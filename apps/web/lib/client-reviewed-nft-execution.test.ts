import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { canonicalReviewedNftValue, createReviewedNftPendingStore, type ReviewedNftPendingReference } from './client-reviewed-nft-execution';
import { ReviewedNftExecutionGuidance, ReviewedNftTransactions } from '../components/reviewed-nft-transactions';

const mockWallet = {
  configured: true, authenticated: true, connected: true, isLoading: false, unavailableReason: null,
  userId: 'did:privy:alice', account: { address: `0x${'1'.repeat(40)}`, chainId: 84532 },
  accounts: [], network: { chainId: 84532, name: 'Base Sepolia' },
  identityScope: () => 'did:privy:alice/base', getAccessToken: async () => 'token',
  connect: async () => {}, connectX: async () => {}, disconnect: async () => {}, linkWallet: async () => {},
  selectWallet: () => {}, sendEvmTransaction: async () => `0x${'a'.repeat(64)}`,
};
vi.mock('./client-wallet', () => ({ useWallet: () => mockWallet }));

const now = Date.parse('2026-11-20T12:00:00.000Z');
const reference = (): ReviewedNftPendingReference => ({ reviewId: '00000000-0000-4000-8000-000000000001', hash: `0x${'a'.repeat(64)}`, from: `0x${'1'.repeat(40)}`, deploymentId: 'b'.repeat(64), chainId: 84532, createdAt: new Date(now).toISOString() });
function memory() { const values = new Map<string, string>(); return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } }; }

describe('reviewed NFT recovery references', () => {
  it('keeps only safe identifiers in an account-specific key and scopes reads to wallet/network/deployment', () => {
    const storage = memory(), pending = createReviewedNftPendingStore(storage, () => now), item = reference();
    expect(pending.remember('did:privy:alice', item)).toBe(true);
    expect(pending.list('did:privy:alice', { from: item.from, chainId: 84532, deploymentId: item.deploymentId })).toEqual([item]);
    expect(pending.list('did:privy:bob')).toEqual([]); expect(pending.list('did:privy:alice', { chainId: 31337 })).toEqual([]);
    expect([...storage.values.keys()][0]).not.toContain('alice');
    expect([...storage.values.values()][0]).not.toMatch(/reviewHash|calldata|bearer|did:privy/);
    expect(pending.remember('did:privy:alice', { ...item, reviewToken: 'private' } as ReviewedNftPendingReference)).toBe(false);
  });
  it('does not expire pending references when signing reviews age out and does not mix terminal removal across accounts', () => {
    const storage = memory(), old = createReviewedNftPendingStore(storage, () => now); old.remember('alice', reference()); old.remember('bob', reference());
    const later = createReviewedNftPendingStore(storage, () => now + 365 * 86_400_000);
    expect(later.list('alice')).toHaveLength(1); expect(later.forget('bob', reference().reviewId)).toBe(true); expect(later.list('alice')).toHaveLength(1); expect(later.list('bob')).toEqual([]);
  });
  it('never silently changes the transaction bound to a saved review or assigns one hash to another review', () => {
    const pending = createReviewedNftPendingStore(memory(), () => now), item = reference(); pending.remember('alice', item);
    expect(pending.remember('alice', { ...item, hash: `0x${'c'.repeat(64)}` })).toBe(false);
    expect(pending.remember('alice', { ...item, reviewId: '00000000-0000-4000-8000-000000000002' })).toBe(false);
    expect(pending.list('alice')).toEqual([item]);
  });
  it('preserves malformed storage and reports unavailable reads/writes without claiming a save', () => {
    const storage = memory(), pending = createReviewedNftPendingStore(storage, () => now); pending.remember('alice', reference()); const key = [...storage.values.keys()][0];
    for (const raw of ['{', '[]', '{"version":1,"references":[{"reviewToken":"private"}]}']) {
      storage.values.set(key, raw); expect(pending.remember('alice', reference())).toBe(false); expect(storage.values.get(key)).toBe(raw); expect(pending.warning()).toContain('could not be saved');
    }
    expect(createReviewedNftPendingStore(null, () => now).remember('alice', reference())).toBe(false);
    const denied = createReviewedNftPendingStore({ getItem: () => null, setItem: () => { throw new Error('private'); } }, () => now);
    expect(denied.remember('alice', reference())).toBe(false); expect(denied.warning()).not.toContain('private');
  });
  it('does not overwrite another tab’s changed references during an update', () => {
    const storage = memory(); let calls = 0;
    const pending = createReviewedNftPendingStore({ ...storage, getItem: key => { calls++; if (calls === 2) storage.values.set(key, '{"changed":true}'); return storage.getItem(key); } }, () => now);
    expect(pending.remember('alice', reference())).toBe(false); expect([...storage.values.values()]).toEqual(['{"changed":true}']);
  });
});

describe('immutable reviewed value comparison', () => {
  it('compares reordered nested review fields without ignoring changed transaction values', () => {
    const first = { network: { chainId: 84532, mode: 'base-sepolia' }, simulation: { gas: '100', block: '1' }, values: ['0', '1'] };
    const reordered = { values: ['0', '1'], simulation: { block: '1', gas: '100' }, network: { mode: 'base-sepolia', chainId: 84532 } };
    expect(canonicalReviewedNftValue(first)).toBe(canonicalReviewedNftValue(reordered));
    expect(canonicalReviewedNftValue(first)).not.toBe(canonicalReviewedNftValue({ ...reordered, values: ['1', '0'] }));
  });
});

describe('reviewed NFT transaction widget integration', () => {
  it('restricts burned NFTs to payout claims and preserves saved transaction recovery when unavailable', () => {
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ReviewedNftTransactions, {
      collection: `0x${'2'.repeat(40)}`, tokenId: '0', listing: null, burned: true, deploymentId: 'b'.repeat(64), onRefresh: () => {},
    })));
    expect(html).toContain('Manage this NFT');
    expect(html).toContain('This NFT has been burned');
    expect(html).toContain('Claim payouts');
    expect(html).not.toContain('List NFT');
    expect(html).toContain('Check a saved transaction');

    const unavailableHtml = renderToStaticMarkup(createElement(ReviewedNftExecutionGuidance, {
      access: 'unavailable', action: 'buy', onRefresh: () => {},
    }));
    expect(unavailableHtml).toContain('Listing and buying are currently unavailable');
    expect(unavailableHtml).toContain('Refresh availability');
  });
});
