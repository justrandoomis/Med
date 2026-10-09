import { afterEach, describe, expect, it, vi } from 'vitest';
import { normToView, type PageViewTransform } from '@medlevo/shared';
import { selectionToHighlight } from '../selection/SelectionToolbar';
import { clientRectsToNorm, mergeLineBoxes, quoteFromText, rangeFromOffsets, rangeOffsetsWithin } from './textQuote';

describe('text quote anchors (§25)', () => {
  const text = 'Pain usually begins in the periumbilical region and later migrates to the right iliac fossa.';
  it('builds {exact, prefix, suffix} and trims surrounding whitespace', () => {
    const s = text.indexOf('periumbilical') - 1; // includes the space before
    const q = quoteFromText(text, s, s + 1 + 'periumbilical region'.length + 1, 10);
    expect(q).toEqual({ exact: 'periumbilical region', prefix: 'ns in the ', suffix: ' and later' });
    expect(quoteFromText(text, 5, 5)).toBeNull();
    expect(quoteFromText('   ', 0, 3)).toBeNull();
    expect(quoteFromText(text, 0, 4)).toEqual({ exact: 'Pain', suffix: ' usually begins in the periumbil' });
  });

  it('keeps Arabic in logical order (no bidi controls added)', () => {
    const ar = 'يبدأ الألم عادةً حول السرة ثم ينتقل';
    const q = quoteFromText(ar, ar.indexOf('حول'), ar.indexOf('ثم') - 1);
    expect(q?.exact).toBe('حول السرة');
    expect(/[‎‏‪-‮⁦-⁩]/.test(JSON.stringify(q))).toBe(false);
  });

  it('maps a DOM selection across text-layer spans to offsets and back', () => {
    const root = document.createElement('div');
    root.innerHTML = '<span>Acute </span><span>appendicitis</span><br><span>Pain usually</span>';
    document.body.append(root);
    const spans = root.querySelectorAll('span');
    const r = document.createRange();
    r.setStart(spans[1]!.firstChild!, 3); // "endicitis…"
    r.setEnd(spans[2]!.firstChild!, 4); // "…Pain"
    const off = rangeOffsetsWithin(root, r);
    expect(off).toEqual({ start: 9, end: 22 });
    expect((root.textContent ?? '').slice(off!.start, off!.end)).toBe('endicitisPain');
    const back = rangeFromOffsets(root, off!.start, off!.end)!;
    expect(back.toString()).toBe('endicitisPain');
    // element boundaries (selection ending at a span edge)
    const r2 = document.createRange();
    r2.setStart(root, 1);
    r2.setEnd(root, 2);
    expect(rangeOffsetsWithin(root, r2)).toEqual({ start: 6, end: 18 });
    // selectNodeContents(span): the end boundary is "after the last child" of that span (regression:
    // it used to resolve to the end of the whole page, quoting the entire page)
    const r3 = document.createRange();
    r3.selectNodeContents(spans[1]!);
    expect(rangeOffsetsWithin(root, r3)).toEqual({ start: 6, end: 18 });
    root.remove();
  });

  it('converts selection rects to normalized boxes on the unrotated page — exact under rotation', () => {
    const view: PageViewTransform = { pageWidth: 600, pageHeight: 800, scale: 1.5, rotation: 90 };
    // a word at normalized (0.1, 0.2)–(0.3, 0.23): where does it appear on the rotated screen?
    const [ax, ay] = normToView(0.1, 0.2, view);
    const [bx, by] = normToView(0.3, 0.23, view);
    const box = { left: 100, top: 50, width: 1200, height: 900 };
    const rect = { left: box.left + Math.min(ax, bx), top: box.top + Math.min(ay, by), width: Math.abs(bx - ax), height: Math.abs(by - ay) };
    const [n] = clientRectsToNorm([rect], box, view);
    expect(n!.x).toBeCloseTo(0.1, 6);
    expect(n!.y).toBeCloseTo(0.2, 6);
    expect(n!.w).toBeCloseTo(0.2, 6);
    expect(n!.h).toBeCloseTo(0.03, 6);
    // rects outside the page and empty rects are dropped
    expect(clientRectsToNorm([{ left: 0, top: 0, width: 10, height: 10 }, { left: 200, top: 200, width: 0, height: 4 }], box, view)).toEqual([]);
  });

  it('merges per-run rects of one line', () => {
    const merged = mergeLineBoxes([
      { x: 0.1, y: 0.2, w: 0.1, h: 0.02 },
      { x: 0.2, y: 0.2005, w: 0.15, h: 0.02 },
      { x: 0.1, y: 0.25, w: 0.3, h: 0.02 },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0]!.x).toBeCloseTo(0.1);
    expect(merged[0]!.w).toBeCloseTo(0.25);
  });
});

describe('text highlight from a selection (selection → annotation data)', () => {
  afterEach(() => vi.restoreAllMocks());
  it('produces the quote with context and normalized rects from the page sheet', () => {
    const sheet = document.createElement('div');
    sheet.className = 'wk-sheet';
    Object.assign(sheet.dataset, { pw: '595', ph: '842', scale: '1', rot: '0' });
    const layer = document.createElement('div');
    layer.innerHTML = '<span>Ultrasound is the first-line </span><span>imaging test in children.</span>';
    sheet.append(layer);
    document.body.append(sheet);
    vi.spyOn(sheet, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 595, height: 842, right: 595, bottom: 842, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
    const span = layer.querySelectorAll('span')[0]!;
    const range = document.createRange();
    range.setStart(span.firstChild!, 0);
    range.setEnd(span.firstChild!, 'Ultrasound is the first-line'.length);
    range.getClientRects = () => [{ left: 59.5, top: 84.2, width: 119, height: 16.84 }] as unknown as DOMRectList;
    const h = selectionToHighlight({ range }, layer, sheet);
    expect(h?.quote).toEqual({ exact: 'Ultrasound is the first-line', suffix: ' imaging test in children.' });
    expect(h?.rects).toEqual([{ x: 0.1, y: 0.1, w: 0.2, h: 0.02 }]);
    sheet.remove();
  });
});
