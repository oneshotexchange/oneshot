import { describe, expect, it, vi } from 'vitest';
import { MemoryIndexerStore } from '../../indexer/src/store';
import { syncReviewedNftIndexer } from '../../indexer/src/reviewed-nft-engine';
import { rAdmit, rBlock, rListed, rManifest as m, rTransfer, ra, rh, ReviewedFixtureSource } from '../../indexer/test/reviewed-nft-fixture';
import { reviewedNftManifestId } from '../../../packages/evm/src/reviewed-nft';
import { reviewedContextSchema, reviewedActivitySchema } from './reviewed-nft-data';
import { assertReviewedNftCheckpoint, fetchReviewedNftRead, parseReviewedNftRead, reviewedNftCollectionHref, reviewedNftDeployment, reviewedNftItemHref, reviewedNftReadPath } from './client-reviewed-nfts';
const deployment = reviewedNftManifestId(m);
async function data() {
  const block = rBlock(1), source = new ReviewedFixtureSource().add(block, [rAdmit(block), rTransfer(block, 1, ra(4), m.marketplace.address), rListed(block, 2)], '0', '2'), store = new MemoryIndexerStore();
  await syncReviewedNftIndexer(source, store, m); const { projection } = await store.snapshot();
  const context = { schemaVersion: 1, kind: 'reviewed-external-nft-journal', enabled: true, available: true, reason: null, deploymentId: deployment, network: { mode: 'local', chainId: 31337, name: 'Local testnet', nativeSymbol: 'ETH', nativeDecimals: 18 }, source: { genesisHash: m.genesisHash, registry: m.registry.address, marketplace: m.marketplace.address }, checkpoint: { number: '1', hash: block.hash, timestamp: block.timestamp.toString() }, sync: { chainHead: '1', behindBlocks: '0' }, readonly: true, finalized: false, coverage: { mode: 'observed-since-admission', completeCollection: false, includesPreAdmissionHistory: false } };
  return { context, collection: projection.collections[ra(10)], item: projection.items[`${ra(10)}:0`], listing: projection.listings[`${m.marketplace.address}:1`], activity: Object.values(projection.activity)[0] };
}
describe('public reviewed NFT client', () => {
  it('keeps collection admission and tab records at the same canonical checkpoint', async () => {
    const { context } = await data(), valid = reviewedContextSchema.parse(context);
    expect(() => assertReviewedNftCheckpoint(valid, valid)).not.toThrow();
    expect(() => assertReviewedNftCheckpoint({ ...valid, checkpoint: { ...valid.checkpoint!, hash: rh(900) } }, valid)).toThrow('Collection records changed.');
  });
  it('rejects unreadable activity arguments and attribution to another registry', async () => {
    const f = await data(), activity = reviewedActivitySchema.parse(f.activity), selected = { kind: 'activity' as const, collection: ra(10) };
    for (const value of [{ ...activity, args: { ...activity.args, version: 'abc' } }, { ...activity, args: { ...activity.args, privateNote: 'unrequested' } }, { ...activity, source: ra(99) }])
      expect(() => parseReviewedNftRead({ context: f.context, items: [value], nextCursor: null }, selected)).toThrow();
  });
  it('supports exact tokenID0 and deployment-bound links without a native dense-ID assumption', () => {
    expect(reviewedNftItemHref(ra(10), '0', deployment)).toContain('/0?deployment='); expect(reviewedNftCollectionHref(ra(10), deployment)).toContain(deployment);
    expect(reviewedNftReadPath({ kind: 'item', collection: ra(10), tokenId: '9007199254740993' })).toMatch(/\/9007199254740993$/);
    for (const value of ['00', '-1', '1e3', (2n ** 256n).toString()]) expect(() => reviewedNftItemHref(ra(10), value, deployment)).toThrow();
    expect(() => reviewedNftDeployment(`?deployment=${deployment}&deployment=${deployment}`)).toThrow();
  });
  it('uses public GET with omitted credentials and validates returned records before use', async () => {
    const f = await data(), fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ context: f.context, item: f.item, listing: f.listing }));
    const value = await fetchReviewedNftRead({ kind: 'item', collection: ra(10), tokenId: '0' }, deployment, undefined, undefined, fetcher);
    expect(value).toMatchObject({ item: { tokenId: '0' } }); expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error' });
  });
  it.each(['deployment', 'network', 'height', 'kind', 'coverage'] as const)('rejects mismatched context: %s', async key => {
    const f = await data(), context = { ...f.context };
    Object.assign(context, key === 'deployment' ? { deploymentId: 'f'.repeat(64) } : key === 'network' ? { network: { ...f.context.network, chainId: 84532 } } : key === 'height' ? { checkpoint: { ...f.context.checkpoint, number: '0' }, sync: null } : key === 'kind' ? { kind: 'native-nft-journal' } : { coverage: { ...f.context.coverage, completeCollection: true } });
    expect(() => parseReviewedNftRead({ context, items: [f.collection], nextCursor: null }, { kind: 'collections' }, deployment)).toThrow();
  });
  it('rejects other collection/item attribution, absent listing association and changed royalty economics', async () => {
    const f = await data(), selection = { kind: 'item' as const, collection: ra(10), tokenId: '0' };
    for (const body of [{ ...f, item: { ...f.item, collection: ra(11) } }, { ...f, item: { ...f.item, tokenId: '1' } }, { ...f, listing: null }, { ...f, listing: { ...f.listing, royaltyRaw: '1001' } }]) {
      const { collection: _collection, activity: _activity, ...raw } = body; expect(() => parseReviewedNftRead(raw, selection, deployment)).toThrow();
    }
  });
  it('never treats disabled service data as a successful nonempty list', async () => {
    const f = await data(), context = { ...f.context, enabled: false, available: false, reason: 'Try again later.' };
    expect(() => parseReviewedNftRead({ context, items: [f.collection], nextCursor: null }, { kind: 'collections' })).toThrow();
    expect(() => parseReviewedNftRead({ context, items: [], nextCursor: 'next' }, { kind: 'collections' })).toThrow();
  });
  it('rejects an available detail response without its observed collection or item', async () => {
    const f = await data();
    expect(() => parseReviewedNftRead({ context: f.context, collection: null }, { kind: 'collection', collection: ra(10) })).toThrow();
    expect(() => parseReviewedNftRead({ context: f.context, item: null, listing: null }, { kind: 'item', collection: ra(10), tokenId: '0' })).toThrow();
  });
  it('rejects repeated or unordered sparse token pages and cursors without records', async () => {
    const f = await data(); expect(() => parseReviewedNftRead({ context: f.context, items: [f.item, f.item], nextCursor: null }, { kind: 'items', collection: ra(10) })).toThrow();
    expect(() => parseReviewedNftRead({ context: f.context, items: [{ ...f.item, tokenId: '9' }, f.item], nextCursor: null }, { kind: 'items', collection: ra(10) })).toThrow();
    expect(() => parseReviewedNftRead({ context: f.context, items: [], nextCursor: 'next' }, { kind: 'items', collection: ra(10) })).toThrow();
  });
  it('rejects unreadable/oversized responses and maps unknown server errors without echoing private details', async () => {
    const selection = { kind: 'collections' as const };
    await expect(fetchReviewedNftRead(selection, null, undefined, undefined, async () => new Response('<bad>'))).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    await expect(fetchReviewedNftRead(selection, null, undefined, undefined, async () => new Response('{}', { headers: { 'content-length': '2097153' } }))).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    await expect(fetchReviewedNftRead(selection, null, undefined, undefined, async () => Response.json({ error: { code: 'FAILED', message: 'private-rpc-credential' } }, { status: 503 }))).rejects.toThrow('Reviewed NFT records are unavailable. Please try again later.');
  });
  it('preserves abort semantics and refuses malformed page inputs before calling a provider', async () => {
    const fetcher = vi.fn(), controller = new AbortController(); controller.abort();
    await expect(fetchReviewedNftRead({ kind: 'collections' }, null, undefined, controller.signal, fetcher)).rejects.toBeDefined(); expect(fetcher).not.toHaveBeenCalled();
    expect(() => reviewedNftReadPath({ kind: 'collections' }, 'has spaces')).toThrow(); expect(() => reviewedNftReadPath({ kind: 'item', collection: ra(10), tokenId: '0' }, 'cursor')).toThrow();
  });
});
