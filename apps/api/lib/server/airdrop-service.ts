import { randomBytes, randomUUID } from 'node:crypto';
import { verifyMessage, type Address } from 'viem';
import { buildAirdropMerkleTree, AIRDROP_TOKENOMICS } from '@oneshot/evm';
import { ApiError } from './errors';
import { webOrigin } from './origins';
import { genesisAuth, type GenesisSession } from './genesis-auth';
import { airdropStore, type AirdropStore, type AirdropTransaction } from './airdrop-store';
import {
  layerZeroEligibilityResolver,
  type LayerZeroEligibilityResolver,
} from './layerzero-eligibility';
import {
  AirdropEvidenceError,
  AirdropProviderUnavailable,
  createAirdropVerifier,
  type AirdropVerifier,
} from './airdrop-verification';
import {
  AIRDROP_GENERAL_POOL,
  AIRDROP_MAX_POSTS,
  AIRDROP_REFRESH_COOLDOWN_MS,
  AIRDROP_TOP500_POOL,
  AIRDROP_TOTAL_POOL,
  AIRDROP_FDV_USD,
  airdropCampaignSchema,
  airdropMerkleExportSchema,
  airdropPostId,
  airdropSnapshotImportSchema,
  airdropWalletBindMessage,
  airdropWalletBindSchema,
  airdropWalletChallengeSchema,
  computeBaseGeneralTokens,
  computeEngagementBonusBps,
  computeParticipantEngagementScore,
  computeParticipantScore,
  computeRequiredProgressCount,
  computeTop500RewardForRank,
  maskWallet,
  parseSnapshotCsv,
  requiredMissionsComplete,
  tokensToRaw8,
  type AirdropCampaign,
  type AirdropEligibilityResponse,
  type AirdropLeaderboardEntry,
  type AirdropMeResponse,
  type AirdropMissionTask,
  type AirdropParticipant,
  type AirdropParticipantSummary,
  type AirdropPostMetrics,
  type AirdropPublicCampaign,
  type AirdropSnapshotEntry,
  type AirdropSnapshotImportInput,
  type AirdropSnapshotTier,
} from '../../../web/lib/airdrop-schema';

function fail(code: string, message: string, status = 409): never {
  throw new ApiError(status, code, message);
}

function requireXProfile(session: GenesisSession) {
  if (!session.xAccount) fail('AIRDROP_X_REQUIRED', 'Connect your X account to continue.', 403);
  return session.xAccount;
}

export function publicAirdropCampaign(
  campaign: AirdropCampaign,
  reserved: { slots: number; generalTokens: number },
  merkleRoot: string | null,
  now = Date.now(),
): AirdropPublicCampaign {
  const state =
    campaign.state === 'open'
      ? campaign.closesAt && Date.parse(campaign.closesAt) <= now
        ? 'closed'
        : campaign.opensAt && Date.parse(campaign.opensAt) > now
          ? 'upcoming'
          : 'open'
      : campaign.state;
  return {
    state,
    tokenName: campaign.tokenName,
    tokenSymbol: campaign.tokenSymbol,
    opensAt: campaign.opensAt,
    closesAt: campaign.closesAt,
    projectHandle: campaign.projectHandle || null,
    announcementPostId: campaign.announcementPostId || null,
    baseWinnerTokens: campaign.baseWinnerTokens,
    maxGeneralSlots: campaign.maxGeneralSlots,
    reservedSlots: reserved.slots,
    reservedGeneralTokens: reserved.generalTokens,
    generalPoolTokens: AIRDROP_GENERAL_POOL,
    top500PoolTokens: AIRDROP_TOP500_POOL,
    totalAirdropTokens: AIRDROP_TOTAL_POOL,
    openingFdvUsd: AIRDROP_FDV_USD,
    tradeMissionEnabled: campaign.tradeMissionEnabled,
    minTradeNativeRaw: campaign.minTradeNativeRaw,
    chainId: campaign.chainId,
    distributorAddress: campaign.distributorAddress,
    tokenAddress: campaign.tokenAddress,
    marketAddress: campaign.marketAddress,
    claimingOpen: campaign.claimingOpen,
    claimDeadline: campaign.claimDeadline,
    snapshotCutoffAt: campaign.snapshotCutoffAt,
    merkleRoot,
    version: campaign.version,
  };
}

function assertOpen(campaign: AirdropCampaign, now: number) {
  if (publicAirdropCampaign(campaign, { slots: 0, generalTokens: 0 }, null, now).state !== 'open') {
    fail('AIRDROP_CLOSED', 'The airdrop mission window is not open right now.');
  }
}

async function assertWritableCampaign(tx: AirdropTransaction, nowMs: number): Promise<AirdropCampaign> {
  const campaign = await tx.campaign();
  assertOpen(campaign, nowMs);
  if (await tx.publishedMerkleMeta()) {
    fail('AIRDROP_CLAIMS_FROZEN', 'Wallet changes and missions are closed now that final airdrop allocations are locked.');
  }
  return campaign;
}

function requireOwner(participant: AirdropParticipant | null, session: GenesisSession): AirdropParticipant {
  if (!participant || participant.userId !== session.userId) {
    fail('AIRDROP_NOT_FOUND', 'Connect X to open your airdrop box.', 404);
  }
  if (participant.profile.id !== requireXProfile(session).id) {
    fail('AIRDROP_X_CHANGED', 'Reconnect the X account linked to your mission box.', 403);
  }
  return participant;
}

type RankedRow = {
  participant: AirdropParticipant;
  invitedReferrals: number;
  qualifiedReferrals: number;
  engagementScore: number;
  totalScore: number;
  rank: number | null;
  projectedTop500Tokens: number;
};

async function computeRankings(tx: AirdropTransaction): Promise<Map<string, RankedRow>> {
  const [all, referralMap] = await Promise.all([tx.allParticipants(), tx.referralCounts()]);
  const rows: RankedRow[] = all.map(participant => {
    const referralStats = referralMap[participant.id];
    const invitedReferrals = referralStats?.total ?? 0;
    const qualifiedReferrals = referralStats?.qualified ?? 0;
    const engagementScore = computeParticipantEngagementScore(participant);
    const totalScore = computeParticipantScore(participant, qualifiedReferrals);
    return {
      participant,
      invitedReferrals,
      qualifiedReferrals,
      engagementScore,
      totalScore,
      rank: null,
      projectedTop500Tokens: 0,
    };
  });

  const eligible = rows
    .filter(row => Boolean(row.participant.boxUnlockedAt && row.participant.wallet))
    .sort((a, b) => {
      if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
      const tA = Date.parse(a.participant.boxUnlockedAt!);
      const tB = Date.parse(b.participant.boxUnlockedAt!);
      if (tA !== tB) return tA - tB;
      return a.participant.id.localeCompare(b.participant.id);
    });

  eligible.forEach((row, index) => {
    const rank = index + 1;
    row.rank = rank;
    row.projectedTop500Tokens = computeTop500RewardForRank(rank);
  });

  return new Map(rows.map(row => [row.participant.id, row]));
}

async function recomputeAllocationAndLock(
  tx: AirdropTransaction,
  participant: AirdropParticipant,
  campaign: AirdropCampaign,
  nowIso: string,
) {
  participant.baseGeneralTokens = computeBaseGeneralTokens(participant.tier, campaign.baseWinnerTokens);
  const engagementScore = computeParticipantEngagementScore(participant);
  const bonusBps = computeEngagementBonusBps(engagementScore);
  const desiredBonus =
    participant.tier === 'community' ? 0 : Math.floor((participant.baseGeneralTokens * bonusBps) / 10_000);

  const complete = requiredMissionsComplete(participant);
  if (complete && !participant.boxUnlockedAt) {
    participant.boxUnlockedAt = nowIso;
  } else if (!complete && participant.boxUnlockedAt) {
    participant.boxUnlockedAt = null;
  }

  if (!complete || participant.tier === 'community' || participant.baseGeneralTokens <= 0) {
    participant.slotReserved = false;
    participant.reservedSlotNumber = null;
    participant.engagementBonusTokens = 0;
    participant.reservedGeneralTokens = 0;
    return;
  }

  const totals = await tx.countReservedSlots();
  const otherSlots = totals.slots - (participant.slotReserved ? 1 : 0);
  const otherTokens = totals.generalTokens - (participant.slotReserved ? participant.reservedGeneralTokens : 0);

  if (!participant.slotReserved) {
    if (otherSlots < campaign.maxGeneralSlots && otherTokens + participant.baseGeneralTokens <= AIRDROP_GENERAL_POOL) {
      const maxSlot = await tx.maxReservedSlotNumber();
      participant.slotReserved = true;
      participant.reservedSlotNumber = maxSlot + 1;
    }
  }

  if (participant.slotReserved) {
    const remainingRoom = Math.max(0, AIRDROP_GENERAL_POOL - otherTokens - participant.baseGeneralTokens);
    const cappedBonus = Math.min(desiredBonus, remainingRoom);
    participant.engagementBonusTokens = cappedBonus;
    participant.reservedGeneralTokens = participant.baseGeneralTokens + cappedBonus;
  } else {
    participant.engagementBonusTokens = 0;
    participant.reservedGeneralTokens = 0;
  }
}

export function createAirdropService(options: {
  store?: AirdropStore;
  verifier?: AirdropVerifier;
  layerZeroResolver?: LayerZeroEligibilityResolver | null;
  now?: () => number;
  webOrigin: () => string;
}) {
  const store = options.store || airdropStore;
  const layerZeroResolver = options.layerZeroResolver ?? null;
  const now = options.now || Date.now;
  const verifier =
    options.verifier ||
    createAirdropVerifier({
      reserveRead: () => store.transaction(async tx => tx.budget((await tx.campaign()).dailyReadLimit, now())),
      now,
    });

  async function resolveAndCacheSnapshot(
    wallet: string,
    campaign: AirdropCampaign,
    existing: AirdropSnapshotEntry | null,
  ): Promise<AirdropSnapshotEntry | null> {
    if (existing) return existing;
    if (!campaign.liveLayerZeroLookup || !layerZeroResolver) return null;

    const live = await layerZeroResolver.resolve(wallet, { cutoffAt: campaign.snapshotCutoffAt });
    if (live.tier !== 'lz_winner' && live.tier !== 'lz_user_5tx') return null;

    const importedAt = new Date(now()).toISOString();
    await store.transaction(async tx => {
      await tx.importSnapshot(
        [
          {
            wallet,
            tier: live.tier as AirdropSnapshotTier,
            ...(live.txCount !== undefined ? { txCount: live.txCount } : {}),
          },
        ],
        'merge',
        importedAt,
      );
    });
    return {
      wallet,
      tier: live.tier,
      ...(live.txCount !== undefined ? { txCount: live.txCount } : {}),
      importedAt,
    };
  }

  async function buildMe(tx: AirdropTransaction, session: GenesisSession): Promise<AirdropMeResponse> {
    const record = await tx.participant('userId', session.userId);
    if (!record) {
      return {
        profile: session.xAccount || null,
        participant: null,
        referralUrl: null,
      };
    }
    const participant = requireOwner(record, session);
    const ranked = await computeRankings(tx);
    const row = ranked.get(participant.id)!;
    const engagementBonusBps = computeEngagementBonusBps(row.engagementScore);
    const requiredComplete = requiredMissionsComplete(participant);
    const progress = computeRequiredProgressCount(participant);
    const boxState: AirdropParticipantSummary['boxState'] = participant.boxUnlockedAt
      ? 'unlocked'
      : progress > 0
        ? 'charging'
        : participant.wallet
          ? 'peek_ready'
          : 'sealed';

    const claimProof = participant.wallet ? await tx.publishedMerkleProof(participant.wallet) : null;

    const totalProjectedTokens = participant.reservedGeneralTokens + row.projectedTop500Tokens;
    const {
      userId: _u,
      referrerId: _r,
      walletChallengeNonce: _n,
      consentVersion: _c,
      ...rest
    } = participant;

    return {
      profile: session.xAccount || null,
      participant: {
        ...rest,
        invitedReferrals: row.invitedReferrals,
        qualifiedReferrals: row.qualifiedReferrals,
        engagementScore: row.engagementScore,
        engagementBonusBps,
        totalScore: row.totalScore,
        requiredComplete,
        rank: row.rank,
        projectedTop500Tokens: row.projectedTop500Tokens,
        totalProjectedTokens,
        totalProjectedRaw: tokensToRaw8(totalProjectedTokens).toString(),
        boxState,
        claimProof,
      },
      referralUrl: `${options.webOrigin()}/airdrop?ref=${participant.code}`,
    };
  }

  return {
    campaign: () =>
      store.transaction(
        async tx => {
          const [camp, reserved, merkle] = await Promise.all([
            tx.campaign(),
            tx.countReservedSlots(),
            tx.publishedMerkleMeta(),
          ]);
          return publicAirdropCampaign(camp, reserved, merkle?.root ?? null, now());
        },
        { readOnly: true },
      ),

    async checkEligibility(walletInput: string): Promise<AirdropEligibilityResponse> {
      const wallet = walletInput.toLowerCase();
      const initial = await store.transaction(
        async tx => {
          const [campaign, existingSnapshot, reserved, proof] = await Promise.all([
            tx.campaign(),
            tx.lookupSnapshot(wallet),
            tx.countReservedSlots(),
            tx.publishedMerkleProof(wallet),
          ]);
          return { campaign, existingSnapshot, reserved, proof };
        },
        { readOnly: true },
      );

      const snapshot = await resolveAndCacheSnapshot(wallet, initial.campaign, initial.existingSnapshot);
      const tier = snapshot?.tier ?? 'community';
      const baseGeneralTokens = computeBaseGeneralTokens(tier, initial.campaign.baseWinnerTokens);
      const maxBonusTokens = Math.floor(baseGeneralTokens / 2);
      const slotsRemaining = Math.max(0, initial.campaign.maxGeneralSlots - initial.reserved.slots);
      const generalPoolExhausted = slotsRemaining === 0 || initial.reserved.generalTokens >= AIRDROP_GENERAL_POOL;
      return {
        wallet,
        tier,
        eligibleForGeneralPool: tier !== 'community',
        eligibleForLeaderboard: true,
        baseGeneralTokens,
        maxBonusTokens,
        maxGeneralTokens: baseGeneralTokens + maxBonusTokens,
        slotsRemaining,
        generalPoolExhausted,
        txCount: snapshot?.txCount ?? null,
        proof: initial.proof,
      };
    },

    async leaderboard(offset = 0, limit = 50): Promise<{ totalRanked: number; entries: AirdropLeaderboardEntry[] }> {
      return store.transaction(
        async tx => {
          const ranked = await computeRankings(tx);
          const list = [...ranked.values()]
            .filter(row => row.rank !== null)
            .sort((a, b) => a.rank! - b.rank!);
          const slice = list.slice(offset, offset + limit);
          return {
            totalRanked: list.length,
            entries: slice.map(row => ({
              rank: row.rank!,
              username: row.participant.profile.username,
              name: row.participant.profile.name,
              avatarUrl: row.participant.profile.avatarUrl,
              walletMasked: maskWallet(row.participant.wallet || ''),
              tier: row.participant.tier,
              postsCount: row.participant.posts.length,
              engagementScore: row.engagementScore,
              qualifiedReferrals: row.qualifiedReferrals,
              totalScore: row.totalScore,
              projectedTop500Tokens: row.projectedTop500Tokens,
              reservedGeneralTokens: row.participant.reservedGeneralTokens,
            })),
          };
        },
        { readOnly: true },
      );
    },

    me: (session: GenesisSession) => store.transaction(tx => buildMe(tx, session), { readOnly: true }),

    async enroll(session: GenesisSession, consentVersion: string, referral?: string): Promise<AirdropMeResponse> {
      const identity = requireXProfile(session);
      return store.transaction(async tx => {
        const existing = await tx.participant('userId', session.userId);
        if (existing) {
          const p = requireOwner(existing, session);
          p.profile = identity;
          await tx.saveParticipant(p);
          return buildMe(tx, session);
        }
        await assertWritableCampaign(tx, now());
        const referrer = referral ? await tx.participant('code', referral) : null;
        if (referral && !referrer) {
          fail('AIRDROP_REFERRAL_INVALID', 'This invitation link is invalid or expired.');
        }
        if (referrer && (referrer.userId === session.userId || referrer.profile.id === identity.id)) {
          fail('AIRDROP_REFERRAL_SELF', 'You cannot use your own invitation link.');
        }
        if (await tx.participant('xId', identity.id)) {
          fail('AIRDROP_IDENTITY_USED', 'This X account is already linked to an airdrop box.');
        }
        const createdAt = new Date(now()).toISOString();
        const participant: AirdropParticipant = {
          id: randomUUID(),
          userId: session.userId,
          profile: identity,
          code: randomBytes(12).toString('base64url'),
          referrerId: referrer?.id ?? null,
          createdAt,
          revision: 1,
          wallet: null,
          walletBoundAt: null,
          walletChallengeNonce: null,
          tier: 'community',
          checks: {},
          posts: [],
          lastEngagementRefreshAt: null,
          boxUnlockedAt: null,
          slotReserved: false,
          reservedSlotNumber: null,
          baseGeneralTokens: 0,
          engagementBonusTokens: 0,
          reservedGeneralTokens: 0,
          consentVersion,
        };
        await tx.saveParticipant(participant);
        await tx.audit({ at: createdAt, actor: session.userId, action: 'enroll', participantId: participant.id });
        return buildMe(tx, session);
      });
    },

    async walletChallenge(session: GenesisSession, walletInput: string) {
      const { wallet } = airdropWalletChallengeSchema.parse({ wallet: walletInput });
      return store.transaction(async tx => {
        await assertWritableCampaign(tx, now());
        const participant = requireOwner(await tx.participant('userId', session.userId), session);
        const existing = await tx.participant('wallet', wallet);
        if (existing && existing.id !== participant.id) {
          fail('AIRDROP_WALLET_USED', 'This wallet is already bound to another X account.');
        }
        const nonce = randomBytes(16).toString('hex');
        participant.walletChallengeNonce = nonce;
        participant.revision++;
        await tx.saveParticipant(participant);
        const message = airdropWalletBindMessage({
          origin: options.webOrigin(),
          participantId: participant.id,
          xId: participant.profile.id,
          wallet,
          nonce,
        });
        return { wallet, nonce, expectedRevision: participant.revision, message };
      });
    },

    async bindWallet(
      session: GenesisSession,
      input: { wallet: string; signature: string; expectedRevision: number },
    ): Promise<AirdropMeResponse> {
      const parsed = airdropWalletBindSchema.parse(input);
      const snapshot = await store.transaction(async tx => {
        const campaign = await assertWritableCampaign(tx, now());
        const participant = requireOwner(await tx.participant('userId', session.userId), session);
        if (participant.revision !== parsed.expectedRevision) {
          fail('AIRDROP_REVISION', 'Your mission box updated. Request a fresh signature challenge.');
        }
        if (!participant.walletChallengeNonce) {
          fail('AIRDROP_CHALLENGE_MISSING', 'Request a wallet confirmation message before signing.', 400);
        }
        const existingSnapshot = await tx.lookupSnapshot(parsed.wallet);
        return {
          participantId: participant.id,
          xId: participant.profile.id,
          nonce: participant.walletChallengeNonce,
          expectedRevision: participant.revision,
          campaign,
          existingSnapshot,
        };
      });

      const message = airdropWalletBindMessage({
        origin: options.webOrigin(),
        participantId: snapshot.participantId,
        xId: snapshot.xId,
        wallet: parsed.wallet,
        nonce: snapshot.nonce,
      });

      let valid = false;
      try {
        valid = await verifyMessage({
          address: parsed.wallet as Address,
          message,
          signature: parsed.signature as `0x${string}`,
        });
      } catch {
        valid = false;
      }
      if (!valid) fail('AIRDROP_SIGNATURE_INVALID', 'Wallet signature verification failed.', 400);

      let liveResolved: { tier: AirdropSnapshotTier; txCount?: number } | null = null;
      if (!snapshot.existingSnapshot && snapshot.campaign.liveLayerZeroLookup && layerZeroResolver) {
        const live = await layerZeroResolver.resolve(parsed.wallet, {
          cutoffAt: snapshot.campaign.snapshotCutoffAt,
        });
        if (live.tier === 'lz_winner' || live.tier === 'lz_user_5tx') {
          liveResolved = {
            tier: live.tier,
            ...(live.txCount !== undefined ? { txCount: live.txCount } : {}),
          };
        }
      }

      return store.transaction(async tx => {
        const campaign = await assertWritableCampaign(tx, now());
        const participant = requireOwner(await tx.participant('userId', session.userId), session);
        if (
          participant.revision !== snapshot.expectedRevision ||
          participant.walletChallengeNonce !== snapshot.nonce
        ) {
          fail('AIRDROP_REVISION', 'Your mission box updated. Request a fresh signature challenge.');
        }
        const existing = await tx.participant('wallet', parsed.wallet);
        if (existing && existing.id !== participant.id) {
          fail('AIRDROP_WALLET_USED', 'This wallet is already bound to another X account.');
        }
        const at = new Date(now()).toISOString();
        if (liveResolved) {
          await tx.importSnapshot(
            [
              {
                wallet: parsed.wallet.toLowerCase(),
                tier: liveResolved.tier,
                ...(liveResolved.txCount !== undefined ? { txCount: liveResolved.txCount } : {}),
              },
            ],
            'merge',
            at,
          );
        }
        const lz = await tx.lookupSnapshot(parsed.wallet);
        const switchedWallet = participant.wallet && participant.wallet.toLowerCase() !== parsed.wallet.toLowerCase();
        if (switchedWallet) {
          delete participant.checks.create_token;
          delete participant.checks.trade_token;
        }
        participant.wallet = parsed.wallet.toLowerCase();
        participant.walletBoundAt = at;
        participant.walletChallengeNonce = null;
        participant.tier = lz?.tier ?? 'community';
        participant.revision++;
        await recomputeAllocationAndLock(tx, participant, campaign, at);
        await tx.saveParticipant(participant);
        await tx.audit({
          at,
          actor: session.userId,
          action: 'bind_wallet',
          participantId: participant.id,
          details: { wallet: participant.wallet, tier: participant.tier },
        });
        return buildMe(tx, session);
      });
    },

    async verifyMission(
      session: GenesisSession,
      task: AirdropMissionTask,
      postUrl?: string,
    ): Promise<AirdropMeResponse> {
      const cleanPostUrl = postUrl?.trim() || undefined;
      type VerifyPre =
        | { alreadyVerified: true; me: AirdropMeResponse }
        | { alreadyVerified: false; campaign: AirdropCampaign; participant: AirdropParticipant };

      const pre = await store.transaction<VerifyPre>(async tx => {
        const campaign = await assertWritableCampaign(tx, now());
        const participant = requireOwner(await tx.participant('userId', session.userId), session);
        if (task === 'trade_token' && !campaign.tradeMissionEnabled) {
          fail('AIRDROP_MISSION_DISABLED', 'This mission is not active right now.', 409);
        }
        if ((task === 'create_token' || task === 'trade_token') && !participant.wallet) {
          fail('AIRDROP_WALLET_REQUIRED', 'Link your wallet first to verify this mission.', 400);
        }
        if (task !== 'post' && participant.checks[task]?.state === 'verified') {
          return { alreadyVerified: true, me: await buildMe(tx, session) };
        }
        if (task === 'repost' && cleanPostUrl && !airdropPostId(cleanPostUrl)) {
          fail('AIRDROP_POST_INVALID', 'Enter a valid public X quote-post link, or leave blank to check your repost.', 400);
        }
        if (task === 'post') {
          if (!cleanPostUrl) {
            fail('AIRDROP_POST_REQUIRED', 'Enter your public X post URL.', 400);
          }
          if (participant.posts.length >= AIRDROP_MAX_POSTS) {
            fail('AIRDROP_POST_LIMIT', `You have already submitted the maximum of ${AIRDROP_MAX_POSTS} posts.`);
          }
          const postId = airdropPostId(cleanPostUrl);
          if (!postId) {
            fail('AIRDROP_POST_INVALID', 'Use a public X post link such as https://x.com/you/status/123.', 400);
          }
          if (await tx.participantByPostId(postId)) {
            fail('AIRDROP_POST_DUPLICATE', 'This X post has already been submitted.');
          }
        }
        return { alreadyVerified: false, campaign, participant };
      });
      if (pre.alreadyVerified) return pre.me;

      const at = new Date(now()).toISOString();

      if (task === 'follow') {
        let checkResult;
        try {
          checkResult = await verifier.verifyFollow(pre.participant.profile, pre.campaign);
        } catch (err) {
          checkResult = {
            state: err instanceof AirdropEvidenceError ? ('needs_action' as const) : ('temporarily_unavailable' as const),
            message: (err as Error).message,
            checkedAt: at,
          };
        }
        return store.transaction(async tx => {
          const campaign = await assertWritableCampaign(tx, now());
          const participant = requireOwner(await tx.participant('userId', session.userId), session);
          if (participant.checks.follow?.state === 'verified') return buildMe(tx, session);
          participant.checks.follow = checkResult;
          participant.revision++;
          await recomputeAllocationAndLock(tx, participant, campaign, at);
          await tx.saveParticipant(participant);
          return buildMe(tx, session);
        });
      }

      if (task === 'repost') {
        let checkResult;
        try {
          checkResult = await verifier.verifyRepost(pre.participant.profile, pre.campaign, cleanPostUrl);
        } catch (err) {
          checkResult = {
            state: err instanceof AirdropEvidenceError ? ('needs_action' as const) : ('temporarily_unavailable' as const),
            message: (err as Error).message,
            checkedAt: at,
          };
        }
        return store.transaction(async tx => {
          const campaign = await assertWritableCampaign(tx, now());
          const participant = requireOwner(await tx.participant('userId', session.userId), session);
          if (participant.checks.repost?.state === 'verified') return buildMe(tx, session);
          participant.checks.repost = checkResult;
          participant.revision++;
          await recomputeAllocationAndLock(tx, participant, campaign, at);
          await tx.saveParticipant(participant);
          return buildMe(tx, session);
        });
      }

      if (task === 'post') {
        let evidence;
        try {
          evidence = await verifier.verifyPost(pre.participant.profile, pre.campaign, cleanPostUrl!);
        } catch (err) {
          if (err instanceof AirdropEvidenceError) {
            fail('AIRDROP_POST_INVALID', err.message, 400);
          }
          fail('AIRDROP_PROVIDER_UNAVAILABLE', (err as Error).message, 503);
        }
        return store.transaction(async tx => {
          const campaign = await assertWritableCampaign(tx, now());
          const participant = requireOwner(await tx.participant('userId', session.userId), session);
          if (participant.posts.length >= AIRDROP_MAX_POSTS) {
            fail('AIRDROP_POST_LIMIT', `You have already verified ${AIRDROP_MAX_POSTS} posts.`);
          }
          const existingOwner = await tx.participantByPostId(evidence.postId);
          if (existingOwner) {
            fail('AIRDROP_POST_DUPLICATE', 'This X post has already been submitted.');
          }
          participant.posts.push({
            postId: evidence.postId,
            postUrl: evidence.postUrl,
            verifiedAt: at,
            lastRefreshedAt: at,
            metrics: evidence.metrics,
            engagementScore: evidence.engagementScore,
          });
          participant.revision++;
          await recomputeAllocationAndLock(tx, participant, campaign, at);
          await tx.saveParticipant(participant);
          await tx.audit({
            at,
            actor: session.userId,
            action: 'verify_post',
            participantId: participant.id,
            details: { postId: evidence.postId, engagementScore: evidence.engagementScore },
          });
          return buildMe(tx, session);
        });
      }

      if (task === 'create_token') {
        const result = await verifier.verifyCreatedToken(pre.participant.wallet!);
        return store.transaction(async tx => {
          const campaign = await assertWritableCampaign(tx, now());
          const participant = requireOwner(await tx.participant('userId', session.userId), session);
          if (participant.wallet?.toLowerCase() !== pre.participant.wallet!.toLowerCase()) {
            fail('AIRDROP_WALLET_CHANGED', 'Your linked wallet changed. Please verify this mission again.');
          }
          if (participant.checks.create_token?.state === 'verified') return buildMe(tx, session);
          participant.checks.create_token = {
            ...result,
            ...(result.evidenceId ? { tokenMarket: result.evidenceId } : {}),
          };
          participant.revision++;
          await recomputeAllocationAndLock(tx, participant, campaign, at);
          await tx.saveParticipant(participant);
          return buildMe(tx, session);
        });
      }

      const tradeResult = await verifier.verifyTradeVolume(pre.participant.wallet!, pre.campaign.minTradeNativeRaw);
      return store.transaction(async tx => {
        const campaign = await assertWritableCampaign(tx, now());
        const participant = requireOwner(await tx.participant('userId', session.userId), session);
        if (!campaign.tradeMissionEnabled) {
          fail('AIRDROP_MISSION_DISABLED', 'This mission is not active right now.', 409);
        }
        if (participant.wallet?.toLowerCase() !== pre.participant.wallet!.toLowerCase()) {
          fail('AIRDROP_WALLET_CHANGED', 'Your linked wallet changed. Please verify this mission again.');
        }
        if (participant.checks.trade_token?.state === 'verified') return buildMe(tx, session);
        participant.checks.trade_token = tradeResult;
        participant.revision++;
        await recomputeAllocationAndLock(tx, participant, campaign, at);
        await tx.saveParticipant(participant);
        return buildMe(tx, session);
      });
    },

    async refreshEngagement(session: GenesisSession): Promise<AirdropMeResponse> {
      const pre = await store.transaction(async tx => {
        await assertWritableCampaign(tx, now());
        const participant = requireOwner(await tx.participant('userId', session.userId), session);
        if (!participant.posts.length) {
          fail('AIRDROP_NO_POSTS', 'Verify at least one X post before refreshing engagement.', 400);
        }
        if (
          participant.lastEngagementRefreshAt &&
          now() - Date.parse(participant.lastEngagementRefreshAt) < AIRDROP_REFRESH_COOLDOWN_MS
        ) {
          fail(
            'AIRDROP_REFRESH_COOLDOWN',
            'Engagement was refreshed recently. Please wait 15 minutes before refreshing again.',
            429,
          );
        }
        return participant;
      });

      const settled = await Promise.allSettled(
        pre.posts.map(async post => ({
          postId: post.postId,
          ...(await verifier.refreshPost(post.postId)),
        })),
      );
      const updates: { postId: string; metrics: AirdropPostMetrics; engagementScore: number }[] = [];
      let firstEvidenceError: AirdropEvidenceError | null = null;
      for (const outcome of settled) {
        if (outcome.status === 'fulfilled') {
          updates.push(outcome.value);
        } else if (outcome.reason instanceof AirdropEvidenceError && !firstEvidenceError) {
          firstEvidenceError = outcome.reason;
        }
      }
      if (updates.length === 0) {
        if (firstEvidenceError) fail('AIRDROP_POST_INVALID', firstEvidenceError.message, 400);
        fail(
          'AIRDROP_PROVIDER_UNAVAILABLE',
          'X engagement refresh is temporarily unavailable. Your progress is saved; try again later.',
          503,
        );
      }

      const at = new Date(now()).toISOString();
      return store.transaction(async tx => {
        const campaign = await assertWritableCampaign(tx, now());
        const current = requireOwner(await tx.participant('userId', session.userId), session);
        if (
          current.lastEngagementRefreshAt &&
          now() - Date.parse(current.lastEngagementRefreshAt) < AIRDROP_REFRESH_COOLDOWN_MS
        ) {
          fail(
            'AIRDROP_REFRESH_COOLDOWN',
            'Engagement was refreshed recently. Please wait 15 minutes before refreshing again.',
            429,
          );
        }
        const byId = new Map(updates.map(item => [item.postId, item]));
        current.posts = current.posts.map(post => {
          const refreshed = byId.get(post.postId);
          if (!refreshed) return post;
          return {
            ...post,
            lastRefreshedAt: at,
            metrics: refreshed.metrics,
            engagementScore: refreshed.engagementScore,
          };
        });
        current.lastEngagementRefreshAt = at;
        current.revision++;
        await recomputeAllocationAndLock(tx, current, campaign, at);
        await tx.saveParticipant(current);
        return buildMe(tx, session);
      });
    },

    async adminSummary() {
      return store.transaction(
        async tx => {
          const [campaign, snapshot, reserved, all, merkle] = await Promise.all([
            tx.campaign(),
            tx.snapshotStats(),
            tx.countReservedSlots(),
            tx.allParticipants(),
            tx.publishedMerkleMeta(),
          ]);
          return {
            campaign,
            snapshot,
            reservedSlots: reserved.slots,
            reservedGeneralTokens: reserved.generalTokens,
            totalParticipants: all.length,
            unlockedBoxes: all.filter(p => Boolean(p.boxUnlockedAt)).length,
            boundWallets: all.filter(p => Boolean(p.wallet)).length,
            publishedMerkle: merkle,
          };
        },
        { readOnly: true },
      );
    },

    async configure(value: AirdropCampaign, expectedRevision: number, actor: string) {
      const parsed = airdropCampaignSchema.parse(value);
      if (parsed.claimingOpen && parsed.state !== 'closed') {
        fail('AIRDROP_CONFIG_INVALID', 'Close the mission campaign before opening on-chain claims.');
      }
      let resolvedProjectXId = parsed.projectXId;
      let resolvedProjectHandle = parsed.projectHandle;
      if (parsed.state === 'open') {
        if (!genesisAuth.available()) {
          fail('AIRDROP_AUTH_UNAVAILABLE', 'Configure official X OAuth before opening the airdrop.', 503);
        }
        if (!resolvedProjectHandle) {
          fail('AIRDROP_CONFIG_INVALID', 'Set the official X handle before opening.');
        }
        if (parsed.opensAt && parsed.closesAt && Date.parse(parsed.closesAt) <= Date.parse(parsed.opensAt)) {
          fail('AIRDROP_CONFIG_INVALID', 'Campaign close time must be after open time.');
        }
        try {
          if (!resolvedProjectXId) {
            if (!verifier.resolveUserByHandle) {
              fail('AIRDROP_CONFIG_INVALID', 'Set the official X ID and handle before opening.');
            }
            const resolved = await verifier.resolveUserByHandle(resolvedProjectHandle);
            resolvedProjectXId = resolved.id;
            resolvedProjectHandle = resolved.username;
          } else {
            const actual = await verifier.projectHandle(resolvedProjectXId);
            if (actual.toLowerCase() !== resolvedProjectHandle.toLowerCase()) {
              fail('AIRDROP_PROJECT_MISMATCH', 'The official X ID and handle do not match.');
            }
          }
        } catch (err) {
          if (err instanceof AirdropEvidenceError) {
            fail('AIRDROP_PROJECT_NOT_FOUND', err.message, 400);
          }
          if (err instanceof AirdropProviderUnavailable) {
            fail(
              'AIRDROP_PROVIDER_UNAVAILABLE',
              err.message || 'Could not verify the official X handle right now. Try again shortly.',
              503,
            );
          }
          throw err;
        }
      }
      return store.transaction(async tx => {
        const old = await tx.campaign();
        if (old.revision !== expectedRevision) {
          fail('AIRDROP_REVISION', 'Campaign settings changed. Refresh before saving.');
        }
        const merkle = await tx.publishedMerkleMeta();
        if (parsed.claimingOpen) {
          if (parsed.state !== 'closed') {
            fail('AIRDROP_CONFIG_INVALID', 'Close the mission campaign before opening on-chain claims.');
          }
          if (
            !merkle ||
            !parsed.chainId ||
            !parsed.distributorAddress ||
            merkle.chainId !== parsed.chainId ||
            merkle.distributor.toLowerCase() !== parsed.distributorAddress.toLowerCase()
          ) {
            fail(
              'AIRDROP_MERKLE_REQUIRED',
              'Publish a Merkle root matching the target chain ID and distributor before opening claims.',
            );
          }
        }
        const reserved = await tx.countReservedSlots();
        if (
          reserved.slots > 0 &&
          (old.baseWinnerTokens !== parsed.baseWinnerTokens || old.maxGeneralSlots !== parsed.maxGeneralSlots)
        ) {
          fail('AIRDROP_TERMS_LOCKED', 'Base share and slot cap cannot change after boxes are locked in.');
        }
        const termsChanged = old.projectXId !== resolvedProjectXId || old.projectHandle !== resolvedProjectHandle;
        const next: AirdropCampaign = {
          ...parsed,
          projectXId: resolvedProjectXId,
          projectHandle: resolvedProjectHandle,
          version: old.version + (termsChanged ? 1 : 0),
          revision: old.revision + 1,
        };
        await tx.saveCampaign(next);
        await tx.audit({ at: new Date(now()).toISOString(), actor, action: 'configure_campaign', details: next });
        return next;
      });
    },

    async importSnapshot(input: AirdropSnapshotImportInput, actor: string) {
      const parsed = airdropSnapshotImportSchema.parse(input);
      let entries: { wallet: string; tier: AirdropSnapshotTier; txCount?: number }[];
      if (parsed.entries?.length) {
        entries = parsed.entries;
      } else {
        try {
          entries = parseSnapshotCsv(parsed.csvText!, {
            ...(parsed.defaultTier ? { defaultTier: parsed.defaultTier } : {}),
            ...(parsed.minTxCount !== undefined ? { minTxCount: parsed.minTxCount } : {}),
          });
        } catch (err) {
          fail('AIRDROP_SNAPSHOT_INVALID', (err as Error).message, 400);
        }
      }
      const at = new Date(now()).toISOString();
      return store.transaction(async tx => {
        const campaign = await tx.campaign();
        if (parsed.mode === 'replace' && (campaign.claimingOpen || (await tx.publishedMerkleMeta()))) {
          fail('AIRDROP_CLAIMS_FROZEN', 'Cannot replace the snapshot after final airdrop allocations are published.');
        }
        const result = await tx.importSnapshot(entries, parsed.mode, at);
        await tx.audit({
          at,
          actor,
          action: 'import_snapshot',
          details: { mode: parsed.mode, ...result },
        });
        return result;
      });
    },

    async exportMerkle(input: { chainId: number; distributor: string; publish: boolean }, actor: string) {
      const parsed = airdropMerkleExportSchema.parse(input);
      const at = new Date(now()).toISOString();
      return store.transaction(
        async tx => {
          const campaign = await tx.campaign();
          if (parsed.publish && campaign.claimingOpen) {
            fail('AIRDROP_CLAIMS_ACTIVE', 'Cannot overwrite published Merkle proofs while claiming is open.');
          }
          const ranked = await computeRankings(tx);
          const rawEntries: { wallet: string; amountRaw: bigint; generalTokens: number; top500Tokens: number }[] = [];
          for (const row of ranked.values()) {
            const wallet = row.participant.wallet;
            if (!wallet) continue;
            const totalWhole = row.participant.reservedGeneralTokens + row.projectedTop500Tokens;
            if (totalWhole <= 0) continue;
            rawEntries.push({
              wallet,
              amountRaw: tokensToRaw8(totalWhole),
              generalTokens: row.participant.reservedGeneralTokens,
              top500Tokens: row.projectedTop500Tokens,
            });
          }

          if (parsed.publish && rawEntries.length === 0) {
            fail('AIRDROP_NO_RECIPIENTS', 'There are no eligible unlocked wallets to publish.');
          }

          const totalCommittedRaw = rawEntries.reduce((sum, e) => sum + e.amountRaw, 0n);
          if (totalCommittedRaw > AIRDROP_TOKENOMICS.airdropRaw) {
            fail('AIRDROP_CAP_EXCEEDED', 'Total airdrop commitments exceed 510,000,000 tokens.');
          }

          const tree = buildAirdropMerkleTree(
            rawEntries.map(e => ({ wallet: e.wallet, amountRaw: e.amountRaw })),
            parsed.chainId,
            parsed.distributor as Address,
          );

          if (parsed.publish) {
            const nextDistributor = parsed.distributor.toLowerCase();
            await tx.savePublishedMerkle({
              root: tree.root,
              chainId: parsed.chainId,
              distributor: nextDistributor,
              totalCommittedRaw: tree.totalCommittedRaw.toString(),
              publishedAt: at,
              allocations: tree.proofs,
            });
            if (campaign.chainId !== parsed.chainId || campaign.distributorAddress !== nextDistributor) {
              await tx.saveCampaign({
                ...campaign,
                chainId: parsed.chainId,
                distributorAddress: nextDistributor,
                revision: campaign.revision + 1,
              });
            }
            await tx.audit({
              at,
              actor,
              action: 'publish_merkle',
              details: {
                root: tree.root,
                chainId: parsed.chainId,
                distributor: nextDistributor,
                recipientCount: tree.entries.length,
                totalCommittedRaw: tree.totalCommittedRaw.toString(),
              },
            });
          }

          return {
            root: tree.root,
            chainId: parsed.chainId,
            distributor: parsed.distributor.toLowerCase(),
            recipientCount: tree.entries.length,
            totalCommittedRaw: tree.totalCommittedRaw.toString(),
            published: parsed.publish,
            allocations: tree.proofs,
          };
        },
        { readOnly: !parsed.publish },
      );
    },
  };
}

export const airdropService = createAirdropService({
  webOrigin: () => webOrigin('http://127.0.0.1:3000'),
  layerZeroResolver: process.env.NODE_ENV === 'test' ? null : layerZeroEligibilityResolver,
});
