import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { BASE_SEPOLIA_GENESIS_HASH } from '@oneshot/evm';
import { createExternalNftImports, createExternalNftImportStore, EXTERNAL_NFT_IMPORT_NAMESPACE, type ExternalImportDeployment, type ExternalNftImportInspection } from './external-nft-imports';
import type { OneshotSession } from './oneshot-auth';

const connectionString = process.env.ONESHOT_API_TEST_DATABASE_URL;
const address = (index: number) => `0x${index.toString(16).padStart(40, '0')}` as `0x${string}`;
const checkedAt = '2026-11-19T01:00:00.000Z';
const deployment: ExternalImportDeployment = {
  deploymentId: 'd'.repeat(64), chainId: 84532, genesisHash: BASE_SEPOLIA_GENESIS_HASH, registry: address(1), marketplace: address(2),
};
const request = (collection = address(3)) => ({ deploymentId: deployment.deploymentId, collection, note: 'Review this external collection.', reference: 'https://example.com/collection' });
const proof = (collection: `0x${string}`): ExternalNftImportInspection => ({
  deployment, collection, runtimeCodeHash: `0x${'a'.repeat(64)}`, currentReviewVersion: '0',
  checkpoint: { number: '123', hash: `0x${'b'.repeat(64)}`, timestamp: '1795050000' }, inspectedAt: checkedAt,
});
type Service = ReturnType<typeof createExternalNftImports>;
type Fixture = {
  service: Service; serviceWith(overrides: Parameters<typeof createExternalNftImports>[0]): Service;
  pool(): Pool; reopen(): Promise<void>; session(): OneshotSession;
};
/** Dedicated loopback database and per-test owned schema only; no ambient application URL or global pool. */
async function withDatabase(run: (fixture: Fixture) => Promise<void>) {
  if (!connectionString) throw new Error('Dedicated external import test database required.');
  const selected = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(selected.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(selected.hostname)
    || selected.pathname !== '/oneshot_indexer_test' || selected.username !== 'oneshot_indexer_test') throw new Error('Use the dedicated loopback oneshot_indexer_test database and role.');
  const schema = `external_imports_${randomUUID().replaceAll('-', '')}`;
  const manager = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000 });
  const config = { connectionString, options: `-c search_path=${schema}`, max: 6, connectionTimeoutMillis: 5000, statement_timeout: 10000, idleTimeoutMillis: 1000 };
  let pool: Pool | undefined;
  const close = async () => { const previous = pool; pool = undefined; await previous?.end(); };
  try {
    await manager.query(`CREATE SCHEMA ${schema}`); pool = new Pool(config);
    await pool.query(await readFile(new URL('../../../../db/schema.sql', import.meta.url), 'utf8'));
    const store = createExternalNftImportStore(() => pool ?? null);
    const create = (overrides: Parameters<typeof createExternalNftImports>[0] = {}) => createExternalNftImports({
      store, now: () => checkedAt, deployment: async () => deployment, inspect: async (_selected, collection) => proof(collection), ...overrides,
    });
    await run({ service: create(), serviceWith: create, pool: () => pool!, reopen: async () => { await close(); pool = new Pool(config); },
      session: () => ({ provider: 'privy', userId: `did:privy:external-import-${randomUUID()}`, sessionId: randomUUID(), expiresAt: 9999999999, linkedAddresses: [] }) });
  } finally {
    await close();
    try { await manager.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await manager.end(); }
  }
}

describe.skipIf(!connectionString)('durable PostgreSQL external collection import requests', () => {
  it('persists private requests and separate operator evidence while isolating account reads, pages and mutations', async () => {
    await withDatabase(async ({ service, session, reopen }) => {
      const alice = session(), bob = session(), created = await service.create(request(), alice);
      await service.review(created.id, 1, { decision: 'review-approved', customerNote: 'Reviewed for registry submission.', operatorEvidence: 'Private inspection notes.' }, 'admin:test');
      for (let index = 0; index < 20; index++) await service.create(request(address(100 + index)), bob);
      await reopen();
      const own = await service.list(alice, { limit: 1 }); expect(own.items).toHaveLength(1); expect(own.nextCursor).toBeNull();
      expect(own.items[0]).toMatchObject({ id: created.id, status: 'review-approved', admissionStatus: 'not-established', customerNote: 'Reviewed for registry submission.' });
      for (const secret of [alice.userId, 'Private inspection', 'runtimeCodeHash', 'admin:test', 'inspectionCommitment']) expect(JSON.stringify(own)).not.toContain(secret);
      await expect(service.read(created.id, bob)).rejects.toMatchObject({ code: 'EXTERNAL_IMPORT_NOT_FOUND' });
      await expect(service.withdraw(created.id, 2, bob)).rejects.toMatchObject({ code: 'EXTERNAL_IMPORT_NOT_FOUND' });
      const operator = await service.adminRead(created.id); expect(operator.ownerUserId).toBe(alice.userId); expect(operator.review?.operatorEvidence).toBe('Private inspection notes.');
      expect(operator.review?.inspection?.checkpoint.number).toBe('123');
    });
  });

  it('enforces 20 active requests atomically under concurrent insertion and frees capacity through withdrawal/rejection', async () => {
    await withDatabase(async ({ service, session, pool }) => {
      const owner = session();
      const results = await Promise.allSettled(Array.from({ length: 24 }, (_, index) => service.create(request(address(index + 10)), owner)));
      const accepted = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
      expect(accepted).toHaveLength(20);
      for (const result of results) if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: 'EXTERNAL_IMPORT_LIMIT' });
      const rows = await pool().query("SELECT count(*)::integer AS count FROM b20_app_records WHERE namespace=$1 AND value->>'ownerUserId'=$2 AND value->'request'->>'status' IN ('submitted','review-approved')", [EXTERNAL_NFT_IMPORT_NAMESPACE, owner.userId]);
      expect(rows.rows[0].count).toBe(20);
      await service.withdraw(accepted[0].id, 1, owner); await service.create(request(address(200)), owner);
      await service.review(accepted[1].id, 1, { decision: 'rejected', customerNote: 'Unsupported collection.' }, 'admin:test');
      await service.create(request(address(201)), owner);
      await expect(service.create(request(address(202)), owner)).rejects.toMatchObject({ code: 'EXTERNAL_IMPORT_LIMIT' });
      expect((await service.list(owner, { limit: 50 })).items).toHaveLength(22);
    });
  });

  it('allows exactly one concurrent active duplicate per account and does not confuse another account with a duplicate', async () => {
    await withDatabase(async ({ service, session }) => {
      const owner = session(), other = session();
      const results = await Promise.allSettled(Array.from({ length: 8 }, () => service.create(request(), owner)));
      const accepted = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []); expect(accepted).toHaveLength(1);
      for (const result of results) if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: 'EXTERNAL_IMPORT_DUPLICATE' });
      const independent = await service.create(request(), other); expect(independent.id).not.toBe(accepted[0].id);
      await service.withdraw(accepted[0].id, 1, owner); expect((await service.create(request(), owner)).status).toBe('submitted');
    });
  });

  it('has one review/withdraw CAS winner and cannot revive a withdrawal after a late inspection', async () => {
    await withDatabase(async ({ service, serviceWith, session, reopen }) => {
      const owner = session(), first = await service.create(request(), owner);
      const races = await Promise.allSettled([service.review(first.id, 1, { decision: 'rejected', customerNote: 'Not supported.' }, 'admin:test'), service.withdraw(first.id, 1, owner)]);
      expect(races.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      for (const result of races) if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: 'EXTERNAL_IMPORT_CHANGED' });
      const second = await service.create(request(address(4)), owner); let finish!: (value: ExternalNftImportInspection) => void;
      const inspector = vi.fn(() => new Promise<ExternalNftImportInspection>(resolve => { finish = resolve; }));
      const reviewing = serviceWith({ inspect: inspector }).review(second.id, 1, { decision: 'review-approved' }, 'admin:test');
      await vi.waitFor(() => expect(inspector).toHaveBeenCalledOnce());
      const withdrawn = await service.withdraw(second.id, 1, owner); finish(proof(second.collection));
      await expect(reviewing).rejects.toMatchObject({ code: 'EXTERNAL_IMPORT_CHANGED' });
      await reopen(); expect(await service.read(second.id, owner)).toEqual(withdrawn);
      await expect(service.review(second.id, 2, { decision: 'review-approved' }, 'admin:test')).rejects.toMatchObject({ code: 'EXTERNAL_IMPORT_CHANGED' });
    });
  });

  it('paginates immutable creation order across status changes and pool restarts and binds account/page scope', async () => {
    await withDatabase(async ({ service, session, reopen }) => {
      const owner = session(), other = session(), created = [];
      for (let index = 0; index < 9; index++) created.push(await service.create(request(address(index + 10)), owner));
      const first = await service.list(owner, { limit: 3 }); expect(first.items).toHaveLength(3); expect(first.nextCursor).toBeTypeOf('string');
      await service.withdraw(first.items[0].id, 1, owner); await reopen();
      const second = await service.list(owner, { limit: 3, cursor: first.nextCursor! }), third = await service.list(owner, { limit: 3, cursor: second.nextCursor! });
      const seen = [...first.items, ...second.items, ...third.items].map(value => value.id);
      expect(new Set(seen).size).toBe(9); expect(seen).toEqual(created.map(value => value.id).sort().reverse()); expect(third.nextCursor).toBeNull();
      await expect(service.list(other, { limit: 3, cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'EXTERNAL_IMPORT_CURSOR_INVALID' });
      await expect(service.list(owner, { limit: 2, cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'EXTERNAL_IMPORT_CURSOR_INVALID' });
      const admin = await service.adminList({ limit: 3 });
      await expect(service.list(owner, { limit: 3, cursor: admin.nextCursor! })).rejects.toMatchObject({ code: 'EXTERNAL_IMPORT_CURSOR_INVALID' });
    });
  });

  it('fails corrupted inspection commitments and inconsistent records instead of empty history or false review approval', async () => {
    await withDatabase(async ({ service, session, pool }) => {
      const owner = session(), created = await service.create(request(), owner);
      await service.review(created.id, 1, { decision: 'review-approved' }, 'admin:test');
      await pool().query("UPDATE b20_app_records SET value=jsonb_set(value,'{review,inspection,runtimeCodeHash}',to_jsonb($3::text)) WHERE namespace=$1 AND id=$2", [EXTERNAL_NFT_IMPORT_NAMESPACE, created.id, `0x${'c'.repeat(64)}`]);
      await expect(service.read(created.id, owner)).rejects.toMatchObject({ code: 'EXTERNAL_IMPORT_UNAVAILABLE' });
      await expect(service.list(owner)).rejects.toMatchObject({ code: 'EXTERNAL_IMPORT_UNAVAILABLE' });
      await expect(service.adminRead(created.id)).rejects.toMatchObject({ code: 'EXTERNAL_IMPORT_UNAVAILABLE' });
      await expect(service.withdraw(created.id, 2, owner)).rejects.toMatchObject({ code: 'EXTERNAL_IMPORT_UNAVAILABLE' });
      expect((await service.list(session())).items).toEqual([]);
    });
  });

  it('has no hosted file fallback when its database is unavailable', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    try {
      const service = createExternalNftImports({ store: createExternalNftImportStore(() => null), deployment: async () => deployment });
      const owner: OneshotSession = { provider: 'privy', userId: 'did:privy:no-database', sessionId: 'session', expiresAt: 9999999999, linkedAddresses: [] };
      await expect(service.create(request(), owner)).rejects.toMatchObject({ code: 'DATABASE_REQUIRED' });
      await expect(service.list(owner)).rejects.toMatchObject({ code: 'DATABASE_REQUIRED' });
    } finally { vi.unstubAllEnvs(); }
  });
});
