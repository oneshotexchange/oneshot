import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

it('returns current typed authentication errors and revokes sessions when server error modules reload', async () => {
  vi.stubEnv('ONESHOT_ADMIN_PASSWORD', 'temporary-test-admin-password');
  const first = await import('./admin-auth');
  const { token } = first.adminAuthenticator.signIn('temporary-test-admin-password');
  const request = new Request('https://api.oneshot.example.com/api/admin/genesis', { headers: { Authorization: `Bearer ${token}` } });
  expect(first.adminAuthenticator.requireSession(request)).toHaveProperty('expiresAt');
  vi.resetModules();
  const reloaded = await import('./admin-auth');
  const { ApiError } = await import('./errors');
  expect(() => reloaded.adminAuthenticator.requireSession(new Request(request.url))).toThrowError(ApiError);
  let failure: unknown;
  try { reloaded.adminAuthenticator.requireSession(request); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(ApiError);
  expect(failure).toMatchObject({ status: 401, code: 'ADMIN_AUTH_REQUIRED' });
  const next = reloaded.adminAuthenticator.signIn('temporary-test-admin-password');
  expect(reloaded.adminAuthenticator.requireSession(new Request(request.url, { headers: { Authorization: `Bearer ${next.token}` } }))).toHaveProperty('expiresAt');
});
