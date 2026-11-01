import { serviceMessage } from './service-message';
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiUrl } from './api-url';
import { customerErrorDetails, customerFetch, customerResponseJson } from './customer-http';

export type Token = { id?: string; address: string; name: string; symbol: string; imageUrl?: string; description?: string; createdAt?: string; priceApt?: string; marketCapApt?: string; volume24hApt?: string; holders?: number; creatorFeeBps?: number; dexFeeBps?: number; feeMode?: string; poolAddress?: string; liquidityApt?: string; change24h?: number; supply?: string; candles?: { time: number; open: number; high: number; low: number; close: number }[] };
export type Collection = { id: string; address?: string; name: string; description?: string; imageUrl?: string; creator?: string; supply?: number; maxSupply?: number; minted?: number; priceApt?: string; publicPriceApt?: string; allowlistPriceApt?: string; royaltyBps?: number; status?: string; mintStartsAt?: string; publicStart?: string; publicEnd?: string; allowlistStart?: string; perWalletLimit?: number; allowlistEndsAt?: string; items?: NftItem[]; itemsNextCursor?: string | null; floorApt?: string; volumeApt?: string; metadataFrozen?: boolean };
export type NftItem = { id: string; collectionId?: string; name: string; imageUrl?: string; owner?: string; seller?: string; priceApt?: string; listingId?: string; description?: string; attributes?: { trait_type: string; value: string }[] };
export type Activity = { id: string; type: string; name?: string; symbol?: string; amountApt?: string; wallet?: string; timestamp?: string; transactionHash?: string; tokenAddress?: string; collectionId?: string };
export type SystemStatus = { network?: string; chainId?: number | null; tokenLaunchEnabled?: boolean; nftEnabled?: boolean; configured?: boolean; database?: string | boolean; indexer?: string | { status?: string; configured?: boolean; lagSeconds?: number | null }; keeper?: string | { status?: string }; gate?: { passed?: boolean; reasons?: string[]; status?: string }; tokenGate?: { passed?: boolean; reasons?: string[]; status?: string }; features?: Record<string, boolean | { enabled: boolean; reason?: string }>; contracts?: { nftPackage?: string | null; tokenPackage?: string | null; treasury?: string | null }; dex?: { name: string; defaultFeeBps: number; verified: boolean }; storage?: { configured: boolean }; message?: string; dexFeeBps?: number; checks?: { name: string; status: string; detail?: string }[] };
export type Portfolio = { tokens?: (Token & { balance?: string })[]; nfts?: NftItem[]; nftsNextCursor?: string | null; earnings?: { token?: string; symbol?: string; claimableApt?: string; claimedApt?: string; pendingApt?: string }[]; balanceApt?: string };
export type CursorPage<T> = { items: T[]; nextCursor: string | null };

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers);
  if (options?.body && !(options.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await customerFetch(apiUrl(path), { ...options, headers, credentials: 'omit', redirect: 'error' });
  const body = await customerResponseJson(response, { signal: options?.signal });
  const error = customerErrorDetails(body);
  if (!response.ok) throw new Error(serviceMessage(error.code, error.message, 'Could not complete this request. Please try again.'));
  return body as T;
}

export function useApi<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const [dataPath, setDataPath] = useState<string | null>(null);
  const [settledPath, setSettledPath] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => { setLoading(Boolean(path)); setError(null); setVersion(v => v + 1); }, [path]);
  useEffect(() => {
    if (!path) { setLoading(false); setData(null); setDataPath(null); setSettledPath(null); return; }
    let mounted = true;
    setLoading(true); setError(null);
    api<T>(path).then(result => { if (mounted) { setData(result); setDataPath(path); } }).catch(reason => { if (mounted) setError(reason.message); }).finally(() => { if (mounted) { setLoading(false); setSettledPath(path); } });
    return () => { mounted = false; };
  }, [path, version]);
  return { data: dataPath === path ? data : null, error: settledPath === path ? error : null, loading: Boolean(path) && (loading || settledPath !== path), refresh };
}

const EMPTY_CURSOR_ITEMS: never[] = [];
/** Append a bounded API page while binding responses to their original wallet/collection. */
export function useCursorItems<T extends { id: string }>(scope: string, initialItems: T[] = EMPTY_CURSOR_ITEMS, initialCursor?: string | null) {
  const cursor = initialCursor ?? null;
  type State = { scope: string; source: T[]; sourceCursor: string | null; items: T[]; nextCursor: string | null; loadingMore: boolean; error: string | null };
  const seed = (): State => ({ scope, source: initialItems, sourceCursor: cursor, items: initialItems, nextCursor: cursor, loadingMore: false, error: null });
  const [state, setState] = useState<State>(seed);
  const version = useRef(0); const inFlight = useRef<number | null>(null);
  const latest = useRef({ scope, source: initialItems, cursor }); latest.current = { scope, source: initialItems, cursor };
  const active = state.scope === scope && state.source === initialItems && state.sourceCursor === cursor ? state : seed();
  useEffect(() => { version.current++; inFlight.current = null; setState(seed()); }, [scope, initialItems, cursor]);
  function reset() { version.current++; inFlight.current = null; setState(seed()); }
  async function loadMore(path: string, itemKey = "items", cursorKey = "nextCursor") {
    if (!active.nextCursor || active.loadingMore || inFlight.current !== null) return;
    const request = version.current; inFlight.current = request;
    const current = () => request === version.current && latest.current.scope === scope && latest.current.source === initialItems && latest.current.cursor === cursor;
    setState({ ...active, loadingMore: true, error: null });
    try {
      const page = await api<Record<string, unknown>>(`${path}${path.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(active.nextCursor)}`);
      if (!current()) return;
      const nextItems = items<T>(page, itemKey); const nextCursor = typeof page[cursorKey] === "string" ? page[cursorKey] as string : null;
      setState(previous => ({ ...previous, items: [...new Map([...previous.items, ...nextItems].map(item => [item.id, item])).values()], nextCursor, loadingMore: false, error: null }));
    } catch (reason) { if (current()) setState(previous => ({ ...previous, loadingMore: false, error: reason instanceof Error ? reason.message : "Could not load more items. Try again." })); }
    finally { if (inFlight.current === request) inFlight.current = null; }
  }
  return { items: active.items, nextCursor: active.nextCursor, loadingMore: active.loadingMore, error: active.error, loadMore, reset };
}

export function items<T>(value: unknown, key: string): T[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record[key])) return record[key] as T[];
    if (Array.isArray(record.items)) return record.items as T[];
    if (Array.isArray(record.data)) return record.data as T[];
  }
  return [];
}

export function shortAddress(value?: string) { return value ? `${value.slice(0, 6)}…${value.slice(-4)}` : "N/A"; }
export function sameAddress(left?: string | null, right?: string | null) { if (!left || !right) return false; try { return BigInt(left) === BigInt(right); } catch { return left.toLowerCase() === right.toLowerCase(); } }
export function apt(value?: string | number, maximumFractionDigits = 4) {
  if (value === undefined || value === null || value === "") return "N/A";
  const number = Number(value);
  return Number.isFinite(number) ? new Intl.NumberFormat("en-US", { maximumFractionDigits, notation: number >= 1_000_000 ? "compact" : "standard" }).format(number) : "N/A";
}
export function date(value?: string) { return value ? new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value)) : "N/A"; }
export function featureEnabled(status: SystemStatus | null | undefined, key: string) { const feature = status?.features?.[key]; return feature === true || (typeof feature === "object" && feature.enabled === true); }
export function featureReason(status: SystemStatus | null | undefined, key: string) { const feature = status?.features?.[key]; return typeof feature === "object" ? feature.reason : undefined; }
export function tokenEnabled(status?: SystemStatus | null) { return status?.tokenLaunchEnabled === true || featureEnabled(status, "tokenLaunch"); }
export function nftEnabled(status?: SystemStatus | null) { return status?.nftEnabled === true || featureEnabled(status, "nftLaunch"); }
export function gateReasons(status?: SystemStatus | null) { return status?.tokenGate?.reasons || status?.gate?.reasons || [featureReason(status, "tokenLaunch") || "Token launches are currently unavailable. You can save a draft and return later."]; }
