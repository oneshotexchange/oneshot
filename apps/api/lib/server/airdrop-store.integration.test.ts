import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { createAirdropStore } from './airdrop-store';
import {
  AIRDROP_CONSENT_VERSION,
  airdropCampaignSchema,
  type AirdropParticipant,
} from '../../../web/lib/airdrop-schema';

// Dedicated opt-in test DB only. Each run owns a separate temporary schema.
const connectionString = process.env.ONESHOT_API_TEST_DATABASE_URL;

describe.skipIf(!connectionString)('Airdrop PostgreSQL persistence, snapshot deduplication and queries', () => {
  it('initializes schema, deduplicates snapshot batches, persists participants/referrals/merkle and restarts cleanly', async () => {
    const target = new URL(connectionString!);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) {
      throw new Error('Airdrop integration checks require an explicitly local test database.');
    }

    const schema = 'airdrop_test_' + randomUUID().replaceAll('-', '');
    const manager = new Pool({ connectionString, max: 1 });
    let pool: Pool | undefined;

    try {
      await manager.query(`CREATE SCHEMA ${schema}`);
      pool = new Pool({ connectionString, max: 6, options: `-c search_path=${schema}` });
      await pool.query(await readFile(new URL('../../../../db/schema.sql', import.meta.url), 'utf8'));

      const store = createAirdropStore(() => pool!);
      const now = Date.parse('2026-11-23T00:00:00Z');
      const nowIso = new Date(now).toISOString();

      await store.transaction(tx =>
        tx.saveCampaign(
          airdropCampaignSchema.parse({
            state: 'open',
            projectXId: '999',
            projectHandle: 'oneshot',
            announcementPostId: '888',
          }),
        ),
      );

      // Same-batch duplicate wallets + NULL txCount preservation + tier upgrade on merge
      const w1 = '0x1111111111111111111111111111111111111111';
      const w2 = '0x2222222222222222222222222222222222222222';
      const w3 = '0x3333333333333333333333333333333333333333';

      const import1 = await store.transaction(tx =>
        tx.importSnapshot(
          [
            { wallet: w1, tier: 'lz_user_5tx', txCount: 6 },
            { wallet: w1.toUpperCase(), tier: 'lz_winner', txCount: 11 },
            { wallet: w2, tier: 'lz_user_5tx' },
          ],
          'merge',
          nowIso,
        ),
      );
      expect(import1).toEqual({ imported: 2, total: 2, winners: 1, fiveTx: 1 });

      const snap2 = await store.transaction(tx => tx.lookupSnapshot(w2));
      expect(snap2?.tier).toBe('lz_user_5tx');
      expect(snap2?.txCount).toBeUndefined();

      const import2 = await store.transaction(tx =>
        tx.importSnapshot(
          [
            { wallet: w2, tier: 'lz_winner' },
            { wallet: w3, tier: 'lz_user_5tx', txCount: 8 },
          ],
          'merge',
          nowIso,
        ),
      );
      expect(import2).toEqual({ imported: 2, total: 3, winners: 2, fiveTx: 1 });
      expect((await store.transaction(tx => tx.lookupSnapshot(w2)))?.txCount).toBeUndefined();
      expect((await store.transaction(tx => tx.lookupSnapshot(w2)))?.tier).toBe('lz_winner');

      const replaceRes = await store.transaction(tx =>
        tx.importSnapshot([{ wallet: w1, tier: 'lz_winner', txCount: 15 }], 'replace', nowIso),
      );
      expect(replaceRes).toEqual({ imported: 1, total: 1, winners: 1, fiveTx: 0 });

      // Save participants, verify referral counts, postId GIN lookup, reserved slots, and unique wallet error
      const p1Id = randomUUID();
      const p2Id = randomUUID();
      const p3Id = randomUUID();

      const baseParticipant = (
        id: string,
        idx: number,
        overrides: Partial<AirdropParticipant> = {},
      ): AirdropParticipant => ({
        id,
        userId: `x:${idx}`,
        profile: { id: String(idx), username: `user_${idx}`, name: `User ${idx}`, avatarUrl: null },
        code: String(idx).padStart(16, '0'),
        referrerId: null,
        createdAt: nowIso,
        revision: 1,
        wallet: null,
        walletBoundAt: null,
        walletChallengeNonce: null,
        tier: 'community',
        checks: {},
        posts: [],
        boxUnlockedAt: null,
        slotReserved: false,
        reservedSlotNumber: null,
        baseGeneralTokens: 0,
        engagementBonusTokens: 0,
        reservedGeneralTokens: 0,
        consentVersion: AIRDROP_CONSENT_VERSION,
        ...overrides,
      });

      const p1 = baseParticipant(p1Id, 100, {
        wallet: w1,
        walletBoundAt: nowIso,
        tier: 'lz_winner',
        slotReserved: true,
        reservedSlotNumber: 1,
        baseGeneralTokens: 40_000,
        engagementBonusTokens: 10_000,
        reservedGeneralTokens: 50_000,
        checks: {
          follow: { state: 'verified', message: 'Following', checkedAt: nowIso },
        },
        posts: [
          {
            postId: '999001',
            postUrl: 'https://x.com/user_100/status/999001',
            verifiedAt: nowIso,
            lastRefreshedAt: nowIso,
            metrics: { likes: 5, reposts: 1, replies: 0, views: 100 },
            engagementScore: 15,
          },
        ],
      });

      const p2 = baseParticipant(p2Id, 101, {
        referrerId: p1Id,
        wallet: w2,
        walletBoundAt: nowIso,
        checks: {
          follow: { state: 'verified', message: 'Following', checkedAt: nowIso },
        },
        posts: [
          {
            postId: '999002',
            postUrl: 'https://x.com/user_101/status/999002',
            verifiedAt: nowIso,
            lastRefreshedAt: nowIso,
            metrics: { likes: 1, reposts: 0, replies: 0, views: 10 },
            engagementScore: 2,
          },
        ],
      });

      // p3 is NOT qualified referral (no wallet bound yet)
      const p3 = baseParticipant(p3Id, 102, {
        referrerId: p1Id,
        checks: {
          follow: { state: 'verified', message: 'Following', checkedAt: nowIso },
        },
      });

      await store.transaction(async tx => {
        await tx.saveParticipant(p1);
        await tx.saveParticipant(p2);
        await tx.saveParticipant(p3);
      });

      expect(await store.transaction(tx => tx.countQualifiedReferrals(p1Id))).toBe(1);
      expect(await store.transaction(tx => tx.qualifiedReferralCounts())).toEqual({ [p1Id]: 1 });
      expect(await store.transaction(tx => tx.countReservedSlots())).toEqual({ slots: 1, generalTokens: 50_000 });
      expect(await store.transaction(tx => tx.maxReservedSlotNumber())).toBe(1);
      expect((await store.transaction(tx => tx.participantByPostId('999001')))?.id).toBe(p1Id);

      // Unique wallet collision rejects cleanly
      await expect(
        store.transaction(tx => tx.saveParticipant(baseParticipant(randomUUID(), 103, { wallet: w1 }))),
      ).rejects.toMatchObject({ code: 'AIRDROP_IDENTITY_USED' });

      // Published Merkle + budget + audit durability across Pool restart
      await store.transaction(async tx => {
        await tx.savePublishedMerkle({
          root: '0x' + 'ab'.repeat(32),
          chainId: 84532,
          distributor: w3,
          totalCommittedRaw: '5000000000000',
          publishedAt: nowIso,
          allocations: { [w1]: { amountRaw: '5000000000000', proof: [] } },
        });
        await tx.audit({ at: nowIso, actor: 'admin', action: 'publish_merkle' });
      });

      const budget = await Promise.all(Array.from({ length: 6 }, () => store.transaction(tx => tx.budget(2, now))));
      expect(budget.filter(Boolean)).toHaveLength(2);

      await pool.end();
      pool = new Pool({ connectionString, max: 2, options: `-c search_path=${schema}` });
      const restarted = createAirdropStore(() => pool!);
      expect((await restarted.transaction(tx => tx.publishedMerkle(), { readOnly: true }))?.root).toBe(
        '0x' + 'ab'.repeat(32),
      );
      expect(await restarted.transaction(tx => tx.publishedMerkleMeta(), { readOnly: true })).toEqual({
        root: '0x' + 'ab'.repeat(32),
        chainId: 84532,
        distributor: w3,
        totalCommittedRaw: '5000000000000',
        publishedAt: nowIso,
        recipientCount: 1,
      });
      expect(await restarted.transaction(tx => tx.publishedMerkleProof(w1.toUpperCase()), { readOnly: true })).toEqual({
        amountRaw: '5000000000000',
        proof: [],
      });
      expect(await restarted.transaction(tx => tx.publishedMerkleProof(w2), { readOnly: true })).toBeNull();
      expect((await restarted.transaction(tx => tx.allParticipants(), { readOnly: true })).length).toBe(3);
    } finally {
      await pool?.end();
      await manager.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await manager.end();
    }
  }, 30_000);
});
