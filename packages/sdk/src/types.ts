/** Chain amounts and transaction versions cross JSON boundaries as decimal strings. */
export type RawAmount = string;
export type TransactionVersion = string;
export type AptosAddress = `0x${string}`;
export type TransactionHash = `0x${string}`;
export type FeeMode = "creator" | "liquidity_burn";
export type TradeSide = "buy" | "sell";
export type AptosNetwork = "testnet" | "localnet";

export interface NetworkIdentity {
  network: AptosNetwork;
  chainId: number;
}

/** A launch snapshots these terms. Environment changes apply to later launches only. */
export interface TokenLaunchPolicy {
  readonly creatorFeeBps: number;
  readonly platformShareBps: 2000;
  readonly dexFeeBps: number;
  readonly feeMode: FeeMode;
  readonly decimals: 8;
  readonly supplyRaw: "100000000000000000";
  readonly mutable: false;
}

export type TransactionStage = "simulate" | "sign" | "pending" | "committed" | "indexing" | "complete";
export type TransactionFailure = "rejected" | "simulation_failed" | "expired_quote" | "partial_fill" | "chain_mismatch" | "execution_failed";

export interface TransactionReceipt extends NetworkIdentity {
  hash: TransactionHash;
  version: TransactionVersion;
  success: boolean;
  vmStatus: string;
}

export interface DeploymentIdentity extends NetworkIdentity {
  packageAddress: AptosAddress;
  deploymentVersion: TransactionVersion;
  expectedAbiSha256: string;
}

export interface RuntimeStatus {
  service: "indexer" | "keeper";
  state: "disabled" | "verifying" | "starting" | "running" | "retrying" | "failed" | "stopped";
  message: string;
  updatedAt: string;
  nextVersion?: TransactionVersion;
}
