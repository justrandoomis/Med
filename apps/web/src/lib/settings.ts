// Owner settings store (GET/PATCH /api/settings). Preferences are last-write-wins (§3.4 allows it
// for UI preferences): a change applies locally at once, is kept as a pending patch on this device
// and is sent to the server; if the server is unreachable the patch is retried when back online.
import { useSyncExternalStore } from 'react';
import { DEFAULT_OWNER_SETTINGS, mergeSettingsPatch, type OwnerSettings, type SettingsResponse } from '@medlevo/shared';
import { api, isApiError } from './api';
import { setOwnerTimeZone } from './time';
import { appearanceStore, type AppearancePrefs } from '../design/ThemeProvider';

const PENDING_KEY = 'medlevo.settings.pending.v1';
const CACHE_KEY = 'medlevo.settings.cache.v1';

/** pending_auth: kept on this device because the session expired; sent after the next sign-in (load()). */
export type SettingsSaveState = 'idle' | 'saving' | 'saved' | 'pending_offline' | 'pending_auth' | 'error';

interface SettingsState {
  settings: OwnerSettings;
  loaded: boolean;
  loadError: string | null;
  save: SettingsSaveState;
  saveError: string | null;
}

function read<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
function write(key: string, v: unknown) {
  try {
    if (v == null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(v));
  } catch {
    // ignore
  }
}

const APPEARANCE_KEYS = ['theme', 'paper_texture', 'reduce_motion', 'text_scale'] as const;

function pushAppearance(s: Partial<OwnerSettings>) {
  const patch: Partial<AppearancePrefs> = {};
  for (const k of APPEARANCE_KEYS) if (k in s) (patch as Record<string, unknown>)[k] = s[k];
  if (Object.keys(patch).length) appearanceStore.set(patch);
}

class SettingsStore {
  private state: SettingsState;
  private listeners = new Set<() => void>();
  private pending: Partial<OwnerSettings>;
  private flushing: Promise<void> | null = null;
  private onlineHooked = false;

  constructor() {
    const cached = typeof window !== 'undefined' ? read<OwnerSettings>(CACHE_KEY) : null;
    this.pending = (typeof window !== 'undefined' ? read<Partial<OwnerSettings>>(PENDING_KEY) : null) ?? {};
    const settings = { ...DEFAULT_OWNER_SETTINGS, ...(cached ?? {}), ...this.pending };
    this.state = { settings, loaded: false, loadError: null, save: Object.keys(this.pending).length ? 'pending_offline' : 'idle', saveError: null };
    setOwnerTimeZone(settings.timezone);
  }

  get = () => this.state;
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  private set(p: Partial<SettingsState>) {
    this.state = { ...this.state, ...p };
    this.listeners.forEach((l) => l());
  }

  private hookOnline() {
    if (this.onlineHooked || typeof window === 'undefined') return;
    this.onlineHooked = true;
    window.addEventListener('online', () => void this.flush());
  }

  /** Load from the server (signed-in only). Local pending changes win over the fetched values. */
  async load(): Promise<void> {
    this.hookOnline();
    try {
      // background request: a 401 here must not yank the owner to /login (the route gate handles that)
      const res = await api.get<SettingsResponse>('/settings', { skipAuthRedirect: true });
      const merged = { ...DEFAULT_OWNER_SETTINGS, ...res.settings, ...this.pending };
      write(CACHE_KEY, res.settings);
      this.set({ settings: merged, loaded: true, loadError: null });
      setOwnerTimeZone(merged.timezone);
      pushAppearance(merged);
      if (Object.keys(this.pending).length) void this.flush();
    } catch (e) {
      this.set({ loadError: isApiError(e) ? e.message : 'تعذّر تحميل الإعدادات.' });
    }
  }

  /** Apply now, persist locally, send to the server. */
  update(patch: Partial<OwnerSettings>): Promise<void> {
    this.hookOnline();
    // a partial source_priority changes only the purposes it names (same merge as the server's PATCH)
    const settings = mergeSettingsPatch(this.state.settings, patch);
    this.pending = mergeSettingsPatch(this.pending, patch);
    write(PENDING_KEY, this.pending);
    this.set({ settings });
    if ('timezone' in patch) setOwnerTimeZone(settings.timezone);
    pushAppearance(patch);
    return this.flush();
  }

  /** Sends pending changes. Coalesces concurrent calls; keeps the patch on failure. */
  flush(): Promise<void> {
    if (this.flushing) {
      return this.flushing.then(() => (Object.keys(this.pending).length ? this.flush() : undefined));
    }
    const patch = this.pending;
    if (!Object.keys(patch).length) return Promise.resolve();
    this.set({ save: 'saving', saveError: null });
    /** pending edits minus what this request sent (edits made while it was in flight survive) */
    const unsent = (): Partial<OwnerSettings> => {
      const rest: Partial<OwnerSettings> = {};
      for (const [k, v] of Object.entries(this.pending) as Array<[keyof OwnerSettings, unknown]>) {
        if (JSON.stringify(patch[k]) !== JSON.stringify(v)) (rest as Record<string, unknown>)[k] = v;
      }
      return rest;
    };
    this.flushing = api
      .patch<SettingsResponse>('/settings', patch, { skipAuthRedirect: true })
      .then((res) => {
        const rest = unsent();
        this.pending = rest;
        write(PENDING_KEY, Object.keys(rest).length ? rest : null);
        write(CACHE_KEY, res.settings);
        this.set({ settings: { ...DEFAULT_OWNER_SETTINGS, ...res.settings, ...rest }, save: 'saved', saveError: null });
      })
      .catch((e: unknown) => {
        if (isApiError(e) && e.offline) {
          this.set({ save: 'pending_offline', saveError: e.message });
        } else if (isApiError(e) && e.status === 401) {
          // session expired: keep every pending change on this device; load() after sign-in sends it
          this.set({ save: 'pending_auth', saveError: e.message });
        } else if (isApiError(e) && e.status >= 500) {
          // transient server failure: keep the change and say so; it is re-sent on the next change,
          // reconnect or load
          this.set({ save: 'error', saveError: `${e.message} التغيير محفوظ على هذا الجهاز وسيُعاد إرساله.` });
        } else {
          // validation / server error: the server keeps its value for what we sent → drop only that,
          // show the error and roll back to the server value; later edits stay pending
          const rest = unsent();
          this.pending = rest;
          write(PENDING_KEY, Object.keys(rest).length ? rest : null);
          this.set({ save: 'error', saveError: isApiError(e) ? e.message : 'تعذّر حفظ الإعداد.' });
          void this.load();
        }
      })
      .finally(() => {
        this.flushing = null;
      });
    return this.flushing;
  }
}

export const settingsStore = new SettingsStore();

export function useSettings() {
  const state = useSyncExternalStore(settingsStore.subscribe, settingsStore.get, settingsStore.get);
  return { ...state, update: (p: Partial<OwnerSettings>) => settingsStore.update(p), reload: () => settingsStore.load() };
}
