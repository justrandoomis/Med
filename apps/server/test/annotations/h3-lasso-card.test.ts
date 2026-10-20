// Round 7 — H3 item 4 (§28/§29 «حوّل المحدد إلى بطاقة»): from a lasso selection on a source page, «بطاقة إخفاء في صورة»
// needs a PICTURE of the page area under the selection that an image-occlusion card can be made from. There was none:
// image-occlusion cards could only use the figures processing extracted. POST /api/annotations/page-crops now cuts the
// area out of the stored source file (server-side, so the picture IS the source page — never the owner's ink, never a
// client-sent picture), keeps it as a picture of that source, and the existing occlusion endpoint accepts it.
// Written to FAIL before the endpoint existed (404 route).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, type CardCreateResponse, type PageCropResponse } from '@medlevo/shared';
import type { AppError } from '../../src/lib/errors';
import { createPageCrop, CROP_NO_RENDERER_AR, CROP_TOO_SMALL_AR } from '../../src/modules/annotations/pageCrop';
import { cardMediaFile } from '../../src/modules/learning/review';
import { decodePng, encodePng, type RgbaImage } from '../../src/modules/processing/png';
import { paint, solid } from '../helpers/images';
import { makePdf, rect, renderPng, text } from '../helpers/pdfgen';
import { createNode, createQuestionsApp, uploadAndProcess, type QApp } from '../questions/helpers';

let t: QApp;
let pdfPage: { id: string; versionId: string; sourceId: string };
let rotatedPage: { id: string; pdf: Buffer };
let imagePage: { id: string };

// a 600 × 800 pt page with a black square at x 100–300, y (from the top) 100–300 → normalized (1/6, 1/8, 1/3, 1/4)
const SQUARE = { x: 100 / 600, y: 100 / 800, w: 200 / 600, h: 200 / 800 };
const inset = (b: { x: number; y: number; w: number; h: number }, k = 0.1) => ({ x: b.x + b.w * k, y: b.y + b.h * k, w: b.w * (1 - 2 * k), h: b.h * (1 - 2 * k) });
const body = 'The appendix lies in the right iliac fossa. McBurney point tenderness is a classic sign of acute appendicitis.';

function darkShare(img: RgbaImage): number {
  let dark = 0;
  for (let i = 0; i < img.data.length; i += 4) if (img.data[i]! < 80 && img.data[i + 1]! < 80 && img.data[i + 2]! < 80) dark++;
  return dark / (img.width * img.height);
}
/** normalized bounding box of the solid dark area of a full-page render (thin text strokes do not count) */
function darkBox(img: RgbaImage) {
  const dark = (x: number, y: number) => {
    const i = (y * img.width + x) * 4;
    return x < img.width && y < img.height && img.data[i]! < 40 && img.data[i + 1]! < 40 && img.data[i + 2]! < 40;
  };
  let x0 = img.width, y0 = img.height, x1 = -1, y1 = -1;
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++) {
      if (dark(x, y) && dark(x + 8, y) && dark(x, y + 8) && dark(x + 8, y + 8) && dark(x + 4, y + 4)) {
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + 8); y1 = Math.max(y1, y + 8);
      }
    }
  return { x: x0 / img.width, y: y0 / img.height, w: (x1 - x0 + 1) / img.width, h: (y1 - y0 + 1) / img.height };
}

const post = (url: string, payload: unknown) => t.app.inject({ method: 'POST', url, headers: t.h, payload: payload as never });
async function crop(pageId: string, bbox: { x: number; y: number; w: number; h: number }, id = newId()) {
  return post('/api/annotations/page-crops', { id, page_id: pageId, bbox });
}
async function picture(res: PageCropResponse): Promise<RgbaImage> {
  const file = await t.app.inject({ method: 'GET', url: res.crop.url, headers: t.h });
  expect(file.statusCode).toBe(200);
  return decodePng(file.rawPayload);
}
const pageOf = (versionId: string) => t.ctx.db.get<{ id: string }>('SELECT id FROM source_page WHERE version_id = ? AND page_index = 0', [versionId])!.id;

beforeAll(async () => {
  t = await createQuestionsApp();
  const node = await createNode(t, 'الجراحة');
  const content = text(72, 760, 12, 'Acute appendicitis') + text(72, 60, 10, body) + rect(100, 500, 200, 200, 'f');
  const pdf = makePdf([{ width: 600, height: 800, content }]);
  const a = await uploadAndProcess(t, node.id, 'square.pdf', pdf, 'lecture', 'Square lecture');
  pdfPage = { id: pageOf(a.versionId), versionId: a.versionId, sourceId: a.sourceId };
  const rotated = makePdf([{ width: 600, height: 800, rotate: 90, content }]);
  const b = await uploadAndProcess(t, node.id, 'rotated.pdf', rotated, 'lecture', 'Rotated lecture');
  rotatedPage = { id: pageOf(b.versionId), pdf: rotated };
  const scan = encodePng(paint(solid(400, 300, [255, 255, 255]), 200, 150, 300, 250, [0, 0, 0]));
  const c = await uploadAndProcess(t, node.id, 'scan.png', scan, 'lecture', 'Scanned figure');
  imagePage = { id: pageOf(c.versionId) };
}, 120_000);
afterAll(async () => {
  await t.close();
});

describe('H3 item 4 — a lasso selection becomes a picture for an image-occlusion card', () => {
  it('cuts the page area under the selection out of the source PDF: the square, not its surroundings', async () => {
    const res = await crop(pdfPage.id, inset(SQUARE));
    expect(res.statusCode).toBe(200);
    const out = res.json() as PageCropResponse;
    expect(out.created).toBe(true);
    expect(out.crop).toMatchObject({ source_id: pdfPage.sourceId, version_id: pdfPage.versionId, page_id: pdfPage.id, page_index: 0 });
    const img = await picture(out);
    expect(img.width).toBe(out.crop.width);
    expect(Math.abs(img.width / img.height - 1)).toBeLessThan(0.05); // the square stays square
    expect(Math.max(img.width, img.height)).toBeGreaterThan(600); // enough resolution to draw masks on
    expect(darkShare(img)).toBeGreaterThan(0.95);
    // a blank area of the same page is blank
    const blank = await picture((await crop(pdfPage.id, { x: 0.6, y: 0.2, w: 0.3, h: 0.2 })).json() as PageCropResponse);
    expect(darkShare(blank)).toBeLessThan(0.01);
  });

  it('the image-occlusion card is made from it (origin owner) and its picture is the crop', async () => {
    const out = (await crop(pdfPage.id, SQUARE)).json() as PageCropResponse;
    const res = await post('/api/learning/cards/occlusion', { image_asset_id: out.crop.image_asset_id, masks: [{ id: 'm1', box: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, label: 'المربع' }] });
    expect(res.statusCode).toBe(200);
    const card = (res.json() as CardCreateResponse).cards[0]!;
    expect(card).toMatchObject({ kind: 'image_occlusion', origin: 'owner' });
    expect(cardMediaFile(t.ctx, card.id)).toBe(out.crop.file_id);
    const review = await t.app.inject({ method: 'GET', url: `/api/learning/cards/${card.id}/review`, headers: t.h });
    expect(review.statusCode, review.body).toBe(200);
  });

  it('the same request again returns the same picture (a retried call makes no second one)', async () => {
    const id = newId();
    const first = (await crop(pdfPage.id, SQUARE, id)).json() as PageCropResponse;
    const n = t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM image_asset')!.n;
    const again = (await crop(pdfPage.id, SQUARE, id)).json() as PageCropResponse;
    expect(again.created).toBe(false);
    expect(again.crop.file_id).toBe(first.crop.file_id);
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM image_asset')!.n).toBe(n);
    // the decision is in the audit log
    expect(t.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM change_log WHERE entity_id = ? AND action = 'page_crop'", [id])!.n).toBe(1);
  });

  it('a /Rotate 90 page: the box is in the page as the reader keeps it (unrotated) and the picture is cut where the page shows it', async () => {
    // poppler shows the page turned 90° clockwise: the square of the unrotated page sits at (1 − y − h, x, h, w)
    const full = decodePng(await renderPng(rotatedPage.pdf, 1, 72));
    const where = darkBox(full);
    const expected = { x: 1 - SQUARE.y - SQUARE.h, y: SQUARE.x, w: SQUARE.h, h: SQUARE.w };
    for (const k of ['x', 'y', 'w', 'h'] as const) expect(Math.abs(where[k] - expected[k])).toBeLessThan(0.01);
    const img = await picture((await crop(rotatedPage.id, inset(SQUARE))).json() as PageCropResponse);
    expect(darkShare(img)).toBeGreaterThan(0.95);
    const blank = await picture((await crop(rotatedPage.id, { x: 0.6, y: 0.2, w: 0.3, h: 0.2 })).json() as PageCropResponse);
    expect(darkShare(blank)).toBeLessThan(0.01);
  });

  it('an image source is cut from its stored picture', async () => {
    const img = await picture((await crop(imagePage.id, inset({ x: 0.5, y: 0.5, w: 0.25, h: 1 / 3 }))).json() as PageCropResponse);
    expect(darkShare(img)).toBeGreaterThan(0.95);
    expect(Math.abs(img.width / img.height - 1)).toBeLessThan(0.05); // 100 × 100 px of a 400 × 300 picture
  });

  it('re-processing the page keeps the crop (the card would lose its picture); the image explorer does not list it as a figure', async () => {
    const out = (await crop(pdfPage.id, SQUARE)).json() as PageCropResponse;
    const re = await post(`/api/sources/versions/${pdfPage.versionId}/reprocess`, { page_indexes: [0] });
    expect(re.statusCode, re.body).toBe(200);
    await t.ctx.jobs.drain();
    expect(t.ctx.db.get('SELECT id FROM image_asset WHERE id = ?', [out.crop.image_asset_id])).toBeTruthy();
    const list = await t.app.inject({ method: 'GET', url: '/api/media/images?limit=200', headers: t.h });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.body).not.toContain(out.crop.image_asset_id);
  });

  it('honest refusals: no renderer installed, a tiny selection, an unknown page, no session', async () => {
    const id = newId();
    await expect(createPageCrop(t.ctx, { id, page_id: pdfPage.id, bbox: SQUARE }, { pdftoppm: null })).rejects.toMatchObject({ code: 'FEATURE_DISABLED', messageAr: CROP_NO_RENDERER_AR } satisfies Partial<AppError>);
    expect(t.ctx.db.get('SELECT id FROM image_asset WHERE id = ?', [id])).toBeUndefined();
    const tiny = await crop(pdfPage.id, { x: 0.5, y: 0.5, w: 0.004, h: 0.3 });
    expect(tiny.statusCode).toBe(400);
    expect(tiny.json().error.message).toBe(CROP_TOO_SMALL_AR);
    expect((await crop('NOPAGE', SQUARE)).statusCode).toBe(404);
    const anon = await t.app.inject({ method: 'POST', url: '/api/annotations/page-crops', headers: { 'x-medlevo-csrf': '1' }, payload: { id: newId(), page_id: pdfPage.id, bbox: SQUARE } });
    expect(anon.statusCode).toBe(401);
  });
});
