import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { IndexedTokenSource, TokenAnalyticsContext, TokenAnalyticsFeedResponse, TokenAnalyticsMarketResponse, TokenAnalyticsTrade, TokenAnalyticsTradesResponse, TokenAnalyticsHoldersResponse, TokenPoolPrice } from '@oneshot/evm';
import { apiUrl } from './api-url';
import { customerErrorDetails, customerFetch, customerResponseJson } from './customer-http';
import { validTokenMarketRecord, validTokenSource } from './client-token-markets';
import { nativeTokenPriceMatchesSqrt } from './token-price';
import { encodeFollowedWallets } from './wallet-following';

const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const uint = (value: unknown): value is string => typeof value === 'string' && value.length <= 256 && /^(0|[1-9]\d*)$/.test(value);
const bounded = (value: unknown, bits = 256): value is string => uint(value) && BigInt(value) < 2n ** BigInt(bits);
const address = (value: unknown): value is string => typeof value === 'string' && /^0x[\da-f]{40}$/i.test(value) && !/^0x0{40}$/i.test(value);
const hash = (value: unknown): value is string => typeof value === 'string' && /^0x[\da-f]{64}$/i.test(value) && !/^0x0{64}$/i.test(value);
const tick = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= -887272 && value <= 887272;
const signed = (value: unknown): value is string => typeof value === 'string' && /^(0|-?[1-9]\d{0,38})$/.test(value) && BigInt(value) >= -(2n ** 127n) && BigInt(value) < 2n ** 127n;
const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
const unavailable = 'Token activity could not be loaded. Refresh the activity to try again.';
export class TokenAnalyticsReadError extends Error { constructor(readonly status: number, readonly code: string, message: string) { super(message); } }
const invalid = () => new TokenAnalyticsReadError(502, 'TOKEN_ANALYTICS_INVALID', 'Token activity could not be verified. Refresh the activity to try again.');

export function validTokenAnalyticsContext(value: unknown): value is TokenAnalyticsContext {
  if (!object(value) || value.schemaVersion !== 1 || value.kind !== 'canonical-event-journal' || value.readonly !== true || value.finalized !== false
    || typeof value.enabled !== 'boolean' || typeof value.available !== 'boolean' || !(value.reason === null || typeof value.reason === 'string')) return false;
  if (!value.available) return value.deploymentId === null && value.network === null && value.source === null && value.checkpoint === null && value.observedHeadNumber === null && value.lagBlocks === null;
  const checkpoint = value.checkpoint;
  return value.enabled && value.reason === null && typeof value.deploymentId === 'string' && /^[\da-f]{64}$/.test(value.deploymentId)
    && validTokenSource(value.network, value.source) && object(checkpoint) && bounded(checkpoint.number) && hash(checkpoint.hash)
    && typeof checkpoint.parentHash === 'string' && /^0x[\da-f]{64}$/i.test(checkpoint.parentHash) && (checkpoint.number === '0' || hash(checkpoint.parentHash)) && bounded(checkpoint.timestamp)
    && bounded(value.observedHeadNumber) && bounded(value.lagBlocks) && BigInt(value.observedHeadNumber) >= BigInt(checkpoint.number) && BigInt(value.lagBlocks) === BigInt(value.observedHeadNumber) - BigInt(checkpoint.number);
}
export function tokenAnalyticsPosition(number: unknown, blockHash: unknown, context: TokenAnalyticsContext) {
  return bounded(number) && hash(blockHash) && context.checkpoint !== null && BigInt(number) <= BigInt(context.checkpoint.number)
    && (number !== context.checkpoint.number || same(blockHash, context.checkpoint.hash));
}
export function validTokenAnalyticsPrice(value: unknown, context: TokenAnalyticsContext): value is TokenPoolPrice {
  return object(value) && tick(value.tick) && nativeTokenPriceMatchesSqrt(value.nativeRawPerWholeToken, value.sqrtPriceX96Raw) && tokenAnalyticsPosition(value.blockNumber, value.blockHash, context);
}
export function validateTokenAnalyticsMarket(value: unknown, expectedMarket: string): TokenAnalyticsMarketResponse {
  if (!address(expectedMarket) || !object(value) || !validTokenAnalyticsContext(value.context)) throw invalid();
  if (!value.context.available) { if (value.market !== null || value.analytics !== null) throw invalid(); return value as TokenAnalyticsMarketResponse; }
  const market = value.market, analytics = value.analytics;
  if (!validTokenMarketRecord(market) || !same(market.market, expectedMarket) || !object(analytics)
    || analytics.market !== market.market || analytics.token !== market.token || analytics.creator !== market.creator || analytics.poolId !== market.poolId || analytics.tokenDecimals !== 8 || analytics.holderScope !== 'all-nonzero-balance-addresses'
    || !['observedSupplyRaw', 'mintedRaw', 'burnedRaw', 'holderCount', 'poolSwaps', 'poolNativeVolumeRaw', 'poolTokenVolumeRaw', 'oneshotTrades', 'oneshotBuys', 'oneshotSells', 'oneshotGrossNativeVolumeRaw', 'oneshotExecutionFeesRaw'].every(key => uint(analytics[key]))) throw invalid();
  if (analytics.mintedRaw !== market.initialSupplyRaw || analytics.observedSupplyRaw !== market.totalSupplyRaw
    || BigInt(analytics.burnedRaw as string) + BigInt(analytics.observedSupplyRaw as string) !== BigInt(analytics.mintedRaw as string)
    || BigInt(analytics.holderCount as string) > BigInt(analytics.observedSupplyRaw as string) || (analytics.observedSupplyRaw === '0') !== (analytics.holderCount === '0')
    || BigInt(analytics.oneshotTrades as string) !== BigInt(analytics.oneshotBuys as string) + BigInt(analytics.oneshotSells as string)
    || BigInt(analytics.oneshotExecutionFeesRaw as string) > BigInt(analytics.oneshotGrossNativeVolumeRaw as string) * BigInt(market.executionFeeBps) / 10000n
    || analytics.oneshotTrades === '0' && (analytics.oneshotGrossNativeVolumeRaw !== '0' || analytics.oneshotExecutionFeesRaw !== '0')
    || BigInt(analytics.oneshotGrossNativeVolumeRaw as string) < BigInt(analytics.oneshotTrades as string)
    || analytics.poolSwaps === '0' && (analytics.poolNativeVolumeRaw !== '0' || analytics.poolTokenVolumeRaw !== '0')) throw invalid();
  const price = analytics.price;
  if (!validTokenAnalyticsPrice(price, value.context)) throw invalid();
  return value as TokenAnalyticsMarketResponse;
}

type Reference = { token: string; poolId: string; executionFeeBps: number };
export type TokenAnalyticsTradeKind = 'pool-swap' | 'oneshot-trade' | 'all';
export type TokenAnalyticsPageRequest = { market: string; view: TokenAnalyticsTradeKind | 'holders'; limit?: number; reference?: Reference };
const validRequest = (request: TokenAnalyticsPageRequest) => address(request.market) && ['pool-swap', 'oneshot-trade', 'all', 'holders'].includes(request.view)
  && Number.isInteger(request.limit ?? 20) && (request.limit ?? 20) >= 1 && (request.limit ?? 20) <= 50
  && (!request.reference || address(request.reference.token) && hash(request.reference.poolId) && Number.isInteger(request.reference.executionFeeBps) && request.reference.executionFeeBps >= 100 && request.reference.executionFeeBps <= 500 && request.reference.executionFeeBps % 10 === 0);
type Page = TokenAnalyticsTradesResponse | TokenAnalyticsHoldersResponse;
function validTrade(value: unknown, market: string | undefined, context: TokenAnalyticsContext, reference?: Reference): value is TokenAnalyticsTrade {
  if (!object(value) || !address(value.market) || (market !== undefined && !same(value.market, market)) || !tokenAnalyticsPosition(value.blockNumber, value.blockHash, context) || !bounded(value.timestamp) || BigInt(value.timestamp) > BigInt(context.checkpoint!.timestamp)
    || !hash(value.transactionHash) || !Number.isSafeInteger(value.transactionIndex) || Number(value.transactionIndex) < 0 || !Number.isSafeInteger(value.logIndex) || Number(value.logIndex) < 0 || Number(value.logIndex) > 2147483647
    || value.id !== `${value.transactionHash}:${value.logIndex}`) return false;
  if (value.kind === 'pool-swap') return hash(value.poolId) && (!reference || same(value.poolId, reference.poolId)) && address(value.poolSender) && value.trader === null && value.recipient === null
    && signed(value.amount0Raw) && signed(value.amount1Raw) && bounded(value.sqrtPriceX96Raw, 160) && value.sqrtPriceX96Raw !== '0' && bounded(value.liquidityRaw, 128)
    && tick(value.tick) && Number.isInteger(value.feePips) && Number(value.feePips) >= 0 && Number(value.feePips) <= 1000000;
  return value.kind === 'oneshot-trade' && address(value.token) && (!reference || same(value.token, reference.token)) && address(value.trader) && address(value.recipient) && typeof value.buy === 'boolean'
    && bounded(value.tokensRaw) && value.tokensRaw !== '0' && bounded(value.grossNativeRaw) && value.grossNativeRaw !== '0' && bounded(value.netNativeRaw) && value.netNativeRaw !== '0' && bounded(value.executionFeeRaw)
    && BigInt(value.netNativeRaw) + BigInt(value.executionFeeRaw) === BigInt(value.grossNativeRaw)
    && (!reference || BigInt(value.executionFeeRaw) === BigInt(value.grossNativeRaw) * BigInt(reference.executionFeeBps) / 10000n);
}
const validCursor = (value: unknown) => value === null || typeof value === 'string' && value.length > 0 && value.length <= 2048 && /^[\w-]+$/.test(value);
const afterTrade = (older: TokenAnalyticsTrade, newer: TokenAnalyticsTrade) => BigInt(older.blockNumber) < BigInt(newer.blockNumber) || older.blockNumber === newer.blockNumber && older.logIndex < newer.logIndex;
export function validateTokenAnalyticsTrades(value: unknown, request: TokenAnalyticsPageRequest): TokenAnalyticsTradesResponse {
  if (!validRequest(request) || request.view === 'holders' || !object(value) || !validTokenAnalyticsContext(value.context) || !address(value.market) || !same(value.market, request.market) || value.kind !== request.view || !Array.isArray(value.items) || value.items.length > (request.limit ?? 20)
    || !validCursor(value.nextCursor) || !value.context.available && (value.items.length !== 0 || value.nextCursor !== null) || value.nextCursor !== null && value.items.length === 0
    || !value.items.every(item => validTrade(item, request.market, value.context as TokenAnalyticsContext, request.reference))
    || value.items.some((item, index, items) => (request.view !== 'all' && item.kind !== request.view) || index > 0 && !afterTrade(item, items[index - 1]))) throw invalid();
  return value as TokenAnalyticsTradesResponse;
}
export function validateTokenAnalyticsHolders(value: unknown, request: TokenAnalyticsPageRequest): TokenAnalyticsHoldersResponse {
  if (!validRequest(request) || request.view !== 'holders' || !object(value) || !validTokenAnalyticsContext(value.context) || !address(value.market) || !same(value.market, request.market) || value.scope !== 'all-nonzero-balance-addresses' || !Array.isArray(value.items)
    || value.items.length > (request.limit ?? 20) || !validCursor(value.nextCursor) || value.nextCursor !== null && value.items.length === 0
    || (value.context.available ? !address(value.token) || request.reference && !same(value.token, request.reference.token) : value.token !== null || value.items.length !== 0 || value.nextCursor !== null)
    || !value.items.every(item => object(item) && address(item.wallet) && bounded(item.balanceRaw) && item.balanceRaw !== '0' && BigInt(item.balanceRaw) <= 100000000000000000n && tokenAnalyticsPosition(item.lastBlockNumber, item.lastBlockHash, value.context as TokenAnalyticsContext))
    || value.items.some((item, index, items) => index > 0 && item.wallet.toLowerCase() <= items[index - 1].wallet.toLowerCase())) throw invalid();
  return value as TokenAnalyticsHoldersResponse;
}

function sourceKey(source: IndexedTokenSource | null) { return source && [source.chainId, source.genesisHash.toLowerCase(), ...[source.factory, source.poolManager, source.oracle, source.quoter].map(contract => [contract.address.toLowerCase(), contract.codeHash.toLowerCase()])]; }
export function tokenAnalyticsCheckpointKey(context: TokenAnalyticsContext) {
  return JSON.stringify([context.network?.chainId, context.deploymentId, sourceKey(context.source), context.available, context.checkpoint && [context.checkpoint.number, context.checkpoint.hash.toLowerCase(), context.checkpoint.parentHash.toLowerCase(), context.checkpoint.timestamp]]);
}
export function tokenAnalyticsSourceMatches(context: TokenAnalyticsContext, expected: { deploymentId: string | null; network: { chainId: number } | null; source: IndexedTokenSource | null }) {
  return context.available && context.deploymentId === expected.deploymentId && context.network?.chainId === expected.network?.chainId && JSON.stringify(sourceKey(context.source)) === JSON.stringify(sourceKey(expected.source));
}
export function tokenAnalyticsPagePath(request: TokenAnalyticsPageRequest, cursor?: string) {
  if (!validRequest(request) || cursor !== undefined && !validCursor(cursor)) throw new TokenAnalyticsReadError(400, 'TOKEN_ANALYTICS_INPUT_INVALID', 'Check the market or page selection and try again.');
  const params = new URLSearchParams({ limit: String(request.limit ?? 20) }); if (request.view !== 'holders') params.set('kind', request.view); if (cursor) params.set('cursor', cursor);
  return `/api/oneshot/token-analytics/markets/${request.market.toLowerCase()}/${request.view === 'holders' ? 'holders' : 'trades'}?${params}`;
}
async function read<T>(path: string, validate: (value: unknown) => T, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<T> {
  const response = await customerFetch(apiUrl(path), { signal, credentials: 'omit', redirect: 'error', cache: 'no-store' }, fetcher), body = await customerResponseJson(response, { signal, invalidResponse: invalid });
  if (!response.ok) { const { code } = customerErrorDetails(body); throw new TokenAnalyticsReadError(response.status, code || 'TOKEN_ANALYTICS_READ_FAILED', response.status === 409 ? 'Token activity changed. Refresh the activity from the beginning.' : response.status === 404 ? 'This market has no verified activity record at this checkpoint. Refresh or browse another token.' : response.status === 429 ? 'Too many requests. Wait a moment and refresh the activity.' : unavailable); }
  return validate(body);
}
export function readTokenAnalyticsMarket(market: string, signal?: AbortSignal, fetcher?: typeof fetch) {
  if (!address(market)) return Promise.reject(invalid());
  return read(`/api/oneshot/token-analytics/markets/${market.toLowerCase()}`, value => validateTokenAnalyticsMarket(value, market), signal, fetcher);
}
export function readTokenAnalyticsPage(request: TokenAnalyticsPageRequest, signal?: AbortSignal, cursor?: string, fetcher?: typeof fetch) { return read(tokenAnalyticsPagePath(request, cursor), value => request.view === 'holders' ? validateTokenAnalyticsHolders(value, request) : validateTokenAnalyticsTrades(value, request), signal, fetcher); }

type PageState = { key: string | null; data: Page | null; loading: boolean; loadingMore: boolean; error: string | null; notice: string | null; stale: boolean };
const empty = (key: string | null): PageState => ({ key, data: null, loading: Boolean(key), loadingMore: false, error: null, notice: null, stale: false });
const requestKey = (request: TokenAnalyticsPageRequest | null) => request ? JSON.stringify([request.market.toLowerCase(), request.view, request.limit ?? 20, request.reference?.token.toLowerCase(), request.reference?.poolId.toLowerCase(), request.reference?.executionFeeBps]) : null;
/** Pages remain attached to one market/filter/limit and one canonical source checkpoint. */
export class TokenAnalyticsPageLoader {
  private state = empty(null); private request: TokenAnalyticsPageRequest | null = null; private generation = 0; private abort: AbortController | null = null; private listeners = new Set<() => void>();
  constructor(private readonly fetcher = readTokenAnalyticsPage) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(value: PageState) { this.state = value; for (const listener of this.listeners) listener(); }
  cancel() { this.generation++; this.abort?.abort(); this.abort = null; }
  open = async (request: TokenAnalyticsPageRequest | null, notice: string | null = null) => {
    this.cancel(); this.request = request ? structuredClone(request) : null; const key = requestKey(request), ticket = this.generation; this.publish({ ...empty(key), notice }); if (!request) return;
    const abort = new AbortController(); this.abort = abort;
    try { const value = await this.fetcher(request, abort.signal); const data = request.view === 'holders' ? validateTokenAnalyticsHolders(value, request) : validateTokenAnalyticsTrades(value, request); if (ticket === this.generation) this.publish({ key, data, loading: false, loadingMore: false, error: null, notice, stale: false }); }
    catch (error) { if (ticket === this.generation) this.publish({ ...empty(key), loading: false, error: error instanceof TokenAnalyticsReadError ? error.message : unavailable, notice }); }
  };
  refresh = () => this.open(this.request);
  loadMore = async () => {
    const previous = this.state, request = this.request; if (!request || !previous.data?.nextCursor || previous.loading || previous.loadingMore) return;
    const ticket = this.generation, cursor = previous.data.nextCursor, abort = new AbortController(); this.abort = abort; this.publish({ ...previous, loadingMore: true, error: null });
    try {
      const value = await this.fetcher(request, abort.signal, cursor); if (ticket !== this.generation) return;
      const next = request.view === 'holders' ? validateTokenAnalyticsHolders(value, request) : validateTokenAnalyticsTrades(value, request);
      if (tokenAnalyticsCheckpointKey(previous.data.context) !== tokenAnalyticsCheckpointKey(next.context)) { this.publish({ ...previous, data: null, loadingMore: false, stale: true, error: 'The activity checkpoint changed. Refresh all activity before continuing.' }); return; }
      if (next.nextCursor === cursor) throw invalid();
      let data: Page;
      if ('scope' in previous.data && 'scope' in next) {
        if (previous.data.items.length && next.items.length && previous.data.items.at(-1)!.wallet.toLowerCase() >= next.items[0].wallet.toLowerCase()) throw invalid();
        data = { ...next, items: [...previous.data.items, ...next.items] };
      } else if ('kind' in previous.data && 'kind' in next) {
        if (previous.data.items.length && next.items.length && !afterTrade(next.items[0], previous.data.items.at(-1)!)) throw invalid();
        data = { ...next, items: [...previous.data.items, ...next.items] };
      } else throw invalid();
      this.publish({ ...previous, data, loadingMore: false });
    } catch (error) { if (ticket !== this.generation) return; if (error instanceof TokenAnalyticsReadError && error.status === 409) this.publish({ ...previous, data: null, loadingMore: false, stale: true, error: error.message }); else this.publish({ ...previous, loadingMore: false, error: error instanceof TokenAnalyticsReadError ? error.message : unavailable }); }
  };
}
export function useTokenAnalyticsPage(request: TokenAnalyticsPageRequest | null) {
  const loader = useMemo(() => new TokenAnalyticsPageLoader(), []), state = useSyncExternalStore(loader.subscribe, loader.snapshot, loader.snapshot), key = requestKey(request);
  useEffect(() => { void loader.open(request); return () => loader.cancel(); }, [loader, key]);
  return { ...(state.key === key ? state : empty(key)), refresh: loader.refresh, loadMore: loader.loadMore };
}
export function useTokenAnalyticsMarket(market: string) {
  const [version, setVersion] = useState(0), [state, setState] = useState<{ market: string; data: TokenAnalyticsMarketResponse | null; loading: boolean; error: string | null }>({ market, data: null, loading: true, error: null });
  useEffect(() => { const abort = new AbortController(); let active = true; setState({ market, data: null, loading: true, error: null }); void readTokenAnalyticsMarket(market, abort.signal).then(data => { if (active) setState({ market, data, loading: false, error: null }); }).catch(error => { if (active) setState({ market, data: null, loading: false, error: error instanceof TokenAnalyticsReadError ? error.message : unavailable }); }); return () => { active = false; abort.abort(); }; }, [market, version]);
  return { ...(state.market === market ? state : { market, data: null, loading: true, error: null }), refresh: () => { setState({ market, data: null, loading: true, error: null }); setVersion(value => value + 1); } };
}

export type TokenTradesFeedRequest = {
  kind: TokenAnalyticsTradeKind;
  wallet?: string;
  wallets?: string[];
  limit?: number;
};

function validFeedRequest(request: TokenTradesFeedRequest): boolean {
  if (!['pool-swap', 'oneshot-trade', 'all'].includes(request.kind)) return false;
  const limit = request.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) return false;
  if (request.wallet !== undefined && request.wallets !== undefined) return false;
  if (request.wallet !== undefined && (!address(request.wallet) || request.kind !== 'oneshot-trade')) return false;
  if (request.wallets !== undefined) {
    if (request.kind !== 'oneshot-trade' || !Array.isArray(request.wallets) || request.wallets.length === 0 || request.wallets.length > 50) return false;
    if (!request.wallets.every(item => address(item))) return false;
  }
  return true;
}

export function tokenTradesFeedPath(request: TokenTradesFeedRequest, cursor?: string): string {
  if (!validFeedRequest(request) || (cursor !== undefined && !validCursor(cursor))) {
    throw new TokenAnalyticsReadError(400, 'TOKEN_ANALYTICS_INPUT_INVALID', 'Check the trades selection and try again.');
  }
  const params = new URLSearchParams({ limit: String(request.limit ?? 20), kind: request.kind });
  if (request.wallet !== undefined) params.set('wallet', request.wallet.toLowerCase());
  if (request.wallets !== undefined) params.set('wallets', encodeFollowedWallets(request.wallets));
  if (cursor) params.set('cursor', cursor);
  return `/api/oneshot/token-analytics/trades?${params}`;
}

export function validateTokenTradesFeed(value: unknown, request: TokenTradesFeedRequest): TokenAnalyticsFeedResponse {
  if (
    !validFeedRequest(request) ||
    !object(value) ||
    !validTokenAnalyticsContext(value.context) ||
    value.kind !== request.kind ||
    value.wallet !== (request.wallet ? request.wallet.toLowerCase() : null) ||
    !Array.isArray(value.items) ||
    value.items.length > (request.limit ?? 20) ||
    !validCursor(value.nextCursor) ||
    (!value.context.available && (value.items.length !== 0 || value.nextCursor !== null)) ||
    (value.nextCursor !== null && value.items.length === 0)
  ) {
    throw invalid();
  }
  const seen = new Set<string>();
  const actors = request.wallet
    ? [request.wallet.toLowerCase()]
    : request.wallets
      ? request.wallets.map(item => item.toLowerCase())
      : null;
  for (let index = 0; index < value.items.length; index++) {
    const item = value.items[index];
    if (!validTrade(item, undefined, value.context as TokenAnalyticsContext)) throw invalid();
    if (request.kind !== 'all' && item.kind !== request.kind) throw invalid();
    if (actors && (item.kind !== 'oneshot-trade' || (!actors.includes(item.trader.toLowerCase()) && !actors.includes(item.recipient.toLowerCase())))) {
      throw invalid();
    }
    if (seen.has(item.id)) throw invalid();
    seen.add(item.id);
    if (index > 0 && !afterTrade(item, value.items[index - 1] as TokenAnalyticsTrade)) throw invalid();
  }
  return value as TokenAnalyticsFeedResponse;
}

export function readTokenTradesFeed(request: TokenTradesFeedRequest, signal?: AbortSignal, cursor?: string, fetcher?: typeof fetch) {
  return read(tokenTradesFeedPath(request, cursor), value => validateTokenTradesFeed(value, request), signal, fetcher);
}

type FeedState = { key: string | null; data: TokenAnalyticsFeedResponse | null; loading: boolean; loadingMore: boolean; error: string | null; stale: boolean };
const emptyFeed = (key: string | null): FeedState => ({ key, data: null, loading: Boolean(key), loadingMore: false, error: null, stale: false });
const feedRequestKey = (request: TokenTradesFeedRequest | null) =>
  request
    ? JSON.stringify([
        request.kind,
        request.limit ?? 20,
        request.wallet ? request.wallet.toLowerCase() : null,
        request.wallets ? [...new Set(request.wallets.map(item => item.toLowerCase()))].sort() : null,
      ])
    : null;

/** Feed pages remain bound to one filter selection and one canonical event-journal checkpoint. */
export class TokenTradesFeedLoader {
  private state = emptyFeed(null);
  private request: TokenTradesFeedRequest | null = null;
  private generation = 0;
  private abort: AbortController | null = null;
  private listeners = new Set<() => void>();
  constructor(private readonly fetcher = readTokenTradesFeed) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(value: FeedState) {
    this.state = value;
    for (const listener of this.listeners) listener();
  }
  cancel() {
    this.generation++;
    this.abort?.abort();
    this.abort = null;
  }
  open = async (request: TokenTradesFeedRequest | null) => {
    this.cancel();
    this.request = request ? structuredClone(request) : null;
    const key = feedRequestKey(request), ticket = this.generation;
    this.publish(emptyFeed(key));
    if (!request) return;
    const abort = new AbortController();
    this.abort = abort;
    try {
      const value = await this.fetcher(request, abort.signal);
      const data = validateTokenTradesFeed(value, request);
      if (ticket === this.generation) this.publish({ key, data, loading: false, loadingMore: false, error: null, stale: false });
    } catch (error) {
      if (ticket === this.generation) {
        this.publish({ ...emptyFeed(key), loading: false, error: error instanceof TokenAnalyticsReadError ? error.message : unavailable });
      }
    }
  };
  refresh = () => this.open(this.request);
  loadMore = async () => {
    const previous = this.state, request = this.request;
    if (!request || !previous.data?.nextCursor || previous.loading || previous.loadingMore) return;
    const ticket = this.generation, cursor = previous.data.nextCursor, abort = new AbortController();
    this.abort = abort;
    this.publish({ ...previous, loadingMore: true, error: null });
    try {
      const value = await this.fetcher(request, abort.signal, cursor);
      if (ticket !== this.generation) return;
      const next = validateTokenTradesFeed(value, request);
      if (tokenAnalyticsCheckpointKey(previous.data.context) !== tokenAnalyticsCheckpointKey(next.context)) {
        this.publish({ ...previous, data: null, loadingMore: false, stale: true, error: 'The activity checkpoint changed. Refresh the feed before continuing.' });
        return;
      }
      if (next.nextCursor === cursor) throw invalid();
      if (previous.data.items.length && next.items.length && !afterTrade(next.items[0], previous.data.items.at(-1)!)) throw invalid();
      this.publish({ ...previous, data: { ...next, items: [...previous.data.items, ...next.items] }, loadingMore: false });
    } catch (error) {
      if (ticket !== this.generation) return;
      if (error instanceof TokenAnalyticsReadError && error.status === 409) {
        this.publish({ ...previous, data: null, loadingMore: false, stale: true, error: error.message });
      } else {
        this.publish({ ...previous, loadingMore: false, error: error instanceof TokenAnalyticsReadError ? error.message : unavailable });
      }
    }
  };
}

export function useTokenTradesFeed(request: TokenTradesFeedRequest | null) {
  const loader = useMemo(() => new TokenTradesFeedLoader(), []);
  const state = useSyncExternalStore(loader.subscribe, loader.snapshot, loader.snapshot);
  const key = feedRequestKey(request);
  useEffect(() => {
    void loader.open(request);
    return () => loader.cancel();
  }, [loader, key]);
  return { ...(state.key === key ? state : emptyFeed(key)), refresh: loader.refresh, loadMore: loader.loadMore };
}
