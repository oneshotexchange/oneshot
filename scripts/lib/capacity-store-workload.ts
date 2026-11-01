import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { performance } from 'node:perf_hooks';
import type { Pool } from 'pg';
import type { Hex } from 'viem';
import {
  createNftLaunchRepository, NFT_REVIEW_NAMESPACE,
  type NftLaunchRepository, type StoredNftReview,
} from '../../apps/api/lib/server/nft-launch-store';

export type CapacityStoreOperation =
  | 'store.create' | 'store.bindHash' | 'store.recoverGet' | 'store.recoverList'
  | 'store.setOutcome' | 'store.raceBindHash' | 'store.isolationBindHash'
  | 'store.isolationList' | 'store.restartGet' | 'store.restartList' | 'store.cleanup';
export type CapacityStoreSample = { operation: CapacityStoreOperation; durationMs: number; ok: boolean };
export type CapacityStoreCheck = 'exactRecovery' | 'firstHashRace' | 'accountIsolation' | 'separatePoolRecovery' | 'outcomeRecovery' | 'cleanup';
export type CapacityStoreFailure = 'STORE_OPERATION_FAILED' | 'STORE_EXACT_RECOVERY_FAILED' | 'STORE_HASH_RACE_FAILED'
  | 'STORE_ACCOUNT_ISOLATION_FAILED' | 'STORE_RESTART_RECOVERY_FAILED' | 'STORE_OUTCOME_RECOVERY_FAILED' | 'STORE_CLEANUP_FAILED';
export type CapacityStoreResult = {
  records: number; concurrency: number; durationMs: number;
  counts: { attempted: number; succeeded: number; failed: number; expectedRejections: number; created: number; cleaned: number };
  samples: CapacityStoreSample[];
  checks: Record<CapacityStoreCheck, boolean>;
  failures: CapacityStoreFailure[];
};
export type CapacityStoreOptions = {
  /** Both pools must point to the caller's explicitly validated dedicated local test database. */
  pool: Pool;
  /** A separate pool checks recovery through fresh database clients, without relying on repository memory. */
  recoveryPool: Pool;
  records: number;
  concurrency: number;
};
type Repository = Pick<NftLaunchRepository, 'create' | 'get' | 'bindHash' | 'setOutcome' | 'list'>;
type Dependencies = { repository?: (pool: Pool) => Repository; clock?: () => number };
class WorkloadFailure extends Error {
  constructor(readonly code: CapacityStoreFailure) { super(code); }
}
const wallet = '0x1111111111111111111111111111111111111111';
const otherWallet = '0x2222222222222222222222222222222222222222';
const fixtureHash = `0x${'ab'.repeat(32)}` as Hex;
const exactPrice = '99999999999999999999999999';
const hash = (): Hex => `0x${createHash('sha256').update(randomUUID()).digest('hex')}`;
const hasCode = (error: unknown, code: string) => typeof error === 'object' && error !== null && 'code' in error && error.code === code;

function fixture(owner: string, from: typeof wallet | typeof otherWallet, createdAt: number): StoredNftReview {
  const draftId = randomUUID();
  const input: StoredNftReview['input'] = { draftId, expectedRevision: 2, from, action: 'list', collection: wallet, tokenId: '1', price: '99999999.999999999999999999', localEthAcknowledged: true };
  return {
    owner, session: randomUUID(), createdAt, input,
    review: {
      id: randomUUID(), reviewHash: fixtureHash, scope: 'draft', expiresAt: new Date(createdAt + 120_000).toISOString(),
      chainId: 31337, from, to: wallet, data: '0x1234', value: '0', action: 'list',
      network: { mode: 'local', chainId: 31337, name: 'Local Anvil', nativeSymbol: 'ETH', nativeDecimals: 18 },
      summary: { tokenId: '1', enteredPriceRaw: exactPrice, priceRaw: exactPrice, label: 'Internal persistence capacity fixture' },
      deploymentId: 'a'.repeat(64), draftId, revision: 2,
      simulation: { blockNumber: '10', blockHash: fixtureHash, gasEstimate: '100000' },
    },
  };
}

/** Runs repository operations only: no HTTP authentication shortcut, wallet signing, or chain submission.
 * The caller owns and closes both pools. Results contain aggregates and static codes only.
 * Cleanup is limited to this run's random review IDs AND fixture owners in the review namespace.
 */
export async function capacityStoreWorkload(options: CapacityStoreOptions, dependencies: Dependencies = {}): Promise<CapacityStoreResult> {
  const { pool, recoveryPool, records, concurrency } = options;
  if (!Number.isInteger(records) || records < 2 || records > 100 || !Number.isInteger(concurrency) || concurrency < 2 || concurrency > 16
    || !pool || !recoveryPool || pool === recoveryPool) throw new Error('Use 2–100 records, 2–16 workers, and two separate validated local test database pools.');
  const clock = dependencies.clock ?? (() => performance.now());
  const repository = dependencies.repository ?? (selectedPool => createNftLaunchRepository({ database: () => selectedPool }));
  const started = clock(), now = Date.now();
  const result: CapacityStoreResult = {
    records, concurrency, durationMs: 0,
    counts: { attempted: 0, succeeded: 0, failed: 0, expectedRejections: 0, created: 0, cleaned: 0 },
    samples: [], failures: [],
    checks: { exactRecovery: false, firstHashRace: false, accountIsolation: false, separatePoolRecovery: false, outcomeRecovery: false, cleanup: false },
  };
  const owner = `did:privy:capacity-${randomUUID()}`, otherOwner = `did:privy:capacity-${randomUUID()}`, unrelatedOwner = `did:privy:capacity-${randomUUID()}`;
  const originals = Array.from({ length: records }, (_, index) => fixture(index === records - 1 ? otherOwner : owner, index === records - 1 ? otherWallet : wallet, now + index));
  const boundHashes = new Map<string, Hex>();
  const elapsed = (from: number) => {
    const value = clock() - from;
    return Number.isFinite(value) ? Math.max(0, value) : 0;
  };
  const failure = (code: CapacityStoreFailure): never => { throw new WorkloadFailure(code); };
  const invariant = (condition: boolean, code: CapacityStoreFailure) => { if (!condition) failure(code); };
  async function sample<T>(operation: CapacityStoreOperation, action: () => Promise<T>): Promise<T> {
    const start = clock(); result.counts.attempted++;
    try {
      const value = await action();
      result.counts.succeeded++; result.samples.push({ operation, durationMs: elapsed(start), ok: true }); return value;
    } catch (error) {
      result.counts.failed++; result.samples.push({ operation, durationMs: elapsed(start), ok: false }); throw error;
    }
  }
  async function concurrent<T>(values: readonly T[], action: (value: T, index: number) => Promise<void>) {
    let next = 0;
    const failures: unknown[] = [];
    await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (next < values.length) {
        const index = next++;
        try { await action(values[index], index); } catch (error) { failures.push(error); }
      }
    }));
    // Every started worker has settled before cleanup can begin.
    if (failures.length) throw failures[0];
  }
  function unchanged(actual: StoredNftReview | null, expected: StoredNftReview) {
    return actual !== null && actual.owner === expected.owner && actual.session === expected.session && actual.createdAt === expected.createdAt
      && isDeepStrictEqual(actual.review, expected.review) && isDeepStrictEqual(actual.input, expected.input)
      && actual.transactionHash === boundHashes.get(expected.review.id);
  }
  async function history(repo: Repository, selectedOwner: string, operation: 'store.recoverList' | 'store.restartList') {
    const found: StoredNftReview[] = [], cursors = new Set<string>(); let cursor: string | undefined;
    do {
      const page = await sample(operation, () => repo.list(selectedOwner, { limit: 50, ...(cursor ? { cursor } : {}) }, now + records + 10));
      found.push(...page.items); cursor = page.nextCursor;
      invariant(found.length <= records && (!cursor || !cursors.has(cursor)), 'STORE_ACCOUNT_ISOLATION_FAILED');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    const expected = originals.filter(item => item.owner === selectedOwner);
    invariant(found.length === expected.length && found.every(item => item.owner === selectedOwner && expected.some(original => original.review.id === item.review.id && unchanged(item, original)))
      && new Set(found.map(item => item.review.id)).size === expected.length, 'STORE_ACCOUNT_ISOLATION_FAILED');
    return found;
  }
  try {
    const repo = repository(pool);
    await concurrent(originals, async item => sample('store.create', async () => { await repo.create(item, now + records); result.counts.created++; }));
    const race = originals[0], candidates = Array.from({ length: Math.min(4, concurrency) }, hash);
    const winners: Hex[] = []; let rejected = 0;
    await concurrent(candidates, async candidate => sample('store.raceBindHash', async () => {
      try { const accepted = await repo.bindHash(race.review.id, race.owner, candidate, now + records + 1); invariant(accepted.transactionHash === candidate, 'STORE_HASH_RACE_FAILED'); winners.push(candidate); }
      catch (error) { if (hasCode(error, 'TRANSACTION_CHANGED')) { rejected++; result.counts.expectedRejections++; } else throw error; }
    }));
    invariant(winners.length === 1 && rejected === candidates.length - 1, 'STORE_HASH_RACE_FAILED');
    boundHashes.set(race.review.id, winners[0]); result.checks.firstHashRace = true;
    await sample('store.isolationBindHash', async () => {
      try { await repo.bindHash(race.review.id, otherOwner, hash(), now + records + 2); }
      catch (error) { if (hasCode(error, 'REVIEW_NOT_FOUND')) { result.counts.expectedRejections++; return; } throw error; }
      failure('STORE_ACCOUNT_ISOLATION_FAILED');
    });
    await concurrent(originals.slice(1), async item => sample('store.bindHash', async () => {
      const transactionHash = hash(), accepted = await repo.bindHash(item.review.id, item.owner, transactionHash, now + records + 3);
      invariant(accepted.transactionHash === transactionHash, 'STORE_EXACT_RECOVERY_FAILED'); boundHashes.set(item.review.id, transactionHash);
    }));
    await concurrent(originals, async item => sample('store.recoverGet', async () => {
      invariant(unchanged(await repo.get(item.review.id, now + records + 4), item), 'STORE_EXACT_RECOVERY_FAILED');
    }));
    await history(repo, owner, 'store.recoverList'); await history(repo, otherOwner, 'store.recoverList'); result.checks.exactRecovery = true;
    await sample('store.isolationList', async () => {
      const page = await repo.list(unrelatedOwner, { limit: 50 }, now + records + 5);
      invariant(page.items.length === 0 && page.nextCursor === undefined, 'STORE_ACCOUNT_ISOLATION_FAILED');
    });
    result.checks.accountIsolation = true;
    await concurrent(originals, async (item, index) => sample('store.setOutcome', () => repo.setOutcome(item.review.id, boundHashes.get(item.review.id)!, index % 2 === 0 ? 'confirmed' : 'reverted', now + records + 6)));
    const reopened = repository(recoveryPool);
    await concurrent(originals, async (item, index) => sample('store.restartGet', async () => {
      const recovered = await reopened.get(item.review.id, now + records + 7);
      invariant(unchanged(recovered, item), 'STORE_RESTART_RECOVERY_FAILED');
      invariant(recovered?.outcome === (index % 2 === 0 ? 'confirmed' : 'reverted'), 'STORE_OUTCOME_RECOVERY_FAILED');
    }));
    await history(reopened, owner, 'store.restartList'); await history(reopened, otherOwner, 'store.restartList');
    result.checks.separatePoolRecovery = true; result.checks.outcomeRecovery = true;
  } catch (error) {
    result.failures.push(error instanceof WorkloadFailure ? error.code : 'STORE_OPERATION_FAILED');
  } finally {
    try {
      await sample('store.cleanup', async () => {
        const deleted = await pool.query('DELETE FROM b20_app_records WHERE namespace=$1 AND id=ANY($2::text[]) AND value->>\'owner\'=ANY($3::text[])',
          [NFT_REVIEW_NAMESPACE, originals.map(item => item.review.id), [owner, otherOwner]]);
        result.counts.cleaned = deleted.rowCount ?? 0;
        invariant(result.counts.cleaned === result.counts.created, 'STORE_CLEANUP_FAILED'); result.checks.cleanup = true;
      });
    } catch {
      result.failures.push('STORE_CLEANUP_FAILED');
    }
    result.durationMs = elapsed(started);
  }
  return result;
}
