import { RpcError } from '@oneshot/evm';
import { syncIndexer, type SyncOptions } from './engine';
import { IndexerError, type ChainSource, type IndexerStore, type Manifest } from './types';

export type WatchEvent =
  | { status: 'syncing' | 'idle'; passes: number; processed: number; rolledBack: number; lagBlocks: string }
  | { status: 'retrying'; passes: number; failures: number; retryInMs: number; error: 'RPC_TEMPORARILY_UNAVAILABLE' | 'DATABASE_TEMPORARILY_UNAVAILABLE' | 'CHAIN_MOVED' | 'CONCURRENT_SYNC' }
  | { status: 'stopped'; passes: number };
export type WatchOptions = SyncOptions & {
  pollIntervalMs?: number;
  onEvent?: (event: WatchEvent) => void;
  /** Injectable scheduling and pass boundary for deterministic lifecycle tests. */
  pause?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  sync?: typeof syncIndexer;
};

const transientDatabaseCodes = new Set([
  '40001', '40P01', '53300', '57P01', '57P02', '57P03',
  '08000', '08001', '08003', '08004', '08006', '08007', '08P01',
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH',
]);
const transientRpcCodes = new Set(['RPC_TIMEOUT', 'RPC_UNAVAILABLE', 'RPC_HTTP_ERROR']);
type RetryError = Extract<WatchEvent, { status: 'retrying' }>['error'];

/** Retry only known availability/race failures; integrity and decoding errors stop. */
export function indexerRetryReason(error: unknown): RetryError | null {
  if (error instanceof RpcError) return transientRpcCodes.has(error.code) ? 'RPC_TEMPORARILY_UNAVAILABLE' : null;
  if (error instanceof IndexerError) return error.code === 'CHAIN_MOVED' || error.code === 'CONCURRENT_SYNC' ? error.code : null;
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && transientDatabaseCodes.has(error.code)) {
    return 'DATABASE_TEMPORARILY_UNAVAILABLE';
  }
  return null;
}

/** Interrupt an idle/backoff wait without interrupting an atomic indexer pass. */
export function pauseIndexerWatch(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, milliseconds);
    signal?.addEventListener('abort', finish, { once: true });
    // Covers an abort between the initial check and listener registration.
    if (signal?.aborted) finish();
  });
}

/**
 * Explicit local watcher. Each bounded pass commits through the existing engine;
 * stop drains the in-flight pass, and the caller owns lease/store cleanup.
 */
export async function watchIndexer(source: ChainSource, store: IndexerStore, manifest: Manifest, options: WatchOptions = {}) {
  if (manifest.mode !== 'local' || manifest.chainId !== 31337) throw new IndexerError('LOCAL_PROFILE_REQUIRED');
  const poll = options.pollIntervalMs ?? 2_000;
  if (!Number.isSafeInteger(poll) || poll < 500 || poll > 60_000) throw new IndexerError('WATCH_OPTIONS_INVALID');
  const pause = options.pause ?? pauseIndexerWatch, sync = options.sync ?? syncIndexer;
  const syncOptions: SyncOptions = { maxBlocks: options.maxBlocks, confirmationDepth: options.confirmationDepth, maxReorgDepth: options.maxReorgDepth, signal: options.signal };
  let passes = 0, failures = 0, previousIdle = false;
  while (!options.signal?.aborted) {
    let result: Awaited<ReturnType<typeof syncIndexer>>;
    try {
      result = await sync(source, store, manifest, syncOptions);
    } catch (error) {
      if (options.signal?.aborted) break;
      const reason = indexerRetryReason(error);
      if (!reason) throw error;
      failures += 1;
      // An absent backend must eventually require operator attention.
      if (failures > 8) throw new IndexerError('WATCH_RETRY_EXHAUSTED');
      const retryInMs = Math.min(30_000, 500 * 2 ** (failures - 1));
      options.onEvent?.({ status: 'retrying', passes, failures, retryInMs, error: reason });
      await pause(retryInMs, options.signal);
      previousIdle = false;
      continue;
    }
    passes += 1; failures = 0;
    const lag = result.target - (result.head?.number ?? manifest.startBlock - 1n);
    const idle = result.caughtUp && result.processed === 0 && result.rolledBack === 0;
    // Avoid periodic unchanged logs while retaining progress and transitions.
    if (!idle || !previousIdle) options.onEvent?.({ status: idle ? 'idle' : 'syncing', passes,
      processed: result.processed, rolledBack: result.rolledBack, lagBlocks: (lag > 0n ? lag : 0n).toString() });
    previousIdle = idle;
    if (!options.signal?.aborted) await pause(result.caughtUp ? poll : 500, options.signal);
  }
  options.onEvent?.({ status: 'stopped', passes });
  return { passes, reason: 'aborted' as const };
}
