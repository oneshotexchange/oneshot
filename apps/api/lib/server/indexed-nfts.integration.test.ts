import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { createIndexedNftReader, type IndexedReaderDependencies } from './indexed-nfts';
import { api } from './http';
import { manifestId, parseManifest } from '../../../indexer/src/manifest';
import { PostgresIndexerStore, type SqlPool } from '../../../indexer/src/store';
import type { Block, ChainSource, IndexerTransaction, Manifest, ProjectionValue } from '../../../indexer/src/types';
import { BASE_SEPOLIA_GENESIS_HASH } from '@oneshot/evm';
import { encodeFollowedWallets } from '../../../web/lib/wallet-following';

// This suite can never fall back to an ambient application/production database.
const databaseUrl = process.env.ONESHOT_API_TEST_DATABASE_URL;
const hash = (value: number): `0x${string}` => `0x${value.toString(16).padStart(64, '0')}`;
const address = (value: number): `0x${string}` => `0x${value.toString(16).padStart(40, '0')}`;
const factory = address(1), market = address(2), collection = address(3), otherCollection = address(4);
const alice = address(7), bob = address(8), recipient = address(9);
const exactPrice = '9007199254740993123456789';

type Fixture = {
  pool: Pool; store: PostgresIndexerStore; manifest: Manifest; deploymentId: string;
  canonical: Map<bigint, Block>;
  read(path: string, contentResolver?: IndexedReaderDependencies['contentResolver']): Promise<Response>;
  reader(poolOverride?: SqlPool): ReturnType<typeof createIndexedNftReader>;
  meta(block?: bigint): ProjectionValue;
};
function block(number: bigint, ownHash = hash(Number(number) + 100), parentHash = hash(Number(number) + 99)): Block {
  return { number, hash: ownHash, parentHash, timestamp: 1_700_000_000n + number };
}
async function withDatabase(run: (fixture: Fixture) => Promise<void>, baseSepolia = false) {
  if (!databaseUrl) throw new Error('ONESHOT_API_TEST_DATABASE_URL is required');
  const configuration = { connectionString: databaseUrl, max: 3, connectionTimeoutMillis: 5000, idleTimeoutMillis: 1000, statement_timeout: 10_000 };
  const pool = new Pool(configuration);
  const store = new PostgresIndexerStore(new Pool(configuration));
  const genesis = `0x${createHash('sha256').update(randomUUID()).digest('hex')}`;
  const manifest = parseManifest({ schemaVersion: 1, deploymentVersion: 'oneshot-nft-v1', mode: baseSepolia?'base-sepolia':'local', chainId: baseSepolia?84532:31337,
    genesisHash: baseSepolia?BASE_SEPOLIA_GENESIS_HASH:genesis, startBlock: '1', anchorHash: baseSepolia?BASE_SEPOLIA_GENESIS_HASH:hash(100),
    // A random code identity isolates the simulated Base fixture without changing its pinned genesis.
    factory: { address: factory, codeHash: baseSepolia?genesis:hash(20) }, marketplace: { address: market, codeHash: hash(21) },
  });
  const id = manifestId(manifest);
  const canonical = new Map<bigint, Block>([[0n, block(0n)], [1n, block(1n)], [2n, block(2n)], [3n, block(3n)]]);
  if (baseSepolia) {canonical.set(0n,block(0n,BASE_SEPOLIA_GENESIS_HASH));canonical.set(1n,block(1n,hash(101),BASE_SEPOLIA_GENESIS_HASH));}
  const source: ChainSource = {
    async verify(observed) { expect(observed).toEqual(manifest); },
    async height() { return [...canonical.keys()].reduce((maximum, number) => number > maximum ? number : maximum, 0n); },
    async block(number) { const value = canonical.get(number); if (!value) throw new Error('Missing local test block'); return value; },
    async logs() { throw new Error('Public reads must never request event ingestion'); },
  };
  const env: Record<string, string | undefined> = { ONESHOT_INDEXER_READS_ENABLED: 'true', ONESHOT_NETWORK: manifest.mode, DATABASE_URL: databaseUrl, ONESHOT_INDEXER_MANIFEST_PATH: 'injected-local-test-manifest.json' };
  const reader = (poolOverride: SqlPool = pool, contentResolver?: IndexedReaderDependencies['contentResolver']) => createIndexedNftReader({ pool: () => poolOverride, loadManifest: async () => manifest, source: async () => source, env: () => env, ...(contentResolver ? { contentResolver } : {}) });
  const serve = (handler: ReturnType<typeof createIndexedNftReader>, path: string) => api(request => handler(request))(
    new NextRequest(`http://localhost/api/oneshot/indexed${path}`), {},
  );
  let initialized = false;
  try {
    await store.initialize(id); initialized = true;
    await run({ pool, store, manifest, deploymentId: id, canonical, reader,
      read: (path, contentResolver) => serve(reader(pool, contentResolver), path),
      meta(number = 1n) { const at = canonical.get(number)!; return { schemaVersion: 1, deploymentVersion: 'oneshot-nft-v1', chainId: manifest.chainId,
        lastBlockNumber: number.toString(), lastBlockHash: at.hash, lastTransactionHash: hash(500), lastLogIndex: 0 }; },
    });
  } finally {
    try {
      if (initialized) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          for (const table of ['oneshot_evm_logs', 'oneshot_evm_journal', 'oneshot_evm_projections', 'oneshot_evm_deployments']) {
            // Table names are constants; cleanup is scoped to this fixture's random manifest.
            await client.query(`DELETE FROM ${table} WHERE manifest_id=$1`, [id]);
          }
          await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
      }
    } finally { try { await store.close(); } finally { await pool.end(); } }
  }
}

function collectionRow(fixture: Fixture, name = 'Indexed originals', at = collection) {
  const fee = BigInt(exactPrice) * 200n / 10_000n;
  return { address: at, creator: alice, factory, name, symbol: 'SHOT', configured: true, opened: true,
    termsHash: hash(30), contentHash: hash(31), totalMinted: '3', primaryTotalPrice: exactPrice,
    primaryPlatformFee: fee.toString(), primaryCreatorProceeds: (BigInt(exactPrice) - fee).toString(), totalClaimed: '50',
    serverOnlyPath: 'C:/private/projection-secret', privateEndpoint: 'https://private-rpc/secret-api-key', ...fixture.meta() };
}
function itemRow(fixture: Fixture, tokenId: string, owner: string | null, activeListingId: string | null = null, at = collection) {
  return { id: `${at}:${tokenId}`, collection: at, tokenId, owner, burned: owner === null, minted: true,
    activeListingId, escrowRelease: null, approved: null, transferCount: '1', ...fixture.meta() };
}
async function putListing(fixture: Fixture, tx: IndexerTransaction, id: string, status: 'active' | 'sold' | 'cancelled',
  overrides: ProjectionValue = {}, number = 1n, source = market) {
  const logIndex = Number(id) + 1, transactionHash = hash(600 + Number(id));
  const listing = { listingId: id, collection, tokenId: id === '1' ? '2' : '1', seller: alice, totalPrice: exactPrice, status,
    ...fixture.meta(number), lastTransactionHash: transactionHash, lastLogIndex: logIndex, ...overrides };
  await tx.put('listings', id, listing);
  await tx.put('activity', `${transactionHash}:${logIndex}`, {
    eventName: status === 'active' ? 'Listed' : status === 'sold' ? 'Sold' : 'ListingCancelled', source,
    args: { listingId: id, totalPrice: listing.totalPrice, ...(status === 'active'
      ? { collection: listing.collection, tokenId: listing.tokenId, seller: listing.seller }
      : { buyer: alice, recipient: alice, platformFee: '200', royalty: '500', sellerProceeds: '9300' }) },
    blockNumber: number.toString(), blockHash: fixture.canonical.get(number)!.hash, transactionHash, transactionIndex: 1, logIndex,
    schemaVersion: 1, deploymentVersion: 'oneshot-nft-v1', chainId: fixture.manifest.chainId,
  });
}
async function seed(fixture: Fixture) {
  await fixture.store.transaction(async tx => {
    await tx.put('collections', collection, collectionRow(fixture));
    await tx.put('collections', otherCollection, collectionRow(fixture, 'Another collection', otherCollection));
    await tx.put('items', `${collection}:1`, itemRow(fixture, '1', alice));
    await tx.put('items', `${collection}:2`, itemRow(fixture, '2', market, '1'));
    await tx.put('items', `${collection}:3`, itemRow(fixture, '3', null));
    await tx.put('items', `${otherCollection}:10`, itemRow(fixture, '10', alice, null, otherCollection));
    await putListing(fixture, tx, '1', 'active');
    await putListing(fixture, tx, '2', 'sold', { seller: bob, totalPrice: '10000', buyer: alice,
      recipient: alice, platformFee: '200', royalty: '500', sellerProceeds: '9300' });
    await tx.put('claims', `${market}:${alice}`, { contract: market, beneficiary: alice, totalClaimed: exactPrice, recipient, lastAmount: '50', ...fixture.meta() });
    for (const [logIndex, at] of [collection, otherCollection].entries()) await tx.put('activity', `${hash(499)}:${logIndex}`, {
      eventName: 'CollectionCreated', source: factory, args: { collection: at, creator: alice, name: 'Indexed originals', symbol: 'SHOT' },
      blockNumber: '1', blockHash: fixture.canonical.get(1n)!.hash, transactionHash: hash(499), transactionIndex: 0, logIndex,
      schemaVersion: 1, deploymentVersion: 'oneshot-nft-v1', chainId: fixture.manifest.chainId,
    });
    await tx.append(fixture.canonical.get(1n)!, []);
  });
}
const payload = async (response: Response) => { expect(response.status).toBe(200); return response.json(); };

describe.skipIf(!databaseUrl)('real PostgreSQL indexed NFT public reads', () => {
  it('queries a canonical union of followed-wallet actors once and binds pagination to the exact set', async () => {
    await withDatabase(async fixture => {
      await seed(fixture);
      const all = await payload(await fixture.read('/activity?limit=50'));
      const encoded = encodeFollowedWallets([alice, bob]);
      const expected = all.items.filter((event: any) => Object.entries(event.args).some(([key, value]) => ['creator','payer','recipient','from','to','account','owner','approved','operator','buyer','seller','bidder','caller'].includes(key) && [alice, bob].includes(value as `0x${string}`)));
      const whole = await payload(await fixture.read(`/activity?wallets=${encoded}&limit=50`));
      expect(whole.items.map((event: any) => event.id)).toEqual(expected.map((event: any) => event.id));
      expect(new Set(whole.items.map((event: any) => event.id)).size).toBe(whole.items.length);
      const first = await payload(await fixture.read(`/activity?wallets=${encoded}&limit=1`));
      expect(first.nextCursor).toBeTypeOf('string');
      const second = await payload(await fixture.read(`/activity?wallets=${encoded}&limit=1&cursor=${first.nextCursor}`));
      expect(second.items[0].id).not.toBe(first.items[0].id);
      expect((await fixture.read(`/activity?wallets=${encodeFollowedWallets([alice])}&limit=1&cursor=${first.nextCursor}`)).status).toBe(400);
      expect((await fixture.read(`/activity?wallets=${encoded}&wallet=${alice}`)).status).toBe(400);
      const maximum = encodeFollowedWallets([alice, bob, ...Array.from({ length: 48 }, (_, index) => address(index + 100))]);
      const bounded = await payload(await fixture.read(`/activity?wallets=${maximum}&limit=1`));
      expect((await fixture.read(`/activity?wallets=${maximum}&limit=1&cursor=${bounded.nextCursor}`)).status).toBe(200);
    });
  });
  it('filters complete creator collections before pagination and binds continuations to that creator', async () => {
    await withDatabase(async fixture => {
      await seed(fixture);
      const first = await payload(await fixture.read(`/collections?creator=${alice}&limit=1`));
      expect(first.items).toHaveLength(1); expect(first.items[0].creator).toBe(alice); expect(first.nextCursor).toBeTypeOf('string');
      const next = await payload(await fixture.read(`/collections?creator=${alice}&limit=1&cursor=${first.nextCursor}`));
      expect(next.items).toHaveLength(1); expect(next.items[0].address).not.toBe(first.items[0].address); expect(next.nextCursor).toBeNull();
      expect((await payload(await fixture.read(`/collections?creator=${bob}`))).items).toEqual([]);
      expect((await fixture.read(`/collections?creator=${bob}&limit=1&cursor=${first.nextCursor}`)).status).toBe(400);
      expect((await fixture.read(`/collections?creator=${alice}&creator=${bob}`)).status).toBe(400);
      expect((await fixture.read(`/collections?creator=${address(0)}`)).status).toBe(400);
    });
  });
  it('reads exact statistics in a simulated pinned Base deployment on PostgreSQL and rejects a replaced canonical branch',async()=>{
    await withDatabase(async fixture=>{
      await seed(fixture);
      const detail=await payload(await fixture.read(`/collections/${collection}`));
      expect(detail.context).toMatchObject({deploymentId:fixture.deploymentId,network:{mode:'base-sepolia',chainId:84532,nativeSymbol:'ETH',nativeDecimals:18},finalized:false});
      expect(detail.marketStats).toEqual({activeListings:'1',lowestListingPriceRaw:exactPrice,completedSales:'1',secondaryVolumeRaw:'10000'});
      fixture.canonical.set(1n,block(1n,hash(999),BASE_SEPOLIA_GENESIS_HASH));
      const orphaned=await fixture.read(`/collections/${collection}`);
      expect(orphaned.status).toBe(409);expect(await orphaned.json()).not.toHaveProperty('marketStats');
    },true);
  });
  it('aggregates canonical escrow listings and every completed resale, with exact gross volume above uint256', async () => {
    await withDatabase(async fixture => {
      await seed(fixture);
      await fixture.store.transaction(async tx => {
        const maximum = (2n ** 256n - 1n).toString();
        await putListing(fixture, tx, '3', 'sold', { totalPrice: maximum, tokenId: '1' }, 2n);
        await putListing(fixture, tx, '4', 'sold', { totalPrice: maximum, tokenId: '1' }, 2n);
        await putListing(fixture, tx, '5', 'active', { totalPrice: '17', tokenId: '3' }, 2n);
        await tx.put('items', `${collection}:3`, { ...itemRow(fixture, '3', market, '5'), ...fixture.meta(2n) });
        // Historical sales survive later transfers and burns of the same item.
        await tx.put('items', `${collection}:1`, { ...itemRow(fixture, '1', null), ...fixture.meta(2n) });
        await tx.append(fixture.canonical.get(2n)!, []);
      });
      const detail = await payload(await fixture.read(`/collections/${collection}`));
      expect(detail.context.checkpoint.number).toBe('2');
      expect(detail.marketStats).toEqual({ activeListings: '2', lowestListingPriceRaw: '17', completedSales: '3',
        secondaryVolumeRaw: (2n * (2n ** 256n - 1n) + 10000n).toString() });
      const discovery = await payload(await fixture.read('/collections'));
      expect(discovery).not.toHaveProperty('marketStats');
      expect(discovery.items.every((item: object) => !('marketStats' in item))).toBe(true);
      await fixture.store.transaction(async tx => { await tx.rollbackHead(); });
      const restored = await payload(await fixture.read(`/collections/${collection}`));
      expect(restored.context.checkpoint.number).toBe('1');
      expect(restored.marketStats).toEqual({ activeListings: '1', lowestListingPriceRaw: exactPrice, completedSales: '1', secondaryVolumeRaw: '10000' });
    });
  });

  it('excludes cancelled, stale, unminted, burned, unrelated, noncanonical and wrong-market listings', async () => {
    await withDatabase(async fixture => {
      await seed(fixture);
      await fixture.store.transaction(async tx => {
        const candidates: [string, string, string | null, string | null, ProjectionValue][] = [
          ['3', '3', market, '3', { burned: true }], ['4', '1', alice, '4', {}],
          ['5', '5', market, '5', { minted: false }], ['6', '6', market, '999', {}],
        ];
        for (const [id, tokenId, owner, activeId, changes] of candidates) {
          await tx.put('items', `${collection}:${tokenId}`, { ...itemRow(fixture, tokenId, owner, activeId), ...changes });
          await putListing(fixture, tx, id, 'active', { tokenId, totalPrice: '1' });
        }
        await putListing(fixture, tx, '7', 'cancelled', { totalPrice: '1' });
        await tx.put('items', `${otherCollection}:8`, itemRow(fixture, '8', market, '8', otherCollection));
        await putListing(fixture, tx, '8', 'active', { collection: otherCollection, tokenId: '8', totalPrice: '1' });
        await tx.put('items', `${collection}:9`, itemRow(fixture, '9', market, '9'));
        await putListing(fixture, tx, '9', 'active', { tokenId: '9', totalPrice: '1' }, 1n, address(99));
        await putListing(fixture, tx, '10', 'sold', { totalPrice: '1', lastBlockHash: hash(999) });
        await putListing(fixture, tx, '11', 'sold', { totalPrice: '1' }, 1n, address(99));
        await putListing(fixture, tx, '12', 'sold', { collection: otherCollection, totalPrice: '1' });
        await putListing(fixture, tx, '13', 'sold', { totalPrice: '1' }, 3n); // journal has no block 3
        await tx.append(fixture.canonical.get(2n)!, []);
      });
      const detail = await payload(await fixture.read(`/collections/${collection}`));
      expect(detail.marketStats).toEqual({ activeListings: '1', lowestListingPriceRaw: exactPrice, completedSales: '1', secondaryVolumeRaw: '10000' });
      const empty = await payload(await fixture.read(`/collections/${otherCollection}`));
      expect(empty.marketStats).toEqual({ activeListings: '1', lowestListingPriceRaw: '1', completedSales: '1', secondaryVolumeRaw: '1' });
      const index = await fixture.pool.query("SELECT indexdef FROM pg_indexes WHERE schemaname=current_schema() AND indexname='oneshot_evm_listing_collection_status'");
      expect(index.rows).toHaveLength(1);
      expect(index.rows[0].indexdef).toContain('listings');
      await fixture.store.initialize(fixture.deploymentId); // additive migration is idempotent
    });
  });

  it('distinguishes a successful empty market from malformed zero-priced or inexact canonical listing data', async () => {
    await withDatabase(async fixture => {
      await seed(fixture);
      const empty = await payload(await fixture.read(`/collections/${otherCollection}`));
      expect(empty.marketStats).toEqual({ activeListings: '0', lowestListingPriceRaw: null, completedSales: '0', secondaryVolumeRaw: '0' });
      for (const totalPrice of ['0', '01', '1e2', (2n ** 256n).toString(), '1'.repeat(79), 1]) {
        await fixture.store.transaction(async tx => {
          await putListing(fixture, tx, '1', 'active', { totalPrice }, 2n);
          await tx.append(fixture.canonical.get(2n)!, []);
        });
        const response = await fixture.read(`/collections/${collection}`);
        expect(response.status).toBe(503);
        const body = await response.json();
        expect(body).toMatchObject({ error: { code: 'INDEXER_DATA_INVALID' } });
        expect(body).not.toHaveProperty('marketStats');
        await fixture.store.transaction(async tx => { await tx.rollbackHead(); });
      }
      const recovered = await payload(await fixture.read(`/collections/${collection}`));
      expect(recovered.marketStats.lowestListingPriceRaw).toBe(exactPrice);
    });
  });

  it('reads collection and aggregates from one checkpoint during a concurrent sale and reverses both on rollback', async () => {
    await withDatabase(async fixture => {
      await seed(fixture);
      let releaseRead!: () => void, reachedAggregate!: () => void;
      const paused = new Promise<void>(resolve => { reachedAggregate = resolve; });
      const resume = new Promise<void>(resolve => { releaseRead = resolve; });
      const snapshotPool: SqlPool = { async connect() {
        const client = await fixture.pool.connect();
        return { release: () => client.release(), async query(sql, values) {
          if (sql.startsWith('WITH canonical_listings')) { reachedAggregate(); await resume; }
          return client.query(sql, values);
        } };
      } };
      const response = api(request => fixture.reader(snapshotPool)(request))(new NextRequest(`http://localhost/api/oneshot/indexed/collections/${collection}`), {});
      try {
        await Promise.race([paused, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Aggregate did not reach snapshot barrier')), 5000).unref())]);
        await fixture.store.transaction(async tx => {
          await putListing(fixture, tx, '1', 'sold', {}, 2n);
          await tx.put('items', `${collection}:2`, { ...itemRow(fixture, '2', bob), ...fixture.meta(2n) });
          await tx.append(fixture.canonical.get(2n)!, []);
        });
      } finally { releaseRead(); }
      const held = await payload(await response);
      expect(held.context.checkpoint.number).toBe('1');
      expect(held.marketStats).toEqual({ activeListings: '1', lowestListingPriceRaw: exactPrice, completedSales: '1', secondaryVolumeRaw: '10000' });
      const latest = await payload(await fixture.read(`/collections/${collection}`));
      expect(latest.context.checkpoint.number).toBe('2');
      expect(latest.marketStats).toEqual({ activeListings: '0', lowestListingPriceRaw: null, completedSales: '2', secondaryVolumeRaw: (BigInt(exactPrice) + 10000n).toString() });
      await fixture.store.transaction(async tx => { await tx.rollbackHead(); });
      const restored = await payload(await fixture.read(`/collections/${collection}`));
      expect(restored.context.checkpoint.number).toBe('1');
      expect(restored.marketStats).toEqual(held.marketStats);
    });
  });
  it('searches the full result set with stable creation ordering and literal special characters', async () => {
    await withDatabase(async fixture => {
      await seed(fixture);
      await fixture.store.transaction(async tx => {
        for (let index = 0; index < 25; index++) {
          const at = address(100 + index);
          const name = index % 12 === 0 ? `Nebula ${index}` : index === 3 ? "100%_\\ signed" : `Other ${index}`;
          await tx.put('collections', at, { ...collectionRow(fixture, name, at), symbol: index === 7 ? 'MATCH' : 'OTHER' });
          await tx.put('activity', `${hash(501)}:${index}`, { eventName: 'CollectionCreated', source: factory,
            args: { collection: at, creator: alice, name, symbol: 'OTHER' }, blockNumber: '2', blockHash: fixture.canonical.get(2n)!.hash,
            transactionHash: hash(501), transactionIndex: 0, logIndex: index, schemaVersion: 1, deploymentVersion: 'oneshot-nft-v1', chainId: 31337 });
        }
        // Subsequent activity must not make an older collection appear newly created.
        await tx.put('collections', collection, { ...collectionRow(fixture), totalMinted: '999', ...fixture.meta(2n) });
        await tx.append(fixture.canonical.get(2n)!, []);
      });
      const found: string[] = [];
      let cursor: string | null = null;
      do {
        const result = await payload(await fixture.read(`/collections?q=nEbUlA&sort=newest&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`));
        found.push(...result.items.map((item: { address: string }) => item.address)); cursor = result.nextCursor;
        expect(found.length).toBeLessThanOrEqual(3);
      } while (cursor);
      expect(found).toEqual([address(124), address(112), address(100)]);
      const oldest = await payload(await fixture.read('/collections?sort=oldest&limit=2'));
      expect(oldest.items.map((item: { address: string }) => item.address)).toEqual([collection, otherCollection]);
      const oldestMatch = await payload(await fixture.read('/collections?q=Nebula&sort=oldest'));
      expect(oldestMatch.items.map((item: { address: string }) => item.address)).toEqual([...found].reverse());
      const symbol = await payload(await fixture.read('/collections?q=match'));
      expect(symbol.items.map((item: { address: string }) => item.address)).toEqual([address(107)]);
      const byAddress = await payload(await fixture.read(`/collections?q=${address(118).toUpperCase()}`));
      expect(byAddress.items.map((item: { address: string }) => item.address)).toEqual([address(118)]);
      const literal = await payload(await fixture.read(`/collections?q=${encodeURIComponent('%_\\')}`));
      expect(literal.items.map((item: { address: string }) => item.address)).toEqual([address(103)]);
      const injection = await payload(await fixture.read(`/collections?q=${encodeURIComponent("' OR true --")}`));
      expect(injection).toMatchObject({ context: { available: true }, items: [], nextCursor: null });
      const first = await payload(await fixture.read('/collections?q=Nebula&limit=1'));
      for (const path of ['/collections?q=Other&limit=1', '/collections?q=Nebula&sort=oldest&limit=1']) {
        expect((await fixture.read(`${path}&cursor=${encodeURIComponent(first.nextCursor)}`)).status).toBe(400);
      }
      expect(JSON.stringify(oldest)).not.toMatch(/serverOnlyPath|privateEndpoint|created_block_number|created_log_index/);

      const index = await fixture.pool.query("SELECT indexdef FROM pg_indexes WHERE schemaname=current_schema() AND tablename='oneshot_evm_projections' AND indexname='oneshot_evm_collection_creation_order'");
      expect(index.rows).toHaveLength(1);
      expect(index.rows[0].indexdef).toContain('CollectionCreated');
      // Exercise index eligibility on the actual discovery SQL, rather than a different demonstration query.
      let discoverySql: string | undefined, discoveryValues: unknown[] | undefined;
      const observedPool: SqlPool = { async connect() {
        const client = await fixture.pool.connect();
        return { release: () => client.release(), async query(sql, values) {
          if (sql.startsWith('SELECT p.entity_id')) { discoverySql = sql; discoveryValues = values; }
          return client.query(sql, values);
        } };
      } };
      await payload(await api(request => fixture.reader(observedPool)(request))(new NextRequest('http://localhost/api/oneshot/indexed/collections?limit=1'), {}));
      expect(discoverySql).toBeTruthy();
      const planner = await fixture.pool.connect();
      try {
        await planner.query('BEGIN');
        // Tiny fixtures normally favor sequential scans. These transaction-local settings
        // demonstrate that both ordered directions can use the migration's index.
        await planner.query('SET LOCAL enable_seqscan=off');
        await planner.query('SET LOCAL enable_sort=off');
        const newestPlan = await planner.query(`EXPLAIN (FORMAT JSON) ${discoverySql}`, discoveryValues);
        expect(JSON.stringify(newestPlan.rows)).toContain('oneshot_evm_collection_creation_order');
        const oldestSql = discoverySql!.replaceAll('numeric DESC', 'numeric ASC').replaceAll('integer DESC', 'integer ASC');
        const oldestPlan = await planner.query(`EXPLAIN (FORMAT JSON) ${oldestSql}`, discoveryValues);
        expect(JSON.stringify(oldestPlan.rows)).toContain('oneshot_evm_collection_creation_order');
      } finally { await planner.query('ROLLBACK'); planner.release(); }
    });
  });
  it('joins each item to its canonical collection content and reverses the association on rollback', async () => {
    await withDatabase(async fixture => {
      await seed(fixture);
      const resolved: [string, string][] = [];
      const contentResolver: IndexedReaderDependencies['contentResolver'] = () => async (contentHash, tokenId) => {
        resolved.push([contentHash, tokenId]);
        return { manifestHash: contentHash.slice(2), tokenId, name: `Public original ${tokenId}`, description: 'Committed art',
          imagePath: `/api/media/${hash(40).slice(2)}.webp`, metadataPath: `/api/oneshot/metadata/${contentHash.slice(2)}/${tokenId}`, attributes: [] };
      };
      const initial = await payload(await fixture.read(`/wallets/${alice}/items`, contentResolver));
      expect(initial.items.map((item: { presentation: { manifestHash: string; tokenId: string } }) => item.presentation.tokenId)).toEqual(['1', '10']);
      expect(resolved).toEqual([[hash(31), '1'], [hash(31), '10']]);
      await fixture.store.transaction(async tx => {
        await tx.put('collections', collection, { ...collectionRow(fixture), contentHash: hash(32) });
        await tx.append(fixture.canonical.get(2n)!, []);
      });
      const replacement = await payload(await fixture.read(`/collections/${collection}/items/1`, contentResolver));
      expect(replacement.item.presentation.manifestHash).toBe(hash(32).slice(2));
      await fixture.store.transaction(async tx => { await tx.rollbackHead(); });
      const restored = await payload(await fixture.read(`/collections/${collection}/items/1`, contentResolver));
      expect(restored.item.presentation.manifestHash).toBe(hash(31).slice(2));
      await fixture.store.transaction(async tx => {
        await tx.put('collections', collection, { ...collectionRow(fixture), opened: false, contentHash: null });
        await tx.append(fixture.canonical.get(2n)!, []);
      });
      const unopened = await payload(await fixture.read(`/collections/${collection}/items/1`, contentResolver));
      expect(unopened.item.presentation).toBeNull();
      expect(unopened.item.owner).toBe(alice);
      expect(resolved).toHaveLength(4);
    });
  });

  it('returns observed exact state, explicit local context and actual cumulative claims', async () => {
    await withDatabase(async fixture => {
      await seed(fixture);
      const status = await payload(await fixture.read('/status'));
      expect(status.context).toMatchObject({ enabled: true, available: true, deploymentId: fixture.deploymentId, readonly: true, finalized: false,
        network: { mode: 'local', chainId: 31337, nativeSymbol: 'ETH', nativeDecimals: 18 }, checkpoint: { number: '1', hash: fixture.canonical.get(1n)!.hash } });
      const detail = await payload(await fixture.read(`/collections/${collection}`));
      expect(detail.collection).toMatchObject({ address: collection, name: 'Indexed originals', totalMinted: '3', primaryTotalPriceRaw: exactPrice });
      expect(JSON.stringify(detail)).not.toMatch(/projection-secret|private-rpc|secret-api-key/);
      for (const unknown of ['royaltyBps', 'publicPrice', 'maxSupply', 'metadataBaseURI', 'imageUrl', 'publicStart']) expect(detail.collection).not.toHaveProperty(unknown);
      const item = await payload(await fixture.read(`/collections/${collection}/items/2`));
      expect(item.item).toMatchObject({ collection, tokenId: '2', owner: market, listing: { id: '1', seller: alice, totalPriceRaw: exactPrice, status: 'active' } });
      const claims = await payload(await fixture.read(`/wallets/${alice}/claims`));
      expect(claims.items).toEqual([expect.objectContaining({ contract: market, beneficiary: alice, totalClaimedRaw: exactPrice, lastAmountRaw: '50' })]);
      expect(claims.items[0]).not.toHaveProperty('claimable');
      const activity = await payload(await fixture.read('/activity'));
      expect(activity.items).toHaveLength(4);
      expect(activity.items.find((item: { eventName: string }) => item.eventName === 'Listed')).toMatchObject({ eventName: 'Listed', collection, blockNumber: '1', args: expect.objectContaining({ totalPrice: exactPrice }) });
      expect(activity.items[0].timestamp).toBeTruthy();
    });
  });

  it('keeps another manifest deployment out of all public result sets', async () => {
    await withDatabase(async fixture => {
      await seed(fixture);
      const otherManifest = createHash('sha256').update(randomUUID()).digest('hex');
      const foreignAddress = address(99);
      try {
        await fixture.pool.query('INSERT INTO oneshot_evm_deployments(manifest_id) VALUES($1)', [otherManifest]);
        await fixture.pool.query('INSERT INTO oneshot_evm_projections(manifest_id,kind,entity_id,value) VALUES($1,$2,$3,$4::jsonb)',
          [otherManifest, 'collections', foreignAddress, JSON.stringify(collectionRow(fixture, 'Foreign deployment must remain hidden', foreignAddress))]);
        await fixture.pool.query('INSERT INTO oneshot_evm_journal(manifest_id,block_number,block_hash,parent_hash,block_timestamp,undo) SELECT $1,block_number,block_hash,parent_hash,block_timestamp,undo FROM oneshot_evm_journal WHERE manifest_id=$2', [otherManifest, fixture.deploymentId]);
        await fixture.pool.query('INSERT INTO oneshot_evm_projections(manifest_id,kind,entity_id,value) SELECT $1,kind,entity_id,value FROM oneshot_evm_projections WHERE manifest_id=$2', [otherManifest, fixture.deploymentId]);
        const result = await payload(await fixture.read('/collections'));
        expect(result.items).toHaveLength(2);
        expect(JSON.stringify(result)).not.toContain('Foreign deployment must remain hidden');
        expect((await fixture.read(`/collections/${foreignAddress}`)).status).toBe(404);
        const detail = await payload(await fixture.read(`/collections/${collection}`));
        expect(detail.marketStats).toEqual({ activeListings: '1', lowestListingPriceRaw: exactPrice, completedSales: '1', secondaryVolumeRaw: '10000' });
      } finally {
        await fixture.pool.query('DELETE FROM oneshot_evm_projections WHERE manifest_id=$1', [otherManifest]);
        await fixture.pool.query('DELETE FROM oneshot_evm_journal WHERE manifest_id=$1', [otherManifest]);
        await fixture.pool.query('DELETE FROM oneshot_evm_deployments WHERE manifest_id=$1', [otherManifest]);
      }
    });
  });

  it('bounds pages, distinguishes actual ownership from escrow sellers and scopes filters', async () => {
    await withDatabase(async fixture => {
      await seed(fixture);
      const first = await payload(await fixture.read('/collections?limit=1'));
      expect(first.items).toHaveLength(1); expect(first.nextCursor).toBeTypeOf('string');
      const next = await payload(await fixture.read(`/collections?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`));
      expect(next.items).toHaveLength(1); expect(next.nextCursor).toBeNull(); expect(next.items[0].address).not.toBe(first.items[0].address);
      expect((await fixture.read(`/listings?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`)).status).toBe(400);
      const owned = await payload(await fixture.read(`/wallets/${alice}/items`));
      expect(owned.items.map((item: { tokenId: string }) => item.tokenId).sort()).toEqual(['1', '10']);
      const active = await payload(await fixture.read(`/listings?collection=${collection}&seller=${alice}&status=active`));
      expect(active.items.map((listing: { id: string }) => listing.id)).toEqual(['1']);
      const sold = await payload(await fixture.read('/listings?status=sold'));
      expect(sold.items).toEqual([expect.objectContaining({ id: '2', platformFeeRaw: '200', royaltyRaw: '500', sellerProceedsRaw: '9300' })]);
      expect((await fixture.read(`/collections/${collection}/items/100`)).status).toBe(404);
      expect((await fixture.read(`/collections/${address(99)}`)).status).toBe(404);
    });
  });

  it('invalidates cursors after forward progress and after replacing an indexed branch', async () => {
    await withDatabase(async fixture => {
      await seed(fixture);
      const first = await payload(await fixture.read('/collections?limit=1'));
      await fixture.store.transaction(async tx => {
        await tx.put('items', `${collection}:1`, itemRow(fixture, '1', bob));
        await tx.append(fixture.canonical.get(2n)!, []);
      });
      const stale = await fixture.read(`/collections?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`);
      expect(stale.status).toBe(409); expect(await stale.json()).toMatchObject({ error: { code: 'CURSOR_STALE' } });
      const second = await payload(await fixture.read('/collections?limit=1'));
      await fixture.store.transaction(async tx => { await tx.rollbackHead(); });
      fixture.canonical.set(2n, block(2n, hash(902), fixture.canonical.get(1n)!.hash));
      await fixture.store.transaction(async tx => { await tx.append(fixture.canonical.get(2n)!, []); });
      const orphanCursor = await fixture.read(`/collections?limit=1&cursor=${encodeURIComponent(second.nextCursor)}`);
      expect(orphanCursor.status).toBe(409); expect(await orphanCursor.json()).toMatchObject({ error: { code: 'CURSOR_STALE' } });
      const restored = await payload(await fixture.read(`/collections/${collection}/items/1`));
      expect(restored.item.owner).toBe(alice);
    });
  });

  it('rejects a checkpoint whose number still exists on a different canonical branch', async () => {
    await withDatabase(async fixture => {
      await seed(fixture);
      fixture.canonical.set(1n, block(1n, hash(901), hash(100)));
      const response = await fixture.read('/collections');
      expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: { code: 'INDEXER_CHAIN_MOVED' } });
      const detail = await fixture.read(`/collections/${collection}`);
      expect(detail.status).toBe(409);
      expect(await detail.json()).not.toHaveProperty('marketStats');
      const rows = await fixture.pool.query('SELECT block_hash FROM oneshot_evm_journal WHERE manifest_id=$1', [fixture.deploymentId]);
      expect(rows.rows[0].block_hash).toBe(hash(101));
    });
  });

  it('keeps head and projected records on one snapshot during a concurrent block commit', async () => {
    await withDatabase(async fixture => {
      await seed(fixture);
      let releaseRead!: () => void, observedHead!: () => void;
      const paused = new Promise<void>(resolve => { observedHead = resolve; });
      const resume = new Promise<void>(resolve => { releaseRead = resolve; });
      let held = false;
      const snapshotPool: SqlPool = { async connect() {
        const client = await fixture.pool.connect();
        return { release: () => client.release(), async query(sql, values) {
          const result = await client.query(sql, values);
          if (!held && /FROM\s+oneshot_evm_journal/i.test(sql) && /ORDER BY/i.test(sql)) {
            held = true; observedHead(); await resume;
          }
          return result;
        } };
      } };
      const handler = fixture.reader(snapshotPool);
      const reading = api(request => handler(request))(new NextRequest('http://localhost/api/oneshot/indexed/collections'), {});
      try {
        await Promise.race([paused, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Head query did not reach snapshot barrier')), 5000).unref())]);
        await fixture.store.transaction(async tx => {
          await tx.put('collections', collection, { ...collectionRow(fixture), totalMinted: '999' });
          await tx.append(fixture.canonical.get(2n)!, []);
        });
      } finally { releaseRead(); }
      const response = await payload(await reading);
      expect(response.context.checkpoint.number).toBe('1');
      expect(response.items.find((item: { address: string }) => item.address === collection).totalMinted).toBe('3');
      const latest = await payload(await fixture.read('/collections'));
      expect(latest.context.checkpoint.number).toBe('2');
      expect(latest.items.find((item: { address: string }) => item.address === collection).totalMinted).toBe('999');
    });
  });
});
