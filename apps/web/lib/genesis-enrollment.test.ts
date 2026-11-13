import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGenesisEnrollment } from './genesis-enrollment';
import { GENESIS_CONSENT_VERSION, type GenesisMe } from './genesis-schema';

const profile = { id: '123', username: 'creator', name: 'Creator', avatarUrl: null };
const withoutApplication: GenesisMe = { profile, application: null, qualifiedReferrals: 0, referralUrl: null, shareUrl: null };
const saved: GenesisMe = { ...withoutApplication, application: { id: '11111111-1111-4111-8111-111111111111', profile, code: 'abcdefghijklmnop', createdAt: '2026-11-01T00:00:00Z', submittedAt: null, revision: 1, ruleVersion: 1, status: 'draft', checks: {}, publishedDecision: null, shareConsent: false } };
type Input = Parameters<ReturnType<typeof createGenesisEnrollment>['start']>[0];
function fixture() {
  let scope: string | null = 'person:123:session';
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(saved));
  vi.stubGlobal('fetch', fetcher);
  const input: Input = {
    scope, currentScope: () => scope, authReady: true, verifiedProfileId: profile.id,
    campaign: { state: 'open', capacity: 750, version: 1, opensAt: null, closesAt: null, projectHandle: null },
    campaignLoading: false, campaignError: false, account: { scope, data: withoutApplication },
    accountLoading: false, accountError: false, busy: false,
    referral: 'abcdefghijklmnop', sessionId: 'session', getToken: async () => null, onStart: vi.fn(),
  };
  return { input, fetcher, enrollment: createGenesisEnrollment(), setScope: (value: string | null) => { scope = value; } };
}
afterEach(() => vi.unstubAllGlobals());

describe('connected Genesis application enrollment', () => {
  it('creates a private draft once with the invitation, current session and disclosure version', async () => {
    const f = fixture();
    const result = await f.enrollment.start(f.input);
    expect(result).toEqual({ state: 'saved', scope: f.input.scope, data: saved });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    const [url, request] = f.fetcher.mock.calls[0];
    expect(url).toBe('/api/oneshot/genesis/enroll');
    expect(request).toMatchObject({ method: 'POST', credentials: 'same-origin', headers: { 'X-Genesis-Session': 'session' } });
    expect(JSON.parse(String(request?.body))).toEqual({ consentVersion: GENESIS_CONSENT_VERSION, referral: 'abcdefghijklmnop' });
    expect(saved.application?.submittedAt).toBeNull();
    expect(await f.enrollment.start(f.input)).toEqual({ state: 'skipped' });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(['upcoming', 'closed'] as const)('never creates a draft while applications are %s', async state => {
    const f = fixture(); f.input.campaign = { ...f.input.campaign!, state };
    expect(await f.enrollment.start(f.input)).toEqual({ state: 'skipped' });
    expect(f.fetcher).not.toHaveBeenCalled();
    // An explicit retry cannot bypass campaign eligibility either.
    expect(await f.enrollment.start(f.input, true)).toEqual({ state: 'skipped' });
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it('does not act on stale or failed account/campaign data', async () => {
    for (const change of [
      { authReady: false }, { campaignLoading: true }, { campaignError: true }, { campaign: null },
      { accountLoading: true }, { accountError: true }, { account: null }, { busy: true },
      { verifiedProfileId: '999' }, { account: { scope: 'other-session', data: withoutApplication } },
      { account: { scope: 'person:123:session', data: { ...withoutApplication, profile: null } } },
    ] satisfies Partial<Input>[]) {
      const f = fixture(); Object.assign(f.input, change);
      expect(await f.enrollment.start(f.input)).toEqual({ state: 'skipped' });
      expect(f.fetcher).not.toHaveBeenCalled();
    }
  });

  it('leaves an existing application untouched', async () => {
    const f = fixture(); f.input.account!.data = saved;
    expect(await f.enrollment.start(f.input, true)).toEqual({ state: 'skipped' });
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it('does not retry a failed request on re-render; an explicit retry can recover', async () => {
    const f = fixture(); f.fetcher.mockResolvedValueOnce(Response.json({ error: { message: 'Unavailable' } }, { status: 503 }));
    expect(await f.enrollment.start(f.input)).toEqual({ state: 'failed', scope: f.input.scope });
    expect(await f.enrollment.start(f.input)).toEqual({ state: 'skipped' });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect((await f.enrollment.start(f.input, true)).state).toBe('saved');
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(f.fetcher.mock.calls[1][1]?.body)).referral).toBe('abcdefghijklmnop');
  });

  it('keeps the invitation and recovery attempt available after a transport failure', async () => {
    const f = fixture(); f.fetcher.mockRejectedValueOnce(new Error('private transport detail'));
    expect(await f.enrollment.start(f.input)).toEqual({ state: 'failed', scope: f.input.scope });
    expect(f.input.referral).toBe('abcdefghijklmnop');
    // A failed campaign refresh is not permission to create a draft or consume Retry.
    expect(await f.enrollment.start({ ...f.input, campaignError: true }, true)).toEqual({ state: 'skipped' });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect((await f.enrollment.start(f.input, true)).state).toBe('saved');
    expect(JSON.parse(String(f.fetcher.mock.calls[1][1]?.body)).referral).toBe('abcdefghijklmnop');
  });

  it('does not duplicate an in-flight enrollment even when Retry is pressed again', async () => {
    const f = fixture(); let complete!: (response: Response) => void;
    f.fetcher.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const pending = f.enrollment.start(f.input);
    await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(1));
    expect(await f.enrollment.start(f.input, true)).toEqual({ state: 'skipped' });
    complete(Response.json(saved));
    expect((await pending).state).toBe('saved');
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });

  it('discards results after an account/session switch or unmount', async () => {
    for (const next of ['other-account:456:session', null]) {
      const f = fixture(); let complete!: (response: Response) => void;
      f.fetcher.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
      const pending = f.enrollment.start(f.input);
      await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(1));
      f.setScope(next); complete(Response.json(saved));
      expect(await pending).toEqual({ state: 'stale', scope: f.input.scope });
    }
  });

  it('rejects an identity switch during token loading before sending a mutation', async () => {
    const f = fixture(); f.input.getToken = async () => { f.setScope('changed-session'); return null; };
    expect(await f.enrollment.start(f.input)).toEqual({ state: 'stale', scope: f.input.scope });
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it.each([
    () => new Response('<html>unavailable</html>'),
    () => Response.json({ profile }),
    () => Response.json(withoutApplication),
    () => Response.json({ ...saved, profile: { ...profile, id: '999' } }),
  ])('keeps unreadable or incomplete responses retryable without claiming a saved draft', async response => {
    const f = fixture(); f.fetcher.mockResolvedValueOnce(response());
    expect(await f.enrollment.start(f.input)).toEqual({ state: 'failed', scope: f.input.scope });
    expect((await f.enrollment.start(f.input, true)).state).toBe('saved');
  });
});
