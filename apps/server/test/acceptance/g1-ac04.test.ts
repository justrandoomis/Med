// G1 / AC-04 — a citation «ص12» opens the right page even when file page 12 carries another printed number; both
// numberings are shown when needed. Real pipeline on derived acceptance fixtures (fixtures/acceptance):
//   g1_front_matter_labels.pdf   — /PageLabels i, ii, 1…12: printed «12» = file page 14; file page 12 = printed «10»
//   g1_front_matter_detected.pdf — the same book WITHOUT /PageLabels: numbers detected from the footers, the cover
//                                  and contents pages print no number
//   mixed_scanned_lecture.pdf    — a Golden Set file with no printed numbers at all (control: labels unchanged)
// The AI citation path uses the TEST-ONLY scripted provider (no AI key exists here).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { pageDisplayLabel, sourceChipLabel, type EvidenceView, type ExplainResponse, type PageRegionsResponse, type SourcePagesResponse } from '@medlevo/shared';
import { REPO_ROOT } from '../../src/config';
import type { AuthHeaders, TestApp } from '../helpers/app';
import { addSource, processVersion, regions, type AddedSource } from '../processing/helpers';
import { aliasFor, content, createStudyApp, S, ScriptedAi } from '../studybook/helpers';

const ACC = join(REPO_ROOT, 'fixtures', 'acceptance');
const ai = new ScriptedAi();
let t: TestApp;
let h: AuthHeaders;
let labelled: AddedSource;
let detected: AddedSource;
let unnumbered: AddedSource;

const get = async <T>(url: string): Promise<T> => (await t.app.inject({ method: 'GET', url, headers: h })).json() as T;
const post = async <T>(url: string, payload: object): Promise<{ status: number; body: T }> => {
  const res = await t.app.inject({ method: 'POST', url, headers: h, payload });
  return { status: res.statusCode, body: res.json() as T };
};
const markerRegion = (s: AddedSource, pageIndex: number, marker: string) => {
  const r = regions(t, s.versionId, pageIndex).find((x) => (x.text ?? '').includes(`Unique marker ${marker}`));
  if (!r) throw new Error(`no region with ${marker} on file page ${pageIndex + 1}`);
  return r;
};
const evidenceOf = async (regionId: string) => (await post<{ evidence: EvidenceView }>('/api/evidence/from-region', { region_id: regionId })).body.evidence;
const pageIds = (s: AddedSource) => t.ctx.db.all<{ id: string }>('SELECT id FROM source_page WHERE version_id = ? ORDER BY page_index', [s.versionId]).map((r) => r.id);

beforeAll(async () => {
  t = await createStudyApp(ai);
  labelled = await addSource(t, 'g1_front_matter_labels.pdf', 'pdf', { data: readFileSync(join(ACC, 'g1_front_matter_labels.pdf')), fileName: 'g1_front_matter_labels.pdf', title: 'G1 book with page labels (TEST FIXTURE)' });
  detected = await addSource(t, 'g1_front_matter_detected.pdf', 'pdf', { data: readFileSync(join(ACC, 'g1_front_matter_detected.pdf')), fileName: 'g1_front_matter_detected.pdf', title: 'G1 book, printed numbers only (TEST FIXTURE)' });
  unnumbered = await addSource(t, 'mixed_scanned_lecture.pdf', 'pdf', { title: 'Unnumbered lecture (TEST FIXTURE)' });
  for (const s of [labelled, detected, unnumbered]) expect((await processVersion(t, s.versionId)).status).toBe('completed');
  h = await t.login();
}, 240_000);
afterAll(async () => {
  await t?.close();
});
afterEach(() => {
  if (ai.errors.length) throw new Error(`scripted generator failed: ${ai.errors.splice(0).map(String).join(' | ')}`);
});

describe('G1 AC-04 — printed page vs file page', () => {
  it('labels are read from /PageLabels and from the printed footers; never invented for the unnumbered front matter', () => {
    const lab = t.ctx.db.all<{ printed_label: string | null; printed_label_origin: string | null }>('SELECT printed_label, printed_label_origin FROM source_page WHERE version_id = ? ORDER BY page_index', [labelled.versionId]);
    expect(lab.map((p) => p.printed_label)).toEqual(['i', 'ii', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12']);
    const det = t.ctx.db.all<{ printed_label: string | null; printed_label_origin: string | null }>('SELECT printed_label, printed_label_origin FROM source_page WHERE version_id = ? ORDER BY page_index', [detected.versionId]);
    expect(det.map((p) => p.printed_label)).toEqual([null, null, '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12']);
    expect(det.slice(2).every((p) => p.printed_label_origin === 'detected_text')).toBe(true);
  });

  it('an AI citation of the page printed 12 points at FILE page 14 (its page id), labelled with both numberings', async () => {
    const region = markerRegion(labelled, 13, 'NUTMEG');
    ai.once('explain', (req) => content([{ kind: 'paragraph', sentences: [S.c('Unique marker NUTMEG sits on file page 14 of this synthetic file.', [aliasFor(req, 'NUTMEG')], 'directly_stated')], explains_regions: [] }]));
    const res = await post<ExplainResponse>('/api/studybook/explain', {
      action: 'explain',
      style: 'detailed',
      anchor: { source_id: labelled.sourceId, version_id: labelled.versionId, page_id: region.page_id, region_ids: [region.id] },
      scope: { mode: 'lecture_only', lecture_source_id: labelled.sourceId },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const claims = Object.values(res.body.artifact.claims);
    const ev = claims.flatMap((c) => c.citations.map((x) => x.evidence)).find((e) => e.region_id === region.id)!;
    expect(ev).toBeTruthy();
    const ids = pageIds(labelled);
    expect(ev.page_id).toBe(ids[13]);
    expect(ev.page_id).not.toBe(ids[11]); // the 12th page of the file is printed «10»
    expect(ev.page_index).toBe(13);
    expect(ev.locator_label_ar).toBe('ص 12 (الصفحة 14 في الملف)');
    expect(sourceChipLabel(ev)).toBe('محاضرة ص12');
    // the stored citation row points at the same page through evidence → region → page
    const row = t.ctx.db.get<{ page_id: string }>('SELECT e.page_id FROM citation c JOIN evidence e ON e.id = c.evidence_id WHERE e.id = ?', [ev.id])!;
    expect(row.page_id).toBe(ids[13]);
  });

  it('the page the citation names is the one the reader is given (pages API): file page 14 printed 12, file page 12 printed 10', async () => {
    const r = await get<SourcePagesResponse>(`/api/sources/${labelled.sourceId}/versions/${labelled.versionId}/pages`);
    expect(r.pages[13]).toMatchObject({ page_index: 13, printed_label: '12', numbered_version: true });
    expect(r.pages[11]).toMatchObject({ page_index: 11, printed_label: '10' });
    expect(pageDisplayLabel(r.pages[13]!)).toBe('ص 12 (الصفحة 14 في الملف)');
    expect(pageDisplayLabel(r.pages[11]!)).toBe('ص 10 (الصفحة 12 في الملف)');
    expect(pageDisplayLabel(r.pages[1]!)).toBe('ص ii (الصفحة 2 في الملف)');
  });

  it('detected labels: «ص12» is file page 14; the unnumbered cover is «الصفحة 1 في الملف», never a second «ص 1»', async () => {
    const ev12 = await evidenceOf(markerRegion(detected, 13, 'NUTMEG').id);
    expect(ev12).toMatchObject({ page_index: 13, locator_label_ar: 'ص 12 (الصفحة 14 في الملف)' });
    const evCover = await evidenceOf(markerRegion(detected, 0, 'ALDER').id);
    expect(evCover.page_index).toBe(0);
    expect(evCover.locator_label_ar).toBe('الصفحة 1 في الملف');
    expect(sourceChipLabel(evCover)).toBe('محاضرة الصفحة 1 في الملف');
    const evOne = await evidenceOf(markerRegion(detected, 2, 'CEDAR').id);
    expect(evOne.locator_label_ar).toBe('ص 1 (الصفحة 3 في الملف)');
    // two different pages never share the same printed identity
    expect(sourceChipLabel(evCover)).not.toBe(sourceChipLabel(evOne));
    const pagesRes = await get<SourcePagesResponse>(`/api/sources/${detected.sourceId}/versions/${detected.versionId}/pages`);
    expect(pagesRes.pages.map((p) => pageDisplayLabel(p, { withFileIndex: false })).slice(0, 4)).toEqual(['الصفحة 1 في الملف', 'الصفحة 2 في الملف', 'ص 1', 'ص 2']);
    const regionsRes = await get<PageRegionsResponse>(`/api/sources/pages/${pagesRes.pages[0]!.id}/regions`);
    expect(regionsRes.page.numbered_version).toBe(true);
  });

  it('control: a document without any printed number keeps «ص N» (file order is its only numbering)', async () => {
    const r = regions(t, unnumbered.versionId, 2).find((x) => x.kind === 'paragraph' && x.text)!;
    const ev = await evidenceOf(r.id);
    expect(ev.locator_label_ar).toBe('ص 3');
    const pagesRes = await get<SourcePagesResponse>(`/api/sources/${unnumbered.sourceId}/versions/${unnumbered.versionId}/pages`);
    expect(pagesRes.pages.every((p) => p.numbered_version === false)).toBe(true);
    expect(pageDisplayLabel(pagesRes.pages[1]!)).toBe('ص 2');
  });
});
