import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { encodeFunctionData } from 'viem';
import { REVIEWED_NFT_MARKETPLACE_ABI } from '../../../../packages/evm/src/reviewed-nft-abi';
import { reviewedNftExecutionReviewSchema } from '../../../web/lib/reviewed-nft-execution';
import { createReviewedNftExecutionStore, reviewedNftReviewHash, REVIEWED_NFT_EXECUTION_NAMESPACE, type StoredReviewedNftExecution } from './reviewed-nft-execution-store';

const url = process.env.ONESHOT_API_TEST_DATABASE_URL;
const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as `0x${string}`;
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as `0x${string}`;
function record(now: number, owner = 'did:privy:alice', from = address(3), deploymentId = 'a'.repeat(64)): StoredReviewedNftExecution {
  const marketplace = address(2), recipient = address(9), unsigned = { schemaVersion: 1 as const, kind: 'reviewed-external-nft-execution' as const, id: randomUUID(), deploymentId, chainId: 31337 as const,
    network: { mode: 'local' as const, chainId: 31337 as const, name: 'Local Anvil', nativeSymbol: 'ETH' as const, nativeDecimals: 18 as const }, marketplace, registry: address(1),
    from, to: marketplace, data: encodeFunctionData({ abi: REVIEWED_NFT_MARKETPLACE_ABI, functionName: 'claimTo', args: [recipient] }), value: '0', nonce: '17', action: 'claim' as const,
    expiresAt: new Date(now + 120000).toISOString(), simulation: { blockNumber: '10', blockHash: hash(10), blockTimestamp: '1800000000', gasEstimate: '30000' }, terms: { account: from, recipient, amountRaw: '1000', allPending: true as const } };
  return { schemaVersion: 1, owner, session: 'session', createdAt: now, review: reviewedNftExecutionReviewSchema.parse({ ...unsigned, reviewHash: reviewedNftReviewHash(unsigned) }),
    input: { action: 'claim', from, expectedChainId: 31337, expectedDeploymentId: deploymentId, testEthAcknowledged: true, recipient },
    transactionHash: null, outcome: 'review', updatedAt: new Date(now).toISOString(), canonicalReceipt: null };
}
async function withDatabase(run: (fixture: { store: ReturnType<typeof createReviewedNftExecutionStore>; pool(): Pool; reopen(): Promise<void>; now(): number; setTime(value: number): void }) => Promise<void>) {
  if (!url) throw new Error('Dedicated execution recovery test database required.'); const selected = new URL(url);
  if (!['postgres:', 'postgresql:'].includes(selected.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(selected.hostname)
    || selected.pathname !== '/oneshot_indexer_test' || selected.username !== 'oneshot_indexer_test') throw new Error('Use the dedicated loopback oneshot_indexer_test database and role.');
  const schema = `reviewed_recovery_${randomUUID().replaceAll('-', '')}`, manager = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5000 });
  const config = { connectionString: url, options: `-c search_path=${schema}`, max: 8, connectionTimeoutMillis: 5000, statement_timeout: 10000, idleTimeoutMillis: 1000 };
  let pool: Pool | undefined, now = 1800000000000;
  const close = async () => { const old = pool; pool = undefined; await old?.end(); };
  try {
    await manager.query(`CREATE SCHEMA ${schema}`); pool = new Pool(config); await pool.query(await readFile(new URL('../../../../db/schema.sql', import.meta.url), 'utf8'));
    const store = createReviewedNftExecutionStore({ pool: () => pool ?? null, now: () => now });
    await run({ store, pool: () => pool!, reopen: async () => { await close(); pool = new Pool(config); }, now: () => now, setTime: value => { now = value; } });
  } finally { await close(); try { await manager.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await manager.end(); } }
}

describe.skipIf(!url)('real PostgreSQL reviewed NFT execution recovery', () => {
  it('persists exact private reviews across pool restarts and isolates owner reads, pages and attachments', async () => {
    await withDatabase(async ({ store, now, reopen }) => {
      const own = record(now()), other = record(now(), 'did:privy:bob'); await store.save(own); await store.save(other); await reopen();
      expect(await store.get(own.review.id, own.owner)).toEqual(own);
      await expect(store.get(own.review.id, other.owner)).rejects.toMatchObject({ code: 'REVIEWED_NFT_REVIEW_NOT_FOUND' });
      await expect(store.attach(own.review.id, other.owner, hash(1))).rejects.toMatchObject({ code: 'REVIEWED_NFT_REVIEW_NOT_FOUND' });
      expect((await store.list(own.owner)).items.map(value => value.review.id)).toEqual([own.review.id]);
      await store.attach(own.review.id, own.owner, hash(1)); await reopen(); expect((await store.get(own.review.id, own.owner)).transactionHash).toBe(hash(1));
    });
  });
  it('enforces the default100 active fresh-review limit under concurrent boundary saves without blocking old broadcast recovery', async () => {
    await withDatabase(async ({ store, now, setTime, pool }) => {
      const records: StoredReviewedNftExecution[] = [];
      for (let index = 0; index < 90; index++) { const item = record(now()); await store.save(item); records.push(item); }
      const results = await Promise.allSettled(Array.from({ length: 20 }, () => store.save(record(now()))));
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(10);
      for (const result of results) if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: 'REVIEWED_NFT_REVIEW_LIMIT' });
      expect((await pool().query("SELECT count(*)::integer AS n FROM b20_app_records WHERE namespace=$1 AND id NOT LIKE 'tx:%'", [REVIEWED_NFT_EXECUTION_NAMESPACE])).rows[0].n).toBe(100);
      setTime(now() + 120001); await store.save(record(now()));
      expect((await store.attach(records[0].review.id, records[0].owner, hash(1))).outcome).toBe('submitted');
    });
  });
  it('serializes competing hash attachments and reserves a hash for one immutable review per owner/deployment', async () => {
    await withDatabase(async ({ store, now, reopen }) => {
      const first = record(now()), second = record(now()); await store.save(first); await store.save(second);
      const hashes = await Promise.allSettled([store.attach(first.review.id, first.owner, hash(1)), store.attach(first.review.id, first.owner, hash(2))]);
      expect(hashes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      const attached = await store.get(first.review.id, first.owner);
      await expect(store.attach(second.review.id, second.owner, attached.transactionHash!)).rejects.toMatchObject({ code: 'REVIEWED_NFT_TRANSACTION_CHANGED' });
      const third = record(now()); await store.save(third);
      const race = await Promise.allSettled([store.attach(second.review.id, second.owner, hash(3)), store.attach(third.review.id, third.owner, hash(3))]);
      expect(race.filter(result => result.status === 'fulfilled')).toHaveLength(1); await reopen();
      const otherDeployment = record(now(), first.owner, address(3), 'b'.repeat(64)); await store.save(otherDeployment);
      expect((await store.attach(otherDeployment.review.id, first.owner, attached.transactionHash!)).transactionHash).toBe(attached.transactionHash);
      expect((await store.list(first.owner)).items).toHaveLength(4);
    });
  });
  it('atomically records terminal canonical receipts, ignores stale pending results and supports explicit reorg replacement', async () => {
    await withDatabase(async ({ store, now, reopen }) => {
      const item = record(now()); await store.save(item); await store.attach(item.review.id, item.owner, hash(1));
      const terminal = await Promise.allSettled([store.settle(item.review.id, item.owner, hash(1), 'confirmed', undefined, { blockNumber: '11', blockHash: hash(11) }), store.settle(item.review.id, item.owner, hash(1), 'reverted', undefined, { blockNumber: '12', blockHash: hash(12) })]);
      expect(terminal.filter(value => value.status === 'fulfilled')).toHaveLength(1);
      const saved = await store.get(item.review.id, item.owner); expect(saved.canonicalReceipt).not.toBeNull();
      expect(await store.settle(item.review.id, item.owner, hash(1), 'submitted')).toEqual(saved);
      expect((await store.attach(item.review.id, item.owner, hash(1))).outcome).toBe(saved.outcome);
      await store.settle(item.review.id, item.owner, hash(1), 'submitted', undefined, null); await reopen();
      expect((await store.get(item.review.id, item.owner)).canonicalReceipt).toBeNull();
      expect((await store.settle(item.review.id, item.owner, hash(1), 'confirmed', undefined, { blockNumber: '13', blockHash: hash(13) })).canonicalReceipt?.blockHash).toBe(hash(13));
    });
  });
  it('preserves pending rows and hash reservations beyond30 days while cleaning bounded terminal/unsubmitted history', async () => {
    await withDatabase(async ({ store, now, setTime, pool, reopen }) => {
      const pending = record(now()), old = record(now()), unused = record(now()); await store.save(pending); await store.attach(pending.review.id, pending.owner, hash(1));
      await store.save(old); await store.attach(old.review.id, old.owner, hash(2)); await store.settle(old.review.id, old.owner, hash(2), 'confirmed', undefined, { blockNumber: '11', blockHash: hash(11) }); await store.save(unused);
      setTime(now() + 31 * 86400000); const fresh = record(now()); await store.save(fresh); await reopen();
      expect((await store.get(pending.review.id, pending.owner)).outcome).toBe('submitted');
      for (const item of [old, unused]) await expect(store.get(item.review.id, item.owner)).rejects.toMatchObject({ code: 'REVIEWED_NFT_REVIEW_NOT_FOUND' });
      expect((await store.list(pending.owner)).items).toHaveLength(2);
      await expect(store.attach(fresh.review.id, fresh.owner, hash(2))).rejects.toMatchObject({ code: 'REVIEWED_NFT_TRANSACTION_CHANGED' });
      expect((await pool().query("SELECT count(*)::integer AS n FROM b20_app_records WHERE namespace=$1 AND id LIKE 'tx:%'", [REVIEWED_NFT_EXECUTION_NAMESPACE])).rows[0].n).toBe(2);
    });
  });
  it('orders numeric creation times across9/10 and99/100 with wallet/account/page-bound cursors and rejects tampering', async () => {
    await withDatabase(async ({ store, setTime, reopen, pool }) => {
      const items = [];
      for (const tick of [9, 10, 99, 100]) { setTime(tick); const item = record(tick); await store.save(item); items.push(item); }
      await store.save(record(100, 'did:privy:bob')); await store.save(record(100, 'did:privy:alice', address(4))); await reopen();
      const first = await store.list('did:privy:alice', { wallet: address(3), limit: 2 }), second = await store.list('did:privy:alice', { wallet: address(3), limit: 2, cursor: first.nextCursor! });
      expect([...first.items, ...second.items].map(item => item.createdAt)).toEqual([100, 99, 10, 9]); expect(second.nextCursor).toBeNull();
      for (const options of [{ wallet: address(4), limit: 2 }, { wallet: address(3), limit: 3 }]) await expect(store.list('did:privy:alice', { ...options, cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'REVIEWED_NFT_REVIEW_INVALID' });
      await expect(store.list('did:privy:bob', { wallet: address(3), limit: 2, cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'REVIEWED_NFT_REVIEW_INVALID' });
      await pool().query("UPDATE b20_app_records SET value=jsonb_set(value,'{review,nonce}','\"99\"'::jsonb) WHERE namespace=$1 AND id=$2", [REVIEWED_NFT_EXECUTION_NAMESPACE, items[0].review.id]);
      await expect(store.get(items[0].review.id, items[0].owner)).rejects.toMatchObject({ code: 'REVIEWED_NFT_REVIEW_INTEGRITY' });
      await expect(store.list(items[0].owner, { limit: 50 })).rejects.toMatchObject({ code: 'REVIEWED_NFT_REVIEW_INTEGRITY' });
    });
  });
});
