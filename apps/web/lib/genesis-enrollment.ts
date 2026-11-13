import { genesisAccountRequest } from './client-genesis-api';
import { GENESIS_CONSENT_VERSION, type GenesisMe, type GenesisPublicCampaign } from './genesis-schema';

type EnrollmentInput = {
  scope: string | null;
  currentScope(): string | null;
  authReady: boolean;
  verifiedProfileId: string | null;
  campaign: GenesisPublicCampaign | null;
  campaignLoading: boolean;
  campaignError: boolean;
  account: { scope: string; data: GenesisMe } | null;
  accountLoading: boolean;
  accountError: boolean;
  busy: boolean;
  referral: string | null;
  sessionId: string | null;
  getToken(): Promise<string | null>;
  onStart(): void;
};
type EnrollmentResult = { state: 'skipped' } | { state: 'saved'; scope: string; data: GenesisMe } | { state: 'failed' | 'stale'; scope: string };

// An account/session gets one automatic attempt. Re-renders, focus refreshes and
// StrictMode effect replays cannot turn a failed request into a retry loop.
export function createGenesisEnrollment() {
  const attempted = new Set<string>();
  const active = new Set<string>();
  return {
    async start(input: EnrollmentInput, retry = false): Promise<EnrollmentResult> {
      const { scope, account, campaign } = input;
      if (!scope || input.currentScope() !== scope || !input.authReady || !input.verifiedProfileId
        || input.campaignLoading || input.campaignError || campaign?.state !== 'open'
        || input.accountLoading || input.accountError || account?.scope !== scope
        || !account.data.profile || account.data.profile.id !== input.verifiedProfileId || account.data.application
        || input.busy || active.has(scope) || (!retry && attempted.has(scope))) return { state: 'skipped' };
      attempted.add(scope); active.add(scope);
      try {
        input.onStart();
        const data = await genesisAccountRequest('enroll', {
          body: { consentVersion: GENESIS_CONSENT_VERSION, ...(input.referral ? { referral: input.referral } : {}) },
          sessionId: input.sessionId, getToken: input.getToken, scope: input.currentScope,
        });
        if (!data.application || data.profile?.id !== input.verifiedProfileId || data.application.profile.id !== input.verifiedProfileId) throw new Error('The application response is incomplete.');
        return input.currentScope() === scope ? { state: 'saved', scope, data } : { state: 'stale', scope };
      } catch {
        return { state: input.currentScope() === scope ? 'failed' : 'stale', scope };
      } finally { active.delete(scope); }
    },
  };
}
