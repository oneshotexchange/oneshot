import type { Address } from 'viem';
import { parseReviewedNftManifest, reviewedNftManifestJson, reviewedNftManifestId } from '../../../packages/evm/src/reviewed-nft';
import { reviewedCollectionSchema } from '../../web/lib/reviewed-nft-data';
import { IndexerError, type Block, type IndexerStore } from './types';
import type { SyncOptions } from './engine';
import { discoverReviewedNftCollections, projectReviewedNftLogs } from './reviewed-nft-projector';
import { normalizeReviewedNftBlock, normalizeReviewedNftLogs } from './reviewed-nft-source';
import { REVIEWED_NFT_JOURNAL_LIMITS as LIMITS, type ReviewedNftChainSource, type ReviewedNftManifest } from './reviewed-nft-types';

const fail = (code: string): never => { throw new IndexerError(code); };
const same = (a: Block | null, b: Block | null) => a === null ? b === null : b !== null && a.number === b.number && a.hash === b.hash && a.parentHash === b.parentHash && a.timestamp === b.timestamp;
function bound(value: number, max: number, min = 1) { if (!Number.isSafeInteger(value) || value < min || value > max) return fail('SYNC_OPTIONS_INVALID'); return value; }
function amount(value: unknown): bigint { if (typeof value !== 'string' || !/^(0|[1-9]\d{0,77})$/.test(value) || BigInt(value) >= 2n ** 256n) return fail('REVIEWED_ACCOUNTING_INVALID'); return BigInt(value); }

/** Separate manifest/journal. A failed block never commits partial admission, ownership or balances. */
export async function syncReviewedNftIndexer(source: ReviewedNftChainSource, store: IndexerStore, input: ReviewedNftManifest, options: SyncOptions = {}) {
  const manifest = parseReviewedNftManifest(reviewedNftManifestJson(input));
  const maximum = bound(options.maxBlocks ?? 16, LIMITS.maximumBlocks), depth = BigInt(bound(options.confirmationDepth ?? 0, LIMITS.maximumConfirmationDepth, 0));
  const reorg = bound(options.maxReorgDepth ?? 64, LIMITS.maximumReorgDepth), deadline = Date.now() + LIMITS.passTimeoutMs;
  const active = () => { if (Date.now() >= deadline) return fail('REVIEWED_NFT_PASS_LIMIT'); return !options.signal?.aborted; };
  await source.verify(manifest); if (!active()) return { processed: 0, rolledBack: 0, head: null, target: 0n, caughtUp: false };
  await store.initialize(reviewedNftManifestId(manifest));
  const height = await source.height(); if (typeof height !== 'bigint' || height < 0n || height >= 2n ** 64n) return fail('REVIEWED_NFT_RPC_INVALID');
  const target = height >= depth ? height - depth : 0n; let head = await store.transaction(tx => tx.head()), processed = 0, rolledBack = 0;
  const result = () => ({ processed, rolledBack, head, target, caughtUp: !options.signal?.aborted && (head?.number ?? manifest.startBlock - 1n) >= target });
  const readBlock = async (number: bigint) => { const block = normalizeReviewedNftBlock(await source.block(number)); if (block.number !== number) return fail('REVIEWED_NFT_RPC_INVALID'); return block; };
  if (!active()) return result();
  if (head && (head.number > height || !same(await readBlock(head.number), head))) {
    const original = head; let ancestor: Block | null = null, candidate: Block | null = head, count = 0;
    while (candidate) {
      if (!active()) return result();
      if (candidate.number <= height && same(await readBlock(candidate.number), candidate)) { ancestor = candidate; break; }
      if (++count > reorg) return fail('REORG_TOO_DEEP');
      if (candidate.number === manifest.startBlock) break;
      candidate = await store.transaction(tx => tx.block(candidate!.number - 1n)); if (!candidate) return fail('JOURNAL_GAP');
    }
    if ((await readBlock(manifest.startBlock - 1n)).hash !== manifest.anchorHash) return fail('DEPLOYMENT_ANCHOR_CHANGED');
    // A changing common ancestor must not trigger a destructive rollback.
    if (ancestor && !same(await readBlock(ancestor.number), ancestor)) return fail('CHAIN_MOVED');
    if (!active()) return result();
    await store.transaction(async tx => { if (!same(await tx.head(), original)) return fail('CONCURRENT_SYNC'); for (let i = 0; i < count; i++) await tx.rollbackHead(); });
    rolledBack = count; head = ancestor;
  }
  while (processed < maximum && active()) {
    const number = head ? head.number + 1n : manifest.startBlock; if (number > target) break;
    const block = await readBlock(number); if (!active()) break;
    if (block.parentHash !== (head?.hash ?? manifest.anchorHash)) return fail('CHAIN_MOVED');
    const registered = await store.transaction(async tx => {
      if (!same(await tx.head(), head)) return fail('CONCURRENT_SYNC');
      const records = await tx.list('collections'), addresses: Address[] = [];
      for (const [key, raw] of Object.entries(records)) { const parsed = reviewedCollectionSchema.safeParse(raw); if (!parsed.success || parsed.data.address !== key) return fail('REVIEWED_PROJECTION_INVALID'); addresses.push(parsed.data.address); }
      return addresses;
    });
    if (registered.length > LIMITS.maximumCollections) return fail('REVIEWED_NFT_SOURCE_LIMIT');
    const roots = [manifest.registry.address, manifest.marketplace.address];
    const primary = normalizeReviewedNftLogs(block, await source.logs(block, roots), roots); if (!active()) break;
    const collections = [...new Set([...registered, ...discoverReviewedNftCollections(manifest, primary)])];
    if (collections.length > LIMITS.maximumCollections) return fail('REVIEWED_NFT_SOURCE_LIMIT');
    const secondary = collections.length ? normalizeReviewedNftLogs(block, await source.logs(block, collections), collections) : [];
    const logs = normalizeReviewedNftLogs(block, [...primary, ...secondary], [...roots, ...collections]);
    if (!active()) break;
    if (!same(await readBlock(number), block)) return fail('CHAIN_MOVED');
    const actual = await source.accounting(manifest, block); if (!active()) break;
    await store.transaction(async tx => {
      if (!same(await tx.head(), head)) return fail('CONCURRENT_SYNC');
      const key = `${manifest.marketplace.address}:accounting`, previous = await tx.get('claims', key);
      await projectReviewedNftLogs(tx, manifest, logs, block);
      const projected = await tx.get('claims', key), pending = amount(projected?.pendingRaw ?? '0'), next = amount(projected?.nextListingIdRaw ?? '1');
      if (typeof actual.marketDeployed !== 'boolean' || amount(actual.pending) !== pending || amount(actual.balance) < pending || amount(actual.nextListingId) !== next
        || !actual.marketDeployed && (previous?.marketDeployed === true || pending !== 0n || logs.some(log => log.address === manifest.marketplace.address))) return fail('REVIEWED_ACCOUNTING_MISMATCH');
      await tx.put('claims', key, { schemaVersion: 1, kind: 'reviewed-market-accounting', pendingRaw: pending.toString(), nextListingIdRaw: next.toString(), marketDeployed: actual.marketDeployed });
      if (!active()) return fail('REVIEWED_NFT_PASS_ABORTED');
      if (!same(await readBlock(number), block)) return fail('CHAIN_MOVED');
      if (!active()) return fail('REVIEWED_NFT_PASS_ABORTED');
      await tx.append(block, logs);
    });
    head = block; processed++;
  }
  return result();
}
