import { useEffect, useState } from 'react';

export type ThemePref = 'light' | 'dark' | 'auto';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_KEY = 'paperdesk-theme';
const query = '(prefers-color-scheme: dark)';
const chromeColor: Record<ResolvedTheme, string> = { light: '#f4f6f8', dark: '#14181d' };

export function readThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' || v === 'auto' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

const systemTheme = (): ResolvedTheme =>
  typeof window !== 'undefined' && window.matchMedia?.(query).matches ? 'dark' : 'light';

export function applyTheme(theme: ResolvedTheme) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', chromeColor[theme]);
}

/** Light / Dark / Auto preference. Auto follows the OS and updates live when it changes. */
export function useTheme() {
  const [pref, setPrefState] = useState<ThemePref>(readThemePref);
  const [system, setSystem] = useState<ResolvedTheme>(systemTheme);
  const resolved: ResolvedTheme = pref === 'auto' ? system : pref;

  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setSystem(mq.matches ? 'dark' : 'light');
    mq.addEventListener('change', onChange);
    // Keep other open tabs in sync with the saved choice.
    const onStorage = (e: StorageEvent) => {
      if (e.key === THEME_KEY) setPrefState(readThemePref());
    };
    window.addEventListener('storage', onStorage);
    return () => {
      mq.removeEventListener('change', onChange);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  useEffect(() => applyTheme(resolved), [resolved]);

  const setPref = (next: ThemePref) => {
    setPrefState(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* storage unavailable: choice lasts for this visit */
    }
  };

  return { pref, resolved, setPref };
}
