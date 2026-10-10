// Paper templates (§26 «قوالب ورق», §22): drawn in page units (follow zoom exactly), token colours only (dark mode /
// high contrast follow the theme), the ruled margin on the reading side, nothing on blank paper.
import { describe, expect, it } from 'vitest';
import { NOTE_PAGE_TEMPLATES } from '@medlevo/shared';
import { PAPER_GEOMETRY, paperStyle, ruledLineYs } from './paper';

describe('paper templates', () => {
  it('blank paper has no pattern; the others draw one', () => {
    expect(paperStyle('blank', 1)).toEqual({});
    for (const t of NOTE_PAGE_TEMPLATES.filter((x) => x !== 'blank')) expect(paperStyle(t, 1).backgroundImage).toBeTruthy();
  });

  it('uses colour tokens only — never a raw colour that would ignore dark mode or high contrast', () => {
    for (const t of NOTE_PAGE_TEMPLATES) {
      const css = JSON.stringify(paperStyle(t, 1.7));
      expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
      if (t !== 'blank') expect(css).toContain('var(--wk-paper-rule)');
    }
  });

  it('the pattern is in page units: twice the zoom → twice the spacing (lines stay on the same spot of the page)', () => {
    const at1 = paperStyle('grid', 1).backgroundSize!;
    const at2 = paperStyle('grid', 2).backgroundSize!;
    expect(at1.startsWith(`${PAPER_GEOMETRY.grid.pitch}px`)).toBe(true);
    expect(at2.startsWith(`${PAPER_GEOMETRY.grid.pitch * 2}px`)).toBe(true);
    expect(paperStyle('dotted', 0.5).backgroundSize).toBe(`${PAPER_GEOMETRY.dotted.pitch / 2}px ${PAPER_GEOMETRY.dotted.pitch / 2}px`);
    // invalid scales never produce NaN css
    expect(JSON.stringify(paperStyle('ruled', Number.NaN))).not.toMatch(/NaN|Infinity/);
  });

  it('ruled paper: the margin line is on the right for Arabic pages and on the left otherwise; a clear header above the first line', () => {
    const rtl = paperStyle('ruled', 1, { rtl: true, pageWidth: 595 }).backgroundImage!;
    const ltr = paperStyle('ruled', 1, { rtl: false, pageWidth: 595 }).backgroundImage!;
    const margin = (s: string) => Number(/linear-gradient\(to right, transparent ([\d.]+)px/.exec(s)![1]);
    expect(margin(rtl)).toBeGreaterThan(500);
    expect(margin(ltr)).toBeLessThan(100);
    expect(rtl).toContain('var(--wk-paper-bg)');
    const ys = ruledLineYs(842);
    expect(ys[0]).toBe(PAPER_GEOMETRY.ruled.top);
    expect(ys[1]! - ys[0]!).toBe(PAPER_GEOMETRY.ruled.pitch);
    expect(ys[ys.length - 1]!).toBeLessThanOrEqual(842);
  });
});
