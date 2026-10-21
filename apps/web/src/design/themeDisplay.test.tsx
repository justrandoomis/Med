// P1-T2 step 2 — display modes of this device (ADR-0005 B.4): attributes on <html>, kept on this device only, e-ink
// forces light colours / reduced motion / no grain without touching the stored appearance, and e-ink is suggested only
// from the browser's own `(update: slow)` signal.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { applyAppearance, DEFAULT_APPEARANCE, effectiveAppearance } from './ThemeProvider';
import { applyDisplay, DEFAULT_DISPLAY, displayStore, normalizeDisplay, shouldSuggestEink } from './themeDisplay';
import { DisplayModeRows } from '../features/settings/DisplayModes';

const root = () => document.documentElement;

beforeEach(() => {
  localStorage.clear();
  displayStore.__reset(DEFAULT_DISPLAY);
  applyDisplay(DEFAULT_DISPLAY);
});
afterEach(() => {
  displayStore.__reset(DEFAULT_DISPLAY);
  applyDisplay(DEFAULT_DISPLAY);
  vi.restoreAllMocks();
});

describe('display modes', () => {
  it('writes data-eink / data-contrast / data-lite on <html> and removes them again', () => {
    applyDisplay({ ...DEFAULT_DISPLAY, eink: true, lite: true });
    expect(root().getAttribute('data-eink')).toBe('on');
    expect(root().getAttribute('data-lite')).toBe('on');
    expect(root().hasAttribute('data-contrast')).toBe(false);
    applyDisplay(DEFAULT_DISPLAY);
    expect(root().hasAttribute('data-eink')).toBe(false);
    expect(root().hasAttribute('data-lite')).toBe(false);
  });

  it('is kept on this device (localStorage), never in the synced appearance', () => {
    displayStore.set({ contrast: true });
    expect(JSON.parse(localStorage.getItem('medlevo.display.v1')!)).toMatchObject({ contrast: true, eink: false });
    expect(localStorage.getItem('medlevo.appearance.v1')).toBeNull();
    expect(normalizeDisplay({ eink: 'yes' as unknown as boolean })).toEqual(DEFAULT_DISPLAY);
  });

  it('e-ink applies light colours, reduced motion and no paper grain — the stored appearance stays the owner’s', () => {
    const stored = { ...DEFAULT_APPEARANCE, theme: 'dark' as const, paper_texture: true, reduce_motion: 'off' as const };
    expect(effectiveAppearance(stored, { ...DEFAULT_DISPLAY, eink: true })).toMatchObject({ theme: 'light', reduce_motion: 'on', paper_texture: false });
    expect(effectiveAppearance(stored, { ...DEFAULT_DISPLAY, lite: true })).toMatchObject({ theme: 'dark', reduce_motion: 'on', paper_texture: false });
    expect(effectiveAppearance(stored, DEFAULT_DISPLAY)).toBe(stored);
    applyAppearance(stored, root(), { ...DEFAULT_DISPLAY, eink: true });
    expect(root().getAttribute('data-theme')).toBe('light');
    expect(root().getAttribute('data-reduce-motion')).toBe('on');
    expect(root().getAttribute('data-paper')).toBe('off');
    expect(root().getAttribute('data-eink')).toBe('on');
    applyAppearance(stored, root(), DEFAULT_DISPLAY);
    expect(root().getAttribute('data-theme')).toBe('dark');
    expect(root().getAttribute('data-reduce-motion')).toBe('off');
  });

  it('suggests e-ink only from (update: slow), never once on or dismissed', () => {
    expect(shouldSuggestEink(DEFAULT_DISPLAY, false)).toBe(false);
    expect(shouldSuggestEink(DEFAULT_DISPLAY, true)).toBe(true);
    expect(shouldSuggestEink({ ...DEFAULT_DISPLAY, eink: true }, true)).toBe(false);
    expect(shouldSuggestEink({ ...DEFAULT_DISPLAY, eink_suggestion_dismissed: true }, true)).toBe(false);
  });

  it('the settings rows switch the modes; the suggestion shows only with the signal and can be dismissed', () => {
    // jsdom has no matchMedia: a screen that reports a slow update rate
    const had = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: q === '(update: slow)', media: q, onchange: null, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false })) as typeof window.matchMedia;
    render(<DisplayModeRows />);
    expect(screen.getByRole('status').textContent).toContain('الحبر الإلكتروني');
    act(() => screen.getByRole('button', { name: 'لا، شكرًا' }).click());
    expect(screen.queryByRole('status')).toBeNull();
    act(() => screen.getByRole('switch', { name: /شاشة حبر إلكتروني/ }).click());
    expect(displayStore.get().eink).toBe(true);
    expect(root().getAttribute('data-eink')).toBe('on');
    window.matchMedia = had;
  });
});

// (P1-T2 review) e-ink means black / grey ink everywhere — also a custom pen colour (the toolbar's colour picker) and
// the DOM objects (text boxes, sticky notes) that resolve their colour without the ink layer's CSS
describe('e-ink ink colours', () => {
  it('a custom hex colour becomes a grey of its lightness (pens dark, highlighters light); tokens without the CSS use the e-ink greys', async () => {
    const { resolveInkColor } = await import('../features/workspace/ink/palette');
    const grey = (c: string) => {
      const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c);
      return m && m[1] === m[2] && m[2] === m[3] ? parseInt(m[1]!, 16) : null;
    };
    // normal mode: custom colours pass through, tokens use the tone's colour
    expect(resolveInkColor('#ffe14d', 'light', null)).toBe('#ffe14d');
    expect(resolveInkColor('ink-red', 'light', null)).toBe('#c62828');
    applyDisplay({ ...DEFAULT_DISPLAY, eink: true });
    const palePen = grey(resolveInkColor('#ffe14d', 'light', null));
    const darkPen = grey(resolveInkColor('#123456', 'light', null));
    expect(palePen).not.toBeNull();
    expect(darkPen).not.toBeNull();
    expect(palePen!).toBeLessThanOrEqual(0x4a); // a pale custom pen stays readable on a white e-ink page
    expect(darkPen!).toBeLessThanOrEqual(palePen!); // and lightness order is kept
    const hl = grey(resolveInkColor('#ff00aa', 'light', null, 'highlighter'));
    expect(hl).not.toBeNull();
    expect(hl!).toBeGreaterThanOrEqual(0xb0);
    expect(hl!).toBeLessThanOrEqual(0xd6);
    // a text box / sticky note (no ink-layer CSS) in e-ink: the same greys ink.css declares
    expect(resolveInkColor('ink-red', 'light', null)).toBe('#2e2e2e');
    expect(resolveInkColor('hl-yellow', 'light', null)).toBe('#d6d6d6');
  });

  it('ink.css declares exactly the e-ink greys palette.ts uses', async () => {
    const { ALL_COLOR_TOKENS, tokenVar } = await import('../features/workspace/ink/palette');
    const { readFileSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../features/workspace/ink/ink.css'), 'utf8');
    const i = css.indexOf(":root[data-eink='on'] .ml-ink-layer");
    const block = css.slice(i, css.indexOf('}', i));
    for (const t of ALL_COLOR_TOKENS) expect(block).toContain(`${tokenVar(t.token)}: ${(t as { eink?: string }).eink};`);
  });
});
