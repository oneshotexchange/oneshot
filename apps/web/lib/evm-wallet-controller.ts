import { parseEvmIdentity, type EvmIdentity } from './evm-wallet-state';

export type EvmProvider = {
  request(input: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
};
export type EvmWalletSnapshot = EvmIdentity & { isLoading: boolean };
const empty = (): EvmWalletSnapshot => ({ connected: false, account: null, network: null, isLoading: false });

/** One provider subscription and a revision gate for every asynchronous state update.
 * Wallet connection supplies identity only, never server authentication or chain verification.
 */
export class EvmWalletController {
  private provider: EvmProvider | undefined;
  private unsubscribe: (() => void) | undefined;
  private revision = 0;
  private disconnected = false;
  private disposed = false;

  constructor(
    private readonly discover: () => EvmProvider | undefined,
    private readonly publish: (snapshot: EvmWalletSnapshot) => void,
  ) {}

  async start(): Promise<void> {
    if (this.disposed || !this.discover()) return;
    await this.sync(false);
  }

  async connect(): Promise<void> {
    await this.sync(true);
  }

  disconnect(): void {
    if (this.disposed) return;
    this.disconnected = true;
    this.revision++;
    this.publish(empty());
  }

  dispose(): void {
    this.disposed = true;
    this.revision++;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.provider = undefined;
  }

  private adopt(wallet: EvmProvider): void {
    if (wallet === this.provider) return;
    this.revision++;
    this.unsubscribe?.();
    this.provider = wallet;
    const changed = () => {
      if (this.disposed || wallet !== this.provider) return;
      // Invalidate the whole account/chain pair immediately, before starting fresh reads.
      this.revision++;
      this.publish(empty());
      if (!this.disconnected) void this.sync(false).catch(() => { /* Current failures are handled inside sync. */ });
    };
    const lost = () => {
      if (this.disposed || wallet !== this.provider) return;
      this.revision++;
      this.publish(empty());
    };
    wallet.on?.('accountsChanged', changed);
    wallet.on?.('chainChanged', changed);
    wallet.on?.('disconnect', lost);
    this.unsubscribe = () => {
      wallet.removeListener?.('accountsChanged', changed);
      wallet.removeListener?.('chainChanged', changed);
      wallet.removeListener?.('disconnect', lost);
    };
  }

  private current(version: number, wallet: EvmProvider): boolean {
    return !this.disposed && !this.disconnected && version === this.revision && wallet === this.provider;
  }

  private async sync(requestPermission: boolean): Promise<void> {
    if (this.disposed) return;
    // Discovery also runs on explicit connect, so delayed injection gets listeners too.
    const wallet = this.discover() || this.provider;
    if (!wallet) throw new Error('Enable an EVM wallet extension or open oneshot in an EVM wallet browser.');
    this.adopt(wallet);
    if (requestPermission) this.disconnected = false;
    if (this.disconnected) return;
    const version = ++this.revision;
    this.publish({ ...empty(), isLoading: true });
    try {
      const accounts = await wallet.request({ method: requestPermission ? 'eth_requestAccounts' : 'eth_accounts' });
      if (!this.current(version, wallet)) return;
      const chainId = await wallet.request({ method: 'eth_chainId' });
      if (this.current(version, wallet)) this.publish({ ...parseEvmIdentity(accounts, chainId), isLoading: false });
    } catch (error) {
      // A stale rejection must not clear a newer identity or its loading state.
      if (!this.current(version, wallet)) return;
      this.publish(empty());
      throw error;
    }
  }
}
