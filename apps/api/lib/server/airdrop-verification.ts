import type { Pool } from 'pg';
import { z } from 'zod';
import { database } from './store';
import {
  airdropPostId,
  computePostEngagementScore,
  type AirdropCampaign,
  type AirdropCheckResult,
  type AirdropPostMetrics,
  type AirdropXProfile,
} from '../../../web/lib/airdrop-schema';

export class AirdropEvidenceError extends Error {}
export class AirdropProviderUnavailable extends Error {}

const id = z.string().regex(/^\d{1,32}$/);
const handle = z.string().regex(/^[A-Za-z0-9_]{1,15}$/);
const profileSchema = z.object({ data: z.object({ id, userName: handle }) });
const metric = z.number().int().nonnegative().nullable().optional();

const postSchema = z.object({
  data: z.object({
    id,
    text: z.string().min(1).max(100_000),
    createdAt: z.string(),
    author: z.object({ id }),
    retweeted_tweet: z.unknown().optional(),
    quoted_tweet: z.object({ id: id.optional() }).passthrough().nullable().optional(),
    likeCount: metric,
    retweetCount: metric,
    replyCount: metric,
    quoteCount: metric,
    bookmarkCount: metric,
    viewCount: metric,
  }),
});

const retweetersSchema = z.object({
  has_more: z.boolean().optional(),
  next_cursor: z.string().nullable().optional(),
  users: z.array(z.object({ id: id.optional(), userName: handle.optional() })).optional(),
  data: z.array(z.object({ id: id.optional(), userName: handle.optional() })).optional(),
});

export type VerifiedPostEvidence = {
  postId: string;
  postUrl: string;
  metrics: AirdropPostMetrics;
  engagementScore: number;
};

export type AirdropVerifier = {
  verifyFollow(profile: AirdropXProfile, campaign: AirdropCampaign): Promise<AirdropCheckResult>;
  verifyRepost(profile: AirdropXProfile, campaign: AirdropCampaign, postUrl?: string): Promise<AirdropCheckResult>;
  verifyPost(profile: AirdropXProfile, campaign: AirdropCampaign, postUrl: string): Promise<VerifiedPostEvidence>;
  refreshPost(postId: string): Promise<{ metrics: AirdropPostMetrics; engagementScore: number }>;
  verifyCreatedToken(wallet: string): Promise<AirdropCheckResult & { tokenMarket?: string }>;
  verifyTradeVolume(wallet: string, minNativeRaw: string): Promise<AirdropCheckResult & { volumeNativeRaw?: string }>;
  projectHandle(xId: string): Promise<string>;
  resolveUserByHandle?(userName: string): Promise<{ id: string; username: string }>;
};

export function createAirdropVerifier(options: {
  fetcher?: typeof fetch;
  apiKey?: () => string | undefined;
  reserveRead(): Promise<boolean>;
  pool?: () => Pool | null;
  now?: () => number;
}): AirdropVerifier {
  const fetcher = options.fetcher || fetch;
  const key = options.apiKey || (() => process.env.GETX_API_KEY);
  const pool = options.pool || database;
  const now = options.now || Date.now;

  async function read(path: string, query: Record<string, string>) {
    if (!key() || !(await options.reserveRead())) {
      throw new AirdropProviderUnavailable('X verification is temporarily unavailable. Your progress is saved; try again shortly.');
    }
    const url = new URL(path, 'https://api.getxapi.com');
    Object.entries(query).forEach(([name, value]) => url.searchParams.set(name, value));
    try {
      const response = await fetcher(url, {
        headers: { Authorization: `Bearer ${key()}`, Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
        cache: 'no-store',
      });
      if (!response.ok) {
        if (response.status === 404) {
          throw new AirdropEvidenceError('We could not read that X account or post. Make sure it is public and try again.');
        }
        throw new AirdropProviderUnavailable();
      }
      const reader = response.body?.getReader();
      if (!reader) throw new AirdropProviderUnavailable();
      let size = 0;
      const chunks: Uint8Array[] = [];
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > 512 * 1024) {
          await reader.cancel();
          throw new AirdropProviderUnavailable();
        }
        chunks.push(part.value);
      }
      const data = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        data.set(chunk, offset);
        offset += chunk.length;
      }
      return JSON.parse(new TextDecoder().decode(data)) as unknown;
    } catch (error) {
      if (error instanceof AirdropEvidenceError) throw error;
      throw new AirdropProviderUnavailable('X checks are temporarily unavailable. Your progress is saved; try again later.');
    }
  }

  async function projectHandle(xId: string): Promise<string> {
    const parsed = profileSchema.safeParse(await read('/twitter/user/info_by_id', { userId: xId }));
    if (!parsed.success || parsed.data.data.id !== xId) throw new AirdropProviderUnavailable();
    return parsed.data.data.userName;
  }

  async function resolveUserByHandle(userName: string): Promise<{ id: string; username: string }> {
    const cleanHandle = userName.replace(/^@/, '').trim();
    const parsed = profileSchema.safeParse(await read('/twitter/user/info', { userName: cleanHandle }));
    if (!parsed.success || parsed.data.data.userName.toLowerCase() !== cleanHandle.toLowerCase()) {
      throw new AirdropProviderUnavailable('Could not verify the official X handle. Check the handle and try again.');
    }
    return { id: parsed.data.data.id, username: parsed.data.data.userName };
  }

  async function fetchPost(postId: string) {
    const result = postSchema.safeParse(await read('/twitter/tweet/detail', { id: postId }));
    if (!result.success || result.data.data.id !== postId) throw new AirdropProviderUnavailable();
    return result.data.data;
  }

  function extractMetrics(post: z.infer<typeof postSchema>['data']): AirdropPostMetrics {
    return {
      likes: post.likeCount ?? 0,
      reposts: post.retweetCount ?? 0,
      replies: post.replyCount ?? 0,
      quotes: post.quoteCount ?? 0,
      bookmarks: post.bookmarkCount ?? 0,
      views: post.viewCount ?? 0,
    };
  }

  return {
    projectHandle,
    resolveUserByHandle,

    async verifyFollow(profile, campaign) {
      const checkedAt = new Date(now()).toISOString();
      if (!campaign.projectXId) {
        throw new AirdropProviderUnavailable('Follow verification is temporarily unavailable. Try again shortly.');
      }
      const [source, target] = await Promise.all([projectHandle(profile.id), projectHandle(campaign.projectXId)]);
      const result = z
        .object({
          data: z.object({
            sourceUserName: handle,
            targetUserName: handle,
            sourceFollowsTarget: z.boolean(),
          }),
        })
        .safeParse(
          await read('/twitter/user/check_follow_relationship', {
            source_user_name: source,
            target_user_name: target,
          }),
        );
      if (
        !result.success ||
        result.data.data.sourceUserName.toLowerCase() !== source.toLowerCase() ||
        result.data.data.targetUserName.toLowerCase() !== target.toLowerCase()
      ) {
        throw new AirdropProviderUnavailable();
      }
      if (!result.data.data.sourceFollowsTarget) {
        throw new AirdropEvidenceError(`Follow @${target} from your connected X account, then check again.`);
      }
      return { state: 'verified', message: `Following @${target}`, checkedAt };
    },

    async verifyRepost(profile, campaign, postUrl) {
      const checkedAt = new Date(now()).toISOString();
      if (postUrl) {
        const quoteId = airdropPostId(postUrl);
        if (!quoteId) {
          throw new AirdropEvidenceError('Enter a valid public X quote-post link, or leave blank to check your repost.');
        }
        const post = await fetchPost(quoteId);
        if (post.author.id !== profile.id) {
          throw new AirdropEvidenceError('Use a quote post published from your connected X account.');
        }
        if (post.retweeted_tweet || /^RT @/i.test(post.text)) {
          throw new AirdropEvidenceError('Submit a quote post you wrote, or leave the link blank to check your direct repost.');
        }
        const published = Date.parse(post.createdAt);
        if (!Number.isFinite(published)) throw new AirdropProviderUnavailable();
        if (
          published > now() + 60_000 ||
          (campaign.opensAt && published < Date.parse(campaign.opensAt)) ||
          (campaign.closesAt && published > Date.parse(campaign.closesAt))
        ) {
          throw new AirdropEvidenceError('Use a quote post published during the active airdrop campaign window.');
        }
        if (campaign.announcementPostId) {
          if (post.quoted_tweet?.id !== campaign.announcementPostId) {
            throw new AirdropEvidenceError('Quote the official announcement post on X, then check again.');
          }
        } else {
          const mentionsHandle =
            campaign.projectHandle &&
            new RegExp(`(^|[^A-Za-z0-9_])@${campaign.projectHandle}($|[^A-Za-z0-9_])`, 'i').test(post.text);
          if (!mentionsHandle) {
            throw new AirdropEvidenceError('Quote the official announcement post or mention the official handle, then check again.');
          }
        }
        return {
          state: 'verified',
          message: 'Announcement repost / quote verified.',
          checkedAt,
          evidenceId: quoteId,
        };
      }

      if (!campaign.announcementPostId) {
        throw new AirdropProviderUnavailable('Repost verification is temporarily unavailable. Try again shortly.');
      }
      const MAX_RETWEETER_PAGES = 6;
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      let matched = false;
      for (let page = 0; page < MAX_RETWEETER_PAGES; page++) {
        const parsed = retweetersSchema.safeParse(
          await read('/twitter/tweet/retweeters', {
            id: campaign.announcementPostId,
            ...(cursor ? { cursor } : {}),
          }),
        );
        if (!parsed.success) throw new AirdropProviderUnavailable();
        const users = [...(parsed.data.users || []), ...(parsed.data.data || [])];
        if (
          users.some(user =>
            user.id
              ? user.id === profile.id
              : Boolean(user.userName && user.userName.toLowerCase() === profile.username.toLowerCase()),
          )
        ) {
          matched = true;
          break;
        }
        const nextCursor = parsed.data.next_cursor?.trim();
        if (!parsed.data.has_more || !nextCursor || seenCursors.has(nextCursor)) {
          break;
        }
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      }
      if (!matched) {
        throw new AirdropEvidenceError(
          'Repost the announcement on X first, or paste your quote-post link and check again.',
        );
      }
      return {
        state: 'verified',
        message: 'Announcement repost verified.',
        checkedAt,
        evidenceId: campaign.announcementPostId,
      };
    },

    async verifyPost(profile, campaign, postUrl) {
      const postId = airdropPostId(postUrl);
      if (!postId) {
        throw new AirdropEvidenceError('Use a public X post link such as https://x.com/you/status/123.');
      }
      const post = await fetchPost(postId);
      if (post.author.id !== profile.id) {
        throw new AirdropEvidenceError('Submit a post published from the X account connected to your airdrop box.');
      }
      const published = Date.parse(post.createdAt);
      if (!Number.isFinite(published)) throw new AirdropProviderUnavailable();
      if (
        published > now() + 60_000 ||
        (campaign.opensAt && published < Date.parse(campaign.opensAt)) ||
        (campaign.closesAt && published > Date.parse(campaign.closesAt))
      ) {
        throw new AirdropEvidenceError('Submit a post published during the active airdrop campaign window.');
      }
      if (post.retweeted_tweet || /^RT @/i.test(post.text)) {
        throw new AirdropEvidenceError('Write an original post or quote post about oneshot rather than a plain repost.');
      }
      if (campaign.projectHandle) {
        const mention = new RegExp(`(^|[^A-Za-z0-9_])@${campaign.projectHandle}($|[^A-Za-z0-9_])`, 'i');
        if (!mention.test(post.text)) {
          throw new AirdropEvidenceError(`Mention @${campaign.projectHandle} in your post so we can verify it.`);
        }
      }
      const metrics = extractMetrics(post);
      return {
        postId,
        postUrl: `https://x.com/${profile.username}/status/${postId}`,
        metrics,
        engagementScore: computePostEngagementScore(metrics),
      };
    },

    async refreshPost(postId) {
      const post = await fetchPost(postId);
      const metrics = extractMetrics(post);
      return {
        metrics,
        engagementScore: computePostEngagementScore(metrics),
      };
    },

    async verifyCreatedToken(wallet) {
      const checkedAt = new Date(now()).toISOString();
      const db = pool();
      if (!db) {
        return {
          state: 'temporarily_unavailable',
          message: 'Token creation records are temporarily unavailable. Please try again shortly.',
          checkedAt,
        };
      }
      const normalized = wallet.toLowerCase();
      let market: string | undefined;
      let querySucceeded = false;

      try {
        const eventMarket = await db.query(
          "SELECT entity_id FROM oneshot_evm_token_event_projections WHERE kind='markets' AND lower(value->>'creator')=$1 LIMIT 1",
          [normalized],
        );
        querySucceeded = true;
        market = eventMarket.rows[0]?.entity_id as string | undefined;
      } catch {
        /* Fallback to token market snapshot table if event projections are unavailable */
      }

      if (!market) {
        try {
          const snapshotMarket = await db.query(
            "SELECT market FROM oneshot_evm_token_market_snapshots WHERE lower(value->>'creator')=$1 ORDER BY block_number DESC LIMIT 1",
            [normalized],
          );
          querySucceeded = true;
          market = snapshotMarket.rows[0]?.market as string | undefined;
        } catch {
          /* Both token index tables unavailable */
        }
      }

      if (!querySucceeded) {
        return {
          state: 'temporarily_unavailable',
          message: 'Token creation records could not be checked right now. Please try again shortly.',
          checkedAt,
        };
      }
      if (!market) {
        return {
          state: 'needs_action',
          message: 'No token launch was found for this wallet yet. Launch a token on oneshot, give it a moment to confirm, then check again.',
          checkedAt,
        };
      }
      return {
        state: 'verified',
        message: 'Token launch verified.',
        checkedAt,
        evidenceId: market.toLowerCase(),
      };
    },

    async verifyTradeVolume(wallet, minNativeRaw) {
      const checkedAt = new Date(now()).toISOString();
      const db = pool();
      if (!db) {
        return {
          state: 'temporarily_unavailable',
          message: 'Trading volume records are temporarily unavailable. Please try again shortly.',
          checkedAt,
        };
      }
      try {
        const res = await db.query(
          `SELECT COALESCE(SUM((value->>'grossNativeRaw')::numeric), 0)::text AS volume
           FROM oneshot_evm_token_event_projections
           WHERE kind='events'
             AND value->>'kind'='oneshot-trade'
             AND lower(value->>'trader')=$1
             AND (value->>'grossNativeRaw') ~ '^\\d+$'`,
          [wallet.toLowerCase()],
        );
        const volumeStr = String(res.rows[0]?.volume || '0').split('.')[0]!;
        const volume = BigInt(volumeStr);
        const required = BigInt(minNativeRaw);
        if (volume < required) {
          return {
            state: 'needs_action',
            message: 'Your trading volume has not reached the mission target yet.',
            checkedAt,
            volumeNativeRaw: volume.toString(),
          };
        }
        return {
          state: 'verified',
          message: 'Meme token trading volume verified.',
          checkedAt,
          volumeNativeRaw: volume.toString(),
        };
      } catch {
        return {
          state: 'temporarily_unavailable',
          message: 'Trading volume records could not be checked right now. Please try again shortly.',
          checkedAt,
        };
      }
    },
  };
}
