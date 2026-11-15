import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocalCollectionDraft } from './client-oneshot-api';
import { collectionDraftStorageKey } from './collection-drafts';
import {
  COLLECTION_WORKING_COPY_KEY, collectionExitNeedsWarning, collectionReplacementNeedsWarning, collectionWorkingRecord,
  createCollectionWorkingCopyStore, prepareLocalCollectionRestore, readCollectionWorkingCopy, restoreCollectionWorkingDraft, writeCollectionWorkingCopy,
  type CollectionEditorSelection,
} from './collection-working-copy';

const draft = (name = 'In progress'): LocalCollectionDraft => ({
  id: '', savedAt: '', name, symbol: '', description: '', supply: '', royalty: '5.', price: '0.', limit: '',
  metadataMode: 'upload', metadataUrl: 'https://', fileNames: ['original.png'], publicStart: '2026-', publicEnd: '',
  allowlist: true, allowlistStart: '', allowlistEnd: '', allowlistPrice: '', addresses: '0xunfinished',
});
const selection = (changes: Partial<CollectionEditorSelection> = {}): CollectionEditorSelection => ({ source: 'local', draft: draft(), unsaved: true, savedDraftId: null, ...changes });
function memory(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return { values, getItem: vi.fn((key: string) => values.get(key) ?? null), setItem: vi.fn((key: string, value: string) => { values.set(key, value); }) };
}
afterEach(() => vi.useRealTimers());

describe('collection working-copy preservation', () => {
  it('persists incomplete and temporarily invalid terms separately, without changing any named-draft bytes', () => {
    const namedRaw = '[ { "id": "legacy", "futureField": "keep exact bytes" } ]';
    const storage = memory({ [collectionDraftStorageKey]: namedRaw });
    const current = selection({ draft: { ...draft(), supply: '1001', royalty: '-', limit: '0', price: '1e-', allowlistPrice: 'invalid while editing' } });
    expect(readCollectionWorkingCopy(storage)).toEqual({ copy: null, snapshot: null });
    const copy = collectionWorkingRecord(current), snapshot = writeCollectionWorkingCopy(storage, copy, null);
    expect(readCollectionWorkingCopy(storage)).toEqual({ copy, snapshot });
    expect(storage.values.get(collectionDraftStorageKey)).toBe(namedRaw);
    expect(storage.setItem.mock.calls.map(([key]) => key)).toEqual([COLLECTION_WORKING_COPY_KEY]);
  });

  it('whitelists editable fields without persisting account authority, prepared snapshots, proofs, credentials or image bytes', () => {
    const value = { ...draft(), ownerUserId: 'private-user', creatorWallet: '0xprivate', snapshot: { contentHash: 'private' }, accessToken: 'private-token', proof: ['private-proof'], files: [{ bytes: 'private-image' }] };
    const raw = JSON.stringify(collectionWorkingRecord(selection({ draft: value })));
    for (const secret of ['private-user', 'private-token', 'private-proof', 'private-image', 'snapshot', 'creatorWallet', 'ownerUserId', 'files']) expect(raw).not.toContain(secret);
    expect(JSON.parse(raw).terms.fileNames).toEqual(['original.png']);
    expect(JSON.parse(raw).terms).not.toHaveProperty('id');
    expect(JSON.parse(raw).terms).not.toHaveProperty('savedAt');
  });

  it('refuses account-origin selections and account-prefixed pointers rather than manufacturing browser launch authority', () => {
    expect(() => collectionWorkingRecord(selection({ source: 'account' }))).toThrow('stay in your account');
    expect(() => collectionWorkingRecord(selection({ savedDraftId: 'account:remote-id' }))).toThrow('could not be saved');
  });

  it.each(['{', '{}', 'null', '[1]', '{"version":2}', JSON.stringify({ ...collectionWorkingRecord(selection()), session: 'private' })])('protects malformed or unsupported working copy %s without rewriting it', raw => {
    const storage = memory({ [COLLECTION_WORKING_COPY_KEY]: raw });
    expect(() => readCollectionWorkingCopy(storage)).toThrow('has not been changed');
    expect(() => writeCollectionWorkingCopy(storage, collectionWorkingRecord(selection()), raw)).toThrow('has not been changed');
    expect(storage.values.get(COLLECTION_WORKING_COPY_KEY)).toBe(raw);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('rejects hidden authority added to stored terms and oversized stored data', () => {
    const copy = collectionWorkingRecord(selection());
    for (const raw of [JSON.stringify({ ...copy, terms: { ...copy.terms, snapshot: {} } }), ' '.repeat(1024 * 1024 + 1)]) {
      expect(() => readCollectionWorkingCopy(memory({ [COLLECTION_WORKING_COPY_KEY]: raw }))).toThrow('could not be read');
    }
  });

  it('resolves a convenience pointer only against named browser drafts and otherwise restores an unlinked editable copy', () => {
    const named = { ...draft('Named copy'), id: 'browser-one', savedAt: '2026-11-14T12:00:00Z' };
    const copy = collectionWorkingRecord(selection({ savedDraftId: named.id }));
    expect(restoreCollectionWorkingDraft(copy, [named])).toEqual({ ...copy.terms, id: named.id, savedAt: named.savedAt });
    expect(restoreCollectionWorkingDraft(copy, [])).toEqual({ ...copy.terms, id: '', savedAt: '' });
    expect(restoreCollectionWorkingDraft(copy, [{ ...named, id: 'account:browser-one' }]).id).toBe('');
  });

  it('blocks stale writes after another tab replaces or removes the working key', () => {
    const storage = memory();
    const first = writeCollectionWorkingCopy(storage, collectionWorkingRecord(selection()), null);
    const other = writeCollectionWorkingCopy(storage, collectionWorkingRecord(selection({ draft: draft('Other tab') })), first);
    expect(() => writeCollectionWorkingCopy(storage, collectionWorkingRecord(selection()), first)).toThrow('another tab');
    expect(storage.values.get(COLLECTION_WORKING_COPY_KEY)).toBe(other);
    storage.values.delete(COLLECTION_WORKING_COPY_KEY);
    expect(() => writeCollectionWorkingCopy(storage, collectionWorkingRecord(selection()), other)).toThrow('another tab');
    expect(storage.values.has(COLLECTION_WORKING_COPY_KEY)).toBe(false);
  });

  it('returns safe read/write failures and never claims the latest terms were persisted after quota failure', () => {
    const storage = memory(), current = selection();
    const store = createCollectionWorkingCopyStore({ storage: () => storage, current: () => current });
    store.load(); expect(store.flush()).toBe(true);
    const previous = storage.values.get(COLLECTION_WORKING_COPY_KEY);
    current.draft = draft('Latest edit');
    storage.setItem.mockImplementation(() => { throw new Error('QuotaExceededError: raw browser details'); });
    expect(store.flush()).toBe(false); expect(store.isPersisted()).toBe(false);
    expect(store.snapshot()).toMatchObject({ status: 'memory', error: expect.stringContaining('could not be saved') });
    expect(store.snapshot().error).not.toContain('QuotaExceededError');
    expect(storage.values.get(COLLECTION_WORKING_COPY_KEY)).toBe(previous);
    const denied = createCollectionWorkingCopyStore({ storage() { throw new Error('SecurityError'); }, current: () => current });
    expect(denied.load()).toBeUndefined(); expect(denied.flush()).toBe(false);
    expect(denied.snapshot()).toMatchObject({ loaded: true, writable: false, status: 'memory' });
  });

  it('keeps unreadable or conflicting storage locked until an explicit successful reload', () => {
    vi.useFakeTimers();
    const storage = memory(), current = selection();
    const store = createCollectionWorkingCopyStore({ storage: () => storage, current: () => current });
    store.load(); store.flush(); current.draft = draft('Pending local edit'); store.schedule();
    const other = JSON.stringify(collectionWorkingRecord(selection({ draft: draft('Other tab') })));
    storage.values.set(COLLECTION_WORKING_COPY_KEY, other); store.checkExternalChange();
    vi.runAllTimers();
    expect(store.snapshot()).toMatchObject({ writable: false, status: 'memory' });
    expect(store.flush()).toBe(false); expect(storage.values.get(COLLECTION_WORKING_COPY_KEY)).toBe(other);
    expect(store.load()?.terms.name).toBe('Other tab');
    expect(store.snapshot().writable).toBe(true);
  });

  it('invalidates persistence proof after another tab replaces a previously saved unnamed copy', () => {
    const storage = memory(), current = selection();
    const store = createCollectionWorkingCopyStore({ storage: () => storage, current: () => current });
    store.load(); expect(store.flush()).toBe(true); expect(store.isPersisted()).toBe(true);
    const other = JSON.stringify(collectionWorkingRecord(selection({ draft: draft('Other tab') })));
    storage.values.set(COLLECTION_WORKING_COPY_KEY, other); store.checkExternalChange();
    expect(store.flush()).toBe(false); expect(store.isPersisted()).toBe(false);
    expect(collectionExitNeedsWarning({ source: current.source, unsaved: current.unsaved, selectedFilesUnsaved: false, persisted: store.isPersisted() })).toBe(true);
    expect(current.draft.name).toBe('In progress'); expect(storage.values.get(COLLECTION_WORKING_COPY_KEY)).toBe(other);
  });

  it.each(['unreadable', 'unavailable'])('refuses a destructive replacement candidate after an explicit %s reload failure', failure => {
    const storage = memory(), current = selection();
    const store = createCollectionWorkingCopyStore({ storage: () => storage, current: () => current });
    store.load(); expect(store.flush()).toBe(true);
    const original = current.draft, fresh = vi.fn(() => draft('Blank fallback'));
    if (failure === 'unreadable') storage.values.set(COLLECTION_WORKING_COPY_KEY, '{');
    else storage.getItem.mockImplementation(() => { throw new Error('SecurityError: private browser details'); });
    const copy = store.load();
    expect(copy).toBeUndefined(); expect(store.isPersisted()).toBe(false);
    expect(() => prepareLocalCollectionRestore({ copy, saved: [], mode: 'reload', fresh })).toThrow('open draft and selected images have not changed');
    expect(fresh).not.toHaveBeenCalled(); expect(current.draft).toBe(original);
    expect(store.snapshot().error).not.toContain('SecurityError');
  });

  it('does not resolve a saved pointer after a named-browser-draft read failure on explicit reload', () => {
    const copy = collectionWorkingRecord(selection({ savedDraftId: 'browser-one', unsaved: false })), fresh = vi.fn(() => draft('Blank fallback'));
    expect(() => prepareLocalCollectionRestore({ copy, saved: undefined, mode: 'reload', fresh })).toThrow('could not be reopened');
    expect(fresh).not.toHaveBeenCalled();
    expect(copy.savedDraftId).toBe('browser-one');
  });

  it('permits privacy fallback to fresh local fields when storage cannot be read', () => {
    const safe = draft('Safe local fields'), fresh = vi.fn(() => safe);
    expect(prepareLocalCollectionRestore({ copy: undefined, saved: undefined, mode: 'fallback', fresh })).toEqual({ draft: safe, unsaved: false });
    expect(fresh).toHaveBeenCalledOnce();
  });

  it('restores local working terms without claiming a named link when named-browser drafts are unreadable during fallback', () => {
    const copy = collectionWorkingRecord(selection({ savedDraftId: 'browser-one', unsaved: false })), fresh = vi.fn(() => draft('Blank fallback'));
    const restored = prepareLocalCollectionRestore({ copy, saved: undefined, mode: 'fallback', fresh });
    expect(restored).toEqual({ draft: { ...copy.terms, id: '', savedAt: '' }, unsaved: true });
    expect(fresh).not.toHaveBeenCalled();
  });

  it('initializes a new editable draft only after explicit reload successfully reads an absent working key', () => {
    const safe = draft('New working copy');
    expect(prepareLocalCollectionRestore({ copy: null, saved: [], mode: 'reload', fresh: () => safe })).toEqual({ draft: safe, unsaved: false });
  });

  it('debounces incomplete edits and flushes the latest in-memory edit before route unmount', () => {
    vi.useFakeTimers();
    const storage = memory(), current = selection();
    const store = createCollectionWorkingCopyStore({ storage: () => storage, current: () => current, delay: 350 });
    store.load(); store.schedule(); current.draft = draft('Latest unfinished text');
    vi.advanceTimersByTime(349); expect(storage.setItem).not.toHaveBeenCalled();
    store.dispose();
    expect(readCollectionWorkingCopy(storage).copy?.terms.name).toBe('Latest unfinished text');
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    vi.runAllTimers(); expect(storage.setItem).toHaveBeenCalledTimes(1);
  });

  it('explicit lifecycle flush preserves current terms immediately and a later timer cannot restore an older edit', () => {
    vi.useFakeTimers();
    const storage = memory(), current = selection();
    const store = createCollectionWorkingCopyStore({ storage: () => storage, current: () => current });
    store.load(); store.schedule(); current.draft = draft('Hidden-page edit');
    expect(store.flush()).toBe(true);
    expect(readCollectionWorkingCopy(storage).copy?.terms.name).toBe('Hidden-page edit');
    vi.runAllTimers(); expect(storage.setItem).toHaveBeenCalledTimes(1);
  });

  it('cancels pending local autosave when an account draft opens and never serializes that draft on unmount', () => {
    vi.useFakeTimers();
    const storage = memory(), current = selection();
    const store = createCollectionWorkingCopyStore({ storage: () => storage, current: () => current });
    store.load(); store.flush(); const local = storage.values.get(COLLECTION_WORKING_COPY_KEY);
    current.draft = draft('Unsaved local text'); store.schedule();
    current.source = 'account'; current.draft = draft('Private account title'); store.schedule();
    vi.runAllTimers(); store.dispose();
    expect(storage.values.get(COLLECTION_WORKING_COPY_KEY)).toBe(local);
    expect(store.isPersisted()).toBe(false);
    expect(storage.values.get(COLLECTION_WORKING_COPY_KEY)).not.toContain('Private account title');
  });

  it('does not overwrite a corrupted key during unmount, including after it previously loaded successfully', () => {
    const storage = memory(), current = selection();
    const store = createCollectionWorkingCopyStore({ storage: () => storage, current: () => current });
    store.load(); store.flush(); storage.values.set(COLLECTION_WORKING_COPY_KEY, '{');
    store.dispose(); expect(storage.values.get(COLLECTION_WORKING_COPY_KEY)).toBe('{');
    expect(store.snapshot().status).toBe('memory');
  });
});

describe('collection replacement and departure protection', () => {
  it('requires replacement consent for unnamed/edited terms and selected files even after terms autosave', () => {
    expect(collectionReplacementNeedsWarning({ unsaved: true, selectedFilesUnsaved: false })).toBe(true);
    expect(collectionReplacementNeedsWarning({ unsaved: false, selectedFilesUnsaved: true })).toBe(true);
    expect(collectionReplacementNeedsWarning({ unsaved: false, selectedFilesUnsaved: false })).toBe(false);
  });

  it('allows navigation after local terms flush while protecting image bytes, failed saves and unsaved account edits', () => {
    const local = { source: 'local' as const, unsaved: true, selectedFilesUnsaved: false, persisted: true };
    expect(collectionExitNeedsWarning(local)).toBe(false);
    expect(collectionExitNeedsWarning({ ...local, selectedFilesUnsaved: true })).toBe(true);
    expect(collectionExitNeedsWarning({ ...local, persisted: false })).toBe(true);
    expect(collectionExitNeedsWarning({ ...local, source: 'account' })).toBe(true);
    expect(collectionExitNeedsWarning({ ...local, source: 'account', unsaved: false })).toBe(false);
    expect(collectionExitNeedsWarning({ ...local, unsaved: false, persisted: false })).toBe(false);
  });
});
