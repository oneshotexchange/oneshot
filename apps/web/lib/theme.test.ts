import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { readThemePreference, saveThemePreference, themes, THEME_STORAGE_KEY } from './theme';

const bootstrap = readFileSync(new URL('../public/theme-init.js', import.meta.url), 'utf8');

function boot(storage: { getItem(key: string): unknown } | undefined) {
  const root = { dataset: {} as Record<string, string>, style: {} as Record<string, string> };
  const sandbox = { document: { documentElement: root } };
  Object.defineProperty(sandbox, 'localStorage', {
    get() {
      if (!storage) throw new Error('Storage is disabled');
      return storage;
    },
  });
  runInNewContext(bootstrap, sandbox);
  return root;
}

describe('appearance preference recovery', () => {
  it.each(themes)('restores the $id edition with the same first-paint color scheme', theme => {
    const storage = { getItem: (key: string) => key === THEME_STORAGE_KEY ? theme.id : null };
    expect(readThemePreference(storage)).toBe(theme.id);
    expect(boot(storage)).toEqual({ dataset: { theme: theme.id }, style: { colorScheme: theme.appearance } });
  });

  it.each([null, '', 'dark', 'light', 'forest', 'Onyx', 'onyx ', 'null', '{"id":"vice"}', '<script>'])('recovers invalid or legacy storage value %s to Original before and after mounting', value => {
    const storage = { getItem: () => value };
    expect(readThemePreference(storage)).toBe('original');
    expect(boot(storage)).toEqual({ dataset: { theme: 'original' }, style: { colorScheme: 'dark' } });
  });

  it('still starts when the storage API throws or cannot be accessed', () => {
    const denied = { getItem: () => { throw new Error('SecurityError'); } };
    expect(readThemePreference(denied)).toBe('original');
    expect(boot(denied).dataset.theme).toBe('original');
    expect(boot(undefined).dataset.theme).toBe('original');
  });

  it('persists a selection for a subsequent visit without changing unrelated preferences', () => {
    const values = new Map([['unrelated-setting', 'keep-me']]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
    expect(saveThemePreference(storage, 'champagne')).toBe(true);
    expect(readThemePreference(storage)).toBe('champagne');
    expect(boot(storage).style.colorScheme).toBe('light');
    expect(values.get('unrelated-setting')).toBe('keep-me');
  });

  it('reports a failed save without throwing or losing the previously saved selection', () => {
    const storage = {
      getItem: () => 'onyx',
      setItem: () => { throw new Error('QuotaExceededError'); },
    };
    expect(saveThemePreference(storage, 'vice')).toBe(false);
    expect(readThemePreference(storage)).toBe('onyx');
  });
});
