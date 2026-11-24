import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearAirdropReferral,
  createAirdropEnrollment,
  loadAirdropCampaign,
  readAirdropReferral,
} from './client-airdrop-api';
import { AIRDROP_CONSENT_VERSION, type AirdropMeResponse, type AirdropPublicCampaign } from './airdrop-schema';

afterEach(() => {
  vi.unstubAllGlobals();
});

const profile = { id: '123', username: 'lzuser', name: 'LZ User', avatarUrl: null };
const campaignOpen: AirdropPublicCampaign = {
  state: 'open',
  tokenName: 'oneshot',
  tokenSymbol: 'ONE',
  opensAt: null,
  closesAt: null,
  projectHandle: 'oneshot',
  announcementPostId: '9001',
  baseWinnerTokens: 40_000,
  maxGeneralSlots: 10_000,
  reservedSlots: 0,
  reservedGeneralTokens: 0,
  generalPoolTokens: 410_000_000,
  top500PoolTokens: 100_000_000,
  totalAirdropTokens: 510_000_000,
  openingFdvUsd: 960_000,
  tradeMissionEnabled: false,
  minTradeNativeRaw: '10000000000000000',
  chainId: null,
  distributorAddress: null,
  tokenAddress: null,
  marketAddress: null,
  claimingOpen: false,
  claimDeadline: null,
  snapshotCutoffAt: null,
  merkleRoot: null,
  version: 1,
};

const emptyMe: AirdropMeResponse = { profile, participant: null, referralUrl: null };
const savedMe: AirdropMeResponse = {
  profile,
  referralUrl: 'https://oneshot.example.com/airdrop?ref=abcdefghijklmnop',
  participant: {
    id: '11111111-1111-4111-8111-111111111111',
    profile,
    code: 'abcdefghijklmnop',
    createdAt: '2026-11-23T00:00:00Z',
    revision: 1,
    wallet: null,
    walletBoundAt: null,
    tier: 'community',
    checks: {},
    posts: [],
    boxUnlockedAt: null,
    slotReserved: false,
    reservedSlotNumber: null,
    baseGeneralTokens: 0,
    engagementBonusTokens: 0,
    reservedGeneralTokens: 0,
    invitedReferrals: 0,
    qualifiedReferrals: 0,
    engagementScore: 0,
    engagementBonusBps: 0,
    totalScore: 0,
    requiredComplete: false,
    rank: null,
    projectedTop500Tokens: 0,
    totalProjectedTokens: 0,
    totalProjectedRaw: '0',
    boxState: 'sealed',
    claimProof: null,
  },
};

describe('Airdrop client helpers and enrollment', () => {
  it('reads, persists, and clears valid invitation referral codes', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
    };
    expect(readAirdropReferral('?ref=abcdefghijklmnop', storage)).toBe('abcdefghijklmnop');
    expect(readAirdropReferral('', storage)).toBe('abcdefghijklmnop');
    expect(readAirdropReferral('?ref=bad', storage)).toBeNull();
    expect(readAirdropReferral('', storage)).toBeNull();
    readAirdropReferral('?ref=abcdefghijklmnop', storage);
    clearAirdropReferral(storage);
    expect(readAirdropReferral('', storage)).toBeNull();
  });

  it('syncs referral codes across multi-storage lists with fallback', () => {
    const createMemoryStore = () => {
      const map = new Map<string, string>();
      return {
        getItem: (k: string) => map.get(k) ?? null,
        setItem: (k: string, v: string) => {
          map.set(k, v);
        },
        removeItem: (k: string) => {
          map.delete(k);
        },
      };
    };
    const local = createMemoryStore();
    const session = createMemoryStore();

    expect(readAirdropReferral('?ref=abcdefghijklmnop', [local, session])).toBe('abcdefghijklmnop');
    // Second tab loses sessionStorage but still recovers from localStorage and backfills sessionStorage
    const freshSession = createMemoryStore();
    expect(readAirdropReferral('', [local, freshSession])).toBe('abcdefghijklmnop');
    expect(freshSession.getItem('oneshot.airdrop.invitation')).toBe('abcdefghijklmnop');

    clearAirdropReferral([local, freshSession]);
    expect(readAirdropReferral('', [local, freshSession])).toBeNull();
  });

  it('rejects non-JSON campaign responses rather than silently passing', async () => {
    vi.stubGlobal('fetch', async () => new Response('<html>error</html>', { status: 200 }));
    await expect(loadAirdropCampaign()).rejects.toThrow();
  });

  it('enrolls participant once with referral code and blocks duplicate enrollment replays', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(savedMe));
    vi.stubGlobal('fetch', fetcher);
    const enrollment = createAirdropEnrollment();
    const input = {
      scope: 'x:123:s1',
      currentScope: () => 'x:123:s1',
      authReady: true,
      verifiedProfileId: '123',
      campaign: campaignOpen,
      campaignLoading: false,
      campaignError: false,
      account: { scope: 'x:123:s1', data: emptyMe },
      accountLoading: false,
      accountError: false,
      busy: false,
      referral: 'abcdefghijklmnop',
      sessionId: 's1',
      onStart: vi.fn(),
    };

    const res1 = await enrollment.start(input);
    expect(res1).toEqual({ state: 'saved', scope: 'x:123:s1', data: savedMe });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    expect(body).toEqual({ consentVersion: AIRDROP_CONSENT_VERSION, referral: 'abcdefghijklmnop' });

    const res2 = await enrollment.start(input);
    expect(res2).toEqual({ state: 'skipped' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('allows immediate re-enrollment after clearing an invalid or self referral error', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          { error: { code: 'AIRDROP_REFERRAL_INVALID', message: 'This invitation link is invalid or expired.' } },
          { status: 409 },
        ),
      )
      .mockResolvedValueOnce(Response.json(savedMe));
    vi.stubGlobal('fetch', fetcher);

    const enrollment = createAirdropEnrollment();
    const baseInput = {
      scope: 'x:123:s1',
      currentScope: () => 'x:123:s1',
      authReady: true,
      verifiedProfileId: '123',
      campaign: campaignOpen,
      campaignLoading: false,
      campaignError: false,
      account: { scope: 'x:123:s1', data: emptyMe },
      accountLoading: false,
      accountError: false,
      busy: false,
      sessionId: 's1',
      onStart: vi.fn(),
    };

    const failed = await enrollment.start({ ...baseInput, referral: 'badreferralcode1' });
    expect(failed).toEqual({
      state: 'failed',
      scope: 'x:123:s1',
      code: 'AIRDROP_REFERRAL_INVALID',
      message: 'This invitation link is invalid or expired.',
    });

    const recovered = await enrollment.start({ ...baseInput, referral: null });
    expect(recovered).toEqual({ state: 'saved', scope: 'x:123:s1', data: savedMe });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(String(fetcher.mock.calls[1][1]?.body));
    expect(secondBody).toEqual({ consentVersion: AIRDROP_CONSENT_VERSION });
  });
});
