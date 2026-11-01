import type { Address } from 'viem';
import { discoverCollections, projectLogs } from './events';
import { manifestId, manifestJson, parseManifest } from './manifest';
import { IndexerError, type Block, type ChainSource, type IndexerStore, type Manifest, type RawLog } from './types';

export type SyncOptions = { maxBlocks?: number; confirmationDepth?: number; maxReorgDepth?: number; signal?: AbortSignal };
const same = (a: Block | null, b: Block | null) => a === null ? b === null : b !== null && a.number === b.number && a.hash === b.hash;
const bound = (value: number, minimum: number, maximum: number) => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new IndexerError('SYNC_OPTIONS_INVALID');
  return value;
};

/** One bounded, read-only chain pass. Confirmation depth is local policy, never a finality claim. */
export async function syncIndexer(source: ChainSource, store: IndexerStore, input: Manifest, options: SyncOptions = {}) {
  const manifest = parseManifest(manifestJson(input));
  const maxBlocks = bound(options.maxBlocks ?? 100, 1, 1000);
  const depth = BigInt(bound(options.confirmationDepth ?? 0, 0, 1000));
  const maxReorg = bound(options.maxReorgDepth ?? 64, 1, 1000);
  await source.verify(manifest);
  await store.initialize(manifestId(manifest));
  const height = await source.height(), target = height >= depth ? height - depth : 0n;
  let rolledBack = 0, processed = 0;
  let head = await store.transaction(tx => tx.head());
  const result = () => ({ processed, rolledBack, head, target,
    caughtUp: !options.signal?.aborted && (head?.number ?? manifest.startBlock - 1n) >= target });
  if (options.signal?.aborted) return result();
  // Find the entire common ancestor before undoing anything. Deep reorgs preserve the checkpoint.
  if (head && (head.number > height || (await source.block(head.number)).hash !== head.hash)) {
    const originalHead = head;
    let ancestor: Block | null = null, count = 0;
    let candidate: Block | null = head;
    while (candidate) {
      if (options.signal?.aborted) return result();
      if (candidate.number <= height && (await source.block(candidate.number)).hash === candidate.hash) { ancestor = candidate; break; }
      count++;
      if (count > maxReorg) throw new IndexerError('REORG_TOO_DEEP');
      if (candidate.number === manifest.startBlock) break;
      candidate = await store.transaction(tx => tx.block(candidate!.number - 1n));
      if (!candidate) throw new IndexerError('JOURNAL_GAP');
    }
    if ((await source.block(manifest.startBlock - 1n)).hash !== manifest.anchorHash) throw new IndexerError('DEPLOYMENT_ANCHOR_CHANGED');
    if (options.signal?.aborted) return result();
    await store.transaction(async tx => {
      if (!same(await tx.head(), originalHead)) throw new IndexerError('CONCURRENT_SYNC');
      for (let index = 0; index < count; index++) await tx.rollbackHead();
    });
    rolledBack = count;
    head = ancestor;
  }
  while (processed < maxBlocks && !options.signal?.aborted) {
    const number: bigint = head ? head.number + 1n : manifest.startBlock;
    if (number > target) break;
    const block = await source.block(number);
    if (options.signal?.aborted) break;
    if (block.number !== number || block.parentHash !== (head?.hash ?? manifest.anchorHash)) throw new IndexerError('CHAIN_MOVED');
    const registered = await store.transaction(async tx => {
      if (!same(await tx.head(), head)) throw new IndexerError('CONCURRENT_SYNC');
      return Object.keys(await tx.list('collections')) as Address[];
    });
    if (options.signal?.aborted) break;
    if (registered.length > 4094) throw new IndexerError('SOURCE_LIMIT');
    const primary = await source.logs(block, [manifest.factory.address, manifest.marketplace.address]);
    if (options.signal?.aborted) break;
    requireSources(primary, [manifest.factory.address, manifest.marketplace.address]);
    const discovered = discoverCollections(manifest, primary);
    const collections = [...new Set([...registered, ...discovered])];
    if (collections.length > 4094) throw new IndexerError('SOURCE_LIMIT');
    const secondary = collections.length ? await source.logs(block, collections) : [];
    if (options.signal?.aborted) break;
    requireSources(secondary, collections);
    const logs = orderedLogs(block, [...primary, ...secondary]);
    // The source reads logs by exact hash; also ensure that hash is still canonical here.
    const canonical = await source.block(number);
    if (options.signal?.aborted) break;
    if (canonical.hash !== block.hash) throw new IndexerError('CHAIN_MOVED');
    await store.transaction(async tx => {
      if (!same(await tx.head(), head)) throw new IndexerError('CONCURRENT_SYNC');
      await projectLogs(tx, manifest, logs);
      await tx.append(block, logs);
    });
    head = block;
    processed++;
  }
  return result();
}

function requireSources(logs: readonly RawLog[], addresses: readonly Address[]) {
  const allowed = new Set(addresses.map(address => address.toLowerCase()));
  if (logs.some(log => !allowed.has(log.address.toLowerCase()))) throw new IndexerError('UNREQUESTED_LOG_SOURCE');
}

function orderedLogs(block: Block, logs: RawLog[]) {
  if (logs.length > 10_000) throw new IndexerError('SOURCE_LIMIT');
  logs.sort((a, b) => a.logIndex - b.logIndex);
  const transactions = new Map<number, string>();
  const hashes = new Map<string, number>();
  let previousTransaction = -1;
  for (let index = 0; index < logs.length; index++) {
    const log = logs[index];
    if (log.blockHash !== block.hash || log.blockNumber !== block.number
      || !Number.isSafeInteger(log.logIndex) || log.logIndex < 0 || !Number.isSafeInteger(log.transactionIndex) || log.transactionIndex < previousTransaction
      || index > 0 && log.logIndex === logs[index - 1].logIndex) throw new IndexerError('LOG_ORDER_INVALID');
    const knownHash = transactions.get(log.transactionIndex), knownIndex = hashes.get(log.transactionHash);
    if ((knownHash && knownHash !== log.transactionHash) || (knownIndex !== undefined && knownIndex !== log.transactionIndex)) throw new IndexerError('LOG_ORDER_INVALID');
    transactions.set(log.transactionIndex, log.transactionHash); hashes.set(log.transactionHash, log.transactionIndex);
    previousTransaction = log.transactionIndex;
  }
  return logs;
}
