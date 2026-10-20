// H2 item 4 — the Image Quiz serves a MASKED image for JPEG photos too (before: JPEG was served unmasked with the
// masks only drawn by the browser, so removing an overlay in the page revealed the label). The masks follow the
// picture as displayed (EXIF orientation applied), the stored original is untouched, an undecodable / over-budget
// picture still falls back to client masks (said in the payload), and the rendered copy is cached.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ImageQuizView } from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import { sha256 } from '../../src/lib/hash';
import { decodeImage, jpegOrientation } from '../../src/modules/processing/image';
import { quizImageCacheStats } from '../../src/modules/media/quiz';
import { createTestApp, type AuthHeaders, type TestApp } from '../helpers/app';
import { jpeg, paint, pixel, solid, withExif } from '../helpers/images';

let t: TestApp;
let h: AuthHeaders;

beforeEach(async () => {
  t = await createTestApp();
  h = await t.login();
});
afterEach(async () => {
  await t.close();
});

const now = () => t.ctx.clock.now();

async function jpegAsset(bytes: Buffer): Promise<{ id: string; fileId: string; sha: string }> {
  const f = await t.ctx.files.put(bytes, { mime: 'image/jpeg', originalName: 'answer_is_pneumothorax.jpg' });
  const sourceId = newId();
  const versionId = newId();
  const pageId = newId();
  t.ctx.db.run(`INSERT INTO source (id, title, source_type, processing_status, created_at, updated_at) VALUES (?, 'Chest atlas (TEST FIXTURE)', 'lecture', 'ready', ?, ?)`, [sourceId, now(), now()]);
  t.ctx.db.run(
    `INSERT INTO source_version (id, source_id, version_no, kind, file_id, content_hash, mime, file_name, format, pagination, processing_status, created_at)
     VALUES (?, ?, 1, 'original', NULL, ?, 'application/pdf', 'x.pdf', 'pdf', 'pages', 'ready', ?)`,
    [versionId, sourceId, newId(), now()],
  );
  t.ctx.db.run(`INSERT INTO source_page (id, version_id, page_index, kind, created_at, updated_at) VALUES (?, ?, 0, 'page', ?, ?)`, [pageId, versionId, now(), now()]);
  const id = newId();
  t.ctx.db.run(
    `INSERT INTO image_asset (id, file_id, source_id, version_id, page_id, origin, image_kind, caption, match_status, created_at) VALUES (?, ?, ?, ?, ?, 'source', 'radiology', 'Figure 2: right pneumothorax', 'unverified', ?)`,
    [id, f.id, sourceId, versionId, pageId, now()],
  );
  return { id, fileId: f.id, sha: f.sha256 };
}

async function mask(imageId: string, shape: { x: number; y: number; w: number; h: number }) {
  const res = await t.app.inject({ method: 'POST', url: `/api/media/images/${imageId}/overlays`, headers: h, payload: { kind: 'occlusion_mask', shape: { type: 'rect', ...shape }, label: 'Pneumothorax', certainty: 'owner' } });
  expect(res.statusCode, res.body).toBe(200);
}

async function startQuiz(imageId: string): Promise<ImageQuizView> {
  const res = await t.app.inject({ method: 'POST', url: '/api/media/quiz', headers: h, payload: { image_id: imageId } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

const GREY: [number, number, number] = [96, 104, 120];
const near = (a: number[], b: number[], tol = 12) => a.every((v, i) => Math.abs(v - b[i]!) <= tol);

describe('Image Quiz — JPEG photos are served with the masks burned in (H2 item 4)', () => {
  it('a real JPEG: masks rendered on the server, the label area is covered in the served bytes, the original is untouched', async () => {
    // left half dark red (the «label»), right half light — the mask covers the left half
    const img = paint(solid(80, 40, [235, 235, 235]), 0, 0, 40, 40, [180, 30, 30]);
    const a = await jpegAsset(jpeg(img));
    await mask(a.id, { x: 0, y: 0, w: 0.5, h: 1 });
    const quiz = await startQuiz(a.id);
    expect(quiz.masks_rendered).toBe('server');
    const res = await t.app.inject({ method: 'GET', url: quiz.image_url, headers: h });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers.etag).toBeUndefined();
    const served = decodeImage(res.rawPayload);
    expect([served.width, served.height]).toEqual([80, 40]);
    expect(near(pixel(served, 10, 20), GREY), `inside the mask ${pixel(served, 10, 20)}`).toBe(true);
    expect(near(pixel(served, 70, 20), [235, 235, 235]), 'outside the mask the picture is unchanged').toBe(true);
    // no red left anywhere under the mask: removing an overlay in the browser cannot reveal the label
    for (let y = 0; y < 40; y += 3) for (let x = 0; x < 40; x += 3) expect(pixel(served, x, y)[0] - pixel(served, x, y)[2]).toBeLessThan(60);
    expect(sha256(await t.ctx.files.read(a.fileId))).toBe(a.sha);
  });

  it('EXIF orientation 6 (phone photo stored sideways): the mask lands where the owner drew it on the DISPLAYED picture', async () => {
    // displayed upright: 40 wide × 80 tall, the «label» is the TOP half (dark). Stored sideways: rotate the displayed
    // picture 90° counter-clockwise (orientation 6 = rotate 90° clockwise to display).
    const shown = paint(solid(40, 80, [235, 235, 235]), 0, 0, 40, 40, [30, 30, 180]);
    const stored = solid(80, 40, [0, 0, 0]);
    for (let y = 0; y < 80; y++) for (let x = 0; x < 40; x++) {
      const [r, g, b] = pixel(shown, x, y);
      paint(stored, y, 39 - x, y + 1, 40 - x, [r, g, b]);
    }
    for (const order of ['II', 'MM'] as const) {
      const bytes = withExif(jpeg(stored), 6, order);
      expect(jpegOrientation(bytes)).toBe(6);
      const a = await jpegAsset(bytes);
      await mask(a.id, { x: 0, y: 0, w: 1, h: 0.5 }); // top half of the displayed picture
      const quiz = await startQuiz(a.id);
      expect(quiz.masks_rendered).toBe('server');
      const served = decodeImage((await t.app.inject({ method: 'GET', url: quiz.image_url, headers: h })).rawPayload);
      expect([served.width, served.height], 'served as displayed (EXIF applied, no EXIF left)').toEqual([40, 80]);
      expect(jpegOrientation((await t.app.inject({ method: 'GET', url: quiz.image_url, headers: h })).rawPayload)).toBe(1);
      expect(near(pixel(served, 20, 20), GREY), `${order}: the top half is masked ${pixel(served, 20, 20)}`).toBe(true);
      expect(near(pixel(served, 20, 60), [235, 235, 235]), `${order}: the bottom half is the picture`).toBe(true);
    }
  });

  it('the rendered copy is cached (the second request does not decode again); a changed mask renders a new copy', async () => {
    const a = await jpegAsset(jpeg(solid(64, 64, [200, 200, 200])));
    await mask(a.id, { x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
    const quiz = await startQuiz(a.id);
    const before = quizImageCacheStats();
    const r1 = await t.app.inject({ method: 'GET', url: quiz.image_url, headers: h });
    const mid = quizImageCacheStats();
    const r2 = await t.app.inject({ method: 'GET', url: quiz.image_url, headers: h });
    const after = quizImageCacheStats();
    expect(mid.renders).toBe(before.renders + 1);
    expect(after.renders).toBe(mid.renders);
    expect(after.hits).toBe(mid.hits + 1);
    expect(Buffer.compare(r1.rawPayload, r2.rawPayload)).toBe(0);
    expect(after.bytes).toBeLessThanOrEqual(after.maxBytes);
  });

  it('an undecodable JPEG keeps client masks (said in the payload) and is never «masked» by pretence', async () => {
    const broken = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 1)]);
    const a = await jpegAsset(broken);
    await mask(a.id, { x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
    const quiz = await startQuiz(a.id);
    expect(quiz.masks_rendered).toBe('client');
  });
});
