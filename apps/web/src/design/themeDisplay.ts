// Display modes of THIS screen (Academic OS P1-T2 step 2; ADR-0005 B.4; PRD AOS-4.17, OC.5):
//   * e-ink («شاشة حبر إلكتروني», BOOX and similar): no animations or transitions, black / grey palette, paging instead
//     of smooth scrolling, minimal repaints (no live-stroke prediction overlay);
//   * high contrast («تباين عالٍ»): stronger text, lines and control borders, no paper grain;
//   * lite («خفيف»): no paper grain, flat shadows, no blur, a smaller ink tile cache — for slow devices.
// Applied as attributes on <html> (`data-eink`, `data-contrast`, `data-lite` = "on"); the colours live in tokens.css.
//
// They describe the device, not the owner, so they are kept on this device only (never synced to another one). E-ink is
// only SUGGESTED, and only from an honest signal the browser gives: the CSS media feature `(update: slow)`. Nothing is
// inferred from a device name.

export interface DisplayPrefs {
  eink: boolean;
  contrast: boolean;
  lite: boolean;
  /** the owner dismissed the e-ink suggestion on this device */
  eink_suggestion_dismissed: boolean;
}

export const DEFAULT_DISPLAY: DisplayPrefs = { eink: false, contrast: false, lite: false, eink_suggestion_dismissed: false };

const STORAGE_KEY = 'medlevo.display.v1';

export function normalizeDisplay(raw: Partial<DisplayPrefs> | null | undefined): DisplayPrefs {
  const r = raw ?? {};
  return {
    eink: r.eink === true,
    contrast: r.contrast === true,
    lite: r.lite === true,
    eink_suggestion_dismissed: r.eink_suggestion_dismissed === true,
  };
}

function readStored(): DisplayPrefs {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return normalizeDisplay(raw ? (JSON.parse(raw) as Partial<DisplayPrefs>) : null);
  } catch {
    return DEFAULT_DISPLAY;
  }
}

/** Writes the attributes on <html>. Safe to call repeatedly. */
export function applyDisplay(p: DisplayPrefs, root: HTMLElement = document.documentElement): void {
  for (const [attr, on] of [
    ['data-eink', p.eink],
    ['data-contrast', p.contrast],
    ['data-lite', p.lite],
  ] as const) {
    if (on) root.setAttribute(attr, 'on');
    else root.removeAttribute(attr);
  }
}

/**
 * The honest e-ink signal: the screen reports a slow update rate (`@media (update: slow)`, Media Queries 4). Most
 * browsers on e-ink readers do not report it; then nothing is suggested and the owner chooses in the settings.
 */
export function screenUpdatesSlowly(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(update: slow)').matches;
  } catch {
    return false;
  }
}

/** Suggest e-ink mode here? Only from the signal above, never when on already or after the owner said no. */
export function shouldSuggestEink(p: DisplayPrefs, slow: boolean = screenUpdatesSlowly()): boolean {
  return slow && !p.eink && !p.eink_suggestion_dismissed;
}

type Listener = () => void;

class DisplayStore {
  private prefs: DisplayPrefs = typeof window === 'undefined' ? DEFAULT_DISPLAY : readStored();
  private listeners = new Set<Listener>();

  get = (): DisplayPrefs => this.prefs;

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  set(patch: Partial<DisplayPrefs>): void {
    const next = normalizeDisplay({ ...this.prefs, ...patch });
    if (JSON.stringify(next) === JSON.stringify(this.prefs)) return;
    this.prefs = next;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // storage blocked: the mode still applies for this session
    }
    applyDisplay(next);
    this.listeners.forEach((l) => l());
  }

  /** Tests only. */
  __reset(p: DisplayPrefs = DEFAULT_DISPLAY): void {
    this.prefs = p;
    this.listeners.forEach((l) => l());
  }
}

export const displayStore = new DisplayStore();
