import { createHash, randomBytes } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { ApiError, boundedBody, json, rateLimit } from './http';
import { webOrigin } from './origins';
import { genesisAuthStore, type GenesisAuthStore } from './genesis-auth-store';
import { genesisStore, type GenesisStore } from './genesis-store';
import { requireOneshotSession, type OneshotSession } from './oneshot-auth';
import type { GenesisProfile } from '../../../web/lib/genesis-schema';

export type GenesisSession = Omit<OneshotSession, 'provider'> & { provider: 'privy' | 'x' };
const sessionCookie = 'oneshot_genesis_session';
const browserCookie = 'oneshot_genesis_oauth';
const opaque = /^[A-Za-z0-9_-]{43}$/;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const sessionLifetime = 30 * 86_400_000;
const message = 'X sign-in could not finish. Please connect X again.';
const identitySchema = z.object({ data: z.object({ id: z.string().regex(/^\d{1,32}$/), username: z.string().regex(/^[A-Za-z0-9_]{1,15}$/), name: z.string().max(200).optional(), profile_image_url: z.string().optional() }) });
type Environment = Record<string, string | undefined>;
function configuration(env: Environment) {
  const clientId = env.X_OAUTH_CLIENT_ID;
  if (!clientId || clientId.length > 512 || /[\s\u0000-\u001f]/.test(clientId)) return null;
  const redirectUri = webOrigin('http://127.0.0.1:3000', env) + '/api/oneshot/genesis/auth/callback';
  if (env.X_OAUTH_REDIRECT_URI && env.X_OAUTH_REDIRECT_URI !== redirectUri) return null;
  return { clientId, clientSecret: env.X_OAUTH_CLIENT_SECRET || undefined, redirectUri };
}
function denied() { return new ApiError(401, 'GENESIS_AUTH_REQUIRED', 'Connect X to view your application.'); }
function profile(value: unknown): GenesisProfile {
  const parsed = identitySchema.safeParse(value);
  if (!parsed.success) throw new ApiError(503, 'GENESIS_AUTH_UNAVAILABLE', message);
  const user = parsed.data.data; let avatarUrl: string | null = null;
  try { const url = new URL(user.profile_image_url || ''); if (url.protocol === 'https:' && url.hostname === 'pbs.twimg.com' && !url.username && !url.password && !url.port) avatarUrl = url.toString(); } catch { /* Optional public avatar. */ }
  return { id: user.id, username: user.username, name: user.name || user.username, avatarUrl };
}
async function readJson(response: Response) {
  if (!response.ok) throw new ApiError(503, 'GENESIS_AUTH_UNAVAILABLE', message);
  const data = await boundedBody(response, 65_536);
  try { return JSON.parse(new TextDecoder().decode(data)) as unknown; } catch { throw new ApiError(503, 'GENESIS_AUTH_UNAVAILABLE', message); }
}
export function createGenesisAuth(options: { store?: GenesisAuthStore; applications?: GenesisStore; environment?: () => Environment; fetcher?: typeof fetch; now?: () => number } = {}) {
  const store = options.store || genesisAuthStore; const applications = options.applications || genesisStore;
  const environment = options.environment || (() => process.env); const fetcher = options.fetcher || fetch; const now = options.now || Date.now;
  function config() { const value = configuration(environment()); if (!value) throw new ApiError(503, 'GENESIS_AUTH_UNAVAILABLE', 'X sign-in is temporarily unavailable. Please try again later.'); return value; }
  async function authenticate(request: NextRequest): Promise<GenesisSession> {
    const token = request.cookies.get(sessionCookie)?.value;
    if (!token) {
      // Existing Privy applications retain their authenticated API access. A direct
      // X session never authorizes wallet or creator APIs elsewhere in oneshot.
      if (/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/i.test(request.headers.get('authorization') || '')) return requireOneshotSession(request);
      throw denied();
    }
    if (!opaque.test(token)) throw denied();
    const result = await store.transaction(async tx => {
      const session = await tx.session(hash(token));
      if (!session || session.expiresAt <= now()) throw denied();
      const identity = await tx.identity(session.xId); if (!identity) throw denied();
      return { session, identity };
    });
    // Recover an existing application by its verified X ID, preserving its original
    // owner and saved progress without granting access to the old owner's wallets.
    const app = await applications.transaction(tx => tx.application('xId', result.identity.id));
    return { provider: 'x', userId: app?.userId || `x:${result.identity.id}`, sessionId: hash(token).slice(0,32), expiresAt: Math.floor(result.session.expiresAt / 1000), linkedAddresses: [], xAccount: result.identity };
  }
  function assertOrigin(request: NextRequest) {
    if (request.headers.get('origin') !== webOrigin('http://127.0.0.1:3000', environment())) throw new ApiError(403, 'ORIGIN_MISMATCH', 'Return to oneshot and try again.');
  }
  return {
    authenticate,
    assertWrite(request: NextRequest) { if (request.cookies.has(sessionCookie) && !['GET','HEAD'].includes(request.method)) assertOrigin(request); },
    available() { try { return configuration(environment()) !== null; } catch { return false; } },
    async start(referral?: string) {
      if (referral && !/^[A-Za-z0-9_-]{16}$/.test(referral)) throw new ApiError(400,'GENESIS_REFERRAL_INVALID','Use a valid Genesis invitation.');
      const conf = config(); const state = randomBytes(32).toString('base64url'); const browser = randomBytes(32).toString('base64url'); const verifier = randomBytes(32).toString('base64url');
      await store.transaction(async tx => { await tx.prune(now()); await tx.state(hash(state), { verifier, browserHash: hash(browser), expiresAt: now() + 600_000, ...(referral?{referral}:{}) }); });
      const url = new URL('https://x.com/i/oauth2/authorize');
      Object.entries({ response_type: 'code', client_id: conf.clientId, redirect_uri: conf.redirectUri, scope: 'users.read tweet.read', state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).forEach(([key,value]) => url.searchParams.set(key,value));
      return { url: url.href, browser };
    },
    async callback(code: string, state: string, browser: string) {
      const conf = config();
      if (!opaque.test(state) || !opaque.test(browser) || !code || code.length > 2048) throw new ApiError(400, 'GENESIS_AUTH_INVALID', message);
      const saved = await store.transaction(tx => tx.consume(hash(state), hash(browser), now()));
      if (!saved) throw new ApiError(400, 'GENESIS_AUTH_EXPIRED', message);
      const token = z.object({ access_token: z.string().min(1).max(8192) }).parse(await readJson(await fetcher('https://api.x.com/2/oauth2/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(conf.clientSecret ? { Authorization: `Basic ${Buffer.from(`${conf.clientId}:${conf.clientSecret}`).toString('base64')}` } : {}) },
        body: new URLSearchParams({ code, grant_type: 'authorization_code', client_id: conf.clientId, redirect_uri: conf.redirectUri, code_verifier: saved.verifier }).toString(), redirect: 'error', signal: AbortSignal.timeout(8000),
      })));
      const identity = profile(await readJson(await fetcher('https://api.x.com/2/users/me?user.fields=profile_image_url', { headers: { Authorization: `Bearer ${token.access_token}` }, redirect: 'error', signal: AbortSignal.timeout(8000) })));
      const cookie = randomBytes(32).toString('base64url'); const expiresAt = now() + sessionLifetime;
      await store.transaction(async tx => { await tx.saveIdentity(identity); await tx.saveSession(hash(cookie), { xId: identity.id, expiresAt }); });
      // X access tokens are discarded. Only a hash of the opaque oneshot session is
      // persisted; the session secret is delivered in a host-only HttpOnly cookie.
      return { cookie, expiresAt, referral: saved.referral };
    },
    async route(request: NextRequest): Promise<Response | null> {
      const path = request.nextUrl.pathname.replace(/\/$/,'').split('/auth/')[1]; if (!path) return null;
      const secure = environment().NODE_ENV === 'production';
      const cookieOptions = { httpOnly: true, secure, sameSite: 'lax' as const, path: '/api/oneshot/genesis' };
      if (path === 'session' && request.method === 'GET') {
        rateLimit('genesis:auth:session',300);
        let session: GenesisSession | null = null;
        try { if (request.cookies.has(sessionCookie)) session = await authenticate(request); }
        catch (error) { if (!(error instanceof ApiError) || error.status !== 401) throw error; }
        return json({ available: this.available(), user: session ? { userId: session.userId, sessionId: session.sessionId, expiresAt: session.expiresAt, profile: session.xAccount } : null });
      }
      if (path === 'start' && request.method === 'POST') {
        assertOrigin(request); rateLimit('genesis:auth:start',120);
        const input=z.object({referral:z.string().regex(/^[A-Za-z0-9_-]{16}$/).optional()}).strict().parse(JSON.parse(new TextDecoder().decode(await boundedBody(request,1024))));
        const started = await this.start(input.referral); const response = NextResponse.json({ url: started.url }, { headers: { 'Cache-Control': 'no-store' } });
        response.cookies.set(browserCookie, started.browser, { ...cookieOptions, path: '/api/oneshot/genesis/auth', maxAge: 600 }); return response;
      }
      if (path === 'callback' && request.method === 'GET') {
        rateLimit('genesis:auth:callback',120);
        const destination = new URL('/whitelist', webOrigin('http://127.0.0.1:3000',environment()));
        let result: Awaited<ReturnType<typeof this.callback>> | null = null;
        try {
          const query = request.nextUrl.searchParams;
          if (query.has('error') || query.getAll('code').length !== 1 || query.getAll('state').length !== 1) throw new Error('Cancelled');
          result = await this.callback(query.get('code') || '', query.get('state') || '', request.cookies.get(browserCookie)?.value || '');
          if(result.referral)destination.searchParams.set('ref',result.referral);
        } catch { destination.searchParams.set('x_login','failed'); }
        const response = NextResponse.redirect(destination,303); response.headers.set('Cache-Control','no-store'); response.headers.set('Referrer-Policy','no-referrer');
        response.cookies.set(browserCookie,'',{...cookieOptions,path:'/api/oneshot/genesis/auth',maxAge:0});
        if (result) response.cookies.set(sessionCookie,result.cookie,{...cookieOptions,maxAge:sessionLifetime/1000}); return response;
      }
      if (path === 'logout' && request.method === 'POST') {
        assertOrigin(request); const token = request.cookies.get(sessionCookie)?.value;
        if (token && opaque.test(token) && request.headers.get('X-Genesis-Session') !== hash(token).slice(0,32)) throw new ApiError(401,'GENESIS_AUTH_CHANGED','Your X sign-in changed. Refresh the page before continuing.');
        if (token && opaque.test(token)) await store.transaction(tx => tx.revoke(hash(token)));
        const response = NextResponse.json({ok:true},{headers:{'Cache-Control':'no-store'}}); response.cookies.set(sessionCookie,'',{...cookieOptions,maxAge:0}); return response;
      }
      throw new ApiError(404,'NOT_FOUND','This sign-in action is unavailable.');
    },
  };
}
export const genesisAuth = createGenesisAuth();
