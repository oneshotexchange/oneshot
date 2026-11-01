import { describe, expect, it } from 'vitest';
import { eligiblePrivyWallets, emptyPrivyIdentity, privyEvmChainId, privyIdentityScope, projectPrivyIdentity, publicPrivyConfig, scopedPrivyAccessToken, selectPrivyWallet, type PrivyIdentity, type PrivyUserIdentity, type PrivyWalletCandidate } from './privy-wallet-state';

const alice = `0x${'ab'.repeat(20)}`;
const bob = `0x${'cd'.repeat(20)}`;
const extension = (address: string, chainId = 'eip155:1'): PrivyWalletCandidate => ({ address, chainId, chainType: 'ethereum', walletClientType: 'metamask' });
const user = (id = 'did:privy:alice', addresses = [alice, bob]): PrivyUserIdentity => ({ id, wallet: { address: alice }, linkedAccounts: addresses.map(address => ({ type: 'wallet', chainType: 'ethereum', address })) });
const signedIn = (overrides: Partial<Parameters<typeof projectPrivyIdentity>[0]> = {}) => projectPrivyIdentity({ ready: true, authenticated: true, walletsReady: true, user: user(), wallets: [extension(alice), extension(bob)], ...overrides });

describe('Privy wallet projection', () => {
  it('keeps configuration absent without a demo identity or fallback chain', () => {
    expect(publicPrivyConfig('  ', 'client')).toBeNull();
    expect(publicPrivyConfig(' app ', ' client ')).toEqual({ appId: 'app', clientId: 'client' });
    expect(publicPrivyConfig('app')).toEqual({ appId: 'app' });
    expect(emptyPrivyIdentity(false)).toMatchObject({ configured: false, connected: false, account: null, network: null, isLoading: false });
  });

  it('only selects Ethereum wallets linked to the authenticated current user', () => {
    const wallets = [extension(alice.toUpperCase().replace('0X', '0x')), extension(bob), { ...extension(alice), chainType: 'solana' }, extension('malformed')];
    expect(eligiblePrivyWallets(wallets, user('alice', [alice]))).toHaveLength(1);
    expect(selectPrivyWallet(wallets, user('alice', [alice]))?.address.toLowerCase()).toBe(alice);
    expect(selectPrivyWallet(wallets, user('bob', []))).toBeNull();
  });

  it('prefers an explicitly selected linked wallet and remains stable when the SDK list reorders', () => {
    const wallets = [extension(bob), extension(alice)];
    expect(selectPrivyWallet(wallets, user(), bob)?.address).toBe(bob);
    expect(selectPrivyWallet(wallets.reverse(), user(), bob)?.address).toBe(bob);
    expect(selectPrivyWallet(wallets, user(), 'unlinked')?.address).toBe(alice);
  });

  it('does not carry the previous user wallet selection into a new session', () => {
    const state = signedIn({ user: user('new-user'), selection: { userId: 'old-user', address: bob } });
    expect(state.account?.address).toBe(alice);
    expect(signedIn({ user: user('new-user', [bob]) }).account?.address).toBe(bob);
  });

  it('clears account and chain immediately when auth, wallets or the active linked account disappear', () => {
    for (const change of [{ ready: false }, { authenticated: false }, { walletsReady: false }, { user: null }, { signingOut: true }, { wallets: [] }]) {
      expect(signedIn(change)).toMatchObject({ connected: false, account: null, network: null });
    }
    expect(signedIn({ authenticated: false }).userId).toBeNull();
  });

  it('parses only safe EIP-155 chain IDs and never claims an Ethereum chain is Zero', () => {
    expect(privyEvmChainId('eip155:31337')).toBe(31337);
    for (const invalid of ['eip155:0', 'eip155:-1', 'eip155:1x', 'solana:1', '0x1', 'eip155:9007199254740992', undefined]) expect(privyEvmChainId(invalid)).toBeNull();
    expect(signedIn().network).toEqual({ chainId: 1, name: 'Chain 1' });
    expect(signedIn({ wallets: [extension(alice, 'eip155:31337')] }).network?.name).toBe('Local test network');
    expect(signedIn({ wallets: [extension(alice, 'unknown')] }).network).toBeNull();
  });

  it('returns no access token for an unauthenticated SDK state', async () => {
    let called = false;
    expect(await scopedPrivyAccessToken(() => emptyPrivyIdentity(true), async () => { called = true; return 'token'; })).toBeNull();
    expect(called).toBe(false);
  });

  it('rejects token responses that crossed a user, wallet, chain or logout change', async () => {
    const changes = [signedIn({ user: user('new-user') }), signedIn({ selection: { userId: user().id, address: bob } }), signedIn({ wallets: [extension(alice, 'eip155:10')] }), emptyPrivyIdentity(true)];
    for (const changed of changes) {
      let current: PrivyIdentity = signedIn();
      let resolve!: (token: string) => void;
      const pending = scopedPrivyAccessToken(() => current, () => new Promise<string>(done => { resolve = done; }));
      current = changed; resolve('stale-token');
      await expect(pending).rejects.toThrow('account or wallet changed');
    }
    const current = signedIn();
    expect(await scopedPrivyAccessToken(() => current, async () => 'current-token')).toBe('current-token');
  });
  it('rejects a stale rendered account before obtaining a token for a newer user', async () => {
    const rendered = signedIn(); const current = signedIn({ user: user('new-user') }); let called = false;
    await expect(scopedPrivyAccessToken(() => current, async () => { called = true; return 'new-user-token'; }, privyIdentityScope(rendered))).rejects.toThrow('account or wallet changed');
    expect(called).toBe(false);
  });
});
