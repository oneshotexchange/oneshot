import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';
import { PostgresIndexerStore } from '../../../indexer/src/store';
import { syncReviewedNftIndexer } from '../../../indexer/src/reviewed-nft-engine';
import { rAdmit, rBlock, rListed, rLog, rManifest as manifest, rSold, rTransfer, ra, rh, ReviewedFixtureSource } from '../../../indexer/test/reviewed-nft-fixture';
import { reviewedNftManifestId } from '../../../../packages/evm/src/reviewed-nft';
import { createReviewedNftReader } from './reviewed-nft-read';
import { api } from './http';

const url = process.env.ONESHOT_API_TEST_DATABASE_URL;
async function fixture(run: (value: { pool: Pool; store: PostgresIndexerStore; source: ReviewedFixtureSource; read(path: string): Promise<Response>; sync(): Promise<unknown> }) => Promise<void>) {
  const target = new URL(url!);
  if (!['postgres:', 'postgresql:'].includes(target.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) || target.username !== 'oneshot_indexer_test' || target.pathname !== '/oneshot_indexer_test') throw Error('Dedicated loopback test database required.');
  const manager = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5000 }), schema = `reviewed_nfts_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool | undefined, store: PostgresIndexerStore | undefined;
  try {
    await manager.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 4, connectionTimeoutMillis: 5000, statement_timeout: 10000 }); store = new PostgresIndexerStore(pool);
    const source = new ReviewedFixtureSource(), reader = createReviewedNftReader({ env: () => ({ ONESHOT_NETWORK: 'local', ONESHOT_REVIEWED_NFT_READS_ENABLED: 'true', ONESHOT_REVIEWED_NFT_IMPORTS_ENABLED: 'false', ONESHOT_INDEXER_READS_ENABLED: 'false', DATABASE_URL: 'fixture-only', ONESHOT_REVIEWED_NFT_MANIFEST_PATH: 'fixture-only' }), pool: () => pool!, loadManifest: async () => manifest, source: async () => source });
    const handler = api(reader), read = (path: string) => handler(new NextRequest(`http://localhost/api/oneshot/reviewed-nfts${path}`), {});
    await run({ pool, store, source, read, sync: () => syncReviewedNftIndexer(source, store!, manifest) });
  } finally { try { if (store) await store.close(); else await pool?.end(); } finally { try { await manager.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await manager.end(); } } }
}
function initial(source: ReviewedFixtureSource) { const block = rBlock(1); source.add(block, [rAdmit(block), rTransfer(block, 1, ra(4), manifest.marketplace.address), rListed(block, 2)], '0', '2'); }
describe.skipIf(!url)('canonical PostgreSQL reviewed external NFT reads', () => {
  it('isolates its manifest and reads observed token0/listing without creator, artwork or supply claims', async () => fixture(async f => {
    initial(f.source); await f.sync(); const collections = await (await f.read('/collections')).json();
    expect(collections.context).toMatchObject({ kind: 'reviewed-external-nft-journal', available: true, deploymentId: reviewedNftManifestId(manifest), coverage: { completeCollection: false, includesPreAdmissionHistory: false } });
    expect(collections.items).toHaveLength(1); expect(JSON.stringify(collections)).not.toMatch(/creator|totalSupply|totalMinted|imagePath|ownerUserId/);
    const item = await (await f.read(`/collections/${ra(10)}/items/0`)).json(); expect(item.item).toMatchObject({ tokenId: '0', owner: manifest.marketplace.address, activeListingId: '1' }); expect(item.listing).toMatchObject({ listingId: '1', status: 'active', totalPriceRaw: '10000' });
    expect((await f.read(`/collections/${ra(10)}/items/1`)).status).toBe(404); expect((await f.read(`/collections/${ra(10)}/items/00`)).status).toBe(400);
  }));
  it('ties final observed ownership to forwarded transfers while preserving the reviewed sale recipient and payouts', async () => fixture(async f => {
    initial(f.source); const b = rBlock(2); f.source.add(b, [rTransfer(b, 0, manifest.marketplace.address, ra(7)), rTransfer(b, 1, ra(7), ra(8)), rSold(b, 2)], '10000', '2'); await f.sync();
    const item = await (await f.read(`/collections/${ra(10)}/items/0`)).json(); expect(item.item.owner).toBe(ra(8)); expect(item.listing).toBeNull();
    const sales = await (await f.read(`/listings?collection=${ra(10)}&status=sold`)).json(); expect(sales.items[0]).toMatchObject({ recipient: ra(7), platformFeeRaw: '200', royaltyRaw: '500', sellerProceedsRaw: '9300' });
    const claims = await (await f.read(`/wallets/${ra(4)}/claims`)).json(); expect(claims.items[0]).toMatchObject({ account: ra(4), pendingRaw: '9300', claimedRaw: '0' });
    const wallet = await (await f.read(`/wallets/${ra(8)}/items`)).json(); expect(wallet.items[0]).toMatchObject({ tokenId: '0' });
  }));
  it('paginates exact sparse IDs and binds cursors to filters, size and canonical head', async () => fixture(async f => {
    const block = rBlock(1); f.source.add(block, [rAdmit(block), ...[0n, 9n, 9007199254740993n].map((id, i) => rTransfer(block, i + 1, ra(4), ra(8), id))]); await f.sync();
    const first = await (await f.read(`/collections/${ra(10)}/items?limit=2`)).json(); expect(first.items.map((v: { tokenId: string }) => v.tokenId)).toEqual(['0', '9']);
    const next = await (await f.read(`/collections/${ra(10)}/items?limit=2&cursor=${first.nextCursor}`)).json(); expect(next.items[0].tokenId).toBe('9007199254740993'); expect(next.nextCursor).toBeNull();
    expect((await f.read(`/collections/${ra(10)}/items?limit=3&cursor=${first.nextCursor}`)).status).toBe(400);
    expect((await f.read(`/wallets/${ra(8)}/items?limit=2&cursor=${first.nextCursor}`)).status).toBe(400);
    f.source.add(rBlock(2)); await f.sync(); expect((await f.read(`/collections/${ra(10)}/items?limit=2&cursor=${first.nextCursor}`)).status).toBe(409);
  }));
  it('returns unavailable for corrupt provenance/ownership/accounting rather than publishing an empty or trusted record', async () => fixture(async f => {
    initial(f.source); await f.sync(); const id = reviewedNftManifestId(manifest);
    await f.pool.query("UPDATE oneshot_evm_projections SET value=jsonb_set(value,'{owner}',to_jsonb($2::text)) WHERE manifest_id=$1 AND kind='items'", [id, ra(99)]);
    expect((await f.read(`/collections/${ra(10)}/items/0`)).status).toBe(503);
    await f.pool.query("UPDATE oneshot_evm_projections SET value=jsonb_set(value,'{pendingRaw}','\"1\"'::jsonb) WHERE manifest_id=$1 AND kind='claims' AND entity_id=$2", [id, `${manifest.marketplace.address}:accounting`]);
    expect((await f.read('/collections')).status).toBe(503);
  }));
  it('rolls the durable journal and current reads back together without leaking orphan sale liabilities', async () => fixture(async f => {
    initial(f.source); const b = rBlock(2); f.source.add(b, [rTransfer(b, 0, manifest.marketplace.address, ra(7)), rSold(b, 1)], '10000', '2'); await f.sync();
    const before = await (await f.read('/activity?limit=2')).json(); const replacement = { ...rBlock(2, 1), parentHash: rBlock(1).hash };
    f.source.add(replacement, [rLog(replacement, manifest.registry.address, 'ReviewRevoked', { collection: ra(10), previousVersion: 1n, version: 2n }, 0)], '0', '2'); await f.sync();
    expect((await f.read(`/activity?limit=2&cursor=${before.nextCursor}`)).status).toBe(409);
    const collection = await (await f.read(`/collections/${ra(10)}`)).json(); expect(collection.collection).toMatchObject({ active: false, reviewVersion: '2' });
    const claims = await (await f.read(`/wallets/${ra(4)}/claims`)).json(); expect(claims.items).toEqual([]);
    const item = await (await f.read(`/collections/${ra(10)}/items/0`)).json(); expect(item.item.owner).toBe(manifest.marketplace.address); expect(item.listing.status).toBe('active');
  }));
  it('preserves the prior PostgreSQL block after a failed settlement projection', async () => fixture(async f => {
    initial(f.source); await f.sync(); const b = rBlock(2); f.source.add(b, [rTransfer(b, 0, manifest.marketplace.address, ra(7)), rSold(b, 1, { platformFee: 201n, sellerProceeds: 9299n })], '10000', '2');
    await expect(f.sync()).rejects.toBeDefined(); const status = await (await f.read('/status')).json(); expect(status.context.checkpoint.number).toBe('1');
    expect((await f.pool.query("SELECT count(*)::text AS total FROM oneshot_evm_journal WHERE block_number=2")).rows[0].total).toBe('0');
  }));
  it('redacts rejected source verification instead of disclosing provider diagnostics', async () => fixture(async f => {
    initial(f.source); await f.sync(); f.source.verify = vi.fn(async () => { throw Error('https://private:credential@rpc.example'); });
    const response = await f.read('/collections'); expect(response.status).toBe(503); expect(await response.text()).not.toContain('credential');
  }));
});
