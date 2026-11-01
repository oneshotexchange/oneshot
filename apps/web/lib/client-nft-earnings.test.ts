import { describe, expect, it, vi } from 'vitest';
import type { NftEarningsPage } from '@oneshot/evm';
import { createNftEarningsController, nftEarningsScopeKey, validateNftEarningsPage, type NftEarningsFetcher, type NftEarningsScope } from './client-nft-earnings';

const wallet = `0x${'a'.repeat(40)}`, market = `0x${'b'.repeat(40)}`, deploymentId = 'c'.repeat(64), blockHash = `0x${'d'.repeat(64)}`;
const scope: NftEarningsScope = { identityScope: 'owner:wallet:session', wallet, deploymentId };
const contract = (index: number) => `0x${index.toString(16).padStart(40, '0')}`;
const collection = (index: number, amountRaw = String(index)) => ({ contract: contract(index), name: `Originals ${index}`, opened: index % 2 === 0, amountRaw });
const page = (changes: Partial<NftEarningsPage> = {}): NftEarningsPage => ({
  network: { mode: 'local', chainId: 31337, name: 'Local Anvil', nativeSymbol: 'ETH', nativeDecimals: 18 },
  deploymentId, wallet, blockNumber: '100', blockHash, blockTimestamp: '1793066400',
  marketplace: { contract: market, amountRaw: '9007199254740993123456789' }, collections: [collection(1, '0'), collection(2)],
  scannedCount: 2, totalCollectionsRaw: '4', nextCursor: 'page-two', ...changes,
});
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

describe('scoped current NFT earnings', () => {
  it('loads exact base units, zero and unopened credits without signing or floating-point conversion', async () => {
    const fetcher = vi.fn(async () => page());
    const controller = createNftEarningsController(fetcher);
    await controller.open(scope);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith({ wallet }, expect.any(AbortSignal));
    expect(controller.snapshot()).toMatchObject({ key: nftEarningsScopeKey(scope), loading: false, error: null,
      data: { marketplace: { amountRaw: '9007199254740993123456789' }, collections: [collection(1, '0'), collection(2)] } });
  });

  it.each([
    { ...scope, identityScope: 'new-account' }, { ...scope, wallet: contract(99) }, { ...scope, deploymentId: 'e'.repeat(64) },
  ])('clears displayed values synchronously and aborts old reads when scope changes', async replacement => {
    const old = deferred<NftEarningsPage>(), fresh = deferred<NftEarningsPage>();
    const fetcher = vi.fn().mockResolvedValueOnce(page()).mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const controller = createNftEarningsController(fetcher); await controller.open(scope);
    const oldRead = controller.refresh(), currentRead = controller.open(replacement);
    expect(fetcher.mock.calls[1][1].aborted).toBe(true);
    expect(controller.snapshot()).toEqual({ key: nftEarningsScopeKey(replacement), data: null, loading: true, loadingMore: false, error: null });
    fresh.resolve(page({ wallet: replacement.wallet, deploymentId: replacement.deploymentId })); await currentRead;
    old.resolve(page({ marketplace: { contract: market, amountRaw: '999999' } })); await oldRead;
    expect(controller.snapshot().data?.wallet).toBe(replacement.wallet);
    expect(controller.snapshot().data?.marketplace.amountRaw).toBe('9007199254740993123456789');
  });

  it('suppresses late errors after logout or closing the earnings view', async () => {
    const old = deferred<NftEarningsPage>(), fetcher = vi.fn<NftEarningsFetcher>(() => old.promise), controller = createNftEarningsController(fetcher);
    const reading = controller.open(scope); await controller.open(null);
    expect(fetcher.mock.calls[0][1]?.aborted).toBe(true);
    old.reject(new Error('Previous private balance lookup failed')); await reading;
    expect(controller.snapshot()).toEqual({ key: null, data: null, loading: false, loadingMore: false, error: null });
    await controller.refresh(); expect(fetcher).toHaveBeenCalledOnce();
  });

  it('rejects malformed scope before any fetch and clears loaded values on explicit cancellation', async () => {
    const fetcher = vi.fn(async () => page()), controller = createNftEarningsController(fetcher);
    await controller.open({ ...scope, identityScope: '' }); expect(fetcher).not.toHaveBeenCalled();
    expect(controller.snapshot().data).toBeNull();
    await controller.open(scope); controller.cancel();
    expect(controller.snapshot()).toEqual({ key: null, data: null, loading: false, loadingMore: false, error: null });
  });

  it('refreshes from page one and replaces the whole amount snapshot', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(page()).mockResolvedValueOnce(page({ blockNumber: '101', blockHash: `0x${'f'.repeat(64)}`, marketplace: { contract: market, amountRaw: '0' }, collections: [], scannedCount: 0, totalCollectionsRaw: '0', nextCursor: null }));
    const controller = createNftEarningsController(fetcher); await controller.open(scope); await controller.refresh();
    expect(fetcher.mock.calls.map(call => call[0])).toEqual([{ wallet }, { wallet }]);
    expect(controller.snapshot().data).toMatchObject({ blockNumber: '101', marketplace: { amountRaw: '0' }, collections: [] });
  });

  it('clears stale amounts when a current refresh fails and notifies only active subscribers', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(page()).mockRejectedValueOnce(new Error('Provider unavailable'));
    const controller = createNftEarningsController(fetcher), listener = vi.fn(), unsubscribe = controller.subscribe(listener);
    await controller.open(scope); expect(listener).toHaveBeenCalledTimes(2); unsubscribe(); await controller.refresh();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(controller.snapshot()).toMatchObject({ data: null, loading: false, error: 'Provider unavailable' });
  });
});

describe('earnings pagination checkpoint and conservation', () => {
  it('appends each collection once and retains a single marketplace balance while serializing page requests', async () => {
    const second = deferred<NftEarningsPage>();
    const fetcher = vi.fn().mockResolvedValueOnce(page()).mockReturnValueOnce(second.promise);
    const controller = createNftEarningsController(fetcher); await controller.open(scope);
    const loading = controller.loadMore(); await controller.loadMore();
    expect(fetcher).toHaveBeenCalledTimes(2); expect(fetcher.mock.calls[1][0]).toEqual({ wallet, cursor: 'page-two' });
    second.resolve(page({ collections: [collection(3), collection(4)], scannedCount: 4, nextCursor: null })); await loading;
    expect(controller.snapshot().data).toMatchObject({ marketplace: { amountRaw: '9007199254740993123456789' }, collections: [collection(1, '0'), collection(2), collection(3), collection(4)], scannedCount: 4, nextCursor: null });
    await controller.loadMore(); expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    { wallet: contract(99) }, { deploymentId: 'e'.repeat(64) }, { blockNumber: '101' }, { blockHash: `0x${'f'.repeat(64)}` },
    { blockTimestamp: '1793066401' }, { totalCollectionsRaw: '5', nextCursor: 'page-three' },
    { marketplace: { contract: contract(99), amountRaw: '9007199254740993123456789' } },
    { marketplace: { contract: market, amountRaw: '1' } },
    { collections: [collection(1), collection(4)] }, { scannedCount: 2 }, { scannedCount: 3 }, { nextCursor: 'page-two' },
  ])('clears all amounts instead of merging a changed or replayed forward page: %j', changes => {
    const fetcher = vi.fn().mockResolvedValueOnce(page()).mockResolvedValueOnce(page({ collections: [collection(3), collection(4)], scannedCount: 4, nextCursor: null, ...changes }));
    const controller = createNftEarningsController(fetcher);
    return controller.open(scope).then(() => controller.loadMore()).then(() => {
      expect(controller.snapshot().data).toBeNull(); expect(controller.snapshot().error).toBeTruthy();
    });
  });

  it('rejects a cursor cycle beyond the immediately previous page', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(page({ totalCollectionsRaw: '6' }))
      .mockResolvedValueOnce(page({ collections: [collection(3), collection(4)], scannedCount: 4, totalCollectionsRaw: '6', nextCursor: 'page-three' }))
      .mockResolvedValueOnce(page({ collections: [collection(5)], scannedCount: 5, totalCollectionsRaw: '6', nextCursor: 'page-two' }));
    const controller = createNftEarningsController(fetcher); await controller.open(scope); await controller.loadMore(); await controller.loadMore();
    expect(controller.snapshot()).toMatchObject({ data: null, error: expect.stringContaining('Earnings changed') });
  });

  it('does not restore an old page after a new refresh starts', async () => {
    const old = deferred<NftEarningsPage>();
    const fetcher = vi.fn().mockResolvedValueOnce(page()).mockReturnValueOnce(old.promise).mockResolvedValueOnce(page({ marketplace: { contract: market, amountRaw: '10' } }));
    const controller = createNftEarningsController(fetcher); await controller.open(scope);
    const previousPage = controller.loadMore(); await controller.refresh();
    expect(fetcher.mock.calls[1][1].aborted).toBe(true);
    old.resolve(page({ collections: [collection(3), collection(4)], scannedCount: 4, nextCursor: null })); await previousPage;
    expect(controller.snapshot().data?.marketplace.amountRaw).toBe('10'); expect(controller.snapshot().data?.collections).toHaveLength(2);
  });

  it('clears the whole snapshot on a failed forward request and requires a first-page refresh', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(page()).mockRejectedValueOnce(new Error('The canonical block moved'))
      .mockResolvedValueOnce(page({ marketplace: { contract: market, amountRaw: '10' } }));
    const controller = createNftEarningsController(fetcher); await controller.open(scope); await controller.loadMore();
    expect(controller.snapshot()).toMatchObject({ data: null, loadingMore: false, error: 'The canonical block moved' });
    await controller.loadMore(); expect(fetcher).toHaveBeenCalledTimes(2);
    await controller.refresh();
    expect(fetcher.mock.calls[2][0]).toEqual({ wallet });
    expect(controller.snapshot()).toMatchObject({ error: null, data: { marketplace: { amountRaw: '10' } } });
  });
});

describe('earnings response validation', () => {
  it.each([
    { network: { mode: 'zero', chainId: 31337, name: 'Zero', nativeSymbol: 'ETH', nativeDecimals: 18 } },
    { network: { mode: 'local', chainId: 1, name: 'Wrong', nativeSymbol: 'ETH', nativeDecimals: 18 } },
    { network: { mode: 'local', chainId: 31337, name: 'Wrong precision', nativeSymbol: 'ZRO', nativeDecimals: 8 } },
    { blockNumber: '01' }, { blockHash: 'bad' }, { blockTimestamp: '-1' }, { scannedCount: 1.5 },
    { totalCollectionsRaw: '-1' }, { nextCursor: '' }, { nextCursor: 'x'.repeat(2049) },
    { marketplace: { contract: market, amountRaw: '-1' } }, { marketplace: { contract: market, amountRaw: (1n << 256n).toString() } },
    { collections: [collection(1), collection(1)] }, { collections: [{ ...collection(1), contract: market }] },
    { collections: [{ ...collection(1), opened: 'yes' }] }, { collections: [{ ...collection(1), amountRaw: '1.2' }] },
    { collections: Array.from({ length: 11 }, (_, i) => collection(i + 1)), scannedCount: 11, totalCollectionsRaw: '12' },
    { scannedCount: 5 }, { nextCursor: null },
  ])('rejects malformed amounts, network, pagination or contract data: %j', changes => {
    expect(() => validateNftEarningsPage(page(changes as Partial<NftEarningsPage>), scope)).toThrow('Earnings could not be verified');
  });

  it('rejects a first page that starts at a later scan position and strips unrelated payload fields', async () => {
    const fetcher = vi.fn(async () => page({ scannedCount: 3 })), controller = createNftEarningsController(fetcher);
    await controller.open(scope); expect(controller.snapshot().data).toBeNull();
    const projected = validateNftEarningsPage({ ...page(), privateEndpoint: 'must not be retained' } as NftEarningsPage, scope);
    expect(projected).not.toHaveProperty('privateEndpoint');
  });

  it('treats address casing consistently without allowing case-only duplicates', () => {
    const mixedWallet = wallet.toUpperCase().replace('0X', '0x'), mixedMarket = market.toUpperCase().replace('0X', '0x');
    const result = validateNftEarningsPage(page({ wallet: mixedWallet, marketplace: { contract: mixedMarket, amountRaw: '1' } }), scope);
    expect(result.wallet).toBe(wallet); expect(result.marketplace.contract).toBe(market);
    const duplicate = `0x${'e'.repeat(40)}`;
    expect(() => validateNftEarningsPage(page({ collections: [
      { ...collection(1), contract: duplicate }, { ...collection(2), contract: duplicate.toUpperCase().replace('0X', '0x') },
    ] }), scope)).toThrow('Earnings could not be verified');
  });

  it('accepts the server collection-name bound and rejects an oversized name', () => {
    expect(validateNftEarningsPage(page({ collections: [{ ...collection(1), name: 'x'.repeat(200) }] }), scope).collections[0].name).toHaveLength(200);
    expect(() => validateNftEarningsPage(page({ collections: [{ ...collection(1), name: 'x'.repeat(201) }] }), scope)).toThrow('Earnings could not be verified');
  });
});
