export const THEME_STORAGE_KEY = 'oneshot.appearance';

export const themes = [
  {
    id: 'original', name: 'Original', edition: 'THE HOUSE ORIGINAL',
    description: 'oneshot gold, onyx and ivory.',
    colors: ['#0F100F', '#E6B85C', '#F7F3E8', '#171612'],
    appearance: 'dark', accent: '#E6B85C', browserColor: '#0F100F',
  },
  {
    id: 'onyx', name: 'Onyx & 24-Karat', edition: 'AFTER HOURS, REFINED',
    description: 'Black with warm gold accents.',
    colors: ['#0A0A0A', '#C69B3C', '#F4EADE', '#BFC1C2'],
    appearance: 'dark', accent: '#C69B3C', browserColor: '#10100F',
  },
  {
    id: 'champagne', name: 'Brut Champagne', edition: 'A LIGHTER POINT OF VIEW',
    description: 'Ivory, bronze and soft shadows.',
    colors: ['#EBDAB0', '#F4EADE', '#8A7968', '#2B2B2B'],
    appearance: 'light', accent: '#8A7968', browserColor: '#F9F2E7',
  },
  {
    id: 'vice', name: 'Vice Afterglow', edition: 'GTA VI INSPIRED',
    description: 'Deep violet with pink and teal.',
    colors: ['#161225', '#FF8CC6', '#FFB38A', '#70E3DC'],
    appearance: 'dark', accent: '#FF8CC6', browserColor: '#171323',
  },
] as const;

export type ThemeId = typeof themes[number]['id'];

export function isThemeId(value: unknown): value is ThemeId {
  return themes.some(theme => theme.id === value);
}

// Private browsing and embedded browsers can deny storage entirely. Appearance
// still works for the current session when that happens.
export function readThemePreference(storage: Pick<Storage, 'getItem'>): ThemeId {
  try {
    const value = storage.getItem(THEME_STORAGE_KEY);
    return isThemeId(value) ? value : 'original';
  } catch {
    return 'original';
  }
}

export function saveThemePreference(storage: Pick<Storage, 'setItem'>, theme: ThemeId): boolean {
  try {
    storage.setItem(THEME_STORAGE_KEY, theme);
    return true;
  } catch {
    return false;
  }
}
