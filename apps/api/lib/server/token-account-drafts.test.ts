import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { emptyTokenDraft } from '../../../web/lib/token-drafts';
import { createTokenAccountDraft, getTokenAccountDraft, listTokenAccountDrafts, updateTokenAccountDraft, archiveTokenAccountDraft } from './token-account-drafts';
import { putRecord } from './store';
import { oneshotApi } from './oneshot-api';
import { requireOneshotSession, type OneshotSession } from './oneshot-auth';
import { ApiError } from './errors';

vi.mock('./oneshot-auth', async original => ({ ...await original<typeof import('./oneshot-auth')>(), requireOneshotSession: vi.fn() }));
const alice: OneshotSession = { provider: 'privy', userId: 'did:privy:token-alice', sessionId: 'a', expiresAt: 9999999999, linkedAddresses: [] };
const bob = { ...alice, userId: 'did:privy:token-bob' };
const base = path.resolve('.local/token-account-draft-tests');
let directory = '';
beforeEach(async () => {
  await mkdir(base, { recursive: true }); directory = await mkdtemp(path.join(base, 'case-'));
  vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('DATABASE_URL', ''); vi.stubEnv('ONESHOT_DATA_DIR', directory);
  vi.mocked(requireOneshotSession).mockResolvedValue(alice);
});
afterEach(async () => {
  vi.unstubAllEnvs(); vi.clearAllMocks();
  const target = path.resolve(directory); if (!target.startsWith(base + path.sep)) throw new Error('Unsafe test cleanup');
  await rm(target, { recursive: true, force: true });
});
const draft = () => ({ ...emptyTokenDraft(), name: 'Orbit', symbol: 'ORBIT', website: 'https://unfinished.', openingValuation: '12.' });
const endpoint = 'http://localhost/api/oneshot/token-drafts';
describe('private token account drafts', () => {
  it('saves incomplete exact terms without a wallet, hides other owners and rejects forged authority', async () => {
    const record = await createTokenAccountDraft(draft(), alice);
    expect(record.draft).toEqual(draft()); expect(record.revision).toBe(1);
    expect(await listTokenAccountDrafts(bob)).toEqual([]);
    await expect(getTokenAccountDraft(record.id, bob)).rejects.toMatchObject({ status: 404 });
    await expect(updateTokenAccountDraft(record.id, draft(), 1, bob)).rejects.toMatchObject({ status: 404 });
    await expect(archiveTokenAccountDraft(record.id, 1, bob)).rejects.toMatchObject({ status: 404 });
    await expect(createTokenAccountDraft({ ...draft(), ownerUserId: bob.userId }, alice)).rejects.toThrow();
  });
  it('allows only one simultaneous edit and requires a new copy to change the valuation currency', async () => {
    const record = await createTokenAccountDraft(draft(), alice);
    const results = await Promise.allSettled(['A', 'B'].map(name => updateTokenAccountDraft(record.id, { ...draft(), name }, 1, alice)));
    expect(results.filter(value => value.status === 'fulfilled')).toHaveLength(1);
    expect((await getTokenAccountDraft(record.id, alice)).revision).toBe(2);
    await expect(updateTokenAccountDraft(record.id, { ...draft(), pricingNetwork: 'zero' }, 2, alice)).rejects.toMatchObject({ code: 'DRAFT_PRICING_NETWORK_MISMATCH' });
    const legacy = await createTokenAccountDraft({ ...draft(), pricingNetwork: undefined }, alice);
    expect((await updateTokenAccountDraft(legacy.id, { ...draft(), pricingNetwork: 'zero' }, 1, alice)).draft.openingValuation).toBe('12.');
    await expect(updateTokenAccountDraft(legacy.id, draft(), 2, alice)).rejects.toMatchObject({ code: 'DRAFT_PRICING_NETWORK_MISMATCH' });
  });
  it('enforces the active account limit atomically and frees only archived slots', async () => {
    const results = await Promise.allSettled(Array.from({ length: 22 }, () => createTokenAccountDraft(draft(), alice)));
    expect(results.filter(value => value.status === 'fulfilled')).toHaveLength(20);
    const records = await listTokenAccountDrafts(alice); expect(records).toHaveLength(20);
    await expect(archiveTokenAccountDraft(records[0].id, 999, alice)).rejects.toMatchObject({ code: 'DRAFT_CHANGED' });
    await archiveTokenAccountDraft(records[0].id, 1, alice);
    await expect(getTokenAccountDraft(records[0].id, alice)).rejects.toMatchObject({ status: 404 });
    await createTokenAccountDraft(draft(), alice); expect(await listTokenAccountDrafts(alice)).toHaveLength(20);
  });
  it('fails unreadable stored records closed and requires database storage in production', async () => {
    const record = await createTokenAccountDraft(draft(), alice);
    await putRecord('oneshot_token_drafts', record.id, { ...record, draft: { ...record.draft, fee: 999 } });
    await expect(listTokenAccountDrafts(alice)).rejects.toMatchObject({ status: 503 });
    await expect(getTokenAccountDraft(record.id, alice)).rejects.toMatchObject({ status: 503 });
    vi.stubEnv('NODE_ENV', 'production');
    await expect(createTokenAccountDraft(draft(), alice)).rejects.toMatchObject({ code: 'DATABASE_REQUIRED' });
  });
  it('authenticates every route before body parsing and returns no-store data without wallet checks', async () => {
    vi.mocked(requireOneshotSession).mockRejectedValue(new ApiError(401, 'AUTH_REQUIRED', 'Sign in.'));
    for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
      const url = method === 'PUT' || method === 'DELETE' ? endpoint + '/bad' : endpoint;
      expect((await oneshotApi(new NextRequest(url, { method, ...(method === 'GET' ? {} : { body: 'bad' }) }), {})).status).toBe(401);
    }
    vi.mocked(requireOneshotSession).mockResolvedValue(alice);
    const response = await oneshotApi(new NextRequest(endpoint, { method: 'POST', body: JSON.stringify(draft()) }), {});
    expect(response.status).toBe(201); expect(response.headers.get('cache-control')).toBe('no-store');
    const saved = await response.json();
    const edited = await oneshotApi(new NextRequest(`${endpoint}/${saved.id}`, { method: 'PUT', body: JSON.stringify({ expectedRevision: 1, draft: { ...draft(), name: 'Updated' } }) }), {});
    expect(edited.status).toBe(200); expect((await edited.json()).revision).toBe(2);
    const oversized = await oneshotApi(new NextRequest(endpoint, { method: 'POST', body: ' '.repeat(16385) }), {}); expect(oversized.status).toBe(413);
  });
});
