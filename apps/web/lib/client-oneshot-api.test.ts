import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountCollectionInput, accountCollectionLocalDraft, collectionAccountInput, createOneshotAccountApi, normalizeLocalCollectionDraft, type LocalCollectionDraft } from './client-oneshot-api';
import { oneshotDraftSchema, type OneshotDraft } from './oneshot-draft-schema';

const address = `0x${'ab'.repeat(20)}`;
const draft: LocalCollectionDraft = { id: 'local-one', name: 'Originals', symbol: 'SHOT', description: 'Our collection', supply: '2', royalty: '5.5', price: '0.000000000000000001', limit: '2', metadataMode: 'url', metadataUrl: 'https://example.com/manifest.json', fileNames: [], publicStart: '2026-11-01T12:00:00Z', publicEnd: '2026-11-03T12:10:42Z', allowlist: false, allowlistStart: '', allowlistEnd: '', allowlistPrice: '0', addresses: '', savedAt: '2026-10-22T12:00:00Z' };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('oneshot authenticated account client', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('sends a fresh bearer only to the configured separate API, without cookies or redirects', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.oneshot.app');
    const fetcher = vi.fn<typeof fetch>(async () => response({ items: [] }));
    const api = createOneshotAccountApi({ identityScope: () => 'user:a', getAccessToken: async () => 'fresh-token', fetcher });
    await api.listDrafts();
    expect(fetcher.mock.calls[0][0]).toBe('https://api.oneshot.app/api/oneshot/drafts');
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('Authorization')).toBe('Bearer fresh-token');
    expect(fetcher.mock.calls[0][1]).toMatchObject({ credentials: 'omit', redirect: 'error' });
  });
  it('loads one explicit UUID account draft through authenticated GET and rejects malformed targets before fetching', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.oneshot.app');
    const id = 'c73de71c-6638-41cb-bcf2-40b4d1eb85bb';
    const fetcher = vi.fn<typeof fetch>(async () => response({ id, ownerUserId: 'owner', status: 'prepared' }));
    const api = createOneshotAccountApi({ identityScope: () => 'owner:wallet', getAccessToken: async () => 'fresh-token', fetcher });
    expect(await api.getDraft(id)).toMatchObject({ id, ownerUserId: 'owner', status: 'prepared' });
    expect(fetcher.mock.calls[0][0]).toBe(`https://api.oneshot.app/api/oneshot/drafts/${id}`);
    expect(new Request(String(fetcher.mock.calls[0][0]), fetcher.mock.calls[0][1]).method).toBe('GET');
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('Authorization')).toBe('Bearer fresh-token');
    for (const invalid of ['../secret', 'https://other.example', `${id}?owner=another`]) expect(() => api.getDraft(invalid)).toThrow('valid saved account draft');
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('restores account fields without inventing local file data or persisting server ownership fields', () => {
    const record: OneshotDraft = { ...collectionAccountInput(draft), id: 'remote-one', ownerUserId: 'did:privy:owner', revision: 4, status: 'draft', createdAt: draft.savedAt, updatedAt: draft.savedAt };
    const local = accountCollectionLocalDraft(record);
    expect(local.price).toBe(draft.price); expect(local.symbol).toBe('SHOT'); expect(local.fileNames).toEqual([]); expect(local.id).toBe('account:remote-one');
    expect(new Date(local.publicStart).toISOString()).toBe(record.publicStart);
    expect(new Date(local.publicEnd!).toISOString()).toBe(record.publicEnd);
    expect(accountCollectionInput(record)).toEqual(collectionAccountInput(draft));
    expect(accountCollectionInput(record)).not.toHaveProperty('ownerUserId');
  });
  it('preserves decimal price text and maps schedules and royalty without native base-unit conversion', () => {
    const value = collectionAccountInput(draft, address);
    expect(value.publicPrice).toBe(draft.price); expect(value.royaltyBps).toBe(550);
    expect(value.symbol).toBe('SHOT');
    expect(value.publicStart).toBe('2026-11-01T12:00:00.000Z'); expect(value.publicEnd).toBe('2026-11-03T12:10:42.000Z');
    expect(value.creatorWallet).toBe(address); expect(value.metadataUrl).toBe(draft.metadataUrl);
    expect(value).not.toHaveProperty('imageUrl'); expect(value).not.toHaveProperty('manifest');
  });
  it('round-trips every explicit phase boundary, including seconds and fractional precision', () => {
    const input = collectionAccountInput({ ...draft, publicStart: '2026-11-01T12:00:17.123456Z', publicEnd: '2026-11-03T12:10:42.999999Z', allowlist: true, allowlistStart: '2026-10-31T06:15:07.012345Z', allowlistEnd: '2026-11-01T11:55:29.654321Z', allowlistPrice: '0.01', addresses: `${address}\n${address.toUpperCase().replace('0X', '0x')}` });
    const record: OneshotDraft = { ...input, id: 'schedule', ownerUserId: 'owner', revision: 1, status: 'prepared', createdAt: draft.savedAt, updatedAt: draft.savedAt };
    const resumed = accountCollectionLocalDraft(record);
    const saved = collectionAccountInput(resumed);
    for (const field of ['publicStart', 'publicEnd', 'allowlistStart', 'allowlistEnd'] as const) expect(saved[field]).toBe(input[field]);
    expect(saved.allowlistAddresses).toEqual([address]);
    expect(saved.allowlistPrice).toBe('0.01');
  });
  it('keeps old account revisions readable and savable without inventing a symbol', () => {
    const { symbol, ...legacyInput } = collectionAccountInput(draft);
    const record: OneshotDraft = { ...legacyInput, id: 'legacy', ownerUserId: 'owner', revision: 1, status: 'prepared', createdAt: draft.savedAt, updatedAt: draft.savedAt };
    expect(oneshotDraftSchema.parse(legacyInput)).not.toHaveProperty('symbol');
    expect(accountCollectionInput(record)).toEqual(legacyInput);
    expect(accountCollectionLocalDraft(record).symbol).toBe('');
    expect(accountCollectionLocalDraft(record).publicEnd).not.toBe('');
    expect(collectionAccountInput({ ...draft, symbol: undefined })).not.toHaveProperty('symbol');
    expect(symbol).toBe('SHOT');
  });
  it('normalizes missing browser fields to blank and requires explicit ends before saving', () => {
    const { symbol, publicEnd, allowlistEnd, ...legacy } = draft;
    const resumed = normalizeLocalCollectionDraft(JSON.parse(JSON.stringify(legacy)));
    expect(resumed).toMatchObject({ symbol: '', publicEnd: '', allowlistEnd: '', publicStart: draft.publicStart });
    expect(() => collectionAccountInput(resumed)).toThrow('public mint end');
    expect(() => collectionAccountInput({ ...draft, allowlist: true, allowlistStart: '2026-11-01T11:00:00Z', allowlistEnd: undefined, addresses: address })).toThrow('allowlist end');
    expect({ symbol, publicEnd, allowlistEnd }).toMatchObject({ symbol: 'SHOT', publicEnd: draft.publicEnd, allowlistEnd: '' });
  });
  it('validates symbol UTF-8 bytes and rejects empty supplied symbols', () => {
    expect(collectionAccountInput({ ...draft, symbol: '  SHOT  ' }).symbol).toBe('SHOT');
    expect(collectionAccountInput({ ...draft, symbol: '💚'.repeat(5) }).symbol).toBe('💚'.repeat(5));
    for (const symbol of ['', ' ', 'A'.repeat(21), '💚'.repeat(6)]) expect(() => collectionAccountInput({ ...draft, symbol })).toThrow(/symbol/);
  });
  it('rejects malformed dates, impossible calendar dates and invalid phase ordering before saving', () => {
    for (const publicEnd of ['', 'not-a-date', '2026-02-30T12:00:00', '2026-11-03T25:10:00', '2026-11-03T12:99:00']) expect(() => collectionAccountInput({ ...draft, publicEnd })).toThrow('public mint end');
    expect(() => collectionAccountInput({ ...draft, publicEnd: draft.publicStart })).toThrow('end must follow');
    const allowlist = { ...draft, allowlist: true, addresses: address, allowlistStart: '2026-11-01T10:00:01Z', allowlistEnd: '2026-11-01T11:00:02Z' };
    expect(collectionAccountInput(allowlist).allowlistEnd).toBe('2026-11-01T11:00:02.000Z');
    expect(() => collectionAccountInput({ ...allowlist, allowlistEnd: allowlist.allowlistStart })).toThrow('Schedule the allowlist');
    expect(() => collectionAccountInput({ ...allowlist, allowlistEnd: '2026-11-01T12:00:01Z' })).toThrow('Schedule the allowlist');
    expect(() => collectionAccountInput({ ...allowlist, addresses: `0x${'0'.repeat(40)}` })).toThrow('nonzero EVM address');
  });
  it('only adds uploaded art for an explicit upload result and maps each uploaded image', () => {
    const input = { ...draft, metadataMode: 'upload' as const, fileNames: ['one.png', 'two.png'] };
    expect(collectionAccountInput(input)).not.toHaveProperty('imageUrl');
    expect(collectionAccountInput(input)).not.toHaveProperty('manifest');
    const first = { url: 'https://media.example.com/one', hash: 'one', size: 100 };
    expect(collectionAccountInput(input, undefined, [first]).imageUrl).toBe(first.url);
    const local = { ...first, url: 'http://127.0.0.1:3000/api/media/unsafe-for-immutable-metadata', reference: `/api/media/${'ab'.repeat(32)}.webp` };
    expect(collectionAccountInput(input, undefined, [local]).imageUrl).toBe(local.reference);
    expect(collectionAccountInput(input, undefined, [first, { ...first, url: 'https://media.example.com/two' }]).manifest?.items.map(item => item.image)).toEqual(['https://media.example.com/one', 'https://media.example.com/two']);
    const unicode = collectionAccountInput({ ...input, name: '💚'.repeat(25) }, undefined, [first, first]);
    expect(unicode.manifest?.items.every(item => new TextEncoder().encode(item.name).length <= 100)).toBe(true);
    expect(unicode.manifest?.items[0].name).not.toBe(unicode.manifest?.items[1].name);
  });
  it('requires a current Privy session, refreshes the token for each write and sends optimistic revision', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response({ id: 'remote-one', revision: 2 }));
    const getAccessToken = vi.fn().mockResolvedValueOnce('fresh-one').mockResolvedValueOnce('fresh-two');
    const api = createOneshotAccountApi({ identityScope: () => 'user:a', getAccessToken, fetcher });
    await api.saveDraft(collectionAccountInput(draft)); await api.saveDraft(collectionAccountInput(draft), { id: 'remote-one', revision: 1 });
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('Authorization')).toBe('Bearer fresh-one');
    expect(new Headers(fetcher.mock.calls[1][1]?.headers).get('Authorization')).toBe('Bearer fresh-two');
    expect(JSON.parse(fetcher.mock.calls[1][1]!.body as string).expectedRevision).toBe(1);
    const unauthenticated = createOneshotAccountApi({ identityScope: () => null, getAccessToken, fetcher });
    await expect(unauthenticated.listDrafts()).rejects.toThrow('Sign in'); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('lets the browser set the multipart boundary and preserves actionable server errors', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response({ error: { message: 'Revision changed. Reload this draft.' } }, 409));
    const api = createOneshotAccountApi({ identityScope: () => 'user:a', getAccessToken: async () => 'token', fetcher });
    await expect(api.uploadArt(new File(['art'], 'one.png', { type: 'image/png' }))).rejects.toThrow('Revision changed. Reload this draft.');
    expect(fetcher.mock.calls[0][1]?.body).toBeInstanceOf(FormData);
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).has('Content-Type')).toBe(false);
    expect(fetcher.mock.calls[0][1]?.redirect).toBe('error');
  });
  it('archives only the selected revision and rejects an archive response after identity changes', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response({ id: 'saved-one', archived: true }));
    const api = createOneshotAccountApi({ identityScope: () => 'current-user', getAccessToken: async () => 'fresh-token', fetcher });
    await expect(api.archiveDraft({ id: 'saved-one', revision: 7 })).resolves.toEqual({ id: 'saved-one', archived: true });
    expect(fetcher.mock.calls[0][0]).toBe('/api/oneshot/drafts/saved-one');
    expect(fetcher.mock.calls[0][1]?.method).toBe('DELETE');
    expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toEqual({ expectedRevision: 7 });
    let scope = 'current-user'; let finish!: (value: Response) => void;
    const pendingFetcher = vi.fn<typeof fetch>(() => new Promise(resolve => { finish = resolve; }));
    const pendingApi = createOneshotAccountApi({ identityScope: () => scope, getAccessToken: async () => 'fresh-token', fetcher: pendingFetcher });
    const pending = pendingApi.archiveDraft({ id: 'saved-one', revision: 7 });
    await vi.waitFor(() => expect(pendingFetcher).toHaveBeenCalledOnce());
    scope = 'different-user'; finish(response({ id: 'saved-one', archived: true }));
    await expect(pending).rejects.toThrow('account or wallet changed');
  });
  it('does not return a prior account response after the selected identity changes', async () => {
    let scope = 'user:a'; let done!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>(() => new Promise(resolve => { done = resolve; }));
    const api = createOneshotAccountApi({ identityScope: () => scope, getAccessToken: async () => 'token', fetcher });
    const pending = api.listDrafts(); await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    scope = 'user:b'; done(response({ items: [{ name: 'Private previous account draft' }] }));
    await expect(pending).rejects.toThrow('account or wallet changed');
  });
});
