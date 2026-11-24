import { describe, expect, it } from 'vitest';
import {
  AIRDROP_MAX_POST_ENGAGEMENT_SCORE,
  AIRDROP_TOP500_BRACKETS,
  AIRDROP_TOP500_POOL,
  airdropEvmAddress,
  airdropPostId,
  computeBaseGeneralTokens,
  computeEngagementBonusBps,
  computeParticipantScore,
  computePostEngagementScore,
  computeTop500RewardForRank,
  parseSnapshotCsv,
  requiredMissionsComplete,
  tokensToRaw8,
} from './airdrop-schema';

describe('Airdrop schema calculations and LayerZero snapshot parser', () => {
  it('allocates exact 100,000,000 tokens across the 500 leaderboard ranks', () => {
    let total = 0;
    for (let rank = 1; rank <= 500; rank++) {
      total += computeTop500RewardForRank(rank);
    }
    expect(total).toBe(AIRDROP_TOP500_POOL);
    expect(computeTop500RewardForRank(501)).toBe(0);
    expect(computeTop500RewardForRank(null)).toBe(0);
    expect(AIRDROP_TOP500_BRACKETS.reduce((sum, b) => sum + b.subtotalTokens, 0)).toBe(AIRDROP_TOP500_POOL);
  });

  it('computes 100% / 50% / 0% base shares and caps engagement bonus at +50%', () => {
    expect(computeBaseGeneralTokens('lz_winner', 40_000)).toBe(40_000);
    expect(computeBaseGeneralTokens('lz_user_5tx', 40_000)).toBe(20_000);
    expect(computeBaseGeneralTokens('community', 40_000)).toBe(0);

    const score = computePostEngagementScore({ likes: 100, reposts: 20, replies: 10, views: 5_000 });
    // 100*3 + 20*6 + 10*4 + floor(5000/20) = 710
    expect(score).toBe(710);
    expect(
      computePostEngagementScore({
        likes: 100,
        reposts: 20,
        replies: 10,
        quotes: 5,
        bookmarks: 15,
        views: 5_000,
      }),
    ).toBe(780);
    expect(computePostEngagementScore({ likes: 10_000, views: 500_000 })).toBe(AIRDROP_MAX_POST_ENGAGEMENT_SCORE);
    expect(computeEngagementBonusBps(710)).toBe(3550);
    expect(computeEngagementBonusBps(AIRDROP_MAX_POST_ENGAGEMENT_SCORE)).toBe(5000);
    expect(tokensToRaw8(40_000)).toBe(4_000_000_000_000n);
  });

  it('requires all 4 core missions + wallet to unlock the box while keeping invites/trade optional', () => {
    const base = {
      wallet: '0x1111111111111111111111111111111111111111',
      tier: 'lz_winner' as const,
      checks: {
        follow: { state: 'verified' as const, message: 'ok', checkedAt: '2026-11-23T00:00:00Z' },
        repost: { state: 'verified' as const, message: 'ok', checkedAt: '2026-11-23T00:00:00Z' },
        create_token: { state: 'verified' as const, message: 'ok', checkedAt: '2026-11-23T00:00:00Z' },
      },
      posts: [
        {
          postId: '1',
          postUrl: 'https://x.com/u/status/1',
          verifiedAt: '2026-11-23T00:00:00Z',
          lastRefreshedAt: '2026-11-23T00:00:00Z',
          metrics: { likes: 5, reposts: 2, replies: 1, views: 100 },
          engagementScore: 22,
        },
      ],
    };
    expect(requiredMissionsComplete(base)).toBe(true);
    expect(requiredMissionsComplete({ ...base, wallet: null })).toBe(false);
    expect(requiredMissionsComplete({ ...base, posts: [] })).toBe(false);
    expect(computeParticipantScore(base, 2)).toBe(50 + 50 + 200 + 100 + 22 + 300 + 100);
  });

  it('parses CSV snapshots, normalizes addresses, and keeps the higher LZ tier on duplicates', () => {
    const rows = parseSnapshotCsv([
      'wallet,tier,txCount',
      '0xAbCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCd,lz_user_5tx,7',
      '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd,lz_winner,12',
      '0x2222222222222222222222222222222222222222,50%,5',
    ].join('\n'));

    expect(rows).toEqual([
      { wallet: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd', tier: 'lz_winner', txCount: 12 },
      { wallet: '0x2222222222222222222222222222222222222222', tier: 'lz_user_5tx', txCount: 5 },
    ]);
  });

  it('supports LayerZero eligibility/allocation exports, Dune tx counts, quoted rows, and single-column defaultTier', () => {
    // 1. LayerZero Foundation eligibility/allocation CSV (filters false & zero rows)
    const lzExport = parseSnapshotCsv([
      '"address","isEligible","zroAllocation"',
      '"0x1111111111111111111111111111111111111111","true","1,250.5"',
      '"0x2222222222222222222222222222222222222222","false","500"',
      '"0x3333333333333333333333333333333333333333","true","0"',
    ].join('\n'));
    expect(lzExport).toEqual([
      { wallet: '0x1111111111111111111111111111111111111111', tier: 'lz_winner' },
    ]);

    // 2. Dune tx_count CSV (filters < 5 transactions cleanly)
    const duneExport = parseSnapshotCsv([
      'user_address,tx_count',
      '0x4444444444444444444444444444444444444444,3',
      '0x5555555555555555555555555555555555555555,9',
    ].join('\n'));
    expect(duneExport).toEqual([
      { wallet: '0x5555555555555555555555555555555555555555', tier: 'lz_user_5tx', txCount: 9 },
    ]);

    // 3. Single-column wallet list with explicit defaultTier
    const plainList = parseSnapshotCsv(
      ['wallet', '0x6666666666666666666666666666666666666666'].join('\n'),
      { defaultTier: 'lz_winner' },
    );
    expect(plainList).toEqual([
      { wallet: '0x6666666666666666666666666666666666666666', tier: 'lz_winner' },
    ]);
  });

  it('parses mobile and media X post URLs and returns a friendly wallet validation message', () => {
    expect(airdropPostId('https://mobile.x.com/oneshot/status/1234567890123456789?s=20')).toBe('1234567890123456789');
    expect(airdropPostId('https://mobile.twitter.com/oneshot/status/9876543210/photo/1')).toBe('9876543210');
    expect(airdropPostId('https://x.com/oneshot/status/9876543210/video/2/')).toBe('9876543210');
    expect(airdropPostId('https://x.com/i/web/statuses/555666777')).toBe('555666777');
    expect(airdropPostId('https://evil.example/oneshot/status/123')).toBeNull();
    expect(airdropPostId('https://x.com/oneshot')).toBeNull();

    const invalidWallet = airdropEvmAddress.safeParse('bad');
    expect(invalidWallet.success).toBe(false);
    if (!invalidWallet.success) {
      expect(invalidWallet.error.issues[0]?.message).toBe('Enter a valid 0x wallet address.');
    }
  });
});
