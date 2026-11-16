import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { IndexedCollectionMarketStats, IndexedCollectionResponse, IndexedNftContext } from '@oneshot/evm';
import { IndexedCollectionMarketStats as CollectionStats } from '../components/indexed-nfts';
import { nftCollectionMarketStats } from './client-nft-collection-stats';

const collection = `0x${'1'.repeat(40)}`, deployment = 'a'.repeat(64);
const context = (): IndexedNftContext => ({
  enabled: true, available: true, reason: null, deploymentId: deployment,
  network: { mode: 'local', name: 'Local Anvil', chainId: 31337, nativeSymbol: 'ETH', nativeDecimals: 18 },
  checkpoint: { number: '9007199254740993', hash: `0x${'b'.repeat(64)}`, timestamp: '2026-11-14T18:01:00.000Z' },
  readonly: true, finalized: false,
});
const stats = (changes: Partial<IndexedCollectionMarketStats> = {}): IndexedCollectionMarketStats => ({ activeListings: '2', lowestListingPriceRaw: '1000000000000000001', completedSales: '4', secondaryVolumeRaw: '900719925474099312345678901234567890', ...changes });
const response = (marketStats: IndexedCollectionMarketStats | null = stats()): IndexedCollectionResponse => ({
  context: context(), marketStats,
  collection: { address: collection, creator: `0x${'2'.repeat(40)}`, name: 'Originals', symbol: 'SHOT', configured: true, opened: true,
    termsHash: `0x${'3'.repeat(64)}`, contentHash: `0x${'4'.repeat(64)}`, totalMinted: '10', primaryTotalPriceRaw: '999', primaryPlatformFeeRaw: '0', primaryCreatorProceedsRaw: '999', totalClaimedRaw: '0' },
});
const view = (value: unknown) => nftCollectionMarketStats(value, collection, deployment);
const render = (value: IndexedCollectionResponse | null, expected = collection, expectedDeployment = deployment) => renderToStaticMarkup(createElement(CollectionStats, { response: value, collection: expected, deploymentId: expectedDeployment, onRefresh: vi.fn() }));

describe('collection marketplace statistics admission', () => {
  it('uses exact base-unit decimals and unrounded counts/checkpoint from one collection response', () => {
    const completedSales = '900719925474099312345678901234567890';
    const value = response(stats({ completedSales }));
    expect(view(value)).toEqual({ activeListings: '2', lowestListing: '1.000000000000000001', completedSales, resaleVolume: '900719925474099312.34567890123456789', blockNumber: '9007199254740993' });
    expect(value.marketStats?.secondaryVolumeRaw).toBe('900719925474099312345678901234567890');
    expect(value.collection?.primaryTotalPriceRaw).toBe('999');
  });

  it('preserves cumulative resale volume beyond one uint256 while bounding an individual listing price', () => {
    const cumulative = (2n ** 256n * 1000n + 123n).toString();
    const value = response(stats({ secondaryVolumeRaw: cumulative }));
    const result = view(value)!;
    expect(result.resaleVolume).toBe(`${cumulative.slice(0, -18)}.${cumulative.slice(-18)}`);
    expect(view(response(stats({ lowestListingPriceRaw: (2n ** 256n - 1n).toString() })))).not.toBeNull();
    expect(view(response(stats({ lowestListingPriceRaw: (2n ** 256n).toString() })))).toBeNull();
  });

  it('admits a genuinely empty resale market without fabricating a zero-priced listing', () => {
    const value = response(stats({ activeListings: '0', lowestListingPriceRaw: null, completedSales: '0', secondaryVolumeRaw: '0' }));
    expect(view(value)).toMatchObject({ activeListings: '0', lowestListing: null, completedSales: '0', resaleVolume: '0' });
    const html = render(value);
    expect(html).toContain('No active listing'); expect(html).toContain('Resale volume'); expect(html).toContain('<dd>0 <span>ETH</span></dd>');
    expect(html).not.toContain('Marketplace activity is unavailable');
  });

  it('keeps an older API response, a missing collection, and absent/null stats unavailable', () => {
    const older = response(); delete older.marketStats;
    for (const value of [null, {}, older, response(null), { ...response(), collection: null }]) {
      expect(view(value)).toBeNull();
    }
    const html = render(older);
    expect(html).toContain('Marketplace activity is unavailable'); expect(html).toContain('Refresh collection');
    expect(html).not.toContain('No active listing'); expect(html).not.toContain('<dd>0');
  });

  it.each(['activeListings', 'completedSales', 'secondaryVolumeRaw', 'lowestListingPriceRaw'] as const)('rejects malformed canonical integer field %s instead of converting it to a count or price', field => {
    for (const invalid of [-1, 0, 1.2, null, undefined, '', '-1', '+1', '01', ' 1', '1 ', '1e3', '1.0', 'NaN', '1'.repeat(257)]) {
      expect(view(response({ ...stats(), [field]: invalid } as unknown as IndexedCollectionMarketStats)), `${field}: ${String(invalid)}`).toBeNull();
    }
  });

  it.each([
    { activeListings: '0', lowestListingPriceRaw: '1' },
    { activeListings: '1', lowestListingPriceRaw: null },
    { activeListings: '1', lowestListingPriceRaw: '0' },
    { completedSales: '0', secondaryVolumeRaw: '1' },
    { completedSales: '1', secondaryVolumeRaw: '0' },
    { completedSales: '4', secondaryVolumeRaw: '3' },
  ])('rejects inconsistent or impossible zero-price resale totals: %j', changes => {
    expect(view(response(stats(changes)))).toBeNull();
  });

  it('requires active listings not to exceed canonical minted supply while allowing repeated resales', () => {
    expect(view(response(stats({ activeListings: '11' })))).toBeNull();
    expect(view(response(stats({ completedSales: '1000' })))).not.toBeNull();
    for (const totalMinted of ['-1', '01', 'bad', (2n ** 256n).toString()]) {
      const value = response(); value.collection!.totalMinted = totalMinted; expect(view(value)).toBeNull();
    }
    const huge = response(stats({ activeListings: '9007199254740993' }));
    huge.collection!.totalMinted = '9007199254740993';
    expect(view(huge)?.activeListings).toBe('9007199254740993');
  });

  it('binds stats to the requested collection and deployment without using any other list or response', () => {
    expect(nftCollectionMarketStats(response(), `0x${'3'.repeat(40)}`, deployment)).toBeNull();
    expect(nftCollectionMarketStats(response(), collection, 'c'.repeat(64))).toBeNull();
    expect(nftCollectionMarketStats(response(), collection, 'invalid-deployment')).toBeNull();
    expect(nftCollectionMarketStats(response(), 'not-an-address', deployment)).toBeNull();
    expect(nftCollectionMarketStats(response(), collection.toUpperCase().replace('0X', '0x'))).not.toBeNull();
  });

  it.each([
    { enabled: false }, { available: false }, { readonly: false }, { finalized: true },
    { deploymentId: null }, { deploymentId: 'invalid' }, { checkpoint: null },
    { checkpoint: { number: '-1', hash: `0x${'a'.repeat(64)}` } },
    { checkpoint: { number: '12', hash: 'wrong-hash' } },
    { checkpoint: { number: (2n ** 256n).toString(), hash: `0x${'a'.repeat(64)}` } },
    { checkpoint: { number: '12', hash: `0x${'0'.repeat(64)}` } },
    { network: null },
    { network: { mode: 'zero', chainId: 31337, nativeSymbol: 'ETH', nativeDecimals: 18 } },
    { network: { mode: 'local', chainId: 1, nativeSymbol: 'ETH', nativeDecimals: 18 } },
    { network: { mode: 'local', chainId: 31337, nativeSymbol: 'ZRO', nativeDecimals: 18 } },
    { network: { mode: 'local', chainId: 31337, nativeSymbol: 'ETH', nativeDecimals: 8 } },
  ])('keeps unavailable/malformed/network-mismatched context from becoming ETH market data: %j', changes => {
    const value = { ...response(), context: { ...context(), ...changes } };
    expect(view(value)).toBeNull();
  });

  it('renders explicit oneshot scope, fee accounting and nonfinal block provenance without calling a listing a floor', () => {
    const html = render(response());
    for (const text of ['Marketplace activity', 'Lowest listing', 'Active listings', 'Completed resales', 'Resale volume', 'oneshot only', 'platform fee and creator royalty', 'excludes primary mints and network gas', 'As of block 9007199254740993', 'Recent activity may change', '1.000000000000000001', '900719925474099312.34567890123456789']) expect(html).toContain(text);
    expect(html).not.toMatch(/floor|finalized|ZRO|all.marketplaces|RPC|ready|live volume/i);
    expect(html).not.toContain('999');
  });

  it('offers refresh recovery without numeric placeholders when stats are invalid', () => {
    const html = render(response(stats({ activeListings: '-1' })));
    expect(html).toContain('Marketplace activity is unavailable'); expect(html).toContain('Refresh collection');
    expect(html).not.toContain('<dl'); expect(html).not.toContain('0 ETH');
  });
});
