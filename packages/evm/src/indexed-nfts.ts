import type { NftExecutionNetwork } from './execution-network';

/** Public read-only DTOs. Amounts are integer base units, never floating-point prices. */
export type IndexedNftContext = {
  enabled: boolean;
  available: boolean;
  reason: string | null;
  deploymentId: string | null;
  network: NftExecutionNetwork | null;
  checkpoint: { number: string; hash: string; timestamp: string } | null;
  /** Observed chain height and distance from the canonical indexed checkpoint; no worker liveness claim. */
  sync?: { chainHead: string; behindBlocks: string } | null;
  readonly: true;
  finalized: false;
};
/** Allowlisted presentation from the immutable snapshot committed by an opened collection. */
export type IndexedNftPresentation = {
  manifestHash: string; tokenId: string; name: string; description: string;
  imagePath: string; metadataPath: string;
  attributes: { trait_type: string; value: string | number }[];
};
export type IndexedCollection = {
  address: string; creator: string; name: string; symbol: string;
  configured: boolean; opened: boolean; termsHash: string | null; contentHash: string | null;
  totalMinted: string; primaryTotalPriceRaw: string; primaryPlatformFeeRaw: string;
  primaryCreatorProceedsRaw: string; totalClaimedRaw: string;
  presentation?: IndexedNftPresentation | null;
};
export type IndexedListing = {
  id: string; collection: string; tokenId: string; seller: string;
  totalPriceRaw: string; status: 'active' | 'sold' | 'cancelled' | 'offer-filled';
  buyer: string | null; recipient: string | null;
  platformFeeRaw: string | null; royaltyRaw: string | null; sellerProceedsRaw: string | null;
};
export type IndexedNftItem = {
  id: string; collection: string; tokenId: string; owner: string | null; burned: boolean;
  listing: IndexedListing | null;
  presentation?: IndexedNftPresentation | null;
};
export type IndexedClaim = { contract: string; beneficiary: string; totalClaimedRaw: string; recipient: string; lastAmountRaw: string };
export type IndexedActivity = {
  id: string; eventName: string; source: string; collection: string | null;
  transactionHash: string; blockNumber: string; logIndex: number; timestamp: string;
  args: Record<string, string | boolean>;
};
export type IndexedPage<T> = { context: IndexedNftContext; items: T[]; nextCursor: string | null };
/** Public oneshot listing/sale totals at the response's canonical indexed checkpoint.
 * Lowest listing is a public asking price, separate from private guarded-sale policy.
 * Secondary volume includes settlement fees/royalties, excluding primary mints and gas.
 */
export type IndexedCollectionMarketStats = {
  activeListings: string;
  lowestListingPriceRaw: string | null;
  completedSales: string;
  secondaryVolumeRaw: string;
};
export type IndexedCollectionResponse = {
  context: IndexedNftContext;
  collection: IndexedCollection | null;
  /** Optional while a client talks to an older API; absence is unavailable, never zero. */
  marketStats?: IndexedCollectionMarketStats | null;
};
export type IndexedItemResponse = { context: IndexedNftContext; item: IndexedNftItem | null };

/** Exact decimal rendering, with no Number conversion or silent precision loss. */
export function formatIndexedAmount(raw: string, decimals = 18): string {
  if (!/^(0|[1-9]\d*)$/.test(raw) || raw.length > 256 || !Number.isInteger(decimals) || decimals < 0 || decimals > 38) return '—';
  if (decimals === 0) return raw;
  const padded = raw.padStart(decimals + 1, '0');
  const fraction = padded.slice(-decimals).replace(/0+$/, '');
  return padded.slice(0, -decimals) + (fraction ? `.${fraction}` : '');
}
