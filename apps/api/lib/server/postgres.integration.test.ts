import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { archiveOneshotDraft, createOneshotDraft, getOneshotDraft, listOneshotDrafts, updateOneshotDraft } from './oneshot-drafts';
import { compareAndSetRecord, database, reserveMedia } from './store';
import type { OneshotSession } from './oneshot-auth';

// Explicit opt-in only. An ambient DATABASE_URL must never select this suite's DB.
const testDatabaseUrl = process.env.ONESHOT_API_TEST_DATABASE_URL;

type Fixture = {
  inspect: Pool;
  session(): OneshotSession;
  mediaId(): string;
  reopen(): Promise<void>;
};

async function closeApiPool() {
  const previous = globalThis.b20Pool;
  globalThis.b20Pool = undefined;
  await previous?.end();
}

async function withDatabase(run: (fixture: Fixture) => Promise<void>) {
  if (!testDatabaseUrl) throw new Error('ONESHOT_API_TEST_DATABASE_URL is required.');
  await closeApiPool();
  vi.stubEnv('DATABASE_URL', testDatabaseUrl);
  // Missing database configuration must fail instead of silently using local files.
  vi.stubEnv('NODE_ENV', 'production');
  const inspect = new Pool({
    connectionString: testDatabaseUrl, max: 1, connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 1_000, statement_timeout: 10_000, application_name: 'oneshot-api-integration-inspect',
  });
  const owners = new Set<string>();
  const mediaIds = new Set<string>();
  let schemaReady = false;
  try {
    await inspect.query(await readFile(new URL('../../../../db/schema.sql', import.meta.url), 'utf8'));
    schemaReady = true;
    await run({
      inspect,
      session() {
        const userId = `did:privy:api-integration-${randomUUID()}`;
        owners.add(userId);
        return {
          provider: 'privy', userId, sessionId: randomUUID(), expiresAt: Math.floor(Date.now() / 1000) + 3600,
          linkedAddresses: ['0x1111111111111111111111111111111111111111'],
        };
      },
      mediaId() {
        const id = `${createHash('sha256').update(randomUUID()).digest('hex')}.webp`;
        mediaIds.add(id);
        return id;
      },
      reopen: closeApiPool,
    });
  } finally {
    try {
      await closeApiPool();
      if (schemaReady) {
        // No global deletion: only random identities and content IDs allocated here.
        if (owners.size) await inspect.query(
          "DELETE FROM b20_app_records WHERE namespace='oneshot_drafts' AND value->>'ownerUserId'=ANY($1::text[])", [[...owners]],
        );
        if (mediaIds.size) await inspect.query(
          "DELETE FROM b20_app_records WHERE namespace='media' AND id=ANY($1::text[]) AND value->>'owner'=ANY($2::text[])",
          [[...mediaIds], [...owners]],
        );
      }
    } finally {
      try { await inspect.end(); } finally { vi.unstubAllEnvs(); }
    }
  }
}

const input = (session: OneshotSession, name = 'PostgreSQL integration collection') => ({
  name, description: 'Dedicated database integration test', maxSupply: 2, royaltyBps: 500,
  publicPrice: '123456789012345678901234567890.12345678901234567890123456789012345678',
  allowlistPrice: '0.00000000000000000000000000000000000001', perWalletLimit: 2,
  publicStart: '2030-01-01T00:00:00Z', publicEnd: '2030-01-02T00:00:00Z',
  allowlistAddresses: [], metadataMode: 'upload' as const, creatorWallet: session.linkedAddresses[0],
});

describe.skipIf(!testDatabaseUrl)('real PostgreSQL API persistence', () => {
  it('durably preserves exact decimal strings across a new pool and isolates owners', async () => {
    await withDatabase(async ({ inspect, session, reopen }) => {
      const alice = session(), bob = session();
      const original = await createOneshotDraft(input(alice), alice);
      const previousPool = database();
      const persisted = await inspect.query(
        "SELECT value FROM b20_app_records WHERE namespace='oneshot_drafts' AND id=$1", [original.id],
      );
      expect(persisted.rows[0].value).toEqual(original);
      expect(persisted.rows[0].value.publicPrice).toBe(input(alice).publicPrice);
      expect(persisted.rows[0].value.allowlistPrice).toBe(input(alice).allowlistPrice);
      await reopen();
      expect(await getOneshotDraft(original.id, alice)).toEqual(original);
      expect(database()).not.toBe(previousPool);
      expect((await listOneshotDrafts(alice)).map(draft => draft.id)).toEqual([original.id]);
      expect(await listOneshotDrafts(bob)).toEqual([]);
      await expect(getOneshotDraft(original.id, bob)).rejects.toMatchObject({ status: 404, code: 'DRAFT_NOT_FOUND' });
      await expect(updateOneshotDraft(original.id, input(bob), 1, bob)).rejects.toMatchObject({ status: 404, code: 'DRAFT_NOT_FOUND' });
      expect(await getOneshotDraft(original.id, alice)).toEqual(original);
    });
  });

  it('admits exactly one concurrent revision update and rejects stale edits', async () => {
    await withDatabase(async ({ session }) => {
      const owner = session();
      const original = await createOneshotDraft(input(owner), owner);
      const updates = await Promise.allSettled([
        updateOneshotDraft(original.id, input(owner, 'First candidate'), 1, owner),
        updateOneshotDraft(original.id, input(owner, 'Second candidate'), 1, owner),
      ]);
      const accepted = updates.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof updateOneshotDraft>>> => result.status === 'fulfilled');
      const rejected = updates.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      expect(accepted).toHaveLength(1); expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toMatchObject({ status: 409, code: 'DRAFT_CHANGED' });
      const current = await getOneshotDraft(original.id, owner);
      expect(current).toEqual(accepted[0].value); expect(current.revision).toBe(2);
      await expect(updateOneshotDraft(original.id, input(owner, 'Stale request'), 1, owner)).rejects.toMatchObject({ status: 409, code: 'DRAFT_CHANGED' });

      // Force two SQL CAS operations to compare the same already-read snapshot.
      const candidates = [{ ...current, name: 'CAS one', revision: 3 }, { ...current, name: 'CAS two', revision: 3 }];
      const winners = await Promise.all(candidates.map(candidate => compareAndSetRecord('oneshot_drafts', original.id, current, candidate)));
      expect(winners.filter(Boolean)).toHaveLength(1);
      expect(await getOneshotDraft(original.id, owner)).toEqual(candidates[winners.indexOf(true)]);
    });
  });

  it('enforces the 20-draft limit under concurrency and reuses an archived slot', async () => {
    await withDatabase(async ({ inspect, session }) => {
      const owner = session();
      const attempts = await Promise.allSettled(Array.from({ length: 24 }, (_, index) => createOneshotDraft(input(owner, `Concurrent collection ${index}`), owner)));
      const accepted = attempts.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof createOneshotDraft>>> => result.status === 'fulfilled');
      const rejected = attempts.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      expect(accepted).toHaveLength(20); expect(rejected).toHaveLength(4);
      for (const result of rejected) expect(result.reason).toMatchObject({ status: 409, code: 'DRAFT_LIMIT' });
      expect(await listOneshotDrafts(owner)).toHaveLength(20);
      const archived = accepted[0].value;
      await archiveOneshotDraft(archived.id, archived.revision, owner);
      await expect(getOneshotDraft(archived.id, owner)).rejects.toMatchObject({ status: 404 });
      const replacement = await createOneshotDraft(input(owner, 'Replacement after archive'), owner);
      const visible = await listOneshotDrafts(owner);
      expect(visible).toHaveLength(20); expect(visible.some(draft => draft.id === replacement.id)).toBe(true);
      expect(visible.some(draft => draft.id === archived.id)).toBe(false);
      const persisted = await inspect.query(
        "SELECT value->>'status' AS status FROM b20_app_records WHERE namespace='oneshot_drafts' AND value->>'ownerUserId'=$1", [owner.userId],
      );
      expect(persisted.rows).toHaveLength(21);
      expect(persisted.rows.filter(row => row.status === 'deleted')).toHaveLength(1);
      await expect(createOneshotDraft(input(owner), owner)).rejects.toMatchObject({ status: 409, code: 'DRAFT_LIMIT' });
    });
  });

  it('atomically reserves media quota without duplicate charging or a failed reservation row', async () => {
    await withDatabase(async ({ inspect, session, mediaId }) => {
      const owner = session();
      const before = await inspect.query("SELECT COALESCE(SUM((value->>'size')::bigint),0)::text AS total FROM b20_app_records WHERE namespace='media'");
      const baseline = BigInt(before.rows[0].total);
      if (baseline + 10n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('The dedicated test database media total exceeds the safe quota range.');
      vi.stubEnv('ONESHOT_MEDIA_QUOTA_BYTES', (baseline + 10n).toString());
      const candidates = [mediaId(), mediaId()];
      const reservations = await Promise.allSettled(candidates.map(id => reserveMedia(id, { size: 6, owner: owner.userId })));
      expect(reservations.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      const failure = reservations.find(result => result.status === 'rejected') as PromiseRejectedResult;
      expect(failure.reason).toMatchObject({ status: 507, code: 'MEDIA_QUOTA_REACHED' });
      const winner = candidates[reservations.findIndex(result => result.status === 'fulfilled')];
      await reserveMedia(winner, { size: 6, owner: owner.userId });
      await reserveMedia(mediaId(), { size: 4, owner: owner.userId });
      const overflow = mediaId();
      await expect(reserveMedia(overflow, { size: 1, owner: owner.userId })).rejects.toMatchObject({ status: 507, code: 'MEDIA_QUOTA_REACHED' });
      const records = await inspect.query(
        "SELECT id, value->>'size' AS size FROM b20_app_records WHERE namespace='media' AND value->>'owner'=$1", [owner.userId],
      );
      expect(records.rows).toHaveLength(2);
      expect(records.rows.reduce((sum, row) => sum + Number(row.size), 0)).toBe(10);
      expect(records.rows.some(row => row.id === overflow)).toBe(false);
    });
  });
});
