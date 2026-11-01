import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { adminApi } from './admin-api';
import { readiness } from './readiness';

vi.mock('./readiness', () => ({ readiness: vi.fn(async () => ({
  ready: false, checks: { originsConfigured: true, databaseAvailable: false, objectStorageConfigured: true },
  storageAvailabilityVerified: false, chainConnectionVerified: false,
})) }));

const PASSWORD = 'admin-route-test-password-with-enough-length';
let clock = Date.UTC(2030, 0, 1);
const call = (path: string, method = 'GET', options: { token?: string; body?: string; origin?: string; headers?: Record<string, string> } = {}) => adminApi(new NextRequest(`http://localhost${path}`, {
  method, ...(options.body === undefined ? {} : { body: options.body }),
  headers: { ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}), ...(options.origin ? { Origin: options.origin } : {}), ...options.headers },
}), {});
const signIn = () => call('/api/admin/session', 'POST', { body: JSON.stringify({ password: PASSWORD }) });

beforeEach(() => {
  vi.useFakeTimers(); clock += 3_600_000; vi.setSystemTime(clock);
  vi.stubEnv('ONESHOT_ADMIN_PASSWORD', PASSWORD);
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://oneshot.app');
  vi.mocked(readiness).mockClear();
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe('admin diagnostic API access boundary', () => {
  it('protects direct status/session reads and logout without disclosing diagnostic payloads', async () => {
    for (const [path, method] of [['/api/admin/network', 'GET'], ['/api/admin/status', 'GET'], ['/api/admin/readiness', 'GET'], ['/api/admin/session', 'GET'], ['/api/admin/session', 'DELETE']]) {
      const response = await call(path, method);
      expect(response.status).toBe(401); expect(response.headers.get('cache-control')).toBe('no-store');
      const body = await response.json(); expect(body.error.code).toBe('ADMIN_AUTH_REQUIRED'); expect(body.networkConfig).toBeUndefined();
    }
  });
  it('probes and returns readiness details only after validating an administrator session', async () => {
    const forged = await call('/api/admin/readiness', 'GET', { token: 'a'.repeat(43) });
    expect(forged.status).toBe(401);
    expect((await forged.json()).checks).toBeUndefined();
    expect(readiness).not.toHaveBeenCalled();
    const credentials = await (await signIn()).json();
    const response = await call('/api/admin/readiness', 'GET', { token: credentials.token });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      service: 'oneshot-api', ready: false,
      checks: { originsConfigured: true, databaseAvailable: false, objectStorageConfigured: true },
      storageAvailabilityVerified: false, chainConnectionVerified: false,
    });
    expect(readiness).toHaveBeenCalledOnce();
  });
  it('requires the configured password and returns a short-lived bearer without cookies', async () => {
    const wrong = await call('/api/admin/session', 'POST', { body: JSON.stringify({ password: 'wrong' }) });
    expect(wrong.status).toBe(401);
    const response = await signIn(); expect(response.status).toBe(201);
    expect(response.headers.get('set-cookie')).toBeNull(); expect(response.headers.get('cache-control')).toBe('no-store');
    const credentials = await response.json(); expect(credentials.expiresAt).toBe(clock + 30 * 60_000);
    expect((await call('/api/admin/session', 'GET', { token: credentials.token })).status).toBe(200);
    const status = await call('/api/admin/status', 'GET', { token: credentials.token });
    expect(status.status).toBe(200); expect((await status.json()).networkConfig).toBeDefined();
    expect((await call('/api/admin/session', 'DELETE', { token: credentials.token })).status).toBe(200);
    expect((await call('/api/admin/status', 'GET', { token: credentials.token })).status).toBe(401);
  });
  it('expires sessions and rejects them immediately when the server password changes', async () => {
    const first = await (await signIn()).json();
    vi.setSystemTime(first.expiresAt);
    expect((await call('/api/admin/status', 'GET', { token: first.token })).status).toBe(401);
    const second = await (await signIn()).json();
    vi.stubEnv('ONESHOT_ADMIN_PASSWORD', 'rotated-route-test-password-with-enough-length');
    expect((await call('/api/admin/status', 'GET', { token: second.token })).status).toBe(401);
  });
  it('leaves admin access disabled without server configuration and never echoes secrets', async () => {
    vi.stubEnv('ONESHOT_ADMIN_PASSWORD', '');
    expect((await signIn()).status).toBe(503);
    vi.stubEnv('ONESHOT_ADMIN_PASSWORD', PASSWORD);
    vi.stubEnv('PRIVY_APP_SECRET', 'private-provider-secret');
    vi.stubEnv('DATABASE_URL', 'postgresql://private-database-secret');
    const credentials = await (await signIn()).json();
    const status = await call('/api/admin/status', 'GET', { token: credentials.token });
    expect(await status.text()).not.toMatch(/private-provider-secret|private-database-secret|admin-route-test-password/);
  });
  it('uses a process-wide password budget before parsing a request body', async () => {
    for (let index = 0; index < 10; index++) expect((await call('/api/admin/session', 'POST', {
      body: '{invalid json', headers: { 'X-Forwarded-For': `192.0.2.${index}` },
    })).status).toBe(400);
    const limited = await signIn(); expect(limited.status).toBe(429); expect((await limited.json()).error.code).toBe('RATE_LIMITED');
    vi.setSystemTime(clock + 60_001); expect((await signIn()).status).toBe(201);
  });
  it('keeps operator network verification behind admin authentication and hides configured URLs on failure', async () => {
    vi.stubEnv('ONESHOT_RPC_URL', 'not-a-url-secret-api-key');
    const credentials = await (await signIn()).json();
    const response = await call('/api/admin/network', 'GET', { token: credentials.token });
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).toContain('RPC_CONFIG_INVALID'); expect(body).not.toContain('secret-api-key');
  });
  it('bounds sign-in payloads and honors the existing configured-origin bearer CORS policy', async () => {
    expect((await call('/api/admin/session', 'POST', { body: ' '.repeat(4097) })).status).toBe(413);
    const credentials = await (await signIn()).json();
    const allowed = await call('/api/admin/status', 'GET', { token: credentials.token, origin: 'https://oneshot.app' });
    expect(allowed.status).toBe(200); expect(allowed.headers.get('access-control-allow-origin')).toBe('https://oneshot.app');
    expect(allowed.headers.get('access-control-allow-credentials')).toBeNull();
    expect((await call('/api/admin/status', 'GET', { token: credentials.token, origin: 'https://other.example' })).status).toBe(403);
  });
});
