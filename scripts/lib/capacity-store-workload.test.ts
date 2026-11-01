import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { Hex } from 'viem';
import type { StoredNftReview } from '../../apps/api/lib/server/nft-launch-store';
import { NFT_REVIEW_NAMESPACE } from '../../apps/api/lib/server/nft-launch-store';
import { capacityStoreWorkload } from './capacity-store-workload';

type FixtureOptions = { nonAtomic?: boolean; leakList?: boolean; loseExactPrice?: boolean; loseOutcome?: boolean; createError?: Error; cleanupError?: Error };
function fixture(options: FixtureOptions = {}) {
  const rows = new Map<string, StoredNftReview>(), pools: Pool[] = [], cleanup: unknown[][] = [];
  const error = (code: string) => Object.assign(new Error('Fixture error detail must never be reported'), { code });
  const pool = { query: async (sql: string, args: unknown[]) => {
    cleanup.push([sql, ...args]);
    if (options.cleanupError) throw options.cleanupError;
    const [namespace, ids, owners] = args as [string, string[], string[]];
    expect(namespace).toBe(NFT_REVIEW_NAMESPACE);
    let deleted = 0;
    for (const [id, item] of rows) if (ids.includes(id) && owners.includes(item.owner)) { rows.delete(id); deleted++; }
    return { rowCount: deleted };
  } } as unknown as Pool;
  const recoveryPool = {} as Pool;
  const repository = (selectedPool: Pool) => {
    pools.push(selectedPool);
    return {
      create: async (item: StoredNftReview) => {
        if (options.createError) throw options.createError;
        rows.set(item.review.id, structuredClone(item));
      },
      get: async (id: string) => {
        const item = structuredClone(rows.get(id) ?? null);
        if (item && options.loseExactPrice) item.review.summary.priceRaw = String(Number(item.review.summary.priceRaw));
        if (item && selectedPool === recoveryPool && options.loseOutcome) item.outcome = 'submitted';
        return item;
      },
      bindHash: async (id: string, owner: string, hash: Hex) => {
        // Different async clients still make the check-and-bind mutation atomic.
        await Promise.resolve();
        const item = rows.get(id);
        if (!item || item.owner !== owner) throw error('REVIEW_NOT_FOUND');
        if (!options.nonAtomic && item.transactionHash && item.transactionHash !== hash) throw error('TRANSACTION_CHANGED');
        item.transactionHash = hash; item.outcome = 'submitted';
        return structuredClone(item);
      },
      setOutcome: async (id: string, hash: Hex, outcome: 'submitted' | 'confirmed' | 'reverted') => {
        const item = rows.get(id);
        if (!item || item.transactionHash !== hash) throw error('TRANSACTION_CHANGED');
        item.outcome = outcome;
      },
      list: async (owner: string, input: { limit: number; cursor?: string }) => {
        const sorted = [...rows.values()].filter(item => options.leakList || item.owner === owner).sort((a, b) => b.createdAt - a.createdAt);
        const offset = Number(input.cursor ?? 0), items = sorted.slice(offset, offset + input.limit);
        return { items: structuredClone(items), ...(offset + input.limit < sorted.length ? { nextCursor: String(offset + input.limit) } : {}) };
      },
    };
  };
  let time = 0;
  return { pool, recoveryPool, repository, rows, pools, cleanup, clock: () => ++time };
}

describe('bounded local persistence capacity workload', () => {
  it('checks exact large native amounts, first-hash races, ownership, fresh pool recovery, outcomes, and bounded cleanup', async () => {
    const f = fixture();
    const result = await capacityStoreWorkload({ pool: f.pool, recoveryPool: f.recoveryPool, records: 8, concurrency: 3 }, f);
    expect(result.failures).toEqual([]);
    expect(Object.values(result.checks).every(Boolean)).toBe(true);
    expect(result.counts.created).toBe(8); expect(result.counts.cleaned).toBe(8);
    expect(result.counts.expectedRejections).toBe(3); // Two losing hashes and another account's bind attempt.
    expect(result.counts.failed).toBe(0);
    expect(result.counts.attempted).toBe(result.samples.length);
    expect(result.counts.succeeded).toBe(result.samples.length);
    expect(result.samples.every(sample => sample.ok && sample.durationMs > 0)).toBe(true);
    expect(f.pools).toEqual([f.pool, f.recoveryPool]); expect(f.rows.size).toBe(0);
    expect(f.cleanup).toHaveLength(1);
    const [sql, namespace, ids, owners] = f.cleanup[0];
    expect(sql).toContain("namespace=$1 AND id=ANY($2::text[]) AND value->>'owner'=ANY($3::text[])");
    expect(namespace).toBe(NFT_REVIEW_NAMESPACE); expect(ids).toHaveLength(8); expect(owners).toHaveLength(2);
    expect(JSON.stringify(result)).not.toMatch(/did:privy|0x[\da-f]{8}|priceRaw|calldata|Internal persistence/);
  });

  it('checks every history page when records exceed the repository page size', async () => {
    const f = fixture(), result = await capacityStoreWorkload({ pool: f.pool, recoveryPool: f.recoveryPool, records: 100, concurrency: 16 }, f);
    expect(result.failures).toEqual([]); expect(result.checks.exactRecovery).toBe(true);
    expect(result.samples.filter(sample => sample.operation === 'store.recoverList')).toHaveLength(3);
    expect(result.samples.filter(sample => sample.operation === 'store.restartList')).toHaveLength(3);
    expect(result.counts.created).toBe(100); expect(f.rows.size).toBe(0);
  });

  it('reports a broken first-hash race and still cleans only its own rows', async () => {
    const f = fixture({ nonAtomic: true });
    const unrelated = { owner: 'another-account' } as StoredNftReview;
    f.rows.set('unrelated-row', unrelated);
    const result = await capacityStoreWorkload({ pool: f.pool, recoveryPool: f.recoveryPool, records: 3, concurrency: 2 }, f);
    expect(result.failures).toEqual(['STORE_HASH_RACE_FAILED']); expect(result.checks.firstHashRace).toBe(false);
    expect(result.checks.cleanup).toBe(true); expect(f.rows.get('unrelated-row')).toBe(unrelated); expect(f.rows.size).toBe(1);
  });

  it('rejects account history leaks instead of treating successful queries as successful invariants', async () => {
    const f = fixture({ leakList: true });
    const result = await capacityStoreWorkload({ pool: f.pool, recoveryPool: f.recoveryPool, records: 3, concurrency: 2 }, f);
    expect(result.failures).toEqual(['STORE_ACCOUNT_ISOLATION_FAILED']);
    expect(result.checks.accountIsolation).toBe(false); expect(result.checks.cleanup).toBe(true);
  });

  it('detects rounding of stored prices beyond JavaScript safe integer precision', async () => {
    const f = fixture({ loseExactPrice: true });
    const result = await capacityStoreWorkload({ pool: f.pool, recoveryPool: f.recoveryPool, records: 3, concurrency: 2 }, f);
    expect(result.failures).toEqual(['STORE_EXACT_RECOVERY_FAILED']);
    expect(result.counts.failed).toBe(3); expect(result.checks.cleanup).toBe(true);
  });

  it('requires confirmed and reverted outcomes to survive fresh database clients', async () => {
    const f = fixture({ loseOutcome: true });
    const result = await capacityStoreWorkload({ pool: f.pool, recoveryPool: f.recoveryPool, records: 3, concurrency: 2 }, f);
    expect(result.failures).toEqual(['STORE_OUTCOME_RECOVERY_FAILED']);
    expect(result.checks.outcomeRecovery).toBe(false); expect(result.checks.separatePoolRecovery).toBe(false); expect(result.checks.cleanup).toBe(true);
  });

  it('keeps database errors and cleanup errors redacted', async () => {
    const secret = 'postgresql://private-user:secret-password@127.0.0.1/private_test';
    const f = fixture({ createError: new Error(secret), cleanupError: new Error(secret) });
    const result = await capacityStoreWorkload({ pool: f.pool, recoveryPool: f.recoveryPool, records: 3, concurrency: 2 }, f);
    expect(result.failures).toEqual(['STORE_OPERATION_FAILED', 'STORE_CLEANUP_FAILED']);
    expect(result.checks.cleanup).toBe(false); expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.counts.failed).toBe(4); expect(result.samples.every(sample => !sample.ok)).toBe(true);
  });

  it('waits for every started worker before cleanup after a write fails', async () => {
    const f = fixture(); let started = 0, active = 0, peak = 0;
    const repository = (pool: Pool) => {
      const repo = f.repository(pool);
      return { ...repo, create: async (item: StoredNftReview) => {
        const position = started++; active++; peak = Math.max(peak, active);
        try {
          if (position === 0) throw new Error('An initial write failed.');
          await new Promise(resolve => setTimeout(resolve, 2));
          await repo.create(item);
        } finally { active--; }
      } };
    };
    const result = await capacityStoreWorkload({ pool: f.pool, recoveryPool: f.recoveryPool, records: 8, concurrency: 2 }, { ...f, repository });
    expect(result.failures).toEqual(['STORE_OPERATION_FAILED']);
    expect(result.counts.created).toBe(7); expect(result.counts.cleaned).toBe(7);
    expect(result.checks.cleanup).toBe(true); expect(active).toBe(0); expect(peak).toBeLessThanOrEqual(2); expect(f.rows.size).toBe(0);
  });

  it.each([{ records: 1, concurrency: 2 }, { records: 101, concurrency: 2 }, { records: 3, concurrency: 1 }, { records: 3, concurrency: 17 }, { records: 2.5, concurrency: 2 }])('rejects unbounded inputs before database operations: %j', async input => {
    const f = fixture();
    await expect(capacityStoreWorkload({ pool: f.pool, recoveryPool: f.recoveryPool, ...input }, f)).rejects.toThrow('Use 2–100 records');
    expect(f.pools).toEqual([]); expect(f.cleanup).toEqual([]);
  });

  it('requires a separate recovery pool', async () => {
    const f = fixture();
    await expect(capacityStoreWorkload({ pool: f.pool, recoveryPool: f.pool, records: 3, concurrency: 2 }, f)).rejects.toThrow('two separate');
    expect(f.cleanup).toEqual([]);
  });
});
