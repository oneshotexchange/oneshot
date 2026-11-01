import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, parseAbi, zeroAddress, zeroHash, type AbiEvent, type Address, type Hex } from 'viem';
import { syncIndexer } from '../src/engine';
import { MemoryIndexerStore } from '../src/store';
import type { Block, ChainSource, Manifest, RawLog } from '../src/types';

const hash = (value: bigint | number): Hex => `0x${BigInt(value).toString(16).padStart(64, '0')}`;
const address = (value: number): Address => `0x${value.toString(16).padStart(40, '0')}`;
const factory = address(1), marketplace = address(2), creator = address(3);
const original = address(10), orphan = address(11), replacement = address(12);
const manifest: Manifest = {
  schemaVersion: 1, deploymentVersion: 'oneshot-nft-v1', mode: 'local', chainId: 31337,
  genesisHash: hash(100), startBlock: 1n, anchorHash: hash(100),
  factory: { address: factory, codeHash: hash(200) }, marketplace: { address: marketplace, codeHash: hash(201) },
};
// Independent ABI declarations ensure the engine fixtures use actual contract wire encodings.
const factoryAbi = parseAbi(['event CollectionCreated(address indexed collection, address indexed creator, string name, string symbol)']);
const collectionAbi = parseAbi([
  'event TermsConfigured(bytes32 indexed termsHash)',
  'event CollectionOpened(bytes32 indexed termsHash, bytes32 indexed contentHash)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
  'event Minted(address indexed payer, address indexed recipient, uint256 firstTokenId, uint256 quantity, uint256 totalPrice, uint256 platformFee, uint256 creatorProceeds, bool allowlistStage)',
  'event Claimed(address indexed account, address indexed recipient, uint256 amount)',
]);
const marketAbi = parseAbi(['event Listed(uint256 indexed listingId, address indexed collection, uint256 indexed tokenId, address seller, uint256 totalPrice)']);

function eventLog(block: Block, source: Address, abi: readonly AbiEvent[], eventName: string,
  args: Record<string, unknown>, logIndex: number, transactionIndex = 0): RawLog {
  const definition = abi.find(event => event.name === eventName)!;
  return {
    address: source, blockNumber: block.number, blockHash: block.hash,
    transactionHash: hash(BigInt(block.hash) + 10_000n + BigInt(transactionIndex)), transactionIndex, logIndex,
    topics: encodeEventTopics({ abi, eventName, args }) as Hex[],
    data: encodeAbiParameters(definition.inputs.filter(input => !input.indexed),
      definition.inputs.filter(input => !input.indexed).map(input => args[input.name!])),
  };
}
function created(block: Block, collection = original, logIndex = 0): RawLog {
  return eventLog(block, factory, factoryAbi, 'CollectionCreated', { collection, creator, name: 'Oneshot', symbol: 'ONE' }, logIndex);
}
function configured(block: Block, collection: Address, logIndex: number, transactionIndex = 0): RawLog {
  return eventLog(block, collection, collectionAbi, 'TermsConfigured', { termsHash: hash(300) }, logIndex, transactionIndex);
}
function lifecycle(block: Block, collection: Address): RawLog[] {
  return [
    created(block, collection), configured(block, collection, 1, 1),
    eventLog(block, collection, collectionAbi, 'CollectionOpened', { termsHash: hash(300), contentHash: hash(301) }, 2, 2),
    eventLog(block, collection, collectionAbi, 'Transfer', { from: zeroAddress, to: creator, tokenId: 1n }, 3, 3),
    eventLog(block, collection, collectionAbi, 'Minted', {
      payer: creator, recipient: creator, firstTokenId: 1n, quantity: 1n, totalPrice: 100n,
      platformFee: 2n, creatorProceeds: 98n, allowlistStage: false,
    }, 4, 3),
    eventLog(block, collection, collectionAbi, 'Transfer', { from: creator, to: marketplace, tokenId: 1n }, 5, 4),
    eventLog(block, marketplace, marketAbi, 'Listed', {
      listingId: 1n, collection, tokenId: 1n, seller: creator, totalPrice: 150n,
    }, 6, 4),
    eventLog(block, collection, collectionAbi, 'Claimed', { account: creator, recipient: creator, amount: 98n }, 7, 5),
  ];
}

class FakeChain implements ChainSource {
  blocks = new Map<bigint, Block>();
  records = new Map<bigint, RawLog[]>();
  requests: { block: Block; addresses: Address[] }[] = [];
  verified: Manifest[] = [];
  logHook?: (block: Block, addresses: readonly Address[]) => Promise<RawLog[]>;
  blockHook?: (number: bigint) => Promise<Block>;
  constructor(height = 3) {
    this.blocks.set(0n, { number: 0n, hash: manifest.genesisHash, parentHash: hash(0), timestamp: 0n });
    this.fork(1, height, 1_000);
  }
  fork(from: number, height: number, branch: number): void {
    for (const number of [...this.blocks.keys()]) if (number >= BigInt(from)) this.blocks.delete(number);
    for (const number of [...this.records.keys()]) if (number >= BigInt(from)) this.records.delete(number);
    for (let number = from; number <= height; number++) {
      const previous = this.blocks.get(BigInt(number - 1))!;
      this.blocks.set(BigInt(number), { number: BigInt(number), hash: hash(branch + number), parentHash: previous.hash, timestamp: BigInt(number) });
    }
  }
  async verify(input: Manifest): Promise<void> { this.verified.push(input); }
  async height(): Promise<bigint> { return [...this.blocks.keys()].reduce((left, right) => left > right ? left : right, 0n); }
  async block(number: bigint): Promise<Block> {
    if (this.blockHook) return this.blockHook(number);
    const block = this.blocks.get(number);
    if (!block) throw new Error(`No fixture block ${number}`);
    return { ...block };
  }
  async logs(block: Block, addresses: readonly Address[]): Promise<RawLog[]> {
    this.requests.push({ block, addresses: [...addresses] });
    if (this.logHook) return this.logHook(block, addresses);
    return (this.records.get(block.number) ?? []).filter(log => addresses.includes(log.address));
  }
}

describe('bounded local indexer engine', () => {
  it('stops between atomic blocks and resumes from its last committed checkpoint', async () => {
    const source = new FakeChain(3), store = new MemoryIndexerStore(), controller = new AbortController();
    source.records.set(1n, [created(source.blocks.get(1n)!)]);
    source.logHook = async (at, addresses) => {
      if (at.number === 2n) controller.abort();
      return (source.records.get(at.number) ?? []).filter(log => addresses.includes(log.address));
    };
    expect(await syncIndexer(source, store, manifest, { signal: controller.signal }))
      .toMatchObject({ processed: 1, head: { number: 1n }, caughtUp: false });
    expect((await store.snapshot()).blocks.map(entry => entry.block.number)).toEqual([1n]);
    expect(source.requests.some(request => request.block.number === 3n)).toBe(false);
    source.logHook = undefined;
    expect(await syncIndexer(source, store, manifest)).toMatchObject({ processed: 2, head: { number: 3n }, caughtUp: true });
    expect(Object.keys((await store.snapshot()).projection.collections)).toEqual([original]);
  });

  it('preserves the complete previous branch when stopped during ancestor discovery', async () => {
    const source = new FakeChain(3), store = new MemoryIndexerStore(), controller = new AbortController();
    source.records.set(2n, [created(source.blocks.get(2n)!)]);
    await syncIndexer(source, store, manifest); const before = await store.snapshot();
    source.fork(2, 3, 5_000);
    source.blockHook = async number => { if (number === 2n) controller.abort(); return source.blocks.get(number)!; };
    expect(await syncIndexer(source, store, manifest, { signal: controller.signal }))
      .toMatchObject({ processed: 0, rolledBack: 0, head: { number: 3n }, caughtUp: false });
    expect(await store.snapshot()).toEqual(before);
    source.blockHook = undefined;
    expect(await syncIndexer(source, store, manifest)).toMatchObject({ processed: 2, rolledBack: 2, caughtUp: true });
  });

  it('journals guarded policy events without public writes and cleanly rolls them back on a reorg', async () => {
    const guardedManifest: Manifest = { ...manifest, deploymentVersion: 'oneshot-nft-v2',
      listingAuthorization: { authority: address(4), salt: hash(999) } };
    const abi = parseAbi(['event PolicyCommitted(address indexed collection, bytes32 indexed previousCommitment, bytes32 indexed commitment)']);
    const source = new FakeChain(2), store = new MemoryIndexerStore();
    source.records.set(1n, [created(source.blocks.get(1n)!)]);
    const policy = eventLog(source.blocks.get(2n)!, marketplace, abi, 'PolicyCommitted', {
      collection: original, previousCommitment: zeroHash, commitment: hash(888),
    }, 0);
    source.records.set(2n, [policy]);
    await syncIndexer(source, store, guardedManifest);
    const before = await store.snapshot();
    expect(before.blocks[1].logs).toEqual([policy]);
    expect(before.blocks[1].undo).toEqual([]);
    expect(Object.keys(before.projection.activity)).toHaveLength(1);
    expect(Object.values(before.projection.activity).map(row => row.eventName)).toEqual(['CollectionCreated']);
    source.fork(2, 2, 8_000);
    expect(await syncIndexer(source, store, guardedManifest)).toMatchObject({ rolledBack: 1, processed: 1 });
    const after = await store.snapshot();
    expect(after.blocks[1].logs).toEqual([]);
    expect(after.projection).toEqual(before.projection);
  });

  it('advances through empty blocks in bounded passes and replays without duplicate journal entries', async () => {
    const source = new FakeChain(5), store = new MemoryIndexerStore();
    const first = await syncIndexer(source, store, manifest, { maxBlocks: 2 });
    expect(first).toMatchObject({ processed: 2, rolledBack: 0, caughtUp: false, target: 5n, head: { number: 2n } });
    expect((await store.snapshot()).blocks.map(entry => entry.block.number)).toEqual([1n, 2n]);
    const second = await syncIndexer(source, store, manifest, { maxBlocks: 2 });
    expect(second).toMatchObject({ processed: 2, head: { number: 4n }, caughtUp: false });
    expect(await syncIndexer(source, store, manifest, { maxBlocks: 2 })).toMatchObject({ processed: 1, caughtUp: true });
    const checkpoint = await store.snapshot();
    expect(await syncIndexer(source, store, manifest)).toMatchObject({ processed: 0, rolledBack: 0 });
    expect(await store.snapshot()).toEqual(checkpoint);
    expect(checkpoint.blocks.every(entry => entry.logs.length === 0)).toBe(true);
    expect(source.verified).toHaveLength(4);
  });

  it('discovers factory-created collections before reading their events in the same block', async () => {
    const source = new FakeChain(1), store = new MemoryIndexerStore();
    source.records.set(1n, lifecycle(source.blocks.get(1n)!, original));
    expect(await syncIndexer(source, store, manifest)).toMatchObject({ processed: 1, caughtUp: true });
    const snapshot = await store.snapshot();
    expect(source.requests.map(request => request.addresses)).toEqual([[factory, marketplace], [original]]);
    expect(snapshot.blocks[0].logs.map(log => log.logIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(snapshot.projection.collections[original]).toMatchObject({ configured: true, opened: true, totalMinted: '1', primaryTotalPrice: '100' });
    expect(snapshot.projection.items[`${original}:1`]).toMatchObject({ owner: marketplace, minted: true, activeListingId: '1' });
    expect(snapshot.projection.listings['1']).toMatchObject({ collection: original, status: 'active', totalPrice: '150' });
    expect(snapshot.projection.claims[`${original}:${creator}`]).toMatchObject({ totalClaimed: '98' });
    expect(Object.keys(snapshot.projection.activity)).toHaveLength(8);
    await syncIndexer(source, store, manifest);
    expect(await store.snapshot()).toEqual(snapshot);
  });

  it('rolls back orphaned logs and every projection before replaying a replacement branch', async () => {
    const source = new FakeChain(3), store = new MemoryIndexerStore();
    source.records.set(1n, [created(source.blocks.get(1n)!)]);
    source.records.set(2n, lifecycle(source.blocks.get(2n)!, orphan));
    await syncIndexer(source, store, manifest);
    const old = await store.snapshot();
    expect(old.projection.collections[orphan]).toBeDefined();
    const orphanedHashes = old.blocks.slice(1).map(entry => entry.block.hash);
    source.fork(2, 3, 2_000);
    source.records.set(2n, [created(source.blocks.get(2n)!, replacement)]);
    expect(await syncIndexer(source, store, manifest)).toMatchObject({ rolledBack: 2, processed: 2, caughtUp: true });
    const replayed = await store.snapshot();
    expect(Object.keys(replayed.projection.collections).sort()).toEqual([original, replacement]);
    for (const kind of ['items', 'listings', 'claims'] as const) expect(replayed.projection[kind]).toEqual({});
    expect(Object.keys(replayed.projection.activity)).toHaveLength(2);
    expect(replayed.blocks.flatMap(entry => entry.logs).every(log => !orphanedHashes.includes(log.blockHash))).toBe(true);
    expect(replayed.blocks[0]).toEqual(old.blocks[0]);
    expect(source.requests.filter(request => request.block.hash === source.blocks.get(3n)!.hash).map(request => request.addresses))
      .toEqual([[factory, marketplace], [original, replacement]]);
  });

  it('preserves the full checkpoint when a reorganization exceeds the configured depth', async () => {
    const source = new FakeChain(4), store = new MemoryIndexerStore();
    source.records.set(1n, [created(source.blocks.get(1n)!)]);
    await syncIndexer(source, store, manifest);
    const before = await store.snapshot();
    source.fork(2, 4, 3_000);
    await expect(syncIndexer(source, store, manifest, { maxReorgDepth: 2 })).rejects.toMatchObject({ code: 'REORG_TOO_DEEP' });
    expect(await store.snapshot()).toEqual(before);
  });

  it('can replace the entire indexed branch from its unchanged deployment anchor', async () => {
    const source = new FakeChain(2), store = new MemoryIndexerStore();
    source.records.set(1n, [created(source.blocks.get(1n)!)]);
    await syncIndexer(source, store, manifest);
    source.fork(1, 2, 4_000);
    source.records.set(1n, [created(source.blocks.get(1n)!, replacement)]);
    expect(await syncIndexer(source, store, manifest)).toMatchObject({ rolledBack: 2, processed: 2 });
    expect(Object.keys((await store.snapshot()).projection.collections)).toEqual([replacement]);
  });

  it('refuses a changed deployment anchor before undoing the existing checkpoint', async () => {
    const source = new FakeChain(2), store = new MemoryIndexerStore();
    await syncIndexer(source, store, manifest);
    const before = await store.snapshot();
    source.blocks.set(0n, { ...source.blocks.get(0n)!, hash: hash(999) });
    source.fork(1, 2, 5_000);
    await expect(syncIndexer(source, store, manifest)).rejects.toMatchObject({ code: 'DEPLOYMENT_ANCHOR_CHANGED' });
    expect(await store.snapshot()).toEqual(before);
  });

  it('rolls back a cursor beyond a shortened chain without fetching nonexistent blocks', async () => {
    const source = new FakeChain(3), store = new MemoryIndexerStore();
    source.records.set(3n, [created(source.blocks.get(3n)!, orphan)]);
    await syncIndexer(source, store, manifest);
    source.fork(3, 2, 5_000);
    expect(await syncIndexer(source, store, manifest)).toMatchObject({ rolledBack: 1, processed: 0, target: 2n, head: { number: 2n } });
    const snapshot = await store.snapshot();
    expect(snapshot.blocks.map(entry => entry.block.number)).toEqual([1n, 2n]);
    expect(snapshot.projection.collections).toEqual({});
    expect(snapshot.projection.activity).toEqual({});
  });

  it('never commits a block whose hash changes while its logs are read', async () => {
    const source = new FakeChain(1), store = new MemoryIndexerStore();
    const first = source.blocks.get(1n)!;
    source.records.set(1n, [created(first)]);
    let reads = 0;
    source.blockHook = async number => number === 1n && ++reads > 1 ? { ...first, hash: hash(888) } : source.blocks.get(number)!;
    await expect(syncIndexer(source, store, manifest)).rejects.toMatchObject({ code: 'CHAIN_MOVED' });
    expect((await store.snapshot()).blocks).toEqual([]);
    expect((await store.snapshot()).projection.collections).toEqual({});
  });

  it('rejects a block that is not a child of the current cursor', async () => {
    const source = new FakeChain(1), store = new MemoryIndexerStore();
    source.blocks.set(1n, { ...source.blocks.get(1n)!, parentHash: hash(900) });
    await expect(syncIndexer(source, store, manifest)).rejects.toMatchObject({ code: 'CHAIN_MOVED' });
    expect((await store.snapshot()).blocks).toEqual([]);
  });

  it.each([
    ['unrequested primary source', (log: RawLog) => [{ ...log, address: address(999) }], 'UNREQUESTED_LOG_SOURCE'],
    ['malformed factory encoding', (log: RawLog) => [{ ...log, data: '0x' as Hex }], 'EVENT_UNKNOWN_OR_INVALID'],
    ['duplicate position', (log: RawLog) => [log, log], 'EVENT_DUPLICATE'],
    ['wrong block hash', (log: RawLog) => [{ ...log, blockHash: hash(999) }], 'LOG_ORDER_INVALID'],
    ['wrong block number', (log: RawLog) => [{ ...log, blockNumber: 2n }], 'LOG_ORDER_INVALID'],
  ] as const)('does not advance on %s', async (_label, mutate, code) => {
    const source = new FakeChain(1), store = new MemoryIndexerStore();
    const log = created(source.blocks.get(1n)!);
    source.logHook = async (_block, addresses) => addresses.includes(factory) ? [...mutate(log)] : [];
    await expect(syncIndexer(source, store, manifest)).rejects.toMatchObject({ code });
    const snapshot = await store.snapshot();
    expect(snapshot.blocks).toEqual([]);
    expect(snapshot.projection.collections).toEqual({});
    expect(snapshot.projection.activity).toEqual({});
  });

  it('refuses an unrequested collection in a secondary log response', async () => {
    const source = new FakeChain(1), store = new MemoryIndexerStore();
    const block = source.blocks.get(1n)!;
    source.logHook = async (_block, addresses) => addresses.includes(factory)
      ? [created(block)] : [configured(block, orphan, 1)];
    await expect(syncIndexer(source, store, manifest)).rejects.toMatchObject({ code: 'UNREQUESTED_LOG_SOURCE' });
    expect((await store.snapshot()).blocks).toEqual([]);
  });

  it('rejects duplicate positions spanning the factory and child response batches', async () => {
    const source = new FakeChain(1), store = new MemoryIndexerStore();
    const block = source.blocks.get(1n)!;
    source.records.set(1n, [created(block), configured(block, original, 0)]);
    await expect(syncIndexer(source, store, manifest)).rejects.toMatchObject({ code: 'LOG_ORDER_INVALID' });
    expect((await store.snapshot()).blocks).toEqual([]);
    expect((await store.snapshot()).projection.collections).toEqual({});
  });

  it('keeps the cursor and projections atomic when projection fails after a valid creation', async () => {
    const source = new FakeChain(1), store = new MemoryIndexerStore();
    const block = source.blocks.get(1n)!;
    source.records.set(1n, [created(block), eventLog(block, original, collectionAbi, 'CollectionOpened', {
      termsHash: hash(300), contentHash: hash(301),
    }, 1)]);
    await expect(syncIndexer(source, store, manifest)).rejects.toMatchObject({ code: 'COLLECTION_OPEN_INVALID' });
    expect(await store.snapshot()).toMatchObject({ blocks: [], projection: { collections: {}, activity: {} } });
  });

  it('allows only one concurrent pass to commit the same next block', async () => {
    const source = new FakeChain(1), store = new MemoryIndexerStore();
    let reached = 0, release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    source.logHook = async (block, addresses) => {
      if (!addresses.includes(factory)) return [];
      if (++reached === 2) release();
      await barrier;
      return [created(block)];
    };
    const outcomes = await Promise.allSettled([syncIndexer(source, store, manifest), syncIndexer(source, store, manifest)]);
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(outcome => outcome.status === 'rejected').map(outcome => outcome.reason)).toEqual([
      expect.objectContaining({ code: 'CONCURRENT_SYNC' }),
    ]);
    const snapshot = await store.snapshot();
    expect(snapshot.blocks).toHaveLength(1);
    expect(Object.keys(snapshot.projection.collections)).toEqual([original]);
    expect(Object.keys(snapshot.projection.activity)).toHaveLength(1);
  });

  it('treats confirmation depth as an indexing delay and still repairs confirmed local reorgs', async () => {
    const source = new FakeChain(5), store = new MemoryIndexerStore();
    expect(await syncIndexer(source, store, manifest, { confirmationDepth: 2 })).toMatchObject({ target: 3n, head: { number: 3n }, processed: 3 });
    source.fork(3, 5, 6_000);
    source.records.set(3n, [created(source.blocks.get(3n)!, replacement)]);
    expect(await syncIndexer(source, store, manifest, { confirmationDepth: 2 })).toMatchObject({ target: 3n, rolledBack: 1, processed: 1 });
    expect((await store.snapshot()).blocks.map(entry => entry.block.number)).toEqual([1n, 2n, 3n]);
    expect(Object.keys((await store.snapshot()).projection.collections)).toEqual([replacement]);
  });

  it('does no work before the deployment reaches the requested confirmation depth', async () => {
    const source = new FakeChain(1), store = new MemoryIndexerStore();
    expect(await syncIndexer(source, store, manifest, { confirmationDepth: 5 })).toMatchObject({ processed: 0, target: 0n, head: null });
    expect(source.requests).toEqual([]);
  });

  it('never reuses a manifest-bound cursor for another deployment configuration', async () => {
    const source = new FakeChain(2), store = new MemoryIndexerStore();
    await syncIndexer(source, store, manifest);
    const before = await store.snapshot();
    await expect(syncIndexer(source, store, { ...manifest, marketplace: { ...manifest.marketplace, codeHash: hash(999) } }))
      .rejects.toMatchObject({ code: 'MANIFEST_MISMATCH' });
    expect(await store.snapshot()).toEqual(before);
  });

  it.each([{ maxBlocks: 0 }, { maxBlocks: 1001 }, { confirmationDepth: -1 }, { maxReorgDepth: 0 }, { maxBlocks: 1.5 }])
    ('rejects invalid options before querying the chain: %j', async options => {
      const source = new FakeChain(1), store = new MemoryIndexerStore();
      await expect(syncIndexer(source, store, manifest, options)).rejects.toMatchObject({ code: 'SYNC_OPTIONS_INVALID' });
      expect(source.verified).toEqual([]);
    });
});
