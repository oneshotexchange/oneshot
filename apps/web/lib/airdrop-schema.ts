import { z } from 'zod';

export const AIRDROP_TOTAL_SUPPLY = 1_000_000_000;
export const AIRDROP_DECIMALS = 8;
export const AIRDROP_GENERAL_POOL = 410_000_000;
export const AIRDROP_TOP500_POOL = 100_000_000;
export const AIRDROP_TOTAL_POOL = 510_000_000;
export const AIRDROP_LIQUIDITY_POOL = 250_000_000;
export const AIRDROP_TEAM_POOL = 100_000_000;
export const AIRDROP_ECOSYSTEM_POOL = 90_000_000;
export const AIRDROP_TREASURY_POOL = 50_000_000;
export const AIRDROP_GENERAL_SLOT_CAP = 10_000;
export const AIRDROP_DEFAULT_WINNER_TOKENS = 40_000;
export const AIRDROP_MAX_POSTS = 5;
export const AIRDROP_MAX_ENGAGEMENT_BONUS_BPS = 5000;
export const AIRDROP_FDV_USD = 960_000;
export const AIRDROP_LOCK_DAYS = 7;
export const AIRDROP_UNLOCK_DAYS = 7;
export const AIRDROP_TEAM_DAYS = 730;
export const AIRDROP_REFRESH_COOLDOWN_MS = 15 * 60 * 1000;
export const AIRDROP_DEFAULT_SNAPSHOT_CUTOFF = '2026-11-23T00:00:00.000Z';
export const AIRDROP_CONSENT_VERSION = '2026-11-23';

export const AIRDROP_TOP500_BRACKETS = [
  { label: 'Ranks #1 – #10', minRank: 1, maxRank: 10, count: 10, perUserTokens: 1_500_000, subtotalTokens: 15_000_000 },
  { label: 'Ranks #11 – #50', minRank: 11, maxRank: 50, count: 40, perUserTokens: 500_000, subtotalTokens: 20_000_000 },
  { label: 'Ranks #51 – #150', minRank: 51, maxRank: 150, count: 100, perUserTokens: 250_000, subtotalTokens: 25_000_000 },
  { label: 'Ranks #151 – #400', minRank: 151, maxRank: 400, count: 250, perUserTokens: 120_000, subtotalTokens: 30_000_000 },
  { label: 'Ranks #401 – #500', minRank: 401, maxRank: 500, count: 100, perUserTokens: 100_000, subtotalTokens: 10_000_000 },
] as const;

export const airdropEvmAddress = z
  .string()
  .regex(/^0x[\da-fA-F]{40}$/)
  .transform(value => value.toLowerCase())
  .refine(value => !/^0x0{40}$/.test(value), 'Must be a nonzero EVM address.');

export const airdropOptionalAddress = z
  .string()
  .regex(/^0x[\da-fA-F]{40}$/)
  .transform(value => value.toLowerCase())
  .refine(value => !/^0x0{40}$/.test(value))
  .nullable();

export const airdropTierSchema = z.enum(['lz_winner', 'lz_user_5tx', 'community']);
export type AirdropTier = z.infer<typeof airdropTierSchema>;

export const airdropSnapshotTierSchema = z.enum(['lz_winner', 'lz_user_5tx']);
export type AirdropSnapshotTier = z.infer<typeof airdropSnapshotTierSchema>;

export const airdropMissionTaskSchema = z.enum(['follow', 'repost', 'post', 'create_token', 'trade_token']);
export type AirdropMissionTask = z.infer<typeof airdropMissionTaskSchema>;

export type AirdropXProfile = {
  id: string;
  username: string;
  name: string;
  avatarUrl: string | null;
};

export type AirdropPostMetrics = {
  likes: number;
  reposts: number;
  replies: number;
  views: number;
};

export type AirdropVerifiedPost = {
  postId: string;
  postUrl: string;
  verifiedAt: string;
  lastRefreshedAt: string;
  metrics: AirdropPostMetrics;
  engagementScore: number;
};

export type AirdropCheckResult = {
  state: 'verified' | 'needs_action' | 'temporarily_unavailable';
  message: string;
  checkedAt: string;
  evidenceId?: string;
};

export const airdropCampaignSchema = z.object({
  revision: z.number().int().positive().default(1),
  version: z.number().int().positive().default(1),
  state: z.enum(['upcoming', 'open', 'closed']).default('upcoming'),
  opensAt: z.string().datetime().nullable().default(null),
  closesAt: z.string().datetime().nullable().default(null),
  tokenName: z.string().trim().min(1).max(64).default('oneshot'),
  tokenSymbol: z.string().trim().min(1).max(16).default('ONE'),
  projectXId: z.string().regex(/^\d{1,32}$/).or(z.literal('')).default(''),
  projectHandle: z.string().regex(/^[A-Za-z0-9_]{1,15}$/).or(z.literal('')).default(''),
  announcementPostId: z.string().regex(/^\d{1,32}$/).or(z.literal('')).default(''),
  baseWinnerTokens: z.number().int().min(1_000).max(500_000).default(AIRDROP_DEFAULT_WINNER_TOKENS),
  maxGeneralSlots: z.number().int().min(1).max(AIRDROP_GENERAL_SLOT_CAP).default(AIRDROP_GENERAL_SLOT_CAP),
  dailyReadLimit: z.number().int().min(0).max(200_000).default(5000),
  tradeMissionEnabled: z.boolean().default(false),
  minTradeNativeRaw: z.string().regex(/^(0|[1-9]\d{0,38})$/).default('10000000000000000'),
  chainId: z.number().int().positive().nullable().default(null),
  distributorAddress: airdropOptionalAddress.default(null),
  tokenAddress: airdropOptionalAddress.default(null),
  marketAddress: airdropOptionalAddress.default(null),
  teamVestingAddress: airdropOptionalAddress.default(null),
  claimingOpen: z.boolean().default(false),
  claimDeadline: z.string().datetime().nullable().default(null),
  snapshotCutoffAt: z.string().datetime().nullable().default(AIRDROP_DEFAULT_SNAPSHOT_CUTOFF),
  liveLayerZeroLookup: z.boolean().default(true),
}).strict();
export type AirdropCampaign = z.infer<typeof airdropCampaignSchema>;

export type AirdropPublicCampaign = {
  state: 'upcoming' | 'open' | 'closed';
  tokenName: string;
  tokenSymbol: string;
  opensAt: string | null;
  closesAt: string | null;
  projectHandle: string | null;
  announcementPostId: string | null;
  baseWinnerTokens: number;
  maxGeneralSlots: number;
  reservedSlots: number;
  reservedGeneralTokens: number;
  generalPoolTokens: number;
  top500PoolTokens: number;
  totalAirdropTokens: number;
  openingFdvUsd: number;
  tradeMissionEnabled: boolean;
  minTradeNativeRaw: string;
  chainId: number | null;
  distributorAddress: string | null;
  tokenAddress: string | null;
  marketAddress: string | null;
  claimingOpen: boolean;
  claimDeadline: string | null;
  snapshotCutoffAt: string | null;
  merkleRoot: string | null;
  version: number;
};

export type AirdropSnapshotEntry = {
  wallet: string;
  tier: AirdropSnapshotTier;
  txCount?: number;
  importedAt: string;
};

export type AirdropPublishedProof = {
  amountRaw: string;
  proof: string[];
};

export type AirdropPublishedMerkle = {
  root: string;
  chainId: number;
  distributor: string;
  totalCommittedRaw: string;
  publishedAt: string;
  allocations: Record<string, AirdropPublishedProof>;
};

export type AirdropParticipant = {
  id: string;
  userId: string;
  profile: AirdropXProfile;
  code: string;
  referrerId: string | null;
  createdAt: string;
  revision: number;
  wallet: string | null;
  walletBoundAt: string | null;
  walletChallengeNonce: string | null;
  tier: AirdropTier;
  checks: {
    follow?: AirdropCheckResult;
    repost?: AirdropCheckResult;
    create_token?: AirdropCheckResult & { tokenMarket?: string };
    trade_token?: AirdropCheckResult & { volumeNativeRaw?: string };
  };
  posts: AirdropVerifiedPost[];
  lastEngagementRefreshAt?: string | null;
  boxUnlockedAt: string | null;
  slotReserved: boolean;
  reservedSlotNumber: number | null;
  baseGeneralTokens: number;
  engagementBonusTokens: number;
  reservedGeneralTokens: number;
  consentVersion: string;
};

export type AirdropParticipantSummary = Omit<
  AirdropParticipant,
  'userId' | 'referrerId' | 'walletChallengeNonce' | 'consentVersion'
> & {
  qualifiedReferrals: number;
  engagementScore: number;
  engagementBonusBps: number;
  totalScore: number;
  requiredComplete: boolean;
  rank: number | null;
  projectedTop500Tokens: number;
  totalProjectedTokens: number;
  totalProjectedRaw: string;
  boxState: 'sealed' | 'peek_ready' | 'charging' | 'unlocked';
  claimProof: AirdropPublishedProof | null;
};

export type AirdropMeResponse = {
  profile: AirdropXProfile | null;
  participant: AirdropParticipantSummary | null;
  referralUrl: string | null;
};

export type AirdropEligibilityResponse = {
  wallet: string;
  tier: AirdropTier;
  eligibleForGeneralPool: boolean;
  eligibleForLeaderboard: boolean;
  baseGeneralTokens: number;
  maxBonusTokens: number;
  maxGeneralTokens: number;
  slotsRemaining: number;
  generalPoolExhausted: boolean;
  txCount: number | null;
  proof: AirdropPublishedProof | null;
};

export type AirdropLeaderboardEntry = {
  rank: number;
  username: string;
  name: string;
  avatarUrl: string | null;
  walletMasked: string;
  tier: AirdropTier;
  postsCount: number;
  engagementScore: number;
  qualifiedReferrals: number;
  totalScore: number;
  projectedTop500Tokens: number;
  reservedGeneralTokens: number;
};

export const airdropEnrollSchema = z.object({
  consentVersion: z.literal(AIRDROP_CONSENT_VERSION),
  referral: z.string().regex(/^[A-Za-z0-9_-]{16}$/).optional(),
}).strict();

export const airdropWalletChallengeSchema = z.object({
  wallet: airdropEvmAddress,
}).strict();

export const airdropWalletBindSchema = z.object({
  wallet: airdropEvmAddress,
  signature: z.string().regex(/^0x[\da-fA-F]{130}$/),
  expectedRevision: z.number().int().positive(),
}).strict();

export const airdropVerifySchema = z.object({
  task: airdropMissionTaskSchema,
  postUrl: z.string().max(512).optional(),
}).strict();

export const airdropSnapshotRowSchema = z.object({
  wallet: airdropEvmAddress,
  tier: airdropSnapshotTierSchema,
  txCount: z.number().int().min(0).max(1_000_000).optional(),
}).strict();

export const airdropSnapshotImportSchema = z.object({
  mode: z.enum(['merge', 'replace']).default('merge'),
  entries: z.array(airdropSnapshotRowSchema).min(1).max(25_000).optional(),
  csvText: z.string().min(1).max(2_000_000).optional(),
  defaultTier: airdropSnapshotTierSchema.optional(),
  minTxCount: z.number().int().min(0).max(1_000_000).optional(),
}).strict().refine(value => Boolean(value.entries?.length || value.csvText), {
  message: 'Provide snapshot entries or CSV text.',
});
export type AirdropSnapshotImportInput = z.input<typeof airdropSnapshotImportSchema>;

export const airdropMerkleExportSchema = z.object({
  chainId: z.number().int().positive(),
  distributor: airdropEvmAddress,
  publish: z.boolean().default(false),
}).strict();

export function airdropWalletBindMessage(input: {
  origin: string;
  participantId: string;
  xId: string;
  wallet: string;
  nonce: string;
}): string {
  return [
    'oneshot Airdrop wallet confirmation',
    `Origin: ${input.origin}`,
    `Participant: ${input.participantId}`,
    `X ID: ${input.xId}`,
    `Wallet: ${input.wallet.toLowerCase()}`,
    `Nonce: ${input.nonce}`,
  ].join('\n');
}

export function airdropPostId(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      !['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname)
    ) {
      return null;
    }
    return /^\/(?:[A-Za-z0-9_]{1,15}|i\/web)\/status\/(\d{1,32})\/?$/.exec(url.pathname)?.[1] || null;
  } catch {
    return null;
  }
}

export function computeBaseGeneralTokens(tier: AirdropTier, baseWinnerTokens = AIRDROP_DEFAULT_WINNER_TOKENS): number {
  if (tier === 'lz_winner') return baseWinnerTokens;
  if (tier === 'lz_user_5tx') return Math.floor(baseWinnerTokens / 2);
  return 0;
}

export function computePostEngagementScore(metrics: Partial<AirdropPostMetrics> | null | undefined): number {
  if (!metrics) return 0;
  const likes = Math.max(0, Math.floor(metrics.likes ?? 0));
  const reposts = Math.max(0, Math.floor(metrics.reposts ?? 0));
  const replies = Math.max(0, Math.floor(metrics.replies ?? 0));
  const views = Math.max(0, Math.floor(metrics.views ?? 0));
  return likes * 2 + reposts * 4 + replies * 3 + Math.floor(views / 100);
}

export function computeEngagementBonusBps(totalEngagementScore: number): number {
  if (!Number.isFinite(totalEngagementScore) || totalEngagementScore <= 0) return 0;
  return Math.min(AIRDROP_MAX_ENGAGEMENT_BONUS_BPS, Math.floor(totalEngagementScore * 5));
}

export function computeTop500RewardForRank(rank: number | null): number {
  if (!rank || !Number.isInteger(rank) || rank < 1 || rank > 500) return 0;
  for (const bracket of AIRDROP_TOP500_BRACKETS) {
    if (rank >= bracket.minRank && rank <= bracket.maxRank) return bracket.perUserTokens;
  }
  return 0;
}

export function requiredMissionsComplete(
  participant: Pick<AirdropParticipant, 'wallet' | 'checks' | 'posts'>,
): boolean {
  return Boolean(
    participant.wallet &&
      participant.checks.follow?.state === 'verified' &&
      participant.checks.repost?.state === 'verified' &&
      participant.posts.length >= 1 &&
      participant.checks.create_token?.state === 'verified',
  );
}

export function computeRequiredProgressCount(
  participant: Pick<AirdropParticipant, 'checks' | 'posts'>,
): number {
  let count = 0;
  if (participant.checks.follow?.state === 'verified') count++;
  if (participant.checks.repost?.state === 'verified') count++;
  if (participant.posts.length >= 1) count++;
  if (participant.checks.create_token?.state === 'verified') count++;
  return count;
}

export function computeParticipantEngagementScore(
  participant: Pick<AirdropParticipant, 'posts'>,
): number {
  return participant.posts
    .slice(0, AIRDROP_MAX_POSTS)
    .reduce((sum, post) => sum + Math.max(0, Math.floor(post.engagementScore)), 0);
}

export function computeParticipantScore(
  participant: Pick<AirdropParticipant, 'checks' | 'posts' | 'tier'>,
  qualifiedReferrals: number,
): number {
  let score = 0;
  if (participant.checks.follow?.state === 'verified') score += 50;
  if (participant.checks.repost?.state === 'verified') score += 50;
  if (participant.checks.create_token?.state === 'verified') score += 200;
  if (participant.checks.trade_token?.state === 'verified') score += 150;
  score += Math.min(AIRDROP_MAX_POSTS, participant.posts.length) * 100;
  score += computeParticipantEngagementScore(participant);
  score += Math.max(0, Math.floor(qualifiedReferrals)) * 150;
  if (participant.tier === 'lz_winner') score += 100;
  else if (participant.tier === 'lz_user_5tx') score += 50;
  return score;
}

export function tokensToRaw8(wholeTokens: number): bigint {
  if (!Number.isSafeInteger(wholeTokens) || wholeTokens < 0) {
    throw new Error('Token amount must be a non-negative integer.');
  }
  return BigInt(wholeTokens) * 100_000_000n;
}

export function maskWallet(wallet: string): string {
  return /^0x[\da-fA-F]{40}$/.test(wallet) ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : 'Unbound';
}

export type SnapshotCsvColumnMap = {
  walletIdx: number;
  tierIdx: number;
  txCountIdx: number;
  eligibleIdx: number;
  allocationIdx: number;
  hasHeader: boolean;
};

export type SnapshotCsvOptions = {
  defaultTier?: AirdropSnapshotTier;
  minTxCount?: number;
  maxRows?: number;
};

export function splitSnapshotCsvLine(line: string): string[] {
  const clean = line.replace(/^\uFEFF/, '').trim();
  if (!clean) return [];
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i]!;
    if (ch === '"') {
      if (inQuotes && clean[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (!inQuotes && (ch === ',' || ch === '\t' || ch === ';')) {
      fields.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  fields.push(current.trim());
  return fields;
}

const HEADER_WALLET = new Set(['wallet', 'address', 'evmaddress', 'useraddress', 'sender', 'recipient', 'account', 'user']);
const HEADER_TIER = new Set(['tier', 'category', 'group', 'share']);
const HEADER_TX_COUNT = new Set(['txcount', 'transactions', 'txs', 'messagecount', 'messages', 'count', 'tx']);
const HEADER_ELIGIBLE = new Set(['iseligible', 'eligible']);
const HEADER_ALLOCATION = new Set([
  'zroallocation',
  'allocation',
  'amount',
  'totalzro',
  'zro',
  'reward',
  'formattedamount',
]);

export function detectSnapshotCsvHeader(line: string): SnapshotCsvColumnMap | null {
  const clean = line.replace(/^\uFEFF/, '').trim();
  if (!clean || clean.startsWith('#')) return null;
  const cols = splitSnapshotCsvLine(clean);
  if (!cols.length) return null;
  if (cols.some(c => /^0x[\da-fA-F]{8,}$/.test(c))) return null;

  const norm = cols.map(c => c.toLowerCase().replace(/[\s_-]+/g, ''));
  const walletIdx = norm.findIndex(c => HEADER_WALLET.has(c));
  if (walletIdx === -1) return null;

  return {
    walletIdx,
    tierIdx: norm.findIndex(c => HEADER_TIER.has(c)),
    txCountIdx: norm.findIndex(c => HEADER_TX_COUNT.has(c)),
    eligibleIdx: norm.findIndex(c => HEADER_ELIGIBLE.has(c)),
    allocationIdx: norm.findIndex(c => HEADER_ALLOCATION.has(c)),
    hasHeader: true,
  };
}

function parseSnapshotTierToken(raw: string): AirdropSnapshotTier | null {
  const value = raw.trim().toLowerCase();
  if (value === 'lz_winner' || value === 'winner' || value === '100' || value === '100%') return 'lz_winner';
  if (value === 'lz_user_5tx' || value === '5tx' || value === '50' || value === '50%') return 'lz_user_5tx';
  return null;
}

export function parseSnapshotCsvRow(
  line: string,
  lineNumber: number,
  columns: SnapshotCsvColumnMap | null,
  options: SnapshotCsvOptions = {},
): { status: 'row'; entry: { wallet: string; tier: AirdropSnapshotTier; txCount?: number } } | { status: 'skip' } {
  const trimmed = line.replace(/^\uFEFF/, '').trim();
  if (!trimmed || trimmed.startsWith('#')) return { status: 'skip' };
  if (columns && lineNumber > 1 && detectSnapshotCsvHeader(trimmed)) return { status: 'skip' };

  const rawCols = splitSnapshotCsvLine(trimmed);
  if (!rawCols.length) return { status: 'skip' };

  const rawWallet = columns ? rawCols[columns.walletIdx] || '' : rawCols[0] || '';
  const parsedWallet = airdropEvmAddress.safeParse(rawWallet);
  if (!parsedWallet.success) {
    throw new Error(`Invalid wallet address on snapshot row ${lineNumber}.`);
  }

  let txCount: number | undefined;
  let tier: AirdropSnapshotTier | null = null;

  if (columns) {
    if (columns.eligibleIdx >= 0) {
      const elig = (rawCols[columns.eligibleIdx] || '').trim().toLowerCase();
      if (['false', '0', 'no', 'n', 'ineligible'].includes(elig)) return { status: 'skip' };
      if (elig && !['true', '1', 'yes', 'y', 'eligible'].includes(elig)) {
        throw new Error(`Invalid eligibility value "${rawCols[columns.eligibleIdx]}" on snapshot row ${lineNumber}.`);
      }
    }

    if (columns.allocationIdx >= 0) {
      const allocRaw = (rawCols[columns.allocationIdx] || '').replace(/,/g, '').trim();
      if (!allocRaw) return { status: 'skip' };
      const numeric = Number(allocRaw);
      if (!Number.isFinite(numeric)) {
        throw new Error(`Invalid allocation value "${rawCols[columns.allocationIdx]}" on snapshot row ${lineNumber}.`);
      }
      if (numeric <= 0) return { status: 'skip' };
    }

    if (columns.txCountIdx >= 0) {
      const rawTx = (rawCols[columns.txCountIdx] || '').trim();
      if (rawTx) {
        if (!/^\d{1,7}$/.test(rawTx)) {
          throw new Error(`Invalid txCount on snapshot row ${lineNumber}.`);
        }
        txCount = Number(rawTx);
      }
    }

    if (columns.tierIdx >= 0) {
      const rawTier = (rawCols[columns.tierIdx] || '').trim();
      if (rawTier) {
        const parsedTier = parseSnapshotTierToken(rawTier);
        if (!parsedTier) {
          throw new Error(`Invalid tier "${rawTier}" on snapshot row ${lineNumber}. Use lz_winner or lz_user_5tx.`);
        }
        tier = parsedTier;
      }
    }

    if (!tier) {
      if (columns.allocationIdx >= 0) {
        tier = options.defaultTier ?? 'lz_winner';
      } else if (columns.txCountIdx >= 0) {
        const minTx = options.minTxCount ?? 5;
        if (txCount !== undefined && txCount < minTx) return { status: 'skip' };
        tier = options.defaultTier ?? 'lz_user_5tx';
      } else if (options.defaultTier) {
        tier = options.defaultTier;
      } else {
        throw new Error(`Snapshot row ${lineNumber} must include wallet and tier, or select a default tier.`);
      }
    }
  } else {
    const cols = rawCols.filter(Boolean);
    if (cols.length === 1) {
      if (!options.defaultTier) {
        throw new Error(`Snapshot row ${lineNumber} must include wallet and tier, or select a default tier.`);
      }
      tier = options.defaultTier;
    } else {
      const explicitTier = parseSnapshotTierToken(cols[1]!);
      if (explicitTier) {
        tier = explicitTier;
        if (cols[2] !== undefined) {
          if (!/^\d{1,7}$/.test(cols[2])) {
            throw new Error(`Invalid txCount on snapshot row ${lineNumber}.`);
          }
          txCount = Number(cols[2]);
        }
      } else if (cols.length === 2 && /^\d{1,7}$/.test(cols[1]!)) {
        txCount = Number(cols[1]!);
        const minTx = options.minTxCount ?? 5;
        if (txCount < minTx) return { status: 'skip' };
        tier = options.defaultTier ?? 'lz_user_5tx';
      } else {
        throw new Error(`Invalid tier "${cols[1]}" on snapshot row ${lineNumber}. Use lz_winner or lz_user_5tx.`);
      }
    }
  }

  return {
    status: 'row',
    entry: {
      wallet: parsedWallet.data,
      tier,
      ...(txCount !== undefined ? { txCount } : {}),
    },
  };
}

export function parseSnapshotCsv(
  csvText: string,
  options: SnapshotCsvOptions = {},
): { wallet: string; tier: AirdropSnapshotTier; txCount?: number }[] {
  const maxRows = options.maxRows ?? 25_000;
  const lines = csvText.split(/\r?\n/);
  const dedup = new Map<string, { wallet: string; tier: AirdropSnapshotTier; txCount?: number }>();

  let columns: SnapshotCsvColumnMap | null = null;
  let inspectedFirstLine = false;

  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index]!;
    const clean = raw.replace(/^\uFEFF/, '').trim();
    if (!clean || clean.startsWith('#')) continue;

    if (!inspectedFirstLine) {
      inspectedFirstLine = true;
      columns = detectSnapshotCsvHeader(clean);
      if (columns) continue;
    }

    const parsed = parseSnapshotCsvRow(clean, index + 1, columns, options);
    if (parsed.status === 'skip') continue;

    const { wallet, tier, txCount } = parsed.entry;
    const prev = dedup.get(wallet);
    if (!prev) {
      dedup.set(wallet, parsed.entry);
    } else {
      const nextTier: AirdropSnapshotTier =
        prev.tier === 'lz_winner' || tier === 'lz_winner' ? 'lz_winner' : 'lz_user_5tx';
      const maxTx = Math.max(prev.txCount ?? 0, txCount ?? 0);
      dedup.set(wallet, {
        wallet,
        tier: nextTier,
        ...(prev.txCount !== undefined || txCount !== undefined ? { txCount: maxTx } : {}),
      });
    }
    if (dedup.size > maxRows) {
      throw new Error(`Import at most ${maxRows.toLocaleString()} wallets per batch.`);
    }
  }

  const rows = [...dedup.values()];
  if (!rows.length) throw new Error('Snapshot CSV contains no valid wallet rows.');
  return rows;
}
