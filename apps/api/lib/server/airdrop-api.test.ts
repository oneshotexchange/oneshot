import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  campaign: vi.fn(),
  checkEligibility: vi.fn(),
  leaderboard: vi.fn(),
  me: vi.fn(),
  enroll: vi.fn(),
  walletChallenge: vi.fn(),
  bindWallet: vi.fn(),
  verifyMission: vi.fn(),
  refreshEngagement: vi.fn(),
  requireSession: vi.fn(),
}));

vi.mock('./airdrop-service', () => ({ airdropService: mocks }));
vi.mock('./genesis-auth', () => ({ genesisAuth: { authenticate: mocks.requireSession, assertWrite: vi.fn() } }));

import { airdropApi } from './airdrop-api';

afterEach(() => {
  vi.clearAllMocks();
});

describe('Airdrop API public and authenticated boundaries', () => {
  it('serves GET and HEAD public campaign, eligibility, and leaderboard routes without auth', async () => {
    mocks.campaign.mockResolvedValue({ state: 'open', generalPoolTokens: 410_000_000 });
    mocks.checkEligibility.mockResolvedValue({
      wallet: '0x1111111111111111111111111111111111111111',
      tier: 'lz_winner',
    });
    mocks.leaderboard.mockResolvedValue({ totalRanked: 0, entries: [] });

    for (const url of [
      'https://api.oneshot.example/api/oneshot/airdrop/campaign',
      'https://api.oneshot.example/api/oneshot/airdrop/eligibility?wallet=0x1111111111111111111111111111111111111111',
      'https://api.oneshot.example/api/oneshot/airdrop/leaderboard?offset=0&limit=50',
    ]) {
      for (const method of ['GET', 'HEAD']) {
        const res = await airdropApi(new NextRequest(url, { method }));
        expect(res.status).toBe(200);
        expect(res.headers.get('cache-control')).toBe('no-store');
        if (method === 'HEAD') expect(await res.text()).toBe('');
      }
    }
    expect(mocks.requireSession).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated account reads and writes', async () => {
    const denied = new Error('Authentication required');
    mocks.requireSession.mockRejectedValue(denied);
    for (const [path, method] of [
      ['me', 'GET'],
      ['enroll', 'POST'],
      ['wallet-challenge', 'POST'],
      ['wallet', 'POST'],
      ['verify', 'POST'],
      ['refresh-engagement', 'POST'],
    ]) {
      await expect(
        airdropApi(new NextRequest(`https://api.oneshot.example/api/oneshot/airdrop/${path}`, { method })),
      ).rejects.toBe(denied);
    }
    expect(mocks.me).not.toHaveBeenCalled();
  });

  it('enforces X-Genesis-Session header consistency and forwards verified actions', async () => {
    const session = { provider: 'x', userId: 'x:123', sessionId: 'current-session' };
    mocks.requireSession.mockResolvedValue(session);

    await expect(
      airdropApi(
        new NextRequest('https://api.oneshot.example/api/oneshot/airdrop/me', {
          method: 'GET',
          headers: { 'X-Genesis-Session': 'stale-session' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'GENESIS_AUTH_CHANGED', status: 401 });

    mocks.verifyMission.mockResolvedValue({ profile: null, participant: null, referralUrl: null });
    const res = await airdropApi(
      new NextRequest('https://api.oneshot.example/api/oneshot/airdrop/verify', {
        method: 'POST',
        headers: { 'X-Genesis-Session': 'current-session', 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: 'post', postUrl: 'https://x.com/person/status/123456' }),
      }),
    );
    expect(res.status).toBe(200);
    expect(mocks.verifyMission).toHaveBeenCalledWith(session, 'post', 'https://x.com/person/status/123456');
  });

  it('rejects duplicate/unknown query params and malformed JSON cleanly with 400 errors', async () => {
    const addr = '0x1111111111111111111111111111111111111111';
    await expect(
      airdropApi(new NextRequest(`https://api.oneshot.example/api/oneshot/airdrop/eligibility?wallet=${addr}&wallet=${addr}`)),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT', status: 400 });

    await expect(
      airdropApi(new NextRequest('https://api.oneshot.example/api/oneshot/airdrop/leaderboard?offset=0&extra=1')),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT', status: 400 });

    const session = { provider: 'x', userId: 'x:123', sessionId: 'current-session' };
    mocks.requireSession.mockResolvedValue(session);
    await expect(
      airdropApi(
        new NextRequest('https://api.oneshot.example/api/oneshot/airdrop/verify', {
          method: 'POST',
          headers: { 'X-Genesis-Session': 'current-session', 'Content-Type': 'application/json' },
          body: '{malformed',
        }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_JSON', status: 400 });
  });
});
