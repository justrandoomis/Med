// Round 7 H4 item 8 (§46 «فرّق بين PDF مسطح يحفظ المظهر وحبر قابل لإعادة التحرير»): the server writes the ORIGINAL PDF
// with the owner's writing drawn on a copy as vector paths. Before H4 there was no server PDF exporter at all (PDF =
// printing the HTML export, without the ink). Verified by RENDERING the exported file with pdftoppm and checking that
// the ink's colour lands exactly where the shared page geometry (normToView — the function the reader uses) puts it:
//   page 1  plain page whose original content leaves a scaled CTM behind (the writing must not inherit it),
//   page 2  a page with /Rotate 90 (the writing turns with the page, as in the reader),
//   page 3  a crop box smaller than the media box (normalized space is the box the reader shows).
// Writing whose place is uncertain (needs re-anchoring) and text boxes are listed as not drawn — never drawn wrongly.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { concatTransformationMatrix, degrees, PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { normToView, type AnnotatedPdfSummary, type PageViewTransform } from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import { decodePng, encodePng, type RgbaImage } from '../../src/modules/processing/png';
import { createNode, createQuestionsApp, uploadAndProcess, type QApp } from '../questions/helpers';

let t: QApp;
let src: { sourceId: string; versionId: string; pageIds: string[] };
let tmp: string;

async function fixturePdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  // page 1: content that ends with an unbalanced half-scale CTM (no q/Q) — legal, and it must not move the writing
  const p1 = doc.addPage([600, 800]);
  p1.drawText('Annotated export page one (TEST FIXTURE)', { x: 40, y: 760, size: 14, font, color: rgb(0, 0, 0) });
  p1.pushOperators(concatTransformationMatrix(0.5, 0, 0, 0.5, 0, 0));
  // page 2: same box, shown turned 90° clockwise
  const p2 = doc.addPage([600, 800]);
  p2.drawText('Rotated page two (TEST FIXTURE)', { x: 40, y: 760, size: 14, font, color: rgb(0, 0, 0) });
  p2.setRotation(degrees(90));
  // page 3: the reader shows only the crop box
  const p3 = doc.addPage([600, 800]);
  p3.drawText('Cropped page three (TEST FIXTURE)', { x: 70, y: 560, size: 14, font, color: rgb(0, 0, 0) });
  p3.setCropBox(50, 100, 400, 500);
  return Buffer.from(await doc.save());
}

const anchor = (i: number) => ({ type: 'page' as const, source_id: src.sourceId, version_id: src.versionId, page_id: src.pageIds[i]!, page_index: i, space: 'page_norm' as const });
const stroke = (pts: Array<[number, number]>, color: string, width: number, tool: 'pen' | 'highlighter' = 'pen') => ({
  v: 1,
  points: pts.map((p, i) => [p[0], p[1], i * 16, 0.5]),
  style: { tool, color, width },
  bbox: { x: Math.min(...pts.map((p) => p[0])), y: Math.min(...pts.map((p) => p[1])), w: 0.01, h: 0.01 },
  pressure_available: false,
  tilt_available: false,
});

async function push(ops: Array<{ entity_type: string; entity_id: string; op: 'upsert' | 'append'; payload: unknown }>) {
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/sync/push',
    headers: t.h,
    payload: { ops: ops.map((o) => ({ op_id: newId(), device_id: 'PDF_TEST_DEVICE', client_ts: t.ctx.clock.now(), base_rev: null, ...o })) },
  });
  expect(res.statusCode, res.body).toBe(200);
  for (const r of (res.json() as { results: Array<{ result: string }> }).results) expect(r.result, JSON.stringify(r)).toBe('applied');
}

/** render one page (1-based) of a PDF at 72 dpi (1 px = 1 pt), crop box, like the reader */
function render(pdf: Buffer, page: number): RgbaImage {
  const file = join(tmp, `out-${newId()}.pdf`);
  writeFileSync(file, pdf);
  const prefix = join(tmp, `page-${newId()}`);
  execFileSync('pdftoppm', ['-r', '72', '-cropbox', '-png', '-singlefile', '-f', String(page), '-l', String(page), file, prefix]);
  return decodePng(readFileSync(`${prefix}.png`));
}
function px(img: RgbaImage, x: number, y: number): [number, number, number] {
  const i = (Math.round(y) * img.width + Math.round(x)) * 4;
  return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!];
}
/** where a normalized point is drawn on the rendered page — the reader's own geometry */
function at(nx: number, ny: number, view: PageViewTransform): [number, number] {
  return normToView(nx, ny, view);
}
const near = (c: [number, number, number], want: [number, number, number], tol = 40) => c.every((v, i) => Math.abs(v - want[i]!) <= tol);
const WHITE: [number, number, number] = [255, 255, 255];

const IDS = { pen: newId(), hl: newId(), rect: newId(), textHl: newId(), reanchor: newId(), textBox: newId(), image: newId(), rotated: newId(), cropped: newId() };

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'medlevo-pdf-export-'));
  t = await createQuestionsApp();
  const course = await createNode(t, 'PDF export (TEST FIXTURE)', 'course');
  const up = await uploadAndProcess(t, course.id, 'annotated_fixture.pdf', await fixturePdf(), 'lecture', 'Annotated (TEST FIXTURE)');
  const pageIds = t.ctx.db.all<{ id: string }>('SELECT id FROM source_page WHERE version_id = ? ORDER BY page_index', [up.versionId]).map((r) => r.id);
  expect(pageIds).toHaveLength(3);
  src = { ...up, pageIds };

  // a picture the owner placed (solid magenta 4×4 PNG)
  const pic = encodePng({ width: 4, height: 4, data: new Uint8Array(64).map((_, i) => [255, 0, 255, 255][i % 4]!) });
  const file = await t.ctx.files.put(pic, { mime: 'image/png', originalName: 'pasted.png' });
  t.ctx.db.run(`INSERT INTO annotation_image (image_key, file_id, mime, bytes, width, height, referenced, device_id, created_at) VALUES ('IMG_PDF_TEST', ?, 'image/png', ?, 4, 4, 1, 'DEV', ?)`, [
    file.id,
    pic.length,
    t.ctx.clock.now(),
  ]);

  await push([
    { entity_type: 'annotation', entity_id: IDS.pen, op: 'append', payload: { kind: 'ink', tool: 'pen', anchor: anchor(0), data: stroke([[0.2, 0.25], [0.6, 0.25]], 'ink-red', 0.01), layer: 'ink', z: 0 } },
    { entity_type: 'annotation', entity_id: IDS.hl, op: 'append', payload: { kind: 'ink', tool: 'highlighter', anchor: anchor(0), data: stroke([[0.2, 0.5], [0.6, 0.5]], 'hl-yellow', 0.03, 'highlighter'), layer: 'ink', z: 1 } },
    {
      entity_type: 'annotation',
      entity_id: IDS.rect,
      op: 'upsert',
      payload: { kind: 'shape', anchor: anchor(0), data: { v: 1, shape: 'rect', from: [0.1, 0.6], to: [0.3, 0.8], style: { tool: 'pen', color: 'ink-blue', width: 0.006 } }, layer: 'ink', z: 2 },
    },
    {
      entity_type: 'annotation',
      entity_id: IDS.textHl,
      op: 'upsert',
      payload: { kind: 'text_highlight', anchor: anchor(0), data: { v: 1, style: 'highlight', color: 'hl-green', rects: [{ x: 0.6, y: 0.6, w: 0.3, h: 0.05 }], quote: { exact: 'TEST' } }, layer: 'highlight', z: 0 },
    },
    {
      entity_type: 'annotation',
      entity_id: IDS.reanchor,
      op: 'append',
      payload: { kind: 'ink', tool: 'pen', anchor: anchor(0), data: stroke([[0.2, 0.9], [0.6, 0.9]], 'ink-black', 0.01), layer: 'ink', z: 3, anchor_status: 'needs_reanchor' },
    },
    {
      entity_type: 'annotation',
      entity_id: IDS.textBox,
      op: 'upsert',
      payload: { kind: 'text', anchor: anchor(0), data: { v: 1, box: { x: 0.1, y: 0.05, w: 0.3, h: 0.05 }, text: { v: 1, paragraphs: [{ dir: 'rtl', runs: [{ t: 'ملاحظة' }] }] }, color: 'ink-black', font_scale: 1 }, layer: 'text', z: 0 },
    },
    {
      entity_type: 'annotation',
      entity_id: IDS.image,
      op: 'upsert',
      payload: { kind: 'image', anchor: anchor(0), data: { v: 1, image_key: 'IMG_PDF_TEST', box: { x: 0.7, y: 0.05, w: 0.2, h: 0.1 }, mime: 'image/png', natural_w: 4, natural_h: 4, bytes: pic.length }, layer: 'media', z: 0 },
    },
    { entity_type: 'annotation', entity_id: IDS.rotated, op: 'append', payload: { kind: 'ink', tool: 'pen', anchor: anchor(1), data: stroke([[0.2, 0.1], [0.5, 0.1]], 'ink-black', 0.01), layer: 'ink', z: 0 } },
    { entity_type: 'annotation', entity_id: IDS.cropped, op: 'append', payload: { kind: 'ink', tool: 'pen', anchor: anchor(2), data: stroke([[0.3, 0.5], [0.7, 0.5]], 'ink-green', 0.01), layer: 'ink', z: 0 } },
  ]);
}, 240_000);
afterAll(async () => {
  await t?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe('annotated PDF export (flattened, keeps the appearance)', () => {
  let pdf: Buffer;
  let rendered: RgbaImage[];

  it('the summary says what will be drawn and what will not (with the reason), before any file is built', async () => {
    const res = await t.app.inject({ method: 'GET', url: `/api/data/export/source/${src.sourceId}/annotated-pdf/summary`, headers: t.h });
    expect(res.statusCode, res.body).toBe(200);
    const s = res.json() as AnnotatedPdfSummary;
    expect(s).toMatchObject({ source_id: src.sourceId, version_id: src.versionId, available: true, reason_ar: null, pages: 3 });
    expect(s.drawn).toEqual({ strokes: 3, highlighter_strokes: 1, shapes: 1, text_highlights: 1, images: 1, pages_with_writing: 3 });
    expect(s.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'needs_reanchor', count: 1, reason_ar: expect.stringContaining('إعادة ربط') }),
        expect.objectContaining({ kind: 'text', count: 1, reason_ar: expect.stringContaining('تصدير الملاحظات') }),
      ]),
    );
    expect(s.notes_ar.join(' ')).toContain('ليست حبرًا قابلًا لإعادة التحرير');
  });

  it('downloads a copy of the original PDF; the stored original is unchanged', async () => {
    const before = t.ctx.db.get<{ sha256: string }>('SELECT s.sha256 FROM stored_file s JOIN source_version v ON v.file_id = s.id WHERE v.id = ?', [src.versionId])!.sha256;
    const res = await t.app.inject({ method: 'GET', url: `/api/data/export/source/${src.sourceId}/annotated-pdf`, headers: t.h });
    expect(res.statusCode, res.body).toBe(200);
    expect(String(res.headers['content-type'])).toContain('application/pdf');
    expect(decodeURIComponent(String(res.headers['content-disposition']))).toContain('مع كتابتي.pdf');
    pdf = res.rawPayload;
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const doc = await PDFDocument.load(pdf);
    expect(doc.getPageCount()).toBe(3);
    expect(doc.getPage(1).getRotation().angle).toBe(90);
    const after = t.ctx.db.get<{ sha256: string }>('SELECT s.sha256 FROM stored_file s JOIN source_version v ON v.file_id = s.id WHERE v.id = ?', [src.versionId])!.sha256;
    expect(after).toBe(before);
    expect(t.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM change_log WHERE entity_id = ? AND action = 'export'`, [src.sourceId])!.n).toBeGreaterThanOrEqual(1);
    rendered = [render(pdf, 1), render(pdf, 2), render(pdf, 3)];
  });

  it('page 1: pen, highlighter, rectangle, text highlight and picture land where the reader draws them — not under the page’s left-over CTM', () => {
    const img = rendered[0]!;
    const v: PageViewTransform = { pageWidth: 600, pageHeight: 800, scale: 1, rotation: 0 };
    expect([img.width, img.height]).toEqual([600, 800]);
    // red pen stroke across y = 0.25, 6 pt wide
    expect(near(px(img, ...at(0.4, 0.25, v)), [198, 40, 40])).toBe(true);
    expect(near(px(img, ...at(0.4, 0.25 + 0.012, v)), WHITE, 3)).toBe(true);
    // where the half-scale CTM would have put it: nothing there
    expect(near(px(img, 0.4 * 300, 800 - (800 - 0.25 * 800) / 2), WHITE, 3)).toBe(true);
    // highlighter: yellow (multiplied on white = the yellow itself)
    const hl = px(img, ...at(0.4, 0.5, v));
    expect(hl[0]).toBeGreaterThan(220);
    expect(hl[1]).toBeGreaterThan(200);
    expect(hl[2]).toBeLessThan(140);
    // rectangle outline (blue) on its left edge; its inside stays white
    expect(near(px(img, ...at(0.1, 0.7, v)), [35, 70, 200], 60)).toBe(true);
    expect(near(px(img, ...at(0.2, 0.7, v)), WHITE, 3)).toBe(true);
    // text highlight: translucent green fill over white
    const g = px(img, ...at(0.75, 0.625, v));
    expect(g[1]).toBeGreaterThan(g[0]);
    expect(g[1]).toBeGreaterThan(g[2]);
    expect(g[0]).toBeLessThan(250);
    // the picture: magenta inside its box
    expect(near(px(img, ...at(0.8, 0.1, v)), [255, 0, 255], 30)).toBe(true);
    // the writing that needs re-anchoring is NOT drawn
    expect(near(px(img, ...at(0.4, 0.9, v)), WHITE, 3)).toBe(true);
  });

  it('page 2 (/Rotate 90): the stroke turns with the page exactly like normToView', () => {
    const img = rendered[1]!;
    const v: PageViewTransform = { pageWidth: 600, pageHeight: 800, scale: 1, rotation: 90 };
    expect([img.width, img.height]).toEqual([800, 600]);
    for (const nx of [0.25, 0.35, 0.45]) {
      const [x, y] = at(nx, 0.1, v);
      const c = px(img, x, y);
      expect(c.every((ch) => ch < 90), `ink at (${x},${y}) = ${c.join(',')}`).toBe(true);
    }
    // a vertical line on the rotated view: left/right of it is paper
    const [x0, y0] = at(0.35, 0.1, v);
    expect(near(px(img, x0 - 12, y0), WHITE, 3)).toBe(true);
    expect(near(px(img, x0 + 12, y0), WHITE, 3)).toBe(true);
    // where it would be if the rotation were ignored: paper
    expect(near(px(img, 0.35 * 600, 0.1 * 800), WHITE, 3)).toBe(true);
  });

  it('page 3 (crop box ≠ media box): normalized space is the crop box the reader shows', () => {
    const img = rendered[2]!;
    const v: PageViewTransform = { pageWidth: 400, pageHeight: 500, scale: 1, rotation: 0 };
    expect([img.width, img.height]).toEqual([400, 500]);
    expect(near(px(img, ...at(0.5, 0.5, v)), [30, 122, 70], 50)).toBe(true);
    expect(near(px(img, ...at(0.5, 0.5 + 0.02, v)), WHITE, 3)).toBe(true);
  });
});

describe('annotated PDF export: honest refusals', () => {
  it('a source without an original PDF → 409 with the reason (summary says unavailable)', async () => {
    const course = await createNode(t, 'Image course (TEST FIXTURE)', 'course');
    const png = encodePng({ width: 300, height: 200, data: new Uint8Array(300 * 200 * 4).fill(255) });
    const img = await uploadAndProcess(t, course.id, 'scan.png', png, 'lecture', 'Scan (TEST FIXTURE)');
    const s = (await t.app.inject({ method: 'GET', url: `/api/data/export/source/${img.sourceId}/annotated-pdf/summary`, headers: t.h })).json() as AnnotatedPdfSummary;
    expect(s.available).toBe(false);
    expect(s.reason_ar).toContain('لا يوجد ملف PDF');
    const res = await t.app.inject({ method: 'GET', url: `/api/data/export/source/${img.sourceId}/annotated-pdf`, headers: t.h });
    expect(res.statusCode).toBe(409);
    expect(res.body).toContain('لا يوجد ملف PDF');
  });

  it('unknown source → 404; no session → 401', async () => {
    expect((await t.app.inject({ method: 'GET', url: `/api/data/export/source/${newId()}/annotated-pdf`, headers: t.h })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'GET', url: `/api/data/export/source/${src.sourceId}/annotated-pdf` })).statusCode).toBe(401);
  });
});
