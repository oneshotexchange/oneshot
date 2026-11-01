import { beforeEach, describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, keccak256, stringToHex, zeroAddress, zeroHash, type AbiEvent, type Address, type Hex } from 'viem';
import { collectionEvents, discoverCollections, factoryEvents, guardedMarketplaceEvents, marketplaceEvents, projectLogs } from '../src/events';
import { emptyProjection, type Block, type IndexerTransaction, type Manifest, type Projection, type ProjectionKind, type ProjectionValue, type RawLog } from '../src/types';

const addr = (suffix: string) => `0x${suffix.padStart(40, '0')}` as Address;
const hash = (byte: string) => `0x${byte.repeat(64)}` as Hex;
const factory = addr('fac1'), marketplace = addr('fac2'), collection = addr('c011'), unregistered = addr('c022');
const creator = addr('1'), alice = addr('2'), bob = addr('3'), other = addr('4');
const termsHash = hash('a'), contentHash = hash('b');
const manifest: Manifest = {
  schemaVersion: 1, deploymentVersion: 'oneshot-nft-v1', mode: 'local', chainId: 31337,
  genesisHash: hash('1'), startBlock: 1n, anchorHash: hash('2'),
  factory: { address: factory, codeHash: hash('3') }, marketplace: { address: marketplace, codeHash: hash('4') },
};
const largePrice = (1n << 180n) + 2n;
const guardedManifest: Manifest = { ...manifest, deploymentVersion: 'oneshot-nft-v2',
  listingAuthorization: { authority: other, salt: hash('c') } };
let nextIndex = 0;
beforeEach(() => { nextIndex = 0; });

function event(abi: readonly AbiEvent[], source: Address, name: string, args: Record<string, unknown>, patch: Partial<RawLog> = {}): RawLog {
  const definition = abi.find(entry => entry.name === name)!;
  const inputs = definition.inputs.filter(input => !input.indexed);
  return {
    address: source, topics: encodeEventTopics({ abi: [definition], eventName: name, args }) as Hex[],
    data: encodeAbiParameters(inputs, inputs.map(input => args[input.name!])),
    blockNumber: 1n, blockHash: hash('5'), transactionHash: hash('6'), transactionIndex: 0, logIndex: nextIndex++, ...patch,
  };
}
const created = (source = factory, destination = collection) => event(factoryEvents, source, 'CollectionCreated', { collection: destination, creator, name: 'oneshot originals', symbol: 'SHOT' });
const transfer = (from: Address, to: Address, tokenId = 1n) => event(collectionEvents, collection, 'Transfer', { from, to, tokenId });
function primary(quantity = 2n, totalPrice = largePrice) {
  const logs = [created(), event(collectionEvents, collection, 'TermsConfigured', { termsHash }),
    event(collectionEvents, collection, 'CollectionOpened', { termsHash, contentHash })];
  for (let tokenId = 1n; tokenId <= quantity; tokenId++) logs.push(transfer(zeroAddress, alice, tokenId));
  logs.push(minted(quantity, totalPrice));
  return logs;
}
function minted(quantity = 2n, totalPrice = largePrice, extra: Record<string, unknown> = {}) {
  const platformFee = totalPrice * 200n / 10_000n;
  return event(collectionEvents, collection, 'Minted', { payer: alice, recipient: alice, firstTokenId: 1n,
    quantity, totalPrice, platformFee, creatorProceeds: totalPrice - platformFee, allowlistStage: false, ...extra });
}
const itemKey = (tokenId = 1n) => `${collection}:${tokenId}`;
const nextBlock = (logs: RawLog[], blockNumber = 2n) => logs.map(log => ({ ...log, blockNumber, blockHash: hash('7'), transactionHash: hash('8') }));

class MemoryTransaction implements IndexerTransaction {
  projection: Projection = emptyProjection();
  async head(): Promise<Block | null> { return null; }
  async block(): Promise<Block | null> { return null; }
  async get(kind: ProjectionKind, id: string) { return structuredClone(this.projection[kind][id] || null); }
  async put(kind: ProjectionKind, id: string, value: ProjectionValue) { this.projection[kind][id] = structuredClone(value); }
  async remove(kind: ProjectionKind, id: string) { delete this.projection[kind][id]; }
  async list(kind: ProjectionKind) { return structuredClone(this.projection[kind]); }
  async append() {}
  async rollbackHead() {}
}
async function prepared() {
  const tx = new MemoryTransaction(); await projectLogs(tx, manifest, primary()); return tx;
}
function listing(price = largePrice) {
  return [transfer(alice, marketplace), event(marketplaceEvents, marketplace, 'Listed', {
    listingId: 1n, collection, tokenId: 1n, seller: alice, totalPrice: price,
  })];
}
async function listed(price = largePrice) {
  const tx = await prepared(); await projectLogs(tx, manifest, nextBlock(listing(price))); return tx;
}
function sale(price = largePrice, extra: Record<string, unknown> = {}) {
  const platformFee = price * 200n / 10_000n, royalty = price * 750n / 10_000n;
  return event(marketplaceEvents, marketplace, 'Sold', { listingId: 1n, buyer: bob, recipient: bob,
    totalPrice: price, platformFee, royalty, sellerProceeds: price - platformFee - royalty, ...extra });
}

describe('reviewed NFT event discovery and strict ABI decoding', () => {
  it('recognizes guarded policy commitments without adding public projection or activity', async () => {
    const tx = await prepared(), before = structuredClone(tx.projection);
    const policy = event(guardedMarketplaceEvents, marketplace, 'PolicyCommitted', {
      collection, previousCommitment: zeroHash, commitment: hash('d'),
    });
    await projectLogs(tx, guardedManifest, nextBlock([policy]));
    expect(tx.projection).toEqual(before);
    await expect(projectLogs(tx, manifest, nextBlock([policy]))).rejects.toThrow('EVENT_UNKNOWN_OR_INVALID');
  });

  it('validates guarded policy event collection, commitments and exact wire encoding', async () => {
    const tx = await prepared();
    for (const args of [
      { collection: unregistered, previousCommitment: zeroHash, commitment: hash('d') },
      { collection, previousCommitment: zeroHash, commitment: zeroHash },
      { collection, previousCommitment: hash('d'), commitment: hash('d') },
    ]) {
      await expect(projectLogs(tx, guardedManifest, nextBlock([
        event(guardedMarketplaceEvents, marketplace, 'PolicyCommitted', args),
      ]))).rejects.toThrow();
    }
    const policy = event(guardedMarketplaceEvents, marketplace, 'PolicyCommitted', {
      collection, previousCommitment: zeroHash, commitment: hash('d'),
    });
    await expect(projectLogs(tx, guardedManifest, nextBlock([{ ...policy, data: '0x00' }]))).rejects.toThrow();
  });

  it('discovers only the configured factory and normalizes addresses', () => {
    const logs = [created(unregistered, unregistered), created()];
    expect(discoverCollections(manifest, logs)).toEqual([collection]);
  });

  it('rejects duplicate registrations and factory events with zero or overlapping addresses', () => {
    expect(() => discoverCollections(manifest, [created(), created()])).toThrow('COLLECTION_DUPLICATE');
    expect(() => discoverCollections(manifest, [created(factory, zeroAddress)])).toThrow('EVENT_ADDRESS_INVALID');
    expect(() => discoverCollections(manifest, [created(factory, marketplace)])).toThrow('COLLECTION_INVALID');
  });

  it('rejects noncanonical ABI bytes, extra topics, and malformed known-source logs', () => {
    const valid = created();
    expect(() => discoverCollections(manifest, [{ ...valid, data: `${valid.data}00` }])).toThrow('EVENT_ENCODING_INVALID');
    expect(() => discoverCollections(manifest, [{ ...valid, topics: [...valid.topics, zeroHash] }])).toThrow();
    expect(() => discoverCollections(manifest, [{ ...valid, data: '0x00' }])).toThrow();
    expect(() => discoverCollections(manifest, [{ ...valid, topics: [hash('f')] }])).toThrow('EVENT_UNKNOWN_OR_INVALID');
  });

  it('rejects invalid byte lengths even if JavaScript string lengths fit', () => {
    const log = event(factoryEvents, factory, 'CollectionCreated', { collection, creator, name: '🎨'.repeat(26), symbol: 'SHOT' });
    expect(() => discoverCollections(manifest, [log])).toThrow('COLLECTION_INVALID');
  });

  it('rejects ambiguous positions and duplicate logs before projecting', async () => {
    const log = created(), tx = new MemoryTransaction();
    await expect(projectLogs(tx, manifest, [log, log])).rejects.toThrow('EVENT_DUPLICATE');
    await expect(projectLogs(tx, manifest, [log, { ...created(factory, unregistered), blockHash: hash('c') }])).rejects.toThrow('EVENT_POSITION_INVALID');
    await expect(projectLogs(tx, manifest, [{ ...log, logIndex: -1 }])).rejects.toThrow('EVENT_POSITION_INVALID');
  });
});

describe('collection hashes, mint conservation and standard ownership', () => {
  it('orders supplied logs and projects large exact amounts without losing precision', async () => {
    const tx = new MemoryTransaction(), logs = primary();
    await projectLogs(tx, manifest, [...logs].reverse());
    expect(tx.projection.collections[collection]).toMatchObject({
      factory, creator, name: 'oneshot originals', symbol: 'SHOT', configured: true, opened: true,
      termsHash, contentHash, totalMinted: '2', primaryTotalPrice: largePrice.toString(),
      primaryPlatformFee: (largePrice * 200n / 10_000n).toString(),
    });
    expect(tx.projection.items[itemKey()]).toMatchObject({ owner: alice, minted: true, burned: false, payer: alice });
    const activity = tx.projection.activity[`${hash('6')}:${logs.at(-1)!.logIndex}`]!;
    expect(activity).toMatchObject({ eventName: 'Minted', source: collection, chainId: 31337,
      schemaVersion: 1, deploymentVersion: 'oneshot-nft-v1', blockNumber: '1' });
    expect((activity.args as Record<string, unknown>).totalPrice).toBe(largePrice.toString());
    expect(() => JSON.stringify(tx.projection)).not.toThrow();
  });

  it('accepts free batches and independently checks every minted transfer', async () => {
    const tx = new MemoryTransaction(); await projectLogs(tx, manifest, primary(2n, 0n));
    expect(tx.projection.collections[collection]!.primaryPlatformFee).toBe('0');
    const missing = primary().filter(log => log !== undefined);
    missing.splice(4, 1);
    await expect(projectLogs(new MemoryTransaction(), manifest, missing)).rejects.toThrow('ITEM_UNKNOWN');
  });

  it('keeps a receiver callback transfer that happens before Minted', async () => {
    const logs = primary(1n), tx = new MemoryTransaction();
    const mint = logs.pop()!;
    logs.push(transfer(alice, bob));
    mint.logIndex = nextIndex++;
    logs.push(mint);
    await projectLogs(tx, manifest, logs);
    expect(tx.projection.items[itemKey()]).toMatchObject({ owner: bob, mintRecipient: alice, minted: true });
  });

  it('tracks external transfers, approvals and burns without retaining a stale owner', async () => {
    const tx = await prepared();
    const logs = [event(collectionEvents, collection, 'Approval', { owner: alice, approved: bob, tokenId: 1n }),
      event(collectionEvents, collection, 'ApprovalForAll', { owner: alice, operator: bob, approved: true }),
      transfer(alice, bob), transfer(bob, zeroAddress)];
    await projectLogs(tx, manifest, nextBlock(logs));
    expect(tx.projection.items[itemKey()]).toMatchObject({ owner: null, burned: true, approved: null, transferCount: '3' });
    await expect(projectLogs(tx, manifest, nextBlock([transfer(zeroAddress, other)], 3n))).rejects.toThrow('MINT_TRANSFER_INVALID');
  });

  it('rejects transfers and approvals from somebody other than the projected owner', async () => {
    const tx = await prepared();
    await expect(projectLogs(tx, manifest, nextBlock([transfer(bob, other)]))).rejects.toThrow('TRANSFER_OWNER_MISMATCH');
    await expect(projectLogs(tx, manifest, nextBlock([event(collectionEvents, collection, 'Approval', { owner: bob, approved: other, tokenId: 1n })]))).rejects.toThrow('APPROVAL_OWNER_MISMATCH');
  });

  it('requires matching frozen terms and prevents post-open configuration', async () => {
    const bad = primary();
    bad[2] = { ...event(collectionEvents, collection, 'CollectionOpened', { termsHash: hash('c'), contentHash }), logIndex: bad[2]!.logIndex };
    await expect(projectLogs(new MemoryTransaction(), manifest, bad)).rejects.toThrow('COLLECTION_OPEN_INVALID');
    const tx = await prepared();
    await expect(projectLogs(tx, manifest, nextBlock([event(collectionEvents, collection, 'TermsConfigured', { termsHash: hash('c') })]))).rejects.toThrow('COLLECTION_FROZEN');
  });

  it('rejects bad mint fees, nonconserving proceeds, sequence gaps and incomplete mint events', async () => {
    for (const extra of [{ platformFee: 1n }, { creatorProceeds: 1n }, { firstTokenId: 2n }, { quantity: 21n }]) {
      const logs = primary(); logs[logs.length - 1] = { ...minted(2n, largePrice, extra), logIndex: logs.at(-1)!.logIndex };
      await expect(projectLogs(new MemoryTransaction(), manifest, logs)).rejects.toThrow('MINT_ECONOMICS_INVALID');
    }
    const incomplete = primary(); incomplete.pop();
    await expect(projectLogs(new MemoryTransaction(), manifest, incomplete)).rejects.toThrow('MINT_EVENT_MISSING');
  });

  it('ignores unregistered contract logs and rejects unknown events on registered sources', async () => {
    const tx = await prepared(), spoof = { ...transfer(alice, bob), address: unregistered };
    const activityCount = Object.keys(tx.projection.activity).length;
    await projectLogs(tx, manifest, nextBlock([spoof]));
    expect(tx.projection.items[itemKey()]!.owner).toBe(alice);
    expect(Object.keys(tx.projection.activity)).toHaveLength(activityCount);
    const unknown = { ...transfer(alice, bob), topics: [keccak256(stringToHex('MetadataUpdate(uint256)'))] };
    await expect(projectLogs(tx, manifest, nextBlock([unknown]))).rejects.toThrow('EVENT_UNKNOWN_OR_INVALID');
    await expect(projectLogs(tx, manifest, nextBlock([{ ...created(), address: collection }]))).rejects.toThrow('EVENT_UNKNOWN_OR_INVALID');
  });

  it('rejects replayed events even when their local position is otherwise valid', async () => {
    const tx = await prepared();
    await expect(projectLogs(tx, manifest, [primary()[0]!])).rejects.toThrow('COLLECTION_DUPLICATE');
    const original = primary()[1]!;
    original.logIndex = 1;
    await expect(projectLogs(tx, manifest, [original])).rejects.toThrow('EVENT_DUPLICATE');
  });
});

describe('escrow marketplace and cumulative claims', () => {
  it('requires an escrow transfer for every listing and a registered collection', async () => {
    const tx = await prepared();
    await expect(projectLogs(tx, manifest, nextBlock([listing()[1]!]))).rejects.toThrow('ESCROW_TRANSFER_MISSING');
    const fake = event(marketplaceEvents, marketplace, 'Listed', { listingId: 1n, collection: unregistered, tokenId: 1n, seller: alice, totalPrice: largePrice });
    await expect(projectLogs(tx, manifest, nextBlock([fake]))).rejects.toThrow('COLLECTION_UNKNOWN');
  });

  it('records escrow sale splits and the actual final owner after receiver callbacks', async () => {
    const tx = await listed();
    expect(tx.projection.listings['1']).toMatchObject({ status: 'active', seller: alice, totalPrice: largePrice.toString() });
    const logs = [transfer(marketplace, bob), transfer(bob, other), sale()];
    await projectLogs(tx, manifest, nextBlock(logs, 3n));
    expect(tx.projection.items[itemKey()]).toMatchObject({ owner: other, activeListingId: null, escrowRelease: null });
    expect(tx.projection.listings['1']).toMatchObject({ status: 'sold', buyer: bob, recipient: bob,
      platformFee: (largePrice * 200n / 10_000n).toString(), royalty: (largePrice * 750n / 10_000n).toString() });
    await expect(projectLogs(tx, manifest, nextBlock([sale()], 4n))).rejects.toThrow('LISTING_INACTIVE');
  });

  it('allows seller-controlled cancellation to a recovery recipient', async () => {
    const tx = await listed();
    await projectLogs(tx, manifest, nextBlock([transfer(marketplace, other), event(marketplaceEvents, marketplace, 'Cancelled', { listingId: 1n, seller: alice, recipient: other })], 3n));
    expect(tx.projection.items[itemKey()]).toMatchObject({ owner: other, activeListingId: null });
    expect(tx.projection.listings['1']).toMatchObject({ status: 'cancelled', recipient: other });
  });

  it('rejects wrong sellers, missing release transfers, and incomplete settlements', async () => {
    const tx = await listed();
    await expect(projectLogs(tx, manifest, nextBlock([sale()], 3n))).rejects.toThrow('ESCROW_TRANSFER_MISSING');
    const released = transfer(marketplace, other);
    const wrongSeller = event(marketplaceEvents, marketplace, 'Cancelled', { listingId: 1n, seller: bob, recipient: other });
    await expect(projectLogs(tx, manifest, nextBlock([released, wrongSeller], 3n))).rejects.toThrow('LISTING_SELLER_MISMATCH');
    const fresh = await listed();
    await expect(projectLogs(fresh, manifest, nextBlock([transfer(marketplace, bob)], 3n))).rejects.toThrow('ESCROW_SETTLEMENT_MISSING');
  });

  it('rejects wrong sale price, fee, excessive royalty, self-purchase and nonconservation', async () => {
    for (const extra of [
      { totalPrice: largePrice + 1n }, { platformFee: 1n }, { royalty: largePrice / 10n + 1n },
      { buyer: alice }, { sellerProceeds: 1n },
    ]) {
      const tx = await listed();
      await expect(projectLogs(tx, manifest, nextBlock([transfer(marketplace, bob), sale(largePrice, extra)], 3n))).rejects.toThrow('SALE_ECONOMICS_INVALID');
    }
  });

  it('rejects listing identifier gaps and duplicate active listings', async () => {
    const tx = await prepared();
    const gap = event(marketplaceEvents, marketplace, 'Listed', { listingId: 2n, collection, tokenId: 1n, seller: alice, totalPrice: largePrice });
    await expect(projectLogs(tx, manifest, nextBlock([transfer(alice, marketplace), gap]))).rejects.toThrow('LISTING_SEQUENCE_INVALID');
    const fresh = await listed();
    await expect(projectLogs(fresh, manifest, nextBlock([listing()[1]!], 3n))).rejects.toThrow('LISTING_INVALID');
  });

  it('records cumulative actual claims independently per contract and beneficiary', async () => {
    const tx = await prepared();
    const claim = (source: Address, account: Address, recipient: Address, amount: bigint) => event(source === marketplace ? marketplaceEvents : collectionEvents, source, 'Claimed', { account, recipient, amount });
    await projectLogs(tx, manifest, nextBlock([claim(collection, creator, creator, largePrice), claim(collection, creator, other, 7n), claim(marketplace, creator, other, 9n)]));
    expect(tx.projection.claims[`${collection}:${creator}`]).toMatchObject({ beneficiary: creator, recipient: other,
      totalClaimed: (largePrice + 7n).toString(), lastAmount: '7' });
    expect(tx.projection.claims[`${marketplace}:${creator}`]!.totalClaimed).toBe('9');
    expect(tx.projection.collections[collection]!.totalClaimed).toBe((largePrice + 7n).toString());
    await expect(projectLogs(tx, manifest, nextBlock([claim(collection, creator, creator, 0n)], 3n))).rejects.toThrow('CLAIM_INVALID');
  });
});
