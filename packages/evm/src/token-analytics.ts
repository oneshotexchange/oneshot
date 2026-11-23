import type {NftExecutionNetwork} from './execution-network';
import type {IndexedTokenMarket,IndexedTokenSource} from './indexed-tokens';

/** Exact observed pool ratio. The rational value is native raw units per whole token (1e8 token atoms). */
export type TokenPoolPrice={sqrtPriceX96Raw:string;tick:number;nativeRawPerWholeToken:{numerator:string;denominator:string};blockNumber:string;blockHash:string};
export type TokenAnalyticsContext={
  schemaVersion:1;kind:'canonical-event-journal';enabled:boolean;available:boolean;reason:string|null;
  deploymentId:string|null;network:NftExecutionNetwork|null;source:IndexedTokenSource|null;
  checkpoint:{number:string;hash:string;parentHash:string;timestamp:string}|null;
  observedHeadNumber:string|null;lagBlocks:string|null;readonly:true;finalized:false;
};
export type TokenAnalytics={
  market:string;token:string;creator:string;poolId:string;tokenDecimals:8;
  observedSupplyRaw:string;mintedRaw:string;burnedRaw:string;
  /** Includes contracts and PoolManager. Only positive balances count; zero-address burns are excluded. */
  holderCount:string;holderScope:'all-nonzero-balance-addresses';
  poolSwaps:string;poolNativeVolumeRaw:string;poolTokenVolumeRaw:string;
  oneshotTrades:string;oneshotBuys:string;oneshotSells:string;oneshotGrossNativeVolumeRaw:string;oneshotExecutionFeesRaw:string;
  price:TokenPoolPrice;
};
export type TokenAnalyticsMarketResponse={context:TokenAnalyticsContext;market:IndexedTokenMarket|null;analytics:TokenAnalytics|null};
export type TokenAnalyticsEventBase={id:string;market:string;blockNumber:string;blockHash:string;timestamp:string;transactionHash:string;transactionIndex:number;logIndex:number};
export type TokenPoolSwap=TokenAnalyticsEventBase&{kind:'pool-swap';poolId:string;poolSender:string;trader:null;recipient:null;amount0Raw:string;amount1Raw:string;sqrtPriceX96Raw:string;liquidityRaw:string;tick:number;feePips:number};
export type TokenOneshotTrade=TokenAnalyticsEventBase&{kind:'oneshot-trade';token:string;trader:string;recipient:string;buy:boolean;tokensRaw:string;grossNativeRaw:string;netNativeRaw:string;executionFeeRaw:string};
export type TokenAnalyticsTrade=TokenPoolSwap|TokenOneshotTrade;
export type TokenAnalyticsTradesResponse={context:TokenAnalyticsContext;market:string;kind:'pool-swap'|'oneshot-trade'|'all';items:TokenAnalyticsTrade[];nextCursor:string|null};
export type TokenHolderBalance={wallet:string;balanceRaw:string;lastBlockNumber:string;lastBlockHash:string};
export type TokenAnalyticsHoldersResponse={context:TokenAnalyticsContext;market:string;token:string|null;scope:'all-nonzero-balance-addresses';items:TokenHolderBalance[];nextCursor:string|null};
/** This deployment's registered markets only. Public wallet data; no cash value or P&L. */
export type TokenWalletHolding={market:IndexedTokenMarket;balanceRaw:string;price:TokenPoolPrice;lastBalanceBlockNumber:string;lastBalanceBlockHash:string};
export type TokenWalletHoldingsResponse={context:TokenAnalyticsContext;wallet:string;scope:'registered-token-markets';holdingCount:string|null;items:TokenWalletHolding[];nextCursor:string|null};
export type TokenAnalyticsSort='newest'|'volume'|'trades'|'holders';
export type TokenAnalyticsMarketListItem={market:IndexedTokenMarket;analytics:TokenAnalytics};
export type TokenAnalyticsMarketsResponse={context:TokenAnalyticsContext;sort:TokenAnalyticsSort;items:TokenAnalyticsMarketListItem[];nextCursor:string|null};
export type TokenAnalyticsFeedResponse={context:TokenAnalyticsContext;kind:'pool-swap'|'oneshot-trade'|'all';wallet:string|null;items:TokenAnalyticsTrade[];nextCursor:string|null};
