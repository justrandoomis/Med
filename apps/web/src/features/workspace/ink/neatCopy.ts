// «نسخة مرتبة» — the neat copy of a page's handwriting (parity N1 wave 2, G11) — pure, unit-tested.
//
// A DERIVED view: the page's strokes drawn with their lines straightened (each written line turned to a level
// baseline), their size evened out (each line scaled toward the page's usual line height, at most ±25 %, about its
// start: the right end in Arabic) and a stronger smoothing. It is computed from the stored strokes every time it is shown
// and NEVER written back: the original ink stays the evidence of what was written in the lecture (§28, B.2 item 2).
// Shapes, text boxes and pictures are left as they are. N5's export can draw the same items.
import type { InkData } from '@medlevo/shared';
import { baselineAngle, writtenLines } from './handwritingLayout';
import { multiply, rotateAbout, scaleAbout, type Vec } from './math';
import { isInkStroke, transformItem, type InkItem, type InkItemOf } from './model';

type Stroke = InkItemOf<InkData>;

export const NEAT_COPY_LABEL_AR = 'نسخة مرتبة — عرض مشتق للقراءة فقط؛ الحبر الأصلي محفوظ كما كتبته ولم يتغير';
const MAX_TILT = (25 * Math.PI) / 180;

/**
 * The neat copy of `items` (one page): new objects for the strokes that change (same ids — they are never stored), the
 * other items unchanged. `dir` decides which end of a line stays in place when it is resized.
 */
export function neatCopyItems(items: readonly InkItem[], ar: number, dir: 'rtl' | 'ltr' = 'rtl'): InkItem[] {
  const strokes = items.filter((it): it is Stroke => isInkStroke(it) && it.data.style.tool !== 'highlighter');
  if (strokes.length === 0) return [...items];
  const lines = writtenLines(strokes, ar, dir);
  const heights = lines.map((l) => l.box.h).sort((a, b) => a - b);
  const median = heights[Math.floor(heights.length / 2)] ?? 0;
  const derived = new Map<string, InkItem>();
  for (const line of lines) {
    const angle = baselineAngle(line.strokes, ar);
    const c: Vec = [line.box.x + line.box.w / 2, (line.box.y + line.box.h / 2) * ar];
    let m = Math.abs(angle) > MAX_TILT ? rotateAbout(0, c[0], c[1]) : rotateAbout(-angle, c[0], c[1]);
    if (median > 0 && line.box.h > 0 && lines.length > 1) {
      const s = Math.min(1.25, Math.max(0.8, median / line.box.h));
      if (Math.abs(s - 1) > 0.02) {
        const ax = dir === 'rtl' ? line.box.x + line.box.w : line.box.x;
        m = multiply(scaleAbout(s, ax, c[1]), m);
      }
    }
    for (const st of line.strokes) {
      const moved = transformItem(st, m, ar, st.updated_at) as Stroke;
      const smoothing = Math.max(4, typeof st.data.style.smoothing === 'number' ? st.data.style.smoothing : 2);
      derived.set(st.id, { ...moved, data: { ...moved.data, style: { ...moved.data.style, smoothing, width: st.data.style.width } } });
    }
  }
  return items.map((it) => derived.get(it.id) ?? it);
}
