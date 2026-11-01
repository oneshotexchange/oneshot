import { InvalidAuthTokenError, NotFoundError, PrivyClient, verifyAccessToken, type VerifyAccessTokenResponse } from '@privy-io/node';
import { createRemoteJWKSet, errors, type JWTVerifyGetKey } from 'jose';

export class InvalidPrivyAccessTokenError extends Error {}
export class PrivyIdentityUnavailableError extends Error {}

export type PrivyIdentityVerifier = {
  verifyAccessToken(token: string): Promise<VerifyAccessTokenResponse>;
  getUser(userId: string): Promise<unknown>;
};

type VerifierOptions = {
  resolveVerificationKey?: JWTVerifyGetKey;
  lookupUser?: (userId: string) => Promise<unknown>;
};

/** SDK verification pins ES256, issuer, audience and expiry. Only the official public
 * app JWKS is used. The wrapper preserves key-service failures because the SDK otherwise
 * converts both invalid tokens and JWKS transport failures to InvalidAuthTokenError.
 */
export function createPrivyIdentityVerifier(appId: string, appSecret: string, options: VerifierOptions = {}): PrivyIdentityVerifier {
  const resolveKey = options.resolveVerificationKey || createRemoteJWKSet(
    new URL(`https://api.privy.io/v1/apps/${encodeURIComponent(appId)}/jwks.json`),
    { timeoutDuration: 5_000, cooldownDuration: 30_000, cacheMaxAge: 600_000 },
  );
  const client = options.lookupUser ? null : new PrivyClient({ appId, appSecret, timeout: 8_000, maxRetries: 0 });
  return {
    async verifyAccessToken(token) {
      // This flag belongs to one verification request; concurrent users cannot affect it.
      let keyServiceUnavailable = false;
      try {
        return await verifyAccessToken({
          access_token: token,
          app_id: appId,
          verification_key: async (...args) => {
            try { return await resolveKey(...args); }
            catch (error) {
              // An unknown kid is an invalid token. Multiple matches can be iterated by
              // jose itself; preserve that error's iterator rather than reclassifying it.
              if (!(error instanceof errors.JWKSNoMatchingKey) && !(error instanceof errors.JWKSMultipleMatchingKeys)) {
                keyServiceUnavailable = true;
              }
              throw error;
            }
          },
        });
      } catch (error) {
        if (keyServiceUnavailable) throw new PrivyIdentityUnavailableError('Privy verification keys are unavailable.');
        if (error instanceof InvalidAuthTokenError) throw new InvalidPrivyAccessTokenError('The Privy access token is invalid or expired.');
        throw new PrivyIdentityUnavailableError('Privy token verification is unavailable.');
      }
    },
    async getUser(userId) {
      try {
        // _get is the SDK's documented authenticated API lookup by user ID. get()
        // instead verifies an identity token; it does not accept a plain user ID.
        return options.lookupUser ? await options.lookupUser(userId) : await client!.users()._get(userId);
      } catch (error) {
        if (error instanceof NotFoundError) throw new InvalidPrivyAccessTokenError('The Privy user no longer exists.');
        // API authentication errors refer to server credentials, not the user's JWT.
        throw new PrivyIdentityUnavailableError('The authenticated Privy user could not be retrieved.');
      }
    },
  };
}
