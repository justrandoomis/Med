// Academic OS P1-T2 step 3 against the REAL server (built web app, production server), phone 390 × 844 and desktop:
// «انقل ملاحظاتي إلى الإصدار الجديد» — Scenario 4, the note side, inside one vault (PRD AOS-3.13, 4.17, 4.20, Q35).
//
// A 40-page lecture v1 carries the owner's ink on p.5, a text highlight on p.12, a note on p.30 and a note on p.36.
// A renamed v2 arrives with 2 pages inserted after p.10, p.30 rewritten AND p.36 moved up to p.27 (TEST FIXTURE with
// Scenario 4's structure and its own text, apps/server/test/fixtures/note-migration/build.ts — its own text and a
// per-run tag keep it from matching e2e/aos-p1-versions.spec.ts's lecture on the shared per-project server). The owner
// accepts it as version 2 (P1-T3's flow, here by API; its
// UI is covered by e2e/aos-p1-versions.spec.ts) and opens the lecture:
//   1. the reader offers the migration with a preview; nothing changes before the tap;
//   2. ONE tap copies the ink to v2 p.5 and the highlight to v2 p.14; the report says 2 moved, 2 need review, 0 kept;
//   3. the review list (Round 7's «إعادة ربط», as a copy) shows both notes with their old page and the candidate side by
//      side; the moved p.36 note follows to p.27 with one tap on the candidate; the rewritten p.30 note is placed by the
//      owner through the place dialog;
//   4. the v1 rows are identical before and after everything (copy, never move); counts before = moved + review + kept;
//   5. one-step undo tombstones the tap's copies only; a new tap revives them; a second tap is a no-op.
// The items are written through the sync API as a device would (drawing on a canvas is covered by the ink suites).
import type { Page } from '@playwright/test';
import type { AnnotationDTO, ImportSuggestionListResponse, NoteDTO, PageRegionsResponse, ReanchorCopyPreview, ReanchorCopyRunResponse, SourceAnnotationsResponse, SourceDetail, SourceIdentityResponse, SourcePagesResponse, UploadResponse } from '@medlevo/shared';
import { ownLectureV1, ownLectureV2, reorderedPageOf } from '../apps/server/test/fixtures/note-migration/build';
import { CSRF_HEADERS, expect, openWorkspace, screenshot, setupOwner, test, type E2eApi } from './support';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitAnalysis(api: E2eApi, sourceId: string): Promise<void> {
  for (let i = 0; ; i++) {
    const id = await api.get<SourceIdentityResponse>(`/api/versions/sources/${sourceId}/identity`);
    if (id.analysis?.state === 'ready') return;
    if (i > 240) throw new Error(`analysis did not finish: ${JSON.stringify(id.analysis)}`);
    await sleep(500);
  }
}

async function uploadPdf(page: Page, nodeId: string, title: string, name: string, buffer: Buffer): Promise<{ source_id: string; version_id: string }> {
  const res = await page.request.post('/api/sources/upload', { headers: { ...CSRF_HEADERS }, multipart: { node_id: nodeId, title, files: { name, mimeType: 'application/pdf', buffer } } });
  expect(res.ok(), await res.text()).toBe(true);
  const r = ((await res.json()) as UploadResponse).results[0]!;
  expect(r.status).toBe('accepted');
  return { source_id: r.source_id!, version_id: r.version_id! };
}

/** 44 px touch targets for this step's controls, and named controls (the repository has no axe-core) */
async function probe(page: Page): Promise<{ unnamed: string[]; small: string[] }> {
  return page.evaluate(() => {
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    };
    const ours = Array.from(document.querySelectorAll('.ml-migrate-banner button, .ml-migrate-review button, .ml-migrate-review a[href], [role="dialog"] .ml-migrate button, [role="dialog"] button')).filter(visible);
    const name = (el: Element) => (el.getAttribute('aria-label') ?? (el as HTMLElement).innerText ?? '').trim();
    return {
      unnamed: ours.filter((el) => !name(el)).map((el) => el.outerHTML.slice(0, 80)),
      small: ours.filter((el) => el.tagName === 'BUTTON' && el.getBoundingClientRect().height < 43.5).map((el) => `${(el as HTMLElement).innerText.trim().slice(0, 30)} (${Math.round(el.getBoundingClientRect().height)}px)`),
    };
  });
}

test('P1-T2 step 3: notes are copied, never moved, to a new version whose pages were inserted and reordered', async ({ page, api }, testInfo) => {
  test.setTimeout(420_000);
  await setupOwner(page);
  const { course } = await api.createNotebookAndCourse();
  const stamp = `${Date.now().toString(36)}-${testInfo.project.name}`;
  const title = `TEST FIXTURE Abdomen Lecture 7 ${stamp}`;
  const phone = testInfo.project.name === 'phone';

  // ── version 1, processed and analysed ──
  const v1 = await uploadPdf(page, course.id, title, 'Abdomen Lecture 7.pdf', ownLectureV1(`TEST FIXTURE note migration v1 ${stamp}`));
  await api.waitForProcessing(v1.version_id);
  await waitAnalysis(api, v1.source_id);
  const v1Pages = (await api.get<SourcePagesResponse>(`/api/sources/${v1.source_id}/versions/${v1.version_id}/pages`)).pages;
  expect(v1Pages).toHaveLength(40);
  const anchor = (p: number) => ({ type: 'page', source_id: v1.source_id, version_id: v1.version_id, page_id: v1Pages[p - 1]!.id, page_index: p - 1, space: 'page_norm' });

  // ── the owner's items on v1 (as a device writes them) ──
  const regions = await api.get<PageRegionsResponse>(`/api/sources/pages/${v1Pages[11]!.id}/regions`);
  const para = regions.regions.find((r) => r.kind !== 'heading' && r.kind !== 'header' && r.kind !== 'footer' && !!r.text && !!r.bbox)!;
  const quote = para.text!.replace(/\s+/g, ' ').trim().slice(0, 40).trim();
  const ids = { ink: `E2EINK${stamp.replace(/[^A-Za-z0-9]/g, '')}`, hl: `E2EHL${stamp.replace(/[^A-Za-z0-9]/g, '')}`, n30: `E2EN30${stamp.replace(/[^A-Za-z0-9]/g, '')}`, n36: `E2EN36${stamp.replace(/[^A-Za-z0-9]/g, '')}` };
  const op = (entity_type: string, entity_id: string, payload: unknown, kind: 'append' | 'upsert' = 'upsert') => ({ op_id: `OP${entity_id}`, device_id: 'E2E_DEVICE', entity_type, entity_id, op: kind, client_ts: Date.now(), payload });
  const rt = (t: string) => ({ v: 1, paragraphs: [{ dir: 'rtl', runs: [{ t }] }] });
  await api.post('/api/sync/push', {
    ops: [
      op('annotation', ids.ink, { kind: 'ink', tool: 'pen', anchor: anchor(5), layer: 'ink', z: 0, locked: false, data: { v: 1, points: [[0.2, 0.3, 0, 0.5], [0.35, 0.32, 16, 0.6]], style: { tool: 'pen', color: 'ink-blue', width: 0.0025 }, bbox: { x: 0.2, y: 0.3, w: 0.15, h: 0.02 }, pressure_available: true, tilt_available: false } }, 'append'),
      op('annotation', ids.hl, { kind: 'text_highlight', tool: 'highlight', anchor: anchor(12), layer: 'highlight', z: 0, locked: false, data: { v: 1, style: 'highlight', color: 'marker-yellow', rects: [{ x: para.bbox!.x, y: para.bbox!.y, w: para.bbox!.w, h: Math.min(0.02, para.bbox!.h) }], quote: { exact: quote } } }, 'append'),
      op('note', ids.n30, { node_id: null, title: null, body: rt('ملاحظتي على صفحة جدار البطن 30'), anchor: anchor(30), origin: 'owner' }),
      op('note', ids.n36, { node_id: null, title: null, body: rt('ملاحظتي على الصفحة 36 التي نُقلت'), anchor: anchor(36), origin: 'owner' }),
    ],
  });
  const v1State = async () => {
    const s = await api.get<SourceAnnotationsResponse>(`/api/annotations/source/${v1.source_id}?version_id=${v1.version_id}`);
    const mine = new Set(Object.values(ids));
    return JSON.stringify({ a: s.annotations.filter((a) => mine.has(a.id)).sort((x, y) => x.id.localeCompare(y.id)), n: s.notes.filter((n) => mine.has(n.id)).sort((x, y) => x.id.localeCompare(y.id)) });
  };
  const before = await v1State();
  expect(JSON.parse(before).a).toHaveLength(2);
  expect(JSON.parse(before).n).toHaveLength(2);

  // ── version 2 (inserted + reordered), accepted as a new version of the lecture ──
  const up = await uploadPdf(page, course.id, `${title} (upload)`, 'Abdomen lec7 final (1).pdf', ownLectureV2(`TEST FIXTURE note migration v2 ${stamp}`));
  await api.waitForProcessing(up.version_id);
  let suggestionId: string | null = null;
  for (let i = 0; !suggestionId; i++) {
    const open = await api.get<ImportSuggestionListResponse>('/api/versions/suggestions?status=open');
    suggestionId = open.suggestions.find((s) => s.field === 'new_version_of' && s.value.field === 'new_version_of' && s.value.source_id === v1.source_id)?.id ?? null;
    if (i > 240) throw new Error('no «إصدار جديد من …» proposal');
    if (!suggestionId) await sleep(500);
  }
  await api.post(`/api/versions/suggestions/${suggestionId}/decide`, { action: 'accept' });
  const detail = await api.get<SourceDetail>(`/api/sources/${v1.source_id}`);
  const v2Id = detail.current_version_id!;
  expect(detail.versions.map((v) => v.version_no).sort()).toEqual([1, 2]);
  await api.waitForProcessing(v2Id);
  let preview: ReanchorCopyPreview | null = null;
  for (let i = 0; preview?.state !== 'ready'; i++) {
    preview = await api.get<ReanchorCopyPreview>(`/api/annotations/reanchor-copy?source_id=${v1.source_id}`);
    if (i > 240) throw new Error(`page map not ready: ${JSON.stringify(preview)}`);
    if (preview.state !== 'ready') await sleep(500);
  }
  expect(preview).toMatchObject({ total: 4, copy: 2, needs_review: 2, kept: 0, already_moved: 0, summary_ar: 'سيُنقل 2 · يحتاج مراجعة 2 · يبقى على الإصدار 1: 0' });
  expect(await v1State()).toBe(before);

  await test.step('the reader offers the migration; the preview changes nothing', async () => {
    await openWorkspace(page, v1.source_id);
    const banner = page.locator('.ml-migrate-banner');
    await expect(banner).toContainText('يوجد إصدار أحدث من المحاضرة', { timeout: 30_000 });
    await expect(banner).toContainText('سيُنقل 2 · يحتاج مراجعة 2 · يبقى على الإصدار 1: 0');
    await banner.getByRole('button', { name: 'معاينة النقل…' }).click();
    const dialog = page.getByRole('dialog', { name: 'انقل ملاحظاتي إلى الإصدار 2' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/نسخ، لا نقل/)).toBeVisible();
    const pages = dialog.getByRole('list', { name: 'الصفحات التي تُنسخ إليها' });
    await expect(pages.getByRole('listitem')).toHaveCount(2);
    await expect(pages.getByRole('listitem').nth(1)).toContainText('ص 12 في الإصدار 1');
    await expect(pages.getByRole('listitem').nth(1)).toContainText(`ص ${reorderedPageOf(12)} في الإصدار 2`);
    const p = await probe(page);
    expect(p.unnamed).toEqual([]);
    if (phone) expect(p.small, 'touch targets under 44 px').toEqual([]);
    await screenshot(page, testInfo, 'aos-p1-note-migration-preview');
    // still nothing written
    expect(await v1State()).toBe(before);
    const src = await api.get<SourceAnnotationsResponse>(`/api/annotations/source/${v1.source_id}?version_id=${v2Id}`);
    expect(src.annotations.filter((a) => a.migrated_from_id)).toEqual([]);
  });

  await test.step('ONE tap copies the ink to v2 p.5 and the highlight to v2 p.14; the report counts everything', async () => {
    const dialog = page.getByRole('dialog', { name: 'انقل ملاحظاتي إلى الإصدار 2' });
    await dialog.getByRole('button', { name: 'انقل ملاحظاتي إلى الإصدار 2' }).click();
    const report = page.getByRole('dialog', { name: 'تقرير نقل الملاحظات' });
    await expect(report).toBeVisible({ timeout: 30_000 });
    await expect(report.getByRole('status').filter({ hasText: 'نُقل عنصران إلى صفحتين؛ عنصران يحتاجان مراجعتك؛ لا شيء بقي على الإصدار السابق' })).toBeVisible();
    await expect(report.getByText('قبل النقل: 4 = نُقل 2 + تحتاج مراجعة 2 + بقي 0. لم يُحذف شيء من الإصدار 1.')).toBeVisible();
    await screenshot(page, testInfo, 'aos-p1-note-migration-report');
    await page.emulateMedia({ colorScheme: 'dark' });
    await screenshot(page, testInfo, 'aos-p1-note-migration-report-dark');
    await page.emulateMedia({ colorScheme: 'light' });

    const v2 = await api.get<SourceAnnotationsResponse>(`/api/annotations/source/${v1.source_id}?version_id=${v2Id}`);
    const copy = (from: string) => v2.annotations.find((a: AnnotationDTO) => a.migrated_from_id === from);
    expect(copy(ids.ink)).toMatchObject({ origin: 'reanchor_copy', anchor_status: 'reanchored', anchor: { version_id: v2Id, page_index: reorderedPageOf(5) - 1 }, previous_anchor: anchor(5) });
    expect(copy(ids.hl)).toMatchObject({ origin: 'reanchor_copy', anchor: { version_id: v2Id, page_index: reorderedPageOf(12) - 1 } });
    expect(v2.notes.filter((n: NoteDTO) => n.migrated_from_id)).toEqual([]);
    expect(await v1State()).toBe(before);
  });

  await test.step('review: the moved p.36 note follows to p.27 with one tap; the rewritten p.30 note goes where the owner picks', async () => {
    const report = page.getByRole('dialog', { name: 'تقرير نقل الملاحظات' });
    await report.getByRole('button', { name: 'راجع العناصر (2)' }).click();
    const list = page.getByRole('list', { name: 'تحتاج مراجعة من الإصدار 1' });
    await expect(list).toBeVisible({ timeout: 30_000 });
    await expect(list.getByRole('listitem')).toHaveCount(2);
    const moved = list.getByRole('listitem').filter({ hasText: 'ملاحظتي على الصفحة 36 التي نُقلت' });
    await expect(moved).toContainText('صفحتها انتقلت إلى موضع آخر');
    await expect(moved.getByRole('img', { name: /من الإصدار 1/ })).toBeVisible();
    await expect(moved.getByRole('img', { name: /من الإصدار 2/ })).toBeVisible();
    await screenshot(page, testInfo, 'aos-p1-note-migration-review');
    const p = await probe(page);
    expect(p.unnamed).toEqual([]);
    if (phone) expect(p.small, 'touch targets under 44 px').toEqual([]);
    await moved.getByRole('button', { name: /^انسخها إلى / }).click();
    await expect(page.locator('.ml-toast').filter({ hasText: /نُسخت الملاحظة إلى «.+» في الإصدار 2\. بقي الأصل على الإصدار 1 كما هو\./ })).toBeVisible({ timeout: 15_000 });
    await expect(list.getByRole('listitem')).toHaveCount(1, { timeout: 15_000 });

    const changed = list.getByRole('listitem').filter({ hasText: 'ملاحظتي على صفحة جدار البطن 30' });
    await expect(changed).toContainText('تغيّر نص صفحتها');
    await changed.getByRole('button', { name: 'اختر مكانها…' }).click();
    const place = page.getByRole('dialog', { name: 'أين تنسخ الملاحظة في الإصدار 2؟' });
    await expect(place).toBeVisible();
    await expect(place.getByLabel('الصفحة', { exact: true })).toHaveValue(String(reorderedPageOf(30) - 1));
    await place.getByRole('button', { name: 'انسخها هنا' }).click();
    // (the open dialog makes the page inert: wait for it to close before reading the list)
    await expect(place).toBeHidden({ timeout: 15_000 });
    await expect(page.locator('.ml-toast').filter({ hasText: /نُسخت الملاحظة إلى/ })).toHaveCount(2, { timeout: 15_000 });
    await expect(page.getByRole('list', { name: 'تحتاج مراجعة من الإصدار 1' })).toHaveCount(0, { timeout: 15_000 });

    const v2 = await api.get<SourceAnnotationsResponse>(`/api/annotations/source/${v1.source_id}?version_id=${v2Id}`);
    const note = (from: string) => v2.notes.find((n) => n.migrated_from_id === from);
    expect(note(ids.n36)?.anchor).toMatchObject({ version_id: v2Id, page_index: reorderedPageOf(36) - 1 });
    expect(note(ids.n30)?.anchor).toMatchObject({ version_id: v2Id, page_index: reorderedPageOf(30) - 1 });
    const after = await api.get<ReanchorCopyPreview>(`/api/annotations/reanchor-copy?source_id=${v1.source_id}`);
    expect(after).toMatchObject({ total: 4, copy: 0, already_moved: 4, needs_review: 0, kept: 0 });
    expect(after.total).toBe(after.copy + after.already_moved + after.needs_review + after.kept);
    expect(await v1State()).toBe(before);
  });

  await test.step('one-step undo tombstones the tap’s copies only; a new tap revives them; a second tap is a no-op', async () => {
    const pv = await api.get<ReanchorCopyPreview>(`/api/annotations/reanchor-copy?source_id=${v1.source_id}`);
    expect(pv.last_run).toMatchObject({ kind: 'run', copied: 2, undone_at: null });
    // the banner keeps the report of the tap made here; its undo (on a phone the study panel is a sheet over the page:
    // it is closed first, as the owner would)
    if (phone) {
      const sheet = page.getByRole('dialog', { name: 'لوحة الدراسة' });
      await sheet.getByRole('button', { name: 'إغلاق', exact: true }).click();
      await expect(sheet).toBeHidden();
    }
    const banner = page.locator('.ml-migrate-banner');
    await banner.getByRole('button', { name: 'التقرير…' }).click();
    const report = page.getByRole('dialog', { name: 'تقرير نقل الملاحظات' });
    await report.getByRole('button', { name: 'تراجع عن النقل' }).click();
    await expect(report.getByRole('status').filter({ hasText: 'تراجعت عن هذا النقل: حُذفت 2 من النسخ' })).toBeVisible({ timeout: 15_000 });
    await report.getByRole('button', { name: 'تم' }).click();
    const v2 = await api.get<SourceAnnotationsResponse>(`/api/annotations/source/${v1.source_id}?version_id=${v2Id}`);
    expect(v2.annotations.filter((a) => a.migrated_from_id && !a.deleted_at)).toEqual([]);
    // the review copies are their own decisions: still there
    expect(v2.notes.filter((n) => n.migrated_from_id && !n.deleted_at)).toHaveLength(2);
    expect(await v1State()).toBe(before);

    const again = await api.post<ReanchorCopyRunResponse>('/api/annotations/reanchor-copy', { source_id: v1.source_id, from_version_id: v1.version_id, to_version_id: v2Id });
    expect(again.report).toMatchObject({ copied: 2, already_moved: 2, total: 4 });
    const noop = await api.post<ReanchorCopyRunResponse>('/api/annotations/reanchor-copy', { source_id: v1.source_id, from_version_id: v1.version_id, to_version_id: v2Id });
    expect(noop.report).toMatchObject({ id: null, copied: 0, already_moved: 4, needs_review: 0, kept: 0, total: 4 });
    const v2b = await api.get<SourceAnnotationsResponse>(`/api/annotations/source/${v1.source_id}?version_id=${v2Id}`);
    expect(v2b.annotations.filter((a) => a.migrated_from_id && !a.deleted_at)).toHaveLength(2);
    expect(await v1State()).toBe(before);
  });

  await test.step('on version 1 the reader says it is an earlier version and opens version 2', async () => {
    await openWorkspace(page, v1.source_id, { versionId: v1.version_id });
    const banner = page.locator('.ml-migrate-banner');
    await expect(banner).toContainText('تقرأ الإصدار 1', { timeout: 30_000 });
    await screenshot(page, testInfo, 'aos-p1-note-migration-earlier');
    await banner.getByRole('button', { name: 'افتح الإصدار 2' }).click();
    await expect(page).toHaveURL(new RegExp(`/study/${v1.source_id}\\?v=${v2Id}`));
  });
});
