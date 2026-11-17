import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { NftCheckoutWalletGuidance, ReviewResult } from '../components/nft-checkout';
import { nftCheckoutAccess } from './client-nft-checkout-access';
import type { NftLaunchState, PublicNftCollection } from './client-nft-launch';

vi.mock('../components/wallet-button', () => ({ WalletButton: () => createElement('button', null, 'Connect fixture wallet') }));
const collection = `0x${'1'.repeat(40)}`, sender = `0x${'2'.repeat(40)}`, deployment = 'a'.repeat(64);
const details = (): PublicNftCollection => ({
  collection, creator: sender, name: 'Originals', symbol: 'SHOT', network: { chainId: 31337, nativeSymbol: 'ETH', nativeDecimals: 18 },
  deploymentId: deployment, opened: true, totalMintedRaw: '1', termsHash: `0x${'3'.repeat(64)}`,
  blockNumber: '10', blockHash: `0x${'4'.repeat(64)}`, blockTimestamp: '1900000000',
  terms: { maxSupplyRaw: '10', royaltyBps: 500, allowlistRoot: `0x${'0'.repeat(64)}`, contentHash: `0x${'5'.repeat(64)}`, metadataBaseURI: 'https://example.test/metadata/', collectionURI: 'https://example.test/collection',
    allowlist: { start: '0', end: '0', walletLimitRaw: '0', priceRaw: '0' }, publicMint: { start: '1800000000', end: '2000000000', walletLimitRaw: '2', priceRaw: '1' } },
});
const input = () => ({ details: details() as PublicNftCollection | null, collection, indexedDeploymentId: deployment, loading: false, error: null as string | null,
  authenticated: true, connected: true, identityScope: 'linked-owner', chainId: 31337 as number | null });
const pending: NftLaunchState = {
  phase: 'submitted', hash: `0x${'6'.repeat(64)}`, receipt: { status: 'pending' }, message: 'Your transaction is pending.',
  review: { id: 'review', reviewHash: `0x${'7'.repeat(64)}`, chainId: 31337, from: sender, to: collection, data: '0x1234', value: '1', action: 'mint',
    expiresAt: '2026-12-01T00:00:00Z', network: { chainId: 31337, nativeSymbol: 'ETH', nativeDecimals: 18 }, summary: {}, deploymentId: deployment, draftId: collection, revision: 0,
    simulation: { blockNumber: '10', blockHash: `0x${'8'.repeat(64)}`, gasEstimate: '20000' } },
};

describe('public checkout availability before wallet setup', () => {
  it.each([
    { loading: true }, { error: 'This service is temporarily unavailable.' }, { details: null },
    { indexedDeploymentId: 'b'.repeat(64) }, { collection: `0x${'9'.repeat(40)}` },
    { details: { ...details(), opened: false } },
  ])('suppresses connection/network guidance and new review readiness for unavailable terms: %j', changes => {
    for (const identity of [{ authenticated: false, connected: false, identityScope: null, chainId: null }, { authenticated: true, connected: true, identityScope: 'owner', chainId: 1 }]) {
      const access = nftCheckoutAccess({ ...input(), ...identity, ...changes });
      expect(access).toMatchObject({ available: false, needsWallet: false, needsNetwork: false, ready: false });
      const html = renderToStaticMarkup(createElement(NftCheckoutWalletGuidance, { access }));
      expect(html).toBe('');
    }
  });

  it('offers a wallet only for valid matching opened terms, including a signed-in account with no linked wallet', () => {
    for (const authenticated of [false, true]) {
      const access = nftCheckoutAccess({ ...input(), authenticated, connected: false, identityScope: null, chainId: null });
      expect(access).toMatchObject({ available: true, needsWallet: true, needsNetwork: false, ready: false });
      const html = renderToStaticMarkup(createElement(NftCheckoutWalletGuidance, { access }));
      expect(html).toContain('Connect fixture wallet'); expect(html).toContain('Connect a wallet to continue.');
      expect(html).not.toContain('Switch your wallet');
    }
  });

  it('offers the supported network only after an authenticated connected wallet and verified available terms', () => {
    const access = nftCheckoutAccess({ ...input(), chainId: 1 });
    expect(access).toMatchObject({ available: true, needsWallet: false, needsNetwork: true, ready: false });
    const html = renderToStaticMarkup(createElement(NftCheckoutWalletGuidance, { access, network: details().network }));
    expect(html).toContain('Switch your wallet to Local test network (31337)'); expect(html).not.toContain('Connect fixture wallet');
  });

  it('permits review only for a matching opened collection and the current linked wallet on the correct network', () => {
    expect(nftCheckoutAccess(input())).toEqual({ available: true, matchingDeployment: true, needsWallet: false, needsNetwork: false, ready: true });
    expect(nftCheckoutAccess({ ...input(), identityScope: null }).ready).toBe(false);
    expect(nftCheckoutAccess({ ...input(), collection: collection.toUpperCase() }).ready).toBe(true);
  });

  it('pauses readiness during a refresh/error without losing the saved collection identity needed by an existing receipt', () => {
    const value = input();
    for (const changes of [{ loading: true }, { error: 'Refresh failed' }]) {
      const access = nftCheckoutAccess({ ...value, ...changes });
      expect(access).toMatchObject({ matchingDeployment: true, available: false, ready: false });
      const html = renderToStaticMarkup(createElement(Fragment, null,
        createElement(NftCheckoutWalletGuidance, { access }),
        createElement(ReviewResult, { state: pending, canApprove: access.ready, onCheck: vi.fn() }),
      ));
      expect(html).toContain(pending.hash); expect(html).toContain('Check receipt');
      expect(html).not.toContain('Approve in wallet'); expect(html).not.toContain('Connect fixture wallet');
    }
  });

  it('retains unsigned review details while suppressing wallet approval until collection availability returns', () => {
    const unsigned: NftLaunchState = { ...pending, phase: 'review', hash: null, receipt: null, message: null };
    const blocked = renderToStaticMarkup(createElement(ReviewResult, { state: unsigned, onCheck: vi.fn() }));
    expect(blocked).toContain('Transaction review'); expect(blocked).not.toContain('Approve in wallet');
    const ready = renderToStaticMarkup(createElement(ReviewResult, { state: unsigned, canApprove: true, onApprove: vi.fn(), onCheck: vi.fn() }));
    expect(ready).toContain('Approve in wallet');
  });
});
