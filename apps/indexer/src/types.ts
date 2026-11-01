import type { Address, Hex } from 'viem';

export type Block = { number: bigint; hash: Hex; parentHash: Hex; timestamp: bigint };
export type RawLog = {
  address: Address; data: Hex; topics: readonly Hex[];
  blockNumber: bigint; blockHash: Hex; transactionHash: Hex;
  transactionIndex: number; logIndex: number;
};
type ManifestBase = {
  schemaVersion: 1;
  mode: 'local';
  chainId: 31337;
  genesisHash: Hex;
  startBlock: bigint;
  anchorHash: Hex;
  factory: { address: Address; codeHash: Hex };
  marketplace: { address: Address; codeHash: Hex };
};
export type Manifest = ManifestBase & (
  | { deploymentVersion: 'oneshot-nft-v1'; listingAuthorization?: never }
  | { deploymentVersion: 'oneshot-nft-v2'; listingAuthorization: { authority: Address; salt: Hex } }
);
export type ProjectionKind = 'collections' | 'items' | 'listings' | 'claims' | 'activity';
export type ProjectionValue = Record<string, unknown>;
export type Projection = Record<ProjectionKind, Record<string, ProjectionValue>>;
export type Undo = { kind: ProjectionKind; id: string; before: ProjectionValue | null };
export type JournalBlock = { block: Block; logs: RawLog[]; undo: Undo[] };

/** A store transaction makes logs, before-images, projections and its head atomic. */
export interface IndexerTransaction {
  head(): Promise<Block | null>;
  block(number: bigint): Promise<Block | null>;
  get(kind: ProjectionKind, id: string): Promise<ProjectionValue | null>;
  put(kind: ProjectionKind, id: string, value: ProjectionValue): Promise<void>;
  remove(kind: ProjectionKind, id: string): Promise<void>;
  list(kind: ProjectionKind): Promise<Record<string, ProjectionValue>>;
  append(block: Block, logs: readonly RawLog[]): Promise<void>;
  rollbackHead(): Promise<void>;
}
export interface IndexerStore {
  /** Bind to the complete manifest fingerprint; mismatches must never reuse a cursor. */
  initialize(manifestId: string): Promise<void>;
  transaction<T>(run: (transaction: IndexerTransaction) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export interface ChainSource {
  verify(manifest: Manifest): Promise<void>;
  height(): Promise<bigint>;
  block(number: bigint): Promise<Block>;
  logs(block: Block, addresses: readonly Address[]): Promise<RawLog[]>;
}
export class IndexerError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'IndexerError'; }
}
export const emptyProjection = (): Projection => ({ collections: {}, items: {}, listings: {}, claims: {}, activity: {} });
