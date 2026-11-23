import {
  nativeCurrencyLabel,
  nftNetworkForChainId,
  type ExecutionNetwork,
  type NftExecutionNetwork,
} from '@oneshot/evm';

export type NftChainId = 31337 | 84532;
export type NftTestAcknowledgement = { localEthAcknowledged: true } | { testEthAcknowledged: true; expectedChainId: 84532 };

/** Legacy local responses may omit names/modes; supplied fields must still describe the exact supported test network. */
export function readNftNetwork(value: unknown): NftExecutionNetwork | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const network = nftNetworkForChainId(input.chainId);
  if (
    !network ||
    input.nativeSymbol !== 'ETH' ||
    input.nativeDecimals !== 18 ||
    (input.mode !== undefined && input.mode !== network.mode) ||
    (input.name !== undefined && input.name !== network.name)
  ) {
    return null;
  }
  return network;
}

export function nativeAssetLabel(
  network: { mode?: string; nativeSymbol?: string; isTestnet?: boolean } | null | undefined,
): string {
  return nativeCurrencyLabel(network);
}

export function nftNetworkLabel(network: { chainId?: number | null; mode?: string } | null | undefined) {
  if (!network) return 'Test network unavailable';
  if (network.chainId === 84532) return 'Base Sepolia testnet (84532)';
  if (network.chainId === 31337) return 'Local test network (31337)';
  if (network.mode === 'zero-testnet') return `Zero Testnet (${network.chainId})`;
  if (network.mode === 'zero-mainnet') return `Zero Mainnet (${network.chainId})`;
  return 'Test network unavailable';
}

export function nftTestAcknowledgement(chainId: NftChainId): NftTestAcknowledgement {
  if (chainId === 84532) return { testEthAcknowledged: true, expectedChainId: 84532 };
  if (chainId === 31337) return { localEthAcknowledged: true };
  throw new Error('This test network is not supported. Refresh before preparing a transaction.');
}

export function validNftTestAcknowledgement(
  input: { localEthAcknowledged?: unknown; testEthAcknowledged?: unknown; expectedChainId?: unknown },
  chainId: number | null,
) {
  return chainId === 84532
    ? input.testEthAcknowledged === true && input.expectedChainId === 84532 && input.localEthAcknowledged !== true
    : chainId === 31337 && input.localEthAcknowledged === true && (input.expectedChainId === undefined || input.expectedChainId === 31337);
}

export function nftExplorerHref(chainId: number | null | undefined, value: string, kind: 'tx' | 'address') {
  if (chainId !== 84532 || !(kind === 'tx' ? /^0x[\da-f]{64}$/i : /^0x[\da-f]{40}$/i).test(value)) return null;
  return `https://sepolia.basescan.org/${kind}/${value}`;
}

export type DraftPricingNetwork = 'zero' | 'zero-testnet' | 'zero-mainnet' | 'base-sepolia';
export function draftPricingNetwork(value: { pricingNetwork?: DraftPricingNetwork }): DraftPricingNetwork {
  if (
    value.pricingNetwork === 'base-sepolia' ||
    value.pricingNetwork === 'zero-testnet' ||
    value.pricingNetwork === 'zero-mainnet'
  ) {
    return value.pricingNetwork;
  }
  return 'zero';
}

export function draftPriceUnit(value: { pricingNetwork?: DraftPricingNetwork }) {
  const pricing = draftPricingNetwork(value);
  if (pricing === 'base-sepolia') return 'test ETH';
  if (pricing === 'zero-testnet') return 'test ZRO';
  if (pricing === 'zero-mainnet') return 'ZRO';
  return 'ZRO (planned)';
}

export function draftPricingNetworkLabel(value: { pricingNetwork?: DraftPricingNetwork }): string {
  const pricing = draftPricingNetwork(value);
  if (pricing === 'base-sepolia') return 'Base Sepolia testnet (84532)';
  if (pricing === 'zero-testnet') return 'Zero Testnet (planned)';
  if (pricing === 'zero-mainnet') return 'Zero Mainnet (planned)';
  return 'Zero (planned)';
}

export function draftCanLaunchOnNetwork(
  value: { pricingNetwork?: DraftPricingNetwork },
  network: NftExecutionNetwork | ExecutionNetwork | null,
) {
  if (!network) return false;
  if (network.chainId === 31337) return true;
  const pricing = draftPricingNetwork(value);
  if (network.mode === 'base-sepolia') return pricing === 'base-sepolia';
  if (network.mode === 'zero-testnet') return pricing === 'zero' || pricing === 'zero-testnet';
  if (network.mode === 'zero-mainnet') return pricing === 'zero' || pricing === 'zero-mainnet';
  return false;
}
