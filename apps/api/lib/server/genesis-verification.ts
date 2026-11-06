import { z } from 'zod';
import type { GenesisCampaign, GenesisCheck, GenesisProfile, GenesisTask } from '../../../web/lib/genesis-schema';

export class GenesisEvidenceError extends Error {}
export class GenesisProviderUnavailable extends Error {}
const id = z.string().regex(/^\d{1,32}$/);
const handle = z.string().regex(/^[A-Za-z0-9_]{1,15}$/);
const profileSchema = z.object({ data: z.object({ id, userName: handle }) });
const metric = z.number().int().nonnegative().nullable().optional();
const postSchema = z.object({ data: z.object({
  id, text: z.string().min(1).max(100_000), createdAt: z.string(), author: z.object({ id }),
  retweeted_tweet: z.unknown().optional(), isReply: z.boolean().optional(),
  entities: z.object({ urls: z.array(z.object({ expanded_url: z.string().optional(), expandedUrl: z.string().optional(), url: z.string().optional() })).max(100).optional() }).passthrough().nullable().optional(),
  likeCount: metric, retweetCount: metric, replyCount: metric, viewCount: metric,
}) });
export type GenesisVerifier = { verify(task: GenesisTask, profile: GenesisProfile, campaign: GenesisCampaign, postId: string | undefined, referralUrls: string[]): Promise<GenesisCheck>; project(id: string): Promise<string>; lookup?(username: string): Promise<{ id: string; username: string }> };

export function createGenesisVerifier(options: { fetcher?: typeof fetch; apiKey?: () => string | undefined; reserveRead(): Promise<boolean>; now?: () => number }): GenesisVerifier {
  const fetcher = options.fetcher || fetch;
  const key = options.apiKey || (() => process.env.GETX_API_KEY);
  const now = options.now || Date.now;
  async function read(path: string, query: Record<string, string>) {
    if (!key() || !await options.reserveRead()) throw new GenesisProviderUnavailable('Verification is temporarily unavailable. Your progress is saved. Try again later.');
    const url = new URL(path, 'https://api.getxapi.com');
    Object.entries(query).forEach(([name, value]) => url.searchParams.set(name, value));
    try {
      const response = await fetcher(url, { headers: { Authorization: `Bearer ${key()}`, Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(8000), cache: 'no-store' });
      if (!response.ok) {
        // A 404 can also mean private or inaccessible: it is not proof of misconduct.
        if (response.status === 404) throw new GenesisEvidenceError('We could not read this account or post. Check that it is public and the link is correct, then try again.');
        throw new GenesisProviderUnavailable();
      }
      const reader = response.body?.getReader(); if (!reader) throw new GenesisProviderUnavailable();
      let size = 0; const chunks: Uint8Array[] = [];
      for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 256 * 1024) { await reader.cancel(); throw new GenesisProviderUnavailable(); } chunks.push(part.value); }
      const data = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
      return JSON.parse(new TextDecoder().decode(data)) as unknown;
    } catch (error) {
      if (error instanceof GenesisEvidenceError) throw error;
      throw new GenesisProviderUnavailable('X checks are temporarily unavailable. Your progress is saved. Try again later.');
    }
  }
  async function project(xId: string) {
    const value = profileSchema.safeParse(await read('/twitter/user/info_by_id', { userId: xId }));
    if (!value.success || value.data.data.id !== xId) throw new GenesisProviderUnavailable();
    return value.data.data.userName;
  }
  return {
    project,
    async lookup(username) {
      const value = profileSchema.safeParse(await read('/twitter/user/info', { userName: username }));
      if (!value.success || value.data.data.userName.toLowerCase() !== username.toLowerCase()) throw new GenesisProviderUnavailable();
      return { id: value.data.data.id, username: value.data.data.userName };
    },
    async verify(task, profile, campaign, postId, referralUrls) {
      const checkedAt = new Date(now()).toISOString();
      if (task === 'follow') {
        const [source, target] = await Promise.all([project(profile.id), project(campaign.projectXId)]);
        const result = z.object({ data: z.object({ sourceUserName: handle, targetUserName: handle, sourceFollowsTarget: z.boolean() }) }).safeParse(await read('/twitter/user/check_follow_relationship', { source_user_name: source, target_user_name: target }));
        if (!result.success || result.data.data.sourceUserName.toLowerCase() !== source.toLowerCase() || result.data.data.targetUserName.toLowerCase() !== target.toLowerCase()) throw new GenesisProviderUnavailable();
        if (!result.data.data.sourceFollowsTarget) throw new GenesisEvidenceError(`Follow @${target} from your connected X account, then check again.`);
        return { state: 'verified', message: `Following @${target}`, checkedAt };
      }
      if (!postId) throw new GenesisEvidenceError('Add the link to your own public X post.');
      const result = postSchema.safeParse(await read('/twitter/tweet/detail', { id: postId }));
      if (!result.success || result.data.data.id !== postId) throw new GenesisProviderUnavailable();
      const post = result.data.data;
      if (post.author.id !== profile.id) throw new GenesisEvidenceError('Use a post from the X account connected to this application.');
      const published = Date.parse(post.createdAt);
      if (!Number.isFinite(published)) throw new GenesisProviderUnavailable();
      if (published > now() + 60_000 || !campaign.opensAt || !campaign.closesAt || published < Date.parse(campaign.opensAt) || published > Date.parse(campaign.closesAt)) throw new GenesisEvidenceError('Use a post published during the application window.');
      if (post.retweeted_tweet || /^RT @/i.test(post.text)) throw new GenesisEvidenceError('Share your own perspective in an original post or quote post. A repost alone does not qualify.');
      if (task === 'post') {
        const mention = new RegExp(`(^|[^A-Za-z0-9_])@${campaign.projectHandle}($|[^A-Za-z0-9_])`, 'i');
        if (!mention.test(post.text)) throw new GenesisEvidenceError(`Mention @${campaign.projectHandle} in your post so we can identify your entry.`);
      } else {
        const urls = post.entities?.urls?.flatMap(value => [value.expanded_url, value.expandedUrl].filter((url): url is string => Boolean(url))) || [];
        // Never resolve arbitrary t.co destinations. The provider must supply expanded entities.
        if (!urls.length && /https:\/\/t\.co\//.test(post.text)) throw new GenesisProviderUnavailable();
        if (!urls.some(value => referralUrls.includes(value))) throw new GenesisEvidenceError('Include your full personal invitation link in the post, then check again.');
      }
      return { state: 'verified', message: task === 'post' ? 'Your post is verified' : 'Your invitation is verified', checkedAt, postId,
        metrics: { likes: post.likeCount ?? null, reposts: post.retweetCount ?? null, replies: post.replyCount ?? null, views: post.viewCount ?? null } };
    },
  };
}
