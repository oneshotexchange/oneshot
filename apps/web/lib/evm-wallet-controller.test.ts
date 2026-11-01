import { describe, expect, it, vi } from 'vitest';
import { EvmWalletController, type EvmProvider, type EvmWalletSnapshot } from './evm-wallet-controller';

const ALICE = `0x${'ab'.repeat(20)}`;
const BOB = `0x${'cd'.repeat(20)}`;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolve_, reject_) => { resolve = resolve_; reject = reject_; });
  return { promise, resolve, reject };
}

class Provider implements EvmProvider {
  accounts = [ALICE];
  chainId = '0x7a69';
  requests: string[] = [];
  listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  handle: (method: string) => Promise<unknown> = async method => method === 'eth_chainId' ? this.chainId : this.accounts;
  request({ method }: { method: string }) { this.requests.push(method); return this.handle(method); }
  on(event: string, listener: (...args: unknown[]) => void) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener);
  }
  removeListener(event: string, listener: (...args: unknown[]) => void) { this.listeners.get(event)?.delete(listener); }
  emit(event: string) { for (const listener of this.listeners.get(event) || []) listener(); }
  listenerCount() { return [...this.listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0); }
}

function observer() {
  let snapshot: EvmWalletSnapshot = { connected: false, account: null, network: null, isLoading: false };
  const publish = vi.fn((value: EvmWalletSnapshot) => { snapshot = value; });
  return { publish, snapshot: () => snapshot };
}

describe('EIP-1193 connection lifecycle', () => {
  it('subscribes when a provider is injected after initial mount, then refreshes account and chain changes', async () => {
    let injected: EvmProvider | undefined;
    const state = observer();
    const controller = new EvmWalletController(() => injected, state.publish);
    await controller.start();
    expect(state.publish).not.toHaveBeenCalled();
    const provider = new Provider(); injected = provider;
    await controller.connect();
    expect(provider.listenerCount()).toBe(3);
    expect(state.snapshot().account?.address).toBe(ALICE);
    provider.accounts = [BOB]; provider.emit('accountsChanged');
    expect(state.snapshot().account).toBeNull();
    await vi.waitFor(() => expect(state.snapshot().account?.address).toBe(BOB));
    provider.chainId = '0x1'; provider.emit('chainChanged');
    expect(state.snapshot().network).toBeNull();
    await vi.waitFor(() => expect(state.snapshot().network?.chainId).toBe(1));
    expect(state.snapshot().network?.name).toBe('Chain 1 · unverified');
    controller.dispose(); expect(provider.listenerCount()).toBe(0);
  });

  it('does not let an older rejected startup request clear a newer successful connection', async () => {
    const provider = new Provider(); const initial = deferred<unknown>();
    provider.handle = async method => method === 'eth_accounts' ? initial.promise : method === 'eth_chainId' ? '0x1' : [BOB];
    const state = observer(); const controller = new EvmWalletController(() => provider, state.publish);
    const startup = controller.start();
    await controller.connect();
    const current = state.snapshot(); expect(current.account?.address).toBe(BOB);
    initial.reject(new Error('superseded request failed'));
    await startup;
    expect(state.snapshot()).toBe(current);
    expect(state.snapshot().isLoading).toBe(false);
    controller.dispose();
  });

  it('preserves newer loading state when an earlier event refresh rejects', async () => {
    const provider = new Provider(); const state = observer();
    const controller = new EvmWalletController(() => provider, state.publish); await controller.start();
    const oldRefresh = deferred<unknown>(); const newConnection = deferred<unknown>();
    provider.handle = async method => method === 'eth_accounts' ? oldRefresh.promise : method === 'eth_requestAccounts' ? newConnection.promise : '0x7a69';
    provider.emit('accountsChanged');
    const connecting = controller.connect();
    oldRefresh.reject(new Error('old event failed'));
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(state.snapshot().isLoading).toBe(true);
    newConnection.resolve([BOB]); await connecting;
    expect(state.snapshot().account?.address).toBe(BOB);
    expect(state.snapshot().isLoading).toBe(false);
    controller.dispose();
  });

  it('manual disconnect invalidates pending reads and suppresses passive reconnection', async () => {
    const provider = new Provider(); const pending = deferred<unknown>(); const state = observer();
    provider.handle = async method => method === 'eth_requestAccounts' ? pending.promise : method === 'eth_chainId' ? '0x7a69' : [BOB];
    const controller = new EvmWalletController(() => provider, state.publish);
    const connecting = controller.connect(); controller.disconnect();
    pending.resolve([ALICE]); await connecting;
    expect(state.snapshot().connected).toBe(false);
    const requestCount = provider.requests.length; provider.emit('accountsChanged');
    expect(provider.requests).toHaveLength(requestCount);
    expect(state.snapshot().account).toBeNull();
    await controller.connect(); expect(state.snapshot().account?.address).toBe(ALICE);
    controller.dispose();
  });

  it('cleans subscriptions on provider replacement and ignores events from the old provider', async () => {
    const first = new Provider(); const second = new Provider(); second.accounts = [BOB];
    let injected = first; const state = observer();
    const controller = new EvmWalletController(() => injected, state.publish); await controller.start();
    injected = second; await controller.connect();
    expect(first.listenerCount()).toBe(0); expect(second.listenerCount()).toBe(3);
    const current = state.snapshot(); first.emit('chainChanged');
    expect(state.snapshot()).toBe(current);
    expect(current.account?.address).toBe(BOB);
    controller.dispose();
  });

  it('unmount cleanup detaches listeners and prevents pending requests from publishing', async () => {
    const provider = new Provider(); const pending = deferred<unknown>(); const state = observer();
    provider.handle = async () => pending.promise;
    const controller = new EvmWalletController(() => provider, state.publish);
    const startup = controller.start(); expect(provider.listenerCount()).toBe(3);
    controller.dispose(); const callCount = state.publish.mock.calls.length;
    pending.resolve([ALICE]); await startup; provider.emit('accountsChanged');
    expect(provider.listenerCount()).toBe(0); expect(state.publish).toHaveBeenCalledTimes(callCount);
  });

  it('clears only current failed identity reads and reports missing wallet errors', async () => {
    const state = observer();
    await expect(new EvmWalletController(() => undefined, state.publish).connect()).rejects.toThrow('Enable an EVM wallet');
    const provider = new Provider(); const controller = new EvmWalletController(() => provider, state.publish);
    await controller.start(); expect(state.snapshot().connected).toBe(true);
    provider.handle = async () => { throw new Error('wallet unavailable'); };
    await expect(controller.connect()).rejects.toThrow('wallet unavailable');
    expect(state.snapshot()).toEqual({ connected: false, account: null, network: null, isLoading: false });
    controller.dispose();
  });
});
