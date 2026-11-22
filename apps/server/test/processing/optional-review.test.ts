// «يحتاج مراجعة» is not an error (owner report 2026-11): picture slides are READY «صورة» pages; uncertain OCR is re-read
// by the routine vision model (only with a key + a standing ai_processing consent + budget) and accepted when the two
// readings agree; what is left is an OPTIONAL review the owner accepts in one tap («اعتمد كما هو» / «اعتمد الكل»).
// Scripted provider only (TEST-ONLY, never registered in production). No poppler needed.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SourcePagesResponse } from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import type { ProviderRequest } from '../../src/modules/ai/types';
import { agreement, consistent, enqueueOcrVerifyFollowUp } from '../../src/modules/processing/ocr-verify';
import type { LayoutRegion } from '../../src/modules/processing/layout/types';
import { finalizeRegions } from '../../src/modules/processing/pipeline';
import { busyShare, classifyPicturePage, keepOnPicture, pictureCoverage } from '../../src/modules/processing/picture';
import { decodePng, encodePng, type RgbaImage } from '../../src/modules/processing/png';
import { computeSummary } from '../../src/modules/processing/summary';
import { grantAiConsent } from '../helpers/consent';
import { createTestApp } from '../helpers/app';
import { solid } from '../helpers/images';
import { ScriptedAi } from '../exams/helpers';
import { api, createNode, type QApp } from '../questions/helpers';
import { addSource, FIXTURES, processVersion } from './helpers';

/**
 * A "pathology slide": the caption of a real fixture slide («01 Epithelium») in the middle of a stained-tissue texture
 * (purple nuclei-like strokes on pink, deterministic) — the texture is what OCR / the coverage check mistake for writing.
 */
function tissueSlide(): RgbaImage {
  const img = decodePng(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'histology_slide_01.png')));
  const { width: w, height: h } = img;
  let seed = 11;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const caption = { x0: 160, y0: 150, x1: 450, y1: 260 };
  const set = (x: number, y: number, c: [number, number, number]) => {
    if (x < 0 || y < 0 || x >= w || y >= h || (x >= caption.x0 && x < caption.x1 && y >= caption.y0 && y < caption.y1)) return;
    img.data.set([...c, 255], (y * w + x) * 4);
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) set(x, y, [236, 190, 214]);
  for (let row = 8; row < h - 24; row += 22) {
    let x = 4 + Math.floor(rnd() * 12);
    while (x < w - 12) {
      const n = 2 + Math.floor(rnd() * 5);
      for (let k = 0; k < n; k++) {
        const hh = 8 + Math.floor(rnd() * 9);
        const ww = 2 + Math.floor(rnd() * 4);
        for (let yy = 0; yy < hh; yy++) for (let xx = 0; xx < ww; xx++) set(x + xx, row + 18 - hh + yy, [90, 40, 120]);
        x += ww + 3 + Math.floor(rnd() * 3);
      }
      x += 10 + Math.floor(rnd() * 18);
    }
  }
  return img;
}

/** An H&E-like texture without any writing (for the raster measure). */
function tissue(w = 360, h = 270): RgbaImage {
  const img = solid(w, h, [236, 190, 214]);
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let y = 0; y < h; y += 5) {
    for (let x = 0; x < w; x += 5) {
      const v = rnd();
      const c: [number, number, number] = v < 0.35 ? [120, 60, 150] : v < 0.7 ? [205, 120, 170] : [245, 215, 230];
      for (let dy = 0; dy < 5 && y + dy < h; dy++) for (let dx = 0; dx < 5 && x + dx < w; dx++) img.data.set([...c, 255], ((y + dy) * w + x + dx) * 4);
    }
  }
  return img;
}

class LeavingAi extends ScriptedAi {
  readonly dataLeavesDeployment = true;
}

const words = (spec: Array<[string, number]>) => spec.map(([text, conf]) => ({ text, conf }));

describe('picture pages («صورة»): classification', () => {
  it('a pathology photo with a short caption is a picture page; texture words are dropped', () => {
    const w = words([
      ['Cirrhosis', 91],
      ['(H&E)', 88],
      ['|', 12],
      ['~i', 21],
      ["l'", 18],
      ['ww', 33],
    ]);
    expect(classifyPicturePage({ coverage: 0.7, words: w, digitalChars: 0 }).picture).toBe(true);
    expect(w.filter(keepOnPicture).map((x) => x.text)).toEqual(['Cirrhosis', '(H&E)']);
    expect(keepOnPicture({ text: 'Cirrhosis', conf: 52 })).toBe(false); // weak: not stored on a picture page
  });

  it('a page with real text is never a picture page — not even a blurred scan read with weak confidence', () => {
    const sentence = 'The appendix is inflamed with neutrophils infiltrating the muscularis propria and serosa; the lumen holds a faecolith'.split(' ');
    expect(classifyPicturePage({ coverage: 1, words: sentence.map((t) => ({ text: t, conf: 92 })), digitalChars: 0 }).picture).toBe(false);
    expect(classifyPicturePage({ coverage: 1, words: [...sentence, ...sentence].map((t) => ({ text: t, conf: 48 })), digitalChars: 0 }).picture).toBe(false);
    // a small picture on a page: not a picture page
    expect(classifyPicturePage({ coverage: 0.1, words: [], digitalChars: 0 }).picture).toBe(false);
  });

  it('picture content is measured on the raster: a tissue photo is busy, a blurred TEXT scan is mostly paper', () => {
    expect(busyShare(tissue())).toBeGreaterThan(0.5);
    expect(busyShare(decodePng(readFileSync(join(FIXTURES, 'low_quality_scan.png'))))).toBeLessThan(0.3);
  });

  it('coverage counts overlapping pictures once', () => {
    const g = { width: 100, height: 100 };
    expect(pictureCoverage([{ x0: 0, top: 0, x1: 50, bottom: 100 }], g)).toBeCloseTo(0.5, 1);
    expect(pictureCoverage([{ x0: 0, top: 0, x1: 50, bottom: 100 }, { x0: 0, top: 0, x1: 50, bottom: 100 }], g)).toBeCloseTo(0.5, 1);
  });

  it('on a picture page weak OCR is an uncertain reading (no review item); elsewhere it stays an honest review item', () => {
    const mk = (): LayoutRegion[] => [{ key: 'r1', kind: 'text_block', box: null, text: 'Hepatocyte balloning', textOrigin: 'ocr', minWordConf: 41, lowConfWords: ['balloning'] } as LayoutRegion];
    const pic = mk();
    expect(finalizeRegions(pic, false, { picture: true })).toEqual([]);
    expect(pic[0]!.status).toBe('uncertain');
    const page = mk();
    const items = finalizeRegions(page, false);
    expect(page[0]!.status).toBe('needs_review');
    expect(items).toHaveLength(1);
  });
});

describe('second reading: deterministic agreement', () => {
  it('agrees on the same words (normalised), not on a different reading; weak words must be confirmed', () => {
    expect(agreement('Hepatocellular carcinoma, trabecular pattern', 'hepatocellular carcinoma trabecular pattern')).toBe(1);
    expect(consistent('Glomerulonephritis crescent formaton', 'Rapidly progressive glomerulonephritis with crescent formation').ok).toBe(false);
    expect(consistent('الالتهاب الحاد في الزائدة', 'الالتهاب الحاد في الزائدة', ['الزائدة']).ok).toBe(true);
    expect(consistent('a b c d e f g h i j', 'a b c d e f g h i j', ['k']).ok).toBe(false);
  });
});

// ───────── end to end: auto-resolution, no consent, «اعتمد الكل» ─────────
const ai = new LeavingAi();
let t: QApp;

const TEXT = {
  confirm: 'Hepatocellular carcinoma with trabecular pattern',
  conflict: 'Glomerulonephritis crescent formaton',
  page: 'Liver biopsy stained with Masson trichrome',
};

async function insertLecture(courseId: string) {
  const { ctx } = t;
  const now = ctx.clock.now();
  const sourceId = newId(now);
  const versionId = newId(now);
  const pageIds = [newId(now), newId(now), newId(now)];
  const regionIds = [newId(now), newId(now), newId(now)];
  const renders = await Promise.all([0, 1, 2].map((i) => ctx.files.put(encodePng(solid(40, 30, [200 - i * 40, 120, 160])), { mime: 'image/png', originalName: `page-${i + 1}.png` })));
  ctx.db.tx(() => {
    ctx.db.run(
      `INSERT INTO source (id, title, source_type, node_id, course_node_id, processing_status, sort_order, created_at, updated_at) VALUES (?, ?, 'lecture', ?, ?, 'needs_review', ?, ?, ?)`,
      [sourceId, 'Liver pathology (TEST FIXTURE)', courseId, courseId, now, now, now],
    );
    ctx.db.run(
      `INSERT INTO source_version (id, source_id, version_no, kind, content_hash, mime, file_name, format, page_count, processing_status, created_at)
       VALUES (?, ?, 1, 'original', ?, 'application/pdf', 'liver.pdf', 'pdf', 3, 'needs_review', ?)`,
      [versionId, sourceId, newId(now), now],
    );
    ctx.db.run('UPDATE source SET current_version_id = ? WHERE id = ?', [versionId, sourceId]);
    pageIds.forEach((id, i) =>
      ctx.db.run(
        `INSERT INTO source_page (id, version_id, page_index, kind, text_status, processing_status, render_file_id, error_code, error_detail, created_at, updated_at)
         VALUES (?, ?, ?, 'slide', 'ocr', 'needs_review', ?, ?, ?, ?, ?)`,
        [id, versionId, i, renders[i]!.id, i === 2 ? 'TEXT_NOT_READ' : null, i === 2 ? 'في الصورة كتابة لم يقرأها التعرف الضوئي.' : null, now, now],
      ),
    );
    [TEXT.confirm, TEXT.conflict, TEXT.page].forEach((text, i) =>
      ctx.db.run(
        `INSERT INTO source_region (id, version_id, page_id, kind, reading_order, text, text_origin, status, created_at, updated_at)
         VALUES (?, ?, ?, 'paragraph', 0, ?, 'ocr', ?, ?, ?)`,
        [regionIds[i], versionId, pageIds[i], text, i === 2 ? 'extracted' : 'needs_review', now, now],
      ),
    );
    const item = (entityType: string, entityId: string, i: number, details: object) =>
      ctx.db.run(
        `INSERT INTO review_queue_item (id, kind, entity_type, entity_id, source_id, reason, details_json, status, created_at) VALUES (?, 'ocr_error', ?, ?, ?, 'ثقة التعرف الضوئي منخفضة', ?, 'open', ?)`,
        [newId(now), entityType, entityId, sourceId, JSON.stringify({ origin: 'processing', version_id: versionId, page_id: pageIds[i], page_index: i, ...details }), now + i],
      );
    item('source_region', regionIds[0]!, 0, { low_confidence_words: ['trabecular'] });
    item('source_region', regionIds[1]!, 1, { low_confidence_words: ['formaton'] });
    item('source_page', pageIds[2]!, 2, { code: 'TEXT_NOT_READ' });
  });
  return { sourceId, versionId, pageIds, regionIds };
}

const verifyOutput = (req: ProviderRequest) => {
  const passage = (text: string, read: string) => (req.prompt.includes(text) ? [{ id: 'p1', text: read, legible: true }] : []);
  return {
    legible: true,
    passages: [...passage(TEXT.confirm, 'Hepatocellular carcinoma with trabecular pattern'), ...passage(TEXT.conflict, 'Rapidly progressive glomerulonephritis with crescent formation')],
    page_text: req.prompt.includes('Also return page_text') ? 'Liver biopsy stained with Masson trichrome' : null,
  };
};

const itemStatus = (entityId: string) => t.ctx.db.get<{ status: string; resolution_json: string | null; details_json: string }>('SELECT status, resolution_json, details_json FROM review_queue_item WHERE entity_id = ?', [entityId])!;

beforeAll(async () => {
  const app = await createTestApp({ ai, jobs: { backoffBaseMs: 0, backoffMaxMs: 0 } });
  const h = await app.login();
  t = Object.assign(app, { h }) as QApp;
}, 120_000);

afterAll(async () => {
  await t?.close();
});

describe('optional review end to end', () => {
  it('without the owner’s consent nothing is sent; the pages are listed with an optional review count', async () => {
    const course = (await createNode(t, 'Pathology (TEST) A')).id;
    const l = await insertLecture(course);
    ai.on('describe_figure', verifyOutput);
    expect(enqueueOcrVerifyFollowUp(t.ctx, l.versionId, 'process-job-x')).toBe(false);
    expect(ai.calls).toHaveLength(0);
    const res = await api(t).get(`/api/sources/${l.sourceId}/versions/${l.versionId}/pages`);
    expect(res.statusCode).toBe(200);
    const pages = (res.json() as SourcePagesResponse).pages;
    expect(pages.map((p) => p.optional_review)).toEqual([1, 1, 1]);
    expect(computeSummary(t.ctx, l.versionId, 'done', null).summary.stage_label_ar).toContain('مراجعة اختيارية');
  });

  it('«اعتمد كما هو» for one page, then «اعتمد الكل»: every page ready, the version ready', async () => {
    const course = (await createNode(t, 'Pathology (TEST) B')).id;
    const l = await insertLecture(course);
    const one = await api(t).post('/api/control/review/processing/accept', { version_id: l.versionId, page_id: l.pageIds[0] });
    expect(one.statusCode).toBe(200);
    expect(one.json()).toMatchObject({ accepted: 1, open_left: 2 });
    expect(t.ctx.db.get<{ s: string }>('SELECT processing_status AS s FROM source_page WHERE id = ?', [l.pageIds[0]])!.s).toBe('ready');
    const all = await api(t).post('/api/control/review/processing/accept', { version_id: l.versionId });
    expect(all.statusCode).toBe(200);
    expect(all.json()).toMatchObject({ accepted: 2, skipped: 0, open_left: 0 });
    const statuses = t.ctx.db.all<{ s: string }>('SELECT processing_status AS s FROM source_page WHERE version_id = ? ORDER BY page_index', [l.versionId]).map((r) => r.s);
    expect(statuses).toEqual(['ready', 'ready', 'ready']);
    expect(t.ctx.db.get<{ s: string }>('SELECT processing_status AS s FROM source_version WHERE id = ?', [l.versionId])!.s).toBe('ready');
    // the text never changed
    expect(t.ctx.db.get<{ text: string }>('SELECT text FROM source_region WHERE id = ?', [l.regionIds[1]])!.text).toBe(TEXT.conflict);
  });

  it('with a standing consent: consistent readings are accepted automatically, a real conflict stays (with the second reading)', async () => {
    grantAiConsent(t, 'scripted-test');
    const course = (await createNode(t, 'Pathology (TEST) C')).id;
    const l = await insertLecture(course);
    const before = ai.callsFor('describe_figure').length;
    expect(enqueueOcrVerifyFollowUp(t.ctx, l.versionId, 'process-job-1')).toBe(true);
    await t.ctx.jobs.drain();
    const calls = ai.callsFor('describe_figure').slice(before);
    expect(calls).toHaveLength(3); // one per page with doubts
    for (const c of calls) expect(c.images).toHaveLength(1);

    // confirmed: region extracted, item accepted by the vision check, text unchanged
    const a = itemStatus(l.regionIds[0]!);
    expect(a.status).toBe('accepted');
    expect(JSON.parse(a.resolution_json!)).toMatchObject({ by: 'vision_check', action: 'accept' });
    expect(t.ctx.db.get<{ status: string; text: string }>('SELECT status, text FROM source_region WHERE id = ?', [l.regionIds[0]])).toEqual({ status: 'extracted', text: TEXT.confirm });
    // page-level «unread writing»: the full-page reading agrees → accepted, page ready
    expect(itemStatus(l.pageIds[2]!).status).toBe('accepted');
    // conflict: stays open, the model's reading is kept beside it, the text is unchanged
    const b = itemStatus(l.regionIds[1]!);
    expect(b.status).toBe('open');
    expect(JSON.parse(b.details_json).vision_check.reading).toContain('Rapidly progressive');
    expect(t.ctx.db.get<{ status: string; text: string }>('SELECT status, text FROM source_region WHERE id = ?', [l.regionIds[1]])).toEqual({ status: 'needs_review', text: TEXT.conflict });

    const statuses = t.ctx.db.all<{ s: string }>('SELECT processing_status AS s FROM source_page WHERE version_id = ? ORDER BY page_index', [l.versionId]).map((r) => r.s);
    expect(statuses).toEqual(['ready', 'needs_review', 'ready']);
    // idempotent per processing run
    expect(enqueueOcrVerifyFollowUp(t.ctx, l.versionId, 'process-job-1')).toBe(true);
    await t.ctx.jobs.drain();
    expect(ai.callsFor('describe_figure').length - before).toBe(3);
  });
});

describe('a picture page goes through processing as READY (real OCR, no poppler needed)', () => {
  it('a stained-tissue slide with a short caption: ready, no review item, no texture stored as text', async () => {
    const src = await addSource(t, 'tissue.png', 'image', { data: encodePng(tissueSlide()), fileName: 'tissue.png' });
    await processVersion(t, src.versionId);
    const page = t.ctx.db.get<{ id: string; processing_status: string; error_code: string | null }>('SELECT id, processing_status, error_code FROM source_page WHERE version_id = ?', [src.versionId])!;
    expect(page.processing_status).toBe('ready');
    expect(page.error_code).toBeNull();
    expect(t.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM review_queue_item WHERE status = 'open' AND json_extract(details_json, '$.page_id') = ?`, [page.id])!.n).toBe(0);
    const res = await api(t).get(`/api/sources/${src.sourceId}/versions/${src.versionId}/pages`);
    expect((res.json() as SourcePagesResponse).pages[0]).toMatchObject({ picture_page: true, optional_review: 0 });
    const text = t.ctx.db.all<{ text: string | null }>('SELECT text FROM source_region WHERE page_id = ?', [page.id]).map((r) => r.text ?? '').join(' ');
    // only readable words are stored (texture read as letters is not text); the picture is described by the figure step
    expect(text.replace(/\s+/g, '').length).toBeLessThan(80);
  }, 120_000);
});

describe('page pictures are served for the browser cache (content-addressed)', () => {
  it('GET /api/files/:id → private immutable + ETag; If-None-Match → 304', async () => {
    const f = await t.ctx.files.put(encodePng(solid(8, 8, [10, 20, 30])), { mime: 'image/png', originalName: 'p.png' });
    const res = await t.app.inject({ method: 'GET', url: `/api/files/${f.id}`, headers: t.h });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('private, max-age=31536000, immutable');
    const etag = res.headers.etag as string;
    expect(etag).toBe(`"${f.sha256}"`);
    const again = await t.app.inject({ method: 'GET', url: `/api/files/${f.id}`, headers: { ...t.h, 'if-none-match': etag } });
    expect(again.statusCode).toBe(304);
  });
});
