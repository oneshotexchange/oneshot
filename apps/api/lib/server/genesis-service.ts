import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ApiError } from './errors';
import { webOrigin } from './origins';
import { genesisAuth, type GenesisSession as OneshotSession } from './genesis-auth';
import { genesisStore, type GenesisStore } from './genesis-store';
import { createGenesisVerifier, GenesisEvidenceError, type GenesisVerifier } from './genesis-verification';
import { GENESIS_CAPACITY, genesisAllVerified, genesisCampaignSchema, genesisPostId, type GenesisApplication, type GenesisCampaign, type GenesisDecision, type GenesisMe, type GenesisPublicCampaign, type GenesisTask } from '../../../web/lib/genesis-schema';

const tasks: GenesisTask[] = ['follow', 'post', 'share'];
function fail(code: string, message: string, status = 409): never { throw new ApiError(status, code, message); }
function profile(session: OneshotSession) { if (!session.xAccount) fail('GENESIS_X_REQUIRED', 'Connect your X account to continue.', 403); return session.xAccount; }
export function publicGenesisCampaign(campaign: GenesisCampaign, now = Date.now()): GenesisPublicCampaign {
  const state = campaign.state === 'open' ? campaign.closesAt && Date.parse(campaign.closesAt) <= now ? 'closed' : campaign.opensAt && Date.parse(campaign.opensAt) > now ? 'upcoming' : 'open' : campaign.state;
  return { state, capacity: GENESIS_CAPACITY, opensAt: campaign.opensAt, closesAt: campaign.closesAt, projectHandle: campaign.projectHandle || null, version: campaign.version };
}
function assertOpen(campaign: GenesisCampaign, now: number) { if (publicGenesisCampaign(campaign, now).state !== 'open') fail('GENESIS_CLOSED', 'Applications are not open right now. Return here for the next update.'); }
function owner(app: GenesisApplication | null, session: OneshotSession): GenesisApplication {
  if (!app || app.userId !== session.userId) fail('GENESIS_NOT_FOUND', 'Start your Genesis application first.', 404);
  if (app.profile.id !== profile(session).id) fail('GENESIS_X_CHANGED', 'Reconnect the X account used for this application. Your application is still saved.', 403);
  return app;
}
function jobKey(appId: string, task: string) { const h = createHash('sha256').update(`${appId}:${task}`).digest('hex'); return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`; }
export function createGenesisService(options: { store?: GenesisStore; verifier?: GenesisVerifier; now?: () => number; webOrigin: () => string }) {
  const store = options.store || genesisStore; const now = options.now || Date.now;
  const verifier = options.verifier || createGenesisVerifier({ reserveRead: () => store.transaction(async tx => tx.budget((await tx.campaign()).dailyReadLimit, now())) });
  const urls = (code: string) => ({ referralUrl: `${options.webOrigin()}/whitelist?ref=${code}`, shareUrl: `${options.webOrigin()}/g/${code}` });
  async function me(session: OneshotSession): Promise<GenesisMe> {
    return store.transaction(async tx => {
      const record = await tx.application('userId', session.userId);
      const campaign = await tx.campaign();
      const from = session.xAccount ? await tx.nominator(session.xAccount.id) : null;
      const incoming = from?.nominations?.find(n => n.xId === session.xAccount?.id);
      const nomination = incoming && from ? { id: incoming.id, from: from.profile.username, accepted: incoming.accepted } : null;
      if (!record) return { profile: session.xAccount || null, application: null, qualifiedReferrals: 0, referralUrl: null, shareUrl: null, nomination, nominationsOpen: campaign.nominationsOpen && publicGenesisCampaign(campaign, now()).state === 'open' };
      const app = owner(record, session);
      const { userId, referrerId, note, decision, consentVersion, ...application } = app;
      return { profile: session.xAccount || null, application, qualifiedReferrals: await tx.count('referrals', app.id), ...urls(app.code), nomination, nominationsOpen: campaign.nominationsOpen && publicGenesisCampaign(campaign, now()).state === 'open' };
    });
  }
  async function processJob(id: string) {
    const claimed = await store.transaction(async tx => {
      const job = await tx.job(id);
      if (!job || job.state === 'done' || job.nextAt > now() || job.leaseUntil > now()) return null;
      const app = await tx.application('id', job.applicationId); const campaign = await tx.campaign();
      if (!app || app.profile.id !== job.xId || app.ruleVersion !== job.ruleVersion || campaign.version !== job.ruleVersion) { await tx.saveJob({ ...job, state: 'done' }); return null; }
      const lease = { ...job, state: 'running' as const, attempts: job.attempts + 1, leaseUntil: now() + 60_000 };
      await tx.saveJob(lease); return { job: lease, app, campaign };
    });
    if (!claimed) return;
    let check: GenesisApplication['checks'][GenesisTask]; let retry = false;
    try { check = await verifier.verify(claimed.job.task, claimed.app.profile, claimed.campaign, claimed.job.postId, Object.values(urls(claimed.app.code))); }
    catch (error) {
      retry = !(error instanceof GenesisEvidenceError);
      check = { state: retry ? 'temporarily_unavailable' : 'needs_action', checkedAt: new Date(now()).toISOString(), ...(claimed.job.postId ? { postId: claimed.job.postId } : {}), message: retry ? 'X checks are temporarily unavailable. Your progress is saved. Try again later.' : (error as Error).message };
    }
    await store.transaction(async tx => {
      const job = await tx.job(id); const app = await tx.application('id', claimed.app.id);
      if (!job || job.leaseUntil !== claimed.job.leaseUntil || job.attempts !== claimed.job.attempts || !app || app.profile.id !== job.xId || app.ruleVersion !== job.ruleVersion) return;
      app.checks[job.task] = check; app.revision++;
      if (app.submittedAt) app.status = genesisAllVerified(app) ? 'under_review' : 'awaiting_verification';
      await tx.saveApplication(app);
      await tx.saveJob({ ...job, state: retry && job.attempts < 5 ? 'pending' : 'done', leaseUntil: 0, nextAt: now() + Math.min(900_000, 30_000 * 2 ** job.attempts) });
    });
  }
  return {
    me,
    campaign: () => store.transaction(async tx => publicGenesisCampaign(await tx.campaign(), now())),
    async enroll(session: OneshotSession, consentVersion: string, referral?: string) {
      const identity = profile(session);
      await store.transaction(async tx => {
        const existing = await tx.application('userId', session.userId); if (existing) { const app = owner(existing, session); app.profile = identity; await tx.saveApplication(app); return; }
        const campaign = await tx.campaign(); assertOpen(campaign, now());
        if (await tx.application('xId', identity.id)) fail('GENESIS_IDENTITY_USED', 'This X account already has an application. Sign in to the original oneshot account.');
        const referrer = referral ? await tx.application('code', referral) : null;
        if (referral && !referrer) fail('GENESIS_REFERRAL_INVALID', 'This invitation link is no longer valid. Remove the invitation to continue.');
        const app: GenesisApplication = { id: randomUUID(), userId: session.userId, profile: identity, code: randomBytes(12).toString('base64url'), referrerId: referrer?.id || null, createdAt: new Date(now()).toISOString(), submittedAt: null, revision: 1, ruleVersion: campaign.version, status: 'draft', checks: {}, decision: null, publishedDecision: null, note: '', shareConsent: false, consentVersion };
        await tx.saveApplication(app); await tx.audit({ at: app.createdAt, actor: session.userId, action: 'enroll', applicationId: app.id });
      }); return me(session);
    },
    async verify(session: OneshotSession, task: GenesisTask, postUrl?: string) {
      const postId = task === 'follow' ? undefined : genesisPostId(postUrl || '');
      if (task !== 'follow' && !postId) fail('GENESIS_POST_INVALID', 'Use a public X post link, such as https://x.com/yourname/status/123.', 400);
      const id = await store.transaction(async tx => {
        const app = owner(await tx.application('userId', session.userId), session); const campaign = await tx.campaign();
        const id = jobKey(app.id, task); const existing = await tx.job(id);
        // Allow already-submitted evidence to recover after the deadline, not new entries.
        const recovery = app.submittedAt && existing && existing.postId === postId && app.checks[task]?.state === 'temporarily_unavailable';
        if (!recovery) assertOpen(campaign, now());
        if (app.ruleVersion !== campaign.version) fail('GENESIS_RULES_CHANGED', 'Application terms changed. Please refresh and try again.');
        if (app.status === 'under_review' || app.decision) return null;
        if (existing?.state === 'running' && existing.leaseUntil > now()) return null;
        if (app.checks[task]?.state === 'verified' && (task === 'follow' || app.checks[task]?.postId === postId)) return null;
        app.checks[task] = { state: 'pending', message: 'Checking your X account…', checkedAt: null, ...(postId ? { postId } : {}) }; app.revision++;
        await tx.saveApplication(app);
        await tx.saveJob({ id, applicationId: app.id, xId: app.profile.id, ruleVersion: campaign.version, task, ...(postId ? { postId } : {}), state: 'pending', attempts: 0, nextAt: now(), leaseUntil: 0 }); return id;
      });
      if (id) await processJob(id);
      return me(session);
    },
    async submit(session: OneshotSession, expectedRevision: number) {
      await store.transaction(async tx => {
        const app = owner(await tx.application('userId', session.userId), session);
        if (app.submittedAt) return;
        const campaign = await tx.campaign(); assertOpen(campaign, now());
        if (app.revision !== expectedRevision) fail('GENESIS_REVISION', 'Your application changed. Refresh it before submitting.');
        if (!tasks.every(task => app.checks[task] && app.checks[task]?.state !== 'needs_action')) fail('GENESIS_TASKS_INCOMPLETE', 'Complete the four steps before submitting.');
        app.submittedAt = new Date(now()).toISOString(); app.status = genesisAllVerified(app) ? 'under_review' : 'awaiting_verification'; app.revision++;
        await tx.saveApplication(app); await tx.audit({ at: app.submittedAt, actor: session.userId, action: 'submit', applicationId: app.id });
      }); return me(session);
    },
    async share(session: OneshotSession, enabled: boolean, expectedRevision: number) {
      await store.transaction(async tx => { const app = owner(await tx.application('userId', session.userId), session); if (app.revision !== expectedRevision) fail('GENESIS_REVISION', 'Your application changed. Refresh it before sharing.'); if (enabled && !app.submittedAt) fail('GENESIS_NOT_SUBMITTED', 'Submit your application before sharing its card.'); app.shareConsent = enabled; app.revision++; await tx.saveApplication(app); }); return me(session);
    },
    async shareProfile(code: string) { return store.transaction(async tx => { const app = await tx.application('code', code); return app?.shareConsent && app.submittedAt ? { profile: app.profile, status: app.publishedDecision === 'selected' ? 'Selected for Genesis' : app.publishedDecision === 'reserve' ? 'On the reserve list' : 'Applied for Genesis' } : null; }); },
    async nominate(session: OneshotSession, username: string) {
      const identity = profile(session);
      // The provider lookup is outside the allocation lock; authorization is checked again below.
      await store.transaction(async tx => { const app = owner(await tx.application('userId', session.userId), session); const campaign = await tx.campaign(); assertOpen(campaign, now()); if (!campaign.nominationsOpen || app.publishedDecision !== 'selected' || (app.nominations?.length || 0) >= (app.nominationQuota || 0)) fail('GENESIS_NOMINATION_UNAVAILABLE', 'No nomination is available for this account right now.'); });
      if (!verifier.lookup) fail('GENESIS_UNAVAILABLE', 'Nominee verification is temporarily unavailable. Try again later.', 503);
      const target = await verifier.lookup(username);
      await store.transaction(async tx => {
        const app = owner(await tx.application('userId', session.userId), session); const campaign = await tx.campaign(); assertOpen(campaign, now());
        if (!campaign.nominationsOpen || app.publishedDecision !== 'selected' || (app.nominations?.length || 0) >= (app.nominationQuota || 0)) fail('GENESIS_NOMINATION_UNAVAILABLE', 'No nomination is available for this account right now.');
        if (target.id === identity.id) fail('GENESIS_SELF_NOMINATION', 'Choose another person to nominate.');
        const targetApp = await tx.application('xId', target.id);
        if (targetApp?.decision === 'selected' || await tx.nominator(target.id)) fail('GENESIS_NOMINEE_USED', 'This person already has a place or a nomination.');
        const nomination = { id: randomUUID(), xId: target.id, username: target.username, accepted: false, createdAt: new Date(now()).toISOString() };
        (app.nominations ||= []).push(nomination); app.revision++; await tx.saveApplication(app);
        await tx.audit({ at: nomination.createdAt, actor: session.userId, action: 'nominate', applicationId: app.id, details: { nominationId: nomination.id, xId: target.id } });
      }); return me(session);
    },
    async acceptNomination(session: OneshotSession, nominationId: string) {
      await store.transaction(async tx => {
        const app = owner(await tx.application('userId', session.userId), session); const campaign = await tx.campaign(); assertOpen(campaign, now());
        const from = await tx.nominator(app.profile.id); const nomination = from?.nominations?.find(n => n.id === nominationId && n.xId === app.profile.id);
        if (!campaign.nominationsOpen || !from || !nomination || from.publishedDecision !== 'selected') fail('GENESIS_NOMINATION_UNAVAILABLE', 'This nomination is unavailable.');
        if (nomination.accepted) return;
        if (app.status !== 'under_review' || !genesisAllVerified(app)) fail('GENESIS_NOMINEE_INCOMPLETE', 'Submit an application and complete its checks before accepting.');
        if (app.publishedDecision === 'not_selected') fail('GENESIS_NOMINEE_USED', 'This application already has a published decision.');
        // An independently selected recipient may accept too: release the redundant
        // reservation without awarding a second place to the same account.
        nomination.accepted = true; from.revision++; app.decision = app.publishedDecision = 'selected'; app.revision++;
        await tx.saveApplication(from); await tx.saveApplication(app);
        await tx.audit({ at: new Date(now()).toISOString(), actor: session.userId, action: 'accept_nomination', applicationId: app.id, details: { nominationId } });
      }); return me(session);
    },
    async admin(offset = 0) { return store.transaction(async tx => ({ campaign: await tx.campaign(), applications: await tx.applications(offset, 25), total: await tx.count('total'), selected: await tx.count('selected'), reserved: await tx.count('reserved'), capacity: GENESIS_CAPACITY, offset })); },
    async configure(value: GenesisCampaign, expectedRevision: number, actor: string) {
      const parsed = genesisCampaignSchema.parse(value);
      if (parsed.state === 'open') {
        if (!genesisAuth.available()) fail('GENESIS_AUTH_UNAVAILABLE', 'Configure official X OAuth and its frontend callback before opening applications.', 503);
        if (!parsed.projectXId || !parsed.projectHandle || !parsed.rulesAccepted || !parsed.opensAt || !parsed.closesAt || Date.parse(parsed.closesAt) <= Date.parse(parsed.opensAt) || Date.parse(parsed.closesAt) <= now()) fail('GENESIS_CONFIG_INVALID', 'Set the official X identity, valid application window, and reviewed campaign rules before opening.');
        options.webOrigin();
        const actual = await verifier.project(parsed.projectXId);
        if (actual.toLowerCase() !== parsed.projectHandle.toLowerCase()) fail('GENESIS_PROJECT_MISMATCH', 'The official X ID and handle do not match.');
      }
      return store.transaction(async tx => {
        const old = await tx.campaign(); if (old.revision !== expectedRevision) fail('GENESIS_REVISION', 'Campaign settings changed. Refresh before saving.');
        const termsChanged = ['projectXId','projectHandle','opensAt','closesAt'].some(key => old[key as keyof GenesisCampaign] !== parsed[key as keyof GenesisCampaign]);
        if (termsChanged && await tx.count('total') > 0) fail('GENESIS_RULES_LOCKED', 'Identity and application dates are locked after the first enrollment. Close the campaign before arranging a separately reviewed rule change.');
        const next = { ...parsed, version: old.version + (termsChanged ? 1 : 0), revision: old.revision + 1 };
        await tx.saveCampaign(next); await tx.audit({ at: new Date(now()).toISOString(), actor, action: 'configure', details: next }); return next;
      });
    },
    async review(id: string, input: { expectedRevision: number; decision: GenesisDecision | null; note: string; publish: boolean; nominationQuota?: number }, actor: string) {
      await store.transaction(async tx => {
        const app = await tx.application('id', id); if (!app) fail('GENESIS_NOT_FOUND', 'Application not found.', 404);
        if (app.revision !== input.expectedRevision) fail('GENESIS_REVISION', 'This application changed. Refresh before reviewing.');
        if (!app.submittedAt || app.status !== 'under_review') fail('GENESIS_NOT_REVIEWABLE', 'Only verified, submitted applications can receive a decision.');
        if (app.publishedDecision && app.publishedDecision !== input.decision && !(app.publishedDecision === 'reserve' && input.decision === 'selected')) fail('GENESIS_DECISION_PUBLISHED', 'Published decisions are locked. A correction requires a separate audited recovery.');
        const quota = input.nominationQuota ?? app.nominationQuota ?? 0;
        if (!Number.isInteger(quota) || quota < (app.nominations?.length || 0) || quota > 20 || quota < 0 || quota > 0 && input.decision !== 'selected') fail('GENESIS_QUOTA_INVALID', 'Only selected accounts can receive nomination places. Issued nominations cannot be removed.');
        const selectionDelta = Number(input.decision === 'selected') - Number(app.decision === 'selected');
        if (await tx.count('selected') + await tx.count('reserved') + selectionDelta + quota - (app.nominationQuota || 0) > GENESIS_CAPACITY) fail('GENESIS_CAPACITY', 'All 750 guaranteed places are allocated or reserved for nominations. Use the reserve list.');
        if (input.publish && !input.decision) fail('GENESIS_DECISION_REQUIRED', 'Choose a decision before publishing.');
        app.decision = input.decision; app.nominationQuota = quota; app.note = input.note; if (input.publish) app.publishedDecision = input.decision; app.revision++;
        await tx.saveApplication(app); await tx.audit({ at: new Date(now()).toISOString(), actor, action: input.publish ? 'publish_decision' : 'review', applicationId: id, details: { decision: input.decision } });
      });
    },
    processJob,
    async runJobs() { const jobs = await store.transaction(tx => tx.jobs(3, now())); const results = await Promise.allSettled(jobs.map(job => processJob(job.id))); return { processed: results.filter(result => result.status === 'fulfilled').length }; },
  };
}
export const genesis = createGenesisService({ webOrigin: () => webOrigin('http://127.0.0.1:3000') });
