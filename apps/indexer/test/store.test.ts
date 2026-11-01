import { describe, expect, it } from 'vitest';
import {
  MemoryIndexerStore, PostgresIndexerStore,
  type QueryResult, type SqlClient, type SqlPool,
} from '../src/store';
import type { Block, IndexerStore, IndexerTransaction, ProjectionValue, RawLog } from '../src/types';

const hash = (number: bigint): `0x${string}` => `0x${number.toString(16).padStart(64, '0')}`;
const block = (number: bigint, parentHash = hash(number - 1n)): Block => ({ number, hash: hash(number), parentHash, timestamp: 1_700_000_000n + number });
function log(at: Block, logIndex = 0): RawLog {
  return {
    address: `0x${'1'.repeat(40)}`, data: '0x', topics: [hash(3n)],
    blockNumber: at.number, blockHash: at.hash, transactionHash: hash(10n), transactionIndex: 0, logIndex,
  };
}
async function read(store: IndexerStore) {
  return store.transaction(async (transaction) => ({ head: await transaction.head(), items: await transaction.list('items') }));
}

type DatabaseState = {
  deployments: Set<string>;
  projections: Map<string, { manifest: string; kind: string; id: string; value: ProjectionValue }>;
  journal: Map<string, Record<string, unknown>>;
  logs: Map<string, { manifest: string; number: string; payload: Record<string, unknown> }>;
};
const emptyDatabase = (): DatabaseState => ({ deployments: new Set(), projections: new Map(), journal: new Map(), logs: new Map() });
const key = (...values: unknown[]) => JSON.stringify(values);
const clone = <T>(value: T): T => structuredClone(value);

/** SQL adapter tests transaction boundaries and parameters, not PostgreSQL execution. */
class DatabaseAdapter implements SqlPool {
  durable = emptyDatabase();
  statements: { sql: string; values: unknown[] }[] = [];
  releases = 0;
  ended = false;
  failCommit = false;
  failLogIndex?: number;

  async connect(): Promise<SqlClient> {
    const adapter = this;
    let pending: DatabaseState | undefined;
    return {
      async query(rawSql, values = []): Promise<QueryResult> {
        const sql = rawSql.replace(/\s+/g, ' ').trim();
        adapter.statements.push({ sql, values: clone(values) });
        const result = (rows: Record<string, unknown>[] = [], rowCount = rows.length): QueryResult => ({ rows, rowCount });
        if (sql === 'BEGIN') { pending = clone(adapter.durable); return result(); }
        if (sql === 'ROLLBACK') { pending = undefined; return result(); }
        if (sql === 'COMMIT') {
          if (!pending) throw new Error('Commit outside transaction');
          if (adapter.failCommit) { adapter.failCommit = false; throw new Error('Injected commit failure'); }
          adapter.durable = pending;
          pending = undefined;
          return result();
        }
        if (!pending) throw new Error(`Query outside transaction: ${sql}`);
        if (sql.startsWith('SELECT pg_advisory_xact_lock') || sql.startsWith('CREATE TABLE')) return result();
        const manifest = String(values[0]);
        if (sql.startsWith('INSERT INTO oneshot_evm_deployments')) { pending.deployments.add(manifest); return result([], 1); }
        if (!pending.deployments.has(manifest)) throw new Error('Unknown deployment');
        if (sql.startsWith('SELECT block_number::text')) {
          let rows = [...pending.journal.values()].filter((row) => row.manifest_id === manifest);
          if (sql.includes('AND block_number=')) rows = rows.filter((row) => row.block_number === values[1]);
          else rows.sort((left, right) => BigInt(String(left.block_number)) > BigInt(String(right.block_number)) ? -1 : 1);
          return result(rows.slice(0, 1).map(clone));
        }
        if (sql.startsWith('SELECT value FROM oneshot_evm_projections')) {
          const row = pending.projections.get(key(...values));
          return result(row ? [{ value: clone(row.value) }] : []);
        }
        if (sql.startsWith('SELECT entity_id, value')) {
          return result([...pending.projections.values()].filter((row) => row.manifest === manifest && row.kind === values[1]).map((row) => ({ entity_id: row.id, value: clone(row.value) })));
        }
        if (sql.startsWith('INSERT INTO oneshot_evm_projections')) {
          pending.projections.set(key(...values.slice(0, 3)), { manifest, kind: String(values[1]), id: String(values[2]), value: JSON.parse(String(values[3])) });
          return result([], 1);
        }
        if (sql.startsWith('DELETE FROM oneshot_evm_projections')) {
          return result([], Number(pending.projections.delete(key(...values))));
        }
        if (sql.startsWith('INSERT INTO oneshot_evm_journal')) {
          const id = key(manifest, values[1]);
          if (pending.journal.has(id)) throw new Error('Duplicate journal block');
          pending.journal.set(id, { manifest_id: manifest, block_number: values[1], block_hash: values[2], parent_hash: values[3], block_timestamp: values[4], undo: JSON.parse(String(values[5])) });
          return result([], 1);
        }
        if (sql.startsWith('INSERT INTO oneshot_evm_logs')) {
          if (values[2] === adapter.failLogIndex) throw new Error('Injected raw log failure');
          if (!pending.journal.has(key(manifest, values[1]))) throw new Error('Missing journal foreign key');
          const id = key(...values.slice(0, 3));
          if (pending.logs.has(id)) throw new Error('Duplicate raw log');
          pending.logs.set(id, { manifest, number: String(values[1]), payload: JSON.parse(String(values[3])) });
          return result([], 1);
        }
        if (sql.startsWith('DELETE FROM oneshot_evm_journal')) {
          pending.journal.delete(key(...values));
          for (const [id, entry] of pending.logs) if (entry.manifest === manifest && entry.number === values[1]) pending.logs.delete(id);
          return result([], 1);
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      },
      release() { adapter.releases++; },
    };
  }
  async end(): Promise<void> { this.ended = true; }
}

describe.each([
  ['memory', () => new MemoryIndexerStore()],
  ['PostgreSQL adapter', () => new PostgresIndexerStore(new DatabaseAdapter())],
] as const)('%s indexer store', (_name, makeStore) => {
  it('requires initialization and binds a store permanently to one manifest', async () => {
    const store = makeStore();
    await expect(read(store)).rejects.toThrow('STORE_NOT_INITIALIZED');
    await store.initialize('manifest-a');
    await store.transaction(async (transaction) => { await transaction.append(block(1n), []); });
    await store.initialize('manifest-a');
    await expect(store.initialize('manifest-b')).rejects.toThrow('MANIFEST_MISMATCH');
    expect((await read(store)).head?.number).toBe(1n);
    await store.close();
    await expect(read(store)).rejects.toThrow('STORE_CLOSED');
  });

  it('restores the original before-image after repeated put/remove and supports mixed append/rollback', async () => {
    const store = makeStore();
    await store.initialize('manifest-a');
    await store.transaction(async (transaction) => {
      await transaction.put('items', 'existing', { owner: 'alice', price: '900719925474099312345' });
      await transaction.append(block(1n), [log(block(1n))]);
      await transaction.put('items', 'existing', { owner: 'bob' });
      await transaction.remove('items', 'existing');
      await transaction.put('items', 'existing', { owner: 'carol' });
      await transaction.put('items', 'new', { owner: 'dave' });
      await transaction.append(block(2n), [log(block(2n))]);
      await transaction.rollbackHead();
      expect(await transaction.get('items', 'existing')).toEqual({ owner: 'alice', price: '900719925474099312345' });
      expect(await transaction.get('items', 'new')).toBeNull();
      expect(await transaction.block(2n)).toBeNull();
      await transaction.append(block(2n), []);
      await transaction.append(block(3n), []);
      await transaction.rollbackHead();
      expect((await transaction.head())?.number).toBe(2n);
    });
    await store.transaction(async (transaction) => { await transaction.rollbackHead(); await transaction.rollbackHead(); await transaction.rollbackHead(); });
    expect(await read(store)).toEqual({ head: null, items: {} });
    await store.close();
  });

  it('does not retain references to inputs, returned projections or block logs', async () => {
    const store = makeStore();
    await store.initialize('manifest-a');
    const value = { owner: { address: 'alice' }, balances: ['1'] };
    const at = block(1n);
    const raw = log(at);
    await store.transaction(async (transaction) => {
      await transaction.put('items', '__proto__', value);
      await transaction.append(at, [raw]);
    });
    value.owner.address = 'mutated';
    value.balances.push('2');
    at.number = 99n;
    raw.topics = [];
    const first = await read(store);
    (first.items.__proto__!.owner as { address: string }).address = 'changed again';
    first.head!.number = 88n;
    const second = await read(store);
    expect(second.head?.number).toBe(1n);
    expect(Object.hasOwn(second.items, '__proto__')).toBe(true);
    expect(second.items.__proto__).toEqual({ owner: { address: 'alice' }, balances: ['1'] });
    await store.close();
  });

  it('rolls back a partially projected and appended transaction when its callback fails', async () => {
    const store = makeStore();
    await store.initialize('manifest-a');
    await expect(store.transaction(async (transaction) => {
      await transaction.put('items', 'one', { owner: 'alice' });
      await transaction.append(block(1n), [log(block(1n))]);
      await transaction.put('items', 'two', { owner: 'bob' });
      throw new Error('Projection failed');
    })).rejects.toThrow('Projection failed');
    expect(await read(store)).toEqual({ head: null, items: {} });
    await store.transaction(async (transaction) => { await transaction.append(block(1n), []); });
    expect((await read(store)).head?.number).toBe(1n);
    await store.close();
  });

  it('rejects lossy projection values and unjournaled writes', async () => {
    const store = makeStore();
    await store.initialize('manifest-a');
    for (const value of [{ amount: 1n }, { amount: undefined }, { amount: NaN }, { amount: new Date() }]) {
      await expect(store.transaction(async (transaction) => { await transaction.put('items', 'bad', value); })).rejects.toThrow('PROJECTION_NOT_JSON');
    }
    await expect(store.transaction(async (transaction) => { await transaction.put('items', 'bad', { amount: '1' }); })).rejects.toThrow('UNJOURNALED_PROJECTIONS');
    expect(await read(store)).toEqual({ head: null, items: {} });
    let retained: IndexerTransaction | undefined;
    await store.transaction(async (transaction) => { retained = transaction; });
    await expect(retained!.head()).rejects.toThrow('TRANSACTION_CLOSED');
    await store.close();
  });

  it('rejects invalid log batches and noncontiguous blocks without altering the head', async () => {
    const store = makeStore();
    await store.initialize('manifest-a');
    await store.transaction(async (transaction) => { await transaction.append(block(1n), []); });
    await expect(store.transaction(async (transaction) => { await transaction.append(block(3n), []); })).rejects.toThrow('NON_CONTIGUOUS_BLOCK');
    await expect(store.transaction(async (transaction) => { await transaction.append(block(2n, hash(99n)), []); })).rejects.toThrow('NON_CONTIGUOUS_BLOCK');
    await expect(store.transaction(async (transaction) => { await transaction.append(block(2n), [log(block(1n))]); })).rejects.toThrow('LOG_BLOCK_MISMATCH');
    await expect(store.transaction(async (transaction) => { await transaction.append(block(2n), [log(block(2n)), log(block(2n))]); })).rejects.toThrow('INVALID_LOG_INDEX');
    expect((await read(store)).head?.number).toBe(1n);
    await store.close();
  });
});

describe('memory journal evidence', () => {
  it('keeps raw logs and one before-image per changed entity, and clones snapshots', async () => {
    const store = new MemoryIndexerStore();
    await store.initialize('manifest-a');
    await store.transaction(async (transaction) => {
      await transaction.put('items', 'one', { amount: '1' });
      await transaction.put('items', 'one', { amount: '2' });
      await transaction.append(block(1n), [log(block(1n))]);
    });
    const snapshot = await store.snapshot();
    expect(snapshot.blocks[0]?.undo).toEqual([{ kind: 'items', id: 'one', before: null }]);
    expect(snapshot.blocks[0]?.logs[0]?.blockNumber).toBe(1n);
    snapshot.blocks[0]!.logs[0]!.topics = [];
    snapshot.projection.items.one!.amount = '9';
    expect((await store.snapshot()).blocks[0]?.logs[0]?.topics).toHaveLength(1);
    expect((await store.snapshot()).projection.items.one!.amount).toBe('2');
    await expect(store.transaction(async (transaction) => { await transaction.append(block(2n), [log(block(2n))]); throw new Error('fail'); })).rejects.toThrow('fail');
    expect((await store.snapshot()).blocks).toHaveLength(1);
  });

  it('serializes concurrent callbacks so updates cannot overwrite one another', async () => {
    const store = new MemoryIndexerStore();
    await store.initialize('manifest-a');
    await store.transaction(async (transaction) => { await transaction.put('items', 'counter', { count: '0' }); await transaction.append(block(1n), []); });
    await Promise.all([1, 2, 3].map(async () => store.transaction(async (transaction) => {
      const current = await transaction.get('items', 'counter');
      await Promise.resolve();
      await transaction.put('items', 'counter', { count: String(Number(current!.count) + 1) });
      const head = await transaction.head();
      await transaction.append(block(head!.number + 1n), []);
    })));
    expect((await read(store)).items.counter).toEqual({ count: '3' });
    expect((await read(store)).head?.number).toBe(4n);
  });
});

describe('PostgreSQL transaction adapter', () => {
  it('rolls back projections, raw logs and journal when COMMIT fails', async () => {
    const database = new DatabaseAdapter();
    const store = new PostgresIndexerStore(database);
    await store.initialize('manifest-a');
    database.failCommit = true;
    await expect(store.transaction(async (transaction) => {
      await transaction.put('items', 'one', { amount: '10' });
      await transaction.append(block(1n), [log(block(1n))]);
    })).rejects.toThrow('Injected commit failure');
    expect(database.durable.projections.size).toBe(0);
    expect(database.durable.journal.size).toBe(0);
    expect(database.durable.logs.size).toBe(0);
    expect(database.statements.at(-1)?.sql).toBe('ROLLBACK');
    expect(await read(store)).toEqual({ head: null, items: {} });
  });

  it('does not retain earlier writes when inserting a later raw log fails', async () => {
    const database = new DatabaseAdapter();
    const store = new PostgresIndexerStore(database);
    await store.initialize('manifest-a');
    database.failLogIndex = 1;
    await expect(store.transaction(async (transaction) => {
      await transaction.put('items', 'one', { amount: '10' });
      await transaction.append(block(1n), [log(block(1n), 0), log(block(1n), 1)]);
    })).rejects.toThrow('Injected raw log failure');
    expect(database.durable.projections.size).toBe(0);
    expect(database.durable.journal.size).toBe(0);
    expect(database.durable.logs.size).toBe(0);
  });

  it('recovers its journal after restart and isolates another deployment fingerprint', async () => {
    const database = new DatabaseAdapter();
    const first = new PostgresIndexerStore(database);
    await first.initialize('manifest-a');
    const large = block(9_007_199_254_740_993n);
    await first.transaction(async (transaction) => {
      await transaction.put('items', 'one', { amount: '1000000000000000001' });
      await transaction.append(large, [log(large)]);
    });
    const restarted = new PostgresIndexerStore(database);
    await restarted.initialize('manifest-a');
    // A caller can detect an already indexed block without replaying its projections.
    await restarted.transaction(async (transaction) => {
      expect(await transaction.block(large.number)).toEqual(large);
      expect(await transaction.head()).toEqual(large);
    });
    expect(database.durable.logs.size).toBe(1);
    expect([...database.durable.logs.values()][0]?.payload.blockNumber).toBe(large.number.toString());
    const other = new PostgresIndexerStore(database);
    await other.initialize('manifest-b');
    expect(await read(other)).toEqual({ head: null, items: {} });
    await other.transaction(async (transaction) => { await transaction.append(block(1n), []); });
    await restarted.transaction(async (transaction) => { await transaction.rollbackHead(); });
    expect(await read(restarted)).toEqual({ head: null, items: {} });
    expect((await read(other)).head?.number).toBe(1n);
    expect(database.durable.logs.size).toBe(0);
  });

  it('acquires a manifest transaction lock on each dedicated connection and closes the pool', async () => {
    const database = new DatabaseAdapter();
    const store = new PostgresIndexerStore(database);
    await store.initialize('manifest-a');
    await read(store);
    await store.transaction(async (transaction) => { await transaction.append(block(1n), []); });
    const locks = database.statements.filter((statement) => statement.sql.includes("hashtext('oneshot_evm_indexer')"));
    expect(locks).toHaveLength(3);
    expect(locks.every((statement) => statement.values[0] === 'manifest-a')).toBe(true);
    expect(database.releases).toBe(3);
    expect(database.statements.some((statement) => /\bb20_/.test(statement.sql))).toBe(false);
    await store.close();
    expect(database.ended).toBe(true);
  });
});
