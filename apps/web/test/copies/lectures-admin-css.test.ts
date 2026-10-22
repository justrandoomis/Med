// P1-T5 step 1 — the stylesheet of the «إدارة القنوات» sections (features/lectures/admin). jsdom does not lay out CSS
// (vitest `css: false`), so this checks the stylesheet itself: every class the screens use has a rule, colours come
// only from the design tokens (light / dark / e-ink are the tokens' job), only logical properties (RTL), 44 px targets.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = join(__dirname, '..', '..', 'src', 'features', 'lectures', 'admin');
const css = readFileSync(join(DIR, 'lectures-admin.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

describe('lectures-admin.css', () => {
  it('every lec-admin* class used by the sections has a rule', () => {
    const used = new Set<string>();
    for (const f of readdirSync(DIR).filter((n) => n.endsWith('.tsx'))) {
      for (const m of readFileSync(join(DIR, f), 'utf8').matchAll(/\b(lec-admin(?:__[A-Za-z0-9-]+)?)\b/g)) used.add(m[1]!);
    }
    expect(used.size).toBeGreaterThan(10);
    const missing = [...used].filter((c) => !new RegExp(`\\.${c}(?![A-Za-z0-9_-])`).test(css)).sort();
    expect(missing).toEqual([]);
  });

  it('colours only from tokens; no physical left / right properties', () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/\b(rgb|rgba|hsl|hsla)\(/);
    for (const m of css.matchAll(/(?:^|[;{\s])((?:background|border(?:-[a-z]+)?|color|outline)(?:-color)?)\s*:\s*([^;]+);/g)) {
      const value = m[2]!;
      if (/\b(0|none|transparent|inherit|currentColor)\b/.test(value) && !/var\(/.test(value)) continue;
      expect(value, `${m[1]}: ${value}`).toMatch(/var\(--ml-/);
    }
    expect(css).not.toMatch(/(?:^|[\s;{])(?:margin|padding|border)-(?:left|right)\b/);
    expect(css).not.toMatch(/(?:^|[\s;{])(?:left|right)\s*:/);
    expect(css).not.toMatch(/text-align:\s*(left|right)/);
  });

  it('action buttons and the file input are at least 44 px tall', () => {
    expect(css).toMatch(/\.lec-admin__actions \.ml-btn\s*\{[^}]*min-block-size:\s*44px/);
    expect(css).toMatch(/\.lec-admin__file input\[type='file'\]\s*\{[^}]*min-block-size:\s*44px/);
  });
});
