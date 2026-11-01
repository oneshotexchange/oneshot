import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { database } from './store';
import { readiness } from './readiness';
import { GET as health } from '../../app/api/health/route';
import { GET as ready } from '../../app/api/ready/route';
import { NextRequest } from 'next/server';

vi.mock('./store', () => ({ database: vi.fn() }));
beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://oneshot.app');
  vi.stubEnv('ONESHOT_API_URL', 'https://api.oneshot.app');
  vi.stubEnv('S3_BUCKET', 'oneshot'); vi.stubEnv('S3_ENDPOINT', 'https://account.r2.cloudflarestorage.com');
  vi.stubEnv('S3_ACCESS_KEY_ID', 'private-key'); vi.stubEnv('S3_SECRET_ACCESS_KEY', 'private-secret');
  vi.mocked(database).mockReset();
});
afterEach(() => vi.unstubAllEnvs());

describe('separate liveness and readiness', () => {
  it('keeps liveness independent of PostgreSQL and external services', async () => {
    const response = await health(new NextRequest('https://api.oneshot.app/api/health'), {});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ service: 'oneshot-api', status: 'ok' });
    expect(database).not.toHaveBeenCalled();
  });
  it('requires live database access and complete S3 configuration', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    vi.mocked(database).mockReturnValue({ query } as never);
    const result = await readiness();
    expect(result.ready).toBe(true);
    expect(query).toHaveBeenCalledWith('SELECT 1');
    expect(result.storageAvailabilityVerified).toBe(false);
    vi.stubEnv('S3_SECRET_ACCESS_KEY', '');
    expect((await readiness()).ready).toBe(false);
  });
  it('reports failed dependencies without leaking connection errors or credentials', async () => {
    vi.mocked(database).mockReturnValue({ query: vi.fn().mockRejectedValue(new Error('postgres://private-password')) } as never);
    const result = await readiness();
    expect(result.ready).toBe(false); expect(result.checks.databaseAvailable).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/private|postgres:/);
  });
  it('returns only a readiness boolean publicly for both available and unavailable dependencies', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    vi.mocked(database).mockReturnValue({ query } as never);
    const available = await ready(new NextRequest('https://api.oneshot.app/api/ready'), {});
    expect(available.status).toBe(200);
    expect(available.headers.get('cache-control')).toBe('no-store');
    expect(await available.json()).toEqual({ service: 'oneshot-api', ready: true });
    query.mockRejectedValue(new Error('postgres://private-password'));
    const unavailable = await ready(new NextRequest('https://api.oneshot.app/api/ready'), {});
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ service: 'oneshot-api', ready: false });
  });
});
