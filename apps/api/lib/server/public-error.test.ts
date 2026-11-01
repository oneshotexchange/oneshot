import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { api, ApiError } from './http';

const unavailable = 'This service is temporarily unavailable. Please try again later.';
const fail = (code: string, message: string, status = 503) => api(async () => { throw new ApiError(status, code, message); });
afterEach(() => vi.unstubAllEnvs());

describe('customer API error boundary', () => {
  it.each([
    'AUTH_NOT_CONFIGURED', 'AUTH_PROVIDER_UNAVAILABLE', 'DATABASE_REQUIRED', 'STORAGE_REQUIRED',
    'INVALID_STORAGE_QUOTA', 'APP_ORIGIN_REQUIRED', 'API_ORIGIN_REQUIRED', 'INVALID_APP_ORIGIN',
    'INVALID_API_ORIGIN', 'HTTPS_METADATA_REQUIRED', 'FLOOR_CONFIG_INVALID', 'LISTING_AUTHORITY_UNAVAILABLE',
    'INDEXER_CONFIG_INCOMPLETE', 'INDEXER_MANIFEST_INVALID', 'INDEXER_READ_UNAVAILABLE',
    'RPC_CONFIG_INVALID', 'RPC_DATA_INVALID', 'DEPLOYMENT_REQUIRED', 'DEPLOYMENT_UNAVAILABLE', 'EXECUTION_DISABLED',
  ])('hides %s setup instructions from direct customer API callers while preserving the code and status', async code => {
    const response = await fail(code, 'Configure private provider and database settings.', 409)(new NextRequest('https://api.oneshot.app/api/oneshot/test'), {});
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code, message: unavailable } });
  });
  it.each([
    ['SCHEDULE_EXPIRED', 'The mint schedule ended. Choose another collection.'],
    ['REVIEW_EXPIRED', 'This review expired. Prepare a fresh review.'],
    ['WALLET_NOT_LINKED', 'Choose an Ethereum wallet linked to your account.'],
    ['DEPLOYMENT_CHANGED', 'The test network changed. Prepare a new review.'],
    ['INVALID_PRICE', 'Choose a positive listing price.'],
  ])('preserves actionable %s customer messages', async (code, message) => {
    const response = await fail(code, message, 409)(new NextRequest('https://api.oneshot.app/api/oneshot/test'), {});
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code, message } });
  });
  it('retains operational errors on the administrator API and gives customers an action for a network change', async () => {
    const message = 'Configure a valid network profile before verifying the RPC.';
    const admin = await fail('RPC_CONFIG_INVALID', message)(new NextRequest('https://api.oneshot.app/api/admin/network'), {});
    expect((await admin.json()).error.message).toBe(message);
    const customer = await fail('INDEXER_CHAIN_MOVED', 'Wait for the indexer to synchronize.', 409)(new NextRequest('https://api.oneshot.app/api/oneshot/test'), {});
    expect((await customer.json()).error.message).toBe('Activity is being updated after a network change. Please refresh shortly.');
  });
  it('also hides origin setup errors raised before a customer handler runs', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '');
    const handler = vi.fn(async () => Response.json({ ok: true }));
    const response = await api(handler)(new NextRequest('https://api.oneshot.app/api/oneshot/test', {
      headers: { Origin: 'https://oneshot.app' },
    }), {});
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: 'APP_ORIGIN_REQUIRED', message: unavailable } });
    expect(handler).not.toHaveBeenCalled();
  });
});
