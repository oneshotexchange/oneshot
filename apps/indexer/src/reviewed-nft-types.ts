import type { Address } from 'viem';
import type { ReviewedNftManifest } from '../../../packages/evm/src/reviewed-nft';
import type { Block, RawLog } from './types';

export type { ReviewedNftManifest } from '../../../packages/evm/src/reviewed-nft';
export type ReviewedNftAccounting = { pending: string; balance: string; marketDeployed: boolean; nextListingId: string };
export interface ReviewedNftChainSource {
  verify(manifest: ReviewedNftManifest, at?: Block): Promise<void>;
  height(): Promise<bigint>;
  block(number: bigint): Promise<Block>;
  logs(block: Block, addresses: readonly Address[]): Promise<RawLog[]>;
  accounting(manifest: ReviewedNftManifest, block: Block): Promise<ReviewedNftAccounting>;
}
export const REVIEWED_NFT_JOURNAL_LIMITS = {
  maximumCollections: 1024,
  maximumAddresses: 1026,
  addressBatchSize: 8,
  maximumLogs: 10_000,
  maximumLogDataBytes: 65_536,
  maximumLogBytes: 16 * 1024 * 1024,
  maximumReads: 160,
  sourceTimeoutMs: 45_000,
  maximumBlocks: 32,
  maximumReorgDepth: 1000,
  maximumConfirmationDepth: 1000,
  passTimeoutMs: 120_000,
} as const;
