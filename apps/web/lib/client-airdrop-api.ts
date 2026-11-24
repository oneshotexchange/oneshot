import { z } from 'zod';
import { customerErrorDetails, customerFetch, customerResponseJson } from './customer-http';
import {
  AIRDROP_CONSENT_VERSION,
  type AirdropEligibilityResponse,
  type AirdropLeaderboardEntry,
  type AirdropMeResponse,
  type AirdropPublicCampaign,
} from './airdrop-schema';

const profileSchema = z.object({
  id: z.string().regex(/^\d{1,32}$/),
  username: z.string(),
  name: z.string(),
  avatarUrl: z.string().nullable(),
});

const checkSchema = z.object({
  state: z.enum(['verified', 'needs_action', 'temporarily_unavailable']),
  message: z.string(),
  checkedAt: z.string(),
  evidenceId: z.string().optional(),
  tokenMarket: z.string().optional(),
  volumeNativeRaw: z.string().optional(),
});

const postSchema = z.object({
  postId: z.string(),
  postUrl: z.string(),
  verifiedAt: z.string(),
  lastRefreshedAt: z.string(),
  metrics: z.object({
    likes: z.number(),
    reposts: z.number(),
    replies: z.number(),
    quotes: z.number().optional(),
    bookmarks: z.number().optional(),
    views: z.number(),
  }),
  engagementScore: z.number(),
});

const proofSchema = z.object({
  amountRaw: z.string(),
  proof: z.array(z.string()),
});

const participantSchema = z.object({
  id: z.string().uuid(),
  profile: profileSchema,
  code: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
  createdAt: z.string(),
  revision: z.number().int().positive(),
  wallet: z.string().regex(/^0x[\da-f]{40}$/).nullable(),
  walletBoundAt: z.string().nullable(),
  tier: z.enum(['lz_winner', 'lz_user_5tx', 'community']),
  checks: z.object({
    follow: checkSchema.optional(),
    repost: checkSchema.optional(),
    create_token: checkSchema.optional(),
    trade_token: checkSchema.optional(),
  }),
  posts: z.array(postSchema),
  lastEngagementRefreshAt: z.string().nullable().optional(),
  boxUnlockedAt: z.string().nullable(),
  slotReserved: z.boolean(),
  reservedSlotNumber: z.number().int().nullable(),
  baseGeneralTokens: z.number(),
  engagementBonusTokens: z.number(),
  reservedGeneralTokens: z.number(),
  invitedReferrals: z.number().int().nonnegative(),
  qualifiedReferrals: z.number().int().nonnegative(),
  engagementScore: z.number().nonnegative(),
  engagementBonusBps: z.number().int().nonnegative(),
  totalScore: z.number().nonnegative(),
  requiredComplete: z.boolean(),
  rank: z.number().int().positive().nullable(),
  projectedTop500Tokens: z.number().nonnegative(),
  totalProjectedTokens: z.number().nonnegative(),
  totalProjectedRaw: z.string(),
  boxState: z.enum(['sealed', 'peek_ready', 'charging', 'unlocked']),
  claimProof: proofSchema.nullable(),
});

export const airdropMeSchema = z.object({
  profile: profileSchema.nullable(),
  participant: participantSchema.nullable(),
  referralUrl: z.string().url().nullable(),
});

export const airdropCampaignResponseSchema = z.object({
  state: z.enum(['upcoming', 'open', 'closed']),
  tokenName: z.string(),
  tokenSymbol: z.string(),
  opensAt: z.string().nullable(),
  closesAt: z.string().nullable(),
  projectHandle: z.string().nullable(),
  announcementPostId: z.string().nullable(),
  baseWinnerTokens: z.number(),
  maxGeneralSlots: z.number(),
  reservedSlots: z.number(),
  reservedGeneralTokens: z.number(),
  generalPoolTokens: z.number(),
  top500PoolTokens: z.number(),
  totalAirdropTokens: z.number(),
  openingFdvUsd: z.number(),
  tradeMissionEnabled: z.boolean(),
  minTradeNativeRaw: z.string(),
  chainId: z.number().nullable(),
  distributorAddress: z.string().nullable(),
  tokenAddress: z.string().nullable(),
  marketAddress: z.string().nullable(),
  claimingOpen: z.boolean(),
  claimDeadline: z.string().nullable(),
  snapshotCutoffAt: z.string().nullable().default(null),
  merkleRoot: z.string().nullable(),
  version: z.number(),
});

export const airdropEligibilitySchema = z.object({
  wallet: z.string(),
  tier: z.enum(['lz_winner', 'lz_user_5tx', 'community']),
  eligibleForGeneralPool: z.boolean(),
  eligibleForLeaderboard: z.boolean(),
  baseGeneralTokens: z.number(),
  maxBonusTokens: z.number(),
  maxGeneralTokens: z.number(),
  slotsRemaining: z.number(),
  generalPoolExhausted: z.boolean(),
  txCount: z.number().nullable(),
  proof: proofSchema.nullable(),
});

export const airdropLeaderboardSchema = z.object({
  totalRanked: z.number().int().nonnegative(),
  entries: z.array(
    z.object({
      rank: z.number().int().positive(),
      username: z.string(),
      name: z.string(),
      avatarUrl: z.string().nullable(),
      walletMasked: z.string(),
      tier: z.enum(['lz_winner', 'lz_user_5tx', 'community']),
      postsCount: z.number().int().nonnegative(),
      engagementScore: z.number().nonnegative(),
      qualifiedReferrals: z.number().int().nonnegative(),
      totalScore: z.number().nonnegative(),
      projectedTop500Tokens: z.number().nonnegative(),
      reservedGeneralTokens: z.number().nonnegative(),
    }),
  ),
});

export const airdropWalletChallengeResponseSchema = z.object({
  wallet: z.string().regex(/^0x[\da-f]{40}$/),
  nonce: z.string().regex(/^[a-f0-9]{32}$/),
  expectedRevision: z.number().int().positive(),
  message: z.string().min(1).max(2000),
});

export class AirdropApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'AirdropApiError';
  }
}

export async function airdropRequest<T>(
  path: string,
  options: {
    body?: unknown;
    sessionId?: string | null;
    signal?: AbortSignal;
    schema: z.ZodType<T>;
  },
): Promise<T> {
  const response = await customerFetch('/api/oneshot/airdrop/' + path, {
    method: options.body === undefined ? 'GET' : 'POST',
    cache: 'no-store',
    credentials: 'same-origin',
    redirect: 'error',
    signal: options.signal,
    headers: {
      ...(options.sessionId ? { 'X-Genesis-Session': options.sessionId } : {}),
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const body = await customerResponseJson(response, { signal: options.signal });
  if (!response.ok) {
    const details = customerErrorDetails(body);
    throw new AirdropApiError(
      response.status,
      details.code,
      details.message || 'Could not load airdrop details. Try again.',
    );
  }
  const parsed = options.schema.safeParse(body);
  if (!parsed.success) {
    throw new Error('The airdrop response could not be read. Please refresh.');
  }
  return parsed.data;
}

export const loadAirdropCampaign = (signal?: AbortSignal): Promise<AirdropPublicCampaign> =>
  airdropRequest('campaign', { schema: airdropCampaignResponseSchema, signal });

export const checkWalletEligibility = (wallet: string, signal?: AbortSignal): Promise<AirdropEligibilityResponse> =>
  airdropRequest(`eligibility?wallet=${encodeURIComponent(wallet)}`, { schema: airdropEligibilitySchema, signal });

export const loadAirdropLeaderboard = (
  offset = 0,
  limit = 50,
  signal?: AbortSignal,
): Promise<{ totalRanked: number; entries: AirdropLeaderboardEntry[] }> =>
  airdropRequest(`leaderboard?offset=${offset}&limit=${limit}`, { schema: airdropLeaderboardSchema, signal });

export async function airdropAccountRequest(
  path: string,
  options: {
    body?: unknown;
    sessionId: string | null;
    scope(): string | null;
    signal?: AbortSignal;
  },
): Promise<AirdropMeResponse> {
  const scope = options.scope();
  if (!scope) throw new Error('Connect your X account to continue.');
  const result = await airdropRequest(path, {
    schema: airdropMeSchema,
    sessionId: options.sessionId,
    body: options.body,
    signal: options.signal,
  });
  if (scope !== options.scope()) throw new Error('Your account changed. Please refresh.');
  return result;
}

export async function requestAirdropWalletChallenge(options: {
  wallet: string;
  sessionId: string | null;
  scope(): string | null;
  signal?: AbortSignal;
}) {
  const scope = options.scope();
  if (!scope) throw new Error('Connect your X account to continue.');
  const result = await airdropRequest('wallet-challenge', {
    schema: airdropWalletChallengeResponseSchema,
    sessionId: options.sessionId,
    body: { wallet: options.wallet },
    signal: options.signal,
  });
  if (scope !== options.scope()) throw new Error('Your account changed. Please refresh.');
  return result;
}

export function createAirdropEnrollment() {
  const attempted = new Set<string>();
  const active = new Set<string>();
  return {
    async start(
      input: {
        scope: string | null;
        currentScope(): string | null;
        authReady: boolean;
        verifiedProfileId: string | null;
        campaign: AirdropPublicCampaign | null;
        campaignLoading: boolean;
        campaignError: boolean;
        account: { scope: string; data: AirdropMeResponse } | null;
        accountLoading: boolean;
        accountError: boolean;
        busy: boolean;
        referral: string | null;
        sessionId: string | null;
        onStart(): void;
      },
      retry = false,
    ): Promise<
      | { state: 'skipped' }
      | { state: 'saved'; scope: string; data: AirdropMeResponse }
      | { state: 'stale'; scope: string }
      | { state: 'failed'; scope: string; code?: string; message?: string }
    > {
      const { scope, account, campaign } = input;
      if (
        !scope ||
        input.currentScope() !== scope ||
        !input.authReady ||
        !input.verifiedProfileId ||
        input.campaignLoading ||
        input.campaignError ||
        campaign?.state !== 'open' ||
        input.accountLoading ||
        input.accountError ||
        account?.scope !== scope ||
        !account.data.profile ||
        account.data.profile.id !== input.verifiedProfileId ||
        account.data.participant ||
        input.busy ||
        active.has(scope) ||
        (!retry && attempted.has(scope))
      ) {
        return { state: 'skipped' };
      }
      attempted.add(scope);
      active.add(scope);
      try {
        input.onStart();
        const data = await airdropAccountRequest('enroll', {
          body: {
            consentVersion: AIRDROP_CONSENT_VERSION,
            ...(input.referral ? { referral: input.referral } : {}),
          },
          sessionId: input.sessionId,
          scope: input.currentScope,
        });
        if (!data.participant || data.profile?.id !== input.verifiedProfileId) {
          throw new Error('Could not initialize your airdrop box.');
        }
        return input.currentScope() === scope ? { state: 'saved', scope, data } : { state: 'stale', scope };
      } catch (error) {
        const code = error instanceof AirdropApiError ? error.code : undefined;
        const message = error instanceof Error && error.message ? error.message : undefined;
        if (code === 'AIRDROP_REFERRAL_INVALID' || code === 'AIRDROP_REFERRAL_SELF') {
          attempted.delete(scope);
        }
        return input.currentScope() === scope
          ? { state: 'failed', scope, code, message }
          : { state: 'stale', scope };
      } finally {
        active.delete(scope);
      }
    },
  };
}

const referralKey = 'oneshot.airdrop.invitation';

export type ReferralStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type ReferralStorageInput = ReferralStorage | readonly ReferralStorage[];

export function airdropReferralStorages(): ReferralStorage[] {
  const stores: ReferralStorage[] = [];
  if (typeof window === 'undefined') return stores;
  for (const kind of ['localStorage', 'sessionStorage'] as const) {
    try {
      const store = window[kind];
      if (store) stores.push(store);
    } catch {
      /* Storage access may be unavailable in restricted browser modes. */
    }
  }
  return stores;
}

function toStorageList(storage?: ReferralStorageInput): readonly ReferralStorage[] {
  if (!storage) return [];
  return 'getItem' in storage ? [storage] : storage;
}

export function readAirdropReferral(
  search: string,
  storage?: ReferralStorageInput,
): string | null {
  const stores = toStorageList(storage);
  const value = new URLSearchParams(search).get('ref');
  if (value !== null) {
    if (!/^[A-Za-z0-9_-]{16}$/.test(value)) {
      clearAirdropReferral(storage);
      return null;
    }
    for (const store of stores) {
      try {
        store.setItem(referralKey, value);
      } catch {
        /* URL preserves attribution */
      }
    }
    return value;
  }
  for (const store of stores) {
    try {
      const saved = store.getItem(referralKey);
      if (saved && /^[A-Za-z0-9_-]{16}$/.test(saved)) {
        for (const target of stores) {
          if (target !== store) {
            try {
              if (target.getItem(referralKey) !== saved) target.setItem(referralKey, saved);
            } catch {
              /* Optional sibling storage */
            }
          }
        }
        return saved;
      }
    } catch {
      /* Optional storage */
    }
  }
  return null;
}

export function clearAirdropReferral(storage?: ReferralStorageInput) {
  for (const store of toStorageList(storage)) {
    try {
      store.removeItem(referralKey);
    } catch {
      /* Optional storage */
    }
  }
}
