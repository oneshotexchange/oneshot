import { nftNetworkForChainId, type NftExecutionNetwork } from '@oneshot/evm';

export type NftChainId = 31337 | 84532;
export type NftTestAcknowledgement = { localEthAcknowledged: true } | { testEthAcknowledged: true; expectedChainId: 84532 };

/** Legacy local responses may omit names/modes; supplied fields must still describe the exact supported test network. */
export function readNftNetwork(value: unknown): NftExecutionNetwork | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const network = nftNetworkForChainId(input.chainId);
  if (!network || input.nativeSymbol !== 'ETH' || input.nativeDecimals !== 18
    || input.mode !== undefined && input.mode !== network.mode
    || input.name !== undefined && input.name !== network.name) return null;
  return network;
}
export function nftNetworkLabel(network: NftExecutionNetwork | null | undefined) {
  return network?.chainId === 84532 ? 'Base Sepolia testnet (84532)' : network?.chainId === 31337 ? 'Local test network (31337)' : 'Test network unavailable';
}
export function nftTestAcknowledgement(chainId: NftChainId): NftTestAcknowledgement {
  if (chainId === 84532) return { testEthAcknowledged: true, expectedChainId: 84532 };
  if (chainId === 31337) return { localEthAcknowledged: true };
  throw new Error('This test network is not supported. Refresh before preparing a transaction.');
}
export function validNftTestAcknowledgement(input: { localEthAcknowledged?: unknown; testEthAcknowledged?: unknown; expectedChainId?: unknown }, chainId: number | null) {
  return chainId === 84532
    ? input.testEthAcknowledged === true && input.expectedChainId === 84532 && input.localEthAcknowledged !== true
    : chainId === 31337 && input.localEthAcknowledged === true && (input.expectedChainId === undefined || input.expectedChainId === 31337);
}
export function nftExplorerHref(chainId: number | null | undefined, value: string, kind: 'tx' | 'address') {
  if (chainId !== 84532 || !(kind === 'tx' ? /^0x[\da-f]{64}$/i : /^0x[\da-f]{40}$/i).test(value)) return null;
  return `https://sepolia.basescan.org/${kind}/${value}`;
}

export type DraftPricingNetwork = 'zero' | 'base-sepolia';
export function draftPricingNetwork(value: { pricingNetwork?: DraftPricingNetwork }) { return value.pricingNetwork === 'base-sepolia' ? 'base-sepolia' : 'zero'; }
export function draftPriceUnit(value: { pricingNetwork?: DraftPricingNetwork }) { return draftPricingNetwork(value) === 'base-sepolia' ? 'test ETH' : 'ZRO (planned)'; }
export function draftCanLaunchOnNetwork(value: { pricingNetwork?: DraftPricingNetwork }, network: NftExecutionNetwork | null) {
  return Boolean(network && (network.chainId === 31337 || draftPricingNetwork(value) === 'base-sepolia'));
}
