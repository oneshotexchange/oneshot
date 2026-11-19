import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { accountWalletProfileSchema, emptyWalletProfile, profileWallet, publicWalletProfileSchema, walletProfileDetailsSchema, type AccountWalletProfile, type WalletProfileDetails } from '../../../web/lib/wallet-profile';
import { ApiError } from './errors';
import { assertLinkedEvmAddress, requireOneshotSession, type OneshotSession } from './oneshot-auth';
import { boundedBody, json, rateLimit } from './http';
import { compareAndSetRecord, database, getRecord, withLocalNamespace } from './store';

export const WALLET_PROFILE_NAMESPACE = 'oneshot_wallet_profiles';
const recordSchema = z.object({ schemaVersion: z.literal(1), ownerUserId: z.string().regex(/^did:privy:[a-zA-Z0-9_-]{1,256}$/), account: accountWalletProfileSchema }).strict()
  .refine(value => value.account.revision > 0);
type ProfileRecord = z.infer<typeof recordSchema>;
const changed = () => new ApiError(409, 'PROFILE_CHANGED', 'This profile changed elsewhere. Reload the saved profile before trying again. Your edits are still open.');
const unavailable = () => new ApiError(503, 'PROFILE_UNAVAILABLE', 'This profile could not be loaded. Please try again.');
const inUse = () => new ApiError(403, 'PROFILE_ACCOUNT_MISMATCH', 'This wallet has a profile saved with another account. Sign in to that account or choose another linked wallet.');
function stored(value: unknown, wallet: string): ProfileRecord {
  const parsed = recordSchema.safeParse(value);
  if (!parsed.success || parsed.data.account.wallet !== wallet) throw unavailable();
  return parsed.data;
}

/** The wallet key is unique; account capacity and insertion share one transaction. */
async function createProfile(record: ProfileRecord) {
  const db = database(), wallet = record.account.wallet;
  const full = () => new ApiError(409, 'PROFILE_LIMIT', 'This account has reached its limit of 20 wallet profiles. Use one of your existing profiles.');
  if (!db) return withLocalNamespace<ProfileRecord, void>(WALLET_PROFILE_NAMESPACE, records => {
    if (records[wallet]) throw changed();
    if (Object.values(records).filter(value => value.ownerUserId === record.ownerUserId).length >= 20) throw full();
    records[wallet] = record;
  }, true);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout='5000ms'");
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${WALLET_PROFILE_NAMESPACE}:${record.ownerUserId}`]);
    const count = await client.query("SELECT count(*)::int AS total FROM b20_app_records WHERE namespace=$1 AND value->>'ownerUserId'=$2", [WALLET_PROFILE_NAMESPACE, record.ownerUserId]);
    if (count.rows[0].total >= 20) throw full();
    const result = await client.query('INSERT INTO b20_app_records(namespace,id,value) VALUES($1,$2,$3) ON CONFLICT(namespace,id) DO NOTHING RETURNING id', [WALLET_PROFILE_NAMESPACE, wallet, JSON.stringify(record)]);
    if (!result.rowCount) throw changed();
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
}
type Dependencies = {
  get(wallet: string): Promise<unknown>;
  create(record: ProfileRecord): Promise<void>;
  compare(wallet: string, previous: ProfileRecord, next: ProfileRecord): Promise<boolean>;
  media(id: string): Promise<unknown>;
  now(): string;
};
const defaults: Dependencies = {
  get: wallet => getRecord(WALLET_PROFILE_NAMESPACE, wallet), create: createProfile,
  compare: (wallet, previous, next) => compareAndSetRecord(WALLET_PROFILE_NAMESPACE, wallet, previous, next),
  media: id => getRecord('media', id), now: () => new Date().toISOString(),
};
export function createWalletProfiles(overrides: Partial<Dependencies> = {}) {
  const deps = { ...defaults, ...overrides };
  async function own(walletInput: string, session: OneshotSession) {
    const wallet = assertLinkedEvmAddress(session, walletInput), value = await deps.get(wallet);
    if (value == null) return { wallet, previous: null };
    const previous = stored(value, wallet);
    if (previous.ownerUserId !== session.userId) throw inUse();
    return { wallet, previous };
  }
  async function images(details: WalletProfileDetails) {
    // Assets are already public, sanitized uploads. Sharing an existing asset does
    // not establish copyright or ownership. Never accept/fetch arbitrary URLs.
    for (const path of new Set([details.avatarPath, details.bannerPath])) if (path) {
      const id = path.slice('/api/media/'.length), value = await deps.media(id);
      if (!value || typeof value !== 'object' || !('mimeType' in value) || value.mimeType !== 'image/webp'
        || !('hash' in value) || value.hash !== id.slice(0, -5) || !('size' in value) || typeof value.size !== 'number' || !Number.isSafeInteger(value.size) || value.size <= 0 || value.size > 5 * 1024 * 1024)
        throw new ApiError(400, 'PROFILE_IMAGE_UNAVAILABLE', 'Upload this profile image again, or remove it before saving.');
    }
  }
  async function mutate(walletInput: string, expectedRevision: number, session: OneshotSession, change: (account: AccountWalletProfile) => Promise<AccountWalletProfile>) {
    const { wallet, previous } = await own(walletInput, session), account = previous?.account ?? { wallet, revision: 0, draft: emptyWalletProfile(), published: null, updatedAt: null };
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== account.revision || expectedRevision >= Number.MAX_SAFE_INTEGER) throw changed();
    const nextAccount = accountWalletProfileSchema.parse({ ...await change(account), revision: account.revision + 1, updatedAt: deps.now() });
    const next: ProfileRecord = { schemaVersion: 1, ownerUserId: session.userId, account: nextAccount };
    if (previous) { if (!await deps.compare(wallet, previous, next)) throw changed(); }
    else await deps.create(next);
    return nextAccount;
  }
  return {
    async public(walletInput: string) {
      const wallet = profileWallet(walletInput), value = await deps.get(wallet);
      return { wallet, profile: value == null ? null : stored(value, wallet).account.published };
    },
    async account(walletInput: string, session: OneshotSession): Promise<AccountWalletProfile> {
      const { wallet, previous } = await own(walletInput, session);
      return previous?.account ?? { wallet, revision: 0, draft: emptyWalletProfile(), published: null, updatedAt: null };
    },
    async save(wallet: string, revision: number, input: unknown, session: OneshotSession) {
      const details = walletProfileDetailsSchema.safeParse(input);
      if (!details.success) throw new ApiError(400, 'PROFILE_INPUT_INVALID', 'Check the profile name, bio, website and images before saving.');
      return mutate(wallet, revision, session, async account => { await images(details.data); return { ...account, draft: details.data }; });
    },
    async publish(wallet: string, revision: number, session: OneshotSession) {
      return mutate(wallet, revision, session, async account => {
        const published = publicWalletProfileSchema.safeParse({ ...account.draft, wallet: account.wallet, publishedAt: deps.now() });
        if (!published.success) throw new ApiError(400, 'PROFILE_NAME_REQUIRED', 'Add a display name and save your changes before publishing.');
        await images(account.draft);
        return { ...account, published: published.data };
      });
    },
    async unpublish(wallet: string, revision: number, session: OneshotSession) {
      return mutate(wallet, revision, session, async account => ({ ...account, published: null }));
    },
  };
}
export const walletProfiles = createWalletProfiles();
const mutation = z.object({ wallet: z.string(), expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict();
export function createWalletProfilesApi(service = walletProfiles, authenticate = requireOneshotSession) {
  return async (request: NextRequest) => {
    let parts: string[];
    try { parts = request.nextUrl.pathname.slice('/api/oneshot/profiles'.length).replace(/^\//, '').replace(/\/$/, '').split('/').map(decodeURIComponent); }
    catch { throw new ApiError(400, 'PROFILE_INPUT_INVALID', 'Check the profile address and try again.'); }
    if (parts.length === 1 && parts[0] !== 'me' && /^0x[\da-fA-F]{40}$/.test(parts[0]) && request.method === 'GET') {
      if (request.nextUrl.search) throw new ApiError(400, 'PROFILE_INPUT_INVALID', 'Use a wallet profile address without additional filters.');
      rateLimit('oneshot:profiles:public', 120);
      if (/^0x0{40}$/i.test(parts[0])) throw new ApiError(400, 'PROFILE_INPUT_INVALID', 'Use a nonzero Ethereum wallet address.');
      return json(await service.public(parts[0]));
    }
    if (parts[0] !== 'me' || parts.length > 2 || parts.length === 2 && parts[1] !== 'publish') throw new ApiError(404, 'NOT_FOUND', 'Profile not found.');
    const session = await authenticate(request);
    rateLimit(`oneshot:profiles:${session.userId}`, request.method === 'GET' ? 120 : 30);
    if (parts.length === 1 && request.method === 'GET') {
      const query = request.nextUrl.searchParams;
      if ([...query.keys()].some(key => key !== 'wallet') || query.getAll('wallet').length !== 1) throw new ApiError(400, 'PROFILE_INPUT_INVALID', 'Choose one linked wallet to edit its profile.');
      return json(await service.account(query.get('wallet')!, session));
    }
    if (request.nextUrl.search) throw new ApiError(400, 'PROFILE_INPUT_INVALID', 'Remove extra profile filters and try again.');
    if (parts.length === 1 && request.method === 'PUT') {
      const body = mutation.extend({ profile: z.unknown() }).parse(JSON.parse(new TextDecoder().decode(await boundedBody(request, 16384))));
      return json(await service.save(body.wallet, body.expectedRevision, body.profile, session));
    }
    if (parts.length === 2 && ['POST', 'DELETE'].includes(request.method)) {
      const body = mutation.parse(JSON.parse(new TextDecoder().decode(await boundedBody(request, 4096))));
      return json(await service[request.method === 'POST' ? 'publish' : 'unpublish'](body.wallet, body.expectedRevision, session));
    }
    throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use the profile form to save or publish changes.');
  };
}
export const walletProfilesApi = createWalletProfilesApi();
