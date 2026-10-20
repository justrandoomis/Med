// H2 item 6 — OCR regions carry tesseract's WORD boxes (reading order, normalized to the unrotated page box) in
// `locator.words`, exposed by the regions API, so the reader can place each word over the scanned glyphs instead of one
// fixed-size text run per region (selection and search-hit rectangles landed on the right line but not on the words).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { regionWords, type NormBox, type PageRegionsResponse, type RegionWord } from '@medlevo/shared';
import { fromJson } from '../../src/db/db';
import { rotateImage } from '../../src/modules/processing/image';
import { decodePng, encodePng } from '../../src/modules/processing/png';
import type { AuthHeaders, TestApp } from '../helpers/app';
import { makePdf, renderPng, text } from '../helpers/pdfgen';
import { addSource, createProcessingApp, pages, processVersion, regions, type RegionRow } from './helpers';

let t: TestApp;
let h: AuthHeaders;
let upright: string;
let turned: string;
let mixed: string;

beforeAll(async () => {
  t = await createProcessingApp();
  h = await t.login();
  let content = text(50, 350, 20, 'Peptic ulcer disease', { bold: true });
  ['Helicobacter pylori infection and NSAIDs are the main causes.', 'The urea breath test confirms active infection before therapy.'].forEach(
    (l, i) => (content += text(50, 305 - i * 17, 13, l)),
  );
  const img = decodePng(await renderPng(makePdf([{ content, width: 500, height: 400 }]), 1, 200));
  upright = (await addSource(t, 'scan.png', 'image', { data: encodePng(img), fileName: 'scan.png' })).versionId;
  turned = (await addSource(t, 'turned.png', 'image', { data: encodePng(rotateImage(img, 90)), fileName: 'turned.png' })).versionId;
  mixed = (await addSource(t, 'mixed_scanned_lecture.pdf', 'pdf')).versionId;
  for (const v of [upright, turned, mixed]) await processVersion(t, v);
}, 240_000);
afterAll(async () => t?.close());

const words = (r: RegionRow): RegionWord[] | null => regionWords({ locator: fromJson<Record<string, unknown>>(r.locator_json) });

function expectWordsFollowText(r: RegionRow): RegionWord[] {
  const ws = words(r);
  expect(ws, `words of «${r.text}»`).not.toBeNull();
  // every word is found in the region text, in order (the text layer interleaves them with the gaps)
  let at = 0;
  for (const [w] of ws!) {
    const k = r.text!.indexOf(w, at);
    expect(k, `«${w}» in «${r.text}» after ${at}`).toBeGreaterThanOrEqual(0);
    at = k + w.length;
  }
  expect(ws!.map((w) => w[0]).join(' ')).toBe(r.text);
  // and every word box lies inside its region box
  const b = fromJson<NormBox>(r.bbox_json)!;
  for (const [w, x, y, ww, hh] of ws!) {
    expect(x >= b.x - 0.002 && y >= b.y - 0.002 && x + ww <= b.x + b.w + 0.002 && y + hh <= b.y + b.h + 0.002, `${w} inside`).toBe(true);
  }
  return ws!;
}

describe('OCR word boxes for the text layer (H2 item 6)', () => {
  it('a scanned picture: each OCR region lists its words in reading order with boxes inside the region', () => {
    const para = regions(t, upright).find((r) => r.text?.includes('urea breath test'))!;
    const ws = expectWordsFollowText(para);
    // words of one line share a baseline band and run left → right; a word box is a word, not the whole line
    const [a, b] = [ws[0]!, ws[1]!];
    expect(a[0]).toBe('Helicobacter');
    expect(b[1]).toBeGreaterThan(a[1] + a[3] - 0.001);
    expect(Math.abs(a[2] - b[2])).toBeLessThan(0.02);
    expect(a[3]).toBeLessThan(0.3 * fromJson<NormBox>(para.bbox_json)!.w);
  });

  it('a photo read after turning it: word boxes are in the stored photo (tall narrow boxes), still in reading order', () => {
    const para = regions(t, turned).find((r) => r.text?.includes('urea breath test'))!;
    const ws = expectWordsFollowText(para);
    const first = ws.find((w) => w[0] === 'Helicobacter')!;
    expect(first[4]).toBeGreaterThan(first[3]); // the 90° picture: the word runs downwards
  });

  it('a scanned page inside a PDF: its OCR regions carry words; digital regions do not', () => {
    const p = pages(t, mixed).find((x) => x.text_status === 'ocr')!;
    const ocr = regions(t, mixed, p.page_index).filter((r) => r.text_origin === 'ocr' && r.kind !== 'diagram' && r.text);
    expect(ocr.length).toBeGreaterThan(0);
    for (const r of ocr) expectWordsFollowText(r);
    const digital = regions(t, mixed).filter((r) => r.text_origin === 'digital');
    expect(digital.length).toBeGreaterThan(0);
    expect(digital.every((r) => words(r) === null)).toBe(true);
  });

  it('exposed to the web through the regions API (locator.words)', async () => {
    const pageId = pages(t, upright)[0]!.id;
    const res = await t.app.inject({ method: 'GET', url: `/api/sources/pages/${pageId}/regions`, headers: h });
    expect(res.statusCode).toBe(200);
    const body = res.json() as PageRegionsResponse;
    const para = body.regions.find((r) => r.text?.includes('urea breath test'))!;
    expect(regionWords(para)?.map((w) => w[0])).toEqual(para.text!.split(' '));
  });
});
