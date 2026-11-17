import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { TokenWalletHoldingsResponse } from '@oneshot/evm';
import { apiUrl } from './api-url';
import { customerErrorDetails, customerFetch, customerResponseJson } from './customer-http';
import { tokenAnalyticsCheckpointKey, tokenAnalyticsPosition, validTokenAnalyticsContext, validTokenAnalyticsPrice } from './client-token-analytics';
import { validTokenMarketRecord } from './client-token-markets';

const address = (value: unknown): value is string => typeof value === 'string' && /^0x[\da-f]{40}$/i.test(value) && !/^0x0{40}$/i.test(value);
const integer = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) && value.length <= 256;
const amount = (value: unknown): value is string => integer(value) && BigInt(value) < 2n ** 256n;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
export class TokenPortfolioReadError extends Error { constructor(readonly status: number, readonly code: string, message: string) { super(message); } }
const invalid = () => new TokenPortfolioReadError(502, 'TOKEN_HOLDINGS_INVALID', 'Token balances could not be verified. Refresh the token balances to try again.');
const unavailable = 'Token balances could not be loaded. Please try again.';
const validLimit = (limit: number) => Number.isInteger(limit) && limit >= 2 && limit <= 5;

/** Holdings, contract proofs, prices and balance-change records must describe one wallet/checkpoint. */
export function validateTokenWalletHoldings(value: unknown, wallet: string, limit = 3, expectedChainId?: number, cursor?: string): TokenWalletHoldingsResponse {
  if (!address(wallet) || !validLimit(limit) || !object(value) || !validTokenAnalyticsContext(value.context) || !address(value.wallet) || value.wallet.toLowerCase() !== wallet.toLowerCase() || value.scope !== 'registered-token-markets'
    || !Array.isArray(value.items) || value.items.length > limit || !(value.nextCursor === null || typeof value.nextCursor === 'string' && /^[\w-]{1,2048}$/.test(value.nextCursor))) throw invalid();
  if (!value.context.available) { if (value.holdingCount !== null || value.items.length !== 0 || value.nextCursor !== null) throw invalid(); return value as TokenWalletHoldingsResponse; }
  if (expectedChainId !== undefined && value.context.network?.chainId !== expectedChainId) throw new TokenPortfolioReadError(409, 'TOKEN_NETWORK_CHANGED', 'Token balances use a different network from these portfolio records. Refresh the portfolio before continuing.');
  if (!integer(value.holdingCount) || BigInt(value.items.length) > BigInt(value.holdingCount) || (value.holdingCount === '0' ? value.items.length !== 0 || value.nextCursor !== null : value.items.length === 0)) throw invalid();
  if (cursor === undefined && (BigInt(value.items.length) !== (BigInt(value.holdingCount) < BigInt(limit) ? BigInt(value.holdingCount) : BigInt(limit)) || (value.nextCursor === null) !== (BigInt(value.items.length) === BigInt(value.holdingCount)))) throw invalid();
  if (!value.items.every(item => object(item) && validTokenMarketRecord(item.market) && amount(item.balanceRaw) && item.balanceRaw !== '0' && BigInt(item.balanceRaw) <= BigInt(item.market.totalSupplyRaw)
    && validTokenAnalyticsPrice(item.price, value.context as TokenWalletHoldingsResponse['context']) && tokenAnalyticsPosition(item.lastBalanceBlockNumber, item.lastBalanceBlockHash, value.context as TokenWalletHoldingsResponse['context']))
    || value.items.some((item, index, items) => index > 0 && item.market.token.toLowerCase() <= items[index - 1].market.token.toLowerCase())
    || new Set(value.items.map(item => item.market.market.toLowerCase())).size !== value.items.length) throw invalid();
  return value as TokenWalletHoldingsResponse;
}
export function tokenWalletHoldingsPath(wallet: string, limit = 3, cursor?: string) {
  if (!address(wallet) || !validLimit(limit) || cursor !== undefined && !/^[\w-]{1,2048}$/.test(cursor)) throw new TokenPortfolioReadError(400, 'TOKEN_HOLDINGS_INPUT_INVALID', 'Enter a complete Ethereum wallet address and try again.');
  const params = new URLSearchParams({ limit: String(limit) }); if (cursor) params.set('cursor', cursor);
  return `/api/oneshot/token-analytics/wallets/${wallet.toLowerCase()}?${params}`;
}
export async function readTokenWalletHoldings(wallet: string, signal?: AbortSignal, cursor?: string, limit = 3, expectedChainId?: number, fetcher: typeof fetch = fetch): Promise<TokenWalletHoldingsResponse> {
  const response = await customerFetch(apiUrl(tokenWalletHoldingsPath(wallet, limit, cursor)), { signal, credentials: 'omit', redirect: 'error', cache: 'no-store' }, fetcher);
  const body = await customerResponseJson(response, { signal, invalidResponse: invalid });
  if (!response.ok) { const { code } = customerErrorDetails(body); throw new TokenPortfolioReadError(response.status, code || 'TOKEN_HOLDINGS_READ_FAILED', response.status === 409 ? 'Token balances changed. Refresh this wallet’s token balances from the beginning.' : response.status === 429 ? 'Too many requests. Wait a moment and refresh the token balances.' : unavailable); }
  return validateTokenWalletHoldings(body, wallet, limit, expectedChainId, cursor);
}

type Scope = { wallet: string; chainId?: number; limit?: number };
type State = { key: string | null; data: TokenWalletHoldingsResponse | null; loading: boolean; loadingMore: boolean; error: string | null; stale: boolean };
const scopeKey = (scope: Scope | null) => scope ? JSON.stringify([scope.wallet.toLowerCase(), scope.chainId, scope.limit ?? 3]) : null;
const empty = (key: string | null): State => ({ key, data: null, loading: Boolean(key), loadingMore: false, error: null, stale: false });
/** Public wallet inspection is independent of the signing account and never carries bearer credentials. */
export class TokenPortfolioLoader {
  private state = empty(null); private scope: Scope | null = null; private generation = 0; private abort: AbortController | null = null; private listeners = new Set<() => void>();
  constructor(private readonly fetcher = readTokenWalletHoldings) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(state: State) { this.state = state; for (const listener of this.listeners) listener(); }
  cancel() { this.generation++; this.abort?.abort(); this.abort = null; }
  open = async (input: Scope | null) => {
    this.cancel(); this.scope = input ? { ...input, wallet: input.wallet.toLowerCase() } : null;
    const scope = this.scope, key = scopeKey(scope), ticket = this.generation; this.publish(empty(key)); if (!scope) return;
    const abort = new AbortController(); this.abort = abort;
    try { const value = await this.fetcher(scope.wallet, abort.signal, undefined, scope.limit ?? 3, scope.chainId); if (ticket !== this.generation) return; const data = validateTokenWalletHoldings(value, scope.wallet, scope.limit ?? 3, scope.chainId); this.publish({ key, data, loading: false, loadingMore: false, error: null, stale: false }); }
    catch (error) { if (ticket === this.generation) this.publish({ ...empty(key), loading: false, error: error instanceof TokenPortfolioReadError ? error.message : unavailable }); }
  };
  refresh = () => this.open(this.scope);
  loadMore = async () => {
    const previous = this.state, scope = this.scope; if (!scope || !previous.data?.nextCursor || previous.loading || previous.loadingMore) return;
    const ticket = this.generation, cursor = previous.data.nextCursor, abort = new AbortController(); this.abort = abort; this.publish({ ...previous, loadingMore: true, error: null });
    try {
      const value = await this.fetcher(scope.wallet, abort.signal, cursor, scope.limit ?? 3, scope.chainId); if (ticket !== this.generation) return;
      const next = validateTokenWalletHoldings(value, scope.wallet, scope.limit ?? 3, scope.chainId, cursor);
      if (tokenAnalyticsCheckpointKey(previous.data.context) !== tokenAnalyticsCheckpointKey(next.context) || previous.data.holdingCount !== next.holdingCount) { this.publish({ ...previous, data: null, loadingMore: false, error: 'The token balance checkpoint changed. Refresh this wallet’s token balances.', stale: true }); return; }
      if (next.nextCursor === cursor || previous.data.items.length && next.items.length && previous.data.items.at(-1)!.market.token.toLowerCase() >= next.items[0].market.token.toLowerCase()
        || BigInt(previous.data.items.length + next.items.length) > BigInt(next.holdingCount!)) throw invalid();
      const items = [...previous.data.items, ...next.items]; if (new Set(items.map(item => item.market.market.toLowerCase())).size !== items.length) throw invalid();
      if ((next.nextCursor === null) !== (BigInt(items.length) === BigInt(next.holdingCount!))) throw invalid();
      this.publish({ ...previous, data: { ...next, items }, loadingMore: false });
    } catch (error) { if (ticket !== this.generation) return; this.publish(error instanceof TokenPortfolioReadError && error.status === 409 ? { ...previous, data: null, loadingMore: false, error: error.message, stale: true } : { ...previous, loadingMore: false, error: error instanceof TokenPortfolioReadError ? error.message : unavailable }); }
  };
}
export function useTokenPortfolio(wallet: string | null, expectedChainId?: number) {
  const loader = useMemo(() => new TokenPortfolioLoader(), []), state = useSyncExternalStore(loader.subscribe, loader.snapshot, loader.snapshot);
  const scope = wallet ? { wallet, chainId: expectedChainId } : null, key = scopeKey(scope);
  useEffect(() => { void loader.open(scope); return () => loader.cancel(); }, [loader, key]);
  return { ...(state.key === key ? state : empty(key)), refresh: loader.refresh, loadMore: loader.loadMore };
}
