// GATE-1 critic pass (2026-10-22, 390 × 844 touch emulation, light / dark / e-ink): the breadcrumb links of every new
// R1-c screen — «القنوات» › university › college on the subject page, «أنا» on «أجهزتي» / «الخصوصية» / «الاستخدام» and on
// every «إدارة القنوات» section — were 24 px tall, and «أنا» only 10 px wide: under the 44 px touch target every other
// control keeps (ARCHITECTURE §4, PRD AOS-20.5). They are navigation, not words inside running text. jsdom does not lay
// out CSS (vitest `css: false`), so this checks the stylesheet: on a coarse pointer a breadcrumb link is a 44 × 44 box.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(__dirname, '..', 'src', 'design', 'components.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** the bodies of every `@media (pointer: coarse) { … }` block (one level of nested rules) */
function coarseBlocks(): string[] {
  const out: string[] = [];
  const re = /@media\s*\(pointer:\s*coarse\)\s*\{/g;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    for (; i < css.length && depth > 0; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') depth--;
    }
    out.push(css.slice(start, i - 1));
  }
  return out;
}

describe('GATE-1: breadcrumb links are touch targets on a phone', () => {
  it('on a coarse pointer `.ml-breadcrumbs a` is at least 44 px tall and 44 px wide, its text centred', () => {
    const decls = coarseBlocks()
      .flatMap((b) => [...b.matchAll(/([^{}]+)\{([^}]*)\}/g)])
      .filter((r) => r[1]!.split(',').map((s) => s.trim()).includes('.ml-breadcrumbs a'))
      .map((r) => r[2]!)
      .join(';');
    expect(decls).toMatch(/min-height:\s*var\(--ml-touch-target\)/);
    expect(decls).toMatch(/min-width:\s*var\(--ml-touch-target\)/);
    expect(decls).toMatch(/display:\s*inline-flex/);
    expect(decls).toMatch(/align-items:\s*center/);
  });
});
