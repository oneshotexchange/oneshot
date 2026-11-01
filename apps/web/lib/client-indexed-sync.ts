import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { indexedApi, IndexedReadError } from './client-indexed-api';
import type { NftLaunchReceipt, NftLaunchReview } from './client-nft-launch';

type ReceiptTarget = { scope: string; deploymentId: string; reviewId: string; transactionHash: string; blockNumber: string; blockHash: string };
export type IndexedReceiptSyncState = {
  scope: string | null;
  phase: 'idle' | 'syncing' | 'indexed' | 'pending' | 'unavailable' | 'changed' | 'reorg';
  message: string | null;
  canRetry: boolean;
};
const idle: IndexedReceiptSyncState = { scope: null, phase: 'idle', message: null, canRetry: false };
const hash = (value: unknown): value is string => typeof value === 'string' && /^0x[\da-f]{64}$/i.test(value);
const uint = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) && value.length <= 78 && BigInt(value) < 2n ** 256n;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const text = (value: unknown, limit: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= limit;

/** Tracks display catchup independently of transaction approval. It has no wallet or submission capability. */
export function createIndexedReceiptSync(options: {
  context(): string | null;
  status(signal: AbortSignal): Promise<unknown>;
  receipt(input: { reviewId: string; hash: string }, signal: AbortSignal): Promise<unknown>;
  refresh(): unknown;
}) {
  let state = idle, generation = 0, target: ReceiptTarget | null = null;
  let abort: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null, deadline: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: IndexedReceiptSyncState) => { state = next; for (const listener of listeners) listener(); };
  function stop() { generation++; abort?.abort(); abort = null; if (timer !== null) clearTimeout(timer); if (deadline !== null) clearTimeout(deadline); timer = deadline = null; }
  function cancel() { stop(); target = null; publish(idle); }
  function active(ticket: number, scope: string) {
    if (ticket !== generation) return false;
    if (options.context() !== scope) { cancel(); return false; }
    return true;
  }
  function finish(ticket: number, captured: ReceiptTarget, phase: IndexedReceiptSyncState['phase'], message: string, canRetry = false, refresh = false) {
    if (!active(ticket, captured.scope)) return;
    stop(); publish({ scope: captured.scope, phase, message, canRetry });
    if (refresh) { try { void Promise.resolve(options.refresh()).catch(() => {}); } catch {} }
  }
  function start(input: ReceiptTarget) {
    stop(); target = null;
    if (!input || !text(input.scope, 8192) || options.context() !== input.scope || !text(input.deploymentId, 256)
      || !text(input.reviewId, 256) || !hash(input.transactionHash) || !uint(input.blockNumber) || !hash(input.blockHash)) {
      publish({ scope: options.context(), phase: 'pending', message: 'The transaction confirmation is saved. Check its receipt again before checking activity.', canRetry: false }); return;
    }
    const captured = { ...input }; target = captured;
    const ticket = generation, controller = new AbortController(); abort = controller;
    publish({ scope: captured.scope, phase: 'syncing', message: 'Transaction confirmed; activity is updating.', canRetry: false });
    deadline = setTimeout(() => finish(ticket, captured, 'pending', 'Transaction confirmed; activity is still updating. You can check again without sending a transaction.', true), 30_000);
    let rateLimited = 0;
    const later = (milliseconds: number) => { if (active(ticket, captured.scope)) timer = setTimeout(() => { timer = null; void poll(); }, milliseconds); };
    async function poll() {
      if (!active(ticket, captured.scope)) return;
      try {
        const response = await options.status(controller.signal);
        if (!active(ticket, captured.scope)) return;
        if (!object(response) || !object(response.context)) throw new Error('Invalid indexed context');
        const context = response.context;
        if (typeof context.enabled !== 'boolean' || typeof context.available !== 'boolean' || context.readonly !== true || context.finalized !== false
          || !(context.deploymentId === null || text(context.deploymentId, 256))) throw new Error('Invalid indexed context');
        if (context.deploymentId !== null && context.deploymentId !== captured.deploymentId) {
          finish(ticket, captured, 'changed', 'The collection network changed. Refresh this page before checking activity.'); return;
        }
        if (!context.enabled) { finish(ticket, captured, 'unavailable', 'Transaction confirmed. Activity is currently unavailable; you can check again later.', true); return; }
        if (!context.available || context.checkpoint === null) { rateLimited = 0; later(2000); return; }
        if (!object(context.network)) throw new Error('Invalid indexed network');
        if (context.network.chainId !== 31337 || context.network.mode !== 'local' || context.network.nativeSymbol !== 'ETH' || context.network.nativeDecimals !== 18) {
          finish(ticket, captured, 'changed', 'The network changed. Refresh this page before checking activity.'); return;
        }
        if (context.deploymentId !== captured.deploymentId || !object(context.checkpoint) || !uint(context.checkpoint.number) || !hash(context.checkpoint.hash) || !uint(context.checkpoint.timestamp)) throw new Error('Invalid indexed checkpoint');
        if (BigInt(context.checkpoint.number) < BigInt(captured.blockNumber)) { rateLimited = 0; later(2000); return; }
        // A checkpoint alone cannot prove that the originally confirmed transaction survived a reorganization.
        const receipt = await options.receipt({ reviewId: captured.reviewId, hash: captured.transactionHash }, controller.signal);
        if (!active(ticket, captured.scope)) return;
        if (!object(receipt) || typeof receipt.status !== 'string' || !['confirmed', 'pending', 'reverted'].includes(receipt.status)) throw new Error('Invalid receipt');
        if (receipt.status !== 'confirmed') {
          finish(ticket, captured, 'reorg', receipt.status === 'reverted'
            ? 'Confirmation changed after a chain update: this transaction reverted. Refreshing activity.'
            : 'Confirmation changed after a chain update: this receipt is pending again. Refreshing activity. Check the receipt to continue.', false, true); return;
        }
        if (!uint(receipt.blockNumber) || !hash(receipt.blockHash) || !hash(receipt.hash) || receipt.hash.toLowerCase() !== captured.transactionHash.toLowerCase()) throw new Error('Invalid receipt');
        if (receipt.blockNumber !== captured.blockNumber || receipt.blockHash.toLowerCase() !== captured.blockHash.toLowerCase()) {
          finish(ticket, captured, 'reorg', 'The transaction moved to another block after a chain update. Refreshing activity. Check the receipt to continue.', false, true); return;
        }
        if (context.checkpoint.number === captured.blockNumber && context.checkpoint.hash.toLowerCase() !== captured.blockHash.toLowerCase()) {
          // The API can briefly observe the indexer before its rollback. Keep the saved canonical receipt.
          rateLimited = 0; later(2000); return;
        }
        finish(ticket, captured, 'indexed', 'Transaction confirmed; activity is up to date.', false, true);
      } catch (error) {
        if (!active(ticket, captured.scope)) return;
        if (object(error) && error.status === 409 && error.code === 'INDEXER_CHAIN_MOVED') {
          finish(ticket, captured, 'pending', 'Activity changed after a network update. Refreshing activity; your saved transaction receipt remains available.', true, true); return;
        }
        if (object(error) && error.code === 'RECEIPT_REORGED') {
          finish(ticket, captured, 'reorg', 'Confirmation changed after a chain update. Refreshing activity. Check the receipt to continue.', false, true); return;
        }
        if (object(error) && error.code === 'DEPLOYMENT_CHANGED') {
          finish(ticket, captured, 'changed', 'The transaction network changed. Refresh this page before checking activity.'); return;
        }
        if (error instanceof IndexedReadError && error.status === 429 || object(error) && error.status === 429) {
          rateLimited = Math.min(rateLimited + 1, 3); later(Math.min(8000, 2000 * 2 ** rateLimited));
        } else {
          // Outages, malformed data and receipt API errors do not turn a saved confirmation into a transaction failure.
          rateLimited = 0; later(2000);
        }
      }
    }
    void poll();
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start, cancel,
    retry() { if (target && state.canRetry) { if (options.context() !== target.scope) { cancel(); return; } start(target); } },
  };
}

export function useNftIndexedSync(options: {
  scope: string | null; review: NftLaunchReview | null; receipt: NftLaunchReceipt | null; hash: string | null; enabled: boolean;
  readReceipt(input: { reviewId: string; hash: string }, signal: AbortSignal): Promise<NftLaunchReceipt>;
  onRefresh(): unknown;
}) {
  const current = useRef(options); current.current = options;
  const controller = useMemo(() => createIndexedReceiptSync({
    context: () => current.current.scope,
    status: signal => indexedApi('/api/oneshot/indexed/status', signal),
    receipt: (input, signal) => current.current.readReceipt(input, signal),
    refresh: () => current.current.onRefresh(),
  }), []);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const reviewId = options.review?.id, deploymentId = options.review?.deploymentId;
  const blockNumber = options.receipt?.blockNumber, blockHash = options.receipt?.blockHash;
  const owner = useRef<{ target: string; scope: string } | null>(null);
  useEffect(() => {
    if (options.enabled && options.scope && reviewId && deploymentId && options.hash && options.receipt?.status === 'confirmed') {
      const target = JSON.stringify([reviewId,deploymentId,options.hash,blockNumber,blockHash]);
      // A rerender after logout or selection change cannot reassign an old confirmation to the new context.
      if (owner.current?.target === target && owner.current.scope !== options.scope) { controller.cancel(); return; }
      owner.current = { target, scope: options.scope };
      controller.start({ scope: options.scope, reviewId, deploymentId, transactionHash: options.hash, blockNumber: blockNumber as string, blockHash: blockHash as string });
    } else controller.cancel();
    return () => controller.cancel();
  }, [controller, options.scope, options.enabled, reviewId, deploymentId, options.hash, options.receipt?.status, blockNumber, blockHash]);
  return { ...(state.scope === options.scope ? state : idle), retry: controller.retry };
}
