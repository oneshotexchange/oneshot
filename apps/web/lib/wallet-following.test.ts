import { describe, it, expect, vi } from 'vitest';
import { decodeFollowedWallets, encodeFollowedWallets, emptyWalletFollowing, walletFollowingSchema } from './wallet-following';
import { createOneshotAccountApi } from './client-oneshot-api';
import { assertFollowingActivity, ActivityFeedResults } from '../components/wallet-following';
import { nftNetworkForChainId } from '@oneshot/evm';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const wallet = '0x1111111111111111111111111111111111111111', other = '0x2222222222222222222222222222222222222222';
const response = (value: unknown) => Response.json(value);
describe('followed wallet selection and requests', () => {
  it('encodes one canonical bounded wallet set and rejects ambiguous or malformed selections', () => {
    expect(decodeFollowedWallets(encodeFollowedWallets([other, wallet, wallet]))).toEqual([wallet, other]);
    const maximum = Array.from({ length: 50 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}`);
    expect(decodeFollowedWallets(encodeFollowedWallets(maximum))).toEqual(maximum);
    for (const value of ['', '%%%', btoa(JSON.stringify([])), btoa(JSON.stringify([other, wallet])).replace(/=+$/, ''), btoa(JSON.stringify([wallet, wallet])).replace(/=+$/, '')]) expect(() => decodeFollowedWallets(value)).toThrow();
    expect(() => encodeFollowedWallets(Array.from({ length: 51 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}`))).toThrow('50');
    expect(walletFollowingSchema.safeParse({ revision: 0, wallets: [wallet], updatedAt: null }).success).toBe(false);
  });
  it('binds follow mutations to the reviewed revision and exact next list', async () => {
    const next = { revision: 1, wallets: [wallet], updatedAt: '2026-11-19T00:00:00.000Z' }, fetcher = vi.fn<typeof fetch>(async () => response(next));
    const api = createOneshotAccountApi({ getAccessToken: async () => 'fresh', identityScope: () => 'alice', fetcher });
    expect(await api.changeWalletFollowing(emptyWalletFollowing(), wallet, true)).toEqual(next);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({ wallet, following: true, expectedRevision: 0 });
    const invalid = createOneshotAccountApi({ getAccessToken: async () => 'fresh', identityScope: () => 'alice', fetcher: async () => response({ ...next, wallets: [other] }) });
    await expect(invalid.changeWalletFollowing(emptyWalletFollowing(), wallet, true)).rejects.toThrow('verified');
  });
  it('does not show another account’s late following response or treat unreadable data as empty', async () => {
    let scope = 'alice';
    const api = createOneshotAccountApi({ getAccessToken: async () => 'fresh', identityScope: () => scope, fetcher: async () => { scope = 'bob'; return response(emptyWalletFollowing()); } });
    await expect(api.getWalletFollowing()).rejects.toThrow('account or wallet changed');
    const broken = createOneshotAccountApi({ getAccessToken: async () => 'fresh', identityScope: () => 'alice', fetcher: async () => response({ wallets: [] }) });
    await expect(broken.getWalletFollowing()).rejects.toThrow('verified');
  });
});
describe('canonical following feed presentation', () => {
  const context = { enabled: true, available: true, reason: null, deploymentId: 'd'.repeat(64), network: nftNetworkForChainId(84532), checkpoint: { number: '10', hash: `0x${'a'.repeat(64)}`, timestamp: '1700000010' }, readonly: true as const, finalized: false as const };
  const event = { id: 'one', eventName: 'Transfer', source: other, collection: other, transactionHash: `0x${'b'.repeat(64)}`, blockNumber: '10', logIndex: 1, timestamp: '2026-11-19T00:00:00.000Z', args: { from: other, to: wallet } };
  const page = { context, items: [event], nextCursor: null };
  it('accepts shared-wallet events once and rejects unrelated, duplicate and unanchored data', () => {
    expect(assertFollowingActivity(page, [wallet, other]).items).toHaveLength(1);
    expect(() => assertFollowingActivity({ ...page, items: [event, event] }, [wallet])).toThrow('verified');
    expect(() => assertFollowingActivity(page, ['0x3333333333333333333333333333333333333333'])).toThrow('verified');
    expect(() => assertFollowingActivity({ ...page, items: [], context: { ...context, checkpoint: null } }, [wallet])).toThrow('verified');
  });
  it('distinguishes failed, unavailable and genuinely empty feeds with recovery actions', () => {
    const base = { loading: false, loadingMore: false, notice: null, refresh: () => {}, loadMore: () => {} };
    const render = (data: typeof page | null, error: string | null) => renderToStaticMarkup(createElement(ActivityFeedResults, { page: { ...base, data, error } }));
    expect(render(null, 'Could not connect. Try again.')).not.toContain('No NFT activity');
    expect(render({ ...page, items: [] }, null)).toContain('No NFT activity at this checkpoint');
    expect(render({ ...page, items: [], context: { ...context, available: false } }, null)).toContain('Activity is unavailable');
  });
});
