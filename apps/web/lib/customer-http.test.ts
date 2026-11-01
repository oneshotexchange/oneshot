import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './client-api';
import { indexedApi } from './client-indexed-api';
import { createOneshotAccountApi } from './client-oneshot-api';
import { createNftFloorApi } from './client-nft-floor';
import { createNftLaunchApi, createNftLaunchController, sendReviewedEvmTransaction, type NftLaunchReview } from './client-nft-launch';
import { CONNECTION_MESSAGE, RESPONSE_MESSAGE, customerFetch, customerResponseJson } from './customer-http';

const from = `0x${'ab'.repeat(20)}`, collection = `0x${'cd'.repeat(20)}`, hash = `0x${'ef'.repeat(32)}`;
const authenticated = { identityScope: () => 'account/wallet', getAccessToken: async () => 'fresh-token' };
const clients = ['general', 'indexed', 'account', 'launch', 'floor'] as const;
type Client = typeof clients[number];
function request(client: Client, fetcher: typeof fetch, signal?: AbortSignal) {
  vi.stubGlobal('fetch', fetcher);
  switch (client) {
    case 'general': return api('/api/tokens', { signal });
    case 'indexed': return indexedApi('/api/oneshot/indexed/collections', signal);
    case 'account': return createOneshotAccountApi({ ...authenticated, fetcher }).listDrafts();
    case 'launch': return createNftLaunchApi({ ...authenticated, fetcher }).status(signal);
    case 'floor': return createNftFloorApi({ ...authenticated, fetcher }).status(collection, from);
  }
}
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('customer HTTP transport', () => {
  it.each(clients)('gives an actionable connection failure in the %s client', async client => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(request(client, fetcher)).rejects.toThrow(CONNECTION_MESSAGE);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('preserves the exact destination, options and injected fetcher', async () => {
    const input = new URL('https://api.oneshot.app/api/example');
    const options: RequestInit = { method: 'POST', body: '{"quantity":"2"}', headers: new Headers({ authorization: 'Bearer token' }), credentials: 'omit', redirect: 'error', cache: 'no-store', signal: new AbortController().signal };
    const response = Response.json({ saved: true }), fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
    expect(await customerFetch(input, options, fetcher)).toBe(response);
    expect(fetcher.mock.calls[0][0]).toBe(input);
    expect(fetcher.mock.calls[0][1]).toBe(options);
  });

  it.each(clients)('preserves an AbortError from the %s client', async client => {
    const abort = new DOMException('The request was cancelled.', 'AbortError');
    await expect(request(client, vi.fn<typeof fetch>().mockRejectedValue(abort))).rejects.toBe(abort);
  });

  it('preserves a caller cancellation reason and a signal carried by a Request', async () => {
    const controller = new AbortController(), reason = new Error('Selection changed');
    const input = new Request('https://api.oneshot.app/api/example', { signal: controller.signal });
    controller.abort(reason);
    await expect(customerFetch(input, undefined, vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Failed to fetch')))).rejects.toBe(reason);
    await expect(customerFetch(input, { signal: null }, vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Failed to fetch')))).rejects.toThrow(CONNECTION_MESSAGE);
  });
});

describe('customer JSON responses', () => {
  it.each(clients)('rejects unreadable successful JSON in the %s client instead of inventing empty data', async client => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('<html>Unavailable</html>'));
    const failure = request(client, fetcher);
    if (client === 'indexed') await expect(failure).rejects.toMatchObject({ status: 502, code: 'INVALID_READ_RESPONSE' });
    else if (client === 'launch') await expect(failure).rejects.toMatchObject({ status: 200, code: 'INVALID_RESPONSE' });
    else if (client === 'floor') await expect(failure).rejects.toMatchObject({ code: 'INVALID_FLOOR_POLICY' });
    else await expect(failure).rejects.toThrow(RESPONSE_MESSAGE);
  });

  it('preserves aborts during body parsing, including HTTP error bodies', async () => {
    const abort = new DOMException('Cancelled during body read', 'AbortError');
    for (const ok of [true, false]) {
      const response = { ok, json: async () => { throw abort; } } as unknown as Response;
      await expect(customerResponseJson(response)).rejects.toBe(abort);
    }
    const controller = new AbortController(), reason = new Error('No longer viewing this collection'); controller.abort(reason);
    const response = { ok: true, json: async () => { throw new SyntaxError('Interrupted JSON'); } } as unknown as Response;
    await expect(customerResponseJson(response, { signal: controller.signal })).rejects.toBe(reason);
  });

  it('retains typed HTTP status when an error response is not JSON', async () => {
    await expect(request('indexed', vi.fn<typeof fetch>().mockResolvedValue(new Response('Unavailable', { status: 503 })))).rejects.toMatchObject({ status: 503, code: 'READ_FAILED' });
    await expect(request('launch', vi.fn<typeof fetch>().mockResolvedValue(new Response('Conflict', { status: 409 })))).rejects.toMatchObject({ status: 409, code: 'LAUNCH_ERROR' });
  });

  it('preserves HTTP transaction and draft consequences without changing codes or status', async () => {
    const message = 'This transaction reverted. Review your balance before preparing a new transaction.';
    await expect(request('general', vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { code: 'TRANSACTION_REVERTED', message } }, { status: 409 })))).rejects.toThrow(message);
    await expect(request('launch', vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { code: 'REVIEW_EXPIRED', message: 'This review expired. Prepare a new review.' } }, { status: 409 })))).rejects.toMatchObject({ code: 'REVIEW_EXPIRED', status: 409, message: 'This review expired. Prepare a new review.' });
    await expect(request('indexed', vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { code: 'CURSOR_STALE', message: 'Cursor is stale' } }, { status: 409 })))).rejects.toMatchObject({ code: 'CURSOR_STALE', status: 409 });
    await expect(request('account', vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { code: 'DRAFT_CHANGED', message: 'Reload your draft before saving.' } }, { status: 409 })))).rejects.toThrow('Reload your draft before saving.');
  });

  it('hides floor setup details while retaining its HTTP code, and preserves ineligibility actions', async () => {
    await expect(request('floor', vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { code: 'FLOOR_CONFIG_INVALID', message: 'Configure a valid private creator eligibility list.' } }, { status: 503 })))).rejects.toMatchObject({ status: 503, code: 'FLOOR_CONFIG_INVALID', message: 'This service is temporarily unavailable. Please try again later.' });
    await expect(request('floor', vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { code: 'FLOOR_INELIGIBLE', message: 'This creator wallet can only disable its existing floor policy.' } }, { status: 403 })))).rejects.toMatchObject({ status: 403, code: 'FLOOR_INELIGIBLE', message: 'This creator wallet can only disable its existing floor policy.' });
    expect(await request('floor', vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 })))).toBeNull();
  });
});

describe('transaction outcomes stay distinct from HTTP failures', () => {
  const now = Date.parse('2026-10-23T12:00:00Z');
  const review: NftLaunchReview = {
    id: 'review-one', reviewHash: `0x${'12'.repeat(32)}`, expiresAt: new Date(now + 120_000).toISOString(),
    chainId: 31337, from, to: collection, data: '0x1234', value: '1', action: 'create',
    network: { chainId: 31337, nativeSymbol: 'ETH', nativeDecimals: 18 }, summary: {}, deploymentId: 'local-test', draftId: 'draft-one', revision: 1,
    simulation: { blockNumber: '20', blockHash: hash, gasEstimate: '30000' },
  };

  it('retains a broadcast hash after a connection failure and blocks a replacement approval', async () => {
    const fetcher = vi.fn<typeof fetch>(async input => {
      if (/\/(review|validate)$/.test(String(input))) return Response.json(review);
      throw new TypeError('Failed to fetch');
    });
    const api = createNftLaunchApi({ ...authenticated, fetcher }), send = vi.fn().mockResolvedValue(hash);
    const controller = createNftLaunchController({ api, context: () => ({ identityScope: authenticated.identityScope(), address: from, chainId: 31337, draftId: 'draft-one', revision: 1, prepared: true, deploymentId: 'local-test' }), now: () => now, sendEvmTransaction: send });
    const input = { draftId: 'draft-one', expectedRevision: 1, from, action: 'create' as const, localEthAcknowledged: true as const };
    await controller.prepare(input); await controller.approve();
    expect(controller.getSnapshot()).toMatchObject({ phase: 'error', hash, receipt: null, message: CONNECTION_MESSAGE });
    await controller.prepare(input); await controller.approve();
    expect(send).toHaveBeenCalledOnce();
  });

  it('leaves a wallet provider failure unchanged', async () => {
    const walletError = new TypeError('Failed to fetch');
    const provider = { request: vi.fn(async ({ method }: { method: string }) => {
      if (method === 'eth_chainId') return '0x7a69';
      if (method === 'eth_accounts') return [from];
      throw walletError;
    }) };
    await expect(sendReviewedEvmTransaction({ transaction: { chainId: 31337, from, to: collection, data: '0x1234', value: '1', expectedIdentityScope: authenticated.identityScope(), expiresAt: review.expiresAt }, identityScope: authenticated.identityScope, getProvider: async () => provider, now: () => now })).rejects.toBe(walletError);
  });
});
