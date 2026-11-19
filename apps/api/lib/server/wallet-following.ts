import { createHash } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { emptyWalletFollowing, walletFollowingSchema, type WalletFollowing } from '../../../web/lib/wallet-following';
import { profileWallet } from '../../../web/lib/wallet-profile';
import { compareAndSetRecord, getRecord, putIfAbsent } from './store';
import { ApiError } from './errors';
import { boundedBody, json, rateLimit } from './http';
import { requireOneshotSession, type OneshotSession } from './oneshot-auth';

const namespace = 'oneshot_wallet_following';
const recordSchema = z.object({ ownerUserId: z.string(), following: walletFollowingSchema }).strict();
type RecordValue = z.infer<typeof recordSchema>;
const changed = () => new ApiError(409, 'FOLLOWING_CHANGED', 'Your following list changed elsewhere. Reload it before trying again.');
function stored(input: unknown, session: OneshotSession): RecordValue {
  const parsed = recordSchema.safeParse(input);
  if (!parsed.success || parsed.data.ownerUserId !== session.userId || parsed.data.following.revision < 1) throw new ApiError(503, 'FOLLOWING_UNAVAILABLE', 'Your following list could not be loaded. Please try again.');
  return parsed.data;
}
type Dependencies = { get(id: string): Promise<unknown>; create(id: string, value: RecordValue): Promise<unknown>; compare(id: string, previous: RecordValue, next: RecordValue): Promise<boolean>; now(): string };
export function createWalletFollowing(overrides: Partial<Dependencies> = {}) {
  const deps: Dependencies = { get: id => getRecord(namespace, id), create: (id, value) => putIfAbsent(namespace, id, value), compare: (id, previous, next) => compareAndSetRecord(namespace, id, previous, next), now: () => new Date().toISOString(), ...overrides };
  const key = (session: OneshotSession) => createHash('sha256').update(session.userId).digest('hex');
  return {
    async read(session: OneshotSession): Promise<WalletFollowing> { const value = await deps.get(key(session)); return value == null ? emptyWalletFollowing() : stored(value, session).following; },
    async change(walletInput: string, following: boolean, revision: number, session: OneshotSession) {
      let wallet: string; try { wallet = profileWallet(walletInput); } catch { throw new ApiError(400, 'FOLLOWING_INPUT_INVALID', 'Choose a valid Ethereum wallet to follow.'); }
      const id = key(session), value = await deps.get(id), previous = value == null ? null : stored(value, session), selected = previous?.following ?? emptyWalletFollowing();
      if (!Number.isSafeInteger(revision) || revision !== selected.revision || revision >= Number.MAX_SAFE_INTEGER) throw changed();
      const wallets = new Set(selected.wallets); if (following) wallets.add(wallet); else wallets.delete(wallet);
      if (wallets.size > 50) throw new ApiError(409, 'FOLLOWING_LIMIT', 'You can follow up to 50 wallets. Unfollow a wallet before adding another.');
      const next: RecordValue = { ownerUserId: session.userId, following: { revision: revision + 1, wallets: [...wallets].sort(), updatedAt: deps.now() } };
      if (previous) { if (!await deps.compare(id, previous, next)) throw changed(); }
      else {
        const saved = stored(await deps.create(id, next), session);
        if (saved.following.revision !== next.following.revision || JSON.stringify(saved.following.wallets) !== JSON.stringify(next.following.wallets)) throw changed();
        return saved.following;
      }
      return next.following;
    },
  };
}
export const walletFollowing = createWalletFollowing();
export function createWalletFollowingApi(service = walletFollowing, authenticate = requireOneshotSession) {
  return async (request: NextRequest) => {
    if (request.nextUrl.pathname.replace(/\/$/, '') !== '/api/oneshot/following' || request.nextUrl.search) throw new ApiError(404, 'NOT_FOUND', 'Following list not found.');
    const session = await authenticate(request); rateLimit(`oneshot:following:${session.userId}`, request.method === 'GET' ? 120 : 30);
    if (request.method === 'GET') return json(await service.read(session));
    if (request.method === 'PUT') {
      const body = z.object({ wallet: z.string(), following: z.boolean(), expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict().parse(JSON.parse(new TextDecoder().decode(await boundedBody(request, 4096))));
      return json(await service.change(body.wallet, body.following, body.expectedRevision, session));
    }
    throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use the follow controls to update your list.');
  };
}
export const walletFollowingApi = createWalletFollowingApi();
