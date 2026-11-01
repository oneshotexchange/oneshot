import { createHash, randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { syncIndexer } from '../../apps/indexer/src/engine';
import { manifestId, manifestJson, parseManifest } from '../../apps/indexer/src/manifest';
import { PostgresIndexerStore, type SqlClient, type SqlPool } from '../../apps/indexer/src/store';
import type { ChainSource, IndexerStore, Manifest, Projection, ProjectionKind } from '../../apps/indexer/src/types';

export class CapacityIndexerError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'CapacityIndexerError'; }
}

const kinds: readonly ProjectionKind[] = ['collections', 'items', 'listings', 'claims', 'activity'];
const fail = (code: string): never => { throw new CapacityIndexerError(code); };
const round = (value: number) => Math.round(value * 1000) / 1000;
function limit(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) fail('CAPACITY_INDEXER_OPTIONS_INVALID');
  return value;
}

/** Sort JSON recursively: PostgreSQL jsonb does not preserve insertion order. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean'
    || typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return fail('CAPACITY_PROJECTION_INVALID');
}

/** Only the digest leaves this helper; no entity IDs, wallets, amounts or private policy data do. */
export function capacityProjectionFingerprint(projection: Projection): string {
  return createHash('sha256').update(canonicalJson(projection)).digest('hex');
}

/**
 * The caller supplies an explicit local test Pool. A fresh schema keeps its deployment,
 * journal and projections separate from the fixture being served by the API.
 * SET LOCAL is applied after each BEGIN, so pooled sessions retain no search_path change.
 */
export async function withCapacityIndexerSchema<T>(pool: SqlPool, run: (scopedPool: SqlPool) => Promise<T>): Promise<T> {
  const schema = `oneshot_capacity_${randomBytes(16).toString('hex')}`;
  if (!/^oneshot_capacity_[a-f0-9]{32}$/.test(schema)) return fail('CAPACITY_SCHEMA_INVALID');
  const identifier = `"${schema}"`;
  let created = false;
  try {
    const client = await pool.connect();
    try {
      // No IF NOT EXISTS: cleanup authority comes only from this successful creation.
      await client.query(`CREATE SCHEMA ${identifier}`);
      created = true;
    } finally { client.release(); }
    const scopedPool: SqlPool = {
      async connect(): Promise<SqlClient> {
        const borrowed = await pool.connect();
        let active = false;
        return {
          async query(sql, values) {
            if (sql === 'BEGIN') {
              if (active) return fail('CAPACITY_TRANSACTION_INVALID');
              const result = await borrowed.query(sql, values);
              active = true;
              try { await borrowed.query(`SET LOCAL search_path TO ${identifier}, pg_catalog`); }
              catch {
                try { await borrowed.query('ROLLBACK'); active = false; } catch { /* Evict on release below. */ }
                return fail('CAPACITY_SCHEMA_SCOPE_FAILED');
              }
              return result;
            }
            if (!active) return fail('CAPACITY_TRANSACTION_REQUIRED');
            const result = await borrowed.query(sql, values);
            if (sql === 'COMMIT' || sql === 'ROLLBACK') active = false;
            return result;
          },
          release() {
            // A failed rollback must not return a transaction with a scoped search_path
            // to the caller's Pool. pg discards a borrowed client released with an error.
            if (active) (borrowed as SqlClient & { release(error?: Error): void }).release(new CapacityIndexerError('CAPACITY_TRANSACTION_ABANDONED'));
            else borrowed.release();
          },
        };
      },
      // Deliberately omit end(): the runner owns the supplied Pool.
    };
    return await run(scopedPool);
  } finally {
    if (created) {
      try {
        const client = await pool.connect();
        try { await client.query(`DROP SCHEMA ${identifier} CASCADE`); }
        finally { client.release(); }
      } catch { fail('CAPACITY_SCHEMA_CLEANUP_FAILED'); }
    }
  }
}

type Snapshot = {
  blocks: number; logs: number; headHash: string | null;
  counts: Record<ProjectionKind, number>; fingerprint: string;
};

async function snapshot(store: IndexerStore, pool: SqlPool, id: string): Promise<Snapshot> {
  const values = await store.transaction(async tx => {
    const projection = {} as Projection;
    for (const kind of kinds) projection[kind] = await tx.list(kind);
    return {
      headHash: (await tx.head())?.hash ?? null,
      counts: Object.fromEntries(kinds.map(kind => [kind, Object.keys(projection[kind]).length])) as Record<ProjectionKind, number>,
      fingerprint: capacityProjectionFingerprint(projection),
    };
  });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const counts = await client.query(`SELECT
      (SELECT count(*)::text FROM oneshot_evm_journal WHERE manifest_id=$1) AS blocks,
      (SELECT count(*)::text FROM oneshot_evm_logs WHERE manifest_id=$1) AS logs`, [id]);
    const blocks = Number(counts.rows[0]?.blocks), logs = Number(counts.rows[0]?.logs);
    if (![blocks, logs].every(value => Number.isSafeInteger(value) && value >= 0)) fail('CAPACITY_COUNTS_INVALID');
    await client.query('COMMIT');
    return { ...values, blocks, logs };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

export type CapacityIndexerReport = {
  workload: 'local-indexer-replay';
  storage: 'postgresql-isolated-schema';
  replay: { blocks: number; logs: number; passes: number; durationMs: number; blocksPerSecond: number; logsPerSecond: number };
  repeat: { processedBlocks: number; rolledBackBlocks: number; durationMs: number };
  projectionCounts: Record<ProjectionKind, number>;
  projectionFingerprint: string;
  idempotent: true;
  schemaCleaned: true;
};

/** Bounded full replay of real canonical local blocks, followed by a zero-write idempotence pass. */
export async function runCapacityIndexerWorkload(options: {
  manifest: Manifest; source: ChainSource; pool: SqlPool;
  maxReplayBlocks?: number; batchSize?: number;
}): Promise<CapacityIndexerReport> {
  const maximum = limit(options.maxReplayBlocks ?? 1000, 10_000);
  const batchSize = limit(options.batchSize ?? 100, 1000);
  let manifest: Manifest;
  try { manifest = parseManifest(manifestJson(options.manifest)); }
  catch { return fail('CAPACITY_MANIFEST_INVALID'); }
  try {
    await options.source.verify(manifest);
    const target = await options.source.height();
    if (typeof target !== 'bigint' || target < manifest.startBlock) fail('CAPACITY_CHAIN_EMPTY');
    const expectedBlocks = target - manifest.startBlock + 1n;
    if (expectedBlocks > BigInt(maximum)) fail('CAPACITY_REPLAY_LIMIT');
    // Fix this rehearsal's height. Concurrently appended blocks are outside its measurement.
    // Canonical hashes are still checked by the production sync engine on every pass.
    const source: ChainSource = {
      verify: value => options.source.verify(value), height: async () => target,
      block: number => options.source.block(number), logs: (block, addresses) => options.source.logs(block, addresses),
    };
    const report = await withCapacityIndexerSchema(options.pool, async pool => {
      const store = new PostgresIndexerStore(pool);
      try {
        const start = performance.now();
        let processed = 0, passes = 0;
        while (processed < Number(expectedBlocks)) {
          const result = await syncIndexer(source, store, manifest, { maxBlocks: batchSize });
          passes++;
          // This is a stable-chain replay measurement; report a moving fixture as a failed run.
          if (result.rolledBack || !result.processed) fail('CAPACITY_CHAIN_MOVED');
          processed += result.processed;
          if (result.caughtUp) break;
        }
        const duration = performance.now() - start;
        const first = await snapshot(store, pool, manifestId(manifest));
        if (first.blocks !== processed || processed !== Number(expectedBlocks)) fail('CAPACITY_REPLAY_INCOMPLETE');
        const repeatStart = performance.now();
        const repeat = await syncIndexer(source, store, manifest, { maxBlocks: batchSize });
        const repeatDuration = performance.now() - repeatStart;
        const second = await snapshot(store, pool, manifestId(manifest));
        if (!repeat.caughtUp || repeat.processed || repeat.rolledBack || canonicalJson(first) !== canonicalJson(second)) {
          fail('CAPACITY_REPLAY_NOT_IDEMPOTENT');
        }
        return {
          workload: 'local-indexer-replay' as const, storage: 'postgresql-isolated-schema' as const,
          replay: { blocks: processed, logs: first.logs, passes, durationMs: round(duration),
            blocksPerSecond: round(processed / Math.max(duration, 0.001) * 1000),
            logsPerSecond: round(first.logs / Math.max(duration, 0.001) * 1000) },
          repeat: { processedBlocks: repeat.processed, rolledBackBlocks: repeat.rolledBack, durationMs: round(repeatDuration) },
          projectionCounts: first.counts, projectionFingerprint: first.fingerprint, idempotent: true as const,
        };
      } finally { await store.close(); }
    });
    // This field is emitted only after the owned schema has been dropped successfully.
    return { ...report, schemaCleaned: true };
  } catch (error) {
    if (error instanceof CapacityIndexerError) throw error;
    // RPC and SQL errors may contain endpoints, credentials, addresses or schema names.
    return fail('CAPACITY_INDEXER_FAILED');
  }
}
