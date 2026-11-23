/** Explicit execution profiles. Adding a network requires a separate verified implementation. */
export const BASE_SEPOLIA_CHAIN_ID = 84532 as const;
export const BASE_SEPOLIA_GENESIS_HASH = '0x0dcc9e089e30b90ddfc55be9a37dd15bc551aeee999d2e2b51414c54eaf934e4' as const;
export const BASE_SEPOLIA_RPC_URL = 'https://sepolia.base.org';
export const BASE_SEPOLIA_EXPLORER_URL = 'https://sepolia.basescan.org';
export const BASE_SEPOLIA_CONFIG_SOURCE_URL = 'https://docs.base.org/get-started/connect-to-base';
export const BASE_SEPOLIA_GENESIS_SOURCE_URL = 'https://github.com/base/base/blob/f352323dc1e63f8e467368598f75018891f532dd/crates/common/chains/src/config.rs#L528';

/** Zerion's consumer L2 uses the name "ZERϴ Network" on chain ID 543210; never treat it as LayerZero Zero. */
export const ZERION_ZERO_CHAIN_ID = 543210 as const;
export const RESERVED_NON_ZERO_CHAIN_IDS = [0, 1, 31337, 8453, BASE_SEPOLIA_CHAIN_ID, ZERION_ZERO_CHAIN_ID] as const;

export type NftExecutionNetwork =
  | { mode: 'local'; chainId: 31337; name: 'Local Anvil'; nativeSymbol: 'ETH'; nativeDecimals: 18 }
  | { mode: 'base-sepolia'; chainId: 84532; name: 'Base Sepolia'; nativeSymbol: 'ETH'; nativeDecimals: 18 };

export type ZeroExecutionNetwork = {
  mode: 'zero-testnet' | 'zero-mainnet';
  chainId: number;
  name: string;
  nativeSymbol: 'ZRO';
  nativeDecimals: number;
  isTestnet: boolean;
};

export type ExecutionNetwork = NftExecutionNetwork | ZeroExecutionNetwork;

export function isSupportedNftChainId(value: unknown): value is NftExecutionNetwork['chainId'] {
  return value === 31337 || value === BASE_SEPOLIA_CHAIN_ID;
}

export function isValidZeroChainId(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    !(RESERVED_NON_ZERO_CHAIN_IDS as readonly number[]).includes(value)
  );
}

/** For presentation/validation only; this does not verify an RPC or deployment. */
export function nftNetworkForChainId(chainId: unknown): NftExecutionNetwork | null {
  if (chainId === 31337) return { mode: 'local', chainId, name: 'Local Anvil', nativeSymbol: 'ETH', nativeDecimals: 18 };
  if (chainId === BASE_SEPOLIA_CHAIN_ID) return { mode: 'base-sepolia', chainId, name: 'Base Sepolia', nativeSymbol: 'ETH', nativeDecimals: 18 };
  return null;
}

/** Require the exact mode/chain pairing; a label cannot retarget a deployment. */
export function nftExecutionNetwork(input: unknown): NftExecutionNetwork | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  const network = nftNetworkForChainId(value.chainId);
  return network?.mode === value.mode ? network : null;
}

export function isNftExecutionNetwork(input: unknown): input is NftExecutionNetwork {
  const network = nftExecutionNetwork(input);
  if (!network) return false;
  const value = input as Record<string, unknown>;
  return value.name === network.name && value.nativeSymbol === network.nativeSymbol && value.nativeDecimals === network.nativeDecimals;
}

export function isMainnetExecutionNetwork(network: { mode?: string; isTestnet?: boolean } | null | undefined): boolean {
  return network?.mode === 'zero-mainnet' || network?.isTestnet === false;
}

export function nativeCurrencyLabel(
  network: { mode?: string; nativeSymbol?: string; isTestnet?: boolean } | null | undefined,
): string {
  if (network?.mode === 'zero-mainnet') return 'ZRO';
  if (network?.mode === 'zero-testnet') return 'test ZRO';
  if (network?.mode === 'zero' || network?.nativeSymbol === 'ZRO') return network?.isTestnet ? 'test ZRO' : 'ZRO';
  return 'test ETH';
}
