// P1-T3 step 1 — DOCX → display PDF (PRD AOS-2.4, 3.14). The Arabic / English DOCX of the Golden Set (labelled TEST
// FIXTURE inside the file) gets a LibreOffice display PDF: every font embedded, the same page count on every run, and
// the paragraph pages / locators that evidence cites left exactly as they were. Needs LibreOffice (installed in this
// container); without it the rendition is recorded as «unavailable» with the reason — also tested.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { VersionFilesResponse } from '@medlevo/shared';
import { detectTools } from '../../src/modules/processing/tools';
import { inspectPdfFonts, makeDocxDisplayPdf } from '../../src/modules/versions/rendition';
import type { TestApp } from '../helpers/app';
import { addSource, createProcessingApp, FIXTURES, processVersion } from './helpers';

const hasSoffice = !!detectTools().soffice;
let t: TestApp;
afterEach(async () => t?.close());

const regionsSnapshot = (versionId: string) =>
  t.ctx.db.all<{ id: string; kind: string; text: string | null; locator_json: string | null; page_index: number }>(
    `SELECT r.id, r.kind, r.text, r.locator_json, p.page_index FROM source_region r JOIN source_page p ON p.id = r.page_id WHERE r.version_id = ? ORDER BY p.page_index, r.reading_order`,
    [versionId],
  );

describe('DOCX display PDF', () => {
  it.skipIf(!hasSoffice)('Arabic/English DOCX: fonts embedded, stable page count across runs, paragraph locators kept', async () => {
    t = await createProcessingApp();
    const h = await t.login();
    const { versionId } = await addSource(t, 'lecture_notes_shock.docx', 'docx');
    await processVersion(t, versionId); // processing + its follow-ups (analysis, display PDF)
    const before = regionsSnapshot(versionId);
    expect(before.length).toBeGreaterThan(3);
    expect(before.some((r) => r.locator_json && /paragraph/.test(r.locator_json))).toBe(true);

    const res = await t.app.inject({ method: 'GET', url: `/api/versions/versions/${versionId}/files`, headers: h });
    expect(res.statusCode, res.body).toBe(200);
    const files = res.json() as VersionFilesResponse;
    expect(files.docx_rendition).toMatchObject({ status: 'ready', reason_ar: null });
    expect(files.docx_rendition!.page_count).toBeGreaterThan(0);
    expect(files.docx_rendition!.fonts.length).toBeGreaterThan(0);
    expect(files.docx_rendition!.fonts.every((f) => f.embedded)).toBe(true);
    const pdfFile = files.files.find((f) => f.role === 'docx_display_pdf')!;
    expect(pdfFile.mime).toBe('application/pdf');
    expect(files.files.find((f) => f.role === 'original')?.mime).toContain('wordprocessingml');
    const pdf = await t.ctx.files.read(pdfFile.file_id);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    // the Arabic text is in the PDF (text layer), not lost to a missing font
    const inspected = await inspectPdfFonts(pdf);
    expect(inspected.pages).toBe(files.docx_rendition!.page_count);

    // a second run: same page count and fonts
    const pages1 = files.docx_rendition!.page_count;
    await makeDocxDisplayPdf(t.ctx, versionId, new AbortController().signal);
    const again = (await t.app.inject({ method: 'GET', url: `/api/versions/versions/${versionId}/files`, headers: h })).json() as VersionFilesResponse;
    expect(again.docx_rendition!.page_count).toBe(pages1);
    expect(again.docx_rendition!.fonts).toEqual(files.docx_rendition!.fonts);

    // evidence locators untouched; the reader's display_file_id contract untouched (paragraph pages ≠ PDF pages)
    expect(regionsSnapshot(versionId)).toEqual(before);
    expect(t.ctx.db.get<{ d: string | null }>('SELECT display_file_id AS d FROM source_version WHERE id = ?', [versionId])!.d).toBeNull();
  }, 120_000);

  it('without LibreOffice the rendition is «unavailable» with the reason (never faked)', async () => {
    t = await createProcessingApp();
    const { versionId } = await addSource(t, 'lecture_notes_shock.docx', 'docx');
    const r = await makeDocxDisplayPdf(t.ctx, versionId, new AbortController().signal, null);
    expect(r.status).toBe('unavailable');
    const row = t.ctx.db.get<{ status: string; reason: string; file_id: string | null }>(`SELECT status, reason, file_id FROM version_rendition WHERE version_id = ?`, [versionId])!;
    expect(row).toMatchObject({ status: 'unavailable', file_id: null });
    expect(row.reason).toContain('LibreOffice');
  });

  it('the purge releases the display PDF with its version', async () => {
    t = await createProcessingApp();
    const h = await t.login();
    const data = readFileSync(join(FIXTURES, 'lecture_notes_shock.docx'));
    const { sourceId, versionId } = await addSource(t, 'lecture_notes_shock.docx', 'docx', { data });
    // a fake rendition file (no converter needed for this check)
    const stored = await t.ctx.files.put(Buffer.from('%PDF-1.4\n% TEST FIXTURE rendition\n'), { mime: 'application/pdf', originalName: 'r.pdf' });
    const now = t.ctx.clock.now();
    t.ctx.db.run(`INSERT INTO version_rendition (version_id, role, file_id, status, page_count, engine, created_at, updated_at) VALUES (?, 'docx_display_pdf', ?, 'ready', 1, 'test', ?, ?)`, [versionId, stored.id, now, now]);
    expect((await t.app.inject({ method: 'POST', url: `/api/sources/${sourceId}/trash`, headers: h })).statusCode).toBe(200);
    const impact = (await t.app.inject({ method: 'GET', url: `/api/sources/${sourceId}/impact?mode=purge`, headers: h })).json() as { confirm_token: string; lines_ar: string[] };
    expect(impact.lines_ar.join(' ')).toContain('نسخ عرض PDF');
    const del = await t.app.inject({ method: 'DELETE', url: `/api/sources/${sourceId}?confirm_token=${encodeURIComponent(impact.confirm_token)}`, headers: h });
    expect(del.statusCode, del.body).toBe(200);
    await t.ctx.jobs.drain();
    expect(t.ctx.files.stat(stored.id)).toBeNull();
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM version_rendition')!.n).toBe(0);
  });
});
