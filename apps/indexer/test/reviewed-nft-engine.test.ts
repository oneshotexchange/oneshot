import { describe, expect, it, vi } from 'vitest';
import { zeroAddress } from 'viem';
import { syncReviewedNftIndexer } from '../src/reviewed-nft-engine';
import { MemoryIndexerStore } from '../src/store';
import { rAdmit, rBlock, rListed, rLog, rManifest as m, rSold, rTransfer, ra, rh, ReviewedFixtureSource } from './reviewed-nft-fixture';

const list = () => { const block = rBlock(1); return new ReviewedFixtureSource().add(block, [rAdmit(block), rTransfer(block, 1, ra(4), m.marketplace.address), rListed(block, 2)], '0', '2'); };
const run = (source: ReviewedFixtureSource, store = new MemoryIndexerStore(), options = {}) => syncReviewedNftIndexer(source, store, m, options).then(result => ({ result, store }));
describe('reviewed external NFT canonical journal', () => {
  it('discovers same-block admissions and accepts token ID0 without mint/supply assumptions', async () => {
    const source = list(), { store, result } = await run(source), { projection } = await store.snapshot();
    expect(result).toMatchObject({ processed: 1, caughtUp: true }); expect(source.reads).toContainEqual([ra(10)]);
    expect(projection.items[`${ra(10)}:0`]).toMatchObject({ owner: m.marketplace.address, activeListingId: '1', firstObservedBlockNumber: '1' });
    expect(projection.collections[ra(10)]).not.toHaveProperty('creator'); expect(projection.collections[ra(10)]).not.toHaveProperty('totalMinted');
  });
  it('ignores pre-admission logs but captures later sparse non-mint transfers in that same block', async () => {
    const block = rBlock(1), source = new ReviewedFixtureSource().add(block, [rTransfer(block, 0, ra(8), ra(4), 55n), rAdmit(block, 1), rTransfer(block, 2, ra(4), ra(6), 9007199254740993n)]);
    const { store } = await run(source), { projection } = await store.snapshot();
    expect(Object.keys(projection.items)).toEqual([`${ra(10)}:9007199254740993`]); expect(Object.keys(projection.activity)).toHaveLength(2);
  });
  it('tracks sales/payout collisions and recipient forwarding before the Sold event', async () => {
    const source = list(), b = rBlock(2); source.events.get(1n)![2] = rListed(rBlock(1), 2, { royaltyRecipient: ra(4) });
    source.add(b, [rTransfer(b, 0, m.marketplace.address, ra(7)), rTransfer(b, 1, ra(7), ra(8)), rSold(b, 2, { royaltyRecipient: ra(4) })], '10000', '2');
    const { store } = await run(source), { projection } = await store.snapshot();
    expect(projection.items[`${ra(10)}:0`]).toMatchObject({ owner: ra(8), activeListingId: null });
    expect(projection.listings[`${m.marketplace.address}:1`]).toMatchObject({ status: 'sold', recipient: ra(7), platformFeeRaw: '200', sellerProceedsRaw: '9300' });
    expect(projection.claims[`${m.marketplace.address}:${ra(4)}`]).toMatchObject({ pendingRaw: '9800' });
    expect(projection.claims[`${m.marketplace.address}:accounting`]).toMatchObject({ pendingRaw: '10000', nextListingIdRaw: '2', marketDeployed: true });
  });
  it('cancels and continues observing transfers after revocation', async () => {
    const source = list(), b = rBlock(2); source.add(b, [rLog(b, m.registry.address, 'ReviewRevoked', { collection: ra(10), previousVersion: 1n, version: 2n }, 0), rTransfer(b, 1, m.marketplace.address, ra(4)), rLog(b, m.marketplace.address, 'Cancelled', { listingId: 1n, seller: ra(4), recipient: ra(4) }, 2), rTransfer(b, 3, ra(4), ra(8))], '0', '2');
    const { store } = await run(source), { projection } = await store.snapshot();
    expect(projection.collections[ra(10)]).toMatchObject({ active: false, reviewVersion: '2' }); expect(projection.items[`${ra(10)}:0`]).toMatchObject({ owner: ra(8), activeListingId: null });
  });
  it('handles pull claims with exact complete beneficiary pending and no active registry requirement', async () => {
    const source = list(), b = rBlock(2), c = rBlock(3); source.add(b, [rTransfer(b, 0, m.marketplace.address, ra(7)), rSold(b, 1)], '10000', '2');
    source.add(c, [rLog(c, m.marketplace.address, 'Claimed', { account: ra(4), recipient: ra(8), amount: 9300n }, 0)], '700', '2');
    const { store } = await run(source), { projection } = await store.snapshot(); expect(projection.claims[`${m.marketplace.address}:${ra(4)}`]).toMatchObject({ pendingRaw: '0', claimedRaw: '9300' });
  });
  it.each(['price', 'royalty', 'fee', 'recipient', 'missing-transfer'] as const)('atomically rejects mismatched settlement: %s', async kind => {
    const source = list(), store = new MemoryIndexerStore(); await run(source, store); const before = await store.snapshot(), b = rBlock(2);
    const fields = kind === 'price' ? { totalPrice: 10001n } : kind === 'royalty' ? { royaltyRecipient: ra(9) } : kind === 'fee' ? { platformFee: 201n, sellerProceeds: 9299n } : kind === 'recipient' ? { recipient: ra(8) } : {};
    source.add(b, [...(kind === 'missing-transfer' ? [] : [rTransfer(b, 0, m.marketplace.address, ra(7))]), rSold(b, 2, fields)], '10000', '2');
    await expect(run(source, store)).rejects.toBeDefined(); expect(await store.snapshot()).toEqual(before);
  });
  it('rejects missing listing IDs, malformed event bytes and unexplained escrow exits', async () => {
    for (const corrupt of ['sequence', 'bytes', 'escrow']) {
      const source = list(), store = new MemoryIndexerStore();
      if (corrupt === 'sequence') source.events.get(1n)![2] = rListed(rBlock(1), 2, { listingId: 2n });
      if (corrupt === 'bytes') source.events.get(1n)![2].data += '00';
      if (corrupt === 'escrow') source.events.get(1n)!.push(rTransfer(rBlock(1), 3, m.marketplace.address, ra(8)));
      await expect(run(source, store)).rejects.toBeDefined(); expect((await store.snapshot()).blocks).toHaveLength(0);
    }
  });
  it('checks onchain pending, market balance and next listing counter before committing', async () => {
    for (const bad of [{ pending: '1' }, { balance: '0', pending: '1' }, { nextListingId: '3' }]) {
      const source = list(), store = new MemoryIndexerStore(); Object.assign(source.states.get(1n)!, bad);
      await expect(run(source, store)).rejects.toMatchObject({ code: 'REVIEWED_ACCOUNTING_MISMATCH' }); expect((await store.snapshot()).blocks).toHaveLength(0);
    }
  });
  it('indexes registry-first deployment, then refuses a market that disappears after deployment', async () => {
    const source = new ReviewedFixtureSource().add(rBlock(1), [rAdmit(rBlock(1))], '0', '1', false).add(rBlock(2), [], '0', '1', true), store = new MemoryIndexerStore();
    await run(source, store); source.add(rBlock(3), [], '0', '1', false); await expect(run(source, store)).rejects.toMatchObject({ code: 'REVIEWED_ACCOUNTING_MISMATCH' }); expect((await store.snapshot()).blocks).toHaveLength(2);
  });
  it('rolls back admissions/items/listings/claim liabilities together on a reorg', async () => {
    const source = list(), b = rBlock(2); source.add(b, [rTransfer(b, 0, m.marketplace.address, ra(7)), rSold(b, 1)], '10000', '2');
    const { store } = await run(source); const fork = { ...rBlock(2, 1), parentHash: rBlock(1).hash }; source.add(fork, [rLog(fork, m.registry.address, 'ReviewRevoked', { collection: ra(10), previousVersion: 1n, version: 2n }, 0)], '0', '2');
    const { result } = await run(source, store), { projection } = await store.snapshot(); expect(result).toMatchObject({ rolledBack: 1, processed: 1 });
    expect(projection.claims[`${m.marketplace.address}:accounting`]).toMatchObject({ pendingRaw: '0' }); expect(projection.claims[`${m.marketplace.address}:${ra(4)}`]).toBeUndefined(); expect(projection.listings[`${m.marketplace.address}:1`]).toMatchObject({ status: 'active' });
  });
  it('does not roll back anything for a reorg deeper than its bound', async () => {
    const source = list().add(rBlock(2), [], '0', '2'), { store } = await run(source), before = await store.snapshot();
    source.add(rBlock(1, 1), [], '0', '1').add(rBlock(2, 1), [], '0', '1'); await expect(run(source, store, { maxReorgDepth: 1 })).rejects.toMatchObject({ code: 'REORG_TOO_DEEP' }); expect(await store.snapshot()).toEqual(before);
  });
  it('aborts an in-flight block before append and rejects out-of-scope/duplicate logs', async () => {
    const source = list(), store = new MemoryIndexerStore(), controller = new AbortController(), accounting = source.accounting.bind(source);
    source.accounting = async (...args) => { controller.abort(); return accounting(...args); }; await run(source, store, { signal: controller.signal }); expect((await store.snapshot()).blocks).toHaveLength(0);
    const other = list(); other.logs = vi.fn(async () => [rAdmit(rBlock(1)), rAdmit(rBlock(1))]); await expect(run(other)).rejects.toMatchObject({ code: 'REVIEWED_NFT_LOG_ORDER_INVALID' });
  });
  it('allows observed burns and re-mints without inventing total supply', async () => {
    const b = rBlock(1), source = new ReviewedFixtureSource().add(b, [rAdmit(b), rTransfer(b, 1, ra(4), zeroAddress, 99n), rTransfer(b, 2, zeroAddress, ra(8), 99n)]);
    const { store } = await run(source); expect((await store.snapshot()).projection.items[`${ra(10)}:99`]).toMatchObject({ owner: ra(8), burned: false });
  });
});
