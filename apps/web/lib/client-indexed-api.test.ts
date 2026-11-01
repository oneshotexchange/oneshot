import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { formatIndexedAmount, type IndexedCollection, type IndexedNftContext, type IndexedNftItem, type IndexedNftPresentation, type IndexedPage } from '@oneshot/evm';
import { IndexedCollectionCard, IndexedCollectionPreview, IndexedContextNote, IndexedItemCards, IndexedItemRecord } from '../components/indexed-nfts';
import { appendIndexedPage, indexedApi, IndexedPageLoader, IndexedReadError, sameIndexedCheckpoint } from './client-indexed-api';
import { indexedPresentation } from './client-indexed-presentation';

const context = (hash = 'a'): IndexedNftContext => ({
  enabled: true, available: true, reason: null, deploymentId: 'deployment-a',
  network: { mode: 'local', name: 'Local Anvil', chainId: 31337, nativeSymbol: 'ETH', nativeDecimals: 18 },
  checkpoint: { number: '20', hash: `0x${hash.repeat(64)}`, timestamp: '2026-10-22T12:00:00.000Z' }, readonly: true, finalized: false,
});
const page = (ids: string[], nextCursor: string | null = null, hash = 'a'): IndexedPage<{ id: string }> => ({ context: context(hash), items: ids.map(id => ({ id })), nextCursor });
const key = (value: { id: string }) => value.id;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (value: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const fetcher = (run: (path: string, signal?: AbortSignal) => Promise<unknown>) => run as typeof indexedApi;
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('indexed response and checkpoint identity', () => {
  it('retains API status and stale-cursor code while using the configured API destination', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.oneshot.example');
    const request = vi.fn(async () => Response.json({ error: { code: 'CURSOR_STALE', message: 'Refresh this list.' } }, { status: 409 }));
    vi.stubGlobal('fetch', request);
    await expect(indexedApi('/api/oneshot/indexed/collections')).rejects.toMatchObject({ status: 409, code: 'CURSOR_STALE' });
    expect(request).toHaveBeenCalledWith('https://api.oneshot.example/api/oneshot/indexed/collections', expect.objectContaining({ credentials: 'omit', redirect: 'error' }));
  });
  it('rejects responses that do not identify a read-only non-finalized context', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ context: { ...context(), readonly: false } })));
    await expect(indexedApi('/api/oneshot/indexed/status')).rejects.toMatchObject({ code: 'INVALID_READ_RESPONSE' });
  });
  it('compares deployment and complete head identity before appending pages', () => {
    expect(sameIndexedCheckpoint(context(), { ...context(), deploymentId: 'deployment-b' })).toBe(false);
    expect(sameIndexedCheckpoint(context(), { ...context(), checkpoint: { ...context().checkpoint!, number: '21' } })).toBe(false);
    expect(sameIndexedCheckpoint(context(), context('b'))).toBe(false);
    expect(() => appendIndexedPage(page(['old']), page(['new'], null, 'b'), key)).toThrow(IndexedReadError);
    expect(appendIndexedPage(page(['a', 'b']), page(['b', 'c']), key).items).toEqual([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  });
  it('appends the same indexed snapshot when only its observed chain head advances', () => {
    const first = { ...page(['one'], 'next'), context: { ...context(), sync: { chainHead: '20', behindBlocks: '0' } } };
    const next = { ...page(['two']), context: { ...context(), sync: { chainHead: '25', behindBlocks: '5' } } };
    expect(sameIndexedCheckpoint(first.context, next.context)).toBe(true);
    expect(appendIndexedPage(first, next, key)).toMatchObject({ items: [{ id: 'one' }, { id: 'two' }], context: { sync: { chainHead: '25', behindBlocks: '5' } } });
  });
});

describe('indexed pagination request ownership', () => {
  it('does not publish a late response from another wallet or collection', async () => {
    const first = deferred<unknown>(), second = deferred<unknown>();
    const signals: AbortSignal[] = [];
    const loader = new IndexedPageLoader(key, fetcher((path, signal) => { signals.push(signal!); return path === '/first' ? first.promise : second.promise; }));
    const stale = loader.open('/first');
    const current = loader.open('/second');
    second.resolve(page(['current'])); await current;
    first.resolve(page(['wrong'])); await stale;
    expect(signals[0].aborted).toBe(true);
    expect(loader.snapshot()).toMatchObject({ path: '/second', data: { items: [{ id: 'current' }] } });
  });
  it('makes at most one simultaneous next-page request', async () => {
    const next = deferred<unknown>(); let requests = 0;
    const loader = new IndexedPageLoader(key, fetcher(async path => { requests++; return path.includes('cursor=') ? next.promise : page(['one'], 'cursor-a'); }));
    await loader.open('/collections');
    const loading = loader.loadMore(); await loader.loadMore();
    expect(requests).toBe(2);
    next.resolve(page(['two'])); await loading;
    expect(loader.snapshot().data?.items).toEqual([{ id: 'one' }, { id: 'two' }]);
  });
  it('ignores an old next page when a refresh starts', async () => {
    const oldNext = deferred<unknown>(); let firstRequests = 0;
    const loader = new IndexedPageLoader(key, fetcher(async path => path.includes('cursor=') ? oldNext.promise : page([++firstRequests === 1 ? 'old' : 'fresh'], 'next')));
    await loader.open('/collections'); const old = loader.loadMore();
    await loader.refresh(); oldNext.resolve(page(['obsolete'])); await old;
    expect(loader.snapshot().data?.items).toEqual([{ id: 'fresh' }]);
  });
  it('clears orphaned records and restarts after a server stale-cursor response', async () => {
    let firstRequests = 0;
    const loader = new IndexedPageLoader(key, fetcher(async path => {
      if (path.includes('cursor=')) throw new IndexedReadError(409, 'CURSOR_STALE', 'Changed');
      return ++firstRequests === 1 ? page(['orphan'], 'next') : page(['canonical'], null, 'b');
    }));
    await loader.open('/collections'); await loader.loadMore();
    expect(loader.snapshot().data?.items).toEqual([{ id: 'canonical' }]);
    expect(loader.snapshot().notice).toContain('refreshed');
  });
  it('restarts if an API incorrectly returns a different head with a successful next page', async () => {
    let firstRequests = 0;
    const loader = new IndexedPageLoader(key, fetcher(async path => path.includes('cursor=') ? page(['mixed'], null, 'b') : ++firstRequests === 1 ? page(['old'], 'next') : page(['new'], null, 'b')));
    await loader.open('/items'); await loader.loadMore();
    expect(loader.snapshot().data?.items).toEqual([{ id: 'new' }]);
  });
  it('clears known orphaned owners on chain-moved errors until an explicit refresh succeeds', async () => {
    let firstRequests = 0;
    const loader = new IndexedPageLoader(key, fetcher(async path => {
      if (path.includes('cursor=')) throw new IndexedReadError(409, 'INDEXER_CHAIN_MOVED', 'The indexed checkpoint was replaced. Refresh after indexing catches up.');
      return ++firstRequests === 1 ? page(['orphaned-owner'], 'next') : page(['canonical-owner'], null, 'b');
    }));
    await loader.open('/wallet/items'); await loader.loadMore();
    expect(loader.snapshot()).toMatchObject({ data: null, loading: false, loadingMore: false, notice: null });
    expect(loader.snapshot().error).toContain('checkpoint was replaced');
    await loader.loadMore();
    expect(firstRequests).toBe(1);
    await loader.refresh();
    expect(loader.snapshot().data?.items).toEqual([{ id: 'canonical-owner' }]);
  });
  it('retains a failed page cursor for retry without losing previously loaded records', async () => {
    let nextRequests = 0;
    const loader = new IndexedPageLoader(key, fetcher(async path => {
      if (!path.includes('cursor=')) return page(['one'], 'next');
      if (++nextRequests === 1) throw new Error('Try again');
      return page(['two']);
    }));
    await loader.open('/items'); await loader.loadMore();
    expect(loader.snapshot()).toMatchObject({ data: { items: [{ id: 'one' }], nextCursor: 'next' }, error: 'Try again', loadingMore: false });
    await loader.loadMore();
    expect(loader.snapshot().data?.items).toEqual([{ id: 'one' }, { id: 'two' }]);
  });
  it('cancels publication when a component unmounts and clears on an empty scope', async () => {
    const pending = deferred<unknown>();
    const loader = new IndexedPageLoader(key, fetcher(async () => pending.promise));
    const request = loader.open('/items'); loader.cancel(); pending.resolve(page(['unmounted'])); await request;
    expect(loader.snapshot().data).toBeNull();
    await loader.open(null);
    expect(loader.snapshot()).toMatchObject({ path: null, loading: false, data: null });
  });
});

describe('indexed display truth', () => {
  const render = (node: React.ReactNode) => renderToStaticMarkup(createElement(MemoryRouter, null, node));
  it('clearly labels local test ETH without exposing operator diagnostics or claiming finality', () => {
    const html = render(createElement(IndexedContextNote, { context: context() }));
    expect(html).toContain('Test network'); expect(html).toContain('ETH amounts');
    expect(html).not.toMatch(/indexed block|finality|checkpoint|finalized/i);
    expect(html).not.toContain('ZRO');
  });
  it.each([
    ['20', '0', 'indexed through this observed head'],
    ['21', '1', '1 block behind'],
    ['900719925474099312345', '900719925474099312325', '900719925474099312325 blocks behind'],
  ])('keeps observed height %s and distance %s out of customer guidance', (chainHead, behindBlocks, note) => {
    const html = render(createElement(IndexedContextNote, { context: { ...context(), sync: { chainHead, behindBlocks } } }));
    expect(html).not.toContain('Observed chain block');
    expect(html).not.toContain(note);
    expect(html).toContain('Test network');
    expect(html).not.toMatch(/worker alive|worker running|finalized|floorRaw|allowlist/i);
  });
  it('omits observed freshness when absent or unavailable', () => {
    for (const value of [context(), { ...context(), sync: null }, { ...context(), available: false, checkpoint: null, sync: { chainHead: '25', behindBlocks: '5' } }]) {
      expect(render(createElement(IndexedContextNote, { context: value }))).not.toContain('Observed chain block');
    }
  });
  it('does not claim an active mint schedule or available art', () => {
    const collection: IndexedCollection = { address: `0x${'1'.repeat(40)}`, creator: `0x${'2'.repeat(40)}`, name: 'Local originals', symbol: 'SHOT', configured: true, opened: true, termsHash: `0x${'3'.repeat(64)}`, contentHash: `0x${'4'.repeat(64)}`, totalMinted: '9007199254740993', primaryTotalPriceRaw: '0', primaryPlatformFeeRaw: '0', primaryCreatorProceedsRaw: '0', totalClaimedRaw: '0' };
    const html = render(createElement(IndexedCollectionCard, { collection }));
    expect(html).toContain('Mint terms locked'); expect(html).toContain('View mint details'); expect(html).toContain('Art unavailable');
    expect(html).toContain('9007199254740993'); expect(html).not.toContain('Minting now'); expect(html).not.toContain('Free');
  });
  it('shows exact large listing amounts without inventing royalty or metadata values', () => {
    const item: IndexedNftItem = { id: 'one', collection: `0x${'1'.repeat(40)}`, tokenId: '1', owner: `0x${'2'.repeat(40)}`, burned: false, listing: { id: '1', collection: `0x${'1'.repeat(40)}`, tokenId: '1', seller: `0x${'3'.repeat(40)}`, totalPriceRaw: '900719925474099312345678901234567890', status: 'active', buyer: null, recipient: null, platformFeeRaw: null, royaltyRaw: null, sellerProceedsRaw: null } };
    const html = render(createElement(IndexedItemRecord, { item }));
    expect(html).toContain('900719925474099312.34567890123456789 ETH'); expect(html).not.toContain('Royalty rate'); expect(html).toContain('Unavailable');
    expect(html).not.toContain('0%'); expect(html).not.toContain('ZRO'); expect(html).not.toContain('Buy now');
    expect(formatIndexedAmount('1')).toBe('0.000000000000000001');
  });
});

describe('stored NFT presentation', () => {
  const render = (node: React.ReactNode) => renderToStaticMarkup(createElement(MemoryRouter, null, node));
  const manifestHash = 'a'.repeat(64);
  const imagePath = `/api/media/${'b'.repeat(64)}.webp`;
  const metadataPath = `/api/oneshot/metadata/${manifestHash}/1`;
  const presentation = (changes: Partial<IndexedNftPresentation> = {}): IndexedNftPresentation => ({
    manifestHash, tokenId: '1', name: 'First light', description: 'An original from the prepared snapshot.', imagePath, metadataPath,
    attributes: [{ trait_type: 'Palette', value: 'Mint' }, { trait_type: 'Edition', value: 0 }], ...changes,
  });
  const collection = (changes: Partial<IndexedCollection> = {}): IndexedCollection => ({
    address: `0x${'1'.repeat(40)}`, creator: `0x${'2'.repeat(40)}`, name: 'Factory collection name', symbol: 'SHOT',
    configured: true, opened: true, termsHash: `0x${'3'.repeat(64)}`, contentHash: `0x${manifestHash}`, totalMinted: '1',
    primaryTotalPriceRaw: '0', primaryPlatformFeeRaw: '0', primaryCreatorProceedsRaw: '0', totalClaimedRaw: '0', ...changes,
  });
  const item = (changes: Partial<IndexedNftItem> = {}): IndexedNftItem => ({
    id: 'first', collection: `0x${'1'.repeat(40)}`, tokenId: '1', owner: `0x${'2'.repeat(40)}`, burned: false, listing: null, ...changes,
  });

  it('uses the configured API origin for stored artwork and identifies collection art as an item preview', () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.oneshot.example');
    const value = collection({ presentation: presentation() });
    const card = render(createElement(IndexedCollectionCard, { collection: value }));
    expect(card).toContain('<h3>Factory collection name</h3>');
    expect(card).not.toContain('<h3>First light</h3>');
    expect(card).toContain('First NFT');
    expect(card).toContain(`src="https://api.oneshot.example${imagePath}"`);
    expect(card).toContain('alt="First NFT from Factory collection name: First light"');
    expect(card).toContain('loading="lazy"'); expect(card).toContain('decoding="async"'); expect(card).toContain('referrerPolicy="no-referrer"');
    expect(card).toContain('View mint details'); expect(card).not.toContain('Minting now');
    const preview = render(createElement(IndexedCollectionPreview, { collection: value }));
    expect(preview).toContain('Artwork from the first NFT in this collection.');
    expect(preview).toContain('Artwork from the first NFT in this collection.');
    expect(preview).toContain('An original from the prepared snapshot.');
    expect(preview).toContain(`href="https://api.oneshot.example${metadataPath}"`);
  });

  it('renders item text and traits as escaped content while retaining ownership and exact prices', () => {
    const value = item({ presentation: presentation({ name: '<img src=x onerror=alert(1)>', description: '<script>snapshot</script>', attributes: [{ trait_type: '<Palette>', value: '<mint>' }, { trait_type: 'Edition', value: 0 }] }),
      listing: { id: '5', collection: `0x${'1'.repeat(40)}`, tokenId: '1', seller: `0x${'3'.repeat(40)}`, totalPriceRaw: '900719925474099312345678901234567890', status: 'active', buyer: null, recipient: null, platformFeeRaw: null, royaltyRaw: null, sellerProceedsRaw: null } });
    const detail = render(createElement(IndexedItemRecord, { item: value }));
    expect(detail).toContain('&lt;script&gt;snapshot&lt;/script&gt;');
    expect(detail).toContain('&lt;Palette&gt;'); expect(detail).toContain('&lt;mint&gt;'); expect(detail).toContain('<strong>0</strong>');
    expect(detail).not.toContain('<script>'); expect(detail).not.toContain('<img src=x');
    expect(detail).toContain('View metadata'); expect(detail).toContain(`href="${metadataPath}"`);
    expect(detail).toContain('900719925474099312.34567890123456789 ETH'); expect(detail).not.toContain('Royalty rate');
    const cards = render(createElement(IndexedItemCards, { items: [value] }));
    expect(cards).toContain('&lt;img src=x onerror=alert(1)&gt;'); expect(cards).toContain('NFT #1');
    expect(cards).toContain('Listed for sale'); expect(cards).toContain('900719925474099312.34567890123456789 ETH');
    expect(cards).not.toContain('ZRO'); expect(cards).not.toContain('Buy now');
  });

  it.each([
    { imagePath: 'https://outside.example/image.webp' },
    { imagePath: '//outside.example/image.webp' },
    { imagePath: 'data:image/svg+xml,<svg></svg>' },
    { imagePath: `${imagePath}?redirect=https://outside.example` },
    { imagePath: `/api/media/${'b'.repeat(64)}.svg` },
    { metadataPath: 'javascript:alert(1)' },
    { metadataPath: `/api/oneshot/metadata/${'c'.repeat(64)}/1` },
    { metadataPath: `/api/oneshot/metadata/${manifestHash}/2` },
    { tokenId: '2', metadataPath: `/api/oneshot/metadata/${manifestHash}/2` },
  ])('keeps the ownership view usable without requesting unsafe or mismatched presentation paths %j', changes => {
    const value = presentation(changes);
    const detail = render(createElement(IndexedItemRecord, { item: item({ presentation: value, burned: true, owner: null }) }));
    expect(detail).not.toContain('<img'); expect(detail).not.toContain('View metadata');
    expect(detail).not.toContain('An original from the prepared snapshot.');
    expect(detail).toContain('Art unavailable'); expect(detail).toContain('Burned'); expect(detail).toContain('None');
    expect(render(createElement(IndexedCollectionPreview, { collection: collection({ presentation: value }) }))).toBe('');
  });

  it('supports old and missing presentation data without inventing metadata', () => {
    for (const value of [undefined, null]) {
      const detail = render(createElement(IndexedItemRecord, { item: item({ presentation: value }) }));
      expect(detail).toContain('Art unavailable'); expect(detail).not.toContain('<img'); expect(detail).not.toContain('Item traits');
      expect(detail).not.toContain('View metadata'); expect(detail).toContain('NFT details');
      const cards = render(createElement(IndexedItemCards, { items: [item({ presentation: value })] }));
      expect(cards).toContain('<h3>NFT #1</h3>'); expect(cards).toContain('Owned');
      expect(render(createElement(IndexedCollectionPreview, { collection: collection({ presentation: value }) }))).toBe('');
    }
  });

  it('refuses malformed token identifiers and invalid deployment origins without breaking the page', () => {
    for (const tokenId of ['01', '0', '-1', (1n << 256n).toString()]) {
      expect(indexedPresentation(presentation({ tokenId, metadataPath: `/api/oneshot/metadata/${manifestHash}/${tokenId}` }), tokenId)).toBeNull();
    }
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.oneshot.example/untrusted-path');
    expect(indexedPresentation(presentation(), '1')).toBeNull();
    expect(render(createElement(IndexedItemRecord, { item: item({ presentation: presentation() }) }))).toContain('NFT details');
  });
});
