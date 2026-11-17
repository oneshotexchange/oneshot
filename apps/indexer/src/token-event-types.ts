import type {Address,Hex} from 'viem';
import type {Block,RawLog,ProjectionValue} from './types';

export type TokenEventKind='markets'|'tokens'|'pools'|'balances'|'events'|'wallets';
export const TOKEN_EVENT_KINDS:readonly TokenEventKind[]=['markets','tokens','pools','balances','events','wallets'];
export type VerifiedTokenRegistration={market:Address;token:Address;creator:Address;poolId:Hex;executionFeeBps:number;liquidityAndBurn:boolean;
  tokenDecimals:8;initialSupplyRaw:'100000000000000000';observedMarketCodeHash:Hex;observedTokenCodeHash:Hex};
export type TokenMarketAnalytics=VerifiedTokenRegistration&{
  schemaVersion:1;chainId:31337|84532;initialized:boolean;initialMintSeen:boolean;
  /** Every nonzero-balance address, including contracts/PoolManager; zero-address burns are excluded. */
  observedSupplyRaw:string;mintedRaw:string;burnedRaw:string;holderCount:string;
  oneshotTrades:string;oneshotBuys:string;oneshotSells:string;oneshotGrossNativeVolumeRaw:string;oneshotExecutionFeesRaw:string;
  poolSwaps:string;poolNativeVolumeRaw:string;poolTokenVolumeRaw:string;
  sqrtPriceX96Raw:string|null;tick:number|null;lastSwapLiquidityRaw:string|null;lastSwapFeePips:number|null;
  priceBlockNumber:string|null;priceBlockHash:Hex|null;
  createdBlockNumber:string;createdBlockHash:Hex;createdTransactionHash:Hex;createdLogIndex:number;
  lastBlockNumber:string;lastBlockHash:Hex;
};
export type TokenEventUndo={kind:TokenEventKind;id:string;before:ProjectionValue|null};
export type TokenEventTransaction={get(kind:TokenEventKind,id:string):Promise<ProjectionValue|null>;put(kind:TokenEventKind,id:string,value:ProjectionValue):Promise<void>;countWalletHoldings(wallet:Address):Promise<bigint>};
export type TokenEventBlockInput={block:Block;logs:readonly RawLog[];registrations:readonly unknown[]};
