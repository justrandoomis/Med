import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ALL_COLOR_TOKENS, resolveInkColor, tokenVar } from '../../src/features/workspace/ink/palette';
import { DEFAULT_PRESETS, loadPrefs, parsePrefs, savePrefs, WIDTH_RANGE } from '../../src/features/workspace/ink/prefs';
import { parseCssColor } from '../../src/features/workspace/ink/render';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, '../../src/features/workspace/ink/ink.css'), 'utf8');

function block(selector: string): string {
  const i = css.indexOf(selector);
  expect(i).toBeGreaterThanOrEqual(0);
  return css.slice(i, css.indexOf('}', i));
}

describe('ink colour tokens', () => {
  it('ink.css declares exactly the palette.ts values for both paper tones', () => {
    const light = block(".ml-ink-layer[data-ink-tone='light'] {");
    const dark = block(".ml-ink-layer[data-ink-tone='dark'] {");
    for (const t of ALL_COLOR_TOKENS) {
      expect(light).toContain(`${tokenVar(t.token)}: ${t.light};`);
      expect(dark).toContain(`${tokenVar(t.token)}: ${t.dark};`);
    }
  });

  it('resolves tokens per tone, passes custom hex through, never resolves to nothing', () => {
    expect(resolveInkColor('ink-black', 'light')).toBe('#1c2230');
    expect(resolveInkColor('ink-black', 'dark')).toBe('#eceae4');
    expect(resolveInkColor('#123abc', 'dark')).toBe('#123abc');
    expect(resolveInkColor('nonsense', 'light')).toBe('#1c2230');
  });

  it('parses computed colours for paper-tone detection', () => {
    expect(parseCssColor('rgb(255, 255, 255)')).toEqual([1, 1, 1, 1]);
    expect(parseCssColor('rgba(0, 0, 0, 0)')![3]).toBe(0);
    expect(parseCssColor('transparent')).toBeNull();
  });
});

describe('tool presets (localStorage, defensive)', () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it('round-trips presets per tool', () => {
    const p = loadPrefs();
    p.presets.fountain = { color: 'ink-red', width: 0.004 };
    p.penOnly = false;
    savePrefs(p);
    const back = loadPrefs();
    expect(back.presets.fountain).toEqual({ color: 'ink-red', width: 0.004 });
    expect(back.penOnly).toBe(false);
    expect(back.presets.pen).toEqual(DEFAULT_PRESETS.pen);
  });

  it('rejects invalid stored values (unknown colours, absurd widths, wrong types)', () => {
    const p = parsePrefs({ presets: { pen: { color: 'javascript:alert(1)', width: 99 }, highlighter: { color: '#00ff00', width: -1 } }, lastPen: 'brush', penOnly: 'yes' });
    expect(p.presets.pen.color).toBe(DEFAULT_PRESETS.pen.color);
    expect(p.presets.pen.width).toBe(WIDTH_RANGE.pen.max);
    expect(p.presets.highlighter).toEqual({ color: '#00ff00', width: WIDTH_RANGE.highlighter.min });
    expect(p.lastPen).toBe('pen');
    expect(typeof p.penOnly).toBe('boolean');
  });

  it('works when storage throws (private mode / blocked)', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    const p = loadPrefs();
    expect(p.presets.pen).toEqual(DEFAULT_PRESETS.pen);
    expect(() => savePrefs(p)).not.toThrow();
  });
});
