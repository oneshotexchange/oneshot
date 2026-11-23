import { describe, expect, it, vi } from 'vitest';
import { nftNetworkForChainId } from '@oneshot/evm';
import { nftExplorerHref, nftNetworkLabel, nftTestAcknowledgement, readNftNetwork, validNftTestAcknowledgement, nativeAssetLabel, draftCanLaunchOnNetwork, draftPriceUnit, draftPricingNetworkLabel } from './nft-network';
import { createNftLaunchController, sendReviewedEvmTransaction, validateNftLaunchStatus, type EvmWalletTransaction, type NftLaunchContext, type NftLaunchReview, type NftLaunchRequest } from './client-nft-launch';
import { createNftPendingStore } from './client-nft-recovery';
import { nftCheckoutAccess } from './client-nft-checkout-access';
import { nftEarningsAccess } from './client-nft-earnings';

const network = nftNetworkForChainId(84532)!, from = `0x${'1'.repeat(40)}`, to = `0x${'2'.repeat(40)}`, hash = `0x${'3'.repeat(64)}`;
const now = Date.parse('2026-11-16T12:00:00Z'), expiresAt = new Date(now + 120_000).toISOString();
const transaction: EvmWalletTransaction = { chainId: 84532, from, to, data: '0x1234', value: '1', expectedIdentityScope: 'owner/base-sepolia', expiresAt };

describe('strict NFT execution networks', () => {
  it('recognizes exactly Base Sepolia and the legacy local test profile, retaining canonical names', () => {
    expect(readNftNetwork(network)).toEqual({ mode: 'base-sepolia', chainId: 84532, name: 'Base Sepolia', nativeSymbol: 'ETH', nativeDecimals: 18 });
    expect(readNftNetwork({ chainId: 31337, nativeSymbol: 'ETH', nativeDecimals: 18 })).toEqual(nftNetworkForChainId(31337));
    expect(validateNftLaunchStatus({ enabled: true, network, deploymentId: 'a'.repeat(64), reason: null }).network).toEqual(network);
    expect(nftNetworkLabel(network)).toBe('Base Sepolia testnet (84532)');
  });

  it.each([8453, 1, 11155111, 31338, 0, -1, '84532'])('rejects mainnets and unsupported chain %s', chainId => {
    expect(readNftNetwork({ ...network, chainId })).toBeNull();
  });

  it.each([{ mode: 'local' }, { name: 'Base Mainnet' }, { nativeSymbol: 'ZRO' }, { nativeDecimals: 8 }])('rejects conflicting Base network fields: %j', change => {
    expect(readNftNetwork({ ...network, ...change })).toBeNull();
  });

  it('requires explicit Base acknowledgement and expected chain rather than accepting a local-chain acknowledgement', () => {
    expect(nftTestAcknowledgement(84532)).toEqual({ testEthAcknowledged: true, expectedChainId: 84532 });
    expect(nftTestAcknowledgement(31337)).toEqual({ localEthAcknowledged: true });
    for (const value of [{ localEthAcknowledged: true }, { testEthAcknowledged: true }, { testEthAcknowledged: true, expectedChainId: 31337 }, { testEthAcknowledged: true, expectedChainId: 84532, localEthAcknowledged: true }]) expect(validNftTestAcknowledgement(value, 84532)).toBe(false);
    expect(validNftTestAcknowledgement(nftTestAcknowledgement(84532), 84532)).toBe(true);
    expect(validNftTestAcknowledgement({ localEthAcknowledged: true }, 31337)).toBe(true);
    expect(validNftTestAcknowledgement({ localEthAcknowledged: true }, 8453)).toBe(false);
  });

  it('produces explorer links only for known Base Sepolia values without inventing an explorer for local or arbitrary chains', () => {
    expect(nftExplorerHref(84532, hash, 'tx')).toBe(`https://sepolia.basescan.org/tx/${hash}`);
    expect(nftExplorerHref(84532, from, 'address')).toBe(`https://sepolia.basescan.org/address/${from}`);
    expect(nftExplorerHref(31337, hash, 'tx')).toBeNull(); expect(nftExplorerHref(8453, hash, 'tx')).toBeNull();
    expect(nftExplorerHref(84532, 'javascript:alert(1)', 'tx')).toBeNull();
  });
});

describe('Base Sepolia transaction authority', () => {
  function harness() {
    const review: NftLaunchReview = { id: 'review', reviewHash: `0x${'4'.repeat(64)}`, expiresAt, chainId: 84532, from, to, data: '0x1234', value: '1', action: 'mint', network,
      scope: 'public', deploymentId: 'a'.repeat(64), draftId: to, revision: 0, summary: {}, simulation: { blockNumber: '10', blockHash: `0x${'5'.repeat(64)}`, gasEstimate: '22000' } };
    const context: NftLaunchContext = { identityScope: transaction.expectedIdentityScope, userId: 'owner', address: from, chainId: 84532, draftId: to, revision: 0, prepared: true, deploymentId: review.deploymentId, scope: 'public' };
    const api = { status: vi.fn(), review: vi.fn(async () => review), validate: vi.fn(async () => review), receipt: vi.fn(async () => ({ status: 'pending' as const })), submitted: vi.fn() };
    const send = vi.fn(async () => hash), pendingStore = createNftPendingStore(null, () => now);
    const controller = createNftLaunchController({ api, context: () => context, sendEvmTransaction: send, now: () => now, receiptAttempts: 1, pendingStore });
    return { review, context, api, send, controller };
  }

  it('prepares Base terms without a wallet request, then sends only after the separate approval and exact revalidation', async () => {
    const h = harness(), input: NftLaunchRequest = { action: 'mint', from, collection: to, quantity: '1', ...nftTestAcknowledgement(84532) };
    await h.controller.prepare(input); expect(h.api.review).toHaveBeenCalledExactlyOnceWith(input); expect(h.send).not.toHaveBeenCalled();
    await h.controller.approve(); expect(h.api.validate).toHaveBeenCalledOnce();
    expect(h.send).toHaveBeenCalledExactlyOnceWith(transaction);
  });

  it('refuses legacy acknowledgement or a changed review chain before calling the wallet', async () => {
    const old = harness(); await old.controller.prepare({ action: 'mint', from, collection: to, quantity: '1', localEthAcknowledged: true });
    expect(old.api.review).not.toHaveBeenCalled(); expect(old.send).not.toHaveBeenCalled();
    const changed = harness(); changed.review.chainId = 31337; changed.review.network = nftNetworkForChainId(31337)!;
    await changed.controller.prepare({ action: 'mint', from, collection: to, quantity: '1', ...nftTestAcknowledgement(84532) });
    expect(changed.controller.getSnapshot().phase).not.toBe('review'); expect(changed.send).not.toHaveBeenCalled();
  });

  it('sends the reviewed Base hexadecimal chain ID and refuses a wallet switched to Base mainnet', async () => {
    const request = vi.fn(async ({ method }: { method: string }) => method === 'eth_chainId' ? '0x14a34' : method === 'eth_accounts' ? [from] : hash);
    await expect(sendReviewedEvmTransaction({ transaction, identityScope: () => transaction.expectedIdentityScope, getProvider: async () => ({ request }), now: () => now })).resolves.toBe(hash);
    expect(request).toHaveBeenLastCalledWith({ method: 'eth_sendTransaction', params: [{ from, to, data: '0x1234', value: '0x1', chainId: '0x14a34' }] });
    let reads = 0;
    const switched = vi.fn(async ({ method }: { method: string }) => method === 'eth_chainId' ? (++reads === 1 ? '0x14a34' : '0x2105') : [from]);
    await expect(sendReviewedEvmTransaction({ transaction, identityScope: () => transaction.expectedIdentityScope, getProvider: async () => ({ request: switched }), now: () => now })).rejects.toThrow('network changed');
    expect(switched.mock.calls.some(([value]) => value.method === 'eth_sendTransaction')).toBe(false);
  });

  it('keeps wallet/earnings access bound to the actual supported deployment network', () => {
    const status = { enabled: true, reason: null, deploymentId: 'a'.repeat(64), network };
    expect(nftEarningsAccess({ status, failed: false, authenticated: true, connected: true, identity: 'owner', wallet: from, chainId: 84532 })).toBe('ready');
    expect(nftEarningsAccess({ status, failed: false, authenticated: true, connected: true, identity: 'owner', wallet: from, chainId: 31337 })).toBe('network');
    const details = { network, deploymentId: status.deploymentId, collection: to, opened: true };
    expect(nftCheckoutAccess({ details: details as never, collection: to, indexedDeploymentId: status.deploymentId, loading: false, error: null, authenticated: true, connected: true, identityScope: 'owner', chainId: 84532 }).ready).toBe(true);
    expect(nftCheckoutAccess({ details: details as never, collection: to, indexedDeploymentId: status.deploymentId, loading: false, error: null, authenticated: true, connected: true, identityScope: 'owner', chainId: 8453 }).ready).toBe(false);
  });

  it('unlocks ZRO drafts for Zero profiles and derives network-appropriate currency labels', () => {
    const zeroTestnet = { mode: 'zero-testnet' as const, chainId: 33001, name: 'Zero Testnet', nativeSymbol: 'ZRO' as const, nativeDecimals: 18, isTestnet: true };
    const zeroMainnet = { mode: 'zero-mainnet' as const, chainId: 33000, name: 'Zero Mainnet', nativeSymbol: 'ZRO' as const, nativeDecimals: 18, isTestnet: false };

    expect(nativeAssetLabel(network)).toBe('test ETH');
    expect(nativeAssetLabel(zeroTestnet)).toBe('test ZRO');
    expect(nativeAssetLabel(zeroMainnet)).toBe('ZRO');
    expect(draftPriceUnit({ pricingNetwork: 'zero-testnet' })).toBe('test ZRO');
    expect(draftPriceUnit({ pricingNetwork: 'zero-mainnet' })).toBe('ZRO');
    expect(draftPricingNetworkLabel({ pricingNetwork: 'base-sepolia' })).toBe('Base Sepolia testnet (84532)');
    expect(draftPricingNetworkLabel({ pricingNetwork: 'zero-testnet' })).toBe('Zero Testnet (planned)');
    expect(draftPricingNetworkLabel({ pricingNetwork: 'zero-mainnet' })).toBe('Zero Mainnet (planned)');
    expect(draftPricingNetworkLabel({ pricingNetwork: 'zero' })).toBe('Zero (planned)');

    expect(draftCanLaunchOnNetwork({ pricingNetwork: 'zero' }, network)).toBe(false);
    expect(draftCanLaunchOnNetwork({ pricingNetwork: 'zero' }, zeroTestnet)).toBe(true);
    expect(draftCanLaunchOnNetwork({ pricingNetwork: 'zero-testnet' }, zeroTestnet)).toBe(true);
    expect(draftCanLaunchOnNetwork({ pricingNetwork: 'zero-testnet' }, zeroMainnet)).toBe(false);
    expect(draftCanLaunchOnNetwork({ pricingNetwork: 'zero' }, zeroMainnet)).toBe(true);
    expect(draftCanLaunchOnNetwork({ pricingNetwork: 'zero-mainnet' }, zeroMainnet)).toBe(true);
    expect(draftCanLaunchOnNetwork({ pricingNetwork: 'base-sepolia' }, zeroMainnet)).toBe(false);
  });
});
