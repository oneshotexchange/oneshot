import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { createIndexedNftReader, type IndexedReaderDependencies } from './indexed-nfts';
import { api } from './http';
import { manifestId, parseManifest } from '../../../indexer/src/manifest';
import { PostgresIndexerStore, type SqlPool } from '../../../indexer/src/store';
import type { Block, ChainSource, Manifest, ProjectionValue } from '../../../indexer/src/types';

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
async function withDatabase(run: (fixture: Fixture) => Promise<void>) {
  if (!databaseUrl) throw new Error('ONESHOT_API_TEST_DATABASE_URL is required');
  const configuration = { connectionString: databaseUrl, max: 3, connectionTimeoutMillis: 5000, idleTimeoutMillis: 1000, statement_timeout: 10_000 };
  const pool = new Pool(configuration);
  const store = new PostgresIndexerStore(new Pool(configuration));
  const genesis = `0x${createHash('sha256').update(randomUUID()).digest('hex')}`;
  const manifest = parseManifest({ schemaVersion: 1, deploymentVersion: 'oneshot-nft-v1', mode: 'local', chainId: 31337,
    genesisHash: genesis, startBlock: '1', anchorHash: hash(100),
    factory: { address: factory, codeHash: hash(20) }, marketplace: { address: market, codeHash: hash(21) },
  });
  const id = manifestId(manifest);
  const canonical = new Map<bigint, Block>([[0n, block(0n)], [1n, block(1n)], [2n, block(2n)], [3n, block(3n)]]);
  const source: ChainSource = {
    async verify(observed) { expect(observed).toEqual(manifest); },
    async height() { return [...canonical.keys()].reduce((maximum, number) => number > maximum ? number : maximum, 0n); },
    async block(number) { const value = canonical.get(number); if (!value) throw new Error('Missing local test block'); return value; },
    async logs() { throw new Error('Public reads must never request event ingestion'); },
  };
  const env: Record<string, string | undefined> = { ONESHOT_INDEXER_READS_ENABLED: 'true', ONESHOT_NETWORK: 'local', DATABASE_URL: databaseUrl, ONESHOT_INDEXER_MANIFEST_PATH: 'injected-local-test-manifest.json' };
  const reader = (poolOverride: SqlPool = pool, contentResolver?: IndexedReaderDependencies['contentResolver']) => createIndexedNftReader({ pool: () => poolOverride, loadManifest: async () => manifest, source: async () => source, env: () => env, ...(contentResolver ? { contentResolver } : {}) });
  const serve = (handler: ReturnType<typeof createIndexedNftReader>, path: string) => api(request => handler(request))(
    new NextRequest(`http://localhost/api/oneshot/indexed${path}`), {},
  );
  let initialized = false;
  try {
    await store.initialize(id); initialized = true;
    await run({ pool, store, manifest, deploymentId: id, canonical, reader,
      read: (path, contentResolver) => serve(reader(pool, contentResolver), path),
      meta(number = 1n) { const at = canonical.get(number)!; return { schemaVersion: 1, deploymentVersion: 'oneshot-nft-v1', chainId: 31337,
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
async function seed(fixture: Fixture) {
  await fixture.store.transaction(async tx => {
    await tx.put('collections', collection, collectionRow(fixture));
    await tx.put('collections', otherCollection, collectionRow(fixture, 'Another collection', otherCollection));
    await tx.put('items', `${collection}:1`, itemRow(fixture, '1', alice));
    await tx.put('items', `${collection}:2`, itemRow(fixture, '2', market, '1'));
    await tx.put('items', `${collection}:3`, itemRow(fixture, '3', null));
    await tx.put('items', `${otherCollection}:10`, itemRow(fixture, '10', alice, null, otherCollection));
    await tx.put('listings', '1', { listingId: '1', collection, tokenId: '2', seller: alice, totalPrice: exactPrice, status: 'active', ...fixture.meta() });
    await tx.put('listings', '2', { listingId: '2', collection, tokenId: '1', seller: bob, totalPrice: '10000', status: 'sold', buyer: alice,
      recipient: alice, platformFee: '200', royalty: '500', sellerProceeds: '9300', ...fixture.meta() });
    await tx.put('claims', `${market}:${alice}`, { contract: market, beneficiary: alice, totalClaimed: exactPrice, recipient, lastAmount: '50', ...fixture.meta() });
    await tx.put('activity', `${hash(500)}:0`, { eventName: 'Listed', source: market, args: { listingId: '1', collection, tokenId: '2', seller: alice, totalPrice: exactPrice },
      blockNumber: '1', blockHash: fixture.canonical.get(1n)!.hash, transactionHash: hash(500), transactionIndex: 0, logIndex: 0,
      schemaVersion: 1, deploymentVersion: 'oneshot-nft-v1', chainId: 31337 });
    await tx.append(fixture.canonical.get(1n)!, []);
  });
}
const payload = async (response: Response) => { expect(response.status).toBe(200); return response.json(); };

describe.skipIf(!databaseUrl)('real PostgreSQL indexed NFT public reads', () => {
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
      expect(activity.items).toEqual([expect.objectContaining({ eventName: 'Listed', collection, blockNumber: '1', args: expect.objectContaining({ totalPrice: exactPrice }) })]);
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
        const result = await payload(await fixture.read('/collections'));
        expect(result.items).toHaveLength(2);
        expect(JSON.stringify(result)).not.toContain('Foreign deployment must remain hidden');
        expect((await fixture.read(`/collections/${foreignAddress}`)).status).toBe(404);
      } finally {
        await fixture.pool.query('DELETE FROM oneshot_evm_projections WHERE manifest_id=$1', [otherManifest]);
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
