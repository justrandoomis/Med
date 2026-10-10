// G1 / AC-03 — partial failure (§60): one page that stumbles is shown clearly, the other pages stay readable, and a
// summary is never called complete before the gap is processed or declared. Every failure here is REAL (no SQL
// shortcut, no fault-injection hook): the actual pipeline meets
//   * g1_partial_images.zip — an ordered image set whose second picture is a truncated (damaged) PNG → OCR fails →
//     that page `failed`, the version `partial`;
//   * g1_damaged_page.pdf — a PDF whose second page has a damaged content stream (viewers draw nothing). Before the
//     G1 fix this page was stored as a «ready» EMPTY page and the version as «ready / complete»; now it is flagged
//     `PAGE_CONTENT_DAMAGED` (needs review, unreadable) and the coverage is not complete.
// Summaries / the Study Book are generated with the TEST-ONLY scripted provider (no AI key exists here).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ProcessingOverviewResponse, ProcessingSummary, StudyBookView, SummaryPreviewResponse } from '@medlevo/shared';
import { REPO_ROOT } from '../../src/config';
import { popplerReportsDamage } from '../../src/modules/processing/tools';
import { searchChunks } from '../../src/modules/processing/search';
import type { AuthHeaders, TestApp } from '../helpers/app';
import { addSource, pages, pageText, processVersion, type AddedSource } from '../processing/helpers';
import { content, createStudyApp, regionsIn, S, ScriptedAi } from '../studybook/helpers';

const ACC = join(REPO_ROOT, 'fixtures', 'acceptance');
const ai = new ScriptedAi();
let t: TestApp;
let h: AuthHeaders;
let images: AddedSource;
let damaged: AddedSource;

/** a scripted generator that cites every region it is given (one directly-stated sentence each) */
function citingGenerator(req: Parameters<Parameters<ScriptedAi['always']>[1]>[0]) {
  const blocks: unknown[] = [{ kind: 'heading', sentences: [S.n('ملخص الصفحات')] }];
  for (const r of regionsIn(req.prompt)) {
    if (!r.alias) continue;
    const first = (r.text.replace(/^\[E\d+\] \[R\d+\]\n/, '').split(/(?<=[.!?؟])\s+/)[0] ?? '').trim().slice(0, 220);
    if (first) blocks.push({ kind: 'paragraph', sentences: [S.c(first, [r.alias], 'directly_stated')], explains_regions: [r.region] });
  }
  return content(blocks);
}

const versionRow = (id: string) => t.ctx.db.get<{ processing_status: string; processing_summary_json: string }>('SELECT processing_status, processing_summary_json FROM source_version WHERE id = ?', [id])!;
const summaryOf = (id: string) => JSON.parse(versionRow(id).processing_summary_json) as ProcessingSummary;
const inject = async <T>(method: 'GET' | 'POST', url: string, payload?: unknown): Promise<{ status: number; body: T }> => {
  const res = await t.app.inject({ method, url, headers: h, ...(payload === undefined ? {} : { payload: payload as object }) });
  return { status: res.statusCode, body: res.json() as T };
};
const lectureOnly = (s: AddedSource) => ({ mode: 'lecture_only' as const, lecture_source_id: s.sourceId });

beforeAll(async () => {
  t = await createStudyApp(ai);
  images = await addSource(t, 'g1_partial_images.zip', 'image_set', { data: readFileSync(join(ACC, 'g1_partial_images.zip')), fileName: 'g1_partial_images.zip', title: 'G1 partial images (TEST FIXTURE)' });
  damaged = await addSource(t, 'g1_damaged_page.pdf', 'pdf', { data: readFileSync(join(ACC, 'g1_damaged_page.pdf')), fileName: 'g1_damaged_page.pdf', title: 'G1 damaged page (TEST FIXTURE)' });
  for (const s of [images, damaged]) await processVersion(t, s.versionId);
  h = await t.login();
  ai.always('summarize', citingGenerator);
  ai.always('study_book', citingGenerator);
}, 240_000);
afterAll(async () => {
  await t?.close();
});
afterEach(() => {
  if (ai.errors.length) throw new Error(`scripted generator failed: ${ai.errors.splice(0).map(String).join(' | ')}`);
});

describe('G1 AC-03 — a page that stumbles is shown; the others stay readable', () => {
  it('image set with a damaged picture: that page failed with an Arabic reason, version partial, coverage incomplete', () => {
    const ps = pages(t, images.versionId);
    expect(ps.map((p) => p.processing_status)).toEqual([expect.stringMatching(/^(ready|needs_review)$/), 'failed', expect.stringMatching(/^(ready|needs_review)$/)]);
    expect(ps[1]).toMatchObject({ error_code: 'OCR_FAILED', text_status: 'failed', section_key: '02_damaged.png' });
    expect(ps[1]!.error_detail).toMatch(/بقية الصفحات لم تتأثر/);
    expect(versionRow(images.versionId).processing_status).toBe('partial');
    const sum = summaryOf(images.versionId);
    expect(sum).toMatchObject({ pages_total: 3, pages_failed: 1, coverage_complete: false });
    expect(sum.stage_label_ar).toContain('جزئيًا');
    expect(sum.stage_label_ar).toContain('التغطية غير كاملة');
    expect(sum.failed_pages).toEqual([expect.objectContaining({ page_index: 1, error_code: 'OCR_FAILED' })]);
  });

  it('…and the other pages are readable and searchable (scan text, flowchart kept as a figure)', () => {
    expect(pageText(t, images.versionId, 0)).toContain('pylori');
    expect(t.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM source_region r JOIN source_page p ON p.id = r.page_id WHERE p.version_id = ? AND p.page_index = 2`, [images.versionId])!.n).toBeGreaterThan(0);
    const hits = searchChunks(t.ctx.db, { versionIds: [images.versionId] }, 'urea breath test');
    expect(hits.length).toBeGreaterThan(0);
  });

  it('PDF with a damaged page: flagged (unreadable, needs review), never a «ready» empty page; the others ready', () => {
    const ps = pages(t, damaged.versionId);
    expect(ps.map((p) => p.processing_status)).toEqual(['ready', 'needs_review', 'ready']);
    expect(ps[1]).toMatchObject({ error_code: 'PAGE_CONTENT_DAMAGED', text_status: 'no_text_found' });
    expect(ps[1]!.error_detail).toContain('تالف');
    const sum = summaryOf(damaged.versionId);
    expect(versionRow(damaged.versionId).processing_status).toBe('needs_review');
    expect(sum.coverage_complete).toBe(false);
    expect(sum.stage_label_ar).toContain('لم يُقرأ نصها');
    const item = t.ctx.db.get<{ kind: string }>(`SELECT kind FROM review_queue_item WHERE entity_id = ?`, [ps[1]!.id]);
    expect(item?.kind).toBe('unreadable_page');
    expect(pageText(t, damaged.versionId, 0)).toContain('Peptic Ulcer Disease');
    expect(pageText(t, damaged.versionId, 2)).toContain('summary table');
  });

  it('poppler diagnostics: errors mean damage, warnings do not', () => {
    expect(popplerReportsDamage('Syntax Error (125734): Unknown compression method in flate stream\n')).toBe(true);
    expect(popplerReportsDamage("Syntax Error: XObject 'Im0' is unknown")).toBe(true);
    expect(popplerReportsDamage('Syntax Warning: Invalid Font Weight\n')).toBe(false);
    expect(popplerReportsDamage('')).toBe(false);
  });

  it('the Control Center lists both versions page by page with the reason and what the gap means', async () => {
    const res = await inject<ProcessingOverviewResponse>('GET', '/api/control/processing');
    expect(res.status).toBe(200);
    for (const [v, code] of [
      [images.versionId, 'OCR_FAILED'],
      [damaged.versionId, 'PAGE_CONTENT_DAMAGED'],
    ] as const) {
      const att = res.body.attention.find((a) => a.version_id === v);
      expect(att, v).toBeTruthy();
      expect(att!.pages).toEqual([expect.objectContaining({ page_index: 1, error_code: code })]);
      expect(att!.coverage_note_ar).toBeTruthy();
    }
  });
});

describe('G1 AC-03 — a summary is never called complete while a page is missing', () => {
  for (const which of ['images', 'damaged'] as const) {
    it(`${which}: the preview says it will NOT be complete and names the unreadable page`, async () => {
      const src = which === 'images' ? images : damaged;
      const res = await inject<SummaryPreviewResponse>('POST', '/api/studybook/summaries/preview', { type: 'detailed', source_id: src.sourceId, scope: lectureOnly(src) });
      expect(res.status).toBe(200);
      expect(res.body.will_be_complete).toBe(false);
      expect(res.body.pages_unreadable).toEqual([1]);
      expect(res.body.pages_ready).toBe(2);
      expect(res.body.notes_ar.join(' ')).toContain('غير مقروءة');
    });
  }

  it('the generated summary covers only the readable pages, lists the gap, and nothing calls it complete', async () => {
    const res = await inject<{ book: StudyBookView }>('POST', '/api/studybook/summaries', { type: 'detailed', source_id: images.sourceId, scope: lectureOnly(images) });
    expect(res.status).toBe(200);
    await t.ctx.jobs.drain();
    const v = (await inject<StudyBookView>('GET', `/api/studybook/summaries/${res.body.book.artifact.id}`)).body;
    expect(v.artifact.kind).toBe('summary');
    expect(['published', 'partial']).toContain(v.artifact.status);
    const cov = v.artifact.coverage!;
    expect(cov.pages_total).toBe(3);
    expect(cov.pages_covered).toBeLessThan(cov.pages_total!);
    expect(cov.missing_ar!.join(' ')).toContain('غير مقروءة');
    expect(cov.missing_ar!.join(' ')).toContain('صورة 2');
    expect(v.artifact.title ?? '').not.toMatch(/كامل|complete/i);
    // the generator never saw anything from the failed page
    const prompts = ai.callsFor('summarize').map((c) => c.prompt).join('\n');
    expect(prompts).not.toContain('02_damaged');
  });

  it('the Study Book of the partial version lists the pages it could not include', async () => {
    const res = await inject<{ book: StudyBookView }>('POST', '/api/studybook/books', { source_id: damaged.sourceId, scope: lectureOnly(damaged) });
    expect(res.status).toBe(200);
    await t.ctx.jobs.drain();
    const v = (await inject<StudyBookView>('GET', `/api/studybook/books/${res.body.book.artifact.id}`)).body;
    expect(v.artifact.coverage?.missing_ar?.join(' ')).toMatch(/لم يشملها الكتاب: ص 2/);
  });
});
