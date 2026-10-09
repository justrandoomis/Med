import { createContext, useContext, useEffect, useSyncExternalStore, type ReactNode } from 'react';

/**
 * Appearance preferences (a subset of OwnerSettings). Applied as attributes on <html>:
 *   data-theme="light|dark"        (absent → follow the OS)
 *   data-paper="on|off"            paper texture
 *   data-reduce-motion="on|off"    (absent → follow the OS)
 *   data-text-scale="1.15" + style --ml-text-scale
 * Persisted locally (so the first paint is right, even offline) and synced from /api/settings by
 * lib/settings.ts when the owner is signed in.
 */
export interface AppearancePrefs {
  theme: 'system' | 'light' | 'dark';
  paper_texture: boolean;
  reduce_motion: 'system' | 'on' | 'off';
  text_scale: number;
}

export const DEFAULT_APPEARANCE: AppearancePrefs = {
  theme: 'system',
  paper_texture: true,
  reduce_motion: 'system',
  text_scale: 1,
};

const STORAGE_KEY = 'medlevo.appearance.v1';

function clampScale(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : 1;
  return Math.min(1.6, Math.max(0.8, Math.round(v * 100) / 100));
}

export function normalizeAppearance(raw: Partial<AppearancePrefs> | null | undefined): AppearancePrefs {
  const r = raw ?? {};
  return {
    theme: r.theme === 'light' || r.theme === 'dark' ? r.theme : 'system',
    paper_texture: typeof r.paper_texture === 'boolean' ? r.paper_texture : DEFAULT_APPEARANCE.paper_texture,
    reduce_motion: r.reduce_motion === 'on' || r.reduce_motion === 'off' ? r.reduce_motion : 'system',
    text_scale: clampScale(r.text_scale),
  };
}

function readStored(): AppearancePrefs {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return normalizeAppearance(raw ? (JSON.parse(raw) as Partial<AppearancePrefs>) : null);
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

function writeStored(p: AppearancePrefs): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    // storage blocked (private mode / quota): appearance still applies for this session
  }
}

type Listener = () => void;

class AppearanceStore {
  private prefs: AppearancePrefs = typeof window === 'undefined' ? DEFAULT_APPEARANCE : readStored();
  private listeners = new Set<Listener>();

  get = (): AppearancePrefs => this.prefs;

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  set(patch: Partial<AppearancePrefs>): void {
    const next = normalizeAppearance({ ...this.prefs, ...patch });
    if (JSON.stringify(next) === JSON.stringify(this.prefs)) return;
    this.prefs = next;
    writeStored(next);
    applyAppearance(next);
    this.listeners.forEach((l) => l());
  }
}

export const appearanceStore = new AppearanceStore();

export function resolvedTheme(p: AppearancePrefs): 'light' | 'dark' {
  if (p.theme !== 'system') return p.theme;
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

const THEME_COLOR = { light: '#EEF0F1', dark: '#121314' } as const;

/** Writes the attributes on <html>. Safe to call repeatedly. */
export function applyAppearance(p: AppearancePrefs, root: HTMLElement = document.documentElement): void {
  if (p.theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', p.theme);
  root.setAttribute('data-paper', p.paper_texture ? 'on' : 'off');
  if (p.reduce_motion === 'system') root.removeAttribute('data-reduce-motion');
  else root.setAttribute('data-reduce-motion', p.reduce_motion);
  root.setAttribute('data-text-scale', String(p.text_scale));
  root.style.setProperty('--ml-text-scale', String(p.text_scale));
  // Browser chrome colour follows the explicit choice; with "system" the media-query metas apply.
  const metas = Array.from(document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'));
  for (const m of metas) {
    if (!m.dataset.media) m.dataset.media = m.getAttribute('media') ?? '';
    if (p.theme === 'system') {
      if (m.dataset.media) m.setAttribute('media', m.dataset.media);
      m.content = m.dataset.media.includes('dark') ? THEME_COLOR.dark : THEME_COLOR.light;
    } else {
      m.removeAttribute('media');
      m.content = THEME_COLOR[p.theme];
    }
  }
}

interface AppearanceContextValue {
  prefs: AppearancePrefs;
  resolved: 'light' | 'dark';
  setPrefs: (patch: Partial<AppearancePrefs>) => void;
}

const AppearanceContext = createContext<AppearanceContextValue | null>(null);

function subscribeSystemScheme(cb: () => void): () => void {
  try {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', cb);
    return () => mq.removeEventListener('change', cb);
  } catch {
    return () => {};
  }
}

function systemIsDark(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const prefs = useSyncExternalStore(appearanceStore.subscribe, appearanceStore.get, () => DEFAULT_APPEARANCE);
  const systemDark = useSyncExternalStore(subscribeSystemScheme, systemIsDark, () => false);
  useEffect(() => {
    applyAppearance(prefs);
  }, [prefs]);
  const resolved = prefs.theme === 'system' ? (systemDark ? 'dark' : 'light') : prefs.theme;
  return (
    <AppearanceContext.Provider value={{ prefs, resolved, setPrefs: (patch) => appearanceStore.set(patch) }}>{children}</AppearanceContext.Provider>
  );
}

export function useAppearance(): AppearanceContextValue {
  const ctx = useContext(AppearanceContext);
  if (!ctx) throw new Error('useAppearance must be used inside <ThemeProvider>');
  return ctx;
}
