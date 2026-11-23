import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { parseAssetAmount } from '@oneshot/evm';

export const TOKEN_ALERTS_STORAGE_KEY = 'oneshot:token-alerts:v1';
export const MAX_TOKEN_ALERTS = 50;
const changedEvent = 'oneshot:token-alerts-changed';

export type TokenPriceAlert = {
  id: string;
  market: string;
  direction: 'above' | 'below';
  targetNativePerToken: string;
  createdAt: string;
};

type AlertsStorage = Pick<Storage, 'getItem' | 'setItem'>;
type SavedAlerts = { items: TokenPriceAlert[]; snapshot: string | null };
type AlertsState = { items: readonly TokenPriceAlert[]; loaded: boolean; error: string | null };

export class TokenAlertsError extends Error {
  constructor(public readonly reason: 'unreadable' | 'unavailable' | 'conflict' | 'invalid' | 'capacity', message: string) {
    super(message);
  }
}

const unavailable = () =>
  new TokenAlertsError('unavailable', 'Your price alerts could not be opened. Check that browser storage is allowed and try again.');

const evmAddress = /^0x[\da-f]{40}$/i;
const decimalText = /^(0|[1-9]\d*)(?:\.\d+)?$/;
const nonnegativeInt = /^(0|[1-9]\d*)$/;
const positiveInt = /^[1-9]\d*$/;

function validAlertRecord(value: unknown): value is TokenPriceAlert {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== 'string' ||
    !record.id ||
    record.id.length > 100 ||
    typeof record.market !== 'string' ||
    !evmAddress.test(record.market) ||
    !/^[a-z0-9-]+$/.test(record.id) && !record.id.includes(':') ||
    (record.direction !== 'above' && record.direction !== 'below') ||
    typeof record.targetNativePerToken !== 'string' ||
    record.targetNativePerToken.length > 80 ||
    !decimalText.test(record.targetNativePerToken) ||
    typeof record.createdAt !== 'string' ||
    !record.createdAt
  ) {
    return false;
  }
  try {
    return parseAssetAmount(record.targetNativePerToken, 18) > 0n;
  } catch {
    return false;
  }
}

/** Exact cross-multiplication over the canonical pool price ratio (native wei per 1e8 token atoms). */
export function tokenPriceAlertTriggered(
  alert: Pick<TokenPriceAlert, 'direction' | 'targetNativePerToken'>,
  priceRatio: { numerator: string; denominator: string },
): boolean {
  if (!nonnegativeInt.test(priceRatio.numerator) || !positiveInt.test(priceRatio.denominator)) return false;
  let targetRaw: bigint;
  try {
    targetRaw = parseAssetAmount(alert.targetNativePerToken, 18);
  } catch {
    return false;
  }
  if (targetRaw <= 0n) return false;
  const lhs = BigInt(priceRatio.numerator);
  const rhs = targetRaw * BigInt(priceRatio.denominator);
  return alert.direction === 'above' ? lhs >= rhs : lhs <= rhs;
}

export function evaluateTokenPriceAlerts(
  alerts: readonly TokenPriceAlert[],
  market: string,
  priceRatio: { numerator: string; denominator: string },
): TokenPriceAlert[] {
  if (!evmAddress.test(market)) return [];
  const normalized = market.toLowerCase();
  return alerts.filter(
    alert => alert.market.toLowerCase() === normalized && tokenPriceAlertTriggered(alert, priceRatio),
  );
}

/** Reading never mutates or clears existing browser alerts. */
export function readTokenAlerts(storage: Pick<Storage, 'getItem'>): SavedAlerts {
  let snapshot: string | null;
  try {
    snapshot = storage.getItem(TOKEN_ALERTS_STORAGE_KEY);
  } catch {
    throw unavailable();
  }
  if (snapshot === null) return { items: [], snapshot };
  try {
    const parsed: unknown = JSON.parse(snapshot);
    if (!Array.isArray(parsed) || !parsed.every(validAlertRecord)) throw new Error();
    return { items: parsed, snapshot };
  } catch {
    throw new TokenAlertsError(
      'unreadable',
      'Your saved price alerts could not be read. They were kept untouched. Clear storage or reload to retry.',
    );
  }
}

function commitAlerts(storage: AlertsStorage, currentSnapshot: string | null, items: TokenPriceAlert[]): SavedAlerts {
  let latest: string | null;
  try {
    latest = storage.getItem(TOKEN_ALERTS_STORAGE_KEY);
  } catch {
    throw unavailable();
  }
  if (latest !== currentSnapshot) {
    throw new TokenAlertsError('conflict', 'Your price alerts changed in another tab. Reload alerts before updating them.');
  }
  const snapshot = JSON.stringify(items);
  try {
    storage.setItem(TOKEN_ALERTS_STORAGE_KEY, snapshot);
  } catch {
    throw new TokenAlertsError('unavailable', 'Your price alert could not be saved. Check browser storage settings.');
  }
  return { items, snapshot };
}

export function addTokenAlert(
  storage: AlertsStorage,
  input: { market: string; direction: 'above' | 'below'; targetNativePerToken: string },
  nowIso = new Date().toISOString(),
): SavedAlerts {
  if (!evmAddress.test(input.market) || /^0x0{40}$/i.test(input.market)) {
    throw new TokenAlertsError('invalid', 'Enter a valid market address before saving an alert.');
  }
  if (input.direction !== 'above' && input.direction !== 'below') {
    throw new TokenAlertsError('invalid', 'Choose an alert direction.');
  }
  const targetText = input.targetNativePerToken.trim();
  let targetRaw: bigint;
  try {
    targetRaw = parseAssetAmount(targetText, 18);
  } catch {
    throw new TokenAlertsError('invalid', 'Enter a positive target price with up to 18 decimal places.');
  }
  if (targetRaw <= 0n || targetRaw >= 2n ** 256n) {
    throw new TokenAlertsError('invalid', 'Target price must be positive.');
  }
  const current = readTokenAlerts(storage);
  if (current.items.length >= MAX_TOKEN_ALERTS) {
    throw new TokenAlertsError('capacity', `You can keep up to ${MAX_TOKEN_ALERTS} price alerts on this device.`);
  }
  const normalizedMarket = input.market.toLowerCase();
  const id = `${normalizedMarket}:${input.direction}:${targetRaw.toString()}:${current.items.length + 1}:${Date.now()}`;
  const entry: TokenPriceAlert = {
    id,
    market: normalizedMarket,
    direction: input.direction,
    targetNativePerToken: targetText,
    createdAt: nowIso,
  };
  return commitAlerts(storage, current.snapshot, [entry, ...current.items]);
}

export function removeTokenAlert(storage: AlertsStorage, id: string): SavedAlerts {
  const current = readTokenAlerts(storage);
  const next = current.items.filter(item => item.id !== id);
  if (next.length === current.items.length) return current;
  return commitAlerts(storage, current.snapshot, next);
}

export function createTokenAlertsStore(storage: () => AlertsStorage) {
  let state: AlertsState = { items: [], loaded: false, error: null };
  const listeners = new Set<() => void>();
  function publish(next: AlertsState) {
    state = next;
    for (const listener of listeners) listener();
  }
  function failed(error: unknown) {
    publish({
      ...state,
      loaded: true,
      error: error instanceof TokenAlertsError ? error.message : unavailable().message,
    });
  }
  const refresh = () => {
    try {
      publish({ items: readTokenAlerts(storage()).items, loaded: true, error: null });
    } catch (error) {
      failed(error);
    }
  };
  return {
    snapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh,
    add(input: { market: string; direction: 'above' | 'below'; targetNativePerToken: string }): boolean {
      try {
        const saved = addTokenAlert(storage(), input);
        publish({ items: saved.items, loaded: true, error: null });
        return true;
      } catch (error) {
        failed(error);
        return false;
      }
    },
    remove(id: string): boolean {
      try {
        const saved = removeTokenAlert(storage(), id);
        publish({ items: saved.items, loaded: true, error: null });
        return true;
      } catch (error) {
        failed(error);
        return false;
      }
    },
  };
}

function browserStorage(): Storage {
  if (typeof window === 'undefined') throw unavailable();
  return window.localStorage;
}

export function useTokenAlerts() {
  const store = useMemo(() => createTokenAlertsStore(browserStorage), []);
  const state = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  useEffect(() => {
    store.refresh();
    const storageChanged = (event: StorageEvent) => {
      if (event.key === TOKEN_ALERTS_STORAGE_KEY || event.key === null) store.refresh();
    };
    window.addEventListener('storage', storageChanged);
    window.addEventListener(changedEvent, store.refresh);
    window.addEventListener('focus', store.refresh);
    return () => {
      window.removeEventListener('storage', storageChanged);
      window.removeEventListener(changedEvent, store.refresh);
      window.removeEventListener('focus', store.refresh);
    };
  }, [store]);
  const add = useCallback(
    (input: { market: string; direction: 'above' | 'below'; targetNativePerToken: string }) => {
      const saved = store.add(input);
      if (saved && typeof window !== 'undefined') window.dispatchEvent(new Event(changedEvent));
      return saved;
    },
    [store],
  );
  const remove = useCallback(
    (id: string) => {
      const saved = store.remove(id);
      if (saved && typeof window !== 'undefined') window.dispatchEvent(new Event(changedEvent));
      return saved;
    },
    [store],
  );
  return { ...state, refresh: store.refresh, add, remove };
}
