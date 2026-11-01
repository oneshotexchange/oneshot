import { describe, expect, it } from 'vitest';
import { generateKeyPair, SignJWT, errors, type JWTVerifyGetKey } from 'jose';
import { createPrivyIdentityVerifier, InvalidPrivyAccessTokenError, PrivyIdentityUnavailableError } from './privy-verifier';

const APP_ID = 'oneshot-test-app';
const USER_ID = 'did:privy:test-user';

async function token(privateKey: CryptoKey, patch: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1_000);
  return new SignJWT({ sub: USER_ID, sid: 'session-123', iss: 'privy.io', aud: APP_ID, iat: now - 1, exp: now + 60, ...patch })
    .setProtectedHeader({ alg: 'ES256', typ: 'JWT', kid: 'test-key' }).sign(privateKey);
}

describe('official Privy SDK verification boundary', () => {
  it('verifies an ES256 token with the SDK and rejects wrong audience, issuer, expiry and signature', async () => {
    const pair = await generateKeyPair('ES256');
    const resolver: JWTVerifyGetKey = async () => pair.publicKey;
    const verifier = createPrivyIdentityVerifier(APP_ID, 'not-a-real-secret', { resolveVerificationKey: resolver, lookupUser: async () => ({ id: USER_ID }) });
    const claims = await verifier.verifyAccessToken(await token(pair.privateKey));
    expect(claims.user_id).toBe(USER_ID); expect(claims.app_id).toBe(APP_ID); expect(claims.issuer).toBe('privy.io');
    for (const patch of [{ aud: 'other-app' }, { iss: 'other-issuer' }, { exp: Math.floor(Date.now() / 1_000) - 1 }]) {
      await expect(verifier.verifyAccessToken(await token(pair.privateKey, patch))).rejects.toBeInstanceOf(InvalidPrivyAccessTokenError);
    }
    const other = await generateKeyPair('ES256');
    await expect(verifier.verifyAccessToken(await token(other.privateKey))).rejects.toBeInstanceOf(InvalidPrivyAccessTokenError);
  });

  it('distinguishes unavailable verification keys from unknown key IDs', async () => {
    const pair = await generateKeyPair('ES256'); const signed = await token(pair.privateKey);
    const unavailable = createPrivyIdentityVerifier(APP_ID, 'not-a-real-secret', {
      resolveVerificationKey: async () => { throw new TypeError('fetch failed'); }, lookupUser: async () => null,
    });
    await expect(unavailable.verifyAccessToken(signed)).rejects.toBeInstanceOf(PrivyIdentityUnavailableError);
    const unknownKey = createPrivyIdentityVerifier(APP_ID, 'not-a-real-secret', {
      resolveVerificationKey: async () => { throw new errors.JWKSNoMatchingKey(); }, lookupUser: async () => null,
    });
    await expect(unknownKey.verifyAccessToken(signed)).rejects.toBeInstanceOf(InvalidPrivyAccessTokenError);
  });

  it('does not cache or invent user identities when the authenticated API lookup fails', async () => {
    const verifier = createPrivyIdentityVerifier(APP_ID, 'not-a-real-secret', {
      lookupUser: async () => { throw new Error('upstream unavailable'); },
    });
    await expect(verifier.getUser(USER_ID)).rejects.toBeInstanceOf(PrivyIdentityUnavailableError);
  });
});
