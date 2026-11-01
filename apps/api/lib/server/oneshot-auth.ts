import { ApiError } from './errors';
import { createPrivyIdentityVerifier, InvalidPrivyAccessTokenError, type PrivyIdentityVerifier } from './privy-verifier';

export type OneshotSession = {
  provider: 'privy';
  userId: string;
  sessionId: string;
  /** Access-token expiry, in Unix seconds. No token or server secret is returned. */
  expiresAt: number;
  linkedAddresses: `0x${string}`[];
};

type Environment = Record<string, string | undefined>;
type AuthConfiguration = { appId: string; appSecret: string };
type AuthDependencies = {
  environment?: () => Environment;
  verifier?: (configuration: AuthConfiguration) => PrivyIdentityVerifier;
  now?: () => number;
};

function configuration(env: Environment): AuthConfiguration | null {
  const appId = env.PRIVY_APP_ID;
  const appSecret = env.PRIVY_APP_SECRET;
  if (!appId || !/^[a-zA-Z0-9_-]{1,128}$/.test(appId) || !appSecret || appSecret.trim() !== appSecret) return null;
  if (env.NEXT_PUBLIC_PRIVY_APP_ID && env.NEXT_PUBLIC_PRIVY_APP_ID !== appId) return null;
  return { appId, appSecret };
}

/** Configuration completeness only; this is not a successful authentication probe. */
export function oneshotAuthStatus(env: Environment = process.env) {
  const configured = configuration(env) !== null;
  return { provider: 'privy' as const, configured, reason: configured ? null : 'Matching Privy app IDs and a server app secret are required.' };
}

let cached: { appId: string; appSecret: string; verifier: PrivyIdentityVerifier } | undefined;
function defaultVerifier(config: AuthConfiguration): PrivyIdentityVerifier {
  if (!cached || cached.appId !== config.appId || cached.appSecret !== config.appSecret) {
    cached = { ...config, verifier: createPrivyIdentityVerifier(config.appId, config.appSecret) };
  }
  return cached.verifier;
}

function bearer(request: Pick<Request, 'headers'>): string {
  const value = request.headers.get('authorization');
  // Accept exactly one compact JWT. Ignore legacy cookies, query strings and body addresses.
  const match = value && /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(value);
  if (!match || match[1].length > 8_192) throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in to oneshot.');
  return match[1];
}

function unauthorized(): ApiError {
  return new ApiError(401, 'AUTH_INVALID', 'Your sign-in session is invalid or expired. Sign in again.');
}

export function normalizeEvmAddress(value: unknown): `0x${string}` {
  if (typeof value !== 'string' || !/^0x[\da-fA-F]{40}$/.test(value) || /^0x0{40}$/.test(value)) {
    throw new ApiError(400, 'INVALID_EVM_ADDRESS', 'Use a nonzero 20-byte Ethereum address.');
  }
  return value.toLowerCase() as `0x${string}`;
}

/** A requested creator/sender must belong to the current server-verified identity. */
export function assertLinkedEvmAddress(session: OneshotSession, value: unknown): `0x${string}` {
  const address = normalizeEvmAddress(value);
  if (!session.linkedAddresses.includes(address)) throw new ApiError(403, 'WALLET_NOT_LINKED', 'Choose an Ethereum wallet linked to your account.');
  return address;
}

export function createOneshotAuthenticator(dependencies: AuthDependencies = {}) {
  const environment = dependencies.environment || (() => process.env);
  const verifier = dependencies.verifier || defaultVerifier;
  const now = dependencies.now || (() => Math.floor(Date.now() / 1_000));
  return async function authenticate(request: Pick<Request, 'headers'>): Promise<OneshotSession> {
    const config = configuration(environment());
    if (!config) throw new ApiError(503, 'AUTH_NOT_CONFIGURED', 'Privy authentication is not configured for oneshot.');
    const token = bearer(request);
    let adapter: PrivyIdentityVerifier;
    let claims: Awaited<ReturnType<PrivyIdentityVerifier['verifyAccessToken']>>;
    try {
      adapter = verifier(config);
      claims = await adapter.verifyAccessToken(token);
    } catch (error) {
      if (error instanceof InvalidPrivyAccessTokenError) throw unauthorized();
      throw new ApiError(503, 'AUTH_PROVIDER_UNAVAILABLE', 'Privy authentication is temporarily unavailable. Please retry.');
    }
    if (claims.app_id !== config.appId || claims.issuer !== 'privy.io'
        || !Number.isSafeInteger(claims.expiration) || claims.expiration <= now()
        || !Number.isSafeInteger(claims.issued_at) || claims.issued_at <= 0 || claims.issued_at > now() + 60
        || claims.expiration <= claims.issued_at
        || typeof claims.user_id !== 'string' || !/^did:privy:[a-zA-Z0-9_-]{1,256}$/.test(claims.user_id)
        || typeof claims.session_id !== 'string' || claims.session_id.length === 0 || claims.session_id.length > 256) {
      throw unauthorized();
    }
    let user: unknown;
    try { user = await adapter.getUser(claims.user_id); }
    catch (error) {
      if (error instanceof InvalidPrivyAccessTokenError) throw unauthorized();
      throw new ApiError(503, 'AUTH_PROVIDER_UNAVAILABLE', 'Privy identity lookup is temporarily unavailable. Please retry.');
    }
    if (!user || typeof user !== 'object') throw new ApiError(503, 'AUTH_PROVIDER_UNAVAILABLE', 'Privy returned an unavailable identity. Please retry.');
    const profile = user as Record<string, unknown>;
    if (profile.id !== claims.user_id || profile.frozen_at != null || claims.expiration <= now()) throw unauthorized();
    if (!Array.isArray(profile.linked_accounts)) throw new ApiError(503, 'AUTH_PROVIDER_UNAVAILABLE', 'Privy returned an unavailable identity. Please retry.');
    const addresses = new Set<`0x${string}`>();
    for (const linked of profile.linked_accounts) {
      if (!linked || typeof linked !== 'object') continue;
      const account = linked as Record<string, unknown>;
      // Only verified Ethereum wallet accounts are in scope. Email, Solana, cross-app
      // accounts and smart-account deployment assumptions are not wallet authorization.
      if (account.type !== 'wallet' || account.chain_type !== 'ethereum'
          || typeof account.verified_at !== 'number' || !Number.isFinite(account.verified_at) || account.verified_at <= 0) continue;
      try { addresses.add(normalizeEvmAddress(account.address)); }
      catch { /* Ignore malformed provider wallet records instead of authorizing them. */ }
    }
    return { provider: 'privy', userId: claims.user_id, sessionId: claims.session_id, expiresAt: claims.expiration, linkedAddresses: [...addresses] };
  };
}

export const requireOneshotSession = createOneshotAuthenticator();
