import { describe, expect, it } from 'vitest';
import type { LocalCollectionDraft } from './client-oneshot-api';
import { collectionDraftStorageKey, readCollectionDrafts, saveCollectionDraft, writeCollectionDrafts } from './collection-drafts';

const draft: LocalCollectionDraft = { id: 'first', savedAt: '2026-11-10T12:00:00.000Z', name: 'Night', description: '', supply: '100', royalty: '5', price: '0', limit: '2', metadataMode: 'upload', metadataUrl: '', fileNames: ['art.webp'], publicStart: '', allowlist: false, allowlistStart: '', allowlistPrice: '0', addresses: '' };
function storage(raw: string | null = null) {
  const values = new Map<string, string>(); if (raw !== null) values.set(collectionDraftStorageKey, raw);
  return { values, getItem(key: string) { return values.get(key) ?? null; }, setItem(key: string, value: string) { values.set(key, value); } };
}

describe('browser collection draft preservation', () => {
  it('loads legacy optional terms without inventing end dates, preserving every saved draft', () => {
    const saved = storage(JSON.stringify([{ ...draft, futureField: 'keep' }]));
    const { items, snapshot } = readCollectionDrafts(saved);
    expect(items[0]).toMatchObject({ symbol: '', publicEnd: '', allowlistEnd: '', futureField: 'keep' });
    expect(saved.getItem(collectionDraftStorageKey)).toBe(snapshot);
  });

  it('refuses to replace corrupt records or silently discard malformed entries', () => {
    for (const raw of ['{', '{}', JSON.stringify([draft, { id: 'invalid' }]), JSON.stringify([draft, draft])]) {
      const saved = storage(raw);
      expect(() => readCollectionDrafts(saved)).toThrow('have not been changed');
      expect(() => writeCollectionDrafts(saved, [], null)).toThrow();
      expect(saved.getItem(collectionDraftStorageKey)).toBe(raw);
    }
  });

  it('refuses a21st new draft without evicting saved work and still allows editing at capacity', () => {
    const items = Array.from({ length: 20 }, (_, i) => ({ ...draft, id: `draft-${i}` }));
    expect(() => saveCollectionDraft(items, { ...draft, id: 'imported' })).toThrow('20 saved');
    expect(items).toHaveLength(20);
    const edited = saveCollectionDraft(items, { ...draft, id: 'draft-10', name: 'Edited' });
    expect(edited).toHaveLength(20); expect(edited[0].name).toBe('Edited');
    expect(new Set(edited.map(item => item.id))).toEqual(new Set(items.map(item => item.id)));
  });

  it('blocks a stale tab from overwriting newly saved or removed drafts', () => {
    const saved = storage(); const first = readCollectionDrafts(saved);
    const newest = writeCollectionDrafts(saved, [draft], first.snapshot);
    expect(() => writeCollectionDrafts(saved, [], first.snapshot)).toThrow('another tab');
    expect(saved.getItem(collectionDraftStorageKey)).toBe(newest);
    saved.values.delete(collectionDraftStorageKey);
    expect(() => writeCollectionDrafts(saved, [draft], newest)).toThrow('another tab');
  });

  it('returns browser quota failure without changing the stored snapshot', () => {
    const saved = storage();
    expect(() => writeCollectionDrafts({ getItem: saved.getItem, setItem() { throw new Error('quota'); } }, [draft], null)).toThrow('could not save');
    expect(saved.getItem(collectionDraftStorageKey)).toBeNull();
  });

  it('preserves old over-capacity lists during edits rather than truncating them', () => {
    const items = Array.from({ length: 21 }, (_, i) => ({ ...draft, id: String(i) }));
    const saved = storage(JSON.stringify(items));
    const loaded = readCollectionDrafts(saved);
    const edited = saveCollectionDraft(loaded.items, { ...loaded.items[0], name: 'Updated' });
    writeCollectionDrafts(saved, edited, loaded.snapshot);
    expect(readCollectionDrafts(saved).items).toHaveLength(21);
  });
});
