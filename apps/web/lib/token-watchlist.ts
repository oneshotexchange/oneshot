import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';

export const TOKEN_WATCHLIST_STORAGE_KEY = 'oneshot:watchlist';
const changedEvent = 'oneshot:watchlist-changed';
type WatchlistStorage = Pick<Storage, 'getItem' | 'setItem'>;
type SavedWatchlist = { entries: string[]; snapshot: string | null };
type WatchlistState = { entries: readonly string[]; loaded: boolean; error: string | null };

export class TokenWatchlistError extends Error {
  constructor(public readonly reason: 'unreadable' | 'unavailable' | 'conflict' | 'invalid', message: string) { super(message); }
}
const unavailable = () => new TokenWatchlistError('unavailable', 'Your watchlist could not be opened. Check that browser storage is allowed, then try again.');

/** Retain the existing string-array format, including legacy token identifiers. Reading never repairs or rewrites it. */
export function readTokenWatchlist(storage: Pick<Storage, 'getItem'>): SavedWatchlist {
  let snapshot: string | null;
  try { snapshot = storage.getItem(TOKEN_WATCHLIST_STORAGE_KEY); }
  catch { throw unavailable(); }
  if (snapshot === null) return { entries: [], snapshot };
  try {
    const entries: unknown = JSON.parse(snapshot);
    if (!Array.isArray(entries) || !entries.every(entry => typeof entry === 'string')) throw new Error();
    return { entries, snapshot };
  } catch { throw new TokenWatchlistError('unreadable', 'Your saved watchlist could not be read. It has not been changed. Try reloading the watchlist.'); }
}

/** Merge the explicit add/remove action into the latest saved list, rather than replacing it with stale component state. */
export function setTokenWatched(storage: WatchlistStorage, address: string, watched: boolean): SavedWatchlist {
  if (typeof address !== 'string' || !address.trim()) throw new TokenWatchlistError('invalid', 'This token could not be saved to your watchlist. Refresh the market and try again.');
  const current = readTokenWatchlist(storage);
  if (current.entries.includes(address) === watched) return current;
  const entries = watched ? [...current.entries, address] : current.entries.filter(entry => entry !== address);
  let latest: string | null;
  try { latest = storage.getItem(TOKEN_WATCHLIST_STORAGE_KEY); }
  catch { throw unavailable(); }
  // localStorage has no cross-tab compare-and-swap; reject an observed intervening change.
  if (latest !== current.snapshot) throw new TokenWatchlistError('conflict', 'Your watchlist changed in another tab. Reload it before trying again.');
  const snapshot = JSON.stringify(entries);
  try { storage.setItem(TOKEN_WATCHLIST_STORAGE_KEY, snapshot); }
  catch { throw new TokenWatchlistError('unavailable', 'Your watchlist change could not be saved. Check that browser storage is allowed, then try again.'); }
  return { entries, snapshot };
}

/** A failed read or write retains the last confirmed selection and exposes a customer recovery message. */
export function createTokenWatchlistStore(storage: () => WatchlistStorage) {
  let state: WatchlistState = { entries: [], loaded: false, error: null };
  const listeners = new Set<() => void>();
  function publish(next: WatchlistState) { state = next; for (const listener of listeners) listener(); }
  function failed(error: unknown) { publish({ ...state, loaded: true, error: error instanceof TokenWatchlistError ? error.message : unavailable().message }); }
  const refresh = () => {
    try { publish({ entries: readTokenWatchlist(storage()).entries, loaded: true, error: null }); }
    catch (error) { failed(error); }
  };
  return {
    snapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refresh,
    setWatched(address: string, watched: boolean): boolean {
      try {
        const saved = setTokenWatched(storage(), address, watched);
        publish({ entries: saved.entries, loaded: true, error: null });
        return true;
      } catch (error) { failed(error); return false; }
    },
  };
}

function browserStorage(): Storage {
  if (typeof window === 'undefined') throw unavailable();
  return window.localStorage;
}

export function useTokenWatchlist() {
  const store = useMemo(() => createTokenWatchlistStore(browserStorage), []);
  const state = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  useEffect(() => {
    store.refresh();
    const storageChanged = (event: StorageEvent) => { if (event.key === TOKEN_WATCHLIST_STORAGE_KEY || event.key === null) store.refresh(); };
    window.addEventListener('storage', storageChanged);
    window.addEventListener(changedEvent, store.refresh);
    window.addEventListener('focus', store.refresh);
    return () => {
      window.removeEventListener('storage', storageChanged);
      window.removeEventListener(changedEvent, store.refresh);
      window.removeEventListener('focus', store.refresh);
    };
  }, [store]);
  const toggle = useCallback((address: string) => {
    const saved = store.setWatched(address, !store.snapshot().entries.includes(address));
    if (saved && typeof window !== 'undefined') window.dispatchEvent(new Event(changedEvent));
    return saved;
  }, [store]);
  return { ...state, refresh: store.refresh, toggle };
}
