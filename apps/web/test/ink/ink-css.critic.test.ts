// Release R1-b + N1 final critic pass (2026-10-21), two findings in the writing screens (jsdom does not lay out CSS —
// vitest `css: false` — so these check the markup and the stylesheet; the real-browser screenshots are in the TEST_LOG):
//  1. in the pen / shape options, «التقط لونًا من الصفحة» (G07, the eyedropper) showed its pipette icon on a line of its
//     own above the words (phone and desktop; light, dark and e-ink): the button uses the text-link style
//     `.ml-ink-linkbtn`, which is not a flex row, so the global `svg { display: block }` reset put the icon alone;
//  2. in the DARK theme a shape's label (G20, e.g. «الإنسولين» in a filled box) was invisible: it inherited the app's
//     light theme text colour (#eceae4) while it sits on the white PDF page (contrast 1.2:1). Like a text box, it must be
//     drawn in an ink colour of the paper tone the layer reports (`--ml-ink-c-*`, light or dark paper, greys in e-ink);
//  3. on the phone (coarse pointer) the colour-meaning fields of «إعدادات الكتابة» and every slider of the writing
//     options (width, pen feel, alignment and zoom) were 40 px tall — under the 44 px touch target (ARCHITECTURE §4).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const INK = join(__dirname, '..', '..', 'src', 'features', 'workspace', 'ink');
const css = readFileSync(join(INK, 'ink.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** declarations of every rule whose selector list contains exactly `.cls` as one selector */
function rulesOf(cls: string): string[] {
  const out: string[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const selectors = m[1]!.split(',').map((s) => s.trim());
    if (selectors.includes(`.${cls}`)) out.push(m[2]!);
  }
  return out;
}
const isFlexRow = (cls: string) => rulesOf(cls).some((d) => /display:\s*(inline-)?flex/.test(d) && /align-items:\s*center/.test(d));

describe('ink link buttons keep an icon beside their words (R1-b final critic)', () => {
  it('every .ml-ink-linkbtn that starts with an icon is a centred flex row', () => {
    const offenders: string[] = [];
    let iconButtons = 0;
    for (const f of readdirSync(INK).filter((n) => n.endsWith('.tsx'))) {
      const src = readFileSync(join(INK, f), 'utf8');
      for (const open of src.matchAll(/<(button|label)\b/g)) {
        // the opening tag ends at the first `>` outside `{…}` (props hold arrow functions)
        let i = open.index! + open[0].length;
        let depth = 0;
        for (; i < src.length; i++) {
          const c = src[i];
          if (c === '{') depth++;
          else if (c === '}') depth--;
          else if (c === '>' && depth === 0) break;
        }
        const tag = src.slice(open.index!, i);
        const cls = /className="([^"]*)"/.exec(tag)?.[1];
        if (!cls || !/\bml-ink-linkbtn\b/.test(cls) || tag.endsWith('/')) continue;
        const children = src.slice(i + 1, src.indexOf(`</${open[1]}>`, i));
        const first = /^\s*<([A-Za-z][A-Za-z0-9]*)\s([^>]*)>/.exec(children);
        // an icon component (lucide: capitalised, sized) as the first child
        if (!first || !/^[A-Z]/.test(first[1]!) || !/\bsize=/.test(first[2]!)) continue;
        iconButtons++;
        if (!cls.split(/\s+/).filter(Boolean).some(isFlexRow)) offenders.push(`${f}: ${cls}`);
      }
    }
    expect(iconButtons).toBeGreaterThan(0); // the eyedropper
    expect(offenders).toEqual([]);
  });

  it('a shape label is drawn in an ink colour of the paper tone, never the app theme’s text colour', () => {
    const rules = rulesOf('ml-ink-shape-label');
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.some((d) => /(^|;|\s)color:\s*var\(--ml-ink-c-[a-z-]+\)/.test(d))).toBe(true);
  });

  it('on a coarse pointer the colour-meaning fields and the writing sliders are 44 px touch targets', () => {
    // the bodies of every `@media (pointer: coarse)` block
    const blocks: string[] = [];
    for (const m of css.matchAll(/@media\s*\(pointer:\s*coarse\)\s*\{/g)) {
      let depth = 1;
      let i = m.index! + m[0].length;
      const start = i;
      for (; i < css.length && depth > 0; i++) {
        if (css[i] === '{') depth++;
        else if (css[i] === '}') depth--;
      }
      blocks.push(css.slice(start, i - 1));
    }
    const coarseRule = (selector: string) =>
      blocks.some((b) => [...b.matchAll(/([^{}]+)\{([^}]*)\}/g)].some((r) => r[1]!.split(',').map((x) => x.trim()).includes(selector) && /min-height:\s*var\(--ml-touch-target\)/.test(r[2]!)));
    expect(coarseRule('.ml-ink-slot__meaning')).toBe(true);
    expect(coarseRule(".ml-ink-width input[type='range']")).toBe(true);
  });
});
