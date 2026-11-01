import { serviceMessage } from './service-message';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { IndexedNftContext, IndexedPage } from '@oneshot/evm';
import { apiUrl } from './api-url';
import { customerErrorDetails, customerFetch, customerResponseJson } from './customer-http';

export class IndexedReadError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}

export async function indexedApi<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await customerFetch(apiUrl(path), { signal, credentials: 'omit', redirect: 'error' });
  const body = await customerResponseJson<{ context?: { readonly?: unknown; finalized?: unknown } }>(response, {
    signal, invalidResponse: () => new IndexedReadError(502, 'INVALID_READ_RESPONSE', 'NFT data could not be verified. Please refresh this page.'),
  });
  const error = customerErrorDetails(body);
  if (!response.ok) throw new IndexedReadError(response.status, error.code || 'READ_FAILED', serviceMessage(error.code, error.message, 'NFT data could not be loaded. Please try again.'));
  if (!body || typeof body !== 'object' || !body.context || body.context.readonly !== true || body.context.finalized !== false) {
    throw new IndexedReadError(502, 'INVALID_READ_RESPONSE', 'NFT data could not be verified. Please refresh this page.');
  }
  return body as T;
}

export function sameIndexedCheckpoint(left: IndexedNftContext, right: IndexedNftContext) {
  return left.deploymentId === right.deploymentId && left.checkpoint?.number === right.checkpoint?.number
    && left.checkpoint?.hash === right.checkpoint?.hash && left.available === right.available;
}

export function appendIndexedPage<T>(previous: IndexedPage<T>, next: IndexedPage<T>, key: (item: T) => string): IndexedPage<T> {
  if (!sameIndexedCheckpoint(previous.context, next.context)) throw new IndexedReadError(409, 'CURSOR_STALE', 'Recent activity changed. Please refresh this list.');
  return { ...next, items: [...new Map([...previous.items, ...next.items].map(item => [key(item), item])).values()] };
}

type PageState<T> = { path: string | null; data: IndexedPage<T> | null; loading: boolean; loadingMore: boolean; error: string | null; notice: string | null };
const emptyState = <T,>(path: string | null): PageState<T> => ({ path, data: null, loading: Boolean(path), loadingMore: false, error: null, notice: null });
type Fetcher = <T>(path: string, signal?: AbortSignal) => Promise<T>;

/** Each request belongs to one path/generation. A new checkpoint restarts instead of merging. */
export class IndexedPageLoader<T> {
  private state: PageState<T> = emptyState<T>(null);
  private listeners = new Set<() => void>();
  private generation = 0;
  private controller: AbortController | null = null;
  constructor(private readonly key: (item: T) => string, private readonly fetcher: Fetcher = indexedApi) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(state: PageState<T>) { this.state = state; for (const listener of this.listeners) listener(); }
  cancel() { this.generation++; this.controller?.abort(); this.controller = null; }
  async open(path: string | null, notice: string | null = null) {
    this.cancel();
    const generation = this.generation;
    this.publish({ ...emptyState<T>(path), notice });
    if (!path) return;
    const controller = new AbortController(); this.controller = controller;
    try {
      const data = await this.fetcher<IndexedPage<T>>(path, controller.signal);
      if (generation !== this.generation) return;
      if (!Array.isArray(data.items) || !(data.nextCursor === null || typeof data.nextCursor === 'string')) throw new Error('This list could not be loaded. Please refresh and try again.');
      this.publish({ path, data, loading: false, loadingMore: false, error: null, notice });
    } catch (error) {
      if (generation !== this.generation) return;
      this.publish({ path, data: null, loading: false, loadingMore: false, error: error instanceof Error ? error.message : 'Could not load NFT data. Please try again.', notice });
    }
  }
  refresh = () => this.open(this.state.path);
  loadMore = async () => {
    const previous = this.state;
    if (!previous.path || !previous.data?.nextCursor || previous.loading || previous.loadingMore) return;
    const generation = this.generation;
    this.publish({ ...previous, loadingMore: true, error: null });
    const controller = new AbortController(); this.controller = controller;
    try {
      const next = await this.fetcher<IndexedPage<T>>(`${previous.path}${previous.path.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(previous.data.nextCursor)}`, controller.signal);
      if (generation !== this.generation) return;
      if (!Array.isArray(next.items) || !(next.nextCursor === null || typeof next.nextCursor === 'string')) throw new Error('This list could not be loaded. Please refresh and try again.');
      this.publish({ ...previous, data: appendIndexedPage(previous.data, next, this.key), loadingMore: false, error: null });
    } catch (error) {
      if (generation !== this.generation) return;
      if (error instanceof IndexedReadError && error.status === 409 && error.code === 'CURSOR_STALE') {
        await this.open(previous.path, 'Recent activity changed. This list has been refreshed.');
      } else if (error instanceof IndexedReadError && error.status === 409 && error.code === 'INDEXER_CHAIN_MOVED') {
        // The server knows this checkpoint is orphaned. Do not retain its owners or listings.
        this.publish({ path: previous.path, data: null, loading: false, loadingMore: false, error: error.message, notice: null });
      } else this.publish({ ...previous, loadingMore: false, error: error instanceof Error ? error.message : 'Could not load more items.' });
    }
  };
}

export function useIndexedPage<T>(path: string | null, key: (item: T) => string) {
  const loader = useMemo(() => new IndexedPageLoader<T>(key), [key]);
  const state = useSyncExternalStore(loader.subscribe, loader.snapshot, loader.snapshot);
  useEffect(() => { void loader.open(path); return () => loader.cancel(); }, [loader, path]);
  const active = state.path === path ? state : emptyState<T>(path);
  return { ...active, refresh: loader.refresh, loadMore: loader.loadMore };
}

export function useIndexedResource<T>(path: string | null) {
  const [version, setVersion] = useState(0);
  const [state, setState] = useState<{ path: string | null; data: T | null; loading: boolean; error: string | null }>({ path, data: null, loading: Boolean(path), error: null });
  useEffect(() => {
    const controller = new AbortController(); let active = true;
    setState({ path, data: null, loading: Boolean(path), error: null });
    if (path) void indexedApi<T>(path, controller.signal).then(data => {
      if (active) setState({ path, data, loading: false, error: null });
    }).catch(error => {
      if (active) setState({ path, data: null, loading: false, error: error instanceof Error ? error.message : 'Could not load NFT data. Please try again.' });
    });
    return () => { active = false; controller.abort(); };
  }, [path, version]);
  return { ...(state.path === path ? state : { path, data: null, loading: Boolean(path), error: null }), refresh: () => setVersion(value => value + 1) };
}
