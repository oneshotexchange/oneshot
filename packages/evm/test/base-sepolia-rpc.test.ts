import { describe, expect, it, vi } from 'vitest';
import { networkConfig, type NetworkConfig } from '../src/config';
import { BASE_SEPOLIA_GENESIS_HASH } from '../src/execution-network';
import { createVerifiedRpc, readRpc, verifyRpcNetwork, type RpcReadMethod } from '../src/rpc';

const BLOCK = `0x${'a'.repeat(64)}`;
const OTHER = `0x${'b'.repeat(64)}`;
const ADDRESS = `0x${'1'.repeat(40)}`;
const SECRET = 'synthetic-provider-secret';
const config = () => networkConfig({ ONESHOT_NETWORK: 'base-sepolia', ONESHOT_RPC_URL: `https://rpc.fixture.invalid/${SECRET}` });
type Request = { id: number; method: string; params: any[] };
const defaults = (request: Request): unknown => {
  if (request.method === 'eth_chainId') return '0x14a34';
  if (request.method === 'eth_blockNumber') return '0x10';
  if (request.method === 'eth_getBlockByNumber') return request.params[0] === '0x0'
    ? { number: '0x0', hash: BASE_SEPOLIA_GENESIS_HASH } : { number: '0x10', hash: BLOCK };
  if (request.method === 'eth_call') return '0x';
  if (request.method === 'eth_estimateGas') return '0x5208';
  if (request.method === 'eth_getBalance') return '0x1';
  throw new Error(`Unexpected method ${SECRET}`);
};
function transport(handler: (request: Request) => unknown = defaults) {
  const sent: Request[] = [];
  const mock = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as Request; sent.push(request);
    const result = handler(request);
    return result instanceof Response ? result : new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  });
  return { fetch: mock as typeof fetch, mock, sent };
}
const call = { from: ADDRESS, to: ADDRESS, data: '0x12345678', value: '0x0' };
const anchor = { number: '0x10', hash: BLOCK };

describe('pinned Base Sepolia read and simulation profile', () => {
  it('requires the official chain/genesis pair and retains safe public verification evidence', async () => {
    const rpc = transport();
    const verification = await verifyRpcNetwork(config(), { fetch: rpc.fetch });
    expect(verification).toMatchObject({ mode: 'base-sepolia', chainId: 84532, genesisHash: BASE_SEPOLIA_GENESIS_HASH, genesisMatched: true, latestBlock: 16n });
    expect(rpc.sent.map(value => value.method)).toEqual(['eth_chainId', 'eth_getBlockByNumber', 'eth_blockNumber']);
    expect(JSON.stringify(verification, (_, value) => typeof value === 'bigint' ? String(value) : value)).not.toContain(SECRET);
  });

  it('allows bounded read-only simulation and checks canonical identity around both RPC reads', async () => {
    const rpc = transport(), client = await createVerifiedRpc(config(), { fetch: rpc.fetch });
    const result = await client.simulateCall(call, anchor);
    expect(result).toEqual({ result: '0x', gasEstimate: '21000' });
    expect(rpc.sent.find(value => value.method === 'eth_call')?.params).toEqual([{ ...call, gas: '0x7a1200' }, { blockHash: BLOCK, requireCanonical: true }]);
    expect(rpc.sent.find(value => value.method === 'eth_estimateGas')?.params[1]).toBe('0x10');
    expect(rpc.sent.filter(value => value.method === 'eth_chainId')).toHaveLength(4);
    expect(rpc.sent.at(-1)?.params).toEqual(['0x10', false]);
    expect(rpc.sent.some(value => /send|sign/i.test(value.method))).toBe(false);
  });

  it.each([
    { chainId: 8453 }, { chainId: 1 }, { chainId: 31337 }, { nativeDecimals: 8 }, { nativeSymbol: 'ZRO' },
    { genesisHash: OTHER }, { sourceUrl: 'https://docs.fixture.invalid/' }, { rpcUrl: 'http://127.0.0.1:8545' },
    { mode: 'zero', nativeSymbol: 'ZRO' },
  ])('rejects forged profile metadata before any network request: %j', async change => {
    const rpc = transport();
    await expect(verifyRpcNetwork({ ...config(), ...change } as NetworkConfig, { fetch: rpc.fetch })).rejects.toMatchObject({ code: expect.stringMatching(/^CONFIG_/) });
    expect(rpc.mock).not.toHaveBeenCalled();
  });

  it.each([
    ['eth_chainId', '0x2105', 'CHAIN_ID_MISMATCH'],
    ['eth_getBlockByNumber', { number: '0x0', hash: OTHER }, 'GENESIS_MISMATCH'],
  ])('refuses a provider with a different %s', async (method, value, code) => {
    const rpc = transport(request => request.method === method ? value : defaults(request));
    await expect(verifyRpcNetwork(config(), { fetch: rpc.fetch })).rejects.toMatchObject({ code });
  });

  it('detects a chain change between simulation and estimation and sends no estimate', async () => {
    let changed = false;
    const rpc = transport(request => {
      if (request.method === 'eth_call') changed = true;
      if (changed && request.method === 'eth_chainId') return '0x2105';
      return defaults(request);
    });
    const client = await createVerifiedRpc(config(), { fetch: rpc.fetch });
    await expect(client.simulateCall(call, anchor)).rejects.toMatchObject({ code: 'CHAIN_ID_MISMATCH' });
    expect(rpc.sent.some(value => value.method === 'eth_estimateGas')).toBe(false);
  });

  it('rejects a checkpoint replaced during simulation without claiming a usable review', async () => {
    const rpc = transport(request => request.method === 'eth_getBlockByNumber' && request.params[0] === anchor.number ? { number: anchor.number, hash: OTHER } : defaults(request));
    const client = await createVerifiedRpc(config(), { fetch: rpc.fetch });
    await expect(client.simulateCall(call, anchor)).rejects.toMatchObject({ code: 'RPC_RESPONSE_INVALID' });
  });

  it('does not expose sending or signing through the read interface', async () => {
    const rpc = transport();
    for (const method of ['eth_sendTransaction', 'eth_sendRawTransaction', 'eth_sign', 'personal_sign'])
      await expect(readRpc(config(), method as RpcReadMethod, [], { fetch: rpc.fetch })).rejects.toMatchObject({ code: 'RPC_METHOD_FORBIDDEN' });
    expect(rpc.mock).not.toHaveBeenCalled();
  });
});
