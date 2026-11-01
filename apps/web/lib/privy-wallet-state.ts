/** Narrow SDK projections keep identity handling independent from provider internals. */
export type PrivyWalletCandidate = {
  address: string;
  chainType: string;
  chainId: string;
  walletClientType: string;
};
export type PrivyUserIdentity = {
  id: string;
  wallet?: { address: string } | null;
  linkedAccounts: readonly unknown[];
};
export type WalletOption = { address: `0x${string}`; label: string; embedded: boolean };
export type PrivyIdentity = {
  configured: boolean;
  authenticationReady: boolean;
  authenticated: boolean;
  userId: string | null;
  connected: boolean;
  account: { address: `0x${string}` } | null;
  network: { chainId: number; name: string } | null;
  isLoading: boolean;
  wallets: WalletOption[];
  unavailableReason: string | null;
};

export function publicPrivyConfig(appId?: string, clientId?: string) {
  const id = appId?.trim();
  return id ? { appId: id, ...(clientId?.trim() ? { clientId: clientId.trim() } : {}) } : null;
}

export function evmAddress(value: unknown): `0x${string}` | null {
  return typeof value === 'string' && /^0x[\da-f]{40}$/i.test(value) ? value.toLowerCase() as `0x${string}` : null;
}

/** Privy's Ethereum wallet chainId is CAIP-2, not a LayerZero endpoint ID. */
export function privyEvmChainId(value: unknown): number | null {
  if (typeof value !== 'string' || !/^eip155:[1-9]\d*$/.test(value)) return null;
  const id = Number(value.slice(7));
  return Number.isSafeInteger(id) ? id : null;
}

export function linkedEthereumAddresses(user: PrivyUserIdentity | null): Set<string> {
  const addresses = new Set<string>();
  for (const account of user?.linkedAccounts || []) {
    if (!account || typeof account !== 'object') continue;
    const value = account as Record<string, unknown>;
    const address = evmAddress(value.address);
    if (value.type === 'wallet' && value.chainType === 'ethereum' && address) addresses.add(address);
  }
  return addresses;
}

/** Never reuse a connected extension left behind by a different Privy user. */
export function eligiblePrivyWallets(wallets: readonly PrivyWalletCandidate[], user: PrivyUserIdentity | null) {
  const linked = linkedEthereumAddresses(user);
  const eligible = wallets.filter(wallet => wallet.chainType === 'ethereum' && linked.has(evmAddress(wallet.address) || ''));
  // A stable order prevents an SDK array reorder from silently switching accounts.
  return [...eligible].sort((left, right) => {
    const byAddress = left.address.toLowerCase().localeCompare(right.address.toLowerCase());
    return byAddress || left.walletClientType.localeCompare(right.walletClientType);
  }).filter((wallet, index, ordered) => index === 0 || evmAddress(wallet.address) !== evmAddress(ordered[index - 1].address));
}

export function selectPrivyWallet(wallets: readonly PrivyWalletCandidate[], user: PrivyUserIdentity | null, selectedAddress?: string) {
  const eligible = eligiblePrivyWallets(wallets, user);
  const selected = evmAddress(selectedAddress); const primary = evmAddress(user?.wallet?.address);
  return eligible.find(wallet => evmAddress(wallet.address) === selected)
    || eligible.find(wallet => evmAddress(wallet.address) === primary)
    || eligible.find(wallet => wallet.walletClientType === 'privy')
    || eligible[0]
    || null;
}

export function emptyPrivyIdentity(configured: boolean): PrivyIdentity {
  return {
    configured, authenticationReady: false, authenticated: false, userId: null,
    connected: false, account: null, network: null, isLoading: configured, wallets: [],
    unavailableReason: configured ? null : 'Sign-in is temporarily unavailable. You can still save drafts on this device.',
  };
}

export function projectPrivyIdentity(input: {
  ready: boolean; authenticated: boolean; walletsReady: boolean;
  user: PrivyUserIdentity | null; wallets: readonly PrivyWalletCandidate[];
  selection?: { userId: string; address: string } | null; signingOut?: boolean;
}): PrivyIdentity {
  const state = emptyPrivyIdentity(true);
  state.authenticationReady = input.ready;
  state.isLoading = !input.ready || (input.authenticated && !input.walletsReady) || Boolean(input.signingOut);
  if (!input.ready || !input.authenticated || !input.user?.id || input.signingOut) return state;
  state.authenticated = true; state.userId = input.user.id;
  if (!input.walletsReady) return state;
  const preferred = input.selection?.userId === input.user.id ? input.selection.address : undefined;
  const eligible = eligiblePrivyWallets(input.wallets, input.user);
  const wallet = selectPrivyWallet(eligible, input.user, preferred);
  state.wallets = eligible.map(candidate => ({ address: evmAddress(candidate.address)!, embedded: candidate.walletClientType === 'privy', label: candidate.walletClientType === 'privy' ? 'Privy embedded wallet' : candidate.walletClientType }));
  if (!wallet) return state;
  state.account = { address: evmAddress(wallet.address)! }; state.connected = true;
  const chainId = privyEvmChainId(wallet.chainId);
  state.network = chainId === null ? null : { chainId, name: chainId === 31337 ? 'Local test network' : `Chain ${chainId}` };
  return state;
}

export function privyIdentityScope(identity: PrivyIdentity): string | null {
  if (!identity.authenticationReady || !identity.authenticated || !identity.userId) return null;
  return JSON.stringify([identity.userId, identity.account?.address || null, identity.network?.chainId || null]);
}

/** Access tokens are short-lived: obtain on demand and discard after identity changes. */
export async function scopedPrivyAccessToken(current: () => PrivyIdentity, getToken: () => Promise<string | null>, expectedScope?: string | null) {
  const before = privyIdentityScope(current());
  if (expectedScope !== undefined && before !== expectedScope) throw new Error('Your account or wallet changed. Please try again.');
  if (!before) return null;
  const token = await getToken();
  if (privyIdentityScope(current()) !== before) throw new Error('Your account or wallet changed. Please try again.');
  return token;
}
