import { createHash, randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { PostgresIndexerStore } from '../src/store';
import type { Block, RawLog } from '../src/types';

// Opt in with an explicitly dedicated test database. Never use DATABASE_URL here.
const databaseUrl = process.env.ONESHOT_INDEXER_TEST_DATABASE_URL;
const randomManifest = () => `0x${createHash('sha256').update(randomBytes(32)).digest('hex')}`;
const hash = (number: bigint): `0x${string}` => `0x${number.toString(16).padStart(64, '0')}`;
function block(number: bigint, blockHash = hash(number), parentHash = hash(number - 1n)): Block {
  return { number, hash: blockHash, parentHash, timestamp: 1_700_000_000n + number };
}
function log(at: Block, logIndex = 0): RawLog {
  return {
    address: `0x${'1'.repeat(40)}`, data: '0x', topics: [hash(90n)],
    blockNumber: at.number, blockHash: at.hash, transactionHash: hash(100n + BigInt(logIndex)),
    transactionIndex: 0, logIndex,
  };
}

type OpenStore = { store: PostgresIndexerStore; manifestId: string; applicationName: string };
type Fixture = {
  inspect: Pool;
  open(manifestId?: string): Promise<OpenStore>;
};

async function withDatabase(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  if (!databaseUrl) throw new Error('ONESHOT_INDEXER_TEST_DATABASE_URL is required');
  const configuration = {
    connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 1_000, statement_timeout: 10_000,
  };
  const inspect = new Pool({ ...configuration, application_name: 'oneshot-indexer-integration-inspect' });
  const manifests = new Set<string>();
  const stores: PostgresIndexerStore[] = [];
  let schemaReady = false;
  try {
    await run({
      inspect,
      async open(manifestId = randomManifest()): Promise<OpenStore> {
        manifests.add(manifestId);
        const applicationName = `oneshot-it-${manifestId.slice(2, 14)}-${stores.length}`;
        const store = new PostgresIndexerStore(new Pool({ ...configuration, application_name: applicationName }));
        stores.push(store);
        await store.initialize(manifestId);
        schemaReady = true;
        return { store, manifestId, applicationName };
      },
    });
  } finally {
    try {
      if (schemaReady && manifests.size) {
        const client = await inspect.connect();
        try {
          await client.query('BEGIN');
          const ids = [[...manifests]];
          // Scope every deletion to the random manifests created by this fixture.
          await client.query('DELETE FROM oneshot_evm_logs WHERE manifest_id=ANY($1::text[])', ids);
          await client.query('DELETE FROM oneshot_evm_journal WHERE manifest_id=ANY($1::text[])', ids);
          await client.query('DELETE FROM oneshot_evm_projections WHERE manifest_id=ANY($1::text[])', ids);
          await client.query('DELETE FROM oneshot_evm_deployments WHERE manifest_id=ANY($1::text[])', ids);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally { client.release(); }
      }
    } finally {
      // Each store owns its pool; close() also handles stores already closed for a restart.
      try { await Promise.all(stores.map((store) => store.close())); }
      finally { await inspect.end(); }
    }
  }
}

async function counts(inspect: Pool, manifestId: string) {
  const result = await inspect.query(`SELECT
    (SELECT count(*)::integer FROM oneshot_evm_journal WHERE manifest_id=$1) AS blocks,
    (SELECT count(*)::integer FROM oneshot_evm_logs WHERE manifest_id=$1) AS logs,
    (SELECT count(*)::integer FROM oneshot_evm_projections WHERE manifest_id=$1) AS projections`, [manifestId]);
  return result.rows[0];
}

describe.skipIf(!databaseUrl)('real PostgreSQL indexer integration', () => {
  it('commits exact block/log values and atomically rolls back a callback failure after writes', async () => {
    await withDatabase(async ({ inspect, open }) => {
      const { store, manifestId } = await open();
      const initial = block(9_007_199_254_740_993n);
      const next = block(initial.number + 1n);
      await store.transaction(async (transaction) => {
        await transaction.put('items', 'one', { owner: 'alice', amount: '1000000000000000001' });
        await transaction.append(initial, [log(initial)]);
      });
      expect(await counts(inspect, manifestId)).toEqual({ blocks: 1, logs: 1, projections: 1 });
      const persisted = await inspect.query('SELECT payload FROM oneshot_evm_logs WHERE manifest_id=$1', [manifestId]);
      expect(persisted.rows[0]?.payload.blockNumber).toBe(initial.number.toString());

      await expect(store.transaction(async (transaction) => {
        await transaction.put('items', 'one', { owner: 'bob' });
        await transaction.put('items', 'two', { owner: 'carol' });
        await transaction.append(next, [log(next, 0), log(next, 1)]);
        throw new Error('Injected failure after journal and raw log inserts');
      })).rejects.toThrow('Injected failure');
      expect(await counts(inspect, manifestId)).toEqual({ blocks: 1, logs: 1, projections: 1 });
      await store.transaction(async (transaction) => {
        expect(await transaction.head()).toEqual(initial);
        expect(await transaction.block(next.number)).toBeNull();
        expect(await transaction.list('items')).toEqual({ one: { owner: 'alice', amount: '1000000000000000001' } });
      });
    });
  }, 30_000);

  it('restores before-images and cascades orphan logs during reorg rollback and replacement', async () => {
    await withDatabase(async ({ inspect, open }) => {
      const { store, manifestId } = await open();
      // Cross a decimal digit boundary to catch accidental text sorting of numeric heads.
      const first = block(9n);
      const orphan = block(10n);
      const replacement = block(10n, hash(202n));
      await store.transaction(async (transaction) => {
        await transaction.put('items', 'one', { owner: 'alice', amount: '7' });
        await transaction.append(first, [log(first)]);
        await transaction.put('items', 'one', { owner: 'bob' });
        await transaction.remove('items', 'one');
        await transaction.put('items', 'one', { owner: 'carol' });
        await transaction.put('items', 'two', { owner: 'dave' });
        await transaction.append(orphan, [log(orphan, 0), log(orphan, 1)]);
        await transaction.append(block(11n), []);
        expect(await transaction.head()).toEqual(block(11n));
        await transaction.rollbackHead();
      });
      const journal = await inspect.query('SELECT undo FROM oneshot_evm_journal WHERE manifest_id=$1 AND block_number=$2::numeric', [manifestId, '10']);
      expect(journal.rows[0]?.undo).toEqual([
        { kind: 'items', id: 'one', before: { owner: 'alice', amount: '7' } },
        { kind: 'items', id: 'two', before: null },
      ]);
      await store.transaction(async (transaction) => { await transaction.rollbackHead(); });
      expect(await counts(inspect, manifestId)).toEqual({ blocks: 1, logs: 1, projections: 1 });
      await store.transaction(async (transaction) => {
        expect(await transaction.head()).toEqual(first);
        expect(await transaction.list('items')).toEqual({ one: { owner: 'alice', amount: '7' } });
        expect(await transaction.block(10n)).toBeNull();
        await transaction.put('items', 'one', { owner: 'eve', amount: '7' });
        await transaction.append(replacement, [log(replacement)]);
      });
      expect(await counts(inspect, manifestId)).toEqual({ blocks: 2, logs: 2, projections: 1 });
      const raw = await inspect.query('SELECT payload FROM oneshot_evm_logs WHERE manifest_id=$1 AND block_number=$2::numeric', [manifestId, '10']);
      expect(raw.rows).toHaveLength(1);
      expect(raw.rows[0]?.payload.blockHash).toBe(replacement.hash);
      await store.transaction(async (transaction) => { await transaction.rollbackHead(); await transaction.rollbackHead(); });
      expect(await counts(inspect, manifestId)).toEqual({ blocks: 0, logs: 0, projections: 0 });
    });
  }, 30_000);

  it('reopens the same manifest after pool shutdown and isolates a second deployment', async () => {
    await withDatabase(async ({ inspect, open }) => {
      const original = await open();
      const first = block(1n);
      await original.store.transaction(async (transaction) => {
        await transaction.put('items', 'one', { owner: 'alice' });
        await transaction.append(first, [log(first)]);
      });
      await original.store.close();
      const restarted = await open(original.manifestId);
      await restarted.store.transaction(async (transaction) => {
        expect(await transaction.head()).toEqual(first);
        expect(await transaction.block(1n)).toEqual(first);
        expect(await transaction.get('items', 'one')).toEqual({ owner: 'alice' });
      });
      const isolated = await open();
      await expect(restarted.store.initialize(isolated.manifestId)).rejects.toThrow('MANIFEST_MISMATCH');
      await isolated.store.transaction(async (transaction) => {
        expect(await transaction.head()).toBeNull();
        expect(await transaction.list('items')).toEqual({});
        await transaction.put('items', 'one', { owner: 'bob' });
        await transaction.append(first, [log(first)]);
      });
      await restarted.store.transaction(async (transaction) => { await transaction.rollbackHead(); });
      expect(await counts(inspect, original.manifestId)).toEqual({ blocks: 0, logs: 0, projections: 0 });
      expect(await counts(inspect, isolated.manifestId)).toEqual({ blocks: 1, logs: 1, projections: 1 });
      await isolated.store.transaction(async (transaction) => {
        expect(await transaction.head()).toEqual(first);
        expect(await transaction.get('items', 'one')).toEqual({ owner: 'bob' });
      });
    });
  }, 30_000);

  it('serializes two connections and rejects a duplicate block after the competing writer commits', async () => {
    await withDatabase(async ({ inspect, open }) => {
      const firstWriter = await open();
      const secondWriter = await open(firstWriter.manifestId);
      const initial = block(1n);
      const next = block(2n);
      await firstWriter.store.transaction(async (transaction) => {
        await transaction.put('items', 'one', { owner: 'initial' });
        await transaction.append(initial, [log(initial)]);
      });

      let announceFirst!: () => void;
      const firstEntered = new Promise<void>((resolve) => { announceFirst = resolve; });
      let releaseFirst!: () => void;
      const holdFirst = new Promise<void>((resolve) => { releaseFirst = resolve; });
      let secondEntered = false;
      const firstCommit = firstWriter.store.transaction(async (transaction) => {
        expect(await transaction.head()).toEqual(initial);
        await transaction.put('items', 'one', { owner: 'winner' });
        announceFirst();
        await holdFirst;
        await transaction.append(next, [log(next)]);
      });
      await Promise.race([
        firstEntered,
        firstCommit.then(() => { throw new Error('First writer exited before reaching its barrier'); }),
      ]);
      const secondCommit = secondWriter.store.transaction(async (transaction) => {
        secondEntered = true;
        // This read must occur after the first writer's COMMIT releases its lock.
        expect(await transaction.head()).toEqual(next);
        await transaction.put('items', 'one', { owner: 'must roll back' });
        await transaction.append(next, [log(next)]);
      });
      const completed = Promise.allSettled([firstCommit, secondCommit]);
      try {
        // Observe an actual waiting PostgreSQL advisory lock before releasing writer one.
        await expect.poll(async () => {
          const waiting = await inspect.query(`SELECT count(*)::integer AS waiting
            FROM pg_locks AS locks JOIN pg_stat_activity AS activity ON activity.pid=locks.pid
            WHERE locks.locktype='advisory' AND NOT locks.granted AND activity.application_name=$1`, [secondWriter.applicationName]);
          return waiting.rows[0]?.waiting;
        }, { timeout: 5_000, interval: 20 }).toBe(1);
        expect(secondEntered).toBe(false);
      } finally { releaseFirst(); await completed; }
      const outcomes = await completed;
      expect(outcomes[0]?.status).toBe('fulfilled');
      expect(outcomes[1]?.status).toBe('rejected');
      if (outcomes[1]?.status === 'rejected') expect(outcomes[1].reason).toMatchObject({ code: 'NON_CONTIGUOUS_BLOCK' });
      expect(secondEntered).toBe(true);
      expect(await counts(inspect, firstWriter.manifestId)).toEqual({ blocks: 2, logs: 2, projections: 1 });
      await firstWriter.store.transaction(async (transaction) => {
        expect(await transaction.head()).toEqual(next);
        expect(await transaction.get('items', 'one')).toEqual({ owner: 'winner' });
      });
    });
  }, 30_000);
});
