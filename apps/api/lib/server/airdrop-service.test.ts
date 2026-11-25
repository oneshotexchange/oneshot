import { describe, expect, it, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { keccak256, concatHex, type Hex } from 'viem';
import { airdropClaimLeaf } from '@oneshot/evm';
import { memoryAirdropStore } from './airdrop-store';
import { createAirdropService } from './airdrop-service';
import {
  AirdropEvidenceError,
  AirdropProviderUnavailable,
  type AirdropVerifier,
} from './airdrop-verification';
import type { LayerZeroEligibilityResolver } from './layerzero-eligibility';
import type { GenesisSession } from './genesis-auth';
import { ApiError } from './errors';
import {
  AIRDROP_CONSENT_VERSION,
  AIRDROP_GENERAL_POOL,
  airdropCampaignSchema,
  computePostEngagementScore,
} from '../../../web/lib/airdrop-schema';

function verifyProof(proof: readonly Hex[], root: Hex, leaf: Hex): boolean {
  let computed = leaf;
  for (const item of proof) {
    computed = keccak256(concatHex(computed < item ? [computed, item] : [item, computed]));
  }
  return computed === root;
}

const ORIGIN = 'https://oneshot.example.com';

function createSession(num: number): GenesisSession {
  return {
    provider: 'x',
    userId: `x:${num}`,
    sessionId: `session-${num}`,
    expiresAt: 9_999_999_999,
    linkedAddresses: [],
    xAccount: {
      id: String(num),
      username: `user${num}`,
      name: `User ${num}`,
      avatarUrl: null,
    },
  };
}

function makeFixture(
  nowMs = Date.parse('2026-11-23T00:00:00Z'),
  extra: { layerZeroResolver?: LayerZeroEligibilityResolver | null } = {},
) {
  let time = nowMs;
  const store = memoryAirdropStore();
  const metricsByPost = new Map<string, { likes: number; reposts: number; replies: number; views: number }>();

  const verifier: AirdropVerifier = {
    projectHandle: vi.fn(async () => 'oneshot'),
    verifyFollow: vi.fn(async () => ({
      state: 'verified' as const,
      message: 'Following @oneshot',
      checkedAt: new Date(time).toISOString(),
    })),
    verifyRepost: vi.fn(async () => ({
      state: 'verified' as const,
      message: 'Announcement repost verified.',
      checkedAt: new Date(time).toISOString(),
    })),
    verifyPost: vi.fn(async (profile, _campaign, postUrl) => {
      const postId = postUrl.split('/').pop()!;
      const metrics = metricsByPost.get(postId) ?? { likes: 10, reposts: 2, replies: 1, views: 300 };
      const engagementScore = computePostEngagementScore(metrics);
      return {
        postId,
        postUrl: `https://x.com/${profile.username}/status/${postId}`,
        metrics,
        engagementScore,
      };
    }),
    refreshPost: vi.fn(async postId => {
      const metrics = metricsByPost.get(postId) ?? { likes: 10, reposts: 2, replies: 1, views: 300 };
      const engagementScore = computePostEngagementScore(metrics);
      return { metrics, engagementScore };
    }),
    verifyCreatedToken: vi.fn(async () => ({
      state: 'verified' as const,
      message: 'Meme token launch verified on-chain.',
      checkedAt: new Date(time).toISOString(),
      evidenceId: '0x9999999999999999999999999999999999999999',
    })),
    verifyTradeVolume: vi.fn(async () => ({
      state: 'verified' as const,
      message: 'Meme token trading volume verified.',
      checkedAt: new Date(time).toISOString(),
      volumeNativeRaw: '20000000000000000',
    })),
    resolveUserByHandle: vi.fn(async (userName: string) => ({
      id: '100',
      username: userName.replace(/^@/, ''),
    })),
  };

  const service = createAirdropService({
    store,
    verifier,
    layerZeroResolver: extra.layerZeroResolver,
    now: () => time,
    webOrigin: () => ORIGIN,
  });

  return {
    store,
    verifier,
    service,
    metricsByPost,
    setTime: (next: number) => {
      time = next;
    },
  };
}

describe('Airdrop service: LayerZero tiers, missions, lock-in caps, Top 500, and Merkle export', () => {
  const accWinner = privateKeyToAccount('0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
  const accFiveTx = privateKeyToAccount('0x1111111111111111111111111111111111111111111111111111111111111111');
  const accCommunity = privateKeyToAccount('0x2222222222222222222222222222222222222222222222222222222222222222');
  const accWinner2 = privateKeyToAccount('0x3333333333333333333333333333333333333333333333333333333333333333');

  async function setupOpenCampaign(f: ReturnType<typeof makeFixture>, overrides: Partial<ReturnType<typeof airdropCampaignSchema.parse>> = {}) {
    await f.store.transaction(tx =>
      tx.saveCampaign(
        airdropCampaignSchema.parse({
          state: 'open',
          projectXId: '100',
          projectHandle: 'oneshot',
          announcementPostId: '9001',
          ...overrides,
        }),
      ),
    );
  }

  async function bind(service: ReturnType<typeof makeFixture>['service'], session: GenesisSession, account: ReturnType<typeof privateKeyToAccount>) {
    const ch = await service.walletChallenge(session, account.address);
    const sig = await account.signMessage({ message: ch.message });
    return service.bindWallet(session, { wallet: account.address, signature: sig, expectedRevision: ch.expectedRevision });
  }

  it('imports LayerZero snapshot, checks wallet eligibility, binds EIP-191 wallets, and blocks duplicate wallets', async () => {
    const f = makeFixture();
    await setupOpenCampaign(f);
    await f.service.importSnapshot(
      {
        mode: 'replace',
        csvText: `${accWinner.address},lz_winner,25\n${accFiveTx.address},lz_user_5tx,6`,
      },
      'admin:1',
    );

    const e1 = await f.service.checkEligibility(accWinner.address);
    expect(e1).toMatchObject({ tier: 'lz_winner', eligibleForGeneralPool: true, baseGeneralTokens: 40_000, maxBonusTokens: 20_000 });
    const e2 = await f.service.checkEligibility(accFiveTx.address);
    expect(e2).toMatchObject({ tier: 'lz_user_5tx', eligibleForGeneralPool: true, baseGeneralTokens: 20_000, maxBonusTokens: 10_000 });
    const e3 = await f.service.checkEligibility(accCommunity.address);
    expect(e3).toMatchObject({ tier: 'community', eligibleForGeneralPool: false, eligibleForLeaderboard: true, baseGeneralTokens: 0 });

    const s1 = createSession(1);
    const s2 = createSession(2);
    await f.service.enroll(s1, AIRDROP_CONSENT_VERSION);
    await f.service.enroll(s2, AIRDROP_CONSENT_VERSION);

    const bound1 = await bind(f.service, s1, accWinner);
    expect(bound1.participant?.tier).toBe('lz_winner');
    expect(bound1.participant?.boxState).toBe('peek_ready');

    // Duplicate wallet binding across X accounts must fail
    const ch2 = await f.service.walletChallenge(s2, accWinner.address).catch(e => e);
    expect(ch2).toMatchObject({ code: 'AIRDROP_WALLET_USED', status: 409 });
  });

  it('unlocks box on 4 required missions, caps engagement at +50%, awards Top 500, and exports Merkle proofs', async () => {
    const f = makeFixture();
    await setupOpenCampaign(f);
    await f.service.importSnapshot(
      {
        mode: 'replace',
        entries: [
          { wallet: accWinner.address, tier: 'lz_winner', txCount: 15 },
          { wallet: accFiveTx.address, tier: 'lz_user_5tx', txCount: 5 },
        ],
      },
      'admin:1',
    );

    const sWinner = createSession(1);
    const sComm = createSession(2);

    const enrolledWinner = await f.service.enroll(sWinner, AIRDROP_CONSENT_VERSION);
    const refCode = enrolledWinner.participant!.code;
    await f.service.enroll(sComm, AIRDROP_CONSENT_VERSION, refCode);

    // Self-referral across a distinct userId holding the same X identity is rejected cleanly
    await expect(
      f.service.enroll({ ...createSession(1), userId: 'x:1-alt-session' }, AIRDROP_CONSENT_VERSION, refCode),
    ).rejects.toMatchObject({ code: 'AIRDROP_REFERRAL_SELF', status: 409 });

    // Invited referral is tracked immediately before qualification
    const invitedBeforeQualify = await f.service.me(sWinner);
    expect(invitedBeforeQualify.participant?.invitedReferrals).toBe(1);
    expect(invitedBeforeQualify.participant?.qualifiedReferrals).toBe(0);

    await bind(f.service, sWinner, accWinner);
    await bind(f.service, sComm, accCommunity);

    // Winner completes 4 required missions + high-engagement posts (hits +50% cap)
    f.metricsByPost.set('501', { likes: 500, reposts: 200, replies: 50, views: 50_000 });
    await f.service.verifyMission(sWinner, 'follow');
    await f.service.verifyMission(sWinner, 'repost');
    await f.service.verifyMission(sWinner, 'post', 'https://x.com/user1/status/501');
    const unlockedWinner = await f.service.verifyMission(sWinner, 'create_token');

    expect(unlockedWinner.participant?.requiredComplete).toBe(true);
    expect(unlockedWinner.participant?.boxState).toBe('unlocked');
    expect(unlockedWinner.participant?.slotReserved).toBe(true);
    expect(unlockedWinner.participant?.reservedSlotNumber).toBe(1);
    expect(unlockedWinner.participant?.engagementBonusBps).toBe(5000);
    expect(unlockedWinner.participant?.reservedGeneralTokens).toBe(60_000); // 40k + 50%
    expect(unlockedWinner.participant?.rank).toBe(1);
    expect(unlockedWinner.participant?.projectedTop500Tokens).toBe(1_500_000);

    // Community user completes 4 required missions -> ineligible for general pool (0), earns Top 500 Rank #2!
    // Also qualifies Winner's referral once follow + 1 post + wallet are done.
    await f.service.verifyMission(sComm, 'follow');
    await f.service.verifyMission(sComm, 'repost');
    await f.service.verifyMission(sComm, 'post', 'https://x.com/user2/status/502');
    const unlockedComm = await f.service.verifyMission(sComm, 'create_token');

    expect(unlockedComm.participant?.tier).toBe('community');
    expect(unlockedComm.participant?.slotReserved).toBe(false);
    expect(unlockedComm.participant?.reservedGeneralTokens).toBe(0);
    expect(unlockedComm.participant?.rank).toBe(2);
    expect(unlockedComm.participant?.projectedTop500Tokens).toBe(1_500_000);

    // Winner now has 1 invited and 1 qualified referral
    const refreshedWinner = await f.service.me(sWinner);
    expect(refreshedWinner.participant?.invitedReferrals).toBe(1);
    expect(refreshedWinner.participant?.qualifiedReferrals).toBe(1);

    // Duplicate post submission across users blocked; >5 posts blocked; trade_token blocked while disabled
    await expect(
      f.service.verifyMission(sComm, 'post', 'https://x.com/user2/status/501'),
    ).rejects.toMatchObject({ code: 'AIRDROP_POST_DUPLICATE' });

    await expect(f.service.verifyMission(sWinner, 'trade_token')).rejects.toMatchObject({
      code: 'AIRDROP_MISSION_DISABLED',
    });

    // Export and publish Merkle proofs
    const distributor = '0x4444444444444444444444444444444444444444' as const;
    const exported = await f.service.exportMerkle({ chainId: 84532, distributor, publish: true }, 'admin:1');
    expect(exported.recipientCount).toBe(2);
    expect(exported.published).toBe(true);

    const winnerAlloc = exported.allocations[accWinner.address.toLowerCase()]!;
    expect(BigInt(winnerAlloc.amountRaw)).toBe(1_560_000n * 100_000_000n);
    const commAlloc = exported.allocations[accCommunity.address.toLowerCase()]!;
    expect(BigInt(commAlloc.amountRaw)).toBe(1_500_000n * 100_000_000n);

    expect(
      verifyProof(
        winnerAlloc.proof as Hex[],
        exported.root as Hex,
        airdropClaimLeaf(84532, distributor, accWinner.address, BigInt(winnerAlloc.amountRaw)),
      ),
    ).toBe(true);

    const meAfterPublish = await f.service.me(sWinner);
    expect(meAfterPublish.participant?.claimProof?.amountRaw).toBe(winnerAlloc.amountRaw);
  });

  it('enforces maxGeneralSlots cap and prevents general pool oversubscription', async () => {
    const f = makeFixture();
    await setupOpenCampaign(f, { maxGeneralSlots: 1, baseWinnerTokens: 40_000 });
    await f.service.importSnapshot(
      {
        mode: 'replace',
        entries: [
          { wallet: accWinner.address, tier: 'lz_winner' },
          { wallet: accFiveTx.address, tier: 'lz_user_5tx' },
        ],
      },
      'admin:1',
    );

    const s1 = createSession(1);
    const s2 = createSession(2);
    await f.service.enroll(s1, AIRDROP_CONSENT_VERSION);
    await f.service.enroll(s2, AIRDROP_CONSENT_VERSION);
    await bind(f.service, s1, accWinner);
    await bind(f.service, s2, accFiveTx);

    for (const [sess, pid] of [
      [s1, '601'],
      [s2, '602'],
    ] as const) {
      await f.service.verifyMission(sess, 'follow');
      await f.service.verifyMission(sess, 'repost');
      await f.service.verifyMission(sess, 'post', `https://x.com/u/status/${pid}`);
      await f.service.verifyMission(sess, 'create_token');
    }

    const me1 = await f.service.me(s1);
    const me2 = await f.service.me(s2);
    expect(me1.participant?.slotReserved).toBe(true);
    expect(me2.participant?.slotReserved).toBe(false);
    expect(me2.participant?.reservedGeneralTokens).toBe(0);

    const campaign = await f.service.campaign();
    expect(campaign.reservedSlots).toBe(1);
    expect(campaign.reservedGeneralTokens).toBeLessThanOrEqual(AIRDROP_GENERAL_POOL);
  });

  it('supports up to 5 posts, engagement refresh, and enables future trade_token mission when toggled on', async () => {
    const f = makeFixture();
    await setupOpenCampaign(f, { tradeMissionEnabled: true });
    const s = createSession(9);
    await f.service.enroll(s, AIRDROP_CONSENT_VERSION);
    await bind(f.service, s, accCommunity);

    for (let i = 1; i <= 5; i++) {
      await f.service.verifyMission(s, 'post', `https://x.com/user9/status/${700 + i}`);
    }
    await expect(
      f.service.verifyMission(s, 'post', 'https://x.com/user9/status/706'),
    ).rejects.toMatchObject({ code: 'AIRDROP_POST_LIMIT' });

    f.metricsByPost.set('701', { likes: 100, reposts: 10, replies: 5, views: 2000 });
    const refreshed = await f.service.refreshEngagement(s);
    expect(refreshed.participant?.engagementScore).toBeGreaterThan(200);

    const traded = await f.service.verifyMission(s, 'trade_token');
    expect(traded.participant?.checks.trade_token?.state).toBe('verified');
  });

  it('re-locks box and drops rank when switching to another wallet until create_token re-verifies', async () => {
    const f = makeFixture();
    await setupOpenCampaign(f);
    await f.service.importSnapshot(
      { mode: 'replace', entries: [{ wallet: accWinner.address, tier: 'lz_winner' }] },
      'admin:1',
    );
    const s = createSession(12);
    await f.service.enroll(s, AIRDROP_CONSENT_VERSION);
    await bind(f.service, s, accWinner);
    await f.service.verifyMission(s, 'follow');
    await f.service.verifyMission(s, 'repost');
    await f.service.verifyMission(s, 'post', 'https://x.com/user12/status/801');
    const unlocked = await f.service.verifyMission(s, 'create_token');
    expect(unlocked.participant?.boxUnlockedAt).not.toBeNull();
    expect(unlocked.participant?.rank).toBe(1);
    expect(unlocked.participant?.slotReserved).toBe(true);

    // Switch to community wallet before Merkle publish -> create_token cleared, box re-locks, rank dropped
    const switched = await bind(f.service, s, accCommunity);
    expect(switched.participant?.checks.create_token).toBeUndefined();
    expect(switched.participant?.boxUnlockedAt).toBeNull();
    expect(switched.participant?.rank).toBeNull();
    expect(switched.participant?.slotReserved).toBe(false);
    expect(switched.participant?.reservedGeneralTokens).toBe(0);

    // Re-verifying create_token on new wallet re-unlocks and ranks cleanly
    const relisted = await f.service.verifyMission(s, 'create_token');
    expect(relisted.participant?.boxUnlockedAt).not.toBeNull();
    expect(relisted.participant?.rank).toBe(1);
  });

  it('blocks wallet-swap TOCTOU, preserves verified checks, saves quota, enforces cooldowns, and locks claims cleanly', async () => {
    const startMs = Date.parse('2026-11-23T00:00:00Z');
    const f = makeFixture(startMs);
    await setupOpenCampaign(f);
    await f.service.importSnapshot(
      {
        mode: 'replace',
        entries: [
          { wallet: accWinner.address, tier: 'lz_winner' },
          { wallet: accWinner2.address, tier: 'lz_winner' },
          { wallet: accFiveTx.address, tier: 'lz_user_5tx' },
        ],
      },
      'admin:1',
    );

    // 1. Pre-check invalid/duplicate postUrl before calling verifier.verifyPost
    const s1 = createSession(21);
    const s2 = createSession(22);
    const s3 = createSession(23);
    await f.service.enroll(s1, AIRDROP_CONSENT_VERSION);
    await f.service.enroll(s2, AIRDROP_CONSENT_VERSION);
    await f.service.enroll(s3, AIRDROP_CONSENT_VERSION);
    await bind(f.service, s1, accWinner);
    await bind(f.service, s2, accWinner2);
    await bind(f.service, s3, accFiveTx);

    await expect(f.service.verifyMission(s1, 'post', 'https://evil.example/status/1')).rejects.toMatchObject({
      code: 'AIRDROP_POST_INVALID',
      status: 400,
    });
    expect(f.verifier.verifyPost).not.toHaveBeenCalled();

    await f.service.verifyMission(s1, 'post', 'https://x.com/user21/status/901');
    vi.mocked(f.verifier.verifyPost).mockClear();
    await expect(f.service.verifyMission(s2, 'post', 'https://x.com/user22/status/901')).rejects.toMatchObject({
      code: 'AIRDROP_POST_DUPLICATE',
      status: 409,
    });
    expect(f.verifier.verifyPost).not.toHaveBeenCalled();

    // 2. Refresh engagement cooldown (15m) + outage recovery
    await f.service.refreshEngagement(s1);
    await expect(f.service.refreshEngagement(s1)).rejects.toMatchObject({
      code: 'AIRDROP_REFRESH_COOLDOWN',
      status: 429,
    });

    f.setTime(startMs + 15 * 60 * 1000);
    vi.mocked(f.verifier.refreshPost).mockRejectedValueOnce(new Error('X temporarily down'));
    await expect(f.service.refreshEngagement(s1)).rejects.toMatchObject({
      code: 'AIRDROP_PROVIDER_UNAVAILABLE',
      status: 503,
    });
    await f.service.refreshEngagement(s1);

    // 3. Monotonic slot numbers across wallet-switch revocation
    for (const [sess, pid] of [
      [s1, '911'],
      [s2, '912'],
    ] as const) {
      await f.service.verifyMission(sess, 'follow');
      await f.service.verifyMission(sess, 'repost');
      if (sess === s2) await f.service.verifyMission(sess, 'post', `https://x.com/u/status/${pid}`);
      await f.service.verifyMission(sess, 'create_token');
    }
    expect((await f.service.me(s1)).participant?.reservedSlotNumber).toBe(1);
    expect((await f.service.me(s2)).participant?.reservedSlotNumber).toBe(2);

    // s1 switches to community wallet, freeing Spot #1; s3 must get Spot #3 (no duplicate Spot #2)
    await bind(f.service, s1, accCommunity);
    await f.service.verifyMission(s3, 'follow');
    await f.service.verifyMission(s3, 'repost');
    await f.service.verifyMission(s3, 'post', 'https://x.com/u/status/913');
    const s3Unlocked = await f.service.verifyMission(s3, 'create_token');
    expect(s3Unlocked.participant?.reservedSlotNumber).toBe(3);

    // 4. Verified checks are idempotent and cannot be revoked by provider outages
    vi.mocked(f.verifier.verifyFollow).mockClear();
    vi.mocked(f.verifier.verifyFollow).mockResolvedValueOnce({
      state: 'temporarily_unavailable',
      message: 'down',
      checkedAt: new Date(startMs).toISOString(),
    });
    const stillVerified = await f.service.verifyMission(s3, 'follow');
    expect(stillVerified.participant?.checks.follow?.state).toBe('verified');
    expect(f.verifier.verifyFollow).not.toHaveBeenCalled();

    // 5. Wallet-swap TOCTOU during create_token verification rejects cleanly
    const sAttack = createSession(24);
    const accAttackerClean = privateKeyToAccount(
      '0x4444444444444444444444444444444444444444444444444444444444444444',
    );
    const accVictim = privateKeyToAccount(
      '0x5555555555555555555555555555555555555555555555555555555555555555',
    );
    await f.service.enroll(sAttack, AIRDROP_CONSENT_VERSION);
    await bind(f.service, sAttack, accAttackerClean);
    vi.mocked(f.verifier.verifyCreatedToken).mockImplementationOnce(async () => {
      await bind(f.service, sAttack, accVictim);
      return {
        state: 'verified',
        message: 'Token launch verified.',
        checkedAt: new Date(startMs).toISOString(),
        evidenceId: '0x9999999999999999999999999999999999999999',
      };
    });
    await expect(f.service.verifyMission(sAttack, 'create_token')).rejects.toMatchObject({
      code: 'AIRDROP_WALLET_CHANGED',
    });
    expect((await f.service.me(sAttack)).participant?.checks.create_token).toBeUndefined();

    // 6. Empty Merkle publish blocked, claimingOpen prerequisites enforced, and post-publish freeze enforced
    const distributor = '0x4444444444444444444444444444444444444444' as const;
    const emptyFixture = makeFixture(startMs);
    await expect(
      emptyFixture.service.exportMerkle({ chainId: 84532, distributor, publish: true }, 'admin:1'),
    ).rejects.toMatchObject({ code: 'AIRDROP_NO_RECIPIENTS' });

    const currentCampaign = (await f.service.adminSummary()).campaign;
    await expect(
      f.service.configure({ ...currentCampaign, claimingOpen: true }, currentCampaign.revision, 'admin:1'),
    ).rejects.toMatchObject({ code: 'AIRDROP_CONFIG_INVALID' });

    await expect(
      f.service.configure(
        { ...currentCampaign, state: 'closed', claimingOpen: true, chainId: 84532, distributorAddress: distributor },
        currentCampaign.revision,
        'admin:1',
      ),
    ).rejects.toMatchObject({ code: 'AIRDROP_MERKLE_REQUIRED' });

    await f.service.exportMerkle({ chainId: 84532, distributor, publish: true }, 'admin:1');

    // Wallet challenge/bind & missions freeze after Merkle publish with customer-safe wording
    const freezeErr = await f.service.walletChallenge(s3, accAttackerClean.address).catch(e => e);
    expect(freezeErr).toMatchObject({ code: 'AIRDROP_CLAIMS_FROZEN' });
    expect(String(freezeErr.message)).not.toMatch(/merkle/i);

    await expect(
      f.service.verifyMission(sAttack, 'follow'),
    ).rejects.toMatchObject({ code: 'AIRDROP_CLAIMS_FROZEN' });

    await expect(
      f.service.importSnapshot(
        { mode: 'replace', entries: [{ wallet: accAttackerClean.address, tier: 'lz_winner' }] },
        'admin:1',
      ),
    ).rejects.toMatchObject({ code: 'AIRDROP_CLAIMS_FROZEN' });

    const afterPublish = (await f.service.adminSummary()).campaign;
    await f.service.configure(
      { ...afterPublish, state: 'closed', claimingOpen: true },
      afterPublish.revision,
      'admin:1',
    );
    await expect(
      f.service.exportMerkle({ chainId: 84532, distributor, publish: true }, 'admin:1'),
    ).rejects.toMatchObject({ code: 'AIRDROP_CLAIMS_ACTIVE' });
  });

  it('resolves unseen wallets live via Arbitrum/LayerZero Scan, caches into snapshot, and fails closed 503 on outage', async () => {
    const resolveMock = vi.fn(async (wallet: string) => {
      const lower = wallet.toLowerCase();
      if (lower === accWinner.address.toLowerCase()) {
        return { wallet: lower, tier: 'lz_winner' as const, zroClaimedRaw: '50000000000000000000', source: 'arbitrum_zro_claim' as const };
      }
      if (lower === accFiveTx.address.toLowerCase()) {
        return { wallet: lower, tier: 'lz_user_5tx' as const, txCount: 8, source: 'layerzero_scan' as const };
      }
      throw new ApiError(503, 'AIRDROP_LAYERZERO_UNAVAILABLE', 'LayerZero eligibility verification is temporarily unavailable.');
    });

    const f = makeFixture(Date.parse('2026-11-23T00:00:00Z'), {
      layerZeroResolver: { resolve: resolveMock },
    });
    await setupOpenCampaign(f);

    // 1. Live lookup on checkEligibility resolves lz_winner and caches into snapshot
    const first = await f.service.checkEligibility(accWinner.address);
    expect(first).toMatchObject({ tier: 'lz_winner', eligibleForGeneralPool: true, baseGeneralTokens: 40_000 });
    expect(resolveMock).toHaveBeenCalledTimes(1);

    // Second check hits PostgreSQL/memory cache without calling resolver again
    const second = await f.service.checkEligibility(accWinner.address);
    expect(second.tier).toBe('lz_winner');
    expect(resolveMock).toHaveBeenCalledTimes(1);

    // 2. Live lookup on bindWallet binds lz_user_5tx tier & caches txCount
    const s = createSession(99);
    await f.service.enroll(s, AIRDROP_CONSENT_VERSION);
    const bound = await bind(f.service, s, accFiveTx);
    expect(bound.participant?.tier).toBe('lz_user_5tx');
    expect((await f.service.adminSummary()).snapshot).toEqual({ total: 2, winners: 1, fiveTx: 1 });

    // 3. Resolver outage fails closed with 503 instead of downgrading unknown wallet to community
    await expect(f.service.checkEligibility(accCommunity.address)).rejects.toMatchObject({
      code: 'AIRDROP_LAYERZERO_UNAVAILABLE',
      status: 503,
    });
  });

  it('auto-resolves official numeric X ID from projectHandle when opening campaign', async () => {
    const f = makeFixture();
    const prevClientId = process.env.X_OAUTH_CLIENT_ID;
    process.env.X_OAUTH_CLIENT_ID = 'test-x-client-id';
    try {
      const current = (await f.service.adminSummary()).campaign;
      const saved = await f.service.configure(
        {
          ...current,
          state: 'open',
          projectHandle: 'oneshot',
          projectXId: '',
        },
        current.revision,
        'admin:1',
      );
      expect(f.verifier.resolveUserByHandle).toHaveBeenCalledWith('oneshot');
      expect(saved.state).toBe('open');
      expect(saved.projectXId).toBe('100');
      expect(saved.projectHandle).toBe('oneshot');
    } finally {
      if (prevClientId === undefined) delete process.env.X_OAUTH_CLIENT_ID;
      else process.env.X_OAUTH_CLIENT_ID = prevClientId;
    }
  });

  it('maps X handle lookup failures cleanly in configure instead of bubbling raw provider errors', async () => {
    const f = makeFixture();
    const prevClientId = process.env.X_OAUTH_CLIENT_ID;
    process.env.X_OAUTH_CLIENT_ID = 'test-x-client-id';
    try {
      const current = (await f.service.adminSummary()).campaign;

      vi.mocked(f.verifier.resolveUserByHandle!).mockRejectedValueOnce(
        new AirdropEvidenceError('Account @oneshot not found.'),
      );
      await expect(
        f.service.configure(
          { ...current, state: 'open', projectHandle: 'oneshot', projectXId: '' },
          current.revision,
          'admin:1',
        ),
      ).rejects.toMatchObject({ code: 'AIRDROP_PROJECT_NOT_FOUND', status: 400 });

      vi.mocked(f.verifier.resolveUserByHandle!).mockRejectedValueOnce(
        new AirdropProviderUnavailable('GetX is temporarily unavailable.'),
      );
      await expect(
        f.service.configure(
          { ...current, state: 'open', projectHandle: 'OneshotExchange', projectXId: '' },
          current.revision,
          'admin:1',
        ),
      ).rejects.toMatchObject({ code: 'AIRDROP_PROVIDER_UNAVAILABLE', status: 503 });
    } finally {
      if (prevClientId === undefined) delete process.env.X_OAUTH_CLIENT_ID;
      else process.env.X_OAUTH_CLIENT_ID = prevClientId;
    }
  });
});
