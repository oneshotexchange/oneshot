import { z } from 'zod';

export const GENESIS_CAPACITY = 750;
export const GENESIS_CONSENT_VERSION = '2026-11-04';
export const genesisCampaignSchema = z.object({
  revision: z.number().int().positive().default(1),
  version: z.number().int().positive().default(1),
  state: z.enum(['upcoming', 'open', 'closed']).default('upcoming'),
  opensAt: z.string().datetime().nullable().default(null),
  closesAt: z.string().datetime().nullable().default(null),
  projectXId: z.string().regex(/^\d{1,32}$/).or(z.literal('')).default(''),
  projectHandle: z.string().regex(/^[A-Za-z0-9_]{1,15}$/).or(z.literal('')).default(''),
  rulesAccepted: z.boolean().default(false),
  nominationsOpen: z.boolean().default(false),
  dailyReadLimit: z.number().int().min(0).max(100_000).default(1000),
}).strict();
export type GenesisCampaign = z.infer<typeof genesisCampaignSchema>;
export type GenesisProfile = { id: string; username: string; name: string; avatarUrl: string | null };
export type GenesisTask = 'follow' | 'post' | 'share';
export const genesisTaskSchema = z.enum(['follow', 'post', 'share']);
export type GenesisCheck = {
  state: 'pending' | 'verified' | 'needs_action' | 'temporarily_unavailable';
  message: string; checkedAt: string | null; postId?: string;
  metrics?: { likes: number | null; reposts: number | null; replies: number | null; views: number | null };
};
export type GenesisDecision = 'selected' | 'reserve' | 'not_selected';
export type GenesisNomination = { id: string; xId: string; username: string; accepted: boolean; createdAt: string };
export type GenesisApplication = {
  id: string; userId: string; profile: GenesisProfile; code: string; referrerId: string | null;
  createdAt: string; submittedAt: string | null; revision: number; ruleVersion: number;
  status: 'draft' | 'awaiting_verification' | 'under_review';
  checks: Partial<Record<GenesisTask, GenesisCheck>>;
  decision: GenesisDecision | null; publishedDecision: GenesisDecision | null;
  note: string; shareConsent: boolean; consentVersion: string;
  nominationQuota?: number; nominations?: GenesisNomination[];
};
export type GenesisPublicCampaign = {
  state: 'upcoming' | 'open' | 'closed'; capacity: number; opensAt: string | null; closesAt: string | null;
  projectHandle: string | null; version: number;
};
export type GenesisMe = {
  profile: GenesisProfile | null;
  application: Omit<GenesisApplication, 'userId' | 'referrerId' | 'note' | 'decision' | 'consentVersion'> | null;
  qualifiedReferrals: number; referralUrl: string | null; shareUrl: string | null;
  nomination?: { id: string; from: string; accepted: boolean } | null;
  nominationsOpen?: boolean;
};
export const genesisEnrollSchema = z.object({ consentVersion: z.literal(GENESIS_CONSENT_VERSION), referral: z.string().regex(/^[A-Za-z0-9_-]{16}$/).optional() }).strict();
export const genesisVerifySchema = z.object({ task: genesisTaskSchema, postUrl: z.string().max(512).optional() }).strict();
export const genesisRevisionSchema = z.object({ expectedRevision: z.number().int().positive() }).strict();
export const genesisReviewSchema = genesisRevisionSchema.extend({ decision: z.enum(['selected', 'reserve', 'not_selected']).nullable(), note: z.string().max(2000), publish: z.boolean(), nominationQuota: z.number().int().min(0).max(20).optional() }).strict();

/** Parse only a post ID, never a fetchable user-controlled URL. */
export function genesisPostId(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname)) return null;
    return /^\/(?:[A-Za-z0-9_]{1,15}|i\/web)\/status\/(\d{1,32})\/?$/.exec(url.pathname)?.[1] || null;
  } catch { return null; }
}
export function genesisAllVerified(app: Pick<GenesisApplication, 'checks'>) {
  return (['follow', 'post', 'share'] as const).every(task => app.checks[task]?.state === 'verified');
}
export function genesisDisplayStatus(app: Pick<GenesisApplication, 'publishedDecision' | 'status'>) {
  if (app.publishedDecision === 'selected') return 'Selected';
  if (app.publishedDecision === 'reserve') return 'Reserve list';
  if (app.publishedDecision === 'not_selected') return 'Not selected';
  return app.status === 'under_review' ? 'Under review' : app.status === 'awaiting_verification' ? 'Checks pending' : 'Application started';
}
