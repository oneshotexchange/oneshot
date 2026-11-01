import type { NetworkConfig } from './config';

export type RpcProviderLabel = 'alchemy' | 'official' | 'custom';
export type RpcReadMethod = 'eth_blockNumber' | 'eth_getBlockByNumber' | 'eth_getBalance' | 'eth_getCode'
  | 'eth_call' | 'eth_getLogs' | 'eth_getTransactionReceipt' | 'eth_getTransactionByHash' | 'eth_getTransactionCount';
export type RpcOptions = {
  /** A diagnostic label only. It does not establish provider support for Zero. */
  provider?: RpcProviderLabel;
  /** One request has this deadline, including response consumption. No retries. */
  timeoutMs?: number;
  /** Injectable HTTP transport; tests must never need a public RPC. */
  fetch?: typeof globalThis.fetch;
};
export type RpcVerification = {
  mode: 'zero' | 'local';
  chainId: number;
  genesisHash: `0x${string}`;
  latestBlock: bigint;
  checkedAt: string;
  provider: { label: RpcProviderLabel; verifiedSupport: false };
  /** null means local Anvil's genesis was observed, without an official anchor. */
  genesisMatched: boolean | null;
};
export type RpcErrorCode = 'SERVER_ONLY' | 'CONFIG_INCOMPLETE' | 'CONFIG_INVALID' | 'RPC_OPTIONS_INVALID'
  | 'RPC_TIMEOUT' | 'RPC_UNAVAILABLE' | 'RPC_HTTP_ERROR' | 'RPC_RESPONSE_INVALID' | 'RPC_REMOTE_ERROR'
  | 'RPC_RESPONSE_TOO_LARGE' | 'CHAIN_ID_MISMATCH' | 'GENESIS_MISMATCH' | 'RPC_METHOD_FORBIDDEN' | 'RPC_PARAMS_INVALID';

const messages: Record<RpcErrorCode, string> = {
  SERVER_ONLY: 'RPC access is available only on the server.',
  CONFIG_INCOMPLETE: 'Verified network configuration is required before RPC access.',
  CONFIG_INVALID: 'The configured network identity is invalid.',
  RPC_OPTIONS_INVALID: 'The RPC verification options are invalid.',
  RPC_TIMEOUT: 'The RPC request exceeded its deadline.',
  RPC_UNAVAILABLE: 'The RPC provider could not be reached.',
  RPC_HTTP_ERROR: 'The RPC provider returned an unsuccessful HTTP response.',
  RPC_RESPONSE_INVALID: 'The RPC provider returned an invalid response.',
  RPC_REMOTE_ERROR: 'The RPC provider could not complete the read request.',
  RPC_RESPONSE_TOO_LARGE: 'The RPC response exceeded the permitted size.',
  CHAIN_ID_MISMATCH: 'The RPC chain ID does not match the configured network.',
  GENESIS_MISMATCH: 'The RPC genesis hash does not match the configured network.',
  RPC_METHOD_FORBIDDEN: 'This RPC method is not permitted by the read interface.',
  RPC_PARAMS_INVALID: 'The RPC read parameters are invalid or exceed the permitted bounds.',
};

/** Safe to expose: provider URLs, underlying errors and remote messages are never attached. */
export class RpcError extends Error {
  readonly code: RpcErrorCode;
  constructor(code: RpcErrorCode) {
    super(messages[code]);
    this.name = 'RpcError';
    this.code = code;
  }
}

const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_LOG_BLOCKS = 2000n;
const QUANTITY = /^0x(?:0|[1-9a-fA-F][\da-fA-F]{0,63})$/;
const HASH = /^0x[\da-fA-F]{64}$/;
const ADDRESS = /^0x[\da-fA-F]{40}$/;
const DATA = /^0x(?:[\da-fA-F]{2})*$/;
const READ_METHODS = new Set<string>([
  'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getBalance', 'eth_getCode', 'eth_call', 'eth_getLogs',
  'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_getTransactionCount',
]);
type ObjectRecord = Record<string, unknown>;
const object = (value: unknown): value is ObjectRecord => !!value && typeof value === 'object' && !Array.isArray(value);
const hexHash = (value: unknown): value is `0x${string}` => typeof value === 'string' && HASH.test(value);
const hexAddress = (value: unknown): value is string => typeof value === 'string' && ADDRESS.test(value);
const quantity = (value: unknown): value is string => typeof value === 'string' && QUANTITY.test(value);
const blockTag = (value: unknown) => typeof value === 'string'
  && (quantity(value) || ['latest', 'earliest', 'safe', 'finalized'].includes(value));
const callBlock = (value: unknown) => blockTag(value) || (object(value)
  && keysOnly(value, ['blockHash', 'requireCanonical']) && hexHash(value.blockHash) && value.requireCanonical === true);
const keysOnly = (value: ObjectRecord, keys: string[]) => Object.keys(value).every(key => keys.includes(key));

function serverOnly() {
  if (typeof window !== 'undefined') throw new RpcError('SERVER_ONLY');
}

type Connection = {
  url: string;
  mode: 'zero' | 'local';
  chainId: number;
  expectedGenesis: `0x${string}` | null;
  provider: RpcProviderLabel;
  timeoutMs: number;
  transport: typeof globalThis.fetch;
  nextId: number;
};

function connectionFor(config: NetworkConfig, options: RpcOptions): Connection {
  serverOnly();
  if (!config.configurationReady || !config.rpcUrl || config.chainId === null) throw new RpcError('CONFIG_INCOMPLETE');
  const provider = options.provider ?? 'custom';
  const timeoutMs = options.timeoutMs ?? 6000;
  if (!['alchemy', 'official', 'custom'].includes(provider) || !Number.isInteger(timeoutMs) || timeoutMs < 4000 || timeoutMs > 8000) {
    throw new RpcError('RPC_OPTIONS_INVALID');
  }
  if (!Number.isSafeInteger(config.chainId) || config.chainId <= 0) throw new RpcError('CONFIG_INVALID');
  let url: URL;
  try { url = new URL(config.rpcUrl); } catch { throw new RpcError('CONFIG_INVALID'); }
  if (url.username || url.password || url.hash) throw new RpcError('CONFIG_INVALID');
  if (config.mode === 'local') {
    if (config.chainId !== 31337 || config.nativeSymbol !== 'ETH' || config.nativeDecimals !== 18
      || url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || (config.genesisHash !== null && !hexHash(config.genesisHash))) throw new RpcError('CONFIG_INVALID');
  } else if (config.mode === 'zero') {
    if (config.chainId === 31337 || config.nativeSymbol !== 'ZRO' || config.nativeDecimals === null
      || !Number.isInteger(config.nativeDecimals) || config.nativeDecimals < 0 || config.nativeDecimals > 38
      || url.protocol !== 'https:' || !hexHash(config.genesisHash) || !config.sourceUrl) throw new RpcError('CONFIG_INCOMPLETE');
    try {
      const source = new URL(config.sourceUrl);
      if (source.protocol !== 'https:' || source.username || source.password || source.hash) throw new Error();
    } catch { throw new RpcError('CONFIG_INVALID'); }
  } else throw new RpcError('CONFIG_INVALID');
  return {
    url: url.toString(), mode: config.mode, chainId: config.chainId, expectedGenesis: config.genesisHash,
    provider, timeoutMs, transport: options.fetch ?? globalThis.fetch, nextId: 1,
  };
}

async function responseJson(response: Response): Promise<unknown> {
  const contentLength = response.headers.get('content-length');
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => undefined);
    throw new RpcError('RPC_RESPONSE_TOO_LARGE');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new RpcError('RPC_RESPONSE_INVALID');
  let length = 0;
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_RESPONSE_BYTES) {
      void reader.cancel().catch(() => undefined);
      throw new RpcError('RPC_RESPONSE_TOO_LARGE');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new RpcError('RPC_RESPONSE_INVALID'); }
}

async function request(connection: Connection, method: string, params: readonly unknown[]): Promise<unknown> {
  serverOnly();
  const id = connection.nextId++;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new RpcError('RPC_TIMEOUT')); }, connection.timeoutMs);
  });
  const operation = (async () => {
    const response = await connection.transport(connection.url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store', redirect: 'error',
      signal: controller.signal, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    if (!response.ok) throw new RpcError('RPC_HTTP_ERROR');
    const body = await responseJson(response);
    if (!object(body) || body.jsonrpc !== '2.0' || body.id !== id || ('error' in body && 'result' in body)) {
      throw new RpcError('RPC_RESPONSE_INVALID');
    }
    if ('error' in body) throw new RpcError('RPC_REMOTE_ERROR');
    if (!('result' in body)) throw new RpcError('RPC_RESPONSE_INVALID');
    return body.result;
  })();
  try { return await Promise.race([deadline, operation]); }
  catch (error) {
    if (error instanceof RpcError) throw error;
    if (controller.signal.aborted) throw new RpcError('RPC_TIMEOUT');
    throw new RpcError('RPC_UNAVAILABLE');
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // Early HTTP/envelope/size failures must not leave an unread native fetch body open.
    controller.abort();
  }
}

async function verifyIdentity(connection: Connection, pinnedGenesis?: `0x${string}`): Promise<`0x${string}`> {
  const chainId = await request(connection, 'eth_chainId', []);
  if (!quantity(chainId)) throw new RpcError('RPC_RESPONSE_INVALID');
  if (BigInt(chainId) !== BigInt(connection.chainId)) throw new RpcError('CHAIN_ID_MISMATCH');
  const block = await request(connection, 'eth_getBlockByNumber', ['0x0', false]);
  if (!object(block) || block.number !== '0x0' || !hexHash(block.hash)) throw new RpcError('RPC_RESPONSE_INVALID');
  const observed = block.hash.toLowerCase() as `0x${string}`;
  if ((connection.expectedGenesis && observed !== connection.expectedGenesis.toLowerCase())
    || (pinnedGenesis && observed !== pinnedGenesis.toLowerCase())) throw new RpcError('GENESIS_MISMATCH');
  return observed;
}

async function verify(connection: Connection): Promise<RpcVerification> {
  const genesisHash = await verifyIdentity(connection);
  const latest = await request(connection, 'eth_blockNumber', []);
  if (!quantity(latest)) throw new RpcError('RPC_RESPONSE_INVALID');
  return {
    mode: connection.mode, chainId: connection.chainId, genesisHash, latestBlock: BigInt(latest),
    checkedAt: new Date().toISOString(), provider: { label: connection.provider, verifiedSupport: false },
    genesisMatched: connection.expectedGenesis === null ? null : true,
  };
}

/** No signature, transaction or provider-specific endpoint is created by this probe. */
export async function verifyRpcNetwork(config: NetworkConfig, options: RpcOptions = {}): Promise<RpcVerification> {
  return verify(connectionFor(config, options));
}

function boundedParams(method: RpcReadMethod, params: readonly unknown[]): readonly unknown[] {
  if (!READ_METHODS.has(method)) throw new RpcError('RPC_METHOD_FORBIDDEN');
  const invalid = () => { throw new RpcError('RPC_PARAMS_INVALID'); };
  if (!Array.isArray(params)) return invalid();
  switch (method) {
    case 'eth_blockNumber':
      if (params.length !== 0) return invalid();
      break;
    case 'eth_getBlockByNumber':
      if (params.length !== 2 || !blockTag(params[0]) || params[1] !== false) return invalid();
      break;
    case 'eth_getBalance': case 'eth_getCode': case 'eth_getTransactionCount':
      if (params.length !== 2 || !hexAddress(params[0]) || !blockTag(params[1])) return invalid();
      break;
    case 'eth_getTransactionReceipt': case 'eth_getTransactionByHash':
      if (params.length !== 1 || !hexHash(params[0])) return invalid();
      break;
    case 'eth_call': {
      const call = params[0];
      if (params.length !== 2 || !object(call) || !keysOnly(call, ['to', 'from', 'data', 'gas', 'value'])
        || !hexAddress(call.to) || (call.from !== undefined && !hexAddress(call.from))
        || typeof call.data !== 'string' || !DATA.test(call.data) || call.data.length > 16_386
        || !callBlock(params[1]) || (call.value !== undefined && call.value !== '0x0')) return invalid();
      const gas = call.gas ?? '0xf4240';
      if (!quantity(gas) || BigInt(gas) === 0n || BigInt(gas) > 2_000_000n) return invalid();
      return [{ ...call, gas }, params[1]];
    }
    case 'eth_getLogs': {
      const filter = params[0];
      if (params.length !== 1 || !object(filter) || !keysOnly(filter, ['address', 'blockHash', 'fromBlock', 'toBlock', 'topics'])) return invalid();
      // Hash selection binds even an empty response to one block during A -> B -> A reorgs.
      // EIP-234 forbids combining it with either numeric range endpoint.
      if (Object.hasOwn(filter, 'blockHash')) {
        if (!hexHash(filter.blockHash) || Object.hasOwn(filter, 'fromBlock') || Object.hasOwn(filter, 'toBlock')) return invalid();
      } else {
        if (!quantity(filter.fromBlock) || !quantity(filter.toBlock)) return invalid();
        const from = BigInt(filter.fromBlock), to = BigInt(filter.toBlock);
        if (to < from || to - from + 1n > MAX_LOG_BLOCKS) return invalid();
      }
      const addresses = Array.isArray(filter.address) ? filter.address : [filter.address];
      if (addresses.length === 0 || addresses.length > 8
        || !addresses.every(hexAddress)) return invalid();
      if (filter.topics !== undefined && (!Array.isArray(filter.topics) || filter.topics.length > 4
        || !filter.topics.every(topic => topic === null || hexHash(topic)
          || (Array.isArray(topic) && topic.length > 0 && topic.length <= 8 && topic.every(hexHash))))) return invalid();
      break;
    }
  }
  return params;
}

async function boundedRead(connection: Connection, method: RpcReadMethod, params: readonly unknown[], pinnedGenesis?: `0x${string}`) {
  // Callers cannot change a validated range or call while identity checks await I/O.
  let snapshot: readonly unknown[];
  try { snapshot = structuredClone(params); } catch { throw new RpcError('RPC_PARAMS_INVALID'); }
  const bounded = boundedParams(method, snapshot);
  await verifyIdentity(connection, pinnedGenesis);
  return request(connection, method, bounded);
}

/** Every read rechecks identity. Only the initial local genesis is accepted for this client. */
export async function createVerifiedRpc(config: NetworkConfig, options: RpcOptions = {}) {
  const connection = connectionFor(config, options);
  const verification = await verify(connection);
  const pinnedGenesis = verification.genesisHash;
  return {
    verification,
    readRpc: (method: RpcReadMethod, params: readonly unknown[] = []) => boundedRead(connection, method, params, pinnedGenesis),
    /** Simulation only: never signs or submits. Restricted to the explicit disposable local profile. */
    simulateCall: async (input: { from: string; to: string; data: string; value: string }, block: { number: string; hash: string }) => {
      if (connection.mode !== 'local' || connection.chainId !== 31337) throw new RpcError('RPC_METHOD_FORBIDDEN');
      let call: typeof input, anchor: typeof block;
      try { call = structuredClone(input); anchor = structuredClone(block); } catch { throw new RpcError('RPC_PARAMS_INVALID'); }
      if (!object(call) || !object(anchor) || !hexAddress(call.from) || !hexAddress(call.to) || typeof call.data !== 'string' || !DATA.test(call.data) || call.data.length > 32_770
        || !quantity(call.value) || !quantity(anchor.number) || !hexHash(anchor.hash)
        || !keysOnly(call, ['from','to','data','value']) || !keysOnly(anchor, ['number','hash'])) throw new RpcError('RPC_PARAMS_INVALID');
      await verifyIdentity(connection, pinnedGenesis);
      const result = await request(connection, 'eth_call', [{ ...call, gas: '0x7a1200' }, { blockHash: anchor.hash, requireCanonical: true }]);
      if (typeof result !== 'string' || !DATA.test(result)) throw new RpcError('RPC_RESPONSE_INVALID');
      await verifyIdentity(connection, pinnedGenesis);
      const estimate = await request(connection, 'eth_estimateGas', [{ ...call, gas: '0x7a1200' }, anchor.number]);
      if (!quantity(estimate) || BigInt(estimate) === 0n || BigInt(estimate) > 8_000_000n) throw new RpcError('RPC_RESPONSE_INVALID');
      await verifyIdentity(connection, pinnedGenesis);
      const canonical = await request(connection, 'eth_getBlockByNumber', [anchor.number, false]);
      if (!object(canonical) || canonical.number !== anchor.number || !hexHash(canonical.hash)
        || canonical.hash.toLowerCase() !== anchor.hash.toLowerCase()) throw new RpcError('RPC_RESPONSE_INVALID');
      return { result, gasEstimate: BigInt(estimate).toString() };
    },
  };
}

/** One bounded read with chain/genesis checks immediately before it. */
export async function readRpc(config: NetworkConfig, method: RpcReadMethod, params: readonly unknown[] = [], options: RpcOptions = {}) {
  return boundedRead(connectionFor(config, options), method, params);
}
