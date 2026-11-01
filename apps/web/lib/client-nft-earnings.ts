import type { NftEarningsPage } from '@oneshot/evm';

export type NftEarningsScope = { identityScope: string; wallet: string; deploymentId: string };
export type NftEarningsFetcher = (input: { wallet: string; cursor?: string }, signal?: AbortSignal) => Promise<NftEarningsPage>;
export type NftEarningsState = { key: string | null; data: NftEarningsPage | null; loading: boolean; loadingMore: boolean; error: string | null };
const address = (value: unknown): value is string => typeof value === 'string' && /^0x[\da-f]{40}$/i.test(value);
const hash = (value: unknown): value is string => typeof value === 'string' && /^0x[\da-f]{64}$/i.test(value);
const deployment = (value: unknown): value is string => typeof value === 'string' && /^[\da-f]{64}$/i.test(value);
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const uint = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9]\d{0,77})$/.test(value) && BigInt(value) < (1n << 256n);
const empty = (key: string | null): NftEarningsState => ({ key, data: null, loading: Boolean(key), loadingMore: false, error: null });
const invalid = (): never => { throw new Error('Earnings could not be verified for this wallet and network. Refresh before continuing.'); };
const changed = (): never => { throw new Error('Earnings changed. Refresh to check the amount available to claim.'); };

export function nftEarningsScopeKey(scope: NftEarningsScope | null): string | null {
  return scope && typeof scope.identityScope === 'string' && scope.identityScope.length > 0 && address(scope.wallet) && deployment(scope.deploymentId)
    ? JSON.stringify([scope.identityScope, scope.wallet.toLowerCase(), scope.deploymentId.toLowerCase()]) : null;
}

/** Validate one server page, keeping only the public amount and contract fields. */
export function validateNftEarningsPage(value: NftEarningsPage, scope: NftEarningsScope): NftEarningsPage {
  if (!nftEarningsScopeKey(scope) || !object(value) || !object(value.network) || value.network.mode !== 'local' || value.network.chainId !== 31337
    || value.network.nativeSymbol !== 'ETH' || value.network.nativeDecimals !== 18 || typeof value.network.name !== 'string' || value.network.name.length > 100
    || !deployment(value.deploymentId) || value.deploymentId.toLowerCase() !== scope.deploymentId.toLowerCase()
    || !address(value.wallet) || value.wallet.toLowerCase() !== scope.wallet.toLowerCase()
    || !uint(value.blockNumber) || !hash(value.blockHash) || !uint(value.blockTimestamp)
    || !object(value.marketplace) || !address(value.marketplace.contract) || !uint(value.marketplace.amountRaw)
    || !Array.isArray(value.collections) || value.collections.length > 10 || !Number.isSafeInteger(value.scannedCount) || value.scannedCount < 0
    || !uint(value.totalCollectionsRaw) || BigInt(value.scannedCount) > BigInt(value.totalCollectionsRaw)
    || !(value.nextCursor === null || typeof value.nextCursor === 'string' && value.nextCursor.length > 0 && value.nextCursor.length <= 2048)) return invalid();
  const seen = new Set<string>();
  const collections = value.collections.map(item => {
    if (!object(item) || !address(item.contract) || typeof item.name !== 'string' || item.name.length > 200
      || typeof item.opened !== 'boolean' || !uint(item.amountRaw) || seen.has(item.contract.toLowerCase())
      || item.contract.toLowerCase() === value.marketplace.contract.toLowerCase()) return invalid();
    seen.add(item.contract.toLowerCase());
    return { contract: item.contract.toLowerCase(), name: item.name, opened: item.opened, amountRaw: item.amountRaw };
  });
  // The cursor describes every scanned factory entry, including zero balances.
  if (collections.length > value.scannedCount || value.nextCursor === null && BigInt(value.scannedCount) !== BigInt(value.totalCollectionsRaw)
    || value.nextCursor !== null && (collections.length === 0 || BigInt(value.scannedCount) >= BigInt(value.totalCollectionsRaw))) return invalid();
  return {
    network: { mode: 'local', chainId: 31337, name: value.network.name, nativeSymbol: 'ETH', nativeDecimals: 18 },
    deploymentId: value.deploymentId.toLowerCase(), wallet: value.wallet.toLowerCase(), blockNumber: value.blockNumber,
    blockHash: value.blockHash.toLowerCase(), blockTimestamp: value.blockTimestamp,
    marketplace: { contract: value.marketplace.contract.toLowerCase(), amountRaw: value.marketplace.amountRaw },
    collections, scannedCount: value.scannedCount, totalCollectionsRaw: value.totalCollectionsRaw, nextCursor: value.nextCursor,
  };
}

/** Reads current credits only. Loading, refreshing and paging never request a signature. */
export class NftEarningsController {
  private state: NftEarningsState = empty(null);
  private scope: NftEarningsScope | null = null;
  private generation = 0;
  private controller: AbortController | null = null;
  private usedCursors = new Set<string>();
  private listeners = new Set<() => void>();
  constructor(private readonly fetcher: NftEarningsFetcher) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(state: NftEarningsState) { this.state = state; for (const listener of this.listeners) listener(); }
  private abort() { this.generation += 1; this.controller?.abort(); this.controller = null; }
  cancel = () => { this.abort(); this.scope = null; this.usedCursors.clear(); this.publish(empty(null)); };
  async open(scope: NftEarningsScope | null): Promise<void> {
    this.abort(); this.usedCursors.clear();
    const key = nftEarningsScopeKey(scope), ticket = this.generation;
    this.scope = key && scope ? { ...scope, wallet: scope.wallet.toLowerCase(), deploymentId: scope.deploymentId.toLowerCase() } : null;
    this.publish(empty(key));
    if (!scope) return;
    if (!this.scope) { this.publish({ ...empty(null), error: 'Sign in and select your wallet on the test network before checking earnings.' }); return; }
    const selected = this.scope, controller = new AbortController(); this.controller = controller;
    try {
      const value = await this.fetcher({ wallet: selected.wallet }, controller.signal);
      if (ticket !== this.generation) return;
      const data = validateNftEarningsPage(value, selected);
      if (data.scannedCount !== data.collections.length) return invalid();
      this.publish({ key, data, loading: false, loadingMore: false, error: null });
    } catch (error) {
      if (ticket !== this.generation) return;
      this.publish({ key, data: null, loading: false, loadingMore: false, error: error instanceof Error ? error.message : 'Current earnings could not be checked.' });
    } finally { if (this.controller === controller) this.controller = null; }
  }
  refresh = () => this.open(this.scope);
  loadMore = async (): Promise<void> => {
    const previous = this.state, scope = this.scope, cursor = previous.data?.nextCursor;
    if (!scope || !previous.data || !cursor || previous.loading || previous.loadingMore || previous.error) return;
    const ticket = this.generation, controller = new AbortController(); this.controller = controller;
    this.publish({ ...previous, loadingMore: true, error: null });
    try {
      if (this.usedCursors.has(cursor)) return changed();
      this.usedCursors.add(cursor);
      const value = await this.fetcher({ wallet: scope.wallet, cursor }, controller.signal);
      if (ticket !== this.generation) return;
      const next = validateNftEarningsPage(value, scope), before = previous.data;
      if (next.blockNumber !== before.blockNumber || next.blockHash !== before.blockHash || next.blockTimestamp !== before.blockTimestamp
        || next.network.name !== before.network.name || next.totalCollectionsRaw !== before.totalCollectionsRaw
        || next.marketplace.contract !== before.marketplace.contract || next.marketplace.amountRaw !== before.marketplace.amountRaw
        || next.scannedCount <= before.scannedCount || next.scannedCount - before.scannedCount !== next.collections.length
        || next.nextCursor !== null && this.usedCursors.has(next.nextCursor)) return changed();
      const contracts = new Set(before.collections.map(item => item.contract));
      if (next.collections.some(item => contracts.has(item.contract))) return changed();
      this.publish({ key: previous.key, data: { ...next, marketplace: before.marketplace, collections: [...before.collections, ...next.collections] }, loading: false, loadingMore: false, error: null });
    } catch (error) {
      if (ticket !== this.generation) return;
      this.usedCursors.clear();
      // A forward-page failure invalidates the whole displayed balance snapshot.
      this.publish({ key: previous.key, data: null, loading: false, loadingMore: false, error: error instanceof Error ? error.message : 'More earnings could not be checked. Refresh current amounts.' });
    } finally { if (this.controller === controller) this.controller = null; }
  };
}

export const createNftEarningsController = (fetcher: NftEarningsFetcher) => new NftEarningsController(fetcher);
