"use client";

import { PrivyProvider, useConnectWallet, useLinkAccount, useLogin, useLoginWithOAuth, usePrivy, useWallets, type PrivyClientConfig } from '@privy-io/react-auth';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { WalletState } from '../lib/client-wallet';
import { sendReviewedEvmTransaction, type EvmWalletTransaction } from '../lib/client-nft-launch';
import { emptyPrivyIdentity, evmAddress, privyIdentityScope, projectPrivyIdentity, scopedPrivyAccessToken, type PrivyUserIdentity, type PrivyWalletCandidate } from '../lib/privy-wallet-state';
import { useTheme } from './theme-provider';

// Ethereum identities are usable before chain integration; no invented Zero chain
// or alternative-chain transaction configuration is installed here.
const privyConfig: PrivyClientConfig = {
  appearance: { theme: 'dark', accentColor: '#57E6C1', walletChainType: 'ethereum-only', showWalletLoginFirst: true },
  loginMethods: ['wallet', 'email', 'twitter'],
  embeddedWallets: { ethereum: { createOnLogin: 'users-without-wallets' } },
};

export default function PrivyHost({ config, onChange }: { config: { appId: string; clientId?: string }; onChange(value: WalletState): void }) {
  const { currentTheme } = useTheme();
  const themedConfig = useMemo<PrivyClientConfig>(() => ({
    ...privyConfig,
    appearance: { ...privyConfig.appearance, theme: currentTheme.appearance, accentColor: currentTheme.accent },
  }), [currentTheme.appearance, currentTheme.accent]);
  return <PrivyProvider appId={config.appId} clientId={config.clientId} config={themedConfig}><PrivyBridge onChange={onChange} /></PrivyProvider>;
}

function PrivyBridge({ onChange }: { onChange(value: WalletState): void }) {
  const auth = usePrivy(); const { wallets, ready: walletsReady } = useWallets();
  const { login } = useLogin(); const { connectWallet } = useConnectWallet(); const { linkWallet: linkPrivyWallet, linkTwitter } = useLinkAccount();
  const { initOAuth } = useLoginWithOAuth();
  const [selection, setSelection] = useState<{ userId: string; address: string } | null>(null);
  const [blocked, setBlocked] = useState(false); const [signingOut, setSigningOut] = useState(false);
  const blockedRef = useRef(false);
  const user: PrivyUserIdentity | null = auth.user ? { id: auth.user.id, wallet: auth.user.wallet ? { address: auth.user.wallet.address } : null, linkedAccounts: auth.user.linkedAccounts } : null;
  // The main SDK's useWallets returns ConnectedWallet[], which extends
  // BaseConnectedEthereumWallet. Solana wallets use a separate SDK entry point.
  const candidates: PrivyWalletCandidate[] = wallets.map(wallet => ({ address: wallet.address, chainId: wallet.chainId, chainType: wallet.type, walletClientType: wallet.walletClientType }));
  // SDK contexts can change object identity without changing an account. Stabilize
  // the bridge payload so reporting it cannot trigger a parent/provider loop.
  const input = JSON.stringify({ ready: auth.ready, authenticated: auth.authenticated && !blocked, walletsReady, user, wallets: candidates, selection, signingOut });
  const identity = useMemo(() => projectPrivyIdentity(JSON.parse(input)), [input]);
  const current = useRef(identity); current.current = identity;
  const sdk = useRef({ auth, login, connectWallet, linkPrivyWallet, wallets, linkTwitter, initOAuth }); sdk.current = { auth, login, connectWallet, linkPrivyWallet, wallets, linkTwitter, initOAuth };

  const connectX = useCallback(async () => {
    const active = sdk.current;
    if (!active.auth.ready) throw new Error('Sign-in is still loading. Please try again.');
    if (blockedRef.current) {
      if (active.auth.authenticated) await active.auth.logout();
      blockedRef.current = false; setBlocked(false);
      await active.initOAuth({ provider: 'twitter' }); return;
    }
    if (active.auth.authenticated) { if (!active.auth.user?.twitter) active.linkTwitter(); }
    else await active.initOAuth({ provider: 'twitter' });
  }, []);

  const connect = useCallback(async () => {
    const active = sdk.current;
    if (!active.auth.ready) throw new Error('Sign-in is still loading. Please try again.');
    if (blockedRef.current) {
      // A previous logout failure must not silently restore its old user.
      if (active.auth.authenticated) await active.auth.logout();
      blockedRef.current = false; setBlocked(false);
      active.login(); return;
    }
    if (active.auth.authenticated) active.connectWallet();
    else active.login();
  }, []);
  const disconnect = useCallback(async () => {
    blockedRef.current = true; current.current = emptyPrivyIdentity(true);
    setBlocked(true); setSelection(null); setSigningOut(true);
    try { await sdk.current.auth.logout(); }
    finally { setSigningOut(false); }
  }, []);
  const linkWallet = useCallback(async () => {
    if (!current.current.authenticationReady || !current.current.authenticated) throw new Error('Sign in before linking another wallet.');
    sdk.current.linkPrivyWallet();
  }, []);
  const selectWallet = useCallback((address: string) => {
    const currentIdentity = current.current; const normalized = evmAddress(address);
    if (!currentIdentity.userId || !normalized || !currentIdentity.wallets.some(wallet => wallet.address === normalized)) throw new Error('Choose a connected wallet linked to your current account.');
    // Invalidate in-flight token reads before React renders the new selection.
    current.current = { ...currentIdentity, account: null, network: null, connected: false };
    setSelection({ userId: currentIdentity.userId, address: normalized });
  }, []);
  const identityScope = useCallback(() => blockedRef.current ? null : privyIdentityScope(current.current), []);
  const renderedScope = privyIdentityScope(identity);
  const getAccessToken = useCallback(() => scopedPrivyAccessToken(
    () => blockedRef.current ? emptyPrivyIdentity(true) : current.current,
    () => sdk.current.auth.getAccessToken(),
    renderedScope,
  ), [renderedScope]);
  const sendEvmTransaction = useCallback((transaction: EvmWalletTransaction) => sendReviewedEvmTransaction({
    transaction, identityScope,
    getProvider: async () => {
      const wallet = sdk.current.wallets.find(candidate => evmAddress(candidate.address) === evmAddress(transaction.from));
      if (!wallet) throw new Error('The reviewed wallet is no longer connected.');
      return wallet.getEthereumProvider();
    },
  }), [identityScope]);
  const twitter = auth.user?.twitter;
  const xKey = JSON.stringify(twitter ? { id: twitter.subject, username: twitter.username || '', name: twitter.name || twitter.username || '', avatarUrl: twitter.profilePictureUrl || null } : null);
  const xAccount = useMemo(() => JSON.parse(xKey) as WalletState['xAccount'], [xKey]);
  const value = useMemo<WalletState>(() => ({ ...identity, xAccount: identity.authenticated ? xAccount : null, connectX, connect, disconnect, linkWallet, selectWallet, identityScope, getAccessToken, sendEvmTransaction }), [identity, xAccount, connectX, connect, disconnect, linkWallet, selectWallet, identityScope, getAccessToken, sendEvmTransaction]);
  useEffect(() => { onChange(value); }, [onChange, value]);
  // A host unmount makes any unfinished token read unusable immediately.
  useEffect(() => {
    current.current = identity;
    blockedRef.current = false;
    return () => { current.current = emptyPrivyIdentity(true); blockedRef.current = true; };
  }, []);
  return null;
}
