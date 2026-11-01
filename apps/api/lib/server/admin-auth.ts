import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ApiError } from './errors';

type Environment = Record<string, string | undefined>;
export type AdminSession = { expiresAt: number };
export type AdminCredentials = AdminSession & { token: string };
const SESSION_LIFETIME_MS = 30 * 60_000;
const MAX_SESSIONS = 128;
const digest = (value: string) => createHash('sha256').update(value).digest();

/** Credentials and bearer sessions remain server-side and are never cookies or browser drafts. */
export function createAdminAuthenticator(dependencies: { environment?: () => Environment; now?: () => number } = {}) {
  const environment = dependencies.environment || (() => process.env);
  const now = dependencies.now || (() => Date.now());
  const sessions = new Map<string, AdminSession>();
  let passwordFingerprint: string | null = null;

  function configuration() {
    const password = environment().ONESHOT_ADMIN_PASSWORD;
    const configured = typeof password === 'string' && password.trim().length >= 16 && password.length <= 1024;
    const hash = configured ? digest(password) : null;
    const fingerprint = hash?.toString('hex') || null;
    if (fingerprint !== passwordFingerprint) { sessions.clear(); passwordFingerprint = fingerprint; }
    for (const [key, session] of sessions) if (session.expiresAt <= now()) sessions.delete(key);
    if (!hash) throw new ApiError(503, 'ADMIN_UNAVAILABLE', 'Admin access is unavailable.');
    return hash;
  }

  function bearer(request: Request) {
    const value = request.headers.get('authorization');
    const token = value?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    if (!token) throw new ApiError(401, 'ADMIN_AUTH_REQUIRED', 'Sign in to access admin settings.');
    return digest(token).toString('hex');
  }

  function requireSession(request: Request): AdminSession {
    configuration();
    const session = sessions.get(bearer(request));
    if (!session) throw new ApiError(401, 'ADMIN_AUTH_REQUIRED', 'Your admin session expired. Sign in again.');
    return { expiresAt: session.expiresAt };
  }

  return {
    assertConfigured() { configuration(); },
    signIn(password: unknown): AdminCredentials {
      const expected = configuration();
      const candidate = typeof password === 'string' && password.length <= 1024 ? password : '';
      if (!timingSafeEqual(expected, digest(candidate))) throw new ApiError(401, 'ADMIN_PASSWORD_INVALID', 'Incorrect admin password.');
      while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value!);
      const token = randomBytes(32).toString('base64url');
      const session = { expiresAt: now() + SESSION_LIFETIME_MS };
      sessions.set(digest(token).toString('hex'), session);
      return { token, ...session };
    },
    requireSession,
    revoke(request: Request) {
      requireSession(request);
      sessions.delete(bearer(request));
    },
  };
}

// Share the bounded in-memory store across development module reloads in this process.
const processState = globalThis as typeof globalThis & { __oneshotAdminAuthenticator?: ReturnType<typeof createAdminAuthenticator> };
export const adminAuthenticator = processState.__oneshotAdminAuthenticator ||= createAdminAuthenticator();
