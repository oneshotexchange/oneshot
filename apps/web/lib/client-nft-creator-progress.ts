import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { NftCreatorProgress, NftCreatorWorkspace } from '@oneshot/evm';
import type { NftLaunchApi, NftTransactionRecord } from './client-nft-launch';

export type CreatorWorkspaceScope = { identityScope: string; userId: string; draftId: string; revision: number; from: string; deploymentId: string };
export type CreatorProgressRequest = Parameters<NftLaunchApi['progress']>[0];
export type CreatorWorkspaceState = { key: string | null; data: NftCreatorWorkspace | null; loading: boolean; loadingMore: boolean; error: string | null };
const address = (value: unknown): value is string => typeof value === 'string' && /^0x[\da-f]{40}$/i.test(value);
const hash = (value: unknown): value is string => typeof value === 'string' && /^0x[\da-f]{64}$/i.test(value);
const id = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
export const creatorWorkspaceKey = (scope: CreatorWorkspaceScope | null) => scope ? JSON.stringify([scope.identityScope, scope.userId, scope.draftId, scope.revision, scope.from.toLowerCase(), scope.deploymentId]) : null;
const empty = (key: string | null): CreatorWorkspaceState => ({ key, data: null, loading: Boolean(key), loadingMore: false, error: null });
const invalid = (): never => { throw new Error('This saved launch does not match your account, draft or network. Refresh before continuing.'); };

export function validateCreatorWorkspace(value: NftCreatorWorkspace, scope: CreatorWorkspaceScope, launchId?: string): NftCreatorWorkspace {
  if (!object(value) || value.draftId !== scope.draftId || value.revision !== scope.revision || !address(value.from)
    || value.from.toLowerCase() !== scope.from.toLowerCase() || value.deploymentId !== scope.deploymentId
    || !Array.isArray(value.items) || value.items.length > 50 || !Array.isArray(value.pending) || value.pending.length > 50
    || !(value.nextCursor === null || typeof value.nextCursor === 'string' && value.nextCursor.length > 0 && value.nextCursor.length <= 4096)) return invalid();
  const ids = new Set<string>();
  for (const item of value.items) {
    if (!object(item) || !id(item.id) || ids.has(item.id) || !address(item.collection) || !hash(item.createHash)
      || typeof item.createdAt !== 'string' || !Number.isFinite(Date.parse(item.createdAt))) return invalid();
    ids.add(item.id);
  }
  const pendingIds = new Set<string>();
  for (const pending of value.pending) {
    if (!object(pending) || !id(pending.reviewId) || pendingIds.has(pending.reviewId) || !hash(pending.hash)) return invalid();
    pendingIds.add(pending.reviewId);
  }
  if (value.selected !== null) {
    const selected = value.selected;
    if (!object(selected) || !launchId || selected.id !== launchId || !id(selected.id) || !address(selected.collection) || !hash(selected.createHash)
      || !['created', 'configured', 'opened', 'schedule-expired', 'orphaned', 'pending', 'mismatch'].includes(selected.phase)
      || ![null, 'configure', 'open'].includes(selected.nextAction) || typeof selected.termsMatch !== 'boolean'
      || !(typeof selected.blockNumber === 'string' && /^(0|[1-9]\d{0,77})$/.test(selected.blockNumber))
      || !hash(selected.blockHash)) return invalid();
    const candidate = value.items.find(item => item.id === selected.id);
    if (candidate && (candidate.collection.toLowerCase() !== selected.collection.toLowerCase() || candidate.createHash.toLowerCase() !== selected.createHash.toLowerCase())) return invalid();
    if (selected.nextAction === 'configure' && selected.phase !== 'created' || selected.nextAction === 'open' && (selected.phase !== 'configured' || !selected.termsMatch)
      || ['opened', 'schedule-expired', 'orphaned', 'pending', 'mismatch'].includes(selected.phase) && selected.nextAction !== null) return invalid();
  } else if (launchId) return invalid();
  return value;
}

/** No fetch in this loader prepares a transaction, asks for a signature or selects the newest launch. */
export class NftCreatorWorkspaceLoader {
  private state: CreatorWorkspaceState = empty(null);
  private listeners = new Set<() => void>();
  private scope: CreatorWorkspaceScope | null = null;
  private selectedId: string | undefined;
  private generation = 0;
  private controller: AbortController | null = null;
  constructor(private readonly fetcher: NftLaunchApi['progress']) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(value: CreatorWorkspaceState) { this.state = value; for (const listener of this.listeners) listener(); }
  cancel() { this.generation++; this.controller?.abort(); this.controller = null; }
  async open(scope: CreatorWorkspaceScope | null, launchId?: string) {
    this.cancel(); this.scope = scope; this.selectedId = launchId;
    const key = creatorWorkspaceKey(scope), ticket = this.generation;
    this.publish(empty(key));
    if (!scope) return;
    const controller = new AbortController(); this.controller = controller;
    try {
      const input = { draftId: scope.draftId, expectedRevision: scope.revision, from: scope.from };
      let data = validateCreatorWorkspace(await this.fetcher({ ...input, ...(launchId ? { launchId } : {}) }, controller.signal), scope, launchId);
      if (ticket !== this.generation) return;
      if (!launchId && data.items.length === 1 && data.nextCursor === null) {
        const sole = data.items[0];
        this.selectedId = sole.id;
        data = validateCreatorWorkspace(await this.fetcher({ ...input, launchId: sole.id }, controller.signal), scope, sole.id);
        if (ticket !== this.generation) return;
      }
      this.publish({ key, data, loading: false, loadingMore: false, error: null });
    } catch (error) {
      if (ticket !== this.generation) return;
      this.publish({ key, data: null, loading: false, loadingMore: false, error: error instanceof Error ? error.message : 'Saved launches could not be checked.' });
    }
  }
  refresh = () => this.open(this.scope, this.selectedId);
  list = () => this.open(this.scope);
  select = (launchId: string) => {
    if (!id(launchId)) return Promise.resolve();
    return this.open(this.scope, launchId);
  };
  loadMore = async () => {
    const previous = this.state, scope = this.scope;
    if (!scope || !previous.data?.nextCursor || previous.loading || previous.loadingMore) return;
    const ticket = this.generation, controller = new AbortController(); this.controller = controller;
    this.publish({ ...previous, loadingMore: true, error: null });
    try {
      const next = validateCreatorWorkspace(await this.fetcher({ draftId: scope.draftId, expectedRevision: scope.revision, from: scope.from, cursor: previous.data.nextCursor }, controller.signal), scope);
      if (ticket !== this.generation) return;
      const merged = new Map(previous.data.items.map(item => [item.id, item]));
      for (const item of next.items) {
        const old = merged.get(item.id);
        if (old && (old.collection !== item.collection || old.createHash !== item.createHash)) return invalid();
        merged.set(item.id, item);
      }
      this.publish({ ...previous, data: { ...next, items: [...merged.values()], selected: previous.data.selected }, loadingMore: false, error: null });
    } catch (error) {
      if (ticket !== this.generation) return;
      this.publish({ ...previous, loadingMore: false, error: error instanceof Error ? error.message : 'More launches could not be loaded.' });
    }
  };
}

export function useNftCreatorWorkspace(api: Pick<NftLaunchApi, 'progress'>, scope: CreatorWorkspaceScope | null, initialLaunchId?: string) {
  const loader = useMemo(() => new NftCreatorWorkspaceLoader(api.progress), [api]);
  const state = useSyncExternalStore(loader.subscribe, loader.snapshot, loader.snapshot);
  const key = creatorWorkspaceKey(scope);
  useEffect(() => { void loader.open(scope, initialLaunchId); return () => loader.cancel(); }, [loader, key, initialLaunchId]);
  return { ...(state.key === key ? state : empty(key)), refresh: loader.refresh, list: loader.list, select: loader.select, loadMore: loader.loadMore };
}

export function assertCreatorRecovery(record: NftTransactionRecord, scope: CreatorWorkspaceScope, reviewId: string, transactionHash: string) {
  const review = record?.review;
  if (!review || review.id !== reviewId || review.action !== 'create' || (review.scope || 'draft') !== 'draft'
    || review.draftId !== scope.draftId || review.revision !== scope.revision || review.deploymentId !== scope.deploymentId
    || !address(review.from) || review.from.toLowerCase() !== scope.from.toLowerCase() || !hash(transactionHash)
    || record.transactionHash && record.transactionHash.toLowerCase() !== transactionHash.toLowerCase()) throw new Error('This transaction does not belong to the selected draft, creator wallet and network.');
}

export function creatorCollectionHref(progress: NftCreatorProgress | null, deploymentId: string): string | null {
  return progress?.phase === 'opened' && progress.termsMatch && address(progress.collection) && /^[a-f0-9]{64}$/.test(deploymentId)
    ? `/nfts/${progress.collection.toLowerCase()}?deployment=${deploymentId}` : null;
}

export function creatorCanStart(data: NftCreatorWorkspace | null, loading: boolean, error: string | null): boolean {
  return Boolean(data && !loading && !error && data.items.length === 0 && !data.nextCursor && data.pending.length === 0 && !data.selected);
}
