import type { IndexedNftContext, IndexedNftItem } from './indexed-nfts';

/** Item discovery uses one canonical collection checkpoint and complete verified
 * metadata coverage. Raw chain values/counts remain decimal strings. */
export type NftItemDiscoveryAvailability = 'all' | 'listed' | 'unlisted';
export type NftItemDiscoverySort = 'serial-asc' | 'serial-desc' | 'price-asc' | 'price-desc';
export type NftItemDiscoveryTrait = { trait_type: string; value: string | number };
export type NftItemDiscoveryFacet = NftItemDiscoveryTrait & { count: string };
export type NftItemDiscoveryQuery = {
  q?: string;
  availability?: NftItemDiscoveryAvailability;
  owner?: string;
  /** Human test-ETH decimal amounts, parsed exactly to 18-decimal native units. */
  minPrice?: string;
  maxPrice?: string;
  sort?: NftItemDiscoverySort;
  /** Canonical UTF-8 base64url JSON array of NftItemDiscoveryTrait values. */
  traits?: string;
  limit?: number;
  cursor?: string;
};
export type NftItemDiscoverySummary = {
  totalItems: string;
  matchingItems: string;
  metadataFilters: { available: boolean; reason: string | null };
  /** Counts cover distinct minted, unburned NFTs in this collection, before
   * applying the current query. Number and string trait values are distinct. */
  facets: NftItemDiscoveryFacet[];
  facetsTruncated: boolean;
  facetScope: 'minted-unburned-collection';
};
export type NftItemDiscoveryResponse = {
  context: IndexedNftContext;
  collection: string;
  items: IndexedNftItem[];
  nextCursor: string | null;
  discovery: NftItemDiscoverySummary | null;
};
