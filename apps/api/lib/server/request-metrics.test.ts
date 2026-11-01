import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { api, json } from './http';
import { ApiError } from './errors';
import { beginRequestMetric, requestMetricRoute } from './request-metrics';

const collection = `0x${'ab'.repeat(20)}`;
const userWallet = `0x${'cd'.repeat(20)}`;
const id = '7b44c6bf-4224-4b7a-871f-afc75f47a333';
const manifest = 'ef'.repeat(32);
const request = (path: string, init?: ConstructorParameters<typeof NextRequest>[1]) => new NextRequest(`https://api.oneshot.app${path}`, init);

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://oneshot.app');
  vi.stubEnv('ONESHOT_API_URL', 'https://api.oneshot.app');
  vi.stubEnv('ONESHOT_REQUEST_METRICS', 'false');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('finite request metric labels', () => {
  it.each([
    ['/api/health', '/api/health'],
    ['/api/ready/', '/api/ready'],
    ['/api/oneshot/session', '/api/oneshot/session'],
    ['/api/oneshot/network', '/api/oneshot/network'],
    ['/api/oneshot/media', '/api/oneshot/media'],
    ['/api/oneshot/drafts', '/api/oneshot/drafts'],
    [`/api/oneshot/drafts/${id}`, '/api/oneshot/drafts/:draftId'],
    [`/api/oneshot/drafts/${id}/prepare`, '/api/oneshot/drafts/:draftId/prepare'],
    [`/api/oneshot/metadata/${manifest}/1`, '/api/oneshot/metadata/:manifest/:item'],
    ['/api/oneshot/launch/status', '/api/oneshot/launch/status'],
    [`/api/oneshot/launch/collections/${collection}`, '/api/oneshot/launch/collections/:collection'],
    [`/api/oneshot/launch/floor/${collection}`, '/api/oneshot/launch/floor/:collection'],
    [`/api/oneshot/launch/reviews/${id}`, '/api/oneshot/launch/reviews/:reviewId'],
    ['/api/oneshot/launch/transactions', '/api/oneshot/launch/transactions'],
    ['/api/oneshot/launch/review', '/api/oneshot/launch/review'],
    ['/api/oneshot/launch/submitted', '/api/oneshot/launch/submitted'],
    ['/api/oneshot/launch/validate', '/api/oneshot/launch/validate'],
    ['/api/oneshot/launch/receipt', '/api/oneshot/launch/receipt'],
    ['/api/oneshot/indexed/status', '/api/oneshot/indexed/status'],
    ['/api/oneshot/indexed/collections', '/api/oneshot/indexed/collections'],
    [`/api/oneshot/indexed/collections/${collection}`, '/api/oneshot/indexed/collections/:collection'],
    [`/api/oneshot/indexed/collections/${collection}/items`, '/api/oneshot/indexed/collections/:collection/items'],
    [`/api/oneshot/indexed/collections/${collection}/items/19`, '/api/oneshot/indexed/collections/:collection/items/:tokenId'],
    ['/api/oneshot/indexed/listings', '/api/oneshot/indexed/listings'],
    ['/api/oneshot/indexed/activity', '/api/oneshot/indexed/activity'],
    [`/api/oneshot/indexed/wallets/${userWallet}/items`, '/api/oneshot/indexed/wallets/:wallet/items'],
    [`/api/oneshot/indexed/wallets/${userWallet}/claims`, '/api/oneshot/indexed/wallets/:wallet/claims'],
  ])('normalizes the known route %s', (path, expected) => {
    expect(requestMetricRoute(path)).toBe(expected);
  });

  it('collapses unknown, legacy, oversized and malformed paths without echoing them', () => {
    const paths = [undefined, null, 42, {}, '', 'https://user:password@private.invalid/api/health',
      '/api/status', '/api/private-user-id', '/api/oneshot/drafts/private-user-id',
      `/api/oneshot/launch/floor/0x${'ab'.repeat(5000)}`,
      `/api/oneshot/indexed/wallets/${userWallet}/items/private-secret`,
      '/api/health?token=private-token', '/api/health#private-secret', '/api/health\n',
      '/api/oneshot/drafts/%', '/api/oneshot/drafts/%GG', '/api/oneshot/drafts/%2fprivate-secret', '/api\\health'];
    for (const path of paths) expect(requestMetricRoute(path)).toBe('unmatched');
  });

  it('never retains query, identity, request body or response fields in the event', () => {
    const incoming = request(`/api/oneshot/launch/floor/${collection}?wallet=${userWallet}&floorRaw=4000000000000000000&privateMode=true`, {
      method: 'POST', headers: { Authorization: 'Bearer private-auth-token', 'X-Private-User': 'did:privy:private-user' },
      body: JSON.stringify({ floorPrice: '4', floorEnabled: true, signature: 'private-signature' }),
    });
    const sink = vi.fn();
    beginRequestMetric(incoming, { enabled: true, clock: () => 10, sink })(200);
    expect(sink).toHaveBeenCalledExactlyOnceWith({ event: 'oneshot_request', route: '/api/oneshot/launch/floor/:collection', method: 'POST', status: 200, durationMs: 0 });
    expect(JSON.stringify(sink.mock.calls)).not.toMatch(/ab{2}|cd{2}|private-|floorRaw|floorPrice|floorEnabled|signature|authorization|wallet=/i);
  });

  it('normalizes arbitrary methods and invalid status values to fixed safe labels', () => {
    const sink = vi.fn();
    const incoming = { method: 'PRIVATE-TOKEN', nextUrl: { pathname: '/api/health' } } as Pick<NextRequest, 'method' | 'nextUrl'>;
    beginRequestMetric(incoming, { enabled: true, clock: () => 0, sink })(Infinity);
    expect(sink).toHaveBeenCalledExactlyOnceWith({ event: 'oneshot_request', route: '/api/health', method: 'OTHER', status: 500, durationMs: 0 });
  });
});

describe('best-effort request completion', () => {
  it('is silent by default and accepts only the explicit true environment value', () => {
    const sink = vi.fn(), clock = vi.fn(() => 0);
    for (const flag of ['', 'false', 'TRUE', '1']) {
      vi.stubEnv('ONESHOT_REQUEST_METRICS', flag);
      beginRequestMetric(request('/api/health'), { sink, clock })(200);
    }
    expect(sink).not.toHaveBeenCalled(); expect(clock).not.toHaveBeenCalled();
    vi.stubEnv('ONESHOT_REQUEST_METRICS', 'true');
    beginRequestMetric(request('/api/health'), { sink, clock })(200);
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it('uses the monotonic clock, reports milliseconds, and completes once', () => {
    const clock = vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(112.34567);
    const sink = vi.fn(), wallClock = vi.spyOn(Date, 'now').mockReturnValue(9_999_999);
    const complete = beginRequestMetric(request('/api/health'), { enabled: true, sink, clock });
    wallClock.mockReturnValue(-9_999_999);
    complete(201); complete(500);
    expect(sink).toHaveBeenCalledExactlyOnceWith({ event: 'oneshot_request', route: '/api/health', method: 'GET', status: 201, durationMs: 12.346 });
  });

  it('contains clock and sink failures without producing a second event', () => {
    const incoming = request('/api/health');
    const sink = vi.fn(() => { throw new Error('private-log-sink'); });
    const complete = beginRequestMetric(incoming, { enabled: true, clock: () => 0, sink });
    expect(() => { complete(200); complete(503); }).not.toThrow();
    expect(sink).toHaveBeenCalledTimes(1);
    const failedClock = vi.fn(() => { throw new Error('private-clock'); });
    expect(() => beginRequestMetric(incoming, { enabled: true, clock: failedClock, sink })(200)).not.toThrow();
    const changedClock = vi.fn().mockReturnValueOnce(1).mockReturnValueOnce(Number.NaN);
    const finiteSink = vi.fn();
    beginRequestMetric(incoming, { enabled: true, clock: changedClock, sink: finiteSink })(200);
    expect(finiteSink.mock.calls[0][0].durationMs).toBe(0);
  });

  it('writes exactly one JSON metric for success, preflight, migration and handled failures', async () => {
    vi.stubEnv('ONESHOT_REQUEST_METRICS', 'true');
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const cases: { path: string; status: number; init: ConstructorParameters<typeof NextRequest>[1]; handler: () => Promise<Response> }[] = [
      { path: '/api/health', status: 201, init: undefined, handler: async () => json({ private: 'not-logged' }, 201) },
      { path: '/api/health', status: 204, init: { method: 'OPTIONS', headers: { Origin: 'https://oneshot.app', 'Access-Control-Request-Method': 'GET' } }, handler: async () => json({}) },
      { path: '/api/not-found/private-user', status: 404, init: undefined, handler: async () => json({}) },
      { path: '/api/oneshot/session', status: 401, init: undefined, handler: async () => { throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in.'); } },
      { path: '/api/oneshot/session', status: 429, init: undefined, handler: async () => { throw new ApiError(429, 'RATE_LIMITED', 'Wait.'); } },
      { path: '/api/oneshot/session', status: 400, init: undefined, handler: async () => { z.string().parse(1); return json({}); } },
      { path: '/api/oneshot/session', status: 400, init: undefined, handler: async () => { throw new SyntaxError('private-json-input'); } },
      { path: '/api/oneshot/session', status: 413, init: { method: 'POST', headers: { 'Content-Length': String(8 * 1024 * 1024) } }, handler: async () => json({}) },
      { path: '/api/oneshot/session', status: 403, init: { headers: { Origin: 'https://private-origin.invalid' } }, handler: async () => json({}) },
    ];
    for (const [index, scenario] of cases.entries()) {
      const response = await api(scenario.handler)(request(scenario.path, scenario.init), {});
      expect(response.status).toBe(scenario.status);
      expect(info).toHaveBeenCalledTimes(index + 1);
      const event = JSON.parse(info.mock.calls[index][0]);
      expect(Object.keys(event).sort()).toEqual(['durationMs', 'event', 'method', 'route', 'status']);
      expect(event.status).toBe(scenario.status);
      expect(event.durationMs).toBeGreaterThanOrEqual(0);
      expect(event.event).toBe('oneshot_request');
    }
    expect(error).not.toHaveBeenCalled();
    expect(JSON.stringify(info.mock.calls)).not.toMatch(/private-|not-logged/);
  });

  it('preserves the response and CORS when both metric and unexpected-error sinks throw', async () => {
    vi.stubEnv('ONESHOT_REQUEST_METRICS', 'true');
    vi.spyOn(console, 'info').mockImplementation(() => { throw new Error('sink failed'); });
    const error = vi.spyOn(console, 'error').mockImplementation(() => { throw new Error('sink failed'); });
    const response = await api(async () => { throw new Error('postgresql://operator:private-password@private-host/config?secret=private-secret'); })(request('/api/oneshot/session', { headers: { Origin: 'https://oneshot.app' } }), {});
    expect(response.status).toBe(503);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://oneshot.app');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: { code: 'SERVICE_UNAVAILABLE', message: 'The service could not complete this request. Please retry.' } });
    expect(error).toHaveBeenCalledExactlyOnceWith('[oneshot API] SERVICE_UNAVAILABLE');
    expect(JSON.stringify(error.mock.calls)).not.toMatch(/private-|postgresql|password|secret=/);
  });
});
