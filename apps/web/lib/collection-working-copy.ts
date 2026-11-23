import { z } from 'zod';
import type { LocalCollectionDraft } from './client-oneshot-api';
import { createTokenDraftAutosave } from './token-drafts';
import { readDraftStorage } from './draft-storage-migration';

export const LEGACY_COLLECTION_WORKING_COPY_KEY = 'oneshot.zero.collectionWorkingCopy.v1';
export const COLLECTION_WORKING_COPY_KEY = 'oneshot.collectionWorkingCopy.v2';
const maximumBytes = 1024 * 1024;
const text = (maximum: number) => z.string().max(maximum);

/** Editing permits incomplete and temporarily invalid values; launch validation remains separate. */
export const collectionWorkingTermsSchema = z.object({
  pricingNetwork: z.enum(['zero', 'zero-testnet', 'zero-mainnet', 'base-sepolia']).optional(),
  name: text(100), symbol: text(20), description: text(2048),
  supply: text(118), royalty: text(118), price: text(118), limit: text(118),
  metadataMode: z.enum(['upload', 'url']), metadataUrl: text(2048), fileNames: z.array(text(255)).max(1000),
  publicStart: text(80), publicEnd: text(80), allowlist: z.boolean(),
  allowlistStart: text(80), allowlistEnd: text(80), allowlistPrice: text(118), addresses: text(430_000),
}).strict();
const workingCopySchema = z.object({
  version: z.literal(1), terms: collectionWorkingTermsSchema,
  // A convenience link to a named browser draft only; it never confers account or launch authority.
  savedDraftId: z.string().min(1).max(200).refine(value => !value.startsWith('account:')).nullable(),
  unsaved: z.boolean(),
}).strict();
export type CollectionWorkingCopy = z.infer<typeof workingCopySchema>;
export type CollectionEditorSelection = { source: 'local' | 'account'; draft: LocalCollectionDraft; unsaved: boolean; savedDraftId: string | null };
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;
type WorkingState = { loaded: boolean; writable: boolean; status: 'loading' | 'saving' | 'saved' | 'memory'; error: string | null };

export class CollectionWorkingCopyError extends Error {
  constructor(public readonly reason: 'unreadable' | 'unavailable' | 'conflict' | 'invalid' | 'account', message: string) { super(message); }
}
const unavailable = () => new CollectionWorkingCopyError('unavailable', 'Your working copy could not be saved on this device. Keep this page open and try again, or download a draft backup.');
const conflict = () => new CollectionWorkingCopyError('conflict', 'Your collection working copy changed in another tab. Keep this page open or download a backup before reloading it.');

export function collectionWorkingTerms(draft: LocalCollectionDraft) {
  const input = { ...draft, symbol: draft.symbol ?? '', publicEnd: draft.publicEnd ?? '', allowlistEnd: draft.allowlistEnd ?? '' };
  return collectionWorkingTermsSchema.parse(Object.fromEntries(Object.keys(collectionWorkingTermsSchema.shape).map(key => [key, input[key as keyof typeof input]])));
}
export function collectionWorkingRecord(selection: CollectionEditorSelection): CollectionWorkingCopy {
  if (selection.source !== 'local') throw new CollectionWorkingCopyError('account', 'Account drafts stay in your account. Choose Copy to new draft to make a browser copy.');
  try { return workingCopySchema.parse({ version: 1, terms: collectionWorkingTerms(selection.draft), savedDraftId: selection.savedDraftId, unsaved: selection.unsaved }); }
  catch { throw new CollectionWorkingCopyError('invalid', 'Your working copy is still open but could not be saved. Check the field lengths and keep a draft backup before leaving.'); }
}
function parse(raw: string): CollectionWorkingCopy {
  try {
    if (new TextEncoder().encode(raw).length > maximumBytes) throw new Error();
    return workingCopySchema.parse(JSON.parse(raw));
  } catch { throw new CollectionWorkingCopyError('unreadable', 'Your saved collection working copy could not be read. It has not been changed. Keep this page open or download a backup before reloading it.'); }
}
function serialized(copy: CollectionWorkingCopy) {
  const raw = JSON.stringify(workingCopySchema.parse(copy));
  if (new TextEncoder().encode(raw).length > maximumBytes) throw new CollectionWorkingCopyError('invalid', 'This working copy is too large to save. Keep this page open and shorten its fields before trying again.');
  return raw;
}
export function readCollectionWorkingCopy(storage: Pick<Storage, 'getItem'>) {
  let selected: ReturnType<typeof readDraftStorage>;
  try { selected = readDraftStorage(storage, COLLECTION_WORKING_COPY_KEY, [LEGACY_COLLECTION_WORKING_COPY_KEY]); }
  catch { throw unavailable(); }
  const copy = selected.raw === null ? null : parse(selected.raw);
  if (copy && selected.sourceKey === LEGACY_COLLECTION_WORKING_COPY_KEY) delete copy.terms.pricingNetwork;
  return { snapshot: selected.snapshot, copy };
}
export function writeCollectionWorkingCopy(storage: Storage, copy: CollectionWorkingCopy, expectedSnapshot: string | null): string {
  const current = readCollectionWorkingCopy(storage);
  if (current.snapshot !== expectedSnapshot) throw conflict();
  let next: string;
  try { next = serialized(copy); }
  catch (error) { if (error instanceof CollectionWorkingCopyError) throw error; throw new CollectionWorkingCopyError('invalid', 'This working copy could not be saved. Keep this page open and check its fields.'); }
  if (next !== current.snapshot) {
    try { storage.setItem(COLLECTION_WORKING_COPY_KEY, next); }
    catch { throw unavailable(); }
  }
  return next;
}

/** A stored pointer is resolved only against named browser records, never an account read. */
export function restoreCollectionWorkingDraft(copy: CollectionWorkingCopy, saved: readonly LocalCollectionDraft[]): LocalCollectionDraft {
  const named = saved.find(item => item.id === copy.savedDraftId && !item.id.startsWith('account:'));
  return { ...copy.terms, id: named?.id || '', savedAt: named?.savedAt || '' };
}

/** Explicit reload requires successful reads; account closure may recover a safe local fallback. */
export function prepareLocalCollectionRestore(input: {
  copy: CollectionWorkingCopy | null | undefined;
  saved: readonly LocalCollectionDraft[] | undefined;
  mode: 'reload' | 'fallback';
  fresh(): LocalCollectionDraft;
}) {
  if (input.mode === 'reload' && (input.copy === undefined || input.saved === undefined))
    throw new CollectionWorkingCopyError('unreadable', 'Your saved working copy could not be reopened. Your open draft and selected images have not changed. Keep editing or download a backup before trying again.');
  const saved = input.saved ?? [];
  const linked = input.copy?.savedDraftId && saved.some(item => item.id === input.copy!.savedDraftId && !item.id.startsWith('account:'));
  return {
    draft: input.copy ? restoreCollectionWorkingDraft(input.copy, saved) : input.fresh(),
    unsaved: Boolean(input.copy && (input.copy.unsaved || input.copy.savedDraftId && !linked)),
  };
}
export function collectionReplacementNeedsWarning(input: { unsaved: boolean; selectedFilesUnsaved: boolean }) {
  return input.unsaved || input.selectedFilesUnsaved;
}
export function collectionExitNeedsWarning(input: { source: 'local' | 'account'; unsaved: boolean; selectedFilesUnsaved: boolean; persisted: boolean }) {
  return input.selectedFilesUnsaved || (input.source === 'account' ? input.unsaved : !input.persisted && input.unsaved);
}

/** Autosaves only the current local selection. Account edits cannot enter the browser record, even on unmount. */
export function createCollectionWorkingCopyStore(options: { storage(): Storage; current(): CollectionEditorSelection; delay?: number }) {
  let state: WorkingState = { loaded: false, writable: false, status: 'loading', error: null };
  let snapshot: string | null = null, confirmed: string | null = null;
  let loaded = false, writable = false;
  const listeners = new Set<() => void>();
  const publish = (next: WorkingState, notify = true) => { state = next; if (notify) for (const listener of listeners) listener(); };
  function failure(reason: unknown, notify: boolean) {
    const error = reason instanceof CollectionWorkingCopyError ? reason : unavailable();
    // Prior successful bytes no longer prove that the current copy remains saved.
    confirmed = null;
    if (['conflict', 'unreadable'].includes(error.reason)) writable = false;
    publish({ loaded, writable, status: 'memory', error: error.message }, notify);
  }
  function flush(notify = true) {
    if (options.current().source !== 'local') return false;
    if (!loaded || !writable) return false;
    try {
      const copy = collectionWorkingRecord(options.current());
      snapshot = writeCollectionWorkingCopy(options.storage(), copy, snapshot); confirmed = serialized(copy);
      publish({ loaded, writable, status: 'saved', error: null }, notify); return true;
    } catch (error) { failure(error, notify); return false; }
  }
  const autosave = createTokenDraftAutosave(flush, options.delay);
  return {
    snapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    load() {
      autosave.cancel();
      try {
        const loadedCopy = readCollectionWorkingCopy(options.storage());
        snapshot = loadedCopy.snapshot; confirmed = loadedCopy.copy ? serialized(loadedCopy.copy) : null;
        loaded = true; writable = true;
        publish({ loaded, writable, status: loadedCopy.copy ? 'saved' : 'saving', error: null }); return loadedCopy.copy;
      } catch (error) { loaded = true; writable = false; failure(error, true); return undefined; }
    },
    isPersisted() {
      if (options.current().source !== 'local' || !loaded || !writable || state.status !== 'saved') return false;
      try { return confirmed !== null && serialized(collectionWorkingRecord(options.current())) === confirmed; }
      catch { return false; }
    },
    schedule() {
      if (options.current().source !== 'local') { autosave.cancel(); return; }
      if (!loaded || !writable) return;
      publish({ loaded, writable, status: 'saving', error: null }); autosave.schedule();
    },
    flush,
    cancel: autosave.cancel,
    checkExternalChange() {
      if (!loaded) return;
      try { if (readDraftStorage(options.storage(), COLLECTION_WORKING_COPY_KEY, [LEGACY_COLLECTION_WORKING_COPY_KEY]).snapshot === snapshot) return; failure(conflict(), true); }
      catch { writable = false; failure(unavailable(), true); }
      autosave.cancel();
    },
    dispose: autosave.dispose,
  };
}
