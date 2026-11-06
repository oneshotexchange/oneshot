import { z } from 'zod';
import { customerErrorDetails, customerFetch, customerResponseJson } from './customer-http';
import type { GenesisMe, GenesisPublicCampaign } from './genesis-schema';

const profile = z.object({ id: z.string().regex(/^\d{1,32}$/), username: z.string(), name: z.string(), avatarUrl: z.string().nullable() });
const check = z.object({ state: z.enum(['pending','verified','needs_action','temporarily_unavailable']), message: z.string(), checkedAt: z.string().nullable(), postId: z.string().optional(), metrics: z.object({ likes: z.number().nullable(), reposts: z.number().nullable(), replies: z.number().nullable(), views: z.number().nullable() }).optional() });
const application = z.object({ id: z.string().uuid(), profile, code: z.string().regex(/^[A-Za-z0-9_-]{16}$/), createdAt: z.string(), submittedAt: z.string().nullable(), revision: z.number().int().positive(), ruleVersion: z.number().int().positive(), status: z.enum(['draft','awaiting_verification','under_review']), checks: z.object({ follow: check.optional(), post: check.optional(), share: check.optional() }), publishedDecision: z.enum(['selected','reserve','not_selected']).nullable(), shareConsent: z.boolean(), nominationQuota:z.number().int().nonnegative().optional(), nominations:z.array(z.object({ id:z.string().uuid(),xId:z.string(),username:z.string(),accepted:z.boolean(),createdAt:z.string() })).optional() });
export const genesisMeResponse = z.object({ profile: profile.nullable(), application: application.nullable(), qualifiedReferrals: z.number().int().nonnegative(), referralUrl: z.string().url().nullable(), shareUrl: z.string().url().nullable(), nomination:z.object({id:z.string().uuid(),from:z.string(),accepted:z.boolean()}).nullable().optional(),nominationsOpen:z.boolean().optional() });
export const genesisCampaignResponse = z.object({ state: z.enum(['upcoming','open','closed']), capacity: z.literal(750), opensAt: z.string().nullable(), closesAt: z.string().nullable(), projectHandle: z.string().nullable(), version: z.number().int().positive() });
export async function genesisRequest<T>(path: string, options: { body?: unknown; token?: string | null; sessionId?: string | null; signal?: AbortSignal; schema: z.ZodType<T> }): Promise<T> {
  const response = await customerFetch('/api/oneshot/genesis/' + path, {
    method: options.body === undefined ? 'GET' : 'POST', cache: 'no-store', credentials: 'same-origin', redirect: 'error', signal: options.signal,
    headers: { ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}), ...(options.sessionId ? {'X-Genesis-Session':options.sessionId} : {}), ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const body = await customerResponseJson(response, { signal: options.signal });
  if (!response.ok) throw new Error(customerErrorDetails(body).message || 'Your application could not be loaded. Please try again.');
  const parsed = options.schema.safeParse(body);
  if (!parsed.success) throw new Error('Your application could not be read. Please try again.');
  return parsed.data;
}
export const loadGenesisCampaign = (signal?: AbortSignal): Promise<GenesisPublicCampaign> => genesisRequest('campaign', { schema: genesisCampaignResponse, signal });
export async function genesisAccountRequest(path: string, options: { body?: unknown; getToken(): Promise<string | null>; sessionId?: string | null; scope(): string | null; signal?: AbortSignal }): Promise<GenesisMe> {
  const scope = options.scope(); if (!scope) throw new Error('Sign in to view your application.');
  const token = await options.getToken();
  if (scope !== options.scope()) throw new Error('Your account changed. Please try again.');
  const result = await genesisRequest(path, { schema: genesisMeResponse, token, sessionId: options.sessionId, body: options.body, signal: options.signal });
  if (scope !== options.scope()) throw new Error('Your account changed. Please try again.');
  return result;
}

const referralKey = 'oneshot.genesis.invitation';
export function readGenesisReferral(search: string, storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>): string | null {
  const value = new URLSearchParams(search).get('ref');
  if (value !== null) {
    if (!/^[A-Za-z0-9_-]{16}$/.test(value)) { clearGenesisReferral(storage); return null; }
    try { storage?.setItem(referralKey, value); } catch { /* The URL still preserves attribution. */ }
    return value;
  }
  try { const saved = storage?.getItem(referralKey); return saved && /^[A-Za-z0-9_-]{16}$/.test(saved) ? saved : null; } catch { return null; }
}
export function clearGenesisReferral(storage?: Pick<Storage, 'removeItem'>) { try { storage?.removeItem(referralKey); } catch { /* Optional storage. */ } }
