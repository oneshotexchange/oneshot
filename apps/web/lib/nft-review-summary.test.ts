import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { IndexedNftContext } from '@oneshot/evm';
import { NftReviewSummary, NftTransactionData, nftTransactionPhase } from '../components/nft-review-summary';
import { IndexedActivityHighlights, IndexedActivityPage, IndexedCollectionHighlights, IndexedPortfolioPage } from '../components/indexed-nfts';
import { Overview } from '../components/overview';
import { useIndexedPage } from './client-indexed-api';
import { useApi } from './client-api';
import { NftCheckout, NftTransactionRecovery, ReviewResult } from '../components/nft-checkout';
import type { NftLaunchState } from './client-nft-launch';

const { pages, recoveryWallet } = vi.hoisted(() => ({ pages: new Map<string | null, unknown>(), recoveryWallet: { current: null as unknown } }));
vi.mock('./client-wallet', async original => ({
  ...await original<typeof import('./client-wallet')>(),
  useWallet: vi.fn(() => recoveryWallet.current),
}));
vi.mock('./client-indexed-api', async original => ({
  ...await original<typeof import('./client-indexed-api')>(),
  useIndexedPage: vi.fn((path: string | null) => pages.get(path)),
}));
vi.mock('./client-api', async original => ({
  ...await original<typeof import('./client-api')>(),
  useApi: vi.fn(() => ({ data: { items: [] }, loading: false, error: null, refresh: vi.fn() })),
}));

const render = (node: React.ReactNode) => renderToStaticMarkup(createElement(MemoryRouter, null, node));
const address = `0x${'1'.repeat(40)}`, recipient = `0x${'2'.repeat(40)}`, deployment = 'd'.repeat(64);
const context = (available = true): IndexedNftContext => ({ enabled: true, available, reason: null, deploymentId: deployment,
  network: { mode: 'local', name: 'Local Anvil', chainId: 31337, nativeSymbol: 'ETH', nativeDecimals: 18 },
  checkpoint: { number: '7', hash: `0x${'a'.repeat(64)}`, timestamp: '1' }, readonly: true, finalized: false });
const page = (items: unknown[], available = true) => ({ data: { context: context(available), items, nextCursor: 'next-page' }, loading: false, loadingMore: false, error: null, notice: null, refresh: vi.fn(), loadMore: vi.fn() });

describe('customer transaction summaries', () => {
  it('preserves exact amounts, payout addresses, fees and percentage royalties without internal commitments', () => {
    const html = render(createElement(NftReviewSummary, { action: 'buy', summary: {
      recipient, seller: address, tokenId: '9007199254740993', royaltyBps: '75', priceRaw: '900719925474099312345678901234567890',
      platformFeeRaw: '1', royaltyRaw: '2', sellerProceedsRaw: '900719925474099312345678901234567887',
      termsHash: 'INTERNAL_TERMS', contentHash: 'INTERNAL_CONTENT', policyCommitment: 'INTERNAL_POLICY', previousCommitment: 'INTERNAL_PREVIOUS',
    } }));
    expect(html).toContain(recipient); expect(html).toContain(address); expect(html).toContain('9007199254740993');
    expect(html).toContain('900719925474099312.34567890123456789 ETH');
    expect(html).toContain('0.000000000000000001 ETH'); expect(html).toContain('0.000000000000000002 ETH');
    expect(html).toContain('0.75%'); expect(html).not.toContain('basis points'); expect(html).not.toContain('INTERNAL_');
    expect(html).toContain('sends the NFT to the recipient shown');
  });

  it('explains the individual NFT approval and retains the approved marketplace address', () => {
    const html = render(createElement(NftReviewSummary, { action: 'approve', summary: { tokenId: '42', approvedSpender: address } }));
    expect(html).toContain('Approved marketplace'); expect(html).toContain(address);
    expect(html).toContain('transfer this NFT'); expect(html).toContain('requires a separate transaction');
  });

  it('keeps exact contract call data available for wallet comparison', () => {
    const data = '0x12340000';
    const html = render(createElement(NftTransactionData, { data }));
    expect(html).toContain('<summary>Transaction data</summary>'); expect(html).toContain(data);
    expect(html).not.toMatch(/deploymentId|reviewHash|simulation/);
  });

  it('keeps sender, destination, value, test network and receipt visible in checkout review', () => {
    const hash = `0x${'b'.repeat(64)}`;
    const state: NftLaunchState = { phase: 'review', hash, receipt: null, message: null, review: {
      id: 'review', reviewHash: 'internal-review-hash', expiresAt: '2026-10-30T12:00:00Z', chainId: 31337,
      from: address, to: recipient, data: '0x1234', value: '1', action: 'buy', network: { chainId: 31337, nativeSymbol: 'ETH', nativeDecimals: 18 },
      summary: { recipient, priceRaw: '1' }, deploymentId: 'internal-deployment-id', draftId: address, revision: 0,
      simulation: { blockNumber: '7', blockHash: 'internal-block-hash', gasEstimate: '22000' },
    } };
    const html = render(createElement(ReviewResult, { state, onCheck() {}, onApprove() {}, canApprove: true }));
    expect(html).toContain(address); expect(html).toContain(recipient); expect(html).toContain(hash);
    expect(html).toContain('0.000000000000000001 ETH'); expect(html).toContain('Test network (31337)');
    expect(html).toContain('22000 gas units'); expect(html).toContain('0x1234'); expect(html).toContain('Approve in wallet');
    expect(html).not.toContain('internal-review-hash'); expect(html).not.toContain('internal-deployment-id'); expect(html).not.toContain('internal-block-hash');
  });

  it('offers a wallet connection instead of an inert load action when signed in without a wallet', () => {
    recoveryWallet.current = { authenticated: true, configured: true, connected: false, account: null, userId: 'owner',
      wallets: [], network: null, isLoading: false, identityScope: () => null, getAccessToken: async () => null };
    const html = render(createElement(NftTransactionRecovery));
    expect(html).toContain('Connect a wallet to check its saved transactions.');
    expect(html).not.toContain('Load saved transactions');
  });

  it('offers a wallet action before network guidance to a signed-in collector without a wallet', () => {
    recoveryWallet.current = { authenticated: true, configured: true, connected: false, account: null, userId: 'owner',
      wallets: [], network: null, isLoading: false, identityScope: () => null, getAccessToken: async () => null };
    const html = render(createElement(NftCheckout, { collection: address }));
    expect(html).toContain('Add a wallet');
    expect(html).toContain('Connect a wallet to continue.');
    expect(html).not.toContain('Switch your wallet to the test network');
    expect(html).not.toContain('Review transaction');
  });

  it('presents transaction states as customer actions and outcomes', () => {
    expect(nftTransactionPhase('review')).toBe('Ready for approval');
    expect(nftTransactionPhase('success')).toBe('Confirmed');
    expect(nftTransactionPhase('invalidated')).toBe('New review needed');
  });
});

describe('home page NFT records', () => {
  beforeEach(() => { pages.clear(); vi.clearAllMocks(); pages.set('/api/oneshot/indexed/activity', page([])); });

  it('uses the routed activity source and shows its real test network records', () => {
    pages.set('/api/oneshot/indexed/activity', page([{ id: 'sale', eventName: 'Sold', collection: address, source: address,
      transactionHash: `0x${'c'.repeat(64)}`, blockNumber: '7', logIndex: 1, timestamp: '2026-10-29T00:00:00Z', args: { tokenId: '4', totalPrice: '1' } }]));
    const html = render(createElement(Overview));
    expect(useIndexedPage).toHaveBeenCalledWith('/api/oneshot/indexed/activity', expect.any(Function));
    expect(useApi).not.toHaveBeenCalledWith('/api/collections'); expect(useApi).not.toHaveBeenCalledWith('/api/activity');
    expect(html).toContain('NFT sold'); expect(html).toContain('0.000000000000000001 ETH'); expect(html).toContain('Test network');
    expect(html).not.toContain('No NFT activity yet'); expect(html).not.toContain('Zero community');
  });

  it('uses the routed collections source and binds collection links to the network instance', () => {
    pages.set('/api/oneshot/indexed/collections', page([{ address, creator: recipient, name: 'Collector originals', symbol: 'SHOT',
      configured: true, opened: true, termsHash: null, contentHash: null, totalMinted: '12', primaryTotalPriceRaw: '0',
      primaryPlatformFeeRaw: '0', primaryCreatorProceedsRaw: '0', totalClaimedRaw: '0' }]));
    const html = render(createElement(IndexedCollectionHighlights));
    expect(useIndexedPage).toHaveBeenCalledWith('/api/oneshot/indexed/collections', expect.any(Function));
    expect(html).toContain('Collector originals'); expect(html).toContain(`href="/nfts/${address}?deployment=${deployment}"`);
    expect(html).toContain('Test network'); expect(html).not.toContain('No collections yet'); expect(html).not.toContain('Load more');
  });

  it('distinguishes unavailable browsing from an empty market and offers a retry', () => {
    pages.set('/api/oneshot/indexed/collections', page([], false));
    const html = render(createElement(IndexedCollectionHighlights));
    expect(html).toContain('NFT browsing is unavailable'); expect(html).toContain('Try again');
    expect(html).not.toContain('No collections yet');
  });

  it('does not invent a test network label before a network context is returned', () => {
    pages.set('/api/oneshot/indexed/activity', { ...page([]), data: null, loading: true });
    const html = render(createElement(IndexedActivityHighlights));
    expect(html).toContain('Loading'); expect(html).not.toContain('Test network'); expect(html).not.toContain('No NFT activity yet');
  });
});

describe('deployment-bound activity and portfolio navigation', () => {
  beforeEach(() => {
    pages.clear(); vi.clearAllMocks(); pages.set(null, page([]));
    recoveryWallet.current = { authenticated: true, authenticationReady: true, configured: true, connected: true,
      account: { address: recipient }, userId: 'owner', wallets: [], network: { chainId: 31337, name: 'Test network' },
      isLoading: false, identityScope: () => 'owner-wallet', getAccessToken: async () => null };
  });

  it('keeps global activity links on the deployment that supplied the event', () => {
    const activity = { id: 'sale', eventName: 'Sold', collection: address, source: address,
      transactionHash: `0x${'c'.repeat(64)}`, blockNumber: '7', logIndex: 1, timestamp: '2026-10-29T00:00:00Z', args: { tokenId: '4', totalPrice: '1' } };
    const source = page([activity]); pages.set('/api/oneshot/indexed/activity', source);
    const html = render(createElement(IndexedActivityPage));
    expect(html).toContain(`href="/nfts/${address}?deployment=${deployment}"`);
    expect(html).not.toContain(`href="/nfts/${address}"`);

    const replacement = 'e'.repeat(64);
    pages.set('/api/oneshot/indexed/activity', { ...source, data: { ...source.data, context: { ...source.data.context, deploymentId: replacement } } });
    const refreshed = render(createElement(IndexedActivityPage));
    expect(refreshed).toContain(`href="/nfts/${address}?deployment=${replacement}"`);
    expect(refreshed).not.toContain(`?deployment=${deployment}`);
  });

  it('keeps owned portfolio item links on the deployment that supplied the ownership record', () => {
    pages.set(`/api/oneshot/indexed/wallets/${recipient}/items`, page([{ id: `${address}:4`, collection: address, tokenId: '4', owner: recipient, burned: false, listing: null }]));
    const html = render(createElement(IndexedPortfolioPage));
    expect(html).toContain(`href="/nfts/${address}/4?deployment=${deployment}"`);
    expect(html).not.toContain(`href="/nfts/${address}/4"`);
  });
});
