import type { NftExecutionNetwork } from './execution-network';

/** Canonical contract snapshots. No spot price, trade history, holder count or volume is inferred. */
export type IndexedTokenMarket = {
  schemaVersion: 1;
  market: string; token: string; creator: string; platformRecipient: string;
  name: string; symbol: string; tokenDecimals: 8;
  initialSupplyRaw: string; totalSupplyRaw: string;
  executionFeeBps: number; liquidityAndBurn: boolean;
  openingValuationNativeRaw: string; effectiveOpeningValuationNativeRaw: string; effectiveUpperValuationNativeRaw: string;
  poolId: string; lpFeePips: 2500; tickSpacing: 10; tickLower: number; tickUpper: number;
  lockedLiquidityRaw: string; lockedRoundingDustRaw: string;
  observedMarketCodeHash: string; observedTokenCodeHash: string;
};
export type IndexedTokenSource = {
  chainId: 31337 | 84532; genesisHash: string;
  factory: {address:string;codeHash:string}; poolManager: {address:string;codeHash:string}; oracle: {address:string;codeHash:string}; quoter: {address:string;codeHash:string};
};
export type IndexedTokenContext = {
  schemaVersion: 1; enabled: boolean; available: boolean; reason: string | null;
  deploymentId: string | null; network: NftExecutionNetwork | null; source: IndexedTokenSource | null;
  checkpoint: {number:string;hash:string;parentHash:string;timestamp:string} | null;
  readonly: true; finalized: false; kind: 'canonical-contract-snapshot';
};
export type IndexedTokenMarketsResponse = {context:IndexedTokenContext;items:IndexedTokenMarket[];nextCursor:string|null};
export type IndexedTokenMarketResponse = {context:IndexedTokenContext;market:IndexedTokenMarket|null};
