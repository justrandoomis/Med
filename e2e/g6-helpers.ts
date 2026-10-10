// Helpers for the G6 acceptance specs (AC-20, AC-21, AC-22, AC-28): visual glyph order of mixed Arabic/English text,
// the painted box of the ink layer, the text-layer box of a word, and the reader's tool / view controls.
import { expect, type Locator, type Page } from '@playwright/test';

export interface Glyph {
  ch: string;
  /** centre, client coordinates */
  x: number;
  y: number;
  h: number;
}

/** Client positions of each character of `token` (first occurrence, DOM text order = logical order) inside `root`. */
export async function glyphs(root: Locator, token: string): Promise<Glyph[] | null> {
  return root.evaluate((el, tok) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const nodes: Array<[Text, number]> = [];
    let text = '';
    while (walker.nextNode()) {
      const n = walker.currentNode as Text;
      nodes.push([n, text.length]);
      text += n.data;
    }
    const at = text.indexOf(tok);
    if (at < 0) return null;
    const out: Array<{ ch: string; x: number; y: number; h: number }> = [];
    for (let i = at; i < at + tok.length; i++) {
      let k = nodes.length - 1;
      while (nodes[k]![1] > i) k--;
      const [node, off] = nodes[k]!;
      const r = document.createRange();
      r.setStart(node, i - off);
      r.setEnd(node, i - off + 1);
      const b = r.getBoundingClientRect();
      out.push({ ch: text[i]!, x: b.left + b.width / 2, y: b.top + b.height / 2, h: b.height });
    }
    return out;
  }, token);
}

const sameLine = (a: Glyph, b: Glyph) => Math.abs(a.y - b.y) < Math.max(a.h, b.h) * 0.5;

/**
 * The characters of an LTR expression (a term, a number with its unit, a formula) are DRAWN left to right — on every
 * line it occupies. A superscript / subscript left outside the expression's isolate is drawn on the wrong side of it.
 */
export async function expectDrawnLeftToRight(root: Locator, token: string): Promise<void> {
  const g = await glyphs(root, token);
  expect(g, `«${token}» is in the text (logical order)`).not.toBeNull();
  const ink = g!.filter((x) => x.ch.trim() !== '' && x.h > 0);
  for (let i = 1; i < ink.length; i++) {
    const [a, b] = [ink[i - 1]!, ink[i]!];
    if (!sameLine(a, b)) continue;
    expect(b.x, `«${token}»: «${b.ch}» must be drawn to the right of «${a.ch}» (${a.x.toFixed(1)} → ${b.x.toFixed(1)})`).toBeGreaterThan(a.x);
  }
}

/** In right-to-left reading, `first` comes before `then`: when both sit on one line, `first` is drawn to the right. */
export async function expectReadBefore(root: Locator, first: string, then: string, within: string): Promise<void> {
  const g = await glyphs(root, within);
  expect(g, `«${within}» is in the text`).not.toBeNull();
  const i = within.indexOf(first);
  const j = within.indexOf(then);
  expect(i >= 0 && j > i, `«${first}» before «${then}» in «${within}»`).toBe(true);
  const a = g![i]!;
  const b = g![j]!;
  if (!sameLine(a, b)) return;
  expect(a.x, `«${first}» is read before «${then}» (right of it in RTL)`).toBeGreaterThan(b.x);
}

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Bounding box (client coordinates) of the painted pixels of the committed-ink canvas of a reader page. */
export async function inkBox(page: Page, pageIndex: number): Promise<Box | null> {
  return page.locator(`.wk-page[data-page-index="${pageIndex}"] canvas.ml-ink-layer__canvas:not(.ml-ink-layer__canvas--highlight):not(.ml-ink-layer__canvas--live)`).evaluate((c: HTMLCanvasElement) => {
    const ctx = c.getContext('2d');
    if (!ctx || !c.width || !c.height) return null;
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        if (data[(y * c.width + x) * 4 + 3]! > 40) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return null;
    const r = c.getBoundingClientRect();
    const sx = r.width / c.width;
    const sy = r.height / c.height;
    return { left: r.left + minX * sx, top: r.top + minY * sy, right: r.left + (maxX + 1) * sx, bottom: r.top + (maxY + 1) * sy };
  });
}

/** Client box of the text-layer span holding `text` on a reader page (the source region the ink was written over). */
export async function wordBox(page: Page, pageIndex: number, text: string | RegExp): Promise<Box> {
  const span = page.locator(`.wk-page[data-page-index="${pageIndex}"] .wk-textlayer span`).filter({ hasText: text }).first();
  await expect(span).toBeAttached();
  return span.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  });
}

/**
 * Painted ink pixels of a reader page in a window around `word` (the word box grown by `pad` px): how many there are,
 * how many lie on the word (grown by `slack` for the stroke width), and the box they span.
 */
export async function inkNear(page: Page, pageIndex: number, word: Box, pad: number, slack = 6): Promise<{ total: number; onWord: number; box: Box | null }> {
  return page
    .locator(`.wk-page[data-page-index="${pageIndex}"] canvas.ml-ink-layer__canvas:not(.ml-ink-layer__canvas--highlight):not(.ml-ink-layer__canvas--live)`)
    .evaluate(
      (c: HTMLCanvasElement, a) => {
        const ctx = c.getContext('2d');
        const r = c.getBoundingClientRect();
        if (!ctx || !c.width || !c.height) return { total: 0, onWord: 0, box: null };
        const sx = c.width / r.width;
        const sy = c.height / r.height;
        const win = { l: a.w.left - a.pad, t: a.w.top - a.pad, r: a.w.right + a.pad, b: a.w.bottom + a.pad };
        const x0 = Math.max(0, Math.floor((win.l - r.left) * sx));
        const y0 = Math.max(0, Math.floor((win.t - r.top) * sy));
        const x1 = Math.min(c.width, Math.ceil((win.r - r.left) * sx));
        const y1 = Math.min(c.height, Math.ceil((win.b - r.top) * sy));
        if (x1 <= x0 || y1 <= y0) return { total: 0, onWord: 0, box: null };
        const { data } = ctx.getImageData(x0, y0, x1 - x0, y1 - y0);
        let total = 0;
        let onWord = 0;
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            if (data[((y - y0) * (x1 - x0) + (x - x0)) * 4 + 3]! <= 40) continue;
            const cx = r.left + (x + 0.5) / sx;
            const cy = r.top + (y + 0.5) / sy;
            total++;
            if (cx >= a.w.left - a.slack && cx <= a.w.right + a.slack && cy >= a.w.top - a.slack && cy <= a.w.bottom + a.slack) onWord++;
            minX = Math.min(minX, cx);
            maxX = Math.max(maxX, cx);
            minY = Math.min(minY, cy);
            maxY = Math.max(maxY, cy);
          }
        }
        return { total, onWord, box: total ? { left: minX, top: minY, right: maxX, bottom: maxY } : null };
      },
      { w: word, pad, slack },
    );
}

/**
 * The stroke written along a word is still on that word: around the word there is ink, ≥ 90 % of it lies on the word,
 * and it still covers at least half of the word's long side (it was written over 70 % of it).
 */
export async function expectInkOnWord(page: Page, pageIndex: number, word: Box, label: string): Promise<void> {
  const long = Math.max(word.right - word.left, word.bottom - word.top);
  const short = Math.min(word.right - word.left, word.bottom - word.top);
  const near = await inkNear(page, pageIndex, word, Math.max(16, short * 2));
  expect(near.total, `${label}: ink painted around the word ${JSON.stringify(round(word))}`).toBeGreaterThan(10);
  expect(near.onWord / near.total, `${label}: share of the nearby ink lying on the word (box ${JSON.stringify(near.box && round(near.box))}, word ${JSON.stringify(round(word))})`).toBeGreaterThan(0.9);
  const b = near.box!;
  const span = word.right - word.left >= word.bottom - word.top ? b.right - b.left : b.bottom - b.top;
  expect(span / long, `${label}: the stroke still runs along the word`).toBeGreaterThan(0.5);
}

const round = (b: Box) => ({ l: Math.round(b.left), t: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom) });

/** Pick a writing tool family from the reader's ink toolbar («القلم», «الممحاة», «تحديد النص», …), also from its overflow. */
export async function pickInkTool(page: Page, name: RegExp): Promise<void> {
  const bar = page.getByRole('toolbar', { name: 'أدوات الكتابة' });
  const direct = bar.getByRole('button', { name });
  if (await direct.count()) {
    await direct.first().click();
    return;
  }
  await bar.getByRole('button', { name: 'المزيد من أدوات الكتابة' }).click();
  await page.getByRole('menuitem', { name }).first().click();
}

/** The reader's view menu: «خيارات العرض» (desktop) or «خيارات القراءة» (phone). */
export async function viewMenuItem(page: Page, item: string | RegExp): Promise<void> {
  const trigger = page.getByRole('button', { name: /^(خيارات العرض|خيارات القراءة)$/ }).first();
  await trigger.click();
  await page.getByRole('menuitem', { name: item }).first().click();
}

/** A straight mouse stroke between two client points (pointer type «mouse» — never a pen). */
export async function mouseStroke(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, steps = 12): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps });
  await page.mouse.up();
}
