import { describe, expect, it, vi } from 'vitest';
import { createAirdropVerifier, AirdropEvidenceError } from './airdrop-verification';
import { airdropCampaignSchema, type AirdropXProfile } from '../../../web/lib/airdrop-schema';

describe('Airdrop verifier security boundaries', () => {
  const profile: AirdropXProfile = {
    id: '42',
    username: 'trusteduser',
    name: 'Trusted User',
    avatarUrl: null,
  };

  const campaign = airdropCampaignSchema.parse({
    state: 'open',
    opensAt: '2026-11-20T00:00:00.000Z',
    closesAt: '2026-12-01T00:00:00.000Z',
    projectXId: '100',
    projectHandle: 'oneshot',
    announcementPostId: '9001',
  });

  function makeVerifier(responder: (url: string) => unknown, nowMs = Date.parse('2026-11-23T00:00:00.000Z')) {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const payload = responder(String(input));
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;

    return createAirdropVerifier({
      fetcher,
      apiKey: () => 'test-key',
      reserveRead: async () => true,
      now: () => nowMs,
    });
  }

  it('rejects plain retweets and out-of-window posts in quote-post repost checks', async () => {
    const verifierRt = makeVerifier(() => ({
      data: {
        id: '777',
        text: 'RT @oneshot: big news',
        createdAt: '2026-11-22T12:00:00.000Z',
        author: { id: '42' },
        quoted_tweet: { id: '9001' },
      },
    }));
    await expect(
      verifierRt.verifyRepost(profile, campaign, 'https://x.com/trusteduser/status/777'),
    ).rejects.toBeInstanceOf(AirdropEvidenceError);

    const verifierOld = makeVerifier(() => ({
      data: {
        id: '778',
        text: 'Old post quoting announcement @oneshot',
        createdAt: '2026-11-10T12:00:00.000Z',
        author: { id: '42' },
        quoted_tweet: { id: '9001' },
      },
    }));
    await expect(
      verifierOld.verifyRepost(profile, campaign, 'https://x.com/trusteduser/status/778'),
    ).rejects.toBeInstanceOf(AirdropEvidenceError);
  });

  it('requires quoting announcementPostId when configured rather than merely mentioning @handle', async () => {
    const verifierNoQuote = makeVerifier(() => ({
      data: {
        id: '779',
        text: 'Hey @oneshot check me out',
        createdAt: '2026-11-22T12:00:00.000Z',
        author: { id: '42' },
        quoted_tweet: null,
      },
    }));
    await expect(
      verifierNoQuote.verifyRepost(profile, campaign, 'https://x.com/trusteduser/status/779'),
    ).rejects.toBeInstanceOf(AirdropEvidenceError);

    const verifierValidQuote = makeVerifier(() => ({
      data: {
        id: '780',
        text: 'LFG @oneshot',
        createdAt: '2026-11-22T12:00:00.000Z',
        author: { id: '42' },
        quoted_tweet: { id: '9001' },
      },
    }));
    await expect(verifierValidQuote.verifyRepost(profile, campaign, 'https://x.com/trusteduser/status/780')).resolves.toMatchObject({
      state: 'verified',
      evidenceId: '780',
    });
  });

  it('never matches retweeters by recycled username when a differing numeric user id is returned', async () => {
    const verifier = makeVerifier(() => ({
      users: [{ id: '999999', userName: 'trusteduser' }],
    }));
    await expect(verifier.verifyRepost(profile, campaign)).rejects.toBeInstanceOf(AirdropEvidenceError);
  });

  it('calls retweeters with ?id=... and follows cursor pagination to verify later pages', async () => {
    const requestedUrls: string[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requestedUrls.push(url);
      const parsed = new URL(url);
      expect(parsed.pathname).toBe('/twitter/tweet/retweeters');
      expect(parsed.searchParams.get('id')).toBe('9001');
      expect(parsed.searchParams.has('tweetId')).toBe(false);
      if (!parsed.searchParams.get('cursor')) {
        return new Response(
          JSON.stringify({
            has_more: true,
            next_cursor: 'page-2-cursor',
            users: [{ id: '999991', userName: 'otheruser' }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      expect(parsed.searchParams.get('cursor')).toBe('page-2-cursor');
      return new Response(
        JSON.stringify({
          has_more: false,
          next_cursor: '',
          users: [{ id: '42', userName: 'trusteduser' }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const verifier = createAirdropVerifier({
      fetcher,
      apiKey: () => 'test-key',
      reserveRead: async () => true,
      now: () => Date.parse('2026-11-23T00:00:00.000Z'),
    });

    await expect(verifier.verifyRepost(profile, campaign)).resolves.toMatchObject({
      state: 'verified',
      evidenceId: '9001',
    });
    expect(requestedUrls).toHaveLength(2);
  });

  it('extracts quotes, bookmarks, and view-weighted engagement score in verifyPost', async () => {
    const verifier = makeVerifier(() => ({
      data: {
        id: '888',
        text: 'Building on @oneshot right now!',
        createdAt: '2026-11-22T12:00:00.000Z',
        author: { id: '42' },
        likeCount: 10,
        retweetCount: 5,
        replyCount: 2,
        quoteCount: 3,
        bookmarkCount: 4,
        viewCount: 2_000,
      },
    }));

    const post = await verifier.verifyPost(profile, campaign, 'https://x.com/trusteduser/status/888');
    expect(post.metrics).toEqual({
      likes: 10,
      reposts: 5,
      replies: 2,
      quotes: 3,
      bookmarks: 4,
      views: 2_000,
    });
    // 10*3 + 5*6 + 2*4 + 3*8 + 4*2 + floor(2000/20) = 30 + 30 + 8 + 24 + 8 + 100 = 200
    expect(post.engagementScore).toBe(200);
  });
});
