/** Current native credits at a single canonical local deployment checkpoint. */
export type NftEarningsPage = {
  network: { mode: 'local'; chainId: 31337; name: string; nativeSymbol: 'ETH'; nativeDecimals: 18 };
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
