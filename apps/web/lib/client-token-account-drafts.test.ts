import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOneshotAccountApi } from './client-oneshot-api';
import { emptyTokenDraft } from './token-drafts';

const id = 'c73de71c-6638-41cb-bcf2-40b4d1eb85bb';
const record = { id, ownerUserId: 'user:a', revision: 1, status: 'draft', draft: { ...emptyTokenDraft(), name: 'Orbit', symbol: 'ORBIT', openingValuation: '0.000000000000000001' }, createdAt: '2026-11-17T00:00:00.000Z', updatedAt: '2026-11-17T00:00:00.000Z' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
afterEach(() => vi.unstubAllEnvs());
function fixture(fetcher: typeof fetch) { return createOneshotAccountApi({ getAccessToken: async () => 'fresh', identityScope: () => 'user:a:session', fetcher }); }
describe('token account draft transport', () => {
  it('keeps exact terms, authenticates each request and binds updates to the reviewed version', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.oneshot.app');
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ items: [record] })).mockResolvedValueOnce(json(record)).mockResolvedValueOnce(json({ ...record, revision: 2 })).mockResolvedValueOnce(json({ id, archived: true }));
    const api = fixture(fetcher);
    expect((await api.listTokenDrafts()).items[0].draft.openingValuation).toBe('0.000000000000000001');
    expect((await api.getTokenDraft(id)).id).toBe(id);
    expect((await api.saveTokenDraft(record.draft, record)).revision).toBe(2);
    expect(JSON.parse(String(fetcher.mock.calls[2][1]?.body))).toEqual({ expectedRevision: 1, draft: record.draft });
    expect(await api.archiveTokenDraft({ id, revision: 2 })).toEqual({ id, archived: true });
    for (const [url, init] of fetcher.mock.calls) {
      expect(String(url).startsWith('https://api.oneshot.app/api/oneshot/token-drafts')).toBe(true);
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer fresh'); expect(init).toMatchObject({ credentials: 'omit', redirect: 'error' });
    }
  });
  it('rejects missing, duplicate, malformed and mismatched success records instead of an empty library or a false save', async () => {
    for (const body of [{}, { items: [record, record] }, { items: [{ ...record, draft: { fee: 99 } }] }]) await expect(fixture(async () => json(body)).listTokenDrafts()).rejects.toThrow('could not be loaded');
    await expect(fixture(async () => json({ ...record, id: 'd73de71c-6638-41cb-bcf2-40b4d1eb85bb' })).getTokenDraft(id)).rejects.toThrow('could not be opened');
    await expect(fixture(async () => json({ ...record, revision: 2, draft: { ...record.draft, fee: 5 } })).saveTokenDraft(record.draft, record)).rejects.toThrow('could not be verified');
    await expect(fixture(async () => json(record)).saveTokenDraft(record.draft, record)).rejects.toThrow('could not be verified');
  });
  it('discards an in-flight account switch and preserves customer recovery messages', async () => {
    let scope = 'a';
    const api = createOneshotAccountApi({ identityScope: () => scope, getAccessToken: async () => 'fresh', fetcher: async () => { scope = 'b'; return json({ items: [record] }); } });
    await expect(api.listTokenDrafts()).rejects.toThrow('account or wallet changed');
    await expect(fixture(async () => { throw new Error('SECRET_RPC_URL'); }).listTokenDrafts()).rejects.toThrow('Check your connection');
    await expect(fixture(async () => new Response('<bad>')).listTokenDrafts()).rejects.toThrow('response could not be loaded');
    await expect(fixture(async () => json({ error: { code: 'DATABASE_REQUIRED', message: 'SECRET_DATABASE' } }, 503)).listTokenDrafts()).rejects.toThrow('temporarily unavailable');
    await expect(fixture(async () => json({ error: { code: 'DRAFT_CHANGED', message: 'Reload account drafts before saving.' } }, 409)).saveTokenDraft(record.draft, record)).rejects.toThrow('Reload account drafts');
  });
  it('does not request a token or contact an arbitrary draft path', async () => {
    const fetcher = vi.fn<typeof fetch>(), token = vi.fn(async () => 'fresh');
    const api = createOneshotAccountApi({ identityScope: () => 'user:a', getAccessToken: token, fetcher });
    for (const target of ['../secret', `${id}?owner=b`, 'https://other.example']) await expect(api.getTokenDraft(target)).rejects.toThrow();
    expect(token).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });
});
