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
    const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="15" fill="${currentTheme.browserColor}"/><g fill="${currentTheme.accent}" transform="rotate(-18 32 32)"><rect x="13" y="16" width="38" height="8" rx="2"/><rect x="22" y="28" width="29" height="8" rx="2"/><rect x="31" y="40" width="20" height="8" rx="2"/></g></svg>`;
    document.querySelector('link[rel="icon"]')?.setAttribute('href', theme === 'original' ? '/icon.svg' : `data:image/svg+xml,${encodeURIComponent(icon)}`);
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
