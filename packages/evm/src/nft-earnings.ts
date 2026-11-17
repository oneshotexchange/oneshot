import type { NftExecutionNetwork } from './execution-network';

/** Current native credits at one canonical supported test-network deployment checkpoint. */
export type NftEarningsPage = {
  network: NftExecutionNetwork;
  deploymentId: string;
  wallet: string;
  blockNumber: string;
  blockHash: string;
  blockTimestamp: string;
  marketplace: { contract: string; amountRaw: string };
  collections: Array<{ contract: string; name: string; opened: boolean; amountRaw: string }>;
  /** Factory entries scanned through this page, including zero balances. */
  scannedCount: number;
  totalCollectionsRaw: string;
  nextCursor: string | null;
};
