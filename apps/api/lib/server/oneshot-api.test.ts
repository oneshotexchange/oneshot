import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { oneshotApi } from './oneshot-api';
import { requireOneshotSession } from './oneshot-auth';
import { createOneshotDraft, listOneshotDrafts, prepareOneshotDraft } from './oneshot-drafts';
import { storeImage } from './media';
import { ApiError } from './errors';
import { nftLaunch } from './nft-launch';

describe('private creator launch progress boundary', () => {
  const draftId = '70000000-0000-4000-8000-000000000001', launchId = '70000000-0000-4000-8000-000000000002';
  const wallet: `0x${string}` = `0x${'12'.repeat(20)}`, deploymentId = 'ab'.repeat(32);
  const identity = { provider: 'privy' as const, userId: 'did:privy:progress-route', sessionId: 'private-progress-session', expiresAt: 9999999999, linkedAddresses: [wallet] };
  const endpoint = `http://localhost/api/oneshot/launch/drafts/${draftId}`;
  it('authenticates before reading a selection or revealing saved launch state', async () => {
    vi.mocked(requireOneshotSession).mockRejectedValue(new ApiError(401, 'AUTH_REQUIRED', 'Sign in with Privy.'));
    for (const query of ['', '?wallet=invalid', `?wallet=${wallet}&revision=2`]) expect((await oneshotApi(new NextRequest(endpoint + query), {})).status).toBe(401);
    expect(nftLaunch.progress).not.toHaveBeenCalled();
  });
  it('passes exactly the owned draft selection to the service without caching', async () => {
    vi.mocked(requireOneshotSession).mockResolvedValue(identity);
    const workspace = { draftId, revision: 2, from: wallet, deploymentId, items: [], pending: [], nextCursor: null, selected: null };
    vi.mocked(nftLaunch.progress).mockResolvedValue(workspace);
    const response = await oneshotApi(new NextRequest(`${endpoint}?wallet=${wallet}&revision=2&launchId=${launchId}`), {});
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store'); expect(await response.json()).toEqual(workspace);
    expect(nftLaunch.progress).toHaveBeenCalledExactlyOnceWith(draftId, { from: wallet, expectedRevision: 2, launchId, cursor: undefined }, identity);
  });
  it.each(['', '?wallet=bad&revision=2', '?revision=2', `?wallet=${wallet}&revision=0`, `?wallet=${wallet}&revision=2&revision=3`, `?wallet=${wallet}&revision=2&wallet=${wallet}`, `?wallet=${wallet}&revision=2&unexpected=1`, `?wallet=${wallet}&revision=2&launchId=${launchId}&cursor=abc`])('rejects ambiguous or invalid selections: %s', async query => {
    vi.mocked(requireOneshotSession).mockResolvedValue(identity);
    expect((await oneshotApi(new NextRequest(endpoint + query), {})).status).toBe(400); expect(nftLaunch.progress).not.toHaveBeenCalled();
  });
});

vi.mock('./oneshot-auth', async importOriginal => ({ ...await importOriginal<typeof import('./oneshot-auth')>(), requireOneshotSession: vi.fn() }));
vi.mock('./oneshot-drafts', async importOriginal => ({ ...await importOriginal<typeof import('./oneshot-drafts')>(), createOneshotDraft: vi.fn(), listOneshotDrafts: vi.fn(), prepareOneshotDraft: vi.fn() }));
vi.mock('./media', async importOriginal => ({ ...await importOriginal<typeof import('./media')>(), storeImage: vi.fn() }));
vi.mock('./nft-launch', async importOriginal => {
  const original = await importOriginal<typeof import('./nft-launch')>();
  return { ...original, nftLaunch: { ...original.nftLaunch, floor: vi.fn(), status: vi.fn(), collection: vi.fn(), progress: vi.fn(), earnings: vi.fn() } };
});
beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost');
  vi.stubEnv('ONESHOT_API_URL', 'http://localhost:3001');
  vi.mocked(requireOneshotSession).mockReset(); vi.mocked(createOneshotDraft).mockReset(); vi.mocked(listOneshotDrafts).mockReset();
  vi.mocked(prepareOneshotDraft).mockReset(); vi.mocked(storeImage).mockReset();
  vi.mocked(nftLaunch.floor).mockReset(); vi.mocked(nftLaunch.status).mockReset(); vi.mocked(nftLaunch.collection).mockReset(); vi.mocked(nftLaunch.progress).mockReset(); vi.mocked(nftLaunch.earnings).mockReset();
});

describe('private current NFT earnings route', () => {
  const wallet = `0x${'17'.repeat(20)}` as `0x${string}`;
  const identity = { provider: 'privy' as const, userId: 'did:privy:earnings-route', sessionId: 'private-session', expiresAt: 9999999999, linkedAddresses: [wallet] };
  const endpoint = 'http://localhost/api/oneshot/launch/earnings';
  it('authenticates before parsing balances or a malformed cursor', async () => {
    vi.mocked(requireOneshotSession).mockRejectedValue(new ApiError(401, 'AUTH_REQUIRED', 'Sign in with Privy.'));
    const response = await oneshotApi(new NextRequest(endpoint + '?wallet=bad&cursor=bad'), {});
    expect(response.status).toBe(401); expect(response.headers.get('cache-control')).toBe('no-store'); expect(nftLaunch.earnings).not.toHaveBeenCalled();
  });
  it('passes one linked wallet and cursor to the service without caching', async () => {
    vi.mocked(requireOneshotSession).mockResolvedValue(identity);
    vi.mocked(nftLaunch.earnings).mockResolvedValue({ wallet, nextCursor: null } as never);
    const response = await oneshotApi(new NextRequest(`${endpoint}?wallet=${wallet}&cursor=page2`), {});
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(nftLaunch.earnings).toHaveBeenCalledExactlyOnceWith({ from: wallet, cursor: 'page2' }, identity);
  });
  it.each(['', '?wallet=bad', `?wallet=${wallet}&wallet=${wallet}`, `?wallet=${wallet}&cursor=`, `?wallet=${wallet}&cursor=a&cursor=b`, `?wallet=${wallet}&limit=10`, `?wallet=${wallet}&cursor=${'a'.repeat(2049)}`])('rejects ambiguous or malformed balance queries: %s', async query => {
    vi.mocked(requireOneshotSession).mockResolvedValue(identity);
    expect((await oneshotApi(new NextRequest(endpoint + query), {})).status).toBe(400); expect(nftLaunch.earnings).not.toHaveBeenCalled();
  });
  it('preserves an unlinked-wallet rejection from the balance service', async () => {
    vi.mocked(requireOneshotSession).mockResolvedValue(identity);
    vi.mocked(nftLaunch.earnings).mockRejectedValue(new ApiError(403, 'WALLET_NOT_LINKED', 'Select a linked wallet.'));
    const response = await oneshotApi(new NextRequest(`${endpoint}?wallet=${wallet}`), {});
    expect(response.status).toBe(403); expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('private creator floor API routing', () => {
  const wallet = `0x${'ab'.repeat(20)}` as `0x${string}`, collection = `0x${'cd'.repeat(20)}` as `0x${string}`;
  const identity = { provider: 'privy' as const, userId: 'did:privy:private-floor-route', sessionId: 'private-session', expiresAt: 9999999999, linkedAddresses: [wallet] };
  const privateSettings = { eligible: true, creator: wallet, collection, deploymentId: 'local-guarded', enabled: false, floorRaw: '0', policyCommitment: `0x${'0'.repeat(64)}` as `0x${string}`, guarded: true, network: { mode: 'local' as const, name: 'Local Anvil' as const, chainId: 31337 as const, nativeSymbol: 'ETH' as const, nativeDecimals: 18 as const } };
  const endpoint = `http://localhost/api/oneshot/launch/floor/${collection}`;

  it('requires authentication before private queries are parsed or settings are loaded', async () => {
    vi.mocked(requireOneshotSession).mockRejectedValue(new ApiError(401, 'AUTH_REQUIRED', 'Sign in with Privy.'));
    for (const query of [`?wallet=${wallet}`, '?wallet=invalid&unexpected=true']) {
      const response = await oneshotApi(new NextRequest(`${endpoint}${query}`), {});
      expect(response.status).toBe(401); expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(await response.json()).toEqual({ error: { code: 'AUTH_REQUIRED', message: 'Sign in with Privy.' } });
    }
    expect(nftLaunch.floor).not.toHaveBeenCalled(); expect(nftLaunch.status).not.toHaveBeenCalled(); expect(nftLaunch.collection).not.toHaveBeenCalled();
  });

  it('passes exactly one valid wallet and the verified session to the private service without caching', async () => {
    vi.mocked(requireOneshotSession).mockResolvedValue(identity); vi.mocked(nftLaunch.floor).mockResolvedValue(privateSettings);
    const request = new NextRequest(`${endpoint}?wallet=${wallet}`, { headers: { Authorization: 'Bearer private-token' } });
    const response = await oneshotApi(request, {});
    expect(requireOneshotSession).toHaveBeenCalledExactlyOnceWith(request);
    expect(nftLaunch.floor).toHaveBeenCalledExactlyOnceWith(collection, wallet, identity);
    expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual(privateSettings);
    expect(nftLaunch.status).not.toHaveBeenCalled(); expect(nftLaunch.collection).not.toHaveBeenCalled();
  });

  it.each([
    '', '?wallet=', '?wallet=invalid', '?wallet=0x1234', `?wallet=${wallet}&wallet=${wallet}`,
    `?wallet=${wallet}&wallet=${collection}`, `?wallet=${wallet}&extra=true`, `?wallet=${wallet}&limit=1`,
    `?wallet=${wallet}&cursor=private`, `?creator=${wallet}`, `?Wallet=${wallet}`, `?wallet=${wallet}%20`,
  ])('rejects a missing, malformed, duplicate or extra wallet query: %s', async query => {
    vi.mocked(requireOneshotSession).mockResolvedValue(identity);
    const response = await oneshotApi(new NextRequest(`${endpoint}${query}`), {});
    expect(response.status).toBe(400); expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ error: { code: 'INVALID_INPUT' } });
    expect(nftLaunch.floor).not.toHaveBeenCalled();
  });

  it('preserves a private not-found result without revealing a policy or eligibility', async () => {
    vi.mocked(requireOneshotSession).mockResolvedValue(identity);
    vi.mocked(nftLaunch.floor).mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'Settings not available.'));
    const response = await oneshotApi(new NextRequest(`${endpoint}?wallet=${wallet}`), {});
    expect(response.status).toBe(404); expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Settings not available.' } });
  });

  it('passes disable-only private settings through for a creator whose eligibility was removed', async () => {
    vi.mocked(requireOneshotSession).mockResolvedValue(identity);
    const disableOnly = { ...privateSettings, eligible: false, enabled: true, floorRaw: '5000000000000000000' };
    vi.mocked(nftLaunch.floor).mockResolvedValue(disableOnly);
    const response = await oneshotApi(new NextRequest(`${endpoint}?wallet=${wallet}`), {});
    expect(response.status).toBe(200); expect(await response.json()).toEqual(disableOnly);
    expect(nftLaunch.floor).toHaveBeenCalledExactlyOnceWith(collection, wallet, identity);
  });

  it('keeps public launch reads separate from the private floor service', async () => {
    vi.mocked(requireOneshotSession).mockRejectedValue(new ApiError(401, 'AUTH_REQUIRED', 'Sign in with Privy.'));
    const publicStatus = { enabled: false, reason: 'Local execution unavailable.', network: null, deploymentId: null };
    const publicCollection = { collection, name: 'Public collection', creator: wallet };
    vi.mocked(nftLaunch.status).mockResolvedValue(publicStatus as never); vi.mocked(nftLaunch.collection).mockResolvedValue(publicCollection as never);
    const availability = await oneshotApi(new NextRequest(`http://localhost/api/oneshot/launch/status?wallet=${wallet}`), {});
    const terms = await oneshotApi(new NextRequest(`http://localhost/api/oneshot/launch/collections/${collection}?wallet=${wallet}`), {});
    expect(availability.status).toBe(200); expect(await availability.json()).toEqual({ ...publicStatus, reason: 'Collection launches are currently unavailable. You can save a draft and return later.' });
    expect(terms.status).toBe(200); expect(await terms.json()).toEqual(publicCollection);
    expect(requireOneshotSession).not.toHaveBeenCalled(); expect(nftLaunch.floor).not.toHaveBeenCalled();
  });

  it.each(['POST', 'PUT', 'DELETE', 'HEAD'])('does not expose the private GET under %s', async method => {
    vi.mocked(requireOneshotSession).mockResolvedValue(identity);
    const response = await oneshotApi(new NextRequest(`${endpoint}?wallet=${wallet}`, { method }), {});
    expect(response.status).toBe(404); expect(nftLaunch.floor).not.toHaveBeenCalled();
  });
});
afterEach(() => vi.unstubAllEnvs());
describe('new Privy API routing', () => {
  it('blocks unauthenticated state writes before parsing or storage', async () => {
    vi.mocked(requireOneshotSession).mockRejectedValue(new ApiError(401, 'AUTH_REQUIRED', 'Sign in with Privy.'));
    const response = await oneshotApi(new NextRequest('http://localhost/api/oneshot/drafts', { method: 'POST', body: '{}' }), {});
    expect(response.status).toBe(401); expect(createOneshotDraft).not.toHaveBeenCalled();
  });
  it('reaches the new account-owned draft service through the legacy migration guard', async () => {
    const identity = { provider: 'privy' as const, userId: 'did:privy:route-user', sessionId: 'session', expiresAt: 9999999999, linkedAddresses: [] };
    vi.mocked(requireOneshotSession).mockResolvedValue(identity);
    vi.mocked(listOneshotDrafts).mockResolvedValue([]);
    const response = await oneshotApi(new NextRequest('http://localhost/api/oneshot/drafts'), {});
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ items: [] }); expect(listOneshotDrafts).toHaveBeenCalledWith(identity);
  });
  it('keeps chain execution unsupported and exposes no token or session ID', async () => {
    vi.mocked(requireOneshotSession).mockResolvedValue({ provider: 'privy', userId: 'did:privy:route-user2', sessionId: 'private-session', expiresAt: 9999999999, linkedAddresses: [] });
    const session = await oneshotApi(new NextRequest('http://localhost/api/oneshot/session'), {});
    expect(JSON.stringify(await session.json())).not.toContain('private-session');
    const trade = await oneshotApi(new NextRequest('http://localhost/api/oneshot/transactions', { method: 'POST', body: '{}' }), {});
    expect(trade.status).toBe(404);
  });
  it('checks origin on new bearer-authenticated mutations too', async () => {
    const response = await oneshotApi(new NextRequest('http://localhost/api/oneshot/drafts', { method: 'POST', headers: { Origin: 'https://foreign.example' }, body: '{}' }), {});
    expect(response.status).toBe(403); expect(requireOneshotSession).not.toHaveBeenCalled();
  });
  it('returns a client error for malformed multipart uploads after authentication', async () => {
    vi.mocked(requireOneshotSession).mockResolvedValue({ provider: 'privy', userId: 'did:privy:bad-upload', sessionId: 'session', expiresAt: 9999999999, linkedAddresses: [] });
    const response = await oneshotApi(new NextRequest('http://localhost/api/oneshot/media', {
      method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=fixture' }, body: 'not multipart data',
    }), {});
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'INVALID_MULTIPART' } });
  });
  it('does not expose operator network verification to signed-in customers', async () => {
    vi.mocked(requireOneshotSession).mockResolvedValue({ provider: 'privy', userId: 'did:privy:customer', sessionId: 'session', expiresAt: 9999999999, linkedAddresses: [] });
    const response = await oneshotApi(new NextRequest('http://localhost/api/oneshot/network'), {});
    expect(response.status).toBe(404);
  });
  it('prepares metadata using the API hostname while authorizing the web hostname', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://oneshot.app');
    vi.stubEnv('ONESHOT_API_URL', 'https://api.oneshot.app');
    const identity = { provider: 'privy' as const, userId: 'did:privy:separate-origins', sessionId: 'session', expiresAt: 9999999999, linkedAddresses: [] };
    vi.mocked(requireOneshotSession).mockResolvedValue(identity);
    vi.mocked(prepareOneshotDraft).mockResolvedValue({ id: 'draft-id' } as never);
    const response = await oneshotApi(new NextRequest('https://untrusted-request-host.app/api/oneshot/drafts/draft-id/prepare', {
      method: 'POST', headers: { Origin: 'https://oneshot.app', 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: 1 }),
    }), {});
    expect(response.status).toBe(200);
    expect(prepareOneshotDraft).toHaveBeenCalledWith('draft-id', 1, identity, 'https://api.oneshot.app');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://oneshot.app');
  });
  it('returns canonical API media URLs and relative persisted references on upload', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://oneshot.app');
    vi.stubEnv('ONESHOT_API_URL', 'https://api.oneshot.app');
    const identity = { provider: 'privy' as const, userId: 'did:privy:separate-upload', sessionId: 'session', expiresAt: 9999999999, linkedAddresses: [] };
    vi.mocked(requireOneshotSession).mockResolvedValue(identity);
    const hash = 'a'.repeat(64);
    vi.mocked(storeImage).mockResolvedValue({ url: `https://api.oneshot.app/api/media/${hash}.webp`, hash, mimeType: 'image/webp', size: 4 });
    const body = new FormData(); body.append('file', new File(['art'], 'art.png', { type: 'image/png' }));
    const response = await oneshotApi(new NextRequest('http://localhost:3001/api/oneshot/media', { method: 'POST', headers: { Origin: 'https://oneshot.app' }, body }), {});
    expect(response.status).toBe(201);
    expect(storeImage).toHaveBeenCalledWith(expect.any(Buffer), identity.userId, 'https://api.oneshot.app');
    expect(await response.json()).toMatchObject({ url: `https://api.oneshot.app/api/media/${hash}.webp`, reference: `/api/media/${hash}.webp` });
  });
});
