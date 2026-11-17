export type CustomerNetwork = { kind: 'base-sepolia' | 'local' | 'zero' | 'unknown'; label: string; assetNote: string };
const unknown: CustomerNetwork = { kind: 'unknown', label: 'Network not identified', assetNote: 'Review the network and currency shown with each transaction.' };

/** General status describes the configured network, not deployment or transaction availability. */
export function customerNetwork(value: unknown): CustomerNetwork {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return unknown;
  const input = value as Record<string, unknown>;
  const name = typeof input.network === 'string' ? input.network : typeof input.name === 'string' ? input.name : '';
  const normalized = name.trim().toLowerCase();
  const named = ['base-sepolia', 'base sepolia', 'base sepolia testnet'].includes(normalized) ? 'base-sepolia'
    : ['local', 'local anvil', 'local anvil (not zero)', 'local test network'].includes(normalized) ? 'local'
      : ['zero', 'zero (planned)'].includes(normalized) ? 'zero' : null;
  const chain = input.chainId;
  if (chain !== null && chain !== undefined && (!Number.isSafeInteger(chain) || Number(chain) <= 0)) return unknown;
  if (named === 'zero') {
    if (chain === 31337 || chain === 84532 || chain === 8453 || input.nativeSymbol !== undefined && input.nativeSymbol !== null && input.nativeSymbol !== 'ZRO') return unknown;
    return { kind: 'zero', label: 'Zero (planned)', assetNote: 'Existing drafts keep their saved currency.' };
  }
  const selected = named || (!normalized && (chain === 84532 ? 'base-sepolia' : chain === 31337 ? 'local' : null));
  if (!selected || chain !== null && chain !== undefined && chain !== (selected === 'base-sepolia' ? 84532 : 31337)
    || input.nativeSymbol !== undefined && input.nativeSymbol !== null && input.nativeSymbol !== 'ETH'
    || input.nativeDecimals !== undefined && input.nativeDecimals !== null && input.nativeDecimals !== 18) return unknown;
  return { kind: selected, label: selected === 'base-sepolia' ? `Base Sepolia testnet${chain === 84532 ? ' (84532)' : ''}` : `Local test network${chain === 31337 ? ' (31337)' : ''}`,
    assetNote: 'Test ETH and test-network assets have no monetary value.' };
}

export function customerNetworkBanner(value: unknown, loading: boolean, failed: boolean) {
  if (loading) return 'Loading network details…';
  if (failed) return 'Network details could not be loaded. Review the network with each transaction.';
  const network = customerNetwork(value);
  return `${network.label}. ${network.assetNote}`;
}
