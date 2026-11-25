import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { privateKeyToAccount } from 'viem/accounts';
import {
  memoryAnalyticsStore,
  normalizeAnalyticsPath,
  type AnalyticsMetric,
} from './analytics-store';
import { createGenesisAuth, type GenesisSession } from './genesis-auth';
import { memoryGenesisAuthStore } from './genesis-auth-store';
import { memoryGenesisStore } from './genesis-store';
import { createAirdropService } from './airdrop-service';
import { memoryAirdropStore } from './airdrop-store';
import type { AirdropVerifier } from './airdrop-verification';
import {
  AIRDROP_CONSENT_VERSION,
  airdropCampaignSchema,
  computePostEngagementScore,
} from '../../../web/lib/airdrop-schema';

describe('analytics-store', () => {
  it('normalizes routes into a bounded allowlist and skips admin paths', () => {
    expect(normalizeAnalyticsPath('/')).toBe('/');
    expect(normalizeAnalyticsPath('/?ref=abc')).toBe('/');
    expect(normalizeAnalyticsPath('/airdrop/')).toBe('/airdrop');
    expect(normalizeAnalyticsPath('/whitelist?ref=xyz')).toBe('/airdrop');
    expect(normalizeAnalyticsPath('/tokens/new')).toBe('/tokens/new');
    expect(normalizeAnalyticsPath('/tokens/0x1234')).toBe('/tokens');
    expect(normalizeAnalyticsPath('/nfts/new')).toBe('/nfts/new');
    expect(normalizeAnalyticsPath('/nfts/import')).toBe('/nfts/import');
    expect(normalizeAnalyticsPath('/nfts/reviewed/0xabc')).toBe('/nfts/reviewed');
    expect(normalizeAnalyticsPath('/nfts/cart')).toBe('/nfts/cart');
    expect(normalizeAnalyticsPath('/nfts/collection-1')).toBe('/nfts');
    expect(normalizeAnalyticsPath('/portfolio')).toBe('/portfolio');
    expect(normalizeAnalyticsPath('/activity')).toBe('/activity');
    expect(normalizeAnalyticsPath('/settings/profile')).toBe('/settings');
    expect(normalizeAnalyticsPath('/profile/0x1234')).toBe('/profile');
    expect(normalizeAnalyticsPath('/some-unknown-page')).toBe('/other');
    expect(normalizeAnalyticsPath('/admin')).toBeNull();
    expect(normalizeAnalyticsPath('/admin/airdrop')).toBeNull();
    expect(normalizeAnalyticsPath('relative-path')).toBeNull();
  });

  it('deduplicates daily and all-time unique visitors and summarizes route views and events', async () => {
    const store = memoryAnalyticsStore();
    const dayOld = Date.parse('2026-11-10T12:00:00Z');
    const day1 = Date.parse('2026-11-24T10:00:00Z');
    const day2 = Date.parse('2026-11-25T15:00:00Z');

    const v1 = 'visitor-alpha-123456';
    const v2 = 'visitor-beta-1234567';
    const v3 = 'visitor-gamma-123456';

    await store.recordVisit(v3, '/', dayOld);
    await store.recordVisit(v1, '/airdrop?ref=abc', day1);
    await store.recordVisit(v1, '/', day1 + 60_000);
    await store.recordVisit(v1, '/airdrop', day2);
    await store.recordVisit(v2, '/tokens/0xabc', day2 + 30_000);
    const skipped = await store.recordVisit(v2, '/admin/airdrop', day2 + 40_000);
    expect(skipped).toEqual({ recorded: false, path: null });

    await store.recordEvent('connect_x_started', 1, day2);
    await store.recordEvent('connect_x_succeeded', 1, day2);
    await store.recordEvent('eligibility_checks', 1, day2);
    await store.recordEvent('eligibility_lz_winner', 1, day2);
    await store.recordEvent('airdrop_enrolled', 1, day2);
    await store.recordEvent('wallet_linked', 1, day2);
    await store.recordEvent('mission_follow_verified', 1, day2);

    const summary = await store.getSummary(14, day2);
    expect(summary.traffic.uniqueVisitors).toBe(3);
    expect(summary.traffic.returningVisitors).toBe(1);
    expect(summary.traffic.totalPageViews).toBe(5);
    expect(summary.traffic.todayUniqueVisitors).toBe(2);
    expect(summary.traffic.todayPageViews).toBe(2);
    expect(summary.traffic.last7dUniqueVisitors).toBe(2);
    expect(summary.traffic.last7dPageViews).toBe(4);
    expect(summary.traffic.topPages).toEqual([
      { path: '/', totalViews: 2, todayViews: 0 },
      { path: '/airdrop', totalViews: 2, todayViews: 1 },
      { path: '/tokens', totalViews: 1, todayViews: 1 },
    ]);
    expect(summary.xAuth.connectXStarted).toBe(1);
    expect(summary.xAuth.connectXSucceeded).toBe(1);
    expect(summary.eligibility.totalChecks).toBe(1);
    expect(summary.eligibility.byTier.lzWinner).toBe(1);
    expect(summary.daily).toHaveLength(14);
    const lastDay = summary.daily[summary.daily.length - 1]!;
    expect(lastDay).toEqual({
      day: '2026-11-25',
      uniqueVisitors: 2,
      pageViews: 2,
      connectXStarted: 1,
      connectXSucceeded: 1,
      connectXFailed: 0,
      eligibilityChecks: 1,
      airdropEnrolled: 1,
      walletLinked: 1,
      missionsVerified: 1,
    });
  });

  it('records X auth lifecycle events without breaking auth when metrics emit fails', async () => {
    const analytics = memoryAnalyticsStore();
    const origin = 'https://oneshot.example.com';
    const env: Record<string, string | undefined> = {
      NODE_ENV: 'production',
      NEXT_PUBLIC_APP_URL: origin,
      X_OAUTH_CLIENT_ID: 'client-1',
      X_OAUTH_CLIENT_SECRET: 'secret-1',
    };
    const fetcher = vi.fn<typeof fetch>(async url =>
      String(url).endsWith('/oauth2/token')
        ? Response.json({ access_token: 'tok' })
        : Response.json({ data: { id: '42', username: 'alice', name: 'Alice' } }),
    );
    const auth = createGenesisAuth({
      store: memoryGenesisAuthStore(),
      applications: memoryGenesisStore(),
      environment: () => env,
      fetcher,
      now: () => Date.parse('2026-11-25T10:00:00Z'),
      recordEvent: metric => analytics.recordEvent(metric, 1, Date.parse('2026-11-25T10:00:00Z')),
    });

    const started = await auth.start(undefined, '/airdrop');
    const state = new URL(started.url).searchParams.get('state')!;
    await auth.callback('code-ok', state, started.browser);

    const startedFail = await auth.start(undefined, '/airdrop');
    const badState = new URL(startedFail.url).searchParams.get('state')!;
    await expect(auth.callback('code-bad', badState, 'wrong-browser-cookie-value-padded-12345')).rejects.toThrow();

    await auth.route(
      new NextRequest(`${origin}/api/oneshot/genesis/auth/callback?error=access_denied`),
    );

    const summary = await analytics.getSummary(7, Date.parse('2026-11-25T10:00:00Z'));
    expect(summary.xAuth.connectXStarted).toBe(2);
    expect(summary.xAuth.connectXSucceeded).toBe(1);
    expect(summary.xAuth.connectXFailed).toBe(2);

    const failingAuth = createGenesisAuth({
      store: memoryGenesisAuthStore(),
      applications: memoryGenesisStore(),
      environment: () => env,
      fetcher,
      now: () => Date.parse('2026-11-25T10:00:00Z'),
      recordEvent: async () => {
        throw new Error('metrics storage down');
      },
    });
    const ok = await failingAuth.start(undefined, '/airdrop');
    expect(ok.url).toContain('https://x.com/i/oauth2/authorize');
  });

  it('records eligibility, enrollment, wallet bind, and mission completions idempotently', async () => {
    const events: AnalyticsMetric[] = [];
    const nowMs = Date.parse('2026-11-25T12:00:00Z');
    const store = memoryAirdropStore();
    const account = privateKeyToAccount('0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
    const origin = 'https://oneshot.example.com';

    await store.transaction(tx =>
      tx.saveCampaign(
        airdropCampaignSchema.parse({
          state: 'open',
          projectXId: '100',
          projectHandle: 'OneshotExchange',
          announcementPostId: '9001',
        }),
      ),
    );

    const verifier: AirdropVerifier = {
      projectHandle: async () => 'OneshotExchange',
      verifyFollow: async () => ({
        state: 'verified',
        message: 'Following @OneshotExchange',
        checkedAt: new Date(nowMs).toISOString(),
      }),
      verifyRepost: async () => ({
        state: 'verified',
        message: 'Announcement repost verified.',
        checkedAt: new Date(nowMs).toISOString(),
      }),
      verifyPost: async (profile, _campaign, postUrl) => {
        const postId = postUrl.split('/').pop()!;
        const metrics = { likes: 5, reposts: 1, replies: 0, views: 100 };
        return {
          postId,
          postUrl: `https://x.com/${profile.username}/status/${postId}`,
          metrics,
          engagementScore: computePostEngagementScore(metrics),
        };
      },
      refreshPost: async () => ({
        metrics: { likes: 5, reposts: 1, replies: 0, views: 100 },
        engagementScore: 26,
      }),
      verifyCreatedToken: async () => ({
        state: 'needs_action',
        message: 'Not deployed yet',
        checkedAt: new Date(nowMs).toISOString(),
      }),
      verifyTradeVolume: async () => ({
        state: 'needs_action',
        message: 'Not traded yet',
        checkedAt: new Date(nowMs).toISOString(),
      }),
    };

    const service = createAirdropService({
      store,
      verifier,
      now: () => nowMs,
      webOrigin: () => origin,
      recordEvent: metric => {
        events.push(metric);
      },
    });

    await service.checkEligibility(account.address);

    const session: GenesisSession = {
      provider: 'x',
      userId: 'x:77',
      sessionId: 'sess-77',
      expiresAt: 9_999_999_999,
      linkedAddresses: [],
      xAccount: { id: '77', username: 'alice', name: 'Alice', avatarUrl: null },
    };

    await service.enroll(session, AIRDROP_CONSENT_VERSION);
    await service.enroll(session, AIRDROP_CONSENT_VERSION); // Idempotent retry should not double count.

    const challenge = await service.walletChallenge(session, account.address);
    const signature = await account.signMessage({ message: challenge.message });
    await service.bindWallet(session, {
      wallet: account.address,
      signature,
      expectedRevision: challenge.expectedRevision,
    });

    await service.verifyMission(session, 'follow');
    await service.verifyMission(session, 'follow'); // Already verified should not double count.
    await service.verifyMission(session, 'repost');
    await service.verifyMission(session, 'post', 'https://x.com/alice/status/1234567890');

    expect(events).toEqual([
      'eligibility_checks',
      'eligibility_community',
      'airdrop_enrolled',
      'wallet_linked',
      'mission_follow_verified',
      'mission_repost_verified',
      'mission_post_verified',
    ]);
  });
});
