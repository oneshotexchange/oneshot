import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { TOKEN_WATCHLIST_STORAGE_KEY, createTokenWatchlistStore, readTokenWatchlist, setTokenWatched, useTokenWatchlist } from './token-watchlist';

function memory(initial: string | null = null) {
  const values = new Map(initial === null ? [] : [[TOKEN_WATCHLIST_STORAGE_KEY, initial]]);
  return {
    values,
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
  };
}

describe('safe token watchlist persistence', () => {
  it('reads a missing list without writing and preserves the original string-array format and identifiers', () => {
    const storage = memory();
    expect(readTokenWatchlist(storage)).toEqual({ entries: [], snapshot: null });
    expect(storage.setItem).not.toHaveBeenCalled();
    const entries = ['0xAbCd', '0x1::legacy::Token', '0xAbCd'];
    const raw = JSON.stringify(entries, null, 2);
    storage.values.set(TOKEN_WATCHLIST_STORAGE_KEY, raw);
    expect(readTokenWatchlist(storage)).toEqual({ entries, snapshot: raw });
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it.each(['{', 'null', '{}', '"0xabc"', '[1]', '[null]', '["0xabc",{}]'])('protects malformed stored value %s from an add or remove', raw => {
    const storage = memory(raw);
    expect(() => readTokenWatchlist(storage)).toThrow('could not be read');
    expect(() => setTokenWatched(storage, '0xabc', true)).toThrow('has not been changed');
    expect(() => setTokenWatched(storage, '0xabc', false)).toThrow('has not been changed');
    expect(storage.values.get(TOKEN_WATCHLIST_STORAGE_KEY)).toBe(raw);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('does not overwrite unreadable values just because a component previously loaded a valid list', () => {
    const storage = memory('["0xold"]');
    const store = createTokenWatchlistStore(() => storage);
    store.refresh();
    storage.values.set(TOKEN_WATCHLIST_STORAGE_KEY, '{');
    expect(store.setWatched('0xnew', true)).toBe(false);
    expect(store.snapshot().entries).toEqual(['0xold']);
    expect(store.snapshot().error).toContain('could not be read');
    expect(storage.values.get(TOKEN_WATCHLIST_STORAGE_KEY)).toBe('{');
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('merges explicit actions with fresh cross-tab changes and preserves unrelated preferences', () => {
    const storage = memory('["0xfirst"]');
    storage.values.set('another-preference', 'keep');
    const firstTab = createTokenWatchlistStore(() => storage), secondTab = createTokenWatchlistStore(() => storage);
    firstTab.refresh(); secondTab.refresh();
    expect(secondTab.setWatched('0xsecond', true)).toBe(true);
    expect(firstTab.setWatched('0xthird', true)).toBe(true);
    expect(readTokenWatchlist(storage).entries).toEqual(['0xfirst', '0xsecond', '0xthird']);
    expect(firstTab.setWatched('0xfirst', false)).toBe(true);
    secondTab.refresh();
    expect(secondTab.snapshot().entries).toEqual(['0xsecond', '0xthird']);
    expect(storage.values.get('another-preference')).toBe('keep');
  });

  it('does not invert an explicit add that another tab has already saved, or rewrite unchanged data', () => {
    const raw = '[ "0xfirst", "0xsecond" ]', storage = memory(raw);
    expect(setTokenWatched(storage, '0xsecond', true)).toEqual({ entries: ['0xfirst', '0xsecond'], snapshot: raw });
    expect(setTokenWatched(storage, '0xmissing', false).snapshot).toBe(raw);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('rejects an observed change between reading and writing without losing the other tab’s list', () => {
    const storage = memory('["0xfirst"]');
    storage.getItem.mockImplementationOnce(() => '["0xfirst"]').mockImplementationOnce(() => {
      storage.values.set(TOKEN_WATCHLIST_STORAGE_KEY, '["0xfirst","0xother-tab"]');
      return '["0xfirst","0xother-tab"]';
    });
    expect(() => setTokenWatched(storage, '0xnew', true)).toThrow('changed in another tab');
    expect(storage.values.get(TOKEN_WATCHLIST_STORAGE_KEY)).toBe('["0xfirst","0xother-tab"]');
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('does not write after a rejected initial or conflict-check read and never exposes transport details', () => {
    const storage = memory('["0xfirst"]');
    storage.getItem.mockImplementation(() => { throw new Error('SecurityError: private browser detail'); });
    expect(() => setTokenWatched(storage, '0xnew', true)).toThrow('Check that browser storage is allowed');
    expect(storage.setItem).not.toHaveBeenCalled();
    storage.getItem.mockImplementationOnce(() => '["0xfirst"]');
    expect(() => setTokenWatched(storage, '0xnew', true)).toThrow('Check that browser storage is allowed');
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('retains the last confirmed selection and reports a failed save when quota or permission rejects a write', () => {
    const storage = memory('["0xfirst"]'), store = createTokenWatchlistStore(() => storage);
    store.refresh();
    storage.setItem.mockImplementation(() => { throw new Error('QuotaExceededError: private browser detail'); });
    expect(store.setWatched('0xnew', true)).toBe(false);
    expect(store.snapshot().entries).toEqual(['0xfirst']);
    expect(store.snapshot().error).toContain('change could not be saved');
    expect(store.snapshot().error).not.toContain('QuotaExceededError');
    expect(readTokenWatchlist(storage).entries).toEqual(['0xfirst']);
    expect(store.setWatched('0xfirst', false)).toBe(false);
    expect(store.snapshot().entries).toEqual(['0xfirst']);
  });

  it('recovers after storage access returns, without treating a failed load as an empty saved list', () => {
    const storage = memory('["0xfirst"]');
    let allowed = false;
    const store = createTokenWatchlistStore(() => { if (!allowed) throw new Error('SecurityError'); return storage; });
    store.refresh();
    expect(store.snapshot()).toMatchObject({ loaded: true, error: expect.stringContaining('could not be opened') });
    expect(store.setWatched('0xnew', true)).toBe(false);
    expect(storage.setItem).not.toHaveBeenCalled();
    allowed = true; store.refresh();
    expect(store.snapshot()).toEqual({ entries: ['0xfirst'], loaded: true, error: null });
    expect(store.setWatched('0xnew', true)).toBe(true);
    expect(store.snapshot()).toEqual({ entries: ['0xfirst', '0xnew'], loaded: true, error: null });
  });

  it('refreshes external removals and clears without recreating a deleted list', () => {
    const storage = memory('["0xfirst"]'), store = createTokenWatchlistStore(() => storage);
    store.refresh(); storage.values.delete(TOKEN_WATCHLIST_STORAGE_KEY); store.refresh();
    expect(store.snapshot()).toEqual({ entries: [], loaded: true, error: null });
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('rejects an invalid token identifier without changing existing entries', () => {
    const storage = memory('["0xfirst"]');
    expect(() => setTokenWatched(storage, ' ', true)).toThrow('Refresh the market');
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('renders before browser storage exists, with no claim that the watchlist has loaded', () => {
    function Preview() {
      const watchlist = useTokenWatchlist();
      return createElement('span', null, watchlist.loaded ? 'Loaded' : 'Loading watchlist');
    }
    expect(renderToStaticMarkup(createElement(Preview))).toBe('<span>Loading watchlist</span>');
  });
});
