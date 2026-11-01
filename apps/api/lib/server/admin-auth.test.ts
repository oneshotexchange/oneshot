import { describe, expect, it } from 'vitest';
import { createAdminAuthenticator } from './admin-auth';

const PASSWORD = 'test-admin-password-with-enough-length';
const request = (token?: string) => new Request('https://api.oneshot.app/api/admin/status', { headers: token ? { Authorization: `Bearer ${token}` } : {} });

describe('server-side admin password sessions', () => {
  it('fails closed without a sufficiently long server password', () => {
    for (const password of [undefined, '', 'short-password', ' '.repeat(30), 'a'.repeat(1025)]) {
      const auth = createAdminAuthenticator({ environment: () => ({ ONESHOT_ADMIN_PASSWORD: password }) });
      expect(() => auth.signIn(PASSWORD)).toThrowError(expect.objectContaining({ status: 503, code: 'ADMIN_UNAVAILABLE' }));
      expect(() => auth.requireSession(request('a'.repeat(43)))).toThrowError(expect.objectContaining({ status: 503 }));
    }
  });
  it('issues random opaque sessions that expire after exactly 30 minutes', () => {
    let now = 1_000_000;
    const auth = createAdminAuthenticator({ environment: () => ({ ONESHOT_ADMIN_PASSWORD: PASSWORD }), now: () => now });
    expect(() => auth.signIn('wrong')).toThrowError(expect.objectContaining({ status: 401 }));
    const first = auth.signIn(PASSWORD), second = auth.signIn(PASSWORD);
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/); expect(second.token).not.toBe(first.token);
    expect(first.expiresAt).toBe(now + 30 * 60_000);
    expect(JSON.stringify(first)).not.toContain(PASSWORD);
    expect(auth.requireSession(request(first.token))).toEqual({ expiresAt: first.expiresAt });
    expect(() => auth.requireSession(request(PASSWORD))).toThrowError(expect.objectContaining({ status: 401 }));
    now = first.expiresAt - 1; expect(auth.requireSession(request(first.token))).toBeTruthy();
    now += 1; expect(() => auth.requireSession(request(first.token))).toThrowError(expect.objectContaining({ status: 401 }));
  });
  it('revokes sessions immediately after logout, password rotation or disabling admin access', () => {
    const env = { ONESHOT_ADMIN_PASSWORD: PASSWORD };
    const auth = createAdminAuthenticator({ environment: () => env });
    const first = auth.signIn(PASSWORD), second = auth.signIn(PASSWORD);
    auth.revoke(request(first.token));
    expect(() => auth.requireSession(request(first.token))).toThrowError(expect.objectContaining({ status: 401 }));
    expect(auth.requireSession(request(second.token))).toBeTruthy();
    env.ONESHOT_ADMIN_PASSWORD = 'rotated-admin-password-with-enough-length';
    expect(() => auth.requireSession(request(second.token))).toThrowError(expect.objectContaining({ status: 401 }));
    const rotated = auth.signIn(env.ONESHOT_ADMIN_PASSWORD);
    env.ONESHOT_ADMIN_PASSWORD = '';
    expect(() => auth.requireSession(request(rotated.token))).toThrowError(expect.objectContaining({ status: 503 }));
    env.ONESHOT_ADMIN_PASSWORD = 'rotated-admin-password-with-enough-length';
    expect(() => auth.requireSession(request(rotated.token))).toThrowError(expect.objectContaining({ status: 401 }));
  });
  it('bounds the in-memory session store and rejects malformed or unknown bearer credentials', () => {
    const auth = createAdminAuthenticator({ environment: () => ({ ONESHOT_ADMIN_PASSWORD: PASSWORD }) });
    const oldest = auth.signIn(PASSWORD);
    let latest = oldest;
    for (let index = 0; index < 128; index++) latest = auth.signIn(PASSWORD);
    expect(() => auth.requireSession(request(oldest.token))).toThrowError(expect.objectContaining({ status: 401 }));
    expect(auth.requireSession(request(latest.token))).toBeTruthy();
    for (const token of [undefined, 'bad', 'a'.repeat(43), `${latest.token} extra`])
      expect(() => auth.requireSession(request(token))).toThrowError(expect.objectContaining({ status: 401 }));
  });
});
