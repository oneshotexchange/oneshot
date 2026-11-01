import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NftFloorSettings } from '../components/nft-floor-settings';
import { createNftFloorApi, nftFloorPolicyRequest, validatePrivateNftFloorStatus, type PrivateNftFloorStatus } from './client-nft-floor';
import type { WalletState } from './client-wallet';

vi.mock('./client-wallet', () => ({ useWallet: () => privateWallet }));
let privateWallet: Partial<WalletState>;

const creator = `0x${'ab'.repeat(20)}`, collection = `0x${'cd'.repeat(20)}`;
const status: PrivateNftFloorStatus = { eligible: true, creator, collection, deploymentId: 'local-guarded', enabled: true, floorRaw: '5000000000000000000', policyCommitment: `0x${'ef'.repeat(32)}`, guarded: true, network: { chainId: 31337, nativeSymbol: 'ETH', nativeDecimals: 18 } };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }

describe('private creator floor client', () => {
  it('renders no settings, placeholder, mode label or badge before private eligibility is verified', () => {
    const linked: Partial<WalletState> = { authenticated: true, connected: true, account: { address: creator as `0x${string}` }, identityScope: () => 'account/creator' };
    for (const fields of [{ authenticated: false }, { connected: false }, { account: null }, { identityScope: () => null }, {}]) {
      privateWallet = { ...linked, ...fields };
      expect(renderToStaticMarkup(createElement(NftFloorSettings, { collection }))).toBe('');
    }
    privateWallet = linked; expect(renderToStaticMarkup(createElement(NftFloorSettings, { collection: '' }))).toBe('');
  });
  it('loads only an authenticated selected creator’s settings without cookies or caches', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(status));
    const api = createNftFloorApi({ identityScope: () => 'account/creator', getAccessToken: async () => 'private-token', fetcher });
    expect(await api.status(collection.toUpperCase().replace('0X', '0x'), creator)).toEqual(status);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(`/api/oneshot/launch/floor/${collection}?wallet=${creator}`, expect.objectContaining({ method: 'GET', headers: { Authorization: 'Bearer private-token' }, credentials: 'omit', redirect: 'error', cache: 'no-store' }));
  });
  it('treats inaccessible, ineligible or legacy collections as absent private UI', async () => {
    const api = createNftFloorApi({ identityScope: () => 'account/creator', getAccessToken: async () => 'token', fetcher: vi.fn().mockResolvedValue(new Response(null, { status: 404 })) });
    expect(await api.status(collection, creator)).toBeNull();
  });
  it('does not request private data without a current session or token', async () => {
    for (const identityScope of [() => null, () => 'account/creator']) {
      const fetcher = vi.fn(), getAccessToken = vi.fn().mockResolvedValue(null);
      const api = createNftFloorApi({ identityScope, getAccessToken, fetcher });
      await expect(api.status(collection, creator)).rejects.toMatchObject({ code: 'IDENTITY_CHANGED' }); expect(fetcher).not.toHaveBeenCalled();
    }
  });
  it('rejects a switched identity before token resolution or after a response', async () => {
    let scope: string | null = 'account/creator';
    const token = deferred<string | null>(), fetcher = vi.fn();
    const before = createNftFloorApi({ identityScope: () => scope, getAccessToken: () => token.promise, fetcher });
    const pendingToken = before.status(collection, creator); scope = 'another/account'; token.resolve('token');
    await expect(pendingToken).rejects.toMatchObject({ code: 'IDENTITY_CHANGED' }); expect(fetcher).not.toHaveBeenCalled();
    scope = 'account/creator'; const response = deferred<Response>();
    const after = createNftFloorApi({ identityScope: () => scope, getAccessToken: async () => 'token', fetcher: vi.fn().mockReturnValue(response.promise) });
    const pendingResponse = after.status(collection, creator); await Promise.resolve(); scope = null; response.resolve(Response.json(status));
    await expect(pendingResponse).rejects.toMatchObject({ code: 'IDENTITY_CHANGED' });
  });
  it('rejects an identity change while parsing private response data', async () => {
    let scope = 'account/creator'; const body = deferred<unknown>(), json = vi.fn().mockReturnValue(body.promise);
    const api = createNftFloorApi({ identityScope: () => scope, getAccessToken: async () => 'token', fetcher: vi.fn().mockResolvedValue({ ok: true, status: 200, json }) });
    const pending = api.status(collection, creator); await vi.waitFor(() => expect(json).toHaveBeenCalled()); scope = 'other/account'; body.resolve(status);
    await expect(pending).rejects.toMatchObject({ code: 'IDENTITY_CHANGED' });
  });
  it.each([
    { creator: collection }, { collection: creator }, { eligible: 'yes' }, { guarded: false }, { enabled: false }, { floorRaw: '0' },
    { floorRaw: '-1' }, { floorRaw: (1n << 256n).toString() }, { policyCommitment: '0x1234' }, { deploymentId: '' },
    { network: { chainId: 1, nativeSymbol: 'ETH', nativeDecimals: 18 } }, { network: { chainId: 31337, nativeSymbol: 'USD', nativeDecimals: 18 } },
  ])('rejects an unbound or invalid private DTO: %j', fields => {
    expect(() => validatePrivateNftFloorStatus({ ...status, ...fields }, collection, creator)).toThrow();
  });
  it('accepts an enabled policy after eligibility removal for disable-only recovery', () => {
    expect(validatePrivateNftFloorStatus({ ...status, eligible: false }, collection, creator)).toMatchObject({ enabled: true, eligible: false });
    expect(() => validatePrivateNftFloorStatus({ ...status, eligible: false, enabled: false, floorRaw: '0' }, collection, creator)).toThrow();
    expect(validatePrivateNftFloorStatus({ ...status, enabled: false, floorRaw: '0' }, collection, creator)).toMatchObject({ enabled: false });
  });
  it('uses exact ETH decimals and a collection-scoped policy request without a draft', () => {
    expect(nftFloorPolicyRequest({ from: creator, collection, enabled: true, price: '0005.000000000000000001', eligible: true })).toEqual({ action: 'policy', from: creator, collection, localEthAcknowledged: true, floorEnabled: true, floorPrice: '5.000000000000000001' });
  });
  it.each(['0', '-1', '1e3', ' 5 ', '0.0000000000000000001', (1n << 256n).toString()])('does not round, clamp or accept invalid enabled floor %s', price => {
    expect(() => nftFloorPolicyRequest({ from: creator, collection, enabled: true, price, eligible: true })).toThrow();
  });
  it('allows an ineligible creator only to disable and explicitly clears the floor', () => {
    expect(nftFloorPolicyRequest({ from: creator, collection, enabled: false, price: 'old or invalid input', eligible: false })).toMatchObject({ floorEnabled: false, floorPrice: '0' });
    expect(() => nftFloorPolicyRequest({ from: creator, collection, enabled: true, price: '5', eligible: false })).toThrow(/only disable/);
  });
});
