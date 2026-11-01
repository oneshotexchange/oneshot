import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { createNftLaunchProgressRepository, NFT_LAUNCH_NAMESPACE, type NftLaunchAssociation } from './nft-launch-progress-store';
import { NFT_REVIEW_NAMESPACE } from './nft-launch-store';

const url = process.env.ONESHOT_API_TEST_DATABASE_URL;
const deploymentId = 'ab'.repeat(32), from = `0x${'12'.repeat(20)}`;
async function withDatabase(run: (fixture: { pool: Pool; owner: string; draftId: string; repo: ReturnType<typeof createNftLaunchProgressRepository>; make: (changes?: Partial<NftLaunchAssociation>) => NftLaunchAssociation }) => Promise<void>) {
  if (!url) throw new Error('Dedicated API test database required.');
  const parsed = new URL(url);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || !parsed.pathname.endsWith('_test')) throw new Error('A dedicated local test database is required.');
  const pool = new Pool({ connectionString: url, max: 4, connectionTimeoutMillis: 5000 });
  const owner = `did:privy:launch-progress-test-${randomUUID()}`, draftId = randomUUID();
  const repo = createNftLaunchProgressRepository({ database: () => pool });
  const make = (changes: Partial<NftLaunchAssociation> = {}): NftLaunchAssociation => ({ version: 1, id: randomUUID(), owner, draftId, revision: 2,
    deploymentId, from, collection: `0x${'34'.repeat(20)}`, createHash: `0x${'56'.repeat(32)}`, blockNumber: '12', blockHash: `0x${'78'.repeat(32)}`, createdAt: 1_800_000_000_000, ...changes });
  try { await pool.query(await readFile(path.resolve('db/schema.sql'), 'utf8')); await run({ pool, owner, draftId, repo, make }); }
  finally {
    try { await pool.query('DELETE FROM b20_app_records WHERE namespace=ANY($1::text[]) AND value->>\'owner\'=$2', [[NFT_LAUNCH_NAMESPACE, NFT_REVIEW_NAMESPACE], owner]); }
    finally { await pool.end(); }
  }
}
describe.skipIf(!url)('real PostgreSQL permanent creator progress', () => {
  it('persists across new pools and atomically resolves conflicting and idempotent creation proofs', async () => {
    await withDatabase(async ({ pool, repo, make }) => {
      const value = make();
      const results = await Promise.allSettled(Array.from({ length: 12 }, (_, index) => repo.save({ ...value, collection: `0x${(index % 2 ? '34' : '35').repeat(20)}` })));
      expect(results.some(result => result.status === 'fulfilled')).toBe(true); expect(results.some(result => result.status === 'rejected')).toBe(true);
      const stored = (await repo.get(value.id))!; await repo.save(stored);
      const second = new Pool({ connectionString: url, max: 1 });
      try { expect(await createNftLaunchProgressRepository({ database: () => second }).get(value.id)).toEqual(stored); } finally { await second.end(); }
      const replacement = { ...stored, blockNumber: '14', blockHash: `0x${'90'.repeat(32)}` }; await repo.save(replacement, stored);
      await expect(repo.save({ ...replacement, blockNumber: '15' }, stored)).rejects.toMatchObject({ code: 'LAUNCH_ASSOCIATION_CHANGED' });
      expect((await pool.query('SELECT count(*)::int AS n FROM b20_app_records WHERE namespace=$1 AND id=$2', [NFT_LAUNCH_NAMESPACE, value.id])).rows[0].n).toBe(1);
    });
  });
  it('filters before pagination and scopes cursors to account, draft, revision, wallet and deployment', async () => {
    await withDatabase(async ({ owner, draftId, repo, make }) => {
      const own = Array.from({ length: 5 }, (_, i) => make({ createdAt: 1_800_000_000_000 + i }));
      for (const item of own) await repo.save(item);
      for (const changes of [{ revision: 3 }, { from: `0x${'22'.repeat(20)}` }, { deploymentId: 'cd'.repeat(32) }, { draftId: randomUUID() }]) await repo.save(make({ createdAt: 1_900_000_000_000, ...changes }));
      const input = { draftId, revision: 2, from, deploymentId, limit: 2 };
      const first = await repo.list(owner, input); expect(first.items.map(item => item.id)).toEqual(own.slice(3).reverse().map(item => item.id));
      const second = await repo.list(owner, { ...input, cursor: first.nextCursor! }); expect(second.items.map(item => item.id)).toEqual(own.slice(1, 3).reverse().map(item => item.id));
      const last = await repo.list(owner, { ...input, cursor: second.nextCursor! }); expect(last.items).toHaveLength(1); expect(last.nextCursor).toBeNull();
      await expect(repo.list(owner, { ...input, from: `0x${'22'.repeat(20)}`, cursor: first.nextCursor! })).rejects.toMatchObject({ status: 400 });
      expect((await repo.list('another-account', input)).items).toEqual([]);
    });
  });
  it('keeps retained pending broadcasts separate from durable associations and expired reviews', async () => {
    await withDatabase(async ({ pool, owner, draftId, repo, make }) => {
      const associated = make(); await repo.save(associated);
      const ids = [randomUUID(), associated.id, randomUUID(), randomUUID()];
      for (const [index, id] of ids.entries()) {
        const value = { owner, createdAt: associated.createdAt - (index === 2 ? 31 * 86_400_000 : 0), outcome: 'submitted', transactionHash: index === 3 ? undefined : associated.createHash,
          review: { id, draftId, revision: 2, from, deploymentId, scope: 'draft', action: 'create' } };
        await pool.query('INSERT INTO b20_app_records(namespace,id,value) VALUES($1,$2,$3)', [NFT_REVIEW_NAMESPACE, id, value]);
      }
      expect(await repo.pending(owner, { draftId, revision: 2, from, deploymentId }, associated.createdAt)).toEqual([{ reviewId: ids[0], hash: associated.createHash }]);
      await pool.query('DELETE FROM b20_app_records WHERE namespace=$1 AND value->>\'owner\'=$2', [NFT_REVIEW_NAMESPACE, owner]);
      expect(await repo.get(associated.id)).toEqual(associated);
    });
  });
});
