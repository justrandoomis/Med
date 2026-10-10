// Paper templates of note pages (§26 «قوالب ورق: فارغ، مسطر، منقط، ومربعات»; §22 calm paper).
// The pattern is drawn with CSS gradients in PAGE units scaled by the view, so lines stay on the same spot of the page
// at every zoom (like ink, AC-21) and print / dark mode follow the colour tokens:
//   --wk-paper-rule   line / dot colour (a subtle token: --ml-color-line-strong; never a raw colour)
//   --wk-paper-bg     the sheet's paper colour (covers the ruled header)
// Patterns sit under the ink and are faint by design; they never change the contrast of what the owner writes (ink
// colours are resolved against the paper colour itself, not the pattern).
import type { NotePageTemplate } from '@medlevo/shared';

/** Pattern geometry in page units (pt on an A4 page of 595 × 842). */
export const PAPER_GEOMETRY = {
  /** ruled: distance between lines; top margin before the first line; a margin line on the inline-start side */
  ruled: { pitch: 24, top: 72, marginFromStart: 56 },
  dotted: { pitch: 18, dot: 1.1 },
  grid: { pitch: 18, line: 0.6 },
} as const;

export interface PaperStyle {
  backgroundImage?: string;
  backgroundSize?: string;
  backgroundPosition?: string;
  backgroundRepeat?: string;
}

const px = (n: number) => `${Math.round(n * 1000) / 1000}px`;

/**
 * CSS background for a template at `scale` css px per page unit. `rtl` puts the ruled margin line on the right (Arabic
 * pages start on the right). Blank paper has no pattern.
 */
export function paperStyle(template: NotePageTemplate, scale: number, opts: { rtl?: boolean; pageWidth?: number } = {}): PaperStyle {
  const s = scale > 0 && Number.isFinite(scale) ? scale : 1;
  const rule = 'var(--wk-paper-rule)';
  switch (template) {
    case 'ruled': {
      const g = PAPER_GEOMETRY.ruled;
      const pitch = g.pitch * s;
      const lineW = Math.max(1, 0.7 * s);
      const w = (opts.pageWidth ?? 595) * s;
      const marginX = opts.rtl === false ? g.marginFromStart * s : w - g.marginFromStart * s;
      // the rules repeat in both directions; the paper colour covers the header above the first line
      const header = (g.top - g.pitch / 2) * s;
      return {
        backgroundImage: [
          `linear-gradient(to bottom, var(--wk-paper-bg) 0, var(--wk-paper-bg) ${px(header)}, transparent ${px(header)})`,
          `linear-gradient(to right, transparent ${px(marginX - lineW / 2)}, ${rule} ${px(marginX - lineW / 2)}, ${rule} ${px(marginX + lineW / 2)}, transparent ${px(marginX + lineW / 2)})`,
          `repeating-linear-gradient(to bottom, transparent 0, transparent ${px(pitch - lineW)}, ${rule} ${px(pitch - lineW)}, ${rule} ${px(pitch)})`,
        ].join(', '),
        backgroundSize: `100% 100%, 100% 100%, 100% ${px(pitch)}`,
        backgroundPosition: `0 0, 0 0, 0 ${px(g.top * s - pitch)}`,
        backgroundRepeat: 'no-repeat, no-repeat, repeat-y',
      };
    }
    case 'dotted': {
      const g = PAPER_GEOMETRY.dotted;
      const pitch = g.pitch * s;
      const r = Math.max(0.75, g.dot * s);
      return {
        backgroundImage: `radial-gradient(circle at ${px(pitch / 2)} ${px(pitch / 2)}, ${rule} 0, ${rule} ${px(r)}, transparent ${px(r + 0.6)})`,
        backgroundSize: `${px(pitch)} ${px(pitch)}`,
        backgroundPosition: '0 0',
        backgroundRepeat: 'repeat',
      };
    }
    case 'grid': {
      const g = PAPER_GEOMETRY.grid;
      const pitch = g.pitch * s;
      const lw = Math.max(1, g.line * s);
      return {
        backgroundImage: [
          `linear-gradient(to right, ${rule} 0, ${rule} ${px(lw)}, transparent ${px(lw)})`,
          `linear-gradient(to bottom, ${rule} 0, ${rule} ${px(lw)}, transparent ${px(lw)})`,
        ].join(', '),
        backgroundSize: `${px(pitch)} ${px(pitch)}, ${px(pitch)} ${px(pitch)}`,
        backgroundPosition: '0 0, 0 0',
        backgroundRepeat: 'repeat, repeat',
      };
    }
    default:
      return {};
  }
}

/** Positions (page units, from the top) of the ruled lines on a page of `height` — what the CSS pattern draws. */
export function ruledLineYs(height: number): number[] {
  const g = PAPER_GEOMETRY.ruled;
  const out: number[] = [];
  for (let y = g.top; y <= height - g.pitch / 2; y += g.pitch) out.push(y);
  return out;
}
