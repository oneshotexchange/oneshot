import { describe, expect, it, vi } from 'vitest';
import { assertLinkedEvmAddress, createOneshotAuthenticator, normalizeEvmAddress, oneshotAuthStatus } from './oneshot-auth';
import { InvalidPrivyAccessTokenError, type PrivyIdentityVerifier } from './privy-verifier';

const NOW = 1_792_620_000;
const APP_ID = 'oneshot-test-app';
const USER_ID = 'did:privy:oneshot-test-user';
const ALICE = `0x${'ab'.repeat(20)}`;
const BOB = `0x${'cd'.repeat(20)}`;
const TOKEN = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJl';
const environment = { PRIVY_APP_ID: APP_ID, PRIVY_APP_SECRET: 'server-secret', NEXT_PUBLIC_PRIVY_APP_ID: APP_ID };

function claims() {
  return { app_id: APP_ID, issuer: 'privy.io', issued_at: NOW - 10, expiration: NOW + 60, session_id: 'session-123', user_id: USER_ID };
}
function user() {
  return { id: USER_ID, frozen_at: null, linked_accounts: [{ type: 'wallet', chain_type: 'ethereum', address: ALICE, verified_at: NOW - 1 }] };
}
function request(authorization: string | null = `Bearer ${TOKEN}`) {
  const headers = new Headers({ cookie: 'b20_session=legacy-cookie; privy-token=unverified-cookie', 'x-wallet-address': BOB });
  if (authorization !== null) headers.set('authorization', authorization);
  return { headers };
}
function fixture() {
  const verifyAccessToken = vi.fn(async () => claims());
  const getUser = vi.fn(async (): Promise<unknown> => user());
  const adapter: PrivyIdentityVerifier = { verifyAccessToken, getUser };
  const verifier = vi.fn(() => adapter);
  const authenticate = createOneshotAuthenticator({ environment: () => environment, verifier, now: () => NOW });
  return { authenticate, verifier, verifyAccessToken, getUser, adapter };
}

describe('oneshot server Privy authentication', () => {
  it('uses only verified claims and freshly retrieved linked Ethereum addresses', async () => {
    const { authenticate, verifyAccessToken, getUser } = fixture();
    getUser.mockResolvedValue({ id: USER_ID, linked_accounts: [
      { type: 'wallet', chain_type: 'ethereum', address: ALICE.toUpperCase().replace('0X', '0x'), verified_at: NOW - 1 },
      { type: 'wallet', chain_type: 'ethereum', address: ALICE, verified_at: NOW - 1 },
      { type: 'wallet', chain_type: 'solana', address: BOB, verified_at: NOW - 1 },
      { type: 'wallet', chain_type: 'ethereum', address: BOB, verified_at: null },
      { type: 'email', address: BOB, verified_at: NOW - 1 },
      { type: 'smart_wallet', address: BOB, verified_at: NOW - 1 },
      { type: 'wallet', chain_type: 'ethereum', address: `0x${'ff'.repeat(32)}`, verified_at: NOW - 1 },
    ] });
    const session = await authenticate(request());
    expect(session).toEqual({ provider: 'privy', userId: USER_ID, sessionId: 'session-123', expiresAt: NOW + 60, linkedAddresses: [ALICE] });
    expect(verifyAccessToken).toHaveBeenCalledWith(TOKEN);
    expect(getUser).toHaveBeenCalledWith(USER_ID);
    expect(assertLinkedEvmAddress(session, ALICE.toUpperCase().replace('0X', '0x'))).toBe(ALICE);
    expect(() => assertLinkedEvmAddress(session, BOB)).toThrow(expect.objectContaining({ status: 403, code: 'WALLET_NOT_LINKED' }));
    expect(JSON.stringify(session)).not.toContain(TOKEN);
    expect(JSON.stringify(session)).not.toContain(environment.PRIVY_APP_SECRET);
  });

  it('does not treat cookies, wallet-address headers, or malformed bearer values as authentication', async () => {
    const { authenticate, verifyAccessToken } = fixture();
    for (const authorization of [null, 'Basic abc', 'Bearer unsigned', `Bearer ${TOKEN},${TOKEN}`, `Bearer ${'a'.repeat(8_193)}.b.c`]) {
      await expect(authenticate(request(authorization))).rejects.toMatchObject({ status: 401, code: 'AUTH_REQUIRED' });
    }
    expect(verifyAccessToken).not.toHaveBeenCalled();
  });

  it('fails closed for missing or mismatched server configuration', async () => {
    const verifier = vi.fn();
    for (const env of [ {}, { NEXT_PUBLIC_PRIVY_APP_ID: APP_ID }, { PRIVY_APP_ID: APP_ID },
      { ...environment, NEXT_PUBLIC_PRIVY_APP_ID: 'different-app' }, { ...environment, PRIVY_APP_SECRET: ' secret ' } ]) {
      expect(oneshotAuthStatus(env).configured).toBe(false);
      const authenticate = createOneshotAuthenticator({ environment: () => env, verifier });
      await expect(authenticate(request())).rejects.toMatchObject({ status: 503, code: 'AUTH_NOT_CONFIGURED' });
    }
    expect(verifier).not.toHaveBeenCalled();
    expect(oneshotAuthStatus(environment)).toEqual({ provider: 'privy', configured: true, reason: null });
    expect(JSON.stringify(oneshotAuthStatus(environment))).not.toContain(environment.PRIVY_APP_SECRET);
  });

  it('defensively rejects incorrect audience, issuer, expiry, subject and session claims', async () => {
    const { authenticate, verifyAccessToken, getUser } = fixture();
    for (const patch of [ { app_id: 'other-app' }, { issuer: 'attacker.example' }, { expiration: NOW },
      { expiration: Number.POSITIVE_INFINITY }, { issued_at: NOW + 61 }, { user_id: 'did:untrusted:user' }, { session_id: '' } ]) {
      verifyAccessToken.mockResolvedValue({ ...claims(), ...patch });
      await expect(authenticate(request())).rejects.toMatchObject({ status: 401, code: 'AUTH_INVALID' });
    }
    expect(getUser).not.toHaveBeenCalled();
  });

  it('rejects invalid signatures while preserving provider outages as 503', async () => {
    const { authenticate, verifyAccessToken, getUser } = fixture();
    verifyAccessToken.mockRejectedValue(new InvalidPrivyAccessTokenError('invalid signature'));
    await expect(authenticate(request())).rejects.toMatchObject({ status: 401, code: 'AUTH_INVALID' });
    expect(getUser).not.toHaveBeenCalled();
    verifyAccessToken.mockRejectedValue(new Error(`provider failure with ${TOKEN} and ${environment.PRIVY_APP_SECRET}`));
    const failure = await authenticate(request()).catch(error => error);
    expect(failure).toMatchObject({ status: 503, code: 'AUTH_PROVIDER_UNAVAILABLE' });
    expect(failure.message).not.toContain(TOKEN); expect(failure.message).not.toContain(environment.PRIVY_APP_SECRET);
  });

  it('never accepts a mismatched, frozen, deleted or unavailable provider identity', async () => {
    const { authenticate, getUser } = fixture();
    getUser.mockResolvedValue({ ...user(), id: 'did:privy:different-user' });
    await expect(authenticate(request())).rejects.toMatchObject({ status: 401 });
    getUser.mockResolvedValue({ ...user(), frozen_at: NOW - 1 });
    await expect(authenticate(request())).rejects.toMatchObject({ status: 401 });
    getUser.mockRejectedValue(new InvalidPrivyAccessTokenError('deleted user'));
    await expect(authenticate(request())).rejects.toMatchObject({ status: 401 });
    getUser.mockRejectedValue(new Error('upstream unavailable'));
    await expect(authenticate(request())).rejects.toMatchObject({ status: 503 });
    getUser.mockResolvedValue({ id: USER_ID });
    await expect(authenticate(request())).rejects.toMatchObject({ status: 503 });
  });

  it('refreshes linked-wallet scope each request and permits identity without an Ethereum wallet', async () => {
    const { authenticate, getUser } = fixture();
    const first = await authenticate(request()); expect(first.linkedAddresses).toEqual([ALICE]);
    getUser.mockResolvedValue({ id: USER_ID, linked_accounts: [] });
    const fresh = await authenticate(request());
    expect(fresh.userId).toBe(USER_ID); expect(fresh.linkedAddresses).toEqual([]);
    expect(() => assertLinkedEvmAddress(fresh, ALICE)).toThrow(expect.objectContaining({ status: 403 }));
    expect(getUser).toHaveBeenCalledTimes(2);
  });

  it('checks expiry again after the identity lookup finishes', async () => {
    let currentTime = NOW; const { adapter, getUser } = fixture();
    getUser.mockImplementation(async () => { currentTime = NOW + 60; return user(); });
    const authenticate = createOneshotAuthenticator({ environment: () => environment, verifier: () => adapter, now: () => currentTime });
    await expect(authenticate(request())).rejects.toMatchObject({ status: 401, code: 'AUTH_INVALID' });
  });

  it('rejects Aptos-sized, zero and malformed wallet scope values', () => {
    for (const value of [null, BOB.slice(2), `0x${'00'.repeat(20)}`, `0x${'ab'.repeat(32)}`, '0x123']) {
      expect(() => normalizeEvmAddress(value)).toThrow(expect.objectContaining({ status: 400, code: 'INVALID_EVM_ADDRESS' }));
    }
  });
});
