import { afterEach, describe, expect, it, vi } from 'vitest';
import { keccak256, zeroHash } from 'viem';
import { networkConfig } from '../src/config';
import { parseRpcCapabilityPlan, probeRpcCapabilities, type RpcCapabilityPlan } from '../src/rpc-capabilities';

// All network/deployment values are synthetic. No public network is contacted.
const GENESIS = `0x${'11'.repeat(32)}` as const;
const BLOCK = `0x${'22'.repeat(32)}` as const;
const OTHER = `0x${'33'.repeat(32)}` as const;
const TX = `0x${'44'.repeat(32)}` as const;
const ADDRESS = `0x${'ab'.repeat(20)}` as const;
const CODE = '0x60006000' as const;
const CALL = '0x12345678' as const;
const RESULT = `0x${'0'.repeat(63)}1` as const;
const SECRET = 'do-not-expose-provider-secret';
const config = () => networkConfig({ ONESHOT_CHAIN_ID: '123456', ONESHOT_RPC_URL: `https://rpc.fixture.invalid/${SECRET}`,
  ONESHOT_GENESIS_HASH: GENESIS, ONESHOT_NATIVE_DECIMALS: '18', ONESHOT_CONFIG_SOURCE_URL: 'https://docs.fixture.invalid/network' });
const plan = (): RpcCapabilityPlan => ({ chainId: 123456, genesisHash: GENESIS, checkpoint: { number: '16', hash: BLOCK },
  contracts: [{ address: ADDRESS, codeHash: keccak256(CODE), call: { data: CALL, expectedResult: RESULT } }],
  expectedLog: { address: ADDRESS, transactionHash: TX, logIndex: '0', topics: [OTHER, zeroHash], data: '0x' } });
const log = () => ({ address: ADDRESS, transactionHash: TX, logIndex: '0x0', transactionIndex: '0x0', blockNumber: '0x10',
  blockHash: BLOCK, removed: false, topics: [OTHER, zeroHash], data: '0x' });
type Request = { id: number; method: string; params: any[] };
const remoteError = (request: Request) => new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: SECRET } }));
const missingBlock = (request: Request) => new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32001, message: 'block not found' } }));
const defaults = (request: Request): unknown => {
  if (request.method === 'eth_chainId') return '0x1e240';
  if (request.method === 'eth_blockNumber') return '0x10';
  if (request.method === 'eth_getBlockByNumber') return request.params[0] === '0x0'
    ? { number: '0x0', hash: GENESIS } : { number: '0x10', hash: BLOCK, parentHash: OTHER, timestamp: '0x100' };
  if (request.method === 'eth_getCode') return CODE;
  if (request.method === 'eth_call') return request.params[1]?.blockHash === zeroHash ? missingBlock(request) : RESULT;
  if (request.method === 'eth_getLogs') return request.params[0]?.blockHash === zeroHash ? missingBlock(request) : [log()];
  throw new Error(`Unexpected method ${SECRET}`);
};
function transport(handler: (request: Request) => unknown | Promise<unknown> = defaults) {
  const mock = vi.fn(async (_url: string | URL | globalThis.Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as Request;
    const result = await handler(request);
    return result instanceof Response ? result : new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  });
  return { mock, fetch: mock as typeof fetch, requests: () => mock.mock.calls.map(call => JSON.parse(String(call[1]?.body)) as Request) };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('explicit read-only RPC capability evidence', () => {
  it('checks known code/call/event witnesses at one block and never claims execution or broader readiness', async () => {
    const rpc = transport();
    const result = await probeRpcCapabilities(config(), plan(), { fetch: rpc.fetch });
    expect(result).toMatchObject({ status: 'passed', code: null, readOnly: true, executionEnabled: false, mode: 'zero', chainId: 123456,
      checkpoint: { number: '16', hash: BLOCK }, evidence: { contractsChecked: 1, codeSelection: 'checkpoint-number', callsMatched: 1,
        logsObserved: 1, expectedLogObserved: true, requests: 24 } });
    expect(Object.values(result.checks).every(check => check.status === 'passed')).toBe(true);
    expect(result.notVerified).toEqual(expect.arrayContaining(['gasEstimation', 'walletSigning', 'transactionReceipts', 'finality', 'nativePrecision', 'nftReadiness', 'ammReadiness', 'codeHashSelection']));
    const sent = rpc.requests();
    expect(new Set(sent.map(request => request.method))).toEqual(new Set(['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getCode', 'eth_call', 'eth_getLogs']));
    expect(sent.find(request => request.method === 'eth_getCode')?.params).toEqual([ADDRESS, '0x10']);
    expect(sent.find(request => request.method === 'eth_call')?.params).toEqual([{ to: ADDRESS, data: CALL, gas: '0xf4240' }, { blockHash: BLOCK, requireCanonical: true }]);
    expect(sent.find(request => request.method === 'eth_getLogs')?.params).toEqual([{ address: [ADDRESS], blockHash: BLOCK }]);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain('rpc.fixture.invalid');
  });

  it('requires a known positive log witness even when the provider accepts both log filter forms', async () => {
    const rpc = transport(request => request.method === 'eth_getLogs' && request.params[0].blockHash !== zeroHash ? [] : defaults(request));
    const input = plan(); delete input.expectedLog;
    const result = await probeRpcCapabilities(config(), input, { fetch: rpc.fetch });
    expect(result).toMatchObject({ status: 'inconclusive', code: 'EXPECTED_LOG_NOT_SUPPLIED', checks: { blockHashLogs: { status: 'inconclusive' }, checkpointRecheck: { status: 'passed' } }, evidence: { logsObserved: 0 } });
  });

  it('does not claim an unanchored nonempty response is an independently known event', async () => {
    const rpc = transport(); const input = plan(); delete input.expectedLog; delete input.checkpoint;
    const result = await probeRpcCapabilities(config(), input, { fetch: rpc.fetch });
    expect(result.status).toBe('inconclusive');
    expect(result.evidence.logsObserved).toBe(1);
    expect(result.checkpoint).toEqual({ number: '16', hash: BLOCK });
  });

  it('rejects a missing expected event instead of treating an empty result as success', async () => {
    const rpc = transport(request => request.method === 'eth_getLogs' ? [] : defaults(request));
    expect(await probeRpcCapabilities(config(), plan(), { fetch: rpc.fetch })).toMatchObject({ status: 'failed', code: 'EXPECTED_LOG_MISSING' });
  });

  it.each(['eth_call', 'eth_getLogs'])('rejects a provider that ignores unknown block hashes for %s', async method => {
    const rpc = transport(request => request.method === method ? method === 'eth_call' ? RESULT : [log()] : defaults(request));
    const result = await probeRpcCapabilities(config(), plan(), { fetch: rpc.fetch });
    expect(result).toMatchObject({ status: 'failed', code: 'BLOCK_HASH_IGNORED' });
    expect(result.checks.checkpointRecheck.status).toBe('not-tested');
  });

  const invalidRejections = [
    { name: 'null', error: null, code: 'RPC_RESPONSE_INVALID' },
    { name: 'array', error: [], code: 'RPC_RESPONSE_INVALID' },
    { name: 'string', error: SECRET, code: 'RPC_RESPONSE_INVALID' },
    { name: 'string code', error: { code: '-32001', message: 'block not found' }, code: 'RPC_RESPONSE_INVALID' },
    { name: 'fractional code', error: { code: -32000.5, message: 'block not found' }, code: 'RPC_RESPONSE_INVALID' },
    { name: 'missing code', error: { message: 'block not found' }, code: 'RPC_RESPONSE_INVALID' },
    { name: 'missing message', error: { code: -32001 }, code: 'RPC_RESPONSE_INVALID' },
    { name: 'non-string message', error: { code: -32001, message: null }, code: 'RPC_RESPONSE_INVALID' },
    { name: 'rate limit', error: { code: -32005, message: `Rate limit exceeded ${SECRET}` }, code: 'RPC_REMOTE_ERROR' },
    { name: 'internal error', error: { code: -32603, message: `Internal error ${SECRET}` }, code: 'RPC_REMOTE_ERROR' },
    { name: 'unrelated server error', error: { code: -32000, message: `Execution reverted ${SECRET}` }, code: 'RPC_REMOTE_ERROR' },
    { name: 'ambiguous missing resource', error: { code: -32001, message: 'resource not found' }, code: 'RPC_REMOTE_ERROR' },
    { name: 'wrong semantic code', error: { code: -32602, message: 'block not found' }, code: 'RPC_REMOTE_ERROR' },
    { name: 'unrelated suffix', error: { code: -32000, message: `block not found ${SECRET}` }, code: 'RPC_REMOTE_ERROR' },
    { name: 'different missing block', error: { code: -32000, message: `block not found: ${OTHER}` }, code: 'RPC_REMOTE_ERROR' },
  ];
  it.each(invalidRejections.flatMap(test => ['eth_call', 'eth_getLogs'].map(method => ({ ...test, method }))))(
    'fails closed on $name during $method negative control', async ({ method, error, code }) => {
      const rpc = transport(request => {
        const selected = request.method === 'eth_call' ? request.params[1] : request.params[0];
        if (request.method === method && selected?.blockHash === zeroHash) return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, error }));
        return defaults(request);
      });
      const result = await probeRpcCapabilities(config(), plan(), { fetch: rpc.fetch });
      expect(result).toMatchObject({ status: 'failed', code });
      expect(result.checks[method === 'eth_call' ? 'callHashRejection' : 'logHashRejection'].status).toBe('failed');
      expect(result.checks.checkpointRecheck.status).toBe('not-tested');
      expect(JSON.stringify(result)).not.toContain(SECRET);
    },
  );

  const clearRejections = [
    { code: -32000, message: 'header not found' },
    { code: -32001, message: 'unknown block' },
    { code: -32000, message: `block not found: ${zeroHash}` },
    { code: -32001, message: `block with hash ${zeroHash} not found` },
    { code: -32000, message: 'Unknown Header.' },
  ];
  it.each(clearRejections.flatMap(error => ['eth_call', 'eth_getLogs'].map(method => ({ error, method }))))(
    'accepts a clear missing-block rejection during $method negative control: $error', async ({ method, error }) => {
      const rpc = transport(request => {
        const selected = request.method === 'eth_call' ? request.params[1] : request.params[0];
        if (request.method === method && selected?.blockHash === zeroHash)
          return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { ...error, data: { secret: SECRET } } }));
        return defaults(request);
      });
      const result = await probeRpcCapabilities(config(), plan(), { fetch: rpc.fetch });
      expect(result.status).toBe('passed');
      expect(JSON.stringify(result)).not.toContain(SECRET);
    },
  );

  it('does not count a negative-control identity error as method rejection', async () => {
    let calls = 0, failIdentity = false;
    const rpc = transport(request => {
      if (request.method === 'eth_call' && ++calls === 1) failIdentity = true;
      else if (request.method === 'eth_chainId' && failIdentity) return remoteError(request);
      return defaults(request);
    });
    const result = await probeRpcCapabilities(config(), plan(), { fetch: rpc.fetch });
    expect(result).toMatchObject({ status: 'failed', code: 'RPC_REMOTE_ERROR', checks: { callHashRejection: { status: 'failed' } } });
    expect(rpc.requests().filter(request => request.method === 'eth_call')).toHaveLength(1);
  });

  it.each(['code', 'call'])('rejects a mismatched known contract %s', async kind => {
    const rpc = transport(request => request.method === (kind === 'code' ? 'eth_getCode' : 'eth_call') ? '0x' : defaults(request));
    expect(await probeRpcCapabilities(config(), plan(), { fetch: rpc.fetch })).toMatchObject({ status: 'failed', code: kind === 'code' ? 'CONTRACT_CODE_MISMATCH' : 'CONTRACT_CALL_MISMATCH' });
  });

  it.each([
    { removed: true }, { blockHash: OTHER }, { blockNumber: '0x11' }, { transactionHash: '0x' }, { transactionIndex: '0x00' },
    { logIndex: '0x00' }, { topics: Array(5).fill(OTHER) }, { data: '0x1' }, { address: `0x${'cd'.repeat(20)}` },
  ])('rejects malformed or unrelated logs %j', async change => {
    const rpc = transport(request => request.method === 'eth_getLogs' ? [{ ...log(), ...change }] : defaults(request));
    expect((await probeRpcCapabilities(config(), plan(), { fetch: rpc.fetch })).status).toBe('failed');
  });

  it.each(['duplicate', 'reordered', 'transactions'])('rejects %s log ordering', async kind => {
    const logs = kind === 'duplicate' ? [log(), log()] : kind === 'reordered' ? [{ ...log(), logIndex: '0x1' }, log()]
      : [log(), { ...log(), logIndex: '0x1', transactionHash: OTHER }];
    const rpc = transport(request => request.method === 'eth_getLogs' ? logs : defaults(request));
    expect(await probeRpcCapabilities(config(), plan(), { fetch: rpc.fetch })).toMatchObject({ status: 'failed', code: 'RPC_LOGS_INVALID' });
  });

  it.each(['hash', 'parentHash', 'timestamp'])('fails if the canonical checkpoint %s changes during the probe', async field => {
    let checkpointReads = 0;
    const rpc = transport(request => {
      const result = defaults(request);
      if (request.method === 'eth_getBlockByNumber' && request.params[0] === '0x10' && ++checkpointReads === 2) return { ...(result as object), [field]: field === 'timestamp' ? '0x101' : GENESIS };
      return result;
    });
    expect(await probeRpcCapabilities(config(), plan(), { fetch: rpc.fetch })).toMatchObject({ status: 'failed', code: 'CHECKPOINT_CHANGED', checks: { checkpointRecheck: { status: 'failed' } } });
  });

  it('rechecks genesis before the final canonical block read', async () => {
    let negatives = 0;
    const rpc = transport(request => {
      if (request.method === 'eth_getLogs' && request.params[0].blockHash === zeroHash) negatives++;
      if (negatives && request.method === 'eth_getBlockByNumber' && request.params[0] === '0x0') return { number: '0x0', hash: OTHER };
      return defaults(request);
    });
    expect(await probeRpcCapabilities(config(), plan(), { fetch: rpc.fetch })).toMatchObject({ status: 'failed', code: 'GENESIS_MISMATCH' });
  });

  it('bounds all four contracts, shared log selection, and total physical requests', async () => {
    const input = plan();
    input.contracts = Array.from({ length: 4 }, (_, i) => ({ ...input.contracts[0], address: `0x${String(i + 1).repeat(40)}` as `0x${string}` }));
    input.expectedLog!.address = input.contracts[0].address;
    const rpc = transport(request => request.method === 'eth_getLogs' && request.params[0].blockHash !== zeroHash
      ? [{ ...log(), address: input.expectedLog!.address }] : defaults(request));
    const result = await probeRpcCapabilities(config(), input, { fetch: rpc.fetch });
    expect(result).toMatchObject({ status: 'passed', evidence: { contractsChecked: 4, callsMatched: 4, requests: 42 } });
    expect(rpc.mock).toHaveBeenCalledTimes(42);
    expect(rpc.requests().find(request => request.method === 'eth_getLogs')?.params[0].address).toHaveLength(4);
  });

  it.each(['fetch', 'body'])('aborts a stalled %s at the overall deadline and schedules no later requests', async stage => {
    vi.useFakeTimers();
    const rpc = transport(async () => stage === 'fetch' ? await new Promise<never>(() => {}) : new Response(new ReadableStream<Uint8Array>({ start() {} })));
    const pending = probeRpcCapabilities(config(), plan(), { fetch: rpc.fetch, overallTimeoutMs: 1000, timeoutMs: 4000 });
    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;
    expect(result).toMatchObject({ status: 'failed', code: 'CAPABILITY_DEADLINE' });
    expect(rpc.mock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(rpc.mock).toHaveBeenCalledTimes(1);
    expect(result.evidence.requests).toBe(1);
  });

  it('snapshots inputs before asynchronous identity verification', async () => {
    const input = plan(), profile = config();
    const rpc = transport();
    const pending = probeRpcCapabilities(profile, input, { fetch: rpc.fetch });
    input.contracts[0].address = `0x${'cd'.repeat(20)}`; input.genesisHash = OTHER; profile.chainId = 1;
    expect((await pending).status).toBe('passed');
    expect(rpc.requests().find(request => request.method === 'eth_getCode')?.params[0]).toBe(ADDRESS);
  });

  it('redacts arbitrary transport failures and fails closed on provider errors', async () => {
    const rpc = transport(() => { throw new Error(`https://rpc.fixture.invalid/${SECRET}`); });
    const result = await probeRpcCapabilities(config(), plan(), { fetch: rpc.fetch });
    expect(result).toMatchObject({ status: 'failed', code: 'RPC_UNAVAILABLE' });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain('rpc.fixture.invalid');
  });
});

describe('capability plan and profile gates', () => {
  it.each([
    null, {}, { ...plan(), unknown: SECRET }, { ...plan(), contracts: [] }, { ...plan(), contracts: Array(5).fill(plan().contracts[0]) },
    { ...plan(), contracts: [plan().contracts[0], plan().contracts[0]] }, { ...plan(), chainId: 0 }, { ...plan(), genesisHash: zeroHash },
    { ...plan(), checkpoint: { number: '016', hash: BLOCK } }, { ...plan(), checkpoint: { number: '16', hash: zeroHash } },
    { ...plan(), contracts: [{ ...plan().contracts[0], call: { data: '0x', expectedResult: RESULT } }] },
    { ...plan(), contracts: [{ ...plan().contracts[0], call: { data: CALL, expectedResult: '0x' } }] },
    { ...plan(), checkpoint: undefined },
  ])('rejects invalid or ambiguous plans before network I/O', async input => {
    const rpc = transport();
    expect(await probeRpcCapabilities(config(), input, { fetch: rpc.fetch })).toMatchObject({ status: 'failed', code: 'CAPABILITY_PLAN_INVALID' });
    expect(rpc.mock).not.toHaveBeenCalled();
  });

  it('rejects configured identity disagreement before network I/O', async () => {
    const rpc = transport();
    expect(await probeRpcCapabilities(config(), { ...plan(), chainId: 1 }, { fetch: rpc.fetch })).toMatchObject({ status: 'failed', code: 'CAPABILITY_IDENTITY_MISMATCH' });
    expect(rpc.mock).not.toHaveBeenCalled();
  });

  it.each([0, 999, 60_001, Number.NaN, Infinity])('rejects invalid overall deadline %s before network I/O', async overallTimeoutMs => {
    const rpc = transport();
    expect(await probeRpcCapabilities(config(), plan(), { fetch: rpc.fetch, overallTimeoutMs })).toMatchObject({ status: 'failed', code: 'CAPABILITY_OPTIONS_INVALID' });
    expect(rpc.mock).not.toHaveBeenCalled();
  });

  it('never permits browser invocation', async () => {
    vi.stubGlobal('window', {}); const rpc = transport();
    expect(await probeRpcCapabilities(config(), plan(), { fetch: rpc.fetch })).toMatchObject({ status: 'failed', code: 'SERVER_ONLY' });
    expect(rpc.mock).not.toHaveBeenCalled();
  });

  it('does not mutate the plan during validation', () => {
    const input = plan(), parsed = parseRpcCapabilityPlan(input);
    expect(parsed).toEqual(input); expect(parsed).not.toBe(input);
  });
});
