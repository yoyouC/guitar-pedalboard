export const BACKGROUND_THEMES = ['meddle', 'prism', 'fluid'] as const;
export type BackgroundTheme = (typeof BACKGROUND_THEMES)[number];
export type AppLocale = 'zh-CN' | 'en';

export interface AppPreferences {
  locale: AppLocale;
  background: BackgroundTheme;
  reduceVisualLoad: boolean;
  reducedMotion: boolean;
}

const PREFERENCES_KEY = 'guitar-pedalboard-preferences-v1';
const LEGACY_BACKGROUND_KEY = 'guitar-pedalboard-bg-theme';
const LEGACY_VISUAL_LOAD_KEY = 'guitar-pedalboard-reduce-visual-load-v1';

function browserLocale(): AppLocale {
  try {
    return navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
  } catch {
    return 'en';
  }
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export function loadAppPreferences(
  storage: Pick<Storage, 'getItem'> | null = typeof localStorage === 'undefined' ? null : localStorage,
): AppPreferences {
  const fallback: AppPreferences = {
    locale: browserLocale(),
    background: 'meddle',
    reduceVisualLoad: false,
    reducedMotion: prefersReducedMotion(),
  };
  if (!storage) return fallback;
  try {
    const raw = storage.getItem(PREFERENCES_KEY);
    if (raw) {
      const value = JSON.parse(raw) as Partial<AppPreferences>;
      return {
        locale: value.locale === 'zh-CN' || value.locale === 'en' ? value.locale : fallback.locale,
        background: BACKGROUND_THEMES.includes(value.background as BackgroundTheme)
          ? value.background as BackgroundTheme
          : fallback.background,
        reduceVisualLoad: typeof value.reduceVisualLoad === 'boolean'
          ? value.reduceVisualLoad
          : fallback.reduceVisualLoad,
        reducedMotion: typeof value.reducedMotion === 'boolean'
          ? value.reducedMotion
          : fallback.reducedMotion,
      };
    }
    const legacyBackground = storage.getItem(LEGACY_BACKGROUND_KEY);
    return {
      ...fallback,
      background: BACKGROUND_THEMES.includes(legacyBackground as BackgroundTheme)
        ? legacyBackground as BackgroundTheme
        : fallback.background,
      reduceVisualLoad: storage.getItem(LEGACY_VISUAL_LOAD_KEY) === 'true',
    };
  } catch {
    return fallback;
  }
}

export function saveAppPreferences(
  preferences: AppPreferences,
  storage: Pick<Storage, 'setItem'> | null = typeof localStorage === 'undefined' ? null : localStorage,
): void {
  if (!storage) return;
  try {
    storage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
  } catch {
    // Private browsing can make storage unavailable; the in-memory session still works.
  }
}

