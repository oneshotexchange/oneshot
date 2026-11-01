import { describe, expect, it, vi } from 'vitest';
import { capacityProjectionFingerprint, runCapacityIndexerWorkload, withCapacityIndexerSchema } from './capacity-indexer-workload';
import type { QueryResult, SqlPool } from '../../apps/indexer/src/store';
import { emptyProjection, type ChainSource, type Manifest } from '../../apps/indexer/src/types';

const hash = (value: string) => `0x${value.repeat(64)}` as const;
const manifest: Manifest = {
  schemaVersion: 1, deploymentVersion: 'oneshot-nft-v1', mode: 'local', chainId: 31337,
  genesisHash: hash('1'), startBlock: 1n, anchorHash: hash('1'),
  factory: { address: `0x${'1'.repeat(40)}`, codeHash: hash('2') },
  marketplace: { address: `0x${'2'.repeat(40)}`, codeHash: hash('3') },
};

function recordingPool(fail?: (sql: string) => boolean) {
  const statements: string[] = [];
  let releases = 0;
  const releaseErrors: (Error | undefined)[] = [];
  const end = vi.fn(async () => undefined);
  const pool: SqlPool = {
    async connect() {
      return {
        async query(sql): Promise<QueryResult> {
          statements.push(sql);
          if (fail?.(sql)) throw new Error('private SQL connection detail');
          return { rows: [{ ok: true }], rowCount: 1 };
        },
        release(error?: Error) { releases++; releaseErrors.push(error); },
      };
    }, end,
  };
  return { pool, statements, end, releaseErrors, releases: () => releases };
}

function source(height = 1n): ChainSource {
  return {
    verify: vi.fn(async () => undefined), height: vi.fn(async () => height),
    block: vi.fn(async () => { throw new Error('unneeded block'); }),
    logs: vi.fn(async () => []),
  };
}

describe('capacity replay isolation', () => {
  it('scopes each transaction to one exclusively created schema and leaves the caller Pool open', async () => {
    const database = recordingPool();
    const result = await withCapacityIndexerSchema(database.pool, async pool => {
      expect(pool.end).toBeUndefined();
      const client = await pool.connect();
      try {
        await expect(client.query('SELECT 1')).rejects.toMatchObject({ code: 'CAPACITY_TRANSACTION_REQUIRED' });
        await client.query('BEGIN');
        expect((await client.query('SELECT 1')).rows).toEqual([{ ok: true }]);
        await client.query('COMMIT');
        await expect(client.query('SELECT 1')).rejects.toMatchObject({ code: 'CAPACITY_TRANSACTION_REQUIRED' });
        await client.query('BEGIN');
        await client.query('ROLLBACK');
      } finally { client.release(); }
      return 7;
    });
    expect(result).toBe(7);
    const create = database.statements[0];
    expect(create).toMatch(/^CREATE SCHEMA "oneshot_capacity_[a-f0-9]{32}"$/);
    const identifier = create.slice('CREATE SCHEMA '.length);
    expect(database.statements.filter(sql => sql.startsWith('SET LOCAL'))).toEqual([
      `SET LOCAL search_path TO ${identifier}, pg_catalog`, `SET LOCAL search_path TO ${identifier}, pg_catalog`,
    ]);
    expect(database.statements.at(-1)).toBe(`DROP SCHEMA ${identifier} CASCADE`);
    expect(database.statements.some(sql => /DELETE|TRUNCATE|public/.test(sql))).toBe(false);
    expect(database.releases()).toBe(3);
    expect(database.end).not.toHaveBeenCalled();
  });

  it('does not acquire cleanup authority if creating the schema fails', async () => {
    const database = recordingPool(sql => sql.startsWith('CREATE SCHEMA'));
    const run = vi.fn();
    await expect(withCapacityIndexerSchema(database.pool, run)).rejects.toThrow('private SQL connection detail');
    expect(run).not.toHaveBeenCalled();
    expect(database.statements).toHaveLength(1);
    expect(database.releases()).toBe(1);
  });

  it('removes only its created schema when the replay callback fails', async () => {
    const database = recordingPool();
    await expect(withCapacityIndexerSchema(database.pool, async () => { throw new Error('test interruption'); }))
      .rejects.toThrow('test interruption');
    expect(database.statements).toHaveLength(2);
    expect(database.statements[1]).toBe(`${database.statements[0].replace('CREATE SCHEMA', 'DROP SCHEMA')} CASCADE`);
  });

  it('rolls back before releasing a connection when transaction scoping fails', async () => {
    const database = recordingPool(sql => sql.startsWith('SET LOCAL'));
    await expect(withCapacityIndexerSchema(database.pool, async pool => {
      const client = await pool.connect();
      try { await client.query('BEGIN'); } finally { client.release(); }
    })).rejects.toMatchObject({ code: 'CAPACITY_SCHEMA_SCOPE_FAILED' });
    expect(database.statements.slice(1, 4)).toEqual(['BEGIN', expect.stringContaining('SET LOCAL search_path'), 'ROLLBACK']);
    expect(database.statements.at(-1)).toMatch(/^DROP SCHEMA "oneshot_capacity_[a-f0-9]{32}" CASCADE$/);
  });

  it('does not report cleanup success when dropping the owned schema fails', async () => {
    const database = recordingPool(sql => sql.startsWith('DROP SCHEMA'));
    await expect(withCapacityIndexerSchema(database.pool, async () => true))
      .rejects.toMatchObject({ code: 'CAPACITY_SCHEMA_CLEANUP_FAILED', message: 'CAPACITY_SCHEMA_CLEANUP_FAILED' });
  });

  it('evicts an abandoned transaction instead of leaking its search_path to another pool user', async () => {
    const database = recordingPool(sql => sql.startsWith('SET LOCAL') || sql === 'ROLLBACK');
    await expect(withCapacityIndexerSchema(database.pool, async pool => {
      const client = await pool.connect();
      try { await client.query('BEGIN'); } finally { client.release(); }
    })).rejects.toMatchObject({ code: 'CAPACITY_SCHEMA_SCOPE_FAILED' });
    expect(database.releaseErrors).toEqual([
      undefined, expect.objectContaining({ code: 'CAPACITY_TRANSACTION_ABANDONED' }), undefined,
    ]);
  });
});

describe('redacted canonical projection digest', () => {
  it('is stable across PostgreSQL jsonb object-key reordering without emitting entity values', () => {
    const first = emptyProjection(), second = emptyProjection();
    first.collections['private-wallet-id'] = { creator: 'private-wallet', terms: { enabled: true, amount: '9' } };
    second.collections['private-wallet-id'] = { terms: { amount: '9', enabled: true }, creator: 'private-wallet' };
    const fingerprint = capacityProjectionFingerprint(first);
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprint).toBe(capacityProjectionFingerprint(second));
    expect(fingerprint).not.toContain('private-wallet');
    second.collections['private-wallet-id'].creator = 'changed-wallet';
    expect(capacityProjectionFingerprint(second)).not.toBe(fingerprint);
  });

  it('rejects lossy non-JSON values instead of producing a misleading stable digest', () => {
    const projection = emptyProjection();
    projection.items.one = { amount: 1n };
    expect(() => capacityProjectionFingerprint(projection)).toThrow('CAPACITY_PROJECTION_INVALID');
  });
});

describe('bounded capacity replay admission', () => {
  it.each([
    { maxReplayBlocks: 0 }, { maxReplayBlocks: 10_001 }, { maxReplayBlocks: NaN },
    { batchSize: 0 }, { batchSize: 1001 }, { batchSize: 1.5 },
  ])('rejects invalid bounds before accessing the chain or database: %j', async bounds => {
    const database = recordingPool(), chain = source();
    await expect(runCapacityIndexerWorkload({ pool: database.pool, source: chain, manifest, ...bounds }))
      .rejects.toMatchObject({ code: 'CAPACITY_INDEXER_OPTIONS_INVALID' });
    expect(chain.verify).not.toHaveBeenCalled();
    expect(database.statements).toEqual([]);
  });

  it('rejects a nonlocal manifest before accessing the chain or database', async () => {
    const database = recordingPool(), chain = source();
    await expect(runCapacityIndexerWorkload({ pool: database.pool, source: chain,
      manifest: { ...manifest, chainId: 1 } as unknown as Manifest }))
      .rejects.toMatchObject({ code: 'CAPACITY_MANIFEST_INVALID' });
    expect(chain.verify).not.toHaveBeenCalled();
    expect(database.statements).toEqual([]);
  });

  it('sanitizes a failed identity verification before creating a schema', async () => {
    const database = recordingPool(), chain = source();
    chain.verify = async () => { throw new Error('postgres://private-user:private-secret@host/local'); };
    await expect(runCapacityIndexerWorkload({ pool: database.pool, source: chain, manifest }))
      .rejects.toMatchObject({ code: 'CAPACITY_INDEXER_FAILED', message: 'CAPACITY_INDEXER_FAILED' });
    expect(database.statements).toEqual([]);
  });

  it('refuses to replay more than the explicit budget instead of silently truncating the result', async () => {
    const database = recordingPool();
    await expect(runCapacityIndexerWorkload({ pool: database.pool, source: source(3n), manifest, maxReplayBlocks: 2 }))
      .rejects.toMatchObject({ code: 'CAPACITY_REPLAY_LIMIT' });
    expect(database.statements).toEqual([]);
  });

  it('requires a deployed local chain rather than reporting an empty successful replay', async () => {
    const database = recordingPool();
    await expect(runCapacityIndexerWorkload({ pool: database.pool, source: source(0n), manifest }))
      .rejects.toMatchObject({ code: 'CAPACITY_CHAIN_EMPTY' });
    expect(database.statements).toEqual([]);
  });
});
