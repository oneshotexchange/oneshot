import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { database, withLocalNamespace } from './store';
import { ApiError } from './errors';
import type { GenesisProfile } from '../../../web/lib/genesis-schema';
import type { AirdropParticipant, AirdropSnapshotEntry } from '../../../web/lib/airdrop-schema';

export type AnalyticsMetric =
  | 'connect_x_started'
  | 'connect_x_succeeded'
  | 'connect_x_failed'
  | 'eligibility_checks'
  | 'eligibility_lz_winner'
  | 'eligibility_lz_user_5tx'
  | 'eligibility_community'
  | 'airdrop_enrolled'
  | 'wallet_linked'
  | 'mission_follow_verified'
  | 'mission_repost_verified'
  | 'mission_post_verified'
  | 'mission_create_token_verified'
  | 'mission_trade_token_verified';

export type AdminAnalyticsSummary = {
  generatedAt: string;
  days: number;
  traffic: {
    uniqueVisitors: number;
    returningVisitors: number;
    totalPageViews: number;
    todayUniqueVisitors: number;
    todayPageViews: number;
    last7dUniqueVisitors: number;
    last7dPageViews: number;
    topPages: Array<{ path: string; totalViews: number; todayViews: number }>;
  };
  xAuth: {
    uniqueConnectedXAccounts: number;
    activeXSessions: number;
    connectXStarted: number;
    connectXSucceeded: number;
    connectXFailed: number;
    todayConnectXStarted: number;
    todayConnectXSucceeded: number;
    todayConnectXFailed: number;
  };
  eligibility: {
    totalChecks: number;
    todayChecks: number;
    byTier: {
      lzWinner: number;
      lzUser5tx: number;
      community: number;
    };
  };
  airdropFunnel: {
    totalParticipants: number;
    boundWallets: number;
    unlockedBoxes: number;
    reservedSlots: number;
    tiers: {
      lzWinner: number;
      lzUser5tx: number;
      community: number;
    };
    missions: {
      followVerified: number;
      repostVerified: number;
      postsVerifiedUsers: number;
      totalVerifiedPosts: number;
      totalEngagementScore: number;
      createTokenVerified: number;
      tradeTokenVerified: number;
    };
    referrals: {
      totalInvited: number;
      totalQualified: number;
      activeReferrers: number;
    };
    snapshot: {
      total: number;
      winners: number;
      fiveTx: number;
    };
    recentParticipants: Array<{
      username: string;
      name: string;
      avatarUrl: string | null;
      tier: string;
      walletBound: boolean;
      followVerified: boolean;
      repostVerified: boolean;
      postsCount: number;
      createdAt: string;
    }>;
  };
  daily: Array<{
    day: string;
    uniqueVisitors: number;
    pageViews: number;
    connectXStarted: number;
    connectXSucceeded: number;
    connectXFailed: number;
    eligibilityChecks: number;
    airdropEnrolled: number;
    walletLinked: number;
    missionsVerified: number;
  }>;
};

export interface AnalyticsStore {
  recordVisit(visitorId: string, rawPath: string, nowMs?: number): Promise<{ recorded: boolean; path: string | null }>;
  recordEvent(metric: AnalyticsMetric, delta?: number, nowMs?: number): Promise<void>;
  getSummary(days?: number, nowMs?: number): Promise<AdminAnalyticsSummary>;
}

const VISITOR_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const PAGE_METRIC_PREFIX = 'page_views:';
const MS_PER_DAY = 86_400_000;

export function hashVisitorId(visitorId: string): string {
  return createHash('sha256').update(visitorId).digest('hex');
}

export function utcDay(nowMs = Date.now()): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** Map client routes to a bounded allowlist so analytics cardinality never grows unbounded. */
export function normalizeAnalyticsPath(rawPath: string): string | null {
  const withoutQuery = rawPath.split('#')[0]!.split('?')[0]!.trim().toLowerCase();
  if (!withoutQuery.startsWith('/')) return null;
  const trimmed = withoutQuery.length > 1 ? withoutQuery.replace(/\/+$/, '') : withoutQuery;
  if (trimmed === '/admin' || trimmed.startsWith('/admin/')) return null;
  if (trimmed === '/' || trimmed === '') return '/';
  if (trimmed === '/airdrop' || trimmed === '/whitelist') return '/airdrop';
  if (trimmed === '/tokens/new') return '/tokens/new';
  if (trimmed === '/tokens' || trimmed.startsWith('/tokens/')) return '/tokens';
  if (trimmed === '/nfts/new') return '/nfts/new';
  if (trimmed === '/nfts/import') return '/nfts/import';
  if (trimmed === '/nfts/reviewed' || trimmed.startsWith('/nfts/reviewed/')) return '/nfts/reviewed';
  if (trimmed === '/nfts/cart') return '/nfts/cart';
  if (trimmed === '/nfts' || trimmed.startsWith('/nfts/')) return '/nfts';
  if (trimmed === '/portfolio') return '/portfolio';
  if (trimmed === '/activity') return '/activity';
  if (trimmed === '/settings' || trimmed.startsWith('/settings/')) return '/settings';
  if (trimmed.startsWith('/profile/')) return '/profile';
  return '/other';
}

function clampDays(days?: number): number {
  if (!days || !Number.isFinite(days)) return 14;
  return Math.max(1, Math.min(90, Math.floor(days)));
}

function buildDayWindow(days: number, nowMs: number): string[] {
  const list: string[] = [];
  for (let offset = days - 1; offset >= 0; offset--) {
    list.push(utcDay(nowMs - offset * MS_PER_DAY));
  }
  return list;
}

function missionMetricSum(byMetric: Map<string, number> | undefined): number {
  if (!byMetric) return 0;
  return (
    (byMetric.get('mission_follow_verified') ?? 0) +
    (byMetric.get('mission_repost_verified') ?? 0) +
    (byMetric.get('mission_post_verified') ?? 0) +
    (byMetric.get('mission_create_token_verified') ?? 0) +
    (byMetric.get('mission_trade_token_verified') ?? 0)
  );
}

function assembleSummary(input: {
  days: number;
  nowMs: number;
  uniqueVisitors: number;
  returningVisitors: number;
  last7dUniqueVisitors: number;
  dailyUniqueVisitors: Map<string, number>;
  allTimeMetrics: Map<string, number>;
  dailyMetrics: Map<string, Map<string, number>>;
  xAuth: { uniqueConnectedXAccounts: number; activeXSessions: number };
  airdropFunnel: AdminAnalyticsSummary['airdropFunnel'];
}): AdminAnalyticsSummary {
  const { days, nowMs } = input;
  const today = utcDay(nowMs);
  const last7Days = new Set(buildDayWindow(7, nowMs));
  const dayWindow = buildDayWindow(days, nowMs);

  const todayMetrics = input.dailyMetrics.get(today);
  let last7dPageViews = 0;
  for (const day of last7Days) {
    last7dPageViews += input.dailyMetrics.get(day)?.get('page_views') ?? 0;
  }

  const topPages: Array<{ path: string; totalViews: number; todayViews: number }> = [];
  for (const [metric, totalViews] of input.allTimeMetrics.entries()) {
    if (!metric.startsWith(PAGE_METRIC_PREFIX)) continue;
    const path = metric.slice(PAGE_METRIC_PREFIX.length);
    topPages.push({
      path,
      totalViews,
      todayViews: todayMetrics?.get(metric) ?? 0,
    });
  }
  topPages.sort((a, b) => b.totalViews - a.totalViews || a.path.localeCompare(b.path));

  const daily = dayWindow.map(day => {
    const m = input.dailyMetrics.get(day);
    return {
      day,
      uniqueVisitors: input.dailyUniqueVisitors.get(day) ?? 0,
      pageViews: m?.get('page_views') ?? 0,
      connectXStarted: m?.get('connect_x_started') ?? 0,
      connectXSucceeded: m?.get('connect_x_succeeded') ?? 0,
      connectXFailed: m?.get('connect_x_failed') ?? 0,
      eligibilityChecks: m?.get('eligibility_checks') ?? 0,
      airdropEnrolled: m?.get('airdrop_enrolled') ?? 0,
      walletLinked: m?.get('wallet_linked') ?? 0,
      missionsVerified: missionMetricSum(m),
    };
  });

  return {
    generatedAt: new Date(nowMs).toISOString(),
    days,
    traffic: {
      uniqueVisitors: input.uniqueVisitors,
      returningVisitors: input.returningVisitors,
      totalPageViews: input.allTimeMetrics.get('page_views') ?? 0,
      todayUniqueVisitors: input.dailyUniqueVisitors.get(today) ?? 0,
      todayPageViews: todayMetrics?.get('page_views') ?? 0,
      last7dUniqueVisitors: input.last7dUniqueVisitors,
      last7dPageViews,
      topPages,
    },
    xAuth: {
      uniqueConnectedXAccounts: input.xAuth.uniqueConnectedXAccounts,
      activeXSessions: input.xAuth.activeXSessions,
      connectXStarted: input.allTimeMetrics.get('connect_x_started') ?? 0,
      connectXSucceeded: input.allTimeMetrics.get('connect_x_succeeded') ?? 0,
      connectXFailed: input.allTimeMetrics.get('connect_x_failed') ?? 0,
      todayConnectXStarted: todayMetrics?.get('connect_x_started') ?? 0,
      todayConnectXSucceeded: todayMetrics?.get('connect_x_succeeded') ?? 0,
      todayConnectXFailed: todayMetrics?.get('connect_x_failed') ?? 0,
    },
    eligibility: {
      totalChecks: input.allTimeMetrics.get('eligibility_checks') ?? 0,
      todayChecks: todayMetrics?.get('eligibility_checks') ?? 0,
      byTier: {
        lzWinner: input.allTimeMetrics.get('eligibility_lz_winner') ?? 0,
        lzUser5tx: input.allTimeMetrics.get('eligibility_lz_user_5tx') ?? 0,
        community: input.allTimeMetrics.get('eligibility_community') ?? 0,
      },
    },
    airdropFunnel: input.airdropFunnel,
    daily,
  };
}

export type LocalAnalyticsState = {
  visitors: Record<string, { firstSeenAt: string; lastSeenAt: string; firstPath: string; visits: number }>;
  dailyVisitors: Record<string, string[]>;
  daily: Record<string, Record<string, number>>;
};

export function freshAnalyticsState(): LocalAnalyticsState {
  return { visitors: {}, dailyVisitors: {}, daily: {} };
}

function bumpLocalMetric(state: LocalAnalyticsState, day: string, metric: string, delta: number) {
  const bucket = (state.daily[day] ||= {});
  bucket[metric] = (bucket[metric] || 0) + delta;
}

function recordVisitInState(
  state: LocalAnalyticsState,
  visitorId: string,
  rawPath: string,
  nowMs: number,
): { recorded: boolean; path: string | null } {
  if (!VISITOR_ID_PATTERN.test(visitorId)) {
    throw new ApiError(400, 'INVALID_INPUT', 'Invalid visitor identifier.');
  }
  const path = normalizeAnalyticsPath(rawPath);
  if (!path) return { recorded: false, path: null };

  const hash = hashVisitorId(visitorId);
  const day = utcDay(nowMs);
  const nowIso = new Date(nowMs).toISOString();

  const existing = state.visitors[hash];
  if (!existing) {
    state.visitors[hash] = {
      firstSeenAt: nowIso,
      lastSeenAt: nowIso,
      firstPath: path,
      visits: 1,
    };
  } else {
    existing.lastSeenAt = nowIso;
    existing.visits += 1;
  }

  const dayList = (state.dailyVisitors[day] ||= []);
  if (!dayList.includes(hash)) {
    dayList.push(hash);
  }

  bumpLocalMetric(state, day, 'page_views', 1);
  bumpLocalMetric(state, day, `${PAGE_METRIC_PREFIX}${path}`, 1);
  return { recorded: true, path };
}

function computeLocalAirdropFunnel(
  participants: AirdropParticipant[],
  snapshot: Record<string, AirdropSnapshotEntry>,
): AdminAnalyticsSummary['airdropFunnel'] {
  let boundWallets = 0;
  let unlockedBoxes = 0;
  let reservedSlots = 0;
  let lzWinner = 0;
  let lzUser5tx = 0;
  let community = 0;
  let followVerified = 0;
  let repostVerified = 0;
  let postsVerifiedUsers = 0;
  let totalVerifiedPosts = 0;
  let totalEngagementScore = 0;
  let createTokenVerified = 0;
  let tradeTokenVerified = 0;
  let totalInvited = 0;
  let totalQualified = 0;
  const referrers = new Set<string>();

  for (const p of participants) {
    if (p.wallet) boundWallets++;
    if (p.boxUnlockedAt) unlockedBoxes++;
    if (p.slotReserved) reservedSlots++;
    if (p.tier === 'lz_winner') lzWinner++;
    else if (p.tier === 'lz_user_5tx') lzUser5tx++;
    else community++;

    const followOk = p.checks.follow?.state === 'verified';
    const repostOk = p.checks.repost?.state === 'verified';
    if (followOk) followVerified++;
    if (repostOk) repostVerified++;
    if (p.posts.length >= 1) postsVerifiedUsers++;
    totalVerifiedPosts += p.posts.length;
    for (const post of p.posts) {
      totalEngagementScore += Math.max(0, post.engagementScore || 0);
    }
    if (p.checks.create_token?.state === 'verified') createTokenVerified++;
    if (p.checks.trade_token?.state === 'verified') tradeTokenVerified++;
    if (p.referrerId) {
      referrers.add(p.referrerId);
      totalInvited++;
      if (p.wallet && followOk && p.posts.length >= 1) {
        totalQualified++;
      }
    }
  }

  const snapEntries = Object.values(snapshot);
  const recentParticipants = [...participants]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id.localeCompare(a.id))
    .slice(0, 10)
    .map(p => ({
      username: p.profile.username,
      name: p.profile.name,
      avatarUrl: p.profile.avatarUrl ?? null,
      tier: p.tier,
      walletBound: Boolean(p.wallet),
      followVerified: p.checks.follow?.state === 'verified',
      repostVerified: p.checks.repost?.state === 'verified',
      postsCount: p.posts.length,
      createdAt: p.createdAt,
    }));

  return {
    totalParticipants: participants.length,
    boundWallets,
    unlockedBoxes,
    reservedSlots,
    tiers: { lzWinner, lzUser5tx, community },
    missions: {
      followVerified,
      repostVerified,
      postsVerifiedUsers,
      totalVerifiedPosts,
      totalEngagementScore,
      createTokenVerified,
      tradeTokenVerified,
    },
    referrals: {
      totalInvited,
      totalQualified,
      activeReferrers: referrers.size,
    },
    snapshot: {
      total: snapEntries.length,
      winners: snapEntries.filter(s => s.tier === 'lz_winner').length,
      fiveTx: snapEntries.filter(s => s.tier === 'lz_user_5tx').length,
    },
    recentParticipants,
  };
}

function summarizeLocalState(
  state: LocalAnalyticsState,
  days: number,
  nowMs: number,
  live?: {
    identities?: Record<string, GenesisProfile>;
    sessions?: Record<string, { expiresAt: number }>;
    participants?: AirdropParticipant[];
    snapshot?: Record<string, AirdropSnapshotEntry>;
  },
): AdminAnalyticsSummary {
  const clampedDays = clampDays(days);
  const visitorsList = Object.values(state.visitors);
  const last7Start = utcDay(nowMs - 6 * MS_PER_DAY);
  const today = utcDay(nowMs);
  const last7VisitorSet = new Set<string>();
  const dailyUniqueVisitors = new Map<string, number>();

  for (const [day, hashes] of Object.entries(state.dailyVisitors)) {
    dailyUniqueVisitors.set(day, hashes.length);
    if (day >= last7Start && day <= today) {
      for (const h of hashes) last7VisitorSet.add(h);
    }
  }

  const allTimeMetrics = new Map<string, number>();
  const dailyMetrics = new Map<string, Map<string, number>>();
  for (const [day, metrics] of Object.entries(state.daily)) {
    const map = new Map<string, number>();
    for (const [metric, count] of Object.entries(metrics)) {
      map.set(metric, count);
      allTimeMetrics.set(metric, (allTimeMetrics.get(metric) ?? 0) + count);
    }
    dailyMetrics.set(day, map);
  }

  const sessionsList = Object.values(live?.sessions ?? {});
  const activeXSessions = sessionsList.filter(s => s.expiresAt > nowMs).length;

  return assembleSummary({
    days: clampedDays,
    nowMs,
    uniqueVisitors: visitorsList.length,
    returningVisitors: visitorsList.filter(v => v.visits > 1).length,
    last7dUniqueVisitors: last7VisitorSet.size,
    dailyUniqueVisitors,
    allTimeMetrics,
    dailyMetrics,
    xAuth: {
      uniqueConnectedXAccounts: Object.keys(live?.identities ?? {}).length,
      activeXSessions,
    },
    airdropFunnel: computeLocalAirdropFunnel(live?.participants ?? [], live?.snapshot ?? {}),
  });
}

export function memoryAnalyticsStore(live?: {
  identities?: Record<string, GenesisProfile>;
  sessions?: Record<string, { expiresAt: number }>;
  participants?: AirdropParticipant[];
  snapshot?: Record<string, AirdropSnapshotEntry>;
}): AnalyticsStore {
  const state = freshAnalyticsState();
  let tail: Promise<unknown> = Promise.resolve();

  return {
    recordVisit(visitorId, rawPath, nowMs = Date.now()) {
      const work = tail.then(() => recordVisitInState(state, visitorId, rawPath, nowMs));
      tail = work.catch(() => undefined);
      return work;
    },
    recordEvent(metric, delta = 1, nowMs = Date.now()) {
      const safeDelta = Number.isInteger(delta) && delta > 0 ? delta : 1;
      const work = tail.then(() => {
        bumpLocalMetric(state, utcDay(nowMs), metric, safeDelta);
      });
      tail = work.catch(() => undefined);
      return work;
    },
    getSummary(days = 14, nowMs = Date.now()) {
      return tail.then(() => summarizeLocalState(state, days, nowMs, live));
    },
  };
}

export function createAnalyticsStore(pool: () => Pool | null = database): AnalyticsStore {
  return {
    async recordVisit(visitorId, rawPath, nowMs = Date.now()) {
      if (!VISITOR_ID_PATTERN.test(visitorId)) {
        throw new ApiError(400, 'INVALID_INPUT', 'Invalid visitor identifier.');
      }
      const path = normalizeAnalyticsPath(rawPath);
      if (!path) return { recorded: false, path: null };

      const db = pool();
      if (!db) {
        if (process.env.NODE_ENV === 'production') {
          throw new ApiError(503, 'ANALYTICS_UNAVAILABLE', 'Analytics storage is unavailable.');
        }
        return withLocalNamespace<LocalAnalyticsState, { recorded: boolean; path: string | null }>(
          'oneshot_analytics',
          records => {
            const state = (records.analytics ||= freshAnalyticsState());
            return recordVisitInState(state, visitorId, path, nowMs);
          },
          true,
        );
      }

      const hash = hashVisitorId(visitorId);
      const day = utcDay(nowMs);
      const seenAt = new Date(nowMs).toISOString();
      const routeMetric = `${PAGE_METRIC_PREFIX}${path}`;
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO oneshot_analytics_visitors(visitor_hash, first_seen_at, last_seen_at, first_path, visits)
           VALUES($1, $2::timestamptz, $2::timestamptz, $3, 1)
           ON CONFLICT(visitor_hash) DO UPDATE SET
             last_seen_at = EXCLUDED.last_seen_at,
             visits = oneshot_analytics_visitors.visits + 1`,
          [hash, seenAt, path],
        );
        await client.query(
          `INSERT INTO oneshot_analytics_daily_visitors(day, visitor_hash)
           VALUES($1::date, $2)
           ON CONFLICT DO NOTHING`,
          [day, hash],
        );
        await client.query(
          `INSERT INTO oneshot_analytics_daily(day, metric, count)
           VALUES($1::date, 'page_views', 1), ($1::date, $2, 1)
           ON CONFLICT(day, metric) DO UPDATE SET
             count = oneshot_analytics_daily.count + EXCLUDED.count`,
          [day, routeMetric],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
      return { recorded: true, path };
    },

    async recordEvent(metric, delta = 1, nowMs = Date.now()) {
      const safeDelta = Number.isInteger(delta) && delta > 0 ? delta : 1;
      const db = pool();
      if (!db) {
        if (process.env.NODE_ENV === 'production') {
          throw new ApiError(503, 'ANALYTICS_UNAVAILABLE', 'Analytics storage is unavailable.');
        }
        await withLocalNamespace<LocalAnalyticsState, void>(
          'oneshot_analytics',
          records => {
            const state = (records.analytics ||= freshAnalyticsState());
            bumpLocalMetric(state, utcDay(nowMs), metric, safeDelta);
          },
          true,
        );
        return;
      }

      const day = utcDay(nowMs);
      await db.query(
        `INSERT INTO oneshot_analytics_daily(day, metric, count)
         VALUES($1::date, $2, $3)
         ON CONFLICT(day, metric) DO UPDATE SET
           count = oneshot_analytics_daily.count + EXCLUDED.count`,
        [day, metric, safeDelta],
      );
    },

    async getSummary(days = 14, nowMs = Date.now()) {
      const clampedDays = clampDays(days);
      const db = pool();
      if (!db) {
        if (process.env.NODE_ENV === 'production') {
          throw new ApiError(503, 'ANALYTICS_UNAVAILABLE', 'Analytics storage is unavailable.');
        }
        const state = await withLocalNamespace<LocalAnalyticsState, LocalAnalyticsState>(
          'oneshot_analytics',
          records => structuredClone(records.analytics || freshAnalyticsState()),
          false,
        );
        const authLive = await withLocalNamespace<{
          identities?: Record<string, GenesisProfile>;
          sessions?: Record<string, { expiresAt: number }>;
        }, { identities: Record<string, GenesisProfile>; sessions: Record<string, { expiresAt: number }> }>(
          'oneshot_genesis_auth',
          records => ({
            identities: structuredClone(records.auth?.identities || {}),
            sessions: structuredClone(records.auth?.sessions || {}),
          }),
          false,
        );
        const airdropLive = await withLocalNamespace<{
          participants?: Record<string, AirdropParticipant>;
          snapshot?: Record<string, AirdropSnapshotEntry>;
        }, { participants: AirdropParticipant[]; snapshot: Record<string, AirdropSnapshotEntry> }>(
          'oneshot_airdrop',
          records => ({
            participants: Object.values(structuredClone(records.airdrop?.participants || {})),
            snapshot: structuredClone(records.airdrop?.snapshot || {}),
          }),
          false,
        );
        return summarizeLocalState(state, clampedDays, nowMs, {
          identities: authLive.identities,
          sessions: authLive.sessions,
          participants: airdropLive.participants,
          snapshot: airdropLive.snapshot,
        });
      }

      const today = utcDay(nowMs);
      const startDay = utcDay(nowMs - (clampedDays - 1) * MS_PER_DAY);
      const last7Start = utcDay(nowMs - 6 * MS_PER_DAY);
      const windowStart = startDay < last7Start ? startDay : last7Start;

      const client = await db.connect();
      try {
        await client.query('BEGIN READ ONLY');
        const [
          visitorTotalsRes,
          last7VisitorsRes,
          dailyVisitorsRes,
          allTimeMetricsRes,
          windowMetricsRes,
          xAuthRes,
          snapshotRes,
          funnelRes,
          recentRes,
        ] = await Promise.all([
          client.query(
            `SELECT
               count(*)::int AS unique_visitors,
               count(*) FILTER (WHERE visits > 1)::int AS returning_visitors
             FROM oneshot_analytics_visitors`,
          ),
          client.query(
            `SELECT count(DISTINCT visitor_hash)::int AS cnt
             FROM oneshot_analytics_daily_visitors
             WHERE day >= $1::date AND day <= $2::date`,
            [last7Start, today],
          ),
          client.query(
            `SELECT to_char(day, 'YYYY-MM-DD') AS day, count(*)::int AS visitors
             FROM oneshot_analytics_daily_visitors
             WHERE day >= $1::date AND day <= $2::date
             GROUP BY day`,
            [windowStart, today],
          ),
          client.query(
            `SELECT metric, COALESCE(sum(count), 0)::bigint AS total
             FROM oneshot_analytics_daily
             GROUP BY metric`,
          ),
          client.query(
            `SELECT to_char(day, 'YYYY-MM-DD') AS day, metric, count::bigint AS count
             FROM oneshot_analytics_daily
             WHERE day >= $1::date AND day <= $2::date`,
            [windowStart, today],
          ),
          client.query(
            `SELECT
               (SELECT count(*)::int FROM oneshot_genesis_identities) AS unique_connected_x,
               (SELECT count(*)::int FROM oneshot_genesis_sessions WHERE expires_at > $1) AS active_x_sessions`,
            [nowMs],
          ),
          client.query(
            `SELECT
               count(*)::int AS total,
               count(*) FILTER (WHERE tier = 'lz_winner')::int AS winners,
               count(*) FILTER (WHERE tier = 'lz_user_5tx')::int AS five_tx
             FROM oneshot_airdrop_snapshot`,
          ),
          client.query(
            `SELECT
               count(*)::int AS total_participants,
               count(*) FILTER (WHERE wallet IS NOT NULL)::int AS bound_wallets,
               count(*) FILTER (WHERE NULLIF(value->>'boxUnlockedAt', '') IS NOT NULL)::int AS unlocked_boxes,
               count(*) FILTER (WHERE COALESCE((value->>'slotReserved')::boolean, false))::int AS reserved_slots,
               count(*) FILTER (WHERE COALESCE(value->>'tier', 'community') = 'lz_winner')::int AS tier_lz_winner,
               count(*) FILTER (WHERE COALESCE(value->>'tier', 'community') = 'lz_user_5tx')::int AS tier_lz_5tx,
               count(*) FILTER (WHERE COALESCE(value->>'tier', 'community') = 'community')::int AS tier_community,
               count(*) FILTER (WHERE value->'checks'->'follow'->>'state' = 'verified')::int AS follow_verified,
               count(*) FILTER (WHERE value->'checks'->'repost'->>'state' = 'verified')::int AS repost_verified,
               count(*) FILTER (WHERE jsonb_array_length(COALESCE(value->'posts', '[]'::jsonb)) >= 1)::int AS posts_verified_users,
               COALESCE(sum(jsonb_array_length(COALESCE(value->'posts', '[]'::jsonb))), 0)::bigint AS total_verified_posts,
               COALESCE(sum(
                 COALESCE((
                   SELECT sum(GREATEST(0, COALESCE((p->>'engagementScore')::bigint, 0)))
                   FROM jsonb_array_elements(COALESCE(value->'posts', '[]'::jsonb)) AS p
                 ), 0)
               ), 0)::bigint AS total_engagement_score,
               count(*) FILTER (WHERE value->'checks'->'create_token'->>'state' = 'verified')::int AS create_token_verified,
               count(*) FILTER (WHERE value->'checks'->'trade_token'->>'state' = 'verified')::int AS trade_token_verified,
               count(*) FILTER (WHERE referrer_id IS NOT NULL)::int AS total_invited,
               count(*) FILTER (
                 WHERE referrer_id IS NOT NULL
                   AND wallet IS NOT NULL
                   AND value->'checks'->'follow'->>'state' = 'verified'
                   AND jsonb_array_length(COALESCE(value->'posts', '[]'::jsonb)) >= 1
               )::int AS total_qualified,
               count(DISTINCT referrer_id)::int AS active_referrers
             FROM oneshot_airdrop_participants`,
          ),
          client.query(
            `SELECT
               COALESCE(value->'profile'->>'username', '') AS username,
               COALESCE(value->'profile'->>'name', '') AS name,
               NULLIF(value->'profile'->>'avatarUrl', '') AS avatar_url,
               COALESCE(value->>'tier', 'community') AS tier,
               (wallet IS NOT NULL) AS wallet_bound,
               (value->'checks'->'follow'->>'state' = 'verified') AS follow_verified,
               (value->'checks'->'repost'->>'state' = 'verified') AS repost_verified,
               jsonb_array_length(COALESCE(value->'posts', '[]'::jsonb))::int AS posts_count,
               COALESCE(NULLIF(value->>'createdAt', ''), created_at::text) AS enrolled_at
             FROM oneshot_airdrop_participants
             ORDER BY created_at DESC, id DESC
             LIMIT 10`,
          ),
        ]);
        await client.query('COMMIT');

        const dailyUniqueVisitors = new Map<string, number>();
        for (const row of dailyVisitorsRes.rows) {
          dailyUniqueVisitors.set(String(row.day), Number(row.visitors || 0));
        }

        const allTimeMetrics = new Map<string, number>();
        for (const row of allTimeMetricsRes.rows) {
          allTimeMetrics.set(String(row.metric), Number(row.total || 0));
        }

        const dailyMetrics = new Map<string, Map<string, number>>();
        for (const row of windowMetricsRes.rows) {
          const day = String(row.day);
          let map = dailyMetrics.get(day);
          if (!map) {
            map = new Map();
            dailyMetrics.set(day, map);
          }
          map.set(String(row.metric), Number(row.count || 0));
        }

        const v = visitorTotalsRes.rows[0] || {};
        const x = xAuthRes.rows[0] || {};
        const snap = snapshotRes.rows[0] || {};
        const f = funnelRes.rows[0] || {};

        return assembleSummary({
          days: clampedDays,
          nowMs,
          uniqueVisitors: Number(v.unique_visitors || 0),
          returningVisitors: Number(v.returning_visitors || 0),
          last7dUniqueVisitors: Number(last7VisitorsRes.rows[0]?.cnt || 0),
          dailyUniqueVisitors,
          allTimeMetrics,
          dailyMetrics,
          xAuth: {
            uniqueConnectedXAccounts: Number(x.unique_connected_x || 0),
            activeXSessions: Number(x.active_x_sessions || 0),
          },
          airdropFunnel: {
            totalParticipants: Number(f.total_participants || 0),
            boundWallets: Number(f.bound_wallets || 0),
            unlockedBoxes: Number(f.unlocked_boxes || 0),
            reservedSlots: Number(f.reserved_slots || 0),
            tiers: {
              lzWinner: Number(f.tier_lz_winner || 0),
              lzUser5tx: Number(f.tier_lz_5tx || 0),
              community: Number(f.tier_community || 0),
            },
            missions: {
              followVerified: Number(f.follow_verified || 0),
              repostVerified: Number(f.repost_verified || 0),
              postsVerifiedUsers: Number(f.posts_verified_users || 0),
              totalVerifiedPosts: Number(f.total_verified_posts || 0),
              totalEngagementScore: Number(f.total_engagement_score || 0),
              createTokenVerified: Number(f.create_token_verified || 0),
              tradeTokenVerified: Number(f.trade_token_verified || 0),
            },
            referrals: {
              totalInvited: Number(f.total_invited || 0),
              totalQualified: Number(f.total_qualified || 0),
              activeReferrers: Number(f.active_referrers || 0),
            },
            snapshot: {
              total: Number(snap.total || 0),
              winners: Number(snap.winners || 0),
              fiveTx: Number(snap.five_tx || 0),
            },
            recentParticipants: recentRes.rows.map(row => ({
              username: String(row.username || ''),
              name: String(row.name || ''),
              avatarUrl: row.avatar_url ? String(row.avatar_url) : null,
              tier: String(row.tier || 'community'),
              walletBound: Boolean(row.wallet_bound),
              followVerified: Boolean(row.follow_verified),
              repostVerified: Boolean(row.repost_verified),
              postsCount: Number(row.posts_count || 0),
              createdAt: String(row.enrolled_at || ''),
            })),
          },
        });
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

export const analyticsStore = createAnalyticsStore();

export async function safeRecordAnalyticsEvent(metric: AnalyticsMetric, delta = 1): Promise<void> {
  try {
    await analyticsStore.recordEvent(metric, delta);
  } catch {
    // Telemetry must never break customer flows.
  }
}
