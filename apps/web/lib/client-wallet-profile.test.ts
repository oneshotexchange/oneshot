import { describe, it, expect, vi } from 'vitest';
import { createOneshotAccountApi } from './client-oneshot-api';
import { assertProfileAssetPage, profileAssetPath, readWalletProfile } from './client-wallet-profile';
import { accountWalletProfileSchema, emptyWalletProfile, publicWalletProfileResponseSchema, walletProfileHref } from './wallet-profile';
import type { AccountWalletProfile } from './wallet-profile';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProfileIdentity } from '../components/wallet-profile';
import { nftNetworkForChainId, type IndexedCollection, type IndexedPage } from '@oneshot/evm';

const wallet = '0x1111111111111111111111111111111111111111', other = '0x2222222222222222222222222222222222222222';
const details = { ...emptyWalletProfile(), displayName: 'Nebula studio', bio: '<script>not markup</script>' };
const initial: AccountWalletProfile = { wallet, revision: 0, draft: emptyWalletProfile(), published: null, updatedAt: null };
const saved: AccountWalletProfile = { wallet, revision: 1, draft: details, published: null, updatedAt: '2026-11-19T00:00:00.000Z' };
const json = (body: unknown, status = 200) => Response.json(body, { status });
describe('public wallet profiles', () => {
  it('normalizes wallet links and preserves an explicit NFT deployment', () => {
    expect(walletProfileHref(wallet.toUpperCase(), 'd'.repeat(64))).toBe(`/profile/${wallet}?deployment=${'d'.repeat(64)}`);
    for (const input of ['', '0x' + '0'.repeat(40), 'https://example.com']) expect(() => walletProfileHref(input)).toThrow('wallet');
    expect(profileAssetPath(wallet, 'created')).toContain(`creator=${wallet}`);
    expect(profileAssetPath(wallet, 'collected')).toContain(`/wallets/${wallet}/items`);
  });
  it('omits credentials on public reads and validates the exact requested wallet', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json({ wallet, profile: null }));
    expect(await readWalletProfile(wallet, undefined, fetcher)).toEqual({ wallet, profile: null });
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ credentials: 'omit', redirect: 'error', cache: 'no-store' });
    await expect(readWalletProfile(wallet, undefined, async () => json({ wallet: other, profile: null }))).rejects.toThrow('verified');
    expect(publicWalletProfileResponseSchema.safeParse({ wallet, profile: null, ownerUserId: 'secret' }).success).toBe(false);
  });
  it('distinguishes failed/unreadable loads from no published details and honors cancellation', async () => {
    await expect(readWalletProfile(wallet, undefined, async () => { throw new Error('private transport'); })).rejects.toThrow('Could not connect');
    await expect(readWalletProfile(wallet, undefined, async () => new Response('broken'))).rejects.toThrow('response');
    await expect(readWalletProfile(wallet, undefined, async () => json({ error: { message: 'Try later.' } }, 503))).rejects.toThrow('Try later');
    const controller = new AbortController();
    await expect(readWalletProfile(wallet, controller.signal, async () => { controller.abort(); return json({ wallet, profile: null }); })).rejects.toThrow();
  });
  it('renders profile text as text, keeps the wallet visible and marks an external website', () => {
    const rendered = renderToStaticMarkup(createElement(ProfileIdentity, { wallet, details: { ...details, website: 'https://example.com' } }));
    expect(rendered).toContain(wallet); expect(rendered).toContain('&lt;script&gt;'); expect(rendered).not.toContain('<script>');
    expect(rendered).toContain('Self-reported website'); expect(rendered).toContain('noopener noreferrer');
  });
});
describe('profile account requests', () => {
  function account(fetcher: typeof fetch, scope = () => 'alice:wallet') { return createOneshotAccountApi({ fetcher, identityScope: scope, getAccessToken: async () => 'fresh' }); }
  it('uses a fresh bearer and explicit revision; saving cannot silently publish', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json(saved));
    expect(await account(fetcher).changeWalletProfile('save', initial, details)).toEqual(saved);
    const init = fetcher.mock.calls[0]?.[1];
    expect(init?.method).toBe('PUT'); expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fresh');
    expect(JSON.parse(String(init?.body))).toEqual({ wallet, expectedRevision: 0, profile: details });
    await expect(account(async () => json({ ...saved, revision: 2 })).changeWalletProfile('save', initial, details)).rejects.toThrow('verified');
    await expect(account(async () => json({ ...saved, draft: { ...details, bio: 'wrong' } })).changeWalletProfile('save', initial, details)).rejects.toThrow('verified');
  });
  it('checks publication content, unpublishing and private read response schemas', async () => {
    const published = { ...saved, revision: 2, published: { ...details, wallet, publishedAt: '2026-11-19T00:00:00.000Z' } };
    expect((await account(async () => json(published)).changeWalletProfile('publish', saved)).published).toMatchObject(details);
    await expect(account(async () => json({ ...published, published: { ...published.published, bio: 'wrong' } })).changeWalletProfile('publish', saved)).rejects.toThrow('verified');
    expect((await account(async () => json({ ...published, revision: 3, published: null })).changeWalletProfile('unpublish', published)).published).toBeNull();
    await expect(account(async () => json({ ...saved, wallet: other })).getWalletProfile(wallet)).rejects.toThrow('verified');
    expect(accountWalletProfileSchema.safeParse({ ...initial, published: published.published }).success).toBe(false);
  });
  it('rejects a late result after account change and does not write after token acquisition changes identity', async () => {
    let scope = 'alice'; const fetcher = vi.fn(async () => { scope = 'bob'; return json(saved); });
    await expect(account(fetcher, () => scope).changeWalletProfile('save', initial, details)).rejects.toThrow('account or wallet changed');
    scope = 'alice'; const tokenFetch = vi.fn(async () => json(saved));
    const api = createOneshotAccountApi({ identityScope: () => scope, getAccessToken: async () => { scope = 'bob'; return 'fresh'; }, fetcher: tokenFetch });
    await expect(api.getWalletProfile(wallet)).rejects.toThrow('account or wallet changed'); expect(tokenFetch).not.toHaveBeenCalled();
  });
});

describe('wallet attribution in public NFT tabs', () => {
  const context = { enabled: true, available: true, reason: null, deploymentId: 'd'.repeat(64), network: nftNetworkForChainId(84532), checkpoint: { number: '10', hash: `0x${'a'.repeat(64)}`, timestamp: '1700000010' }, readonly: true as const, finalized: false as const };
  const collection: IndexedCollection = { address: other, creator: wallet, name: 'Originals', symbol: 'ART', configured: true, opened: true, termsHash: `0x${'b'.repeat(64)}`, contentHash: `0x${'c'.repeat(64)}`, totalMinted: '2', primaryTotalPriceRaw: '0', primaryPlatformFeeRaw: '0', primaryCreatorProceedsRaw: '0', totalClaimedRaw: '0' };
  const page = <T,>(items: T[]): IndexedPage<T> => ({ context, items, nextCursor: null });
  it('accepts only this creator and refuses duplicate or unscoped records', () => {
    expect(assertProfileAssetPage(page([collection]), wallet, 'created').items).toHaveLength(1);
    expect(() => assertProfileAssetPage(page([{ ...collection, creator: other }]), wallet, 'created')).toThrow('verified');
    expect(() => assertProfileAssetPage(page([collection, collection]), wallet, 'created')).toThrow('verified');
    expect(() => assertProfileAssetPage({ ...page([collection]), context: { ...context, available: false } }, wallet, 'created')).toThrow('verified');
  });
  it('distinguishes direct custody, seller listings and unrelated activity', () => {
    const item = { id: `${other}:1`, collection: other, tokenId: '1', owner: wallet, burned: false, listing: null };
    expect(assertProfileAssetPage(page([item]), wallet, 'collected').items).toHaveLength(1);
    expect(() => assertProfileAssetPage(page([{ ...item, owner: other }]), wallet, 'collected')).toThrow('verified');
    const listing = { id: '1', collection: other, tokenId: '1', seller: wallet, totalPriceRaw: '9007199254740993123456789', status: 'active' as const, buyer: null, recipient: null, platformFeeRaw: null, royaltyRaw: null, sellerProceedsRaw: null };
    expect(assertProfileAssetPage(page([listing]), wallet, 'listings').items).toHaveLength(1);
    expect(() => assertProfileAssetPage(page([{ ...listing, seller: other }]), wallet, 'listings')).toThrow('verified');
    const activity = { id: 'event', eventName: 'Transfer', source: other, collection: other, transactionHash: `0x${'b'.repeat(64)}`, blockNumber: '10', logIndex: 1, timestamp: '2026-11-19T00:00:00.000Z', args: { from: wallet, to: other } };
    expect(assertProfileAssetPage(page([activity]), wallet, 'activity').items).toHaveLength(1);
    expect(() => assertProfileAssetPage(page([{ ...activity, args: { from: other } }]), wallet, 'activity')).toThrow('verified');
    expect(() => assertProfileAssetPage(page([{ ...activity, blockNumber: '11' }]), wallet, 'activity')).toThrow('verified');
    expect(() => assertProfileAssetPage(page([{ ...activity, logIndex: -1 }]), wallet, 'activity')).toThrow('verified');
  });
});
