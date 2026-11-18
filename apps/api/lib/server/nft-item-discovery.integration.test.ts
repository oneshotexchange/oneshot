import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { createIndexedNftReader } from './indexed-nfts';
import { api } from './http';
import { stableJson } from './media';
import { buildNftMetadataCatalog, NFT_METADATA_CATALOG_NAMESPACE } from './nft-metadata-catalog';
import { manifestId, parseManifest } from '../../../indexer/src/manifest';
import { PostgresIndexerStore, type SqlClient, type SqlPool } from '../../../indexer/src/store';
import type { Block, ChainSource, IndexerTransaction, Manifest, ProjectionValue } from '../../../indexer/src/types';

// Dedicated test DB only. Each case owns a random schema and never touches the
// application's ambient database, account records, media files or deployment.
const connectionString = process.env.ONESHOT_API_TEST_DATABASE_URL;
const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as `0x${string}`;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const factory = a(1), marketplace = a(2), collection = a(3), alice = a(4), creator = a(5);
const highPrice = 9007199254740993123456789n;
const at = (n: bigint, hash = h(Number(n) + 100), parentHash = h(Number(n) + 99)): Block => ({ number: n, hash, parentHash, timestamp: 1_700_000_000n + n });
type Trait = { trait_type: string; value: string | number };
const traits = (values: Trait[]) => Buffer.from(JSON.stringify([...values].sort((left, right) => {
  const a = JSON.stringify([left.trait_type, Object.is(left.value, -0) ? 0 : left.value]);
  const b = JSON.stringify([right.trait_type, Object.is(right.value, -0) ? 0 : right.value]); return a < b ? -1 : a > b ? 1 : 0;
}))).toString('base64url');
type Fixture = {
  pool: Pool; store: PostgresIndexerStore; manifest: Manifest; identity: string;
  canonical: Map<bigint, Block>; env: Record<string, string | undefined>; contentHash: string; manifestHash: string;
  accounting: { escrow: string; pending: string; balance: string };
  catalog: ReturnType<typeof buildNftMetadataCatalog>;
  read(query?: string, options?: { pool?: SqlPool; sourceFailure?: boolean }): Promise<Response>;
  metadata: (block?: bigint) => ProjectionValue;
  putRecord(namespace: string, id: string, value: unknown): Promise<void>;
};

async function withDatabase(run: (fixture: Fixture) => Promise<void>, wideTraits=false, version: Manifest['deploymentVersion']='oneshot-nft-v1') {
  if (!connectionString) throw new Error('Dedicated item-discovery test database required.');
  const endpoint = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(endpoint.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)
    || endpoint.pathname !== '/oneshot_indexer_test') throw new Error('Use the dedicated loopback oneshot_indexer_test database.');
  const schema = `item_discovery_${randomUUID().replaceAll('-', '')}`;
  const manager = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000 });
  let pool: Pool | undefined, store: PostgresIndexerStore | undefined;
  try {
    await manager.query(`CREATE SCHEMA ${schema}`);
    const configuration = { connectionString, options: `-c search_path=${schema}`, max: 4, connectionTimeoutMillis: 5000, idleTimeoutMillis: 1000, statement_timeout: 10_000 };
    pool = new Pool(configuration); store = new PostgresIndexerStore(new Pool(configuration));
    await pool.query(await readFile(new URL('../../../../db/schema.sql', import.meta.url), 'utf8'));
    const manifest = parseManifest({ schemaVersion: 1, deploymentVersion: version, mode: 'local', chainId: 31337,
      genesisHash: `0x${sha(randomUUID())}`, startBlock: '1', anchorHash: h(100), factory: { address: factory, codeHash: h(20) }, marketplace: { address: marketplace, codeHash: h(21) },
      ...(version==='oneshot-nft-v1'?{}:{listingAuthorization:{authority:a(6),salt:h(22)}}) });
    const identity = manifestId(manifest); await store.initialize(identity);
    const canonical = new Map([[0n, at(0n)], [1n, at(1n)], [2n, at(2n)], [3n, at(3n)]]);
    const accounting={escrow:'0',pending:'0',balance:'0'};
    const source: ChainSource = { verify: async observed => { expect(observed).toEqual(manifest); }, height: async () => 3n,
      block: async number => { const result = canonical.get(number); if (!result) throw new Error('Unknown fixture block'); return result; },
      logs: async () => { throw new Error('Public discovery must not ingest logs'); },
      ...(version==='oneshot-nft-v3'?{offerAccounting:async(observed:Manifest,block:Block)=>{
        expect(observed).toEqual(manifest);expect(block).toEqual(canonical.get(block.number));return{...accounting};
      }}:{}) };
    const imageHash = sha('sanitized fixture image');
    const original = Array.from({ length: 40 }, (_, index) => {
      const serial = index + 1;
      const attributes: Trait[] = [{ trait_type: 'Color', value: serial % 2 === 0 ? 'Blue' : 'Red' }, { trait_type: 'Level', value: serial % 4 < 2 ? 7 : '7' }];
      if(wideTraits){attributes.splice(0);for(let type=0;type<99;type++)attributes.push({trait_type:`Trait ${type}`,value:serial});attributes.push({trait_type:'ZZZ beyond visible facets',value:serial});}
      if (!wideTraits && serial === 2) attributes.push({ trait_type: 'Color', value: 'Blue' });
      if (!wideTraits && serial === 5) attributes.push({ trait_type: '', value: 'kept' });
      return { serial, metadataJson: stableJson({ name: [2, 17, 30].includes(serial) ? `Nebula #${serial}` : serial === 9 ? 'Literal %_ item' : `Original #${serial}`,
        description: 'Verified collection metadata.', image: `https://api.oneshot.app/api/media/${imageHash}.webp`, attributes }) };
    });
    const items = original.map(item => ({ serial: item.serial, metadataHash: sha(item.metadataJson), metadataId: `${sha(item.metadataJson)}.json`, imageHash }));
    const manifestHash = sha(stableJson({ items })); const committed = { manifestHash, items };
    const catalog = buildNftMetadataCatalog(manifestHash, committed, original);
    const env: Record<string, string | undefined> = { ONESHOT_INDEXER_READS_ENABLED: 'true', ONESHOT_NETWORK: 'local', DATABASE_URL: connectionString, ONESHOT_INDEXER_MANIFEST_PATH: 'owned-test-manifest' };
    const fixture: Fixture = {
      pool, store, manifest, identity, canonical, env, contentHash: `0x${manifestHash}`, manifestHash, catalog, accounting,
      metadata(number = 1n) { return { schemaVersion: 1, deploymentVersion: manifest.deploymentVersion, chainId: manifest.chainId, lastBlockNumber: number.toString(), lastBlockHash: canonical.get(number)!.hash, lastTransactionHash: h(500), lastLogIndex: 0 }; },
      async putRecord(namespace, id, value) { await pool!.query('INSERT INTO b20_app_records(namespace,id,value) VALUES($1,$2,$3::jsonb) ON CONFLICT(namespace,id) DO UPDATE SET value=EXCLUDED.value', [namespace, id, JSON.stringify(value)]); },
      async read(query = '', options = {}) {
        const reader = createIndexedNftReader({ env: () => env, pool: () => options.pool ?? pool!, loadManifest: async () => manifest,
          source: async () => { if (options.sourceFailure) throw new Error('private rpc/provider password'); return source; } });
        return api(request => reader(request))(new NextRequest(`http://localhost/api/oneshot/indexed/collections/${collection}/explore${query ? `?${query}` : ''}`), {});
      },
    };
    await fixture.putRecord('oneshot_snapshots', manifestHash, { ...committed, ownerUserId: 'private-owner-do-not-leak' });
    await fixture.putRecord(NFT_METADATA_CATALOG_NAMESPACE, manifestHash, catalog);
    await seed(fixture); await run(fixture);
  } finally {
    try { await store?.close(); } finally {
      await pool?.end();
      // schema consists solely of this prefix and generated UUID hex digits.
      await manager.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await manager.end();
    }
  }
}
function item(f: Fixture, tokenId: number, listingId: string | null = null, overrides: ProjectionValue = {}) {
  return { id: `${collection}:${tokenId}`, collection, tokenId: String(tokenId), owner: listingId ? marketplace : alice, burned: false, minted: true,
    activeListingId: listingId, escrowRelease: null, approved: null, transferCount: '1', ...f.metadata(), ...overrides };
}
async function listing(f: Fixture, tx: IndexerTransaction, id: number, tokenId: number, price: bigint, overrides: ProjectionValue = {}) {
  const transactionHash = h(600 + id), value = { listingId: String(id), collection, tokenId: String(tokenId), seller: alice, totalPrice: price.toString(), status: 'active',
    ...f.metadata(), lastTransactionHash: transactionHash, lastLogIndex: id, ...overrides };
  await tx.put('listings', String(id), value);
  await tx.put('activity', `${transactionHash}:${id}`, { schemaVersion: 1, deploymentVersion: f.manifest.deploymentVersion, chainId: f.manifest.chainId,
    eventName: 'Listed', source: marketplace, args: { listingId: String(id), collection, tokenId: String(tokenId), seller: alice, totalPrice: price.toString() },
    blockNumber: '1', blockHash: f.canonical.get(1n)!.hash, transactionHash, transactionIndex: 1, logIndex: id });
}
async function seed(f: Fixture) {
  await f.store.transaction(async tx => {
    await tx.put('collections', collection, { address: collection, creator, factory, name: 'Complete collection', symbol: 'ALL', configured: true, opened: true,
      termsHash: h(30), contentHash: f.contentHash, totalMinted: '40', primaryTotalPrice: '0', primaryPlatformFee: '0', primaryCreatorProceeds: '0', totalClaimed: '0',
      privateEndpoint: 'private-rpc-secret', serverOnlyPath: 'C:/private/secret', ...f.metadata() });
    await tx.put('activity', `${h(501)}:1`, { schemaVersion: 1, deploymentVersion: f.manifest.deploymentVersion, chainId: f.manifest.chainId,
      eventName: 'CollectionOpened', source: collection, args: { termsHash: h(30), contentHash: f.contentHash },
      blockNumber: '1', blockHash: f.canonical.get(1n)!.hash, transactionHash: h(501), transactionIndex: 0, logIndex: 1 });
    const listed: [number, bigint][] = [[1, highPrice - 1n], [2, highPrice], [9, highPrice + 1n], [10, highPrice], [17, 10n ** 18n], [26, 3n * 10n ** 18n], [30, 2n * 10n ** 18n], [31, highPrice + 1n]];
    for (let serial = 1; serial <= 40; serial++) {
      const index = listed.findIndex(([id]) => id === serial);
      await tx.put('items', `${collection}:${serial}`, item(f, serial, index < 0 ? null : String(index + 1)));
    }
    for (const [index, [serial, price]] of listed.entries()) await listing(f, tx, index + 1, serial, price);
    if(f.manifest.deploymentVersion==='oneshot-nft-v3')await tx.put('offer-accounting',marketplace,{market:marketplace,escrow:'0',pending:'0',inflows:'0',claimed:'0',...f.metadata()});
    await tx.append(f.canonical.get(1n)!, []);
  });
}
async function body(response: Response) { expect(response.status).toBe(200); return response.json(); }
async function pages(f: Fixture, initial: string) {
  const result: Record<string, unknown>[] = []; let cursor: string | null = null;
  for (let count = 0; count < 50; count++) {
    const query = new URLSearchParams(initial); if (cursor) query.set('cursor', cursor);
    const response = await body(await f.read(query.toString())); result.push(...response.items); cursor = response.nextCursor;
    if (cursor === null) return { items: result, last: response };
  }
  throw new Error('Discovery cursor did not terminate');
}
const serials = (items: Record<string, unknown>[]) => items.map(value => value.tokenId);
const human = (raw: bigint) => `${raw / 10n ** 18n}.${(raw % 10n ** 18n).toString().padStart(18, '0')}`;

describe.skipIf(!connectionString)('complete collection item discovery on PostgreSQL', () => {
  it.each(['oneshot-nft-v1','oneshot-nft-v2','oneshot-nft-v3'] as const)('preserves canonical name filtering and exact price continuations for %s',async version=>{
    await withDatabase(async f=>{
      expect(f.manifest.deploymentVersion).toBe(version);
      const named=await pages(f,'q=nEbUlA&limit=1');expect(serials(named.items)).toEqual(['2','17','30']);
      expect(named.last.context).toMatchObject({available:true,deploymentId:f.identity,checkpoint:{number:'1',hash:h(101)}});
      const asc=await pages(f,'availability=listed&sort=price-asc&limit=2');expect(serials(asc.items)).toEqual(['17','30','26','1','2','10','9','31']);
      const desc=await pages(f,'availability=listed&sort=price-desc&limit=2');expect(serials(desc.items)).toEqual(['9','31','2','10','1','26','30','17']);
      const exact=await pages(f,new URLSearchParams({availability:'listed',minPrice:human(highPrice),maxPrice:human(highPrice),sort:'price-desc',limit:'1'}).toString());
      expect(serials(exact.items)).toEqual(['2','10']);
      expect(exact.items.every(value=>(value.listing as {totalPriceRaw:string}).totalPriceRaw===highPrice.toString())).toBe(true);
    },false,version);
  });
  it('rejects v3 offer escrow or pending balance mismatches before returning explorer results',async()=>{
    await withDatabase(async f=>{
      expect((await f.read('q=Nebula')).status).toBe(200);
      for(const changed of [{escrow:'1',pending:'0',balance:'1'},{escrow:'0',pending:'1',balance:'1'}]){
        Object.assign(f.accounting,changed);const response=await f.read('availability=listed&sort=price-asc');
        expect(response.status).toBe(503);const result=await response.json();expect(result).not.toHaveProperty('items');expect(result).not.toHaveProperty('discovery');
      }
      Object.assign(f.accounting,{escrow:'0',pending:'0',balance:'0'});
      expect(serials((await body(await f.read('q=Nebula'))).items)).toEqual(['2','17','30']);
    },false,'oneshot-nft-v3');
  });
  it('bounds facet choices without losing filters for traits beyond the visible choices',async()=>{
    await withDatabase(async f=>{
      const initial=await body(await f.read());expect(initial.discovery.facetsTruncated).toBe(true);expect(initial.discovery.facets).toHaveLength(960);
      expect(initial.discovery.facets.some((value:Trait)=>value.trait_type==='ZZZ beyond visible facets')).toBe(false);
      const found=await body(await f.read(`traits=${traits([{trait_type:'ZZZ beyond visible facets',value:40}])}`));expect(serials(found.items)).toEqual(['40']);expect(found.discovery.matchingItems).toBe('1');
    },true);
  });
  it('rejects incomplete minted projections and noncanonical sale proofs as unavailable data',async()=>{
    await withDatabase(async f=>{
      await f.store.transaction(async tx=>{await tx.put('items',`${collection}:17`,item(f,17,'5',{minted:false}));await tx.append(f.canonical.get(2n)!,[]);});
      expect((await f.read()).status).toBe(503);await f.store.transaction(tx=>tx.rollbackHead());
      await f.store.transaction(async tx=>{const action=await tx.get('activity',`${h(607)}:7`);await tx.put('activity',`${h(607)}:7`,{...action!,blockHash:h(999)});await tx.append(f.canonical.get(2n)!,[]);});
      expect((await f.read('availability=listed')).status).toBe(503);
    });
  });
  it('never reads a prepared metadata catalog for a collection that has not opened',async()=>{
    await withDatabase(async f=>{
      await f.store.transaction(async tx=>{const current=await tx.get('collections',collection);await tx.put('collections',collection,{...current!,opened:false,configured:false,contentHash:null,termsHash:null,totalMinted:'0',...f.metadata(2n)});for(let serial=1;serial<=40;serial++)await tx.remove('items',`${collection}:${serial}`);await tx.remove('activity',`${h(501)}:1`);await tx.append(f.canonical.get(2n)!,[]);});
      const guarded:SqlPool={async connect(){const client=await f.pool.connect();return{query:async(sql:string,values?:unknown[])=>{if(sql.includes('b20_app_records'))throw new Error('Unopened metadata must not be queried');return client.query(sql,values);},release:()=>client.release()} as SqlClient;}};
      const response=await body(await f.read('',{pool:guarded}));expect(response.items).toEqual([]);expect(response.discovery).toMatchObject({totalItems:'0',matchingItems:'0',metadataFilters:{available:false}});
    });
  });
  it('finds metadata beyond the first page and counts facets over the entire minted collection', async () => {
    await withDatabase(async f => {
      const all = await pages(f, 'limit=5&sort=serial-asc'); expect(serials(all.items)).toEqual(Array.from({ length: 40 }, (_, i) => String(i + 1)));
      const search = await pages(f, 'q=nEbUlA&limit=1'); expect(serials(search.items)).toEqual(['2', '17', '30']);
      expect(search.last.discovery).toMatchObject({ totalItems: '40', matchingItems: '3', metadataFilters: { available: true, reason: null }, facetScope: 'minted-unburned-collection' });
      expect(search.last.discovery.facets).toEqual(expect.arrayContaining([{ trait_type: 'Color', value: 'Blue', count: '20' }, { trait_type: 'Color', value: 'Red', count: '20' }, { trait_type: '', value: 'kept', count: '1' }]));
      const literal = await body(await f.read(`q=${encodeURIComponent('%_')}`)); expect(serials(literal.items)).toEqual(['9']);
      expect(JSON.stringify(search)).not.toMatch(/private-owner|private-rpc|serverOnlyPath|C:\/private/);
    });
  });

  it('keeps numeric and string traits distinct, ORs values within a type and ANDs different types', async () => {
    await withDatabase(async f => {
      const selected = traits([{ trait_type: 'Color', value: 'Blue' }, { trait_type: 'Color', value: 'Red' }, { trait_type: 'Level', value: 7 }]);
      const result = await pages(f, `traits=${selected}&limit=3`);
      expect(serials(result.items)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1).filter(n => n % 4 < 2).map(String));
      expect(result.last.discovery.matchingItems).toBe('20');
      const strings = await pages(f, `traits=${traits([{ trait_type: 'Level', value: '7' }])}&limit=7`);
      expect(serials(strings.items)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1).filter(n => n % 4 >= 2).map(String));
      const unnamed = await body(await f.read(`traits=${traits([{ trait_type: '', value: 'kept' }])}`)); expect(serials(unnamed.items)).toEqual(['5']);
    });
  });

  it('sorts exact native amounts above Number precision with stable serial tie-breakers across pages', async () => {
    await withDatabase(async f => {
      const asc = await pages(f, 'availability=listed&sort=price-asc&limit=2'); expect(serials(asc.items)).toEqual(['17', '30', '26', '1', '2', '10', '9', '31']);
      const desc = await pages(f, 'availability=listed&sort=price-desc&limit=2'); expect(serials(desc.items)).toEqual(['9', '31', '2', '10', '1', '26', '30', '17']);
      const exact = await body(await f.read(new URLSearchParams({ availability: 'listed', minPrice: human(highPrice), maxPrice: human(highPrice), sort: 'price-asc' }).toString()));
      expect(serials(exact.items)).toEqual(['2', '10']); expect(exact.items.every((value: { listing: { totalPriceRaw: string } }) => value.listing.totalPriceRaw === highPrice.toString())).toBe(true);
      const owned = await pages(f, `owner=${alice}&availability=unlisted&limit=4`); expect(owned.items).toHaveLength(32);
    });
  });

  it('excludes stale escrow, cancelled and burned listing candidates', async () => {
    await withDatabase(async f => {
      await f.store.transaction(async tx => {
        await tx.put('items', `${collection}:2`, item(f, 2, '2', { owner: alice }));
        await tx.put('listings', '4', { listingId: '4', collection, tokenId: '10', seller: alice, totalPrice: highPrice.toString(), status: 'cancelled', ...f.metadata() });
        await tx.put('items', `${collection}:9`, item(f, 9, '3', { burned: true, owner: null }));
        await tx.put('items', `${collection}:26`, item(f, 26, '999'));
        await tx.append(f.canonical.get(2n)!, []);
      });
      const result = await pages(f, 'availability=listed&sort=price-asc&limit=1'); expect(serials(result.items)).toEqual(['17', '30', '1', '31']);
      expect(result.last.discovery.totalItems).toBe('39');
    });
  });

  it('binds continuation cursors to filters, exact ranges, sort, page size and canonical checkpoint', async () => {
    await withDatabase(async f => {
      const first = await body(await f.read('limit=2')); expect(first.nextCursor).toBeTruthy();
      for (const changed of ['limit=3', 'limit=2&q=Nebula', 'limit=2&sort=serial-desc', `limit=2&owner=${alice}`, 'limit=2&availability=listed', `limit=2&traits=${traits([{ trait_type: 'Color', value: 'Blue' }])}`]) {
        const query = new URLSearchParams(changed); query.set('cursor', first.nextCursor); expect((await f.read(query.toString())).status).toBe(400);
      }
      const listed = await body(await f.read('availability=listed&sort=price-asc&limit=2'));
      const alteredRange = new URLSearchParams({ availability: 'listed', sort: 'price-asc', limit: '2', minPrice: '1', cursor: listed.nextCursor }); expect((await f.read(alteredRange.toString())).status).toBe(400);
      await f.store.transaction(async tx => { await tx.put('items', `${collection}:1`, { ...item(f, 1, null, { burned: true, owner: null }), ...f.metadata(2n) }); await tx.append(f.canonical.get(2n)!, []); });
      expect((await f.read(new URLSearchParams({ limit: '2', cursor: first.nextCursor }).toString())).status).toBe(409);
      const newer = await body(await f.read()); expect(newer.discovery.totalItems).toBe('39');
      await f.store.transaction(async tx => { await tx.rollbackHead(); });
      const restored = await body(await f.read()); expect(restored.discovery.totalItems).toBe('40');
      f.canonical.set(1n, at(1n, h(999)));
      const orphan = await f.read(); expect(orphan.status).toBe(409); expect(await orphan.json()).not.toHaveProperty('items');
    });
  });

  it('keeps metadata-independent browsing available for missing catalogs and rejects incomplete or tampered catalog content', async () => {
    await withDatabase(async f => {
      await f.pool.query('DELETE FROM b20_app_records WHERE namespace=$1 AND id=$2', [NFT_METADATA_CATALOG_NAMESPACE, f.manifestHash]);
      const missing = await body(await f.read('limit=3')); expect(missing.items).toHaveLength(3); expect(missing.discovery.metadataFilters).toMatchObject({ available: false });
      expect((await f.read('q=Nebula')).status).toBe(503);
      expect((await f.read(`traits=${traits([{ trait_type: 'Color', value: 'Blue' }])}`)).status).toBe(503);
      const serial = await body(await f.read('q=%2317')); expect(serials(serial.items)).toEqual(['17']);
      const prices = await body(await f.read('availability=listed&sort=price-asc')); expect(prices.items).toHaveLength(8);
      await f.putRecord(NFT_METADATA_CATALOG_NAMESPACE, f.manifestHash, { ...f.catalog, items: f.catalog.items.slice(0, -1) });
      expect((await f.read()).status).toBe(503);
      const tampered = structuredClone(f.catalog); tampered.items[39].metadataJson = '{"name":"private altered metadata"}';
      await f.putRecord(NFT_METADATA_CATALOG_NAMESPACE, f.manifestHash, tampered); const invalid = await f.read('q=Nebula'); expect(invalid.status).toBe(503); expect(JSON.stringify(await invalid.json())).not.toContain('private altered');
    });
  });

  it('never leaks metadata from a different canonical commitment and restores old catalog only after rollback', async () => {
    await withDatabase(async f => {
      const row = (await f.pool.query("SELECT value FROM oneshot_evm_projections WHERE manifest_id=$1 AND kind='collections' AND entity_id=$2", [f.identity, collection])).rows[0].value;
      await f.store.transaction(async tx => { await tx.put('collections', collection, { ...row, contentHash: h(999), ...f.metadata(2n) }); await tx.append(f.canonical.get(2n)!, []); });
      expect((await f.read()).status).toBe(503);
      expect((await f.read('q=Nebula')).status).toBe(503);
      await f.store.transaction(async tx => { await tx.rollbackHead(); });
      expect(serials((await body(await f.read('q=Nebula'))).items)).toEqual(['2', '17', '30']);
    });
  });

  it('distinguishes unavailable context and metadata storage failure from a genuine empty query', async () => {
    await withDatabase(async f => {
      const empty = await body(await f.read('q=NoSuchItem')); expect(empty.items).toEqual([]); expect(empty.context.available).toBe(true); expect(empty.discovery.matchingItems).toBe('0');
      const failing: SqlPool = { async connect() { const client = await f.pool.connect(); return { query: async (sql: string, values?: unknown[]) => {
        if (/FROM b20_app_records/.test(sql)) throw new Error('private database endpoint and password'); return client.query(sql, values);
      }, release: () => client.release() } as SqlClient; } };
      const failed = await f.read('', { pool: failing }); expect(failed.status).toBe(503); expect(JSON.stringify(await failed.json())).not.toMatch(/password|endpoint/);
      expect((await f.read('', { sourceFailure: true })).status).toBe(503);
      f.env.ONESHOT_INDEXER_READS_ENABLED = 'false'; const disabled = await body(await f.read()); expect(disabled).toMatchObject({ collection, items: [], nextCursor: null, discovery: null, context: { enabled: false, available: false } });
    });
  });
});
