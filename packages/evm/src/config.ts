export type NetworkConfig = {
  mode: 'zero' | 'local';
  name: string;
  chainId: number | null;
  rpcUrl: string | null;
  genesisHash: `0x${string}` | null;
  explorerUrl: string | null;
  nativeSymbol: 'ZRO' | 'ETH';
  nativeDecimals: number | null;
  sourceUrl: string | null;
  configurationReady: boolean;
  missing: string[];
};

function optionalInteger(input: string | undefined, name: string, maximum: number): number | null {
  if (!input) return null;
  if (!/^(0|[1-9]\d*)$/.test(input) || !Number.isSafeInteger(Number(input)) || Number(input) > maximum) throw new Error(`${name} must be a valid integer`);
  return Number(input);
}
function optionalUrl(input: string | undefined, name: string, local = false): string | null {
  if (!input) return null;
  const url = new URL(input);
  if (url.username || url.password || url.hash) throw new Error(`${name} must not include credentials or a fragment`);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (local ? url.protocol !== 'http:' || !loopback : url.protocol !== 'https:') throw new Error(`${name} requires ${local ? 'a loopback HTTP endpoint' : 'HTTPS'}`);
  return url.toString().replace(/\/$/, '');
}

/** Missing Zero facts remain null. EVM compatibility never supplies chain precision. */
export function networkConfig(env: Record<string, string | undefined>): NetworkConfig {
  const mode = env.ONESHOT_NETWORK || 'zero';
  if (mode !== 'zero' && mode !== 'local') throw new Error('ONESHOT_NETWORK must be zero or local');
  if (mode === 'local') {
    const chainId = optionalInteger(env.ONESHOT_CHAIN_ID, 'ONESHOT_CHAIN_ID', Number.MAX_SAFE_INTEGER) ?? 31337;
    if (chainId !== 31337) throw new Error('Local development requires chain ID 31337');
    const decimals = optionalInteger(env.ONESHOT_NATIVE_DECIMALS, 'ONESHOT_NATIVE_DECIMALS', 38) ?? 18;
    if (decimals !== 18) throw new Error('Local Anvil ETH has 18 decimals');
    return { mode, name: 'Local Anvil (not Zero)', chainId, rpcUrl: optionalUrl(env.ONESHOT_RPC_URL || 'http://127.0.0.1:8545', 'ONESHOT_RPC_URL', true), genesisHash: null, explorerUrl: null, nativeSymbol: 'ETH', nativeDecimals: decimals, sourceUrl: null, configurationReady: true, missing: [] };
  }
  const chainId = optionalInteger(env.ONESHOT_CHAIN_ID, 'ONESHOT_CHAIN_ID', Number.MAX_SAFE_INTEGER);
  if (chainId === 0 || chainId === 31337) throw new Error('Zero requires its official chain ID; local Anvil is a separate profile');
  const rpcUrl = optionalUrl(env.ONESHOT_RPC_URL, 'ONESHOT_RPC_URL');
  const nativeDecimals = optionalInteger(env.ONESHOT_NATIVE_DECIMALS, 'ONESHOT_NATIVE_DECIMALS', 38);
  const genesisHash = env.ONESHOT_GENESIS_HASH || null;
  if (genesisHash && !/^0x[\da-fA-F]{64}$/.test(genesisHash)) throw new Error('ONESHOT_GENESIS_HASH must be a 32-byte hex hash');
  const explorerUrl = optionalUrl(env.ONESHOT_EXPLORER_URL, 'ONESHOT_EXPLORER_URL');
  const sourceUrl = optionalUrl(env.ONESHOT_CONFIG_SOURCE_URL, 'ONESHOT_CONFIG_SOURCE_URL');
  const missing = [chainId === null && 'Official Zero EVM chain ID', !rpcUrl && 'Official Zero EVM RPC', !genesisHash && 'Zero genesis hash', nativeDecimals === null && 'Verified native ZRO precision', !sourceUrl && 'Official configuration reference'].filter((item): item is string => Boolean(item));
  return { mode, name: 'Zero', chainId, rpcUrl, nativeDecimals, genesisHash: genesisHash as `0x${string}` | null, explorerUrl, nativeSymbol: 'ZRO', sourceUrl, configurationReady: missing.length === 0, missing };
}

/** Browser status never exposes private provider URLs or credentials. */
export function publicNetwork(config: NetworkConfig) {
  return { mode: config.mode, name: config.name, chainId: config.chainId, nativeSymbol: config.nativeSymbol, nativeDecimals: config.nativeDecimals, explorerUrl: config.explorerUrl, configurationReady: config.configurationReady, missing: config.missing };
}
