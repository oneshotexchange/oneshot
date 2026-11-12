import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useState, type ReactNode } from 'react';
import { isThemeId, readThemePreference, saveThemePreference, themes, THEME_STORAGE_KEY, type ThemeId } from '../lib/theme';

type ThemeContextValue = {
  theme: ThemeId;
  currentTheme: typeof themes[number];
  setTheme: (theme: ThemeId) => void;
  preferenceSaved: boolean;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

function initialTheme(): ThemeId {
  try { return readThemePreference(window.localStorage); }
  catch { return 'original'; }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, updateTheme] = useState<ThemeId>(initialTheme);
  const [preferenceSaved, setPreferenceSaved] = useState(true);
  const currentTheme = themes.find(candidate => candidate.id === theme)!;

  const setTheme = useCallback((next: ThemeId) => {
    if (!isThemeId(next)) return;
    updateTheme(next);
    try { setPreferenceSaved(saveThemePreference(window.localStorage, next)); }
    catch { setPreferenceSaved(false); }
  }, []);

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = currentTheme.appearance;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', currentTheme.browserColor);
    document.querySelector('link[rel="icon"]')?.setAttribute('href', '/icon.svg');
  }, [theme, currentTheme]);

  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key !== THEME_STORAGE_KEY && event.key !== null) return;
      updateTheme(isThemeId(event.newValue) ? event.newValue : 'original');
      setPreferenceSaved(true);
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);

  return <ThemeContext.Provider value={{ theme, currentTheme, setTheme, preferenceSaved }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used inside ThemeProvider.');
  return context;
}
