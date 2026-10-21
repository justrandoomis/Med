// Release R1-a critic pass (2026-10-21): «وضع العرض على هذا الجهاز» (Settings → المظهر, the e-ink / contrast / lite
// rows) rendered its icon on a line of its own above the subhead text, in light, dark and e-ink, at 390 and 1280 px:
// `DisplayModes.tsx` used `ml-settings__subhead` and `ml-settings__note-actions`, which no stylesheet defined, so the
// global `svg { display: block }` reset put the icon alone and the e-ink suggestion's two buttons had no spacing.
// jsdom does not lay out CSS (vitest `css: false`), so this checks the stylesheet itself.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SETTINGS = join(__dirname, '..', 'src', 'features', 'settings');
const css = readFileSync(join(SETTINGS, 'settings.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** the declarations of the first rule whose selector list is exactly `selector` */
function ruleOf(selector: string): string | null {
  const re = new RegExp(`(^|\\})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'm');
  return re.exec(css)?.[2] ?? null;
}

describe('settings stylesheet covers the settings classes (R1-a critic)', () => {
  it('every ml-settings__* class used by a settings component has a rule in settings.css', () => {
    const used = new Set<string>();
    for (const f of readdirSync(SETTINGS).filter((n) => n.endsWith('.tsx') && !n.includes('.test.'))) {
      for (const m of readFileSync(join(SETTINGS, f), 'utf8').matchAll(/\b(ml-settings__[A-Za-z0-9_-]+)/g)) used.add(m[1]!);
    }
    expect(used.has('ml-settings__subhead')).toBe(true);
    const missing = [...used].filter((c) => !new RegExp(`\\.${c}(?![A-Za-z0-9_-])`).test(css)).sort();
    expect(missing).toEqual([]);
  });

  it('the display-mode subhead keeps its icon beside the text (a flex row), and the suggestion buttons wrap with a gap', () => {
    const subhead = ruleOf('.ml-settings__subhead');
    expect(subhead).not.toBeNull();
    expect(subhead!).toMatch(/display:\s*(inline-)?flex/);
    expect(subhead!).toMatch(/align-items:\s*center/);
    const actions = ruleOf('.ml-settings__note-actions');
    expect(actions).not.toBeNull();
    expect(actions!).toMatch(/display:\s*(inline-)?flex/);
    expect(actions!).toMatch(/flex-wrap:\s*wrap/);
    expect(actions!).toMatch(/gap:/);
  });
});
