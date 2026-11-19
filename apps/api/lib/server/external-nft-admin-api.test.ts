import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createAdminAuthenticator } from './admin-auth';
import { createExternalNftAdminApi } from './external-nft-admin-api';
import { api } from './http';
import type { reviewedNftImports, externalNftAdmission } from './external-nft-admission';

const id = '3ba3ca1e-0038-4b0f-8a66-09b51c58c172';
let time = Date.UTC(2026, 10, 20);
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(time += 3600_000); });
afterEach(() => { vi.useRealTimers(); });
function fixture() {
  const auth = createAdminAuthenticator({ environment: () => ({ ONESHOT_ADMIN_PASSWORD: 'test-admin-password-at-least-16-characters' }) });
  const token = auth.signIn('test-admin-password-at-least-16-characters').token;
  const imports = { adminList: vi.fn(async () => ({ items: [], nextCursor: null })), adminRead: vi.fn(async () => ({ request: { id } })), review: vi.fn(async () => ({ request: { id, status: 'review-approved' } })) };
  const admission = { prepare: vi.fn(async () => ({ bundle: { requestId: id }, admissionStatus: 'not-established' })), validate: vi.fn(async () => ({ admissionStatus: 'not-established' })) };
  const handler = api(createExternalNftAdminApi({ imports: imports as unknown as typeof reviewedNftImports, admission: admission as unknown as typeof externalNftAdmission, authenticate: auth.requireSession }));
  const call = (suffix = '', method = 'GET', body?: unknown, credentials: string | null = token) => handler(new NextRequest(`http://localhost/api/admin/external-nfts/imports${suffix}`, {
    method, headers: credentials ? { Authorization: `Bearer ${credentials}` } : {}, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), {});
  return { call, token, auth, imports, admission };
}
describe('external collection review server access boundary', () => {
  it('requires a current server admin session before every queue/detail/review/permit operation', async () => {
    const f = fixture();
    for (const [suffix, method] of [['', 'GET'], [`/${id}`, 'GET'], [`/${id}/review`, 'POST'], [`/${id}/permit`, 'POST'], [`/${id}/validate-permit`, 'POST']]) {
      expect((await f.call(suffix, method, method === 'POST' ? {} : undefined, null)).status).toBe(401);
    }
    expect(f.imports.adminList).not.toHaveBeenCalled(); expect(f.imports.adminRead).not.toHaveBeenCalled(); expect(f.imports.review).not.toHaveBeenCalled(); expect(f.admission.prepare).not.toHaveBeenCalled(); expect(f.admission.validate).not.toHaveBeenCalled();
    expect((await f.call('', 'GET', undefined, 'a'.repeat(43))).status).toBe(401);
    vi.setSystemTime(Date.now() + 30 * 60_000); expect((await f.call()).status).toBe(401);
  });
  it('paginates only the administrator queue and rejects account/extra/duplicate query filters', async () => {
    const f = fixture(), result = await f.call('?limit=10&cursor=bounded_cursor');
    expect(result.status).toBe(200); expect(result.headers.get('cache-control')).toBe('no-store');
    expect(f.imports.adminList).toHaveBeenCalledWith({ limit: 10, cursor: 'bounded_cursor' });
    for (const suffix of ['?ownerUserId=someone', '?limit=1&limit=2', '?limit=0', `/${id}?wallet=someone`]) expect((await f.call(suffix)).status).toBeGreaterThanOrEqual(400);
  });
  it('binds review decisions to an expected revision, records a server actor and requires approval evidence', async () => {
    const f = fixture();
    expect((await f.call(`/${id}/review`, 'POST', { expectedRevision: 2, decision: 'review-approved' })).status).toBe(400);
    expect((await f.call(`/${id}/review`, 'POST', { expectedRevision: 2, decision: 'review-approved', operatorEvidence: 'Reviewed code and rights references.', customerNote: 'Review approved.' })).status).toBe(200);
    expect(f.imports.review).toHaveBeenCalledWith(id, 2, { decision: 'review-approved', operatorEvidence: 'Reviewed code and rights references.', customerNote: 'Review approved.' }, expect.stringMatching(/^admin:[a-f0-9]{16}$/));
    expect((await f.call(`/${id}/review`, 'POST', { expectedRevision: 2, decision: 'rejected', actor: 'forged' })).status).toBe(400);
    expect((await f.call(`/${id}/review`, 'POST', { expectedRevision: 2, decision: 'rejected', customerNote: 'Unsupported collection.' })).status).toBe(200);
  });
  it('only prepares or validates unsigned calls and rejects unknown actions, oversized payloads and non-exact permit input', async () => {
    const f = fixture();
    expect((await f.call(`/${id}/permit`, 'POST', { expectedRevision: 2 })).status).toBe(200); expect(f.admission.prepare).toHaveBeenCalledWith(id, 2);
    expect((await f.call(`/${id}/permit`, 'POST', { expectedRevision: 2, broadcast: true })).status).toBe(400);
    const raw = { expectedRevision: 2, bundle: {}, signature: '0xab', submitter: '0x' + '1'.repeat(40) };
    expect((await f.call(`/${id}/validate-permit`, 'POST', raw)).status).toBe(200); expect(f.admission.validate).toHaveBeenCalledWith(id, raw);
    expect((await f.call(`/${id}/validate-permit`, 'POST', { value: 'x'.repeat(25000) })).status).toBe(413);
    expect((await f.call(`/${id}/broadcast`, 'POST', {})).status).toBe(404);
    expect((await f.call(`/${id}`, 'DELETE', {})).status).toBe(405);
  });
});
