import { afterEach, describe, expect, it, vi } from 'vitest';
import { networkConfig, type NetworkConfig } from '../src/config';
import { createVerifiedRpc, readRpc, RpcError, verifyRpcNetwork, type RpcProviderLabel, type RpcReadMethod } from '../src/rpc';

const GENESIS = `0x${'11'.repeat(32)}` as const;
const OTHER_GENESIS = `0x${'22'.repeat(32)}` as const;
const ADDRESS = `0x${'ab'.repeat(20)}`;
const SECRET = 'never-log-this-api-key';
// Synthetic fixture values exercise the Zero profile; none are published Zero configuration.
const config = (): NetworkConfig => networkConfig({
  ONESHOT_CHAIN_ID: '123456', ONESHOT_RPC_URL: `https://rpc.fixture.invalid/v2/${SECRET}?key=${SECRET}`,
  ONESHOT_GENESIS_HASH: GENESIS, ONESHOT_NATIVE_DECIMALS: '18', ONESHOT_CONFIG_SOURCE_URL: 'https://docs.fixture.invalid/network',
});
type Request = { id: number; method: string; params: unknown[] };
const defaults = (request: Request): unknown => {
  if (request.method === 'eth_chainId') return '0x1e240';
  if (request.method === 'eth_getBlockByNumber') return { number: '0x0', hash: GENESIS };
  if (request.method === 'eth_blockNumber') return '0x10';
  if (request.method === 'eth_getBalance') return '0x64';
  if (request.method === 'eth_getLogs') return [];
  if (request.method === 'eth_call') return '0x';
  throw new Error('Unexpected RPC method in test');
};
function transport(handler: (request: Request) => unknown | Promise<unknown> = defaults) {
  const mock = vi.fn(async (_input: string | URL | globalThis.Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as Request;
    const result = await handler(request);
    return result instanceof Response ? result : new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  });
  return { mock, fetch: mock as typeof globalThis.fetch };
}
const sent = (mock: ReturnType<typeof transport>['mock']) => mock.mock.calls.map(call => JSON.parse(String(call[1]?.body)) as Request);
async function safeError(promise: Promise<unknown>, code: string) {
  const error = await promise.then(() => { throw new Error('Expected rejection'); }, error => error);
  expect(error).toBeInstanceOf(RpcError);
  expect(error).toMatchObject({ code });
  expect(`${error.message}\n${error.stack}\n${JSON.stringify(error)}`).not.toContain(SECRET);
  expect(`${error.message}\n${error.stack}\n${JSON.stringify(error)}`).not.toContain('rpc.fixture.invalid');
  expect(error.cause).toBeUndefined();
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('RPC network identity', () => {
  it('fails closed without Zero configuration and never contacts a provider', async () => {
    const mock = transport();
    await safeError(verifyRpcNetwork(networkConfig({}), { fetch: mock.fetch }), 'CONFIG_INCOMPLETE');
    expect(mock.mock).not.toHaveBeenCalled();
  });

  it('verifies chain, genesis and head with safe diagnostic metadata', async () => {
    const mock = transport();
    const result = await verifyRpcNetwork(config(), { fetch: mock.fetch, provider: 'alchemy' });
    expect(result).toMatchObject({ mode: 'zero', chainId: 123456, genesisHash: GENESIS, latestBlock: 16n,
      genesisMatched: true, provider: { label: 'alchemy', verifiedSupport: false } });
    expect(Number.isNaN(Date.parse(result.checkedAt))).toBe(false);
    expect(sent(mock.mock).map(request => request.method)).toEqual(['eth_chainId', 'eth_getBlockByNumber', 'eth_blockNumber']);
    expect(sent(mock.mock)[1].params).toEqual(['0x0', false]);
    expect(mock.mock.mock.calls[0][1]).toMatchObject({ method: 'POST', cache: 'no-store', redirect: 'error' });
    const publicResult = JSON.stringify(result, (_, value) => typeof value === 'bigint' ? value.toString() : value);
    expect(publicResult).not.toContain(SECRET);
    expect(publicResult).not.toContain('rpc.fixture.invalid');
  });

  it('rejects another chain before fetching blocks', async () => {
    const mock = transport(() => '0x1');
    await safeError(verifyRpcNetwork(config(), { fetch: mock.fetch }), 'CHAIN_ID_MISMATCH');
    expect(mock.mock).toHaveBeenCalledTimes(1);
  });

  it('rejects another genesis before reading the head', async () => {
    const mock = transport(request => request.method === 'eth_getBlockByNumber'
      ? { number: '0x0', hash: OTHER_GENESIS } : defaults(request));
    await safeError(verifyRpcNetwork(config(), { fetch: mock.fetch }), 'GENESIS_MISMATCH');
    expect(mock.mock).toHaveBeenCalledTimes(2);
  });

  it.each(['0x', '0x00', '0xgg', `0x1${'0'.repeat(64)}`, 123456])('rejects malformed chain quantity %s', async chain => {
    const mock = transport(() => chain);
    await safeError(verifyRpcNetwork(config(), { fetch: mock.fetch }), 'RPC_RESPONSE_INVALID');
    expect(mock.mock).toHaveBeenCalledTimes(1);
  });

  it.each([null, { number: '0x1', hash: GENESIS }, { number: '0x0', hash: '0x1234' }])('rejects malformed genesis block', async block => {
    const mock = transport(request => request.method === 'eth_getBlockByNumber' ? block : defaults(request));
    await safeError(verifyRpcNetwork(config(), { fetch: mock.fetch }), 'RPC_RESPONSE_INVALID');
  });

  it('rejects a malformed latest block quantity', async () => {
    const mock = transport(request => request.method === 'eth_blockNumber' ? '0x00' : defaults(request));
    await safeError(verifyRpcNetwork(config(), { fetch: mock.fetch }), 'RPC_RESPONSE_INVALID');
  });

  it.each([
    { jsonrpc: '1.0', id: 1, result: '0x1e240' },
    { jsonrpc: '2.0', id: 2, result: '0x1e240' },
    { jsonrpc: '2.0', id: 1, result: '0x1e240', error: { message: SECRET } },
  ])('rejects invalid or ambiguous JSON-RPC envelopes', async body => {
    const mock = transport(() => new Response(JSON.stringify(body)));
    await safeError(verifyRpcNetwork(config(), { fetch: mock.fetch }), 'RPC_RESPONSE_INVALID');
  });

  it('never exposes a provider error body, failed URL or API key', async () => {
    const remote = transport(request => new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id,
      error: { code: -32000, message: `Invalid API key ${SECRET} at https://rpc.fixture.invalid/` } })));
    await safeError(verifyRpcNetwork(config(), { fetch: remote.fetch }), 'RPC_REMOTE_ERROR');
    const http = transport(() => new Response(SECRET, { status: 503 }));
    await safeError(verifyRpcNetwork(config(), { fetch: http.fetch }), 'RPC_HTTP_ERROR');
    const unavailable = transport(() => { throw new Error(`Connection failed at https://rpc.fixture.invalid/${SECRET}`); });
    await safeError(verifyRpcNetwork(config(), { fetch: unavailable.fetch }), 'RPC_UNAVAILABLE');
    const broken = transport(() => new Response(`not JSON ${SECRET}`));
    await safeError(verifyRpcNetwork(config(), { fetch: broken.fetch }), 'RPC_RESPONSE_INVALID');
  });

  it.each(['fetch', 'body'])('bounds the entire request including a stalled %s', async stage => {
    vi.useFakeTimers();
    const mock = transport(async () => stage === 'fetch' ? await new Promise<never>(() => {})
      : new Response(new ReadableStream<Uint8Array>({ start() {} })));
    const assertion = safeError(verifyRpcNetwork(config(), { fetch: mock.fetch, timeoutMs: 4000 }), 'RPC_TIMEOUT');
    await vi.advanceTimersByTimeAsync(4000);
    await assertion;
    expect(mock.mock).toHaveBeenCalledTimes(1);
    expect(mock.mock.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it.each([true, false])('caps response size with and without content-length', async header => {
    const mock = transport(() => new Response('x'.repeat(1_048_577), header ? { headers: { 'content-length': '1048577' } } : undefined));
    await safeError(verifyRpcNetwork(config(), { fetch: mock.fetch }), 'RPC_RESPONSE_TOO_LARGE');
    expect(mock.mock.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it('cancels an oversized response before consuming its declared body', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start() {}, cancel });
    const mock = transport(() => new Response(body, { headers: { 'content-length': '1048577' } }));
    await safeError(verifyRpcNetwork(config(), { fetch: mock.fetch }), 'RPC_RESPONSE_TOO_LARGE');
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(mock.mock.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it('requires explicit local Anvil mode and reports an observed, unanchored local genesis', async () => {
    const mock = transport(request => request.method === 'eth_chainId' ? '0x7a69' : defaults(request));
    const local = networkConfig({ ONESHOT_NETWORK: 'local' });
    expect(local).toMatchObject({ chainId: 31337, nativeSymbol: 'ETH', nativeDecimals: 18, name: 'Local Anvil (not Zero)' });
    expect(await verifyRpcNetwork(local, { fetch: mock.fetch })).toMatchObject({ mode: 'local', chainId: 31337, genesisMatched: null });
    await safeError(verifyRpcNetwork({ ...local, nativeSymbol: 'ZRO' }, { fetch: mock.fetch }), 'CONFIG_INVALID');
    await safeError(verifyRpcNetwork({ ...config(), chainId: 31337 }, { fetch: mock.fetch }), 'CONFIG_INCOMPLETE');
  });

  it.each([3999, 8001, 4000.5])('rejects timeout outside supported bounds %s', async timeoutMs => {
    const mock = transport();
    await safeError(verifyRpcNetwork(config(), { fetch: mock.fetch, timeoutMs }), 'RPC_OPTIONS_INVALID');
    expect(mock.mock).not.toHaveBeenCalled();
  });

  it('rejects unsupported provider labels and browser calls', async () => {
    const mock = transport();
    await safeError(verifyRpcNetwork(config(), { fetch: mock.fetch, provider: 'invented' as RpcProviderLabel }), 'RPC_OPTIONS_INVALID');
    vi.stubGlobal('window', {});
    await safeError(verifyRpcNetwork(config(), { fetch: mock.fetch }), 'SERVER_ONLY');
    expect(mock.mock).not.toHaveBeenCalled();
  });
});

describe('bounded server reads', () => {
  it('checks network identity immediately before the requested read', async () => {
    const mock = transport();
    expect(await readRpc(config(), 'eth_getBalance', [ADDRESS, 'latest'], { fetch: mock.fetch })).toBe('0x64');
    expect(sent(mock.mock).map(request => request.method)).toEqual(['eth_chainId', 'eth_getBlockByNumber', 'eth_getBalance']);
  });

  it.each([{ block: ['latest'] }, { block: new String('latest') }])('rejects coerced block tags without RPC access', async ({ block }) => {
    const mock = transport();
    await safeError(readRpc(config(), 'eth_getBalance', [ADDRESS, block], { fetch: mock.fetch }), 'RPC_PARAMS_INVALID');
    expect(mock.mock).not.toHaveBeenCalled();
  });

  it.each(['eth_sendTransaction', 'eth_sendRawTransaction', 'personal_sign', 'admin_addPeer', 'eth_estimateGas'])('forbids %s without contacting RPC', async method => {
    const mock = transport();
    await safeError(readRpc(config(), method as RpcReadMethod, [], { fetch: mock.fetch }), 'RPC_METHOD_FORBIDDEN');
    expect(mock.mock).not.toHaveBeenCalled();
  });

  it('rechecks a reused client and pins local genesis independently of public metadata mutation', async () => {
    let changed = false;
    const mock = transport(request => request.method === 'eth_chainId' ? '0x7a69'
      : request.method === 'eth_getBlockByNumber' ? { number: '0x0', hash: changed ? OTHER_GENESIS : GENESIS } : defaults(request));
    const client = await createVerifiedRpc(networkConfig({ ONESHOT_NETWORK: 'local' }), { fetch: mock.fetch });
    changed = true;
    client.verification.genesisHash = OTHER_GENESIS;
    await safeError(client.readRpc('eth_getBalance', [ADDRESS, 'latest']), 'GENESIS_MISMATCH');
    expect(sent(mock.mock).some(request => request.method === 'eth_getBalance')).toBe(false);
  });

  it.each([
    [{ address: ADDRESS, fromBlock: '0x1', toBlock: '0x7d1' }],
    [{ address: ADDRESS, fromBlock: '0x2', toBlock: '0x1' }],
    [{ address: ADDRESS, fromBlock: '0x0', toBlock: 'latest' }],
    [{ fromBlock: '0x0', toBlock: '0x1' }],
    [{ address: Array(9).fill(ADDRESS), fromBlock: '0x0', toBlock: '0x1' }],
    [{ address: ADDRESS, fromBlock: '0x0', toBlock: '0x1', topics: Array(5).fill(GENESIS) }],
  ])('rejects unbounded or malformed log filters', async (...params) => {
    const mock = transport();
    await safeError(readRpc(config(), 'eth_getLogs', params, { fetch: mock.fetch }), 'RPC_PARAMS_INVALID');
    expect(mock.mock).not.toHaveBeenCalled();
  });

  it('allows a bounded explicit 2000-block log range', async () => {
    const mock = transport();
    const filter = { address: [ADDRESS], fromBlock: '0x1', toBlock: '0x7d0', topics: [GENESIS, null] };
    expect(await readRpc(config(), 'eth_getLogs', [filter], { fetch: mock.fetch })).toEqual([]);
    expect(sent(mock.mock).at(-1)?.params).toEqual([filter]);
  });

  it('reads logs from one exact block hash with the existing address and topic bounds', async () => {
    const mock = transport();
    const filter = { address: Array(8).fill(ADDRESS), blockHash: OTHER_GENESIS,
      topics: [Array(8).fill(GENESIS), null, GENESIS, GENESIS] };
    expect(await readRpc(config(), 'eth_getLogs', [filter], { fetch: mock.fetch })).toEqual([]);
    expect(sent(mock.mock).at(-1)?.params).toEqual([filter]);
    expect(sent(mock.mock).map(request => request.method)).toEqual(['eth_chainId', 'eth_getBlockByNumber', 'eth_getLogs']);
  });

  it.each([
    { address: ADDRESS },
    { address: ADDRESS, blockHash: '0x1234' },
    { address: ADDRESS, blockHash: null },
    { address: ADDRESS, blockHash: undefined },
    { address: ADDRESS, blockHash: new String(OTHER_GENESIS) },
    { address: ADDRESS, blockHash: OTHER_GENESIS, fromBlock: '0x1' },
    { address: ADDRESS, blockHash: OTHER_GENESIS, toBlock: '0x1' },
    { address: ADDRESS, blockHash: OTHER_GENESIS, fromBlock: '0x1', toBlock: '0x1' },
    { address: ADDRESS, blockHash: OTHER_GENESIS, fromBlock: undefined },
    { address: ADDRESS, blockHash: OTHER_GENESIS, requireCanonical: true },
    { address: ADDRESS, blockHash: OTHER_GENESIS, topics: Array(5).fill(GENESIS) },
    { address: Array(9).fill(ADDRESS), blockHash: OTHER_GENESIS },
    { address: ADDRESS, fromBlock: '0x1' },
    { address: ADDRESS, toBlock: '0x1' },
  ])('requires exactly one valid block selector without weakening log limits', async filter => {
    const mock = transport();
    await safeError(readRpc(config(), 'eth_getLogs', [filter], { fetch: mock.fetch }), 'RPC_PARAMS_INVALID');
    expect(mock.mock).not.toHaveBeenCalled();
  });

  it('pins a hash-selected request while identity checks await and the caller changes selectors', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const mock = transport(async request => {
      if (request.method === 'eth_chainId') await gate;
      return defaults(request);
    });
    const filter: { address: string; blockHash: string; fromBlock?: string } = { address: ADDRESS, blockHash: OTHER_GENESIS };
    const result = readRpc(config(), 'eth_getLogs', [filter], { fetch: mock.fetch });
    filter.blockHash = GENESIS;
    filter.fromBlock = '0x1';
    release();
    await expect(result).resolves.toEqual([]);
    expect(sent(mock.mock).at(-1)?.params).toEqual([{ address: ADDRESS, blockHash: OTHER_GENESIS }]);
  });

  it('bounds call gas and forbids value, state overrides and oversized calldata', async () => {
    const mock = transport();
    await readRpc(config(), 'eth_call', [{ to: ADDRESS, data: '0x1234' }, 'latest'], { fetch: mock.fetch });
    expect(sent(mock.mock).at(-1)?.params).toEqual([{ to: ADDRESS, data: '0x1234', gas: '0xf4240' }, 'latest']);
    for (const call of [
      { to: ADDRESS, data: '0x12', gas: '0x1e8481' },
      { to: ADDRESS, data: '0x12', value: '0x1' },
      { to: ADDRESS, data: '0x1' },
      { to: ADDRESS, data: `0x${'12'.repeat(8193)}` },
      { to: ADDRESS, data: '0x12', stateOverride: {} },
    ]) await safeError(readRpc(config(), 'eth_call', [call, 'latest'], { fetch: mock.fetch }), 'RPC_PARAMS_INVALID');
    expect(sent(mock.mock)).toHaveLength(3);
  });

  it('snapshots validated parameters before awaiting identity probes', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const mock = transport(async request => {
      if (request.method === 'eth_chainId') await gate;
      return defaults(request);
    });
    const filter = { address: [ADDRESS], fromBlock: '0x1', toBlock: '0x2' };
    const result = readRpc(config(), 'eth_getLogs', [filter], { fetch: mock.fetch });
    filter.toBlock = '0xfffffff';
    filter.address.push('invalid');
    release();
    await expect(result).resolves.toEqual([]);
    expect(sent(mock.mock).at(-1)?.params).toEqual([{ address: [ADDRESS], fromBlock: '0x1', toBlock: '0x2' }]);
  });
});

describe('local NFT transaction simulation', () => {
  const anchor = { number: '0x10', hash: OTHER_GENESIS };
  const call = { from: ADDRESS, to: `0x${'cd'.repeat(20)}`, data: '0x1234', value: '0x64' };
  const local = () => networkConfig({ ONESHOT_NETWORK: 'local' });
  function simulationTransport(override: (request: Request) => unknown = () => undefined) {
    return transport(request => {
      const result = override(request);
      if (result !== undefined) return result;
      if (request.method === 'eth_chainId') return '0x7a69';
      if (request.method === 'eth_getBlockByNumber' && request.params[0] === anchor.number) return anchor;
      if (request.method === 'eth_estimateGas') return '0x5208';
      return defaults(request);
    });
  }

  it('simulates exact value/calldata at a canonical block and bounds its gas without broadcasting', async () => {
    const mock = simulationTransport();
    const client = await createVerifiedRpc(local(), { fetch: mock.fetch });
    await expect(client.simulateCall(call, anchor)).resolves.toEqual({ result: '0x', gasEstimate: '21000' });
    const operations = sent(mock.mock).slice(3);
    expect(operations.map(request => request.method)).toEqual([
      'eth_chainId', 'eth_getBlockByNumber', 'eth_call',
      'eth_chainId', 'eth_getBlockByNumber', 'eth_estimateGas',
      'eth_chainId', 'eth_getBlockByNumber', 'eth_getBlockByNumber',
    ]);
    expect(operations[2].params).toEqual([{ ...call, gas: '0x7a1200' }, { blockHash: anchor.hash, requireCanonical: true }]);
    expect(operations[5].params).toEqual([{ ...call, gas: '0x7a1200' }, anchor.number]);
    expect(operations.at(-1)?.params).toEqual([anchor.number, false]);
    expect(sent(mock.mock).some(request => /send|sign|wallet|personal/i.test(request.method))).toBe(false);
  });

  it('refuses simulation outside the explicit local Anvil profile', async () => {
    const mock = transport();
    const client = await createVerifiedRpc(config(), { fetch: mock.fetch });
    await safeError(client.simulateCall(call, anchor), 'RPC_METHOD_FORBIDDEN');
    expect(sent(mock.mock)).toHaveLength(3);
  });

  it('accepts uint256 maximum value but rejects overflow, noncanonical quantities and call overrides before RPC', async () => {
    const mock = simulationTransport();
    const client = await createVerifiedRpc(local(), { fetch: mock.fetch });
    await expect(client.simulateCall({ ...call, value: `0x${'f'.repeat(64)}` }, anchor)).resolves.toMatchObject({ gasEstimate: '21000' });
    const previous = sent(mock.mock).length;
    for (const value of ['0x', '0x00', '0x01', '-1', '1', `0x1${'0'.repeat(64)}`]) await safeError(client.simulateCall({ ...call, value }, anchor), 'RPC_PARAMS_INVALID');
    for (const altered of [
      { ...call, data: '0x1' }, { ...call, data: `0x${'ab'.repeat(16_385)}` },
      { ...call, from: '0x1234' }, { ...call, to: '0x1234' },
      { ...call, gas: '0x1' }, { ...call, stateOverride: {} }, { ...call, nonce: '0x0' },
    ]) await safeError(client.simulateCall(altered, anchor), 'RPC_PARAMS_INVALID');
    for (const altered of [
      { ...anchor, hash: '0x1234' }, { ...anchor, number: 'latest' },
      { ...anchor, number: '0x00' }, { ...anchor, stateOverride: {} },
    ]) await safeError(client.simulateCall(call, altered), 'RPC_PARAMS_INVALID');
    expect(sent(mock.mock)).toHaveLength(previous);
  });

  it('returns safe validation errors for null, primitive, boxed, and uncloneable runtime arguments', async () => {
    const mock = simulationTransport();
    const client = await createVerifiedRpc(local(), { fetch: mock.fetch });
    type SimulationCall = Parameters<typeof client.simulateCall>[0];
    type SimulationAnchor = Parameters<typeof client.simulateCall>[1];
    for (const invalid of [null, undefined, '0x', [], () => undefined, { ...call, extra: () => undefined }]) await safeError(client.simulateCall(invalid as unknown as SimulationCall, anchor), 'RPC_PARAMS_INVALID');
    for (const invalid of [null, undefined, 'latest', [], () => undefined, { ...anchor, extra: () => undefined }]) await safeError(client.simulateCall(call, invalid as unknown as SimulationAnchor), 'RPC_PARAMS_INVALID');
    await safeError(client.simulateCall({ ...call, data: new String('0x12') } as unknown as SimulationCall, anchor), 'RPC_PARAMS_INVALID');
    expect(sent(mock.mock)).toHaveLength(3);
  });

  it('pins validated call and block parameters before awaiting identity probes', async () => {
    let pause = false;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const mock = transport(async request => {
      if (pause && request.method === 'eth_chainId') await gate;
      if (request.method === 'eth_chainId') return '0x7a69';
      if (request.method === 'eth_getBlockByNumber' && request.params[0] === anchor.number) return anchor;
      if (request.method === 'eth_estimateGas') return '0x5208';
      return defaults(request);
    });
    const client = await createVerifiedRpc(local(), { fetch: mock.fetch });
    pause = true;
    const mutableCall = { ...call }; const mutableAnchor = { ...anchor };
    const result = client.simulateCall(mutableCall, mutableAnchor);
    mutableCall.value = '0xffff'; mutableCall.data = '0xabcd'; mutableAnchor.hash = GENESIS; mutableAnchor.number = '0x20';
    release();
    await expect(result).resolves.toEqual({ result: '0x', gasEstimate: '21000' });
    expect(sent(mock.mock).find(request => request.method === 'eth_call')?.params).toEqual([{ ...call, gas: '0x7a1200' }, { blockHash: anchor.hash, requireCanonical: true }]);
    expect(sent(mock.mock).find(request => request.method === 'eth_estimateGas')?.params).toEqual([{ ...call, gas: '0x7a1200' }, anchor.number]);
  });

  it('refuses a changed chain identity before either simulation or estimation', async () => {
    let changed = false;
    const mock = simulationTransport(request => request.method === 'eth_chainId' && changed ? '0x1' : undefined);
    const client = await createVerifiedRpc(local(), { fetch: mock.fetch });
    changed = true;
    await safeError(client.simulateCall(call, anchor), 'CHAIN_ID_MISMATCH');
    expect(sent(mock.mock).some(request => ['eth_call', 'eth_estimateGas'].includes(request.method))).toBe(false);
  });

  it('rejects an unpinned local genesis despite mutation of public verification metadata', async () => {
    let changed = false;
    const mock = simulationTransport(request => request.method === 'eth_getBlockByNumber' && request.params[0] === '0x0' && changed ? { number: '0x0', hash: OTHER_GENESIS } : undefined);
    const client = await createVerifiedRpc(local(), { fetch: mock.fetch });
    changed = true; client.verification.genesisHash = OTHER_GENESIS;
    await safeError(client.simulateCall(call, anchor), 'GENESIS_MISMATCH');
    expect(sent(mock.mock).some(request => ['eth_call', 'eth_estimateGas'].includes(request.method))).toBe(false);
  });

  it.each(['0x0', '0x00', '0x7a1201', 'bad', null])('rejects invalid or excessive gas estimate %s', async estimate => {
    const mock = simulationTransport(request => request.method === 'eth_estimateGas' ? estimate : undefined);
    const client = await createVerifiedRpc(local(), { fetch: mock.fetch });
    await safeError(client.simulateCall(call, anchor), 'RPC_RESPONSE_INVALID');
  });

  it.each(['0x1', 'bad', 123, null])('rejects malformed eth_call result %s', async result => {
    const mock = simulationTransport(request => request.method === 'eth_call' ? result : undefined);
    const client = await createVerifiedRpc(local(), { fetch: mock.fetch });
    await safeError(client.simulateCall(call, anchor), 'RPC_RESPONSE_INVALID');
    expect(sent(mock.mock).some(request => request.method === 'eth_estimateGas')).toBe(false);
  });

  it.each([null, { ...anchor, hash: GENESIS }, { ...anchor, number: '0x11' }])('rejects a missing, reorganized, or malformed canonical anchor', async block => {
    const mock = simulationTransport(request => request.method === 'eth_getBlockByNumber' && request.params[0] === anchor.number ? block : undefined);
    const client = await createVerifiedRpc(local(), { fetch: mock.fetch });
    await safeError(client.simulateCall(call, anchor), 'RPC_RESPONSE_INVALID');
  });
});
