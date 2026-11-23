import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  BASE_SEPOLIA_GENESIS_HASH,
  BASE_SEPOLIA_POOL_MANAGER,
  formatIndexedAmount,
  type IndexedTokenContext,
  type IndexedTokenMarket,
  type IndexedTokenMarketResponse,
  type IndexedTokenMarketsResponse,
  type IndexedTokenSource,
  type TokenAnalytics,
  type TokenAnalyticsMarketsResponse,
  type TokenAnalyticsSort,
} from '@oneshot/evm';
import { apiUrl } from './api-url';
import { customerErrorDetails, customerFetch, customerResponseJson } from './customer-http';
import { readNftNetwork } from './nft-network';

const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const address = (value: unknown): value is string => typeof value === 'string' && /^0x[\da-f]{40}$/i.test(value) && !/^0x0{40}$/i.test(value);
const hash = (value: unknown): value is string => typeof value === 'string' && /^0x[\da-f]{64}$/i.test(value);
const nonzeroHash = (value: unknown): value is string => hash(value) && !/^0x0{64}$/i.test(value);
const uint = (value: unknown): value is string => typeof value === 'string' && value.length <= 78 && /^(0|[1-9]\d*)$/.test(value) && BigInt(value) < 2n ** 256n;
const text = (value: unknown, maximum: number): value is string => typeof value === 'string' && value.trim().length > 0 && new TextEncoder().encode(value).length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
const unavailable = 'Token markets are unavailable right now. Please try again later.';
const invalid = () => new TokenMarketReadError(502, 'TOKEN_DATA_INVALID', 'Token market data could not be verified. Refresh markets to try again.');

export class TokenMarketReadError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}

export function validTokenSource(networkValue: unknown, source: unknown): source is IndexedTokenSource {
  const network = readNftNetwork(networkValue);
  if (!network || !object(networkValue) || networkValue.mode !== network.mode || networkValue.name !== network.name || !object(source)
    || source.chainId !== network.chainId || !nonzeroHash(source.genesisHash)
    || !['factory', 'poolManager', 'oracle', 'quoter'].every(key => object(source[key]) && address(source[key].address) && nonzeroHash(source[key].codeHash))) return false;
  return network.chainId !== 84532 || source.genesisHash.toLowerCase() === BASE_SEPOLIA_GENESIS_HASH && object(source.poolManager) && String(source.poolManager.address).toLowerCase() === BASE_SEPOLIA_POOL_MANAGER.toLowerCase();
}
function validContext(value: unknown): value is IndexedTokenContext {
  if (!object(value) || value.schemaVersion !== 1 || value.readonly !== true || value.finalized !== false || value.kind !== 'canonical-contract-snapshot'
    || typeof value.enabled !== 'boolean' || typeof value.available !== 'boolean' || !(value.reason === null || typeof value.reason === 'string')) return false;
  if (!value.enabled) return value.available === false && value.deploymentId === null && value.network === null && value.source === null && value.checkpoint === null;
  const network = readNftNetwork(value.network), source = value.source, checkpoint = value.checkpoint;
  if (!value.available || value.reason !== null || typeof value.deploymentId !== 'string' || !/^[\da-f]{64}$/.test(value.deploymentId)
    || !network || !validTokenSource(value.network, source)
    || !object(checkpoint) || !uint(checkpoint.number) || !uint(checkpoint.timestamp) || !nonzeroHash(checkpoint.hash) || !hash(checkpoint.parentHash)
    || checkpoint.number !== '0' && !nonzeroHash(checkpoint.parentHash)) return false;
  return true;
}

export function validTokenMarketRecord(value: unknown): value is IndexedTokenMarket {
  if (!object(value) || value.schemaVersion !== 1 || !['market', 'token', 'creator', 'platformRecipient'].every(key => address(value[key]))
    || String(value.market).toLowerCase() === String(value.token).toLowerCase() || !text(value.name, 64) || !text(value.symbol, 16) || value.tokenDecimals !== 8
    || !['initialSupplyRaw', 'totalSupplyRaw', 'openingValuationNativeRaw', 'effectiveOpeningValuationNativeRaw', 'effectiveUpperValuationNativeRaw', 'lockedLiquidityRaw', 'lockedRoundingDustRaw'].every(key => uint(value[key]))
    || typeof value.executionFeeBps !== 'number' || !Number.isInteger(value.executionFeeBps) || value.executionFeeBps < 100 || value.executionFeeBps > 500 || value.executionFeeBps % 10 !== 0
    || typeof value.liquidityAndBurn !== 'boolean' || value.lpFeePips !== 2500 || value.tickSpacing !== 10 || !nonzeroHash(value.poolId)
    || !Number.isInteger(value.tickLower) || !Number.isInteger(value.tickUpper) || Number(value.tickLower) < -887270 || Number(value.tickUpper) > 887270
    || Number(value.tickLower) % 10 !== 0 || Number(value.tickUpper) % 10 !== 0 || Number(value.tickLower) >= Number(value.tickUpper)
    || !nonzeroHash(value.observedMarketCodeHash) || !nonzeroHash(value.observedTokenCodeHash)) return false;
  return BigInt(value.initialSupplyRaw as string) > 0n && BigInt(value.totalSupplyRaw as string) <= BigInt(value.initialSupplyRaw as string)
    && BigInt(value.openingValuationNativeRaw as string) > 0n && BigInt(value.effectiveOpeningValuationNativeRaw as string) > 0n
    && BigInt(value.effectiveUpperValuationNativeRaw as string) > BigInt(value.effectiveOpeningValuationNativeRaw as string)
    && BigInt(value.lockedLiquidityRaw as string) > 0n && BigInt(value.lockedLiquidityRaw as string) < 2n ** 128n;
}

export function validateTokenMarketsResponse(value: unknown): IndexedTokenMarketsResponse {
  if (!object(value) || !validContext(value.context) || !Array.isArray(value.items) || value.items.length > 25 || !value.items.every(validTokenMarketRecord)
    || !(value.nextCursor === null || typeof value.nextCursor === 'string' && value.nextCursor.length > 0 && value.nextCursor.length <= 4096)
    || !value.context.available && (value.items.length !== 0 || value.nextCursor !== null)
    || new Set(value.items.map(item => item.market.toLowerCase())).size !== value.items.length
    || new Set(value.items.map(item => item.token.toLowerCase())).size !== value.items.length) throw invalid();
  return value as IndexedTokenMarketsResponse;
}

export function validateTokenMarketResponse(value: unknown, expectedMarket: string): IndexedTokenMarketResponse {
  if (!address(expectedMarket) || !object(value) || !validContext(value.context)
    || (value.context.available ? !validTokenMarketRecord(value.market) || value.market.market.toLowerCase() !== expectedMarket.toLowerCase() : value.market !== null)) throw invalid();
  return value as IndexedTokenMarketResponse;
}

export function tokenMarketsPath(query = '', limit = 25) {
  if (query.length > 100 || /[\u0000-\u001f\u007f]/.test(query) || !Number.isInteger(limit) || limit < 1 || limit > 25) throw new TokenMarketReadError(400, 'INPUT_INVALID', 'Use a search of up to 100 characters.');
  const params = new URLSearchParams({ limit: String(limit) }); if (query.trim()) params.set('q', query.trim());
  return `/api/oneshot/token-indexed/markets?${params}`;
}
export function tokenDiscoveryQuery(search: string) {
  const params = new URLSearchParams(search);
  if (params.getAll('q').length > 1) throw new TokenMarketReadError(400, 'INPUT_INVALID', 'Clear the search and enter one name, symbol or address.');
  const query = params.get('q') ?? ''; tokenMarketsPath(query); return query.trim();
}
const VALID_ANALYTICS_SORTS: readonly TokenAnalyticsSort[] = ['newest', 'volume', 'trades', 'holders'];
export function tokenDiscoverySort(search: string): TokenAnalyticsSort {
  const params = new URLSearchParams(search);
  if (params.getAll('sort').length > 1) throw new TokenMarketReadError(400, 'INPUT_INVALID', 'Choose a single token market sort option.');
  const sort = (params.get('sort') ?? 'newest') as TokenAnalyticsSort;
  if (!VALID_ANALYTICS_SORTS.includes(sort)) throw new TokenMarketReadError(400, 'INPUT_INVALID', 'Choose a supported token market sort order.');
  return sort;
}
export function tokenAnalyticsMarketsPath(query = '', sort: TokenAnalyticsSort = 'newest', limit = 25) {
  if (query.length > 100 || /[\u0000-\u001f\u007f]/.test(query) || !VALID_ANALYTICS_SORTS.includes(sort) || !Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new TokenMarketReadError(400, 'INPUT_INVALID', 'Use a search of up to 100 characters and a valid sort option.');
  }
  const params = new URLSearchParams({ limit: String(limit), sort });
  if (query.trim()) params.set('q', query.trim());
  return `/api/oneshot/token-analytics/markets?${params}`;
}
function validAnalyticsContext(value: unknown): boolean {
  if (!object(value) || value.schemaVersion !== 1 || value.readonly !== true || value.finalized !== false || value.kind !== 'canonical-event-journal'
    || typeof value.enabled !== 'boolean' || typeof value.available !== 'boolean' || !(value.reason === null || typeof value.reason === 'string')) return false;
  if (!value.available) return value.checkpoint === null;
  const network = readNftNetwork(value.network), checkpoint = value.checkpoint;
  return Boolean(network && validTokenSource(value.network, value.source) && typeof value.deploymentId === 'string' && /^[\da-f]{64}$/.test(value.deploymentId)
    && object(checkpoint) && uint(checkpoint.number) && uint(checkpoint.timestamp) && nonzeroHash(checkpoint.hash) && hash(checkpoint.parentHash));
}
function validAnalyticsRecord(value: unknown): value is TokenAnalytics {
  if (!object(value) || !['market', 'token', 'creator'].every(k => address(value[k])) || !nonzeroHash(value.poolId)
    || value.tokenDecimals !== 8 || value.holderScope !== 'all-nonzero-balance-addresses'
    || !['observedSupplyRaw', 'mintedRaw', 'burnedRaw', 'holderCount', 'poolSwaps', 'poolNativeVolumeRaw', 'poolTokenVolumeRaw', 'oneshotTrades', 'oneshotBuys', 'oneshotSells', 'oneshotGrossNativeVolumeRaw', 'oneshotExecutionFeesRaw'].every(k => uint(value[k]))
    || !object(value.price) || !uint(value.price.sqrtPriceX96Raw) || typeof value.price.tick !== 'number'
    || !uint(value.price.blockNumber) || !nonzeroHash(value.price.blockHash)
    || !object(value.price.nativeRawPerWholeToken) || !uint(value.price.nativeRawPerWholeToken.numerator) || !uint(value.price.nativeRawPerWholeToken.denominator)) return false;
  return BigInt(value.price.nativeRawPerWholeToken.denominator as string) > 0n;
}
export function validateTokenAnalyticsMarketsResponse(value: unknown): TokenAnalyticsMarketsResponse {
  if (!object(value) || !validAnalyticsContext(value.context) || !VALID_ANALYTICS_SORTS.includes(value.sort as TokenAnalyticsSort)
    || !Array.isArray(value.items) || value.items.length > 50
    || !(value.nextCursor === null || typeof value.nextCursor === 'string' && value.nextCursor.length > 0 && value.nextCursor.length <= 4096)
    || (!value.context || !(value.context as { available: boolean }).available) && (value.items.length !== 0 || value.nextCursor !== null)) throw invalid();
  for (const item of value.items) {
    if (!object(item) || !validTokenMarketRecord(item.market) || !validAnalyticsRecord(item.analytics)
      || item.market.market.toLowerCase() !== item.analytics.market.toLowerCase()) throw invalid();
  }
  return value as TokenAnalyticsMarketsResponse;
}

async function read<T>(path: string, validate: (value: unknown) => T, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<T> {
  const response = await customerFetch(apiUrl(path), { signal, credentials: 'omit', redirect: 'error', cache: 'no-store' }, fetcher);
  const body = await customerResponseJson<unknown>(response, { signal, invalidResponse: invalid });
  if (!response.ok) {
    const code = customerErrorDetails(body).code;
    throw new TokenMarketReadError(response.status, typeof code === 'string' ? code : 'READ_FAILED', response.status === 429 ? 'Too many requests. Wait a moment and refresh markets.'
      : response.status === 404 ? 'This token market is unavailable. Return to token markets or try again.'
        : response.status === 409 ? 'Recent token activity changed. Refresh markets to continue.' : unavailable);
  }
  return validate(body);
}
export const readTokenMarkets = (path: string, signal?: AbortSignal, fetcher?: typeof fetch) => read(path, validateTokenMarketsResponse, signal, fetcher);
export const readTokenMarket = (market: string, signal?: AbortSignal, fetcher?: typeof fetch) => {
  if (!address(market)) return Promise.reject(new TokenMarketReadError(400, 'INPUT_INVALID', 'Choose a valid token market address.'));
  return read(`/api/oneshot/token-indexed/markets/${market.toLowerCase()}`, value => validateTokenMarketResponse(value, market), signal, fetcher);
};
export const tokenNativeAmount = (raw: string) => formatIndexedAmount(raw, 18);
export const tokenSupplyAmount = (raw: string) => formatIndexedAmount(raw, 8);

type PageState = { path: string | null; data: IndexedTokenMarketsResponse | null; loading: boolean; loadingMore: boolean; error: string | null; notice: string | null };
const empty = (path: string | null): PageState => ({ path, data: null, loading: Boolean(path), loadingMore: false, error: null, notice: null });
const checkpointKey = (context: IndexedTokenContext) => JSON.stringify([context.network?.chainId, context.deploymentId, context.source, context.checkpoint, context.available]);

/** Search, network identity and checkpoint stay attached to their original page. */
export class TokenMarketsLoader {
  private state = empty(null); private generation = 0; private abort: AbortController | null = null; private listeners = new Set<() => void>();
  constructor(private readonly fetcher = readTokenMarkets) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(state: PageState) { this.state = state; for (const listener of this.listeners) listener(); }
  cancel() { this.generation++; this.abort?.abort(); this.abort = null; }
  open = async (path: string | null, notice: string | null = null) => {
    this.cancel(); const ticket = this.generation; this.publish({ ...empty(path), notice }); if (!path) return;
    const abort = new AbortController(); this.abort = abort;
    try { const data = validateTokenMarketsResponse(await this.fetcher(path, abort.signal)); if (ticket === this.generation) this.publish({ path, data, loading: false, loadingMore: false, error: null, notice }); }
    catch (error) { if (ticket === this.generation) this.publish({ ...empty(path), loading: false, error: error instanceof TokenMarketReadError ? error.message : unavailable, notice }); }
  };
  refresh = () => this.open(this.state.path);
  loadMore = async () => {
    const previous = this.state;
    if (!previous.path || !previous.data?.nextCursor || previous.loading || previous.loadingMore) return;
    const ticket = this.generation, abort = new AbortController(); this.abort = abort; this.publish({ ...previous, loadingMore: true, error: null });
    try {
      const next = validateTokenMarketsResponse(await this.fetcher(`${previous.path}&cursor=${encodeURIComponent(previous.data.nextCursor)}`, abort.signal));
      if (ticket !== this.generation) return;
      if (checkpointKey(previous.data.context) !== checkpointKey(next.context)) { await this.open(previous.path, 'Recent token activity changed. Markets have been refreshed.'); return; }
      const items = [...new Map([...previous.data.items, ...next.items].map(item => [item.market.toLowerCase(), item])).values()];
      this.publish({ ...previous, data: { ...next, items }, loadingMore: false });
    } catch (error) {
      if (ticket !== this.generation) return;
      if (error instanceof TokenMarketReadError && error.status === 409) await this.open(previous.path, 'Recent token activity changed. Markets have been refreshed.');
      else this.publish({ ...previous, loadingMore: false, error: error instanceof TokenMarketReadError ? error.message : unavailable });
    }
  };
}
export function useTokenMarkets(path: string | null) {
  const loader = useMemo(() => new TokenMarketsLoader(), []), state = useSyncExternalStore(loader.subscribe, loader.snapshot, loader.snapshot);
  useEffect(() => { void loader.open(path); return () => loader.cancel(); }, [loader, path]);
  return { ...(state.path === path ? state : empty(path)), refresh: loader.refresh, loadMore: loader.loadMore };
}
export const readTokenAnalyticsMarkets = (path: string, signal?: AbortSignal, fetcher?: typeof fetch) =>
  read(path, validateTokenAnalyticsMarketsResponse, signal, fetcher);

type AnalyticsPageState = { path: string | null; data: TokenAnalyticsMarketsResponse | null; loading: boolean; loadingMore: boolean; error: string | null; notice: string | null };
const emptyAnalytics = (path: string | null): AnalyticsPageState => ({ path, data: null, loading: Boolean(path), loadingMore: false, error: null, notice: null });
export class TokenAnalyticsMarketsLoader {
  private state = emptyAnalytics(null); private generation = 0; private abort: AbortController | null = null; private listeners = new Set<() => void>();
  constructor(private readonly fetcher = readTokenAnalyticsMarkets) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(state: AnalyticsPageState) { this.state = state; for (const listener of this.listeners) listener(); }
  cancel() { this.generation++; this.abort?.abort(); this.abort = null; }
  open = async (path: string | null, notice: string | null = null) => {
    this.cancel(); const ticket = this.generation; this.publish({ ...emptyAnalytics(path), notice }); if (!path) return;
    const abort = new AbortController(); this.abort = abort;
    try { const data = validateTokenAnalyticsMarketsResponse(await this.fetcher(path, abort.signal)); if (ticket === this.generation) this.publish({ path, data, loading: false, loadingMore: false, error: null, notice }); }
    catch (error) { if (ticket === this.generation) this.publish({ ...emptyAnalytics(path), loading: false, error: error instanceof TokenMarketReadError ? error.message : unavailable, notice }); }
  };
  refresh = () => this.open(this.state.path);
  loadMore = async () => {
    const previous = this.state;
    if (!previous.path || !previous.data?.nextCursor || previous.loading || previous.loadingMore) return;
    const ticket = this.generation, abort = new AbortController(); this.abort = abort; this.publish({ ...previous, loadingMore: true, error: null });
    try {
      const next = validateTokenAnalyticsMarketsResponse(await this.fetcher(`${previous.path}&cursor=${encodeURIComponent(previous.data.nextCursor)}`, abort.signal));
      if (ticket !== this.generation) return;
      if (JSON.stringify(previous.data.context.checkpoint) !== JSON.stringify(next.context.checkpoint) || previous.data.context.deploymentId !== next.context.deploymentId) {
        await this.open(previous.path, 'Recent token activity changed. Markets have been refreshed.'); return;
      }
      const items = [...new Map([...previous.data.items, ...next.items].map(item => [item.market.market.toLowerCase(), item])).values()];
      this.publish({ ...previous, data: { ...next, items }, loadingMore: false });
    } catch (error) {
      if (ticket !== this.generation) return;
      if (error instanceof TokenMarketReadError && error.status === 409) await this.open(previous.path, 'Recent token activity changed. Markets have been refreshed.');
      else this.publish({ ...previous, loadingMore: false, error: error instanceof TokenMarketReadError ? error.message : unavailable });
    }
  };
}
export function useTokenAnalyticsMarkets(path: string | null) {
  const loader = useMemo(() => new TokenAnalyticsMarketsLoader(), []), state = useSyncExternalStore(loader.subscribe, loader.snapshot, loader.snapshot);
  useEffect(() => { void loader.open(path); return () => loader.cancel(); }, [loader, path]);
  return { ...(state.path === path ? state : emptyAnalytics(path)), refresh: loader.refresh, loadMore: loader.loadMore };
}
export function useTokenMarket(market: string) {
  const [version, setVersion] = useState(0);
  const [state, setState] = useState<{ market: string; data: IndexedTokenMarketResponse | null; loading: boolean; error: string | null }>({ market, data: null, loading: true, error: null });
  useEffect(() => {
    let active = true; const abort = new AbortController(); setState({ market, data: null, loading: true, error: null });
    void readTokenMarket(market, abort.signal).then(data => { if (active) setState({ market, data, loading: false, error: null }); })
      .catch(error => { if (active) setState({ market, data: null, loading: false, error: error instanceof TokenMarketReadError ? error.message : unavailable }); });
    return () => { active = false; abort.abort(); };
  }, [market, version]);
  return { ...(state.market === market ? state : { data: null, loading: true, error: null }), refresh: () => setVersion(value => value + 1) };
}
