import { describe, expect, it } from 'vitest';
import { collectionDraftBackup, draftBackupFilename, draftBackupMaxBytes, parseCollectionDraftBackup, parseDraftBackup, serializeDraftBackup } from './draft-backup';
import type { LocalCollectionDraft } from './client-oneshot-api';

const draft: LocalCollectionDraft = {
  id: 'browser-original', savedAt: '2026-11-10T10:00:00Z', name: 'Night Shift', symbol: 'NIGHT', description: 'A shared-art edition',
  supply: '100', royalty: '5', price: '0.001', limit: '2', metadataMode: 'upload', metadataUrl: '', fileNames: ['night.webp'],
  publicStart: '2026-12-01T12:00:00', publicEnd: '2026-12-02T12:00:00', allowlist: true,
  allowlistStart: '2026-11-30T12:00:00', allowlistEnd: '2026-12-01T11:59:59', allowlistPrice: '0', addresses: '0x' + '1'.repeat(40),
};

describe('portable creator drafts', () => {
  it('round trips exact collection prices, schedules, royalty terms and artwork names without ownership', () => {
    const backedUp = collectionDraftBackup(draft);
    const { id, savedAt, ...terms } = draft;
    expect(parseCollectionDraftBackup(backedUp)).toEqual(terms);
    expect(backedUp).not.toContain('browser-original');
    expect(backedUp).not.toContain('savedAt');
    expect(draft.id).toBe(id);
    expect(draft.savedAt).toBe(savedAt);
  });

  it('exports whitelisted terms only even if the editor carries account or secret fields', () => {
    const expanded = { ...draft, ownerUserId: 'private-owner', accessToken: 'private-token', status: 'prepared', snapshot: { baseUri: 'private-snapshot' } };
    const json = collectionDraftBackup(expanded);
    expect(json).not.toMatch(/private-|ownerUserId|accessToken|snapshot|prepared/);
  });

  it('supports incomplete work and older drafts without inventing mint end dates', () => {
    const incomplete = { ...draft, symbol: undefined, supply: '', price: '', royalty: '', limit: '', publicEnd: undefined, allowlistEnd: undefined };
    const result = parseCollectionDraftBackup(collectionDraftBackup(incomplete));
    expect(result).toMatchObject({ symbol: '', publicEnd: '', allowlistEnd: '', supply: '', price: '' });
  });

  it('rejects a different kind and unsupported versions instead of guessing the file contents', () => {
    expect(() => parseCollectionDraftBackup(serializeDraftBackup('token', {}))).toThrow('token draft');
    const envelope = JSON.parse(collectionDraftBackup(draft));
    expect(() => parseCollectionDraftBackup(JSON.stringify({ ...envelope, version: 3 }))).toThrow('not a supported');
    expect(() => parseCollectionDraftBackup(JSON.stringify(draft))).toThrow('not a supported');
  });

  it('rejects malformed data, hidden authority fields and out-of-bounds values as one whole file', () => {
    const original = JSON.parse(collectionDraftBackup(draft));
    for (const fields of [{ royalty: '100' }, { supply: '1001' }, { limit: '-1' }, { fileNames: [4] }, { allowlist: 'false' }, { publicEnd: {} }, { ownerUserId: 'someone' }, { snapshot: {} }, { id: 'account:someone' }, { __proto__: null, accessToken: 'token' }]) {
      expect(() => parseCollectionDraftBackup(JSON.stringify({ ...original, draft: { ...original.draft, ...fields } }))).toThrow('not a supported');
    }
    expect(() => parseCollectionDraftBackup('{')).toThrow('saved drafts have not changed');
    expect(() => parseCollectionDraftBackup('null')).toThrow('not a supported');
  });

  it('enforces the byte limit for UTF-8 input and refuses overlarge exports', () => {
    expect(() => parseCollectionDraftBackup('é'.repeat(draftBackupMaxBytes / 2 + 1))).toThrow('smaller than 1 MiB');
    expect(() => serializeDraftBackup('collection', { name: 'x'.repeat(draftBackupMaxBytes) })).toThrow('too large');
    const emptySize = new TextEncoder().encode(serializeDraftBackup('token', { name: '' })).length;
    const exact = serializeDraftBackup('token', { name: 'x'.repeat(draftBackupMaxBytes - emptySize) });
    expect(new TextEncoder().encode(exact).length).toBe(draftBackupMaxBytes);
    expect(() => parseDraftBackup(exact, 'token', value => value)).not.toThrow();
    expect(() => serializeDraftBackup('token', { name: 'x'.repeat(draftBackupMaxBytes - emptySize + 1) })).toThrow('too large');
  });

  it('runs a caller validator for token terms and never accepts extra envelope metadata', () => {
    const validate = (value: unknown) => { if (!value || typeof value !== 'object' || !('name' in value)) throw new Error(); return value; };
    expect(parseDraftBackup(serializeDraftBackup('token', { name: 'Orbit' }), 'token', validate)).toEqual({ name: 'Orbit' });
    expect(() => parseDraftBackup(serializeDraftBackup('token', null), 'token', validate)).toThrow('not a supported');
    const original = JSON.parse(collectionDraftBackup(draft));
    expect(() => parseCollectionDraftBackup(JSON.stringify({ ...original, authorization: 'token' }))).toThrow('not a supported');
  });

  it('creates safe, bounded download names from arbitrary project names', () => {
    expect(draftBackupFilename('collection', '../../Night Shift<script>')).toBe('oneshot-collection-night-shift-script.json');
    expect(draftBackupFilename('token', '🌙')).toBe('oneshot-token-draft.json');
    expect(draftBackupFilename('token', 'x'.repeat(1000)).length).toBeLessThan(90);
  });
});
