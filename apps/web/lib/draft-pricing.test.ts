import { describe, expect, it, vi } from 'vitest';
import { collectionCopyForBase, tokenCopyForBase } from './draft-pricing';
import { draftCanLaunchOnNetwork, draftPricingNetwork, readNftNetwork } from './nft-network';
import { accountCollectionLocalDraft, collectionAccountInput, type LocalCollectionDraft } from './client-oneshot-api';
import type { OneshotDraft } from './oneshot-draft-schema';
import { legacyCollectionDraftStorageKey, collectionDraftStorageKey, readCollectionDrafts, saveCollectionDraft, writeCollectionDrafts } from './collection-drafts';
import { COLLECTION_WORKING_COPY_KEY, LEGACY_COLLECTION_WORKING_COPY_KEY, collectionWorkingRecord, readCollectionWorkingCopy, writeCollectionWorkingCopy } from './collection-working-copy';
import { LEGACY_TOKEN_DRAFTS_STORAGE_KEY, TOKEN_DRAFTS_STORAGE_KEY, emptyTokenDraft, emptyTokenDraftWorkspace, newTokenDraft, readTokenDrafts, writeTokenDrafts } from './token-drafts';
import { collectionDraftBackup, parseCollectionDraftBackup, parseDraftBackup, serializeDraftBackup } from './draft-backup';

const local: LocalCollectionDraft = { id: 'old-browser-draft', savedAt: '2026-11-14T12:00:00.000Z', name: 'Originals', symbol: 'SHOT', description: 'Art',
  supply: '2', royalty: '5', price: '9007199254740993.000000000000000001', limit: '2', metadataMode: 'url', metadataUrl: 'https://example.com/metadata.json', fileNames: [],
  publicStart: '2026-12-01T10:00:00', publicEnd: '2026-12-02T10:00:00', allowlist: false, allowlistStart: '', allowlistEnd: '', allowlistPrice: '12.123456789012345678', addresses: '' };
function memory(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return { values, getItem: vi.fn((key: string) => values.get(key) ?? null), setItem: vi.fn((key: string, raw: string) => { values.set(key, raw); }) };
}
const base = readNftNetwork({ mode: 'base-sepolia', chainId: 84532, name: 'Base Sepolia', nativeSymbol: 'ETH', nativeDecimals: 18 })!;

describe('explicit Base pricing copies', () => {
  it('clears both NFT prices and browser identity while preserving editable nonfinancial terms and the original object', () => {
    const original = { ...local, ownerUserId: 'private-user', snapshot: { private: true }, accessToken: 'private-token', files: ['private-bytes'] };
    const before = JSON.stringify(original), copy = collectionCopyForBase(original);
    expect(copy).toMatchObject({ pricingNetwork: 'base-sepolia', price: '', allowlistPrice: '', id: '', savedAt: '', name: local.name, supply: local.supply, royalty: local.royalty, metadataUrl: local.metadataUrl });
    expect(JSON.stringify(original)).toBe(before);
    for (const field of ['ownerUserId', 'snapshot', 'accessToken', 'files']) expect(copy).not.toHaveProperty(field);
    expect(() => collectionAccountInput(copy)).toThrow();
    expect(collectionAccountInput({ ...copy, price: '0.001000000000000001' })).toMatchObject({ pricingNetwork: 'base-sepolia', publicPrice: '0.001000000000000001' });
  });

  it('clears a token valuation instead of changing the denomination of the original amount', () => {
    const legacy = { ...emptyTokenDraft(), pricingNetwork: undefined, name: 'Orbit', symbol: 'ORBIT', openingValuation: '123.000000000000000001' };
    const copy = tokenCopyForBase(legacy);
    expect(copy).toMatchObject({ pricingNetwork: 'base-sepolia', name: 'Orbit', symbol: 'ORBIT', openingValuation: '' });
    expect(legacy.openingValuation).toBe('123.000000000000000001'); expect(draftPricingNetwork(legacy)).toBe('zero');
  });

  it('keeps legacy and explicit Zero account records out of Base launch review until a new copy is repriced', () => {
    expect(draftCanLaunchOnNetwork({}, base)).toBe(false);
    expect(draftCanLaunchOnNetwork({ pricingNetwork: 'zero' }, base)).toBe(false);
    expect(draftCanLaunchOnNetwork({ pricingNetwork: 'base-sepolia' }, base)).toBe(true);
    expect(draftCanLaunchOnNetwork({ pricingNetwork: 'base-sepolia' }, null)).toBe(false);
    const input = collectionAccountInput(local);
    const record: OneshotDraft = { ...input, id: 'account-id', ownerUserId: 'owner', revision: 2, status: 'prepared', createdAt: local.savedAt, updatedAt: local.savedAt,
      snapshot: { manifestHash: 'a'.repeat(64), contentHash: `0x${'b'.repeat(64)}`, baseUri: 'https://example.test/frozen/', collectionUri: 'https://example.test/frozen/collection', itemCount: 2, preparedAt: local.savedAt } };
    const before = JSON.stringify(record), copy = collectionCopyForBase(accountCollectionLocalDraft(record));
    expect(copy.price).toBe(''); expect(copy.allowlistPrice).toBe(''); expect(copy.id).toBe('');
    expect(JSON.stringify(record)).toBe(before); expect(copy).not.toHaveProperty('snapshot');
  });
});

describe('non-destructive draft storage migration', () => {
  it('copies old named NFT drafts into a separate key without altering their original bytes or currencies', () => {
    const raw = JSON.stringify([{ ...local, futureField: 'keep' }], null, 2), storage = memory({ [legacyCollectionDraftStorageKey]: raw });
    const loaded = readCollectionDrafts(storage);
    expect(loaded.items[0].pricingNetwork).toBeUndefined(); expect(storage.setItem).not.toHaveBeenCalled();
    const copy = { ...collectionCopyForBase(loaded.items[0]), id: 'new-base-copy', savedAt: local.savedAt };
    writeCollectionDrafts(storage, saveCollectionDraft(loaded.items, copy), loaded.snapshot);
    expect(storage.values.get(legacyCollectionDraftStorageKey)).toBe(raw);
    expect(storage.values.has(collectionDraftStorageKey)).toBe(true);
    const reopened = readCollectionDrafts(storage).items;
    expect(reopened.find(item => item.id === 'old-browser-draft')?.price).toBe(local.price);
    expect(reopened.find(item => item.id === 'old-browser-draft')?.pricingNetwork).toBeUndefined();
    expect(reopened.find(item => item.id === 'new-base-copy')?.pricingNetwork).toBe('base-sepolia');
  });

  it('preserves a legacy incomplete NFT working copy and uses the new key only for the explicit Base copy', () => {
    const copy = collectionWorkingRecord({ source: 'local', draft: { ...local, price: '0.' }, unsaved: true, savedDraftId: null });
    const raw = JSON.stringify(copy, null, 2), storage = memory({ [LEGACY_COLLECTION_WORKING_COPY_KEY]: raw });
    const loaded = readCollectionWorkingCopy(storage);
    expect(loaded.copy?.terms.price).toBe('0.'); expect(loaded.copy?.terms.pricingNetwork).toBeUndefined();
    const baseCopy = collectionWorkingRecord({ source: 'local', draft: collectionCopyForBase({ ...loaded.copy!.terms, id: '', savedAt: '' }), unsaved: true, savedDraftId: null });
    writeCollectionWorkingCopy(storage, baseCopy, loaded.snapshot);
    expect(storage.values.get(LEGACY_COLLECTION_WORKING_COPY_KEY)).toBe(raw);
    expect(storage.values.has(COLLECTION_WORKING_COPY_KEY)).toBe(true);
    expect(readCollectionWorkingCopy(storage).copy?.terms).toMatchObject({ pricingNetwork: 'base-sepolia', price: '', allowlistPrice: '' });
  });

  it('preserves every legacy token plan and exact value when the open draft becomes a new Base copy', () => {
    const legacy = { ...emptyTokenDraft(), pricingNetwork: undefined, name: 'Old plan', symbol: 'OLD', openingValuation: '123.000000000000000001' };
    const workspace = { ...emptyTokenDraftWorkspace(), working: { draft: legacy, savedId: '00000000-0000-4000-8000-000000000001' }, saved: [{ id: '00000000-0000-4000-8000-000000000001', savedAt: local.savedAt, draft: legacy }] };
    const raw = JSON.stringify(workspace, null, 2), storage = memory({ [LEGACY_TOKEN_DRAFTS_STORAGE_KEY]: raw });
    const loaded = readTokenDrafts(storage);
    expect(loaded.source).toBe('legacy-workspace'); expect(loaded.workspace.working.draft.pricingNetwork).toBeUndefined();
    const next = newTokenDraft(loaded.workspace, tokenCopyForBase(loaded.workspace.working.draft));
    writeTokenDrafts(storage, next, loaded.snapshot);
    expect(storage.values.get(LEGACY_TOKEN_DRAFTS_STORAGE_KEY)).toBe(raw); expect(storage.values.has(TOKEN_DRAFTS_STORAGE_KEY)).toBe(true);
    const reopened = readTokenDrafts(storage).workspace;
    expect(reopened.working.draft).toMatchObject({ pricingNetwork: 'base-sepolia', openingValuation: '' });
    expect(reopened.saved[0].draft.pricingNetwork).toBeUndefined();
    expect(reopened.saved[0].draft.openingValuation).toBe(legacy.openingValuation);
  });

  it('rejects a stale first migration when another tab changes the original bytes, without creating a competing copy', () => {
    const storage = memory({ [legacyCollectionDraftStorageKey]: JSON.stringify([local]) }), loaded = readCollectionDrafts(storage);
    const changed = JSON.stringify([{ ...local, name: 'Changed elsewhere' }]); storage.values.set(legacyCollectionDraftStorageKey, changed);
    expect(() => writeCollectionDrafts(storage, loaded.items, loaded.snapshot)).toThrow('another tab');
    expect(storage.values.get(legacyCollectionDraftStorageKey)).toBe(changed); expect(storage.values.has(collectionDraftStorageKey)).toBe(false);
  });

  it('never replaces malformed original storage or silently falls back past a corrupt new key', () => {
    const malformed = memory({ [legacyCollectionDraftStorageKey]: '{' });
    expect(() => readCollectionDrafts(malformed)).toThrow('have not been changed'); expect(malformed.setItem).not.toHaveBeenCalled();
    const newer = memory({ [legacyCollectionDraftStorageKey]: JSON.stringify([local]), [collectionDraftStorageKey]: '{' });
    expect(() => readCollectionDrafts(newer)).toThrow('have not been changed'); expect(newer.setItem).not.toHaveBeenCalled();
  });

  it('protects the original working copy and token plans if their first migration becomes stale', () => {
    const record = collectionWorkingRecord({ source: 'local', draft: local, unsaved: true, savedDraftId: null });
    const working = memory({ [LEGACY_COLLECTION_WORKING_COPY_KEY]: JSON.stringify(record) });
    const loadedWorking = readCollectionWorkingCopy(working);
    working.values.set(LEGACY_COLLECTION_WORKING_COPY_KEY, JSON.stringify({ ...record, unsaved: false }));
    expect(() => writeCollectionWorkingCopy(working, record, loadedWorking.snapshot)).toThrow('another tab');
    expect(working.values.has(COLLECTION_WORKING_COPY_KEY)).toBe(false);
    const workspace = emptyTokenDraftWorkspace(), token = memory({ [LEGACY_TOKEN_DRAFTS_STORAGE_KEY]: JSON.stringify(workspace) });
    const loadedToken = readTokenDrafts(token);
    token.values.set(LEGACY_TOKEN_DRAFTS_STORAGE_KEY, JSON.stringify({ ...workspace, working: { draft: { ...workspace.working.draft, name: 'Edited elsewhere' }, savedId: null } }));
    expect(() => writeTokenDrafts(token, loadedToken.workspace, loadedToken.snapshot)).toThrow('another tab');
    expect(token.values.has(TOKEN_DRAFTS_STORAGE_KEY)).toBe(false);
  });

  it('does not claim a successful migration if storage rejects reads or writes', () => {
    const denied = { getItem: vi.fn(() => { throw new Error('private provider details'); }), setItem: vi.fn() };
    for (const read of [() => readCollectionDrafts(denied), () => readCollectionWorkingCopy(denied), () => readTokenDrafts(denied)]) {
      expect(read).toThrow(); expect(read).not.toThrow('private provider details');
    }
    expect(denied.setItem).not.toHaveBeenCalled();
    const original = JSON.stringify([local]), storage = memory({ [legacyCollectionDraftStorageKey]: original });
    const loaded = readCollectionDrafts(storage); storage.setItem.mockImplementation(() => { throw new Error('quota'); });
    expect(() => writeCollectionDrafts(storage, loaded.items, loaded.snapshot)).toThrow('could not save');
    expect(storage.values.get(legacyCollectionDraftStorageKey)).toBe(original); expect(storage.values.has(collectionDraftStorageKey)).toBe(false);
  });
});

describe('backup pricing provenance', () => {
  it('writes v2 Base denomination explicitly while v1 imports remain Zero plans with exact old amounts', () => {
    const baseCopy = { ...collectionCopyForBase(local), price: '0.001000000000000001' };
    const exported = collectionDraftBackup(baseCopy), envelope = JSON.parse(exported);
    expect(envelope.version).toBe(2); expect(parseCollectionDraftBackup(exported).pricingNetwork).toBe('base-sepolia');
    const legacy = JSON.stringify({ ...envelope, version: 1, draft: { ...envelope.draft, price: local.price } });
    expect(parseCollectionDraftBackup(legacy).pricingNetwork).toBeUndefined();
    expect(parseCollectionDraftBackup(legacy).price).toBe(local.price);
    const token = tokenCopyForBase({ ...emptyTokenDraft(), openingValuation: '44' });
    expect(parseDraftBackup(serializeDraftBackup('token', token), 'token', value => value)).toMatchObject({ pricingNetwork: 'base-sepolia', openingValuation: '' });
  });
});
