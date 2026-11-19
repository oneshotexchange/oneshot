import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { describe, it, expect, vi } from 'vitest';
import { createWalletProfiles } from './wallet-profiles';
import { createWalletFollowing } from './wallet-following';
import { emptyWalletProfile } from '../../../web/lib/wallet-profile';
import type { OneshotSession } from './oneshot-auth';

const connectionString = process.env.ONESHOT_API_TEST_DATABASE_URL;
const address = (index: number) => `0x${index.toString(16).padStart(40, '0')}` as `0x${string}`;
const details = { ...emptyWalletProfile(), displayName: 'Durable creator', bio: 'Original work, saved privately.' };
async function withDatabase(run: (fixture: { service: ReturnType<typeof createWalletProfiles>; pool(): Pool; reopen(): Promise<void>; session(wallets: `0x${string}`[]): OneshotSession }) => Promise<void>) {
  if (!connectionString) throw new Error('Dedicated profile test database required.');
  const selected = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(selected.protocol) || !['localhost','127.0.0.1','[::1]'].includes(selected.hostname) || selected.pathname !== '/oneshot_indexer_test') throw new Error('Use the dedicated loopback oneshot_indexer_test database.');
  const schema = `wallet_profiles_${randomUUID().replaceAll('-', '')}`, manager = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000 });
  const config = { connectionString, options: `-c search_path=${schema}`, max: 4, connectionTimeoutMillis: 5000, statement_timeout: 10000, idleTimeoutMillis: 1000 };
  let pool: Pool | undefined;
  const close = async () => { const previous = globalThis.b20Pool; globalThis.b20Pool = undefined; await previous?.end(); pool = undefined; };
  try {
    await close(); await manager.query(`CREATE SCHEMA ${schema}`);
    vi.stubEnv('DATABASE_URL', connectionString); vi.stubEnv('NODE_ENV', 'production');
    pool = globalThis.b20Pool = new Pool(config);
    await pool.query(await readFile(new URL('../../../../db/schema.sql', import.meta.url), 'utf8'));
    await run({ service: createWalletProfiles(), pool: () => pool!, reopen: async () => { await close(); pool = globalThis.b20Pool = new Pool(config); },
      session: linkedAddresses => ({ provider: 'privy', userId: `did:privy:profile-${randomUUID()}`, sessionId: randomUUID(), expiresAt: 9999999999, linkedAddresses }) });
  } finally {
    await close();
    try { await manager.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await manager.end(); vi.unstubAllEnvs(); }
  }
}
describe.skipIf(!connectionString)('durable PostgreSQL wallet profiles', () => {
  it('persists private follows without a linked wallet and serializes edits and capacity', async () => {
    await withDatabase(async ({ session, reopen }) => {
      const service = createWalletFollowing(), owner = session([]), other = session([]);
      await service.change(address(100), true, 0, owner); await reopen();
      expect((await service.read(owner)).wallets).toEqual([address(100)]); expect((await service.read(other)).wallets).toEqual([]);
      const edits = await Promise.allSettled([service.change(address(101), true, 1, owner), service.change(address(102), true, 1, owner)]);
      expect(edits.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      let current = await service.read(owner);
      for (let index = 200; current.wallets.length < 50; index++) current = await service.change(address(index), true, current.revision, owner);
      await expect(service.change(address(999), true, current.revision, owner)).rejects.toMatchObject({ code: 'FOLLOWING_LIMIT' });
      current = await service.change(current.wallets[0], false, current.revision, owner);
      current = await service.change(address(999), true, current.revision, owner); await reopen();
      expect(await service.read(owner)).toEqual(current); expect(JSON.stringify(current)).not.toContain(owner.userId);
    });
  });
  it('preserves a private draft, its separate publication and unpublishing across pool restarts', async () => {
    await withDatabase(async ({ service, session, reopen }) => {
      const wallet = address(11), owner = session([wallet]);
      await service.save(wallet, 0, details, owner); await reopen();
      expect((await service.account(wallet, owner)).draft).toEqual(details); expect((await service.public(wallet)).profile).toBeNull();
      await service.publish(wallet, 1, owner); await service.save(wallet, 2, { ...details, bio: 'Unpublished edit' }, owner); await reopen();
      expect((await service.public(wallet)).profile?.bio).toBe(details.bio);
      expect((await service.account(wallet, owner)).draft.bio).toBe('Unpublished edit');
      await service.unpublish(wallet, 3, owner); await reopen(); expect((await service.public(wallet)).profile).toBeNull();
    });
  });
  it('enforces the 20-profile account limit atomically with concurrent creation', async () => {
    await withDatabase(async ({ service, session, pool }) => {
      const wallets = Array.from({ length: 22 }, (_, index) => address(index + 101)), owner = session(wallets);
      const results = await Promise.allSettled(wallets.map(wallet => service.save(wallet, 0, details, owner)));
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(20);
      for (const result of results) if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: 'PROFILE_LIMIT' });
      expect((await pool().query("SELECT count(*)::int AS n FROM b20_app_records WHERE namespace='oneshot_wallet_profiles'")).rows[0].n).toBe(20);
    });
  });
  it('allows one first writer per wallet and one revision winner without disclosing the other account', async () => {
    await withDatabase(async ({ service, session, pool }) => {
      const wallet = address(12), alice = session([wallet]), bob = session([wallet]);
      const claims = await Promise.allSettled([service.save(wallet, 0, details, alice), service.save(wallet, 0, details, bob)]);
      expect(claims.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      const row = (await pool().query("SELECT value FROM b20_app_records WHERE namespace='oneshot_wallet_profiles' AND id=$1", [wallet])).rows[0].value;
      const owner = row.ownerUserId === alice.userId ? alice : bob, other = owner === alice ? bob : alice;
      await expect(service.account(wallet, other)).rejects.toMatchObject({ code: 'PROFILE_ACCOUNT_MISMATCH' });
      const edits = await Promise.allSettled([service.save(wallet, 1, { ...details, bio: 'One' }, owner), service.save(wallet, 1, { ...details, bio: 'Two' }, owner)]);
      expect(edits.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      await expect(service.publish(wallet, 1, owner)).rejects.toMatchObject({ code: 'PROFILE_CHANGED' });
      await service.publish(wallet, 2, owner);
      const publicValue = JSON.stringify(await service.public(wallet));
      expect(publicValue).not.toContain(owner.userId); expect(publicValue).not.toContain(other.userId); expect(publicValue).not.toContain('draft');
    });
  });
  it('does not fall back to files when hosted database access is absent', async () => {
    await withDatabase(async ({ service, session }) => {
      const previous = globalThis.b20Pool; globalThis.b20Pool = undefined; await previous?.end();
      vi.stubEnv('DATABASE_URL', '');
      await expect(service.save(address(13), 0, details, session([address(13)]))).rejects.toMatchObject({ code: 'DATABASE_REQUIRED' });
      await expect(service.public(address(13))).rejects.toMatchObject({ code: 'DATABASE_REQUIRED' });
    });
  });
});
