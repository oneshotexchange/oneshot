import type { Address, Hex } from 'viem';
import type { NftExecutionNetwork } from './execution-network';
import type { TokenLaunchDraft } from './token-market-review';

/** Browser-safe transport types. Validate runtime values at each trust boundary. */
export type TokenExecutionReview = {
  id:string;reviewHash:string;expiresAt:string;action:'launch'|'approve'|'buy'|'sell'|'claim'|'maintain';
  chainId:31337|84532;deploymentId:string;network:NftExecutionNetwork;
  from:Address;to:Address;value:string;data:Hex;summary:Record<string,string>;
  simulation:{blockNumber:string;blockHash:Hex;gasEstimate:string};
};
type Common={from:Address;testEthAcknowledged:true;expectedChainId:31337|84532;expectedDeploymentId:string};
export type TokenTransactionIntent = Common & (
  | {action:'launch';draft:TokenLaunchDraft & {pricingNetwork:'zero'|'base-sepolia'}}
  | {action:'approve';market:Address;amount:string}
  | {action:'buy'|'sell';market:Address;amount:string;slippageBps:number;recipient?:Address}
  | {action:'claim';market:Address;recipient?:Address}
  | {action:'maintain';market:Address;maximumNativeBudget:string;maximumTokenBudget:string}
);
export type TokenExecutionStatus =
  | {enabled:true;network:NftExecutionNetwork;deploymentId:string;factory:Address;reason:null}
  | {enabled:false;network:null;deploymentId:null;factory:null;reason:string};
export type TokenExecutionReceipt =
  | {reviewId:string;hash:Hex;status:'pending';reason:string}
  | {reviewId:string;hash:Hex;status:'confirmed'|'reverted';blockNumber:string;blockHash:Hex;finalized:false;createdMarket?:{market:Address;token:Address}};
export type TokenExecutionRecovery={review:TokenExecutionReview;transactionHash:Hex|null;outcome:'submitted'|'confirmed'|'reverted'|null};
