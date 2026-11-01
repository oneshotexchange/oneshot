import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { api, json } from './http';
import { ApiError } from './errors';
import { proxy } from '../../proxy';

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://oneshot.app');
  vi.stubEnv('ONESHOT_API_URL', 'https://api.oneshot.app');
});
afterEach(() => vi.unstubAllEnvs());
const request = (path = '/api/oneshot/session', init?: ConstructorParameters<typeof NextRequest>[1]) => new NextRequest(`https://api.oneshot.app${path}`, init);

describe('browser requests between the Cloudflare web and separate API', () => {
  it('supports bearer preflight only from the exact web origin', async () => {
    const handler = vi.fn();
    const response = await api(handler)(request('/api/oneshot/drafts', {
      method: 'OPTIONS', headers: { Origin: 'https://oneshot.app', 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'authorization, content-type' },
    }), {});
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://oneshot.app');
    expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Authorization, Content-Type');
    expect(response.headers.has('Access-Control-Allow-Credentials')).toBe(false);
    expect(response.headers.get('Vary')).toContain('Access-Control-Request-Headers');
    expect(handler).not.toHaveBeenCalled();
  });
  it('preserves readable CORS headers on authentication and validation errors', async () => {
    const response = await api(async () => { throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in.'); })(request(undefined, { headers: { Origin: 'https://oneshot.app' } }), {});
    expect(response.status).toBe(401);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://oneshot.app');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: { code: 'AUTH_REQUIRED', message: 'Sign in.' } });
  });
  it('rejects foreign and null origins before running handlers', async () => {
    const handler = vi.fn(async () => json({ ok: true }));
    for (const origin of ['https://foreign.app', 'https://oneshot.app.foreign.app', 'null']) {
      const response = await api(handler)(request(undefined, { headers: { Origin: origin } }), {});
      expect(response.status).toBe(403);
      expect(response.headers.has('Access-Control-Allow-Origin')).toBe(false);
    }
    expect(handler).not.toHaveBeenCalled();
  });
  it('rejects unsupported preflight methods and headers while allowing server-to-server calls', async () => {
    const unsupported: Record<string, string>[] = [{ 'Access-Control-Request-Method': 'TRACE' }, { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-arbitrary-secret' }];
    for (const extra of unsupported) {
      const response = await api(async () => json({ ok: true }))(request(undefined, { method: 'OPTIONS', headers: { Origin: 'https://oneshot.app', ...extra } }), {});
      expect(response.status).toBe(403);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://oneshot.app');
    }
    const response = await api(async () => json({ ok: true }))(request(), {});
    expect(response.status).toBe(200);
    expect(response.headers.has('Access-Control-Allow-Origin')).toBe(false);
  });
  it('adds the same CORS policy before framework-generated responses', () => {
    const response = proxy(request('/api/not-a-route', { headers: { Origin: 'https://oneshot.app' } }));
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://oneshot.app');
    expect(response.headers.get('x-middleware-next')).toBe('1');
    const blocked = proxy(request('/api/not-a-route', { headers: { Origin: 'https://foreign.app' } }));
    expect(blocked.status).toBe(403);
  });
});
