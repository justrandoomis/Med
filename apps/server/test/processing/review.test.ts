// Regression tests for defects found in the independent review of track A2 (see docs/modules/processing.md,
// "Independent review"). Derived fixtures live in ./fixtures (regenerate with fixtures/make_fixtures.py).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FigureStructure, NormBox, TableStructure } from '@medlevo/shared';
import { fromJson } from '../../src/db/db';
import { JobError } from '../../src/lib/errors';
import { newId } from '../../src/lib/ids';
import type { LayoutRegion } from '../../src/modules/processing/layout/types';
import { OcrEngine, OcrTimeoutError } from '../../src/modules/processing/ocr';
import { persistPage, type PageUpdate } from '../../src/modules/processing/persist';
import { MAX_RENDER_PIXELS, RENDER_DPI, renderDpi } from '../../src/modules/processing/pipeline';
import { searchChunks } from '../../src/modules/processing/search';
import { linkFiguresAcrossPages } from '../../src/modules/processing/structure';
import { ambiguousLamAlefWords, detectSuspicious, fixReversedLamAlef, hasReversedLamAlef } from '../../src/modules/processing/text';
import { findExecutable } from '../../src/modules/processing/tools';
import type { TestApp } from '../helpers/app';
import { addSource, createProcessingApp, FIXTURES, pages, processVersion, regions, type RegionRow } from './helpers';

const LOCAL = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const HAS_PDFTOPPM = findExecutable('pdftoppm') !== null;

const box = (r: Pick<RegionRow, 'bbox_json'>): NormBox => fromJson<NormBox>(r.bbox_json)!;

function expectBoxClose(actual: NormBox, expected: NormBox, tol: number, label: string): void {
  for (const k of ['x', 'y', 'w', 'h'] as const) {
    expect(Math.abs(actual[k] - expected[k]), `${label}: ${k} ${actual[k]} vs ${expected[k]}`).toBeLessThanOrEqual(tol);
  }
}

describe('reversed lam-alef: plain «لا» after the article is repaired; ambiguous words are flagged (review fix)', () => {
  it('repairs the word-initial double alef («االلتهاب» → «الالتهاب») with and without proclitics', () => {
    expect(fixReversedLamAlef('يسبب االلتهاب االنسداد').text).toBe('يسبب الالتهاب الانسداد');
    expect(fixReversedLamAlef('واالختبار بااللتهاب فاالنسداد').text).toBe('والاختبار بالالتهاب فالانسداد');
    expect(fixReversedLamAlef('االلتهاب').fixes).toBe(1);
  });

  it('never changes correct words that contain «ال»/«لا»', () => {
    for (const w of ['الالتهاب', 'الانسداد', 'والاختبار', 'إلا', 'الا', 'لا', 'العلاج', 'السلام', 'اللاإرادي', 'لالتهاب', 'الألم', 'الآن', 'آلام']) {
      expect(fixReversedLamAlef(w).text, w).toBe(w);
    }
  });

  it('flags words with an inner «ال» only when the document is known to reverse ligatures', () => {
    expect(ambiguousLamAlefWords('العالج السالم الحفرة والاختبار بالأمواج')).toEqual(['العالج', 'السالم']);
    expect(detectSuspicious('العالج السالم')).toEqual([]); // a clean document: «ال» inside words is normal
    const flagged = detectSuspicious('العالج السالم', { reversedLigatures: true });
    expect(flagged.map((s) => [s.kind, s.token])).toEqual([
      ['ambiguous_lam_alef', 'العالج'],
      ['ambiguous_lam_alef', 'السالم'],
    ]);
    expect(hasReversedLamAlef('يسبب االلتهاب')).toBe(true);
    expect(hasReversedLamAlef('يسبب الالتهاب والعلاج')).toBe(false);
  });

  it('a LibreOffice-exported Arabic PDF: repaired words are stored correctly, the others are flagged for review', async () => {
    const t = await createProcessingApp();
    try {
      const { versionId } = await addSource(t, 'arabic_lam_alef.pdf', 'pdf', { data: readFileSync(join(LOCAL, 'arabic_lam_alef.pdf')) });
      await processVersion(t, versionId);
      const rs = regions(t, versionId);
      const all = rs.map((r) => r.text ?? '').join('\n');
      expect(all).toContain('يسبب الالتهاب الانسداد في الأمعاء والاختبار بالالتهاب');
      for (const reversed of ['االلتهاب', 'االنسداد', 'واالختبار', 'بااللتهاب', 'األمعاء']) expect(all).not.toContain(reversed);
      // «العلاج» comes out as «العالج»: it cannot be repaired safely, so the region must not pass silently
      const region = rs.find((r) => r.text?.includes('العالج'))!;
      expect(region.status).toBe('needs_review');
      const item = t.ctx.db.get<{ kind: string; reason: string }>('SELECT kind, reason FROM review_queue_item WHERE entity_id = ?', [region.id]);
      expect(item?.kind).toBe('ocr_error');
      expect(item?.reason).toContain('«العالج»');
      expect(pages(t, versionId)[0]!.processing_status).toBe('needs_review');
    } finally {
      await t.close();
    }
  }, 60_000);
});

describe('pages with an intrinsic /Rotate are laid out as displayed; boxes stay in the unrotated page box (review fix)', () => {
  let t: TestApp;
  let plain: string;
  let rotated: string;
  beforeAll(async () => {
    t = await createProcessingApp();
    plain = (await addSource(t, 'lecture_appendicitis.pdf', 'pdf')).versionId;
    rotated = (await addSource(t, 'rotated_lecture.pdf', 'pdf', { data: readFileSync(join(LOCAL, 'rotated_lecture.pdf')) })).versionId;
    await processVersion(t, plain);
    await processVersion(t, rotated);
  }, 120_000);
  afterAll(async () => t?.close());

  it('same regions, kinds, reading order and review flags as the upright original (rotations 90/270/180/90)', () => {
    const ps = pages(t, rotated);
    expect(ps.map((p) => p.printed_label)).toEqual(['11', '12', '13', '14']);
    const key = (vid: string) =>
      regions(t, vid)
        .filter((r) => r.kind !== 'diagram') // figure labels are OCR'd from a crop (raster details may differ)
        .map((r) => `${r.page_index}|${r.kind}|${r.reading_order}|${r.status}|${r.text}`);
    expect(key(rotated)).toEqual(key(plain));
    // the tanween glyph mapped to «S» is still caught on the rotated page
    expect(regions(t, rotated, 0).find((r) => r.text?.includes('عادةS'))?.status).toBe('needs_review');
  });

  it('the table on the 180° page keeps its structure (10 × 3, merged header)', () => {
    const s = (vid: string) => fromJson<TableStructure>(regions(t, vid, 2).find((r) => r.kind === 'table')!.structure_json)!;
    const a = s(rotated);
    expect([a.rows, a.cols]).toEqual([10, 3]);
    expect(a.cells.find((c) => c.text.includes('Alvarado score (MANTRELS)'))?.colspan).toBe(3);
    expect(a.cells.map((c) => [c.r, c.c, c.text])).toEqual(s(plain).cells.map((c) => [c.r, c.c, c.text]));
  });

  it('bboxes are normalized to the UNROTATED page box (exact inverse of the page rotation)', () => {
    // the fixture turned the content by -rotation; map the upright box into the unrotated space
    const map: Record<number, (b: NormBox) => NormBox> = {
      90: (b) => ({ x: b.y, y: 1 - (b.x + b.w), w: b.h, h: b.w }),
      270: (b) => ({ x: 1 - (b.y + b.h), y: b.x, w: b.h, h: b.w }),
      180: (b) => ({ x: 1 - (b.x + b.w), y: 1 - (b.y + b.h), w: b.w, h: b.h }),
    };
    const rotations = [90, 270, 180, 90];
    const a = regions(t, plain).filter((r) => r.kind !== 'diagram' && r.bbox_json);
    const b = regions(t, rotated).filter((r) => r.kind !== 'diagram' && r.bbox_json);
    expect(b.length).toBe(a.length);
    a.forEach((r, i) => expectBoxClose(box(b[i]!), map[rotations[r.page_index]!]!(box(r)), 0.003, `${r.kind} «${(r.text ?? '').slice(0, 20)}»`));
    // table cell boxes too
    const cells = (vid: string) => fromJson<TableStructure>(regions(t, vid, 2).find((r) => r.kind === 'table')!.structure_json)!.cells;
    cells(plain).forEach((c, i) => expectBoxClose(cells(rotated)[i]!.bbox!, map[180]!(c.bbox!), 0.003, `cell ${c.r},${c.c}`));
  });

  it('the figure page (90°) keeps its figure ↔ caption link and a crop asset', () => {
    const fig = regions(t, rotated, 3).find((r) => r.kind === 'figure')!;
    const s = fromJson<FigureStructure>(fig.structure_json)!;
    expect(regions(t, rotated, 3).find((r) => r.id === s.caption_region_id)?.text).toContain('Figure 1');
    if (HAS_PDFTOPPM) expect(t.ctx.db.get<{ file_id: string | null }>('SELECT file_id FROM image_asset WHERE region_id = ?', [fig.id])?.file_id).toBeTruthy();
  });
});

describe.skipIf(!HAS_PDFTOPPM)('a scanned page with /Rotate 90 and a CropBox ≠ MediaBox (review fix)', () => {
  it('OCR text reads in order and boxes map to the crop box of the unrotated page', async () => {
    const t = await createProcessingApp();
    try {
      const plain = (await addSource(t, 'mixed_scanned_lecture.pdf', 'pdf')).versionId;
      const odd = (await addSource(t, 'rotated_cropped_scan.pdf', 'pdf', { data: readFileSync(join(LOCAL, 'rotated_cropped_scan.pdf')) })).versionId;
      await processVersion(t, plain);
      await processVersion(t, odd);
      const p = pages(t, odd)[0]!;
      expect(p.text_status).toBe('ocr');
      // page size = the crop box (what pdfjs reports and pdftoppm now renders), unrotated
      expect(p.width).toBeCloseTo(801.89, 1);
      expect(p.height).toBeCloseTo(535.28, 1);
      const rs = regions(t, odd, 0);
      const text = rs.map((r) => r.text ?? '').join('\n');
      expect(text).toContain('Helicobacter pylori (H. pylori) infection');
      expect(text).toContain('The urea breath test is a non-invasive test');
      expect(rs.find((r) => r.text?.includes('جرثومة'))?.text).toBe('جرثومة H. pylori سبب شائع لقرحة المعدة.');
      expect(rs.findIndex((r) => r.text?.includes('Helicobacter'))).toBeLessThan(rs.findIndex((r) => r.text?.includes('urea breath')));

      // expected box: upright page W0×H0 → unrotated landscape (content turned by -90°) → crop [20,30,H0-20,W0-30]
      const W0 = 595.28;
      const H0 = 841.89;
      const cw = H0 - 40;
      const ch = W0 - 60;
      const expectFrom = (b: NormBox): NormBox => {
        const X = b.x * W0;
        const Y = b.y * H0;
        const w = b.w * W0;
        const h = b.h * H0;
        return { x: (Y - 20) / cw, y: (W0 - (X + w) - 30) / ch, w: h / cw, h: w / ch };
      };
      for (const needle of ['urea breath', 'جرثومة']) {
        const a = regions(t, plain, 1).find((r) => r.text?.includes(needle))!;
        const b = rs.find((r) => r.text?.includes(needle))!;
        expectBoxClose(box(b), expectFrom(box(a)), 0.01, needle);
      }
    } finally {
      await t.close();
    }
  }, 120_000);
});

describe('a failed or cancelled re-processing never leaves chunks that cite deleted regions (review fix)', () => {
  let failPage: number | null = null;
  let t: TestApp;
  beforeAll(async () => {
    t = await createProcessingApp({
      hooks: {
        afterPagePersist: (i) => {
          if (i === failPage) throw new JobError('TEST_FLAKY', 'محاكاة عطل متكرر بعد حفظ الصفحة.', { retryable: true });
        },
      },
    });
  }, 60_000);
  afterAll(async () => t?.close());

  const danglingChunkRegions = (vid: string): number =>
    t.ctx.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM document_chunk c, json_each(c.region_ids_json) j
        WHERE c.version_id = ? AND NOT EXISTS (SELECT 1 FROM source_region r WHERE r.id = j.value)`,
      [vid],
    )!.n;

  it('rebuilds the index from the stored regions when the last attempt fails', async () => {
    const { versionId } = await addSource(t, 'lecture_appendicitis.pdf', 'pdf');
    await processVersion(t, versionId);
    expect(danglingChunkRegions(versionId)).toBe(0);
    failPage = 1;
    const job = await processVersion(t, versionId, { page_indexes: [1], reason: 'reprocess' });
    failPage = null;
    expect(job.status).toBe('failed');
    expect(job.attempts).toBe(3);
    // page 1's regions were replaced by every attempt; no chunk may point at the old ids
    expect(danglingChunkRegions(versionId)).toBe(0);
    const hit = searchChunks(t.ctx.db, { versionIds: [versionId] }, 'first-line imaging');
    expect(hit).toHaveLength(1);
    expect(hit[0]!.region_ids.every((id) => t.ctx.db.get('SELECT 1 AS x FROM source_region WHERE id = ?', [id]))).toBe(true);
    t.ctx.db.run(`INSERT INTO chunk_fts(chunk_fts) VALUES ('integrity-check')`);
  }, 120_000);

  it('while a page is being replaced, its old chunks are gone in the same transaction as its old regions', async () => {
    const { versionId, sourceId } = await addSource(t, 'lecture_cholecystitis.pdf', 'pdf');
    await processVersion(t, versionId);
    const page = pages(t, versionId)[0]!;
    const before = t.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM document_chunk WHERE version_id = ? AND page_ids_json LIKE ?`, [versionId, `%${page.id}%`])!.n;
    expect(before).toBeGreaterThan(0);
    const upd: PageUpdate = { text_status: 'digital', processing_status: 'ready', ocr_confidence: null, has_images: false, error_code: null, error_detail: null };
    const para: LayoutRegion = { key: 'p1', kind: 'paragraph', box: { x0: 10, top: 10, x1: 100, bottom: 20 }, text: 'replacement', textOrigin: 'digital' };
    persistPage(t.ctx, { versionId, sourceId, pageId: page.id, pageIndex: 0, printedLabel: null, geom: { width: 600, height: 800 } }, [para], new Map(), [], upd);
    expect(t.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM document_chunk WHERE version_id = ? AND page_ids_json LIKE ?`, [versionId, `%${page.id}%`])!.n).toBe(0);
    expect(danglingChunkRegions(versionId)).toBe(0);
  });
});

describe('a caption printed on the next page does not block re-processing that page (review fix)', () => {
  it('re-persisting the caption page releases and re-links the cross-page caption', async () => {
    const t = await createProcessingApp();
    try {
      const { versionId, sourceId } = await addSource(t, 'x.pdf', 'pdf', { data: Buffer.from('%PDF-1.4 test fixture'), fileName: 'x.pdf' });
      const now = t.clock.now();
      for (const i of [0, 1]) {
        t.ctx.db.run(`INSERT INTO source_page (id, version_id, page_index, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`, [newId(), versionId, i, now, now]);
      }
      const ps = pages(t, versionId);
      const geom = { width: 600, height: 800 };
      const upd: PageUpdate = { text_status: 'digital', processing_status: 'ready', ocr_confidence: null, has_images: true, error_code: null, error_detail: null };
      const crop = await t.ctx.files.put(Buffer.from('test figure crop'), { mime: 'image/png', originalName: 'figure.png' });
      const figure: LayoutRegion = {
        key: 'fig1',
        kind: 'figure',
        box: { x0: 100, top: 500, x1: 500, bottom: 780 },
        text: null,
        textOrigin: null,
        figure: { captionKey: null, labels: [], labelsOrigin: null },
      };
      persistPage(t.ctx, { versionId, sourceId, pageId: ps[0]!.id, pageIndex: 0, printedLabel: null, geom }, [figure], new Map([['fig1', { fileId: crop.id }]]), [], upd);
      const caption = (): LayoutRegion => ({ key: 'c1', kind: 'caption', box: { x0: 100, top: 20, x1: 500, bottom: 40 }, text: 'Figure 2: test diagram', textOrigin: 'digital' });
      const ref1 = { versionId, sourceId, pageId: ps[1]!.id, pageIndex: 1, printedLabel: null, geom };
      persistPage(t.ctx, ref1, [caption()], new Map(), [], upd);
      expect(linkFiguresAcrossPages(t.ctx, versionId).captionsLinked).toBe(1);

      // before the fix: FOREIGN KEY (image_asset.caption_region_id) → RegionsInUseError ("evidence cites it")
      expect(() => persistPage(t.ctx, ref1, [caption()], new Map(), [], upd)).not.toThrow();
      const newCaption = regions(t, versionId, 1).find((r) => r.kind === 'caption')!;
      linkFiguresAcrossPages(t.ctx, versionId);
      const fig = regions(t, versionId, 0).find((r) => r.kind === 'figure')!;
      expect(fromJson<FigureStructure>(fig.structure_json)?.caption_region_id).toBe(newCaption.id);
      expect(t.ctx.db.get<{ caption_region_id: string; caption: string }>('SELECT caption_region_id, caption FROM image_asset WHERE region_id = ?', [fig.id])).toEqual({
        caption_region_id: newCaption.id,
        caption: 'Figure 2: test diagram',
      });
    } finally {
      await t.close();
    }
  });
});

describe('resource limits (review fix)', () => {
  it('caps the render resolution of huge pages by a pixel budget', () => {
    expect(renderDpi(595.28, 841.89)).toBe(RENDER_DPI); // A4
    const dpi = renderDpi(14400, 14400); // 200 × 200 inch page
    expect(dpi).toBeLessThan(RENDER_DPI);
    expect(((14400 * dpi) / 72) ** 2).toBeLessThanOrEqual(MAX_RENDER_PIXELS);
  });

  it('an image too large for OCR is kept as a figure and flagged (no OCR attempted)', async () => {
    const t = await createProcessingApp();
    try {
      // a PNG whose header declares 10000 × 5000 px (50 MP)
      const ihdr = Buffer.alloc(13);
      ihdr.writeUInt32BE(10_000, 0);
      ihdr.writeUInt32BE(5_000, 4);
      ihdr[8] = 8;
      ihdr[9] = 0;
      const chunk = (type: string, body: Buffer) => {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(body.length);
        return Buffer.concat([len, Buffer.from(type, 'latin1'), body, Buffer.alloc(4)]);
      };
      const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', deflateSync(Buffer.alloc(100))),
        chunk('IEND', Buffer.alloc(0)),
      ]);
      const { versionId } = await addSource(t, 'huge.png', 'image', { data: png, fileName: 'huge.png' });
      const job = await processVersion(t, versionId);
      expect(job.status).toBe('completed');
      const p = pages(t, versionId)[0]!;
      expect(p.error_code).toBe('IMAGE_TOO_LARGE');
      expect(p.processing_status).toBe('needs_review');
      expect(p.error_detail).toContain('50 ميغابكسل');
      expect(regions(t, versionId).map((r) => r.kind)).toEqual(['figure']);
    } finally {
      await t.close();
    }
  });

  it('a recognition that exceeds its time limit is abandoned and the next one gets a fresh worker', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'medlevo-ocr-'));
    const engine = new OcrEngine(dir);
    try {
      const image = readFileSync(join(FIXTURES, 'scanned_page.png'));
      // while the worker is still starting
      await expect(engine.recognize({ image, timeoutMs: 1 })).rejects.toBeInstanceOf(OcrTimeoutError);
      // while a recognition is in flight on a warm worker (it would otherwise run to completion)
      const warm = await engine.recognize({ image });
      expect(warm.words.length).toBeGreaterThan(10);
      const started = Date.now();
      await expect(engine.recognize({ image, timeoutMs: 40 })).rejects.toBeInstanceOf(OcrTimeoutError);
      expect(Date.now() - started).toBeLessThan(400); // abandoned at the limit, not after the full recognition
      const ok = await engine.recognize({ image });
      expect(ok.words.map((w) => w.text).join(' ').toLowerCase()).toContain('pylori');
    } finally {
      await engine.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('re-processing never replaces regions the owner reviewed or corrected (review fix)', () => {
  it('keeps the page and says why', async () => {
    const t = await createProcessingApp();
    try {
      const { versionId } = await addSource(t, 'lecture_cholecystitis.pdf', 'pdf');
      await processVersion(t, versionId);
      const region = regions(t, versionId, 1).find((r) => r.status === 'needs_review')!;
      t.ctx.db.run(`UPDATE source_region SET status = 'owner_reviewed' WHERE id = ?`, [region.id]);
      const before = regions(t, versionId, 1).map((r) => r.id);
      const job = await processVersion(t, versionId, { page_indexes: [1], reason: 'reprocess' });
      expect(job.status).toBe('partial');
      const p = pages(t, versionId)[1]!;
      expect(p.error_code).toBe('OWNER_REVIEWED_REGIONS');
      expect(p.error_detail).toContain('بنفسك');
      expect(regions(t, versionId, 1).map((r) => r.id)).toEqual(before);
      expect(regions(t, versionId, 1).find((r) => r.id === region.id)?.status).toBe('owner_reviewed');
    } finally {
      await t.close();
    }
  }, 60_000);
});

describe.skipIf(!HAS_PDFTOPPM)('a cancelled run never leaves a page "processing" (review fix)', () => {
  it('the interrupted page is marked failed with a specific reason and the version is partial', async () => {
    let cancelled = false;
    const t = await createProcessingApp({
      hooks: {
        beforePage: (i) => {
          if (i !== 1 || cancelled) return;
          cancelled = true;
          const running = t.ctx.jobs.list({ status: 'running' }).jobs[0]!;
          t.ctx.jobs.cancel(running.id); // the OCR render of page 1 is aborted (pdftoppm killed)
        },
      },
    });
    try {
      const { versionId } = await addSource(t, 'mixed_scanned_lecture.pdf', 'pdf');
      const job = await processVersion(t, versionId);
      expect(job.status).toBe('cancelled');
      // the aborted handler finishes its clean-up right after the queue settled the job
      for (let k = 0; k < 50 && pages(t, versionId)[1]!.processing_status === 'processing'; k++) await new Promise((r) => setTimeout(r, 20));
      const p = pages(t, versionId)[1]!;
      expect(p.processing_status).toBe('failed');
      expect(p.error_code).toBe('PROCESSING_INTERRUPTED');
      expect(t.ctx.db.get<{ s: string }>('SELECT processing_status AS s FROM source_version WHERE id = ?', [versionId])!.s).toBe('partial');
    } finally {
      await t.close();
    }
  }, 60_000);
});

describe('a large figure on a digital page is kept; a full-page background behind text is not a figure (review fix)', () => {
  it('records the figure + caption + crop, and leaves background pages as text', async () => {
    const t = await createProcessingApp();
    try {
      const { versionId } = await addSource(t, 'large_figure.pdf', 'pdf', { data: readFileSync(join(LOCAL, 'large_figure.pdf')) });
      await processVersion(t, versionId);
      const p0 = regions(t, versionId, 0);
      const fig = p0.find((r) => r.kind === 'figure');
      expect(fig, 'the 64 % diagram must not be dropped silently').toBeDefined();
      expect(box(fig!).w * box(fig!).h).toBeGreaterThan(0.5);
      const s = fromJson<FigureStructure>(fig!.structure_json)!;
      expect(p0.find((r) => r.id === s.caption_region_id)?.text).toContain('Figure 3');
      const asset = t.ctx.db.get<{ file_id: string | null; caption: string | null }>('SELECT file_id, caption FROM image_asset WHERE region_id = ?', [fig!.id]);
      expect(asset?.caption).toContain('Figure 3');
      if (HAS_PDFTOPPM) expect(asset?.file_id).toBeTruthy();
      // page 2: the picture is a background under ten lines of body text → no figure, every line kept as text
      const p1 = regions(t, versionId, 1);
      expect(p1.some((r) => r.kind === 'figure')).toBe(false);
      const text = p1.map((r) => r.text ?? '').join('\n');
      for (let i = 0; i < 10; i++) expect(text).toContain(`Body text line ${i}`);
    } finally {
      await t.close();
    }
  }, 60_000);
});
