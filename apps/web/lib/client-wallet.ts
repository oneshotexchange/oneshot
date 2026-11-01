"use client";

import { Component, Suspense, lazy, createContext, createElement, useCallback, useContext, useState, type ReactNode } from 'react';
import { emptyPrivyIdentity, publicPrivyConfig, type PrivyIdentity } from './privy-wallet-state';
import type { EvmWalletTransaction } from './client-nft-launch';

export type WalletState = PrivyIdentity & {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  linkWallet(): Promise<void>;
  selectWallet(address: string): void;
  identityScope(): string | null;
  getAccessToken(): Promise<string | null>;
  sendEvmTransaction(transaction: EvmWalletTransaction): Promise<string>;
};
const Context = createContext<WalletState | null>(null);
const config = publicPrivyConfig(process.env.NEXT_PUBLIC_PRIVY_APP_ID, process.env.NEXT_PUBLIC_PRIVY_CLIENT_ID);
const PrivyHost = lazy(() => import('../components/privy-host'));

function unavailable(configured: boolean, reason?: string): WalletState {
  const identity = emptyPrivyIdentity(configured);
  if (reason) { identity.unavailableReason = reason; identity.isLoading = false; }
  const unavailableAction = async () => { throw new Error(identity.unavailableReason || 'Sign-in is starting. Please try again.'); };
  return {
    ...identity, connect: unavailableAction, linkWallet: unavailableAction,
    disconnect: async () => {}, selectWallet: () => { throw new Error('Wallet selection is unavailable.'); },
    identityScope: () => null, getAccessToken: async () => null, sendEvmTransaction: unavailableAction,
  };
}

class WalletHostBoundary extends Component<{ children: ReactNode; onFailure(): void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { this.props.onFailure(); }
  render() { return this.state.failed ? null : this.props.children; }
}

/** Privy owns wallet discovery and login. Drafts never wait for the SDK or a network. */
export function PrivyWalletProvider({ children }: { children: ReactNode }) {
  const [wallet, setWallet] = useState<WalletState>(() => unavailable(Boolean(config)));
  const onChange = useCallback((value: WalletState) => setWallet(value), []);
  const onFailure = useCallback(() => setWallet(unavailable(true, 'Sign-in is temporarily unavailable. Your saved drafts are still available.')), []);
  return createElement(Context.Provider, { value: wallet }, children,
    config ? createElement(WalletHostBoundary, { onFailure, children: createElement(Suspense, { fallback: null }, createElement(PrivyHost, { config, onChange })) }) : null,
  );
}
export function useWallet() {
  const wallet = useContext(Context);
  if (!wallet) throw new Error('Wallet components require PrivyWalletProvider');
  return wallet;
}
