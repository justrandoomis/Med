// Round 7 — H3: reader, writing & notes completeness (spec §25, §26, §28, §29), against the REAL server serving the
// built app. No AI key exists here; nothing in this spec needs one.
import type { AnnotationDTO, CardListResponse, LectureQuestionsResponse, NeedsReanchorResponse, QuestionDetailResponse } from '@medlevo/shared';
import { mouseStroke, pickInkTool, wordBox } from './g6-helpers';
import { expect, openWorkspace, screenshot, setupOwner, test } from './support';

test.describe('H3 — reader chrome on a phone', () => {
  test('item 5: the go-to popover keeps «انتقال» inside it at 360 and 390 px', async ({ page, api }, testInfo) => {
    test.skip(testInfo.project.name !== 'phone', 'phone widths only');
    await setupOwner(page);
    const { course } = await api.createNotebookAndCourse();
    const up = await api.uploadFixture(course.id, 'lecture_appendicitis.pdf', { sourceType: 'lecture', onDuplicate: 'create' });
    await api.waitForProcessing(up.version_id);
    for (const width of [360, 375, 390]) {
      await page.setViewportSize({ width, height: 780 });
      await openWorkspace(page, up.source_id);
      await page.getByRole('button', { name: /الانتقال إلى صفحة/ }).first().click();
      const dialog = page.locator('.ml-popover').filter({ has: page.locator('.wk-goto') });
      await expect(dialog).toBeVisible();
      const go = dialog.getByRole('button', { name: 'انتقال' });
      const input = dialog.getByRole('textbox', { name: 'انتقل إلى صفحة' });
      const [pop, btn, field] = await Promise.all([dialog.boundingBox(), go.boundingBox(), input.boundingBox()]);
      expect(pop && btn && field, 'boxes').toBeTruthy();
      // the button and the field lie inside the popover, and the popover inside the screen
      expect(btn!.x, `${width}px: button left`).toBeGreaterThanOrEqual(pop!.x - 0.5);
      expect(btn!.x + btn!.width, `${width}px: button right`).toBeLessThanOrEqual(pop!.x + pop!.width + 0.5);
      expect(field!.x, `${width}px: field left`).toBeGreaterThanOrEqual(pop!.x - 0.5);
      expect(field!.x + field!.width, `${width}px: field right`).toBeLessThanOrEqual(pop!.x + pop!.width + 0.5);
      expect(pop!.x).toBeGreaterThanOrEqual(0);
      expect(pop!.x + pop!.width).toBeLessThanOrEqual(width);
      // nothing inside the form overflows it either (scrollWidth == clientWidth)
      const overflow = await dialog.locator('.wk-goto').evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(overflow, `${width}px: form overflow`).toBeLessThanOrEqual(0);
      // it still works: «13» goes to the printed page 13
      await input.fill('13');
      await go.click();
      await expect(page.getByRole('button', { name: /^ص 13/ }).first()).toBeVisible();
      if (width === 360) await screenshot(page, testInfo, 'h3-goto-360');
    }
  });
});

// ───────────────────────── item 4: a card / a question from a lasso selection ─────────────────────────
const WORD = /^McBurney$/;

test.describe('H3 item 4 — lasso → card / question (no AI key on this server)', () => {
  test('a typed card (the reading is honestly unavailable), an image-occlusion card cut from the page, an owner question', async ({ page, api }, testInfo) => {
    await setupOwner(page);
    const { course } = await api.createNotebookAndCourse();
    const up = await api.uploadFixture(course.id, 'lecture_appendicitis.pdf', { sourceType: 'lecture', onDuplicate: 'create', title: `H3 lasso ${testInfo.project.name}` });
    expect((await api.waitForProcessing(up.version_id)).job?.status).toBe('completed');
    await openWorkspace(page, up.source_id, { pageIndex: 0 });

    // a diagonal pen stroke over the printed word: its box is an area of the page, not a thin line
    const span = page.locator('.wk-page[data-page-index="0"] .wk-textlayer span').filter({ hasText: WORD }).first();
    await expect(span).toBeAttached({ timeout: 30_000 });
    await span.scrollIntoViewIfNeeded();
    await pickInkTool(page, /^القلم/);
    const b = await wordBox(page, 0, WORD);
    const from = { x: b.left - 10, y: b.top - 30 };
    const to = { x: b.right + 40, y: b.bottom + 30 };
    await mouseStroke(page, from, to, 16);
    await pickInkTool(page, /التحديد الحر/);
    const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
    const selection = page.getByRole('toolbar', { name: /^إجراءات التحديد/ });
    const lassoItem = async (name: RegExp) => {
      if (!(await selection.isVisible())) await page.mouse.click(mid.x, mid.y);
      await expect(selection).toBeVisible();
      await selection.getByRole('button', { name: 'المزيد' }).click();
      await page.getByRole('menuitem', { name }).click();
    };

    await test.step('«سؤال وجواب»: «املأ الوجه من الخط المقروء» says why it is unavailable; the typed card is saved and synced', async () => {
      await lassoItem(/اصنع بطاقة من المحدد/);
      const dialog = page.getByRole('dialog', { name: 'بطاقة من المحدد' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'املأ الوجه من الخط المقروء' })).toBeDisabled();
      await expect(dialog.getByText(/vision/).first()).toBeVisible();
      await dialog.getByLabel('وجه البطاقة').fill('أين تقع نقطة McBurney؟');
      await dialog.getByLabel('ظهر البطاقة').fill('ثلث المسافة من الشوكة الحرقفية الأمامية العلوية إلى السرة');
      await screenshot(page, testInfo, 'h3-lasso-card-basic');
      await dialog.getByRole('button', { name: 'احفظ البطاقة' }).click();
      await expect(dialog.getByText('حُفظت البطاقة.')).toBeVisible();
      await expect
        .poll(async () => (await api.get<CardListResponse>(`/api/learning/cards?source_id=${up.source_id}&limit=50`)).items.filter((c) => c.kind === 'basic' && c.origin === 'owner').length, { timeout: 30_000 })
        .toBe(1);
      await dialog.getByRole('button', { name: 'تم' }).click();
    });

    await test.step('«إخفاء في صورة»: the server cuts the page area under the selection; a named mask becomes a card', async () => {
      await lassoItem(/اصنع بطاقة من المحدد/);
      const dialog = page.getByRole('dialog', { name: 'بطاقة من المحدد' });
      await dialog.getByRole('radio', { name: 'إخفاء في صورة' }).click();
      await dialog.getByRole('button', { name: 'اقطع الصورة من الصفحة' }).click();
      await expect(dialog.getByText(/صورة من الصفحة 1 في المصدر/)).toBeVisible({ timeout: 30_000 });
      const img = dialog.locator('img').first();
      await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth), { timeout: 15_000 }).toBeGreaterThan(50);
      await dialog.getByRole('button', { name: /أضف منطقة/ }).click();
      await dialog.getByLabel(/اسم المنطقة 1/).fill('McBurney');
      await screenshot(page, testInfo, 'h3-lasso-card-occlusion');
      await dialog.getByRole('button', { name: 'أنشئ البطاقة' }).click();
      await expect(dialog.getByText('حُفظت البطاقة.')).toBeVisible({ timeout: 15_000 });
      const cards = (await api.get<CardListResponse>(`/api/learning/cards?source_id=${up.source_id}&limit=50`)).items;
      const occ = cards.find((c) => c.kind === 'image_occlusion');
      expect(occ?.origin).toBe('owner');
      // the card's picture is served to the review (the crop is a stored picture of the source page)
      expect((await api.call('GET', `/api/learning/cards/${occ!.id}/review`)).status()).toBe(200);
      await dialog.getByRole('button', { name: 'تم' }).click();
    });

    await test.step('«اكتب سؤالًا من المحدد»: the owner\'s question (with the owner\'s key) is in the vault, linked to this lecture', async () => {
      await lassoItem(/اكتب سؤالًا من المحدد/);
      const dialog = page.getByRole('dialog', { name: 'سؤال من المحدد' });
      await expect(dialog.getByRole('button', { name: 'املأ السؤال من الخط المقروء' })).toBeDisabled();
      await dialog.getByLabel('نص السؤال وخياراته').fill('Tenderness at McBurney point suggests?\nA. Acute appendicitis\nB. Acute cholecystitis');
      await dialog.getByLabel(/مفتاح الإجابة/).fill('A');
      await dialog.getByRole('button', { name: 'احفظ السؤال في الخزنة' }).click();
      await expect(dialog.getByText(/أُضيف السؤال إلى خزنتك/)).toBeVisible({ timeout: 15_000 });
      const href = await dialog.getByRole('link', { name: 'افتح السؤال' }).getAttribute('href');
      const id = decodeURIComponent(href!.split('/').pop()!);
      const detail = await api.get<QuestionDetailResponse>(`/api/questions/${id}`);
      expect(detail.question.origin_type).toBe('owner');
      const linked = await api.get<LectureQuestionsResponse>(`/api/questions/for-lecture/${up.source_id}`);
      expect(linked.items.map((i) => i.question_id)).toContain(id);
      await screenshot(page, testInfo, 'h3-lasso-question');
    });
  });
});

// ───────────────────────── item 2: «تحتاج إعادة ربط» → the owner picks the new place ─────────────────────────
test.describe('H3 item 2 — manual re-anchoring in the reader', () => {
  test('an ink group whose page is gone goes to a paragraph the owner picks; a note is kept detached', async ({ page, api }, testInfo) => {
    await setupOwner(page);
    const { course } = await api.createNotebookAndCourse();
    const up = await api.uploadFixture(course.id, 'lecture_appendicitis.pdf', { sourceType: 'lecture', onDuplicate: 'create', title: `H3 reanchor ${testInfo.project.name}` });
    await api.waitForProcessing(up.version_id);
    // another device wrote on a page that this version does not have (e.g. a page removed by a new upload)
    const gone = { type: 'page', source_id: up.source_id, version_id: up.version_id, page_id: 'GONEPAGE', page_index: 40, space: 'page_norm' };
    const stamp = `${Date.now()}`;
    const ink = (n: number) => ({
      op_id: `E2EOP${stamp}${n}`,
      device_id: 'E2E_OTHER_DEVICE',
      entity_type: 'annotation',
      entity_id: `E2EINK${stamp}${n}`,
      op: 'append',
      client_ts: Date.now(),
      payload: {
        kind: 'ink', tool: 'pen', anchor: gone, layer: 'ink', z: n, locked: false,
        data: { v: 1, points: [[0.2, 0.3 + n * 0.02, 0, 0.5], [0.3, 0.31 + n * 0.02, 16, 0.5]], style: { tool: 'pen', color: 'ink-blue', width: 0.0025 }, bbox: { x: 0.2, y: 0.3 + n * 0.02, w: 0.1, h: 0.01 }, pressure_available: true, tilt_available: false },
      },
    });
    const note = {
      op_id: `E2EOP${stamp}N`, device_id: 'E2E_OTHER_DEVICE', entity_type: 'note', entity_id: `E2ENOTE${stamp}`, op: 'upsert', client_ts: Date.now(),
      payload: { node_id: null, title: null, body: { v: 1, paragraphs: [{ dir: 'rtl', runs: [{ t: 'ملاحظة على صفحة لم تعد موجودة' }] }] }, anchor: gone, origin: 'owner' },
    };
    await api.post('/api/sync/push', { ops: [ink(1), ink(2), note] });
    const before = await api.get<NeedsReanchorResponse>(`/api/annotations/needs-reanchor?source_id=${up.source_id}`);
    expect(before.items).toHaveLength(2);

    await openWorkspace(page, up.source_id, { pageIndex: 0 });
    const tab = page.getByRole('tab', { name: /ملاحظاتي/ });
    if (!(await tab.isVisible())) await page.getByRole('button', { name: 'لوحة الدراسة' }).first().click();
    await tab.click();
    await page.getByRole('radio', { name: /إعادة ربط/ }).click();
    const list = page.getByRole('list', { name: 'تحتاج إعادة ربط' });
    await expect(list).toBeVisible({ timeout: 15_000 });

    await test.step('the ink group: page 12, at a paragraph — one decision for both strokes', async () => {
      const group = list.locator('li').filter({ hasText: 'كتابة بالقلم (عنصران)' });
      await expect(group).toContainText(/مكانها السابق/);
      await group.getByRole('button', { name: 'اختر مكانها الجديد…' }).click();
      const dialog = page.getByRole('dialog', { name: /أين تضع كتابة بالقلم/ });
      await dialog.getByLabel('الصفحة').selectOption({ index: 1 });
      const para = dialog.getByRole('radio', { name: /عند الفقرة/ }).first();
      await expect(para).toBeVisible({ timeout: 15_000 });
      await para.check();
      await screenshot(page, testInfo, 'h3-reanchor-dialog');
      await dialog.getByRole('button', { name: 'اربطها هنا' }).click();
      await expect(page.getByText(/أُعيد ربط/).first()).toBeVisible({ timeout: 15_000 });
    });

    await test.step('the note: «أبقِها دون ربط» — listed apart, nothing moved', async () => {
      const row = list.locator('li').filter({ hasText: 'ملاحظة على صفحة لم تعد موجودة' });
      await row.getByRole('button', { name: 'أبقِها دون ربط' }).click();
      await expect(page.getByText(/محفوظة دون ربط \(1\)/)).toBeVisible({ timeout: 15_000 });
    });

    await test.step('server: moved with the previous anchor kept; the list is empty; both decisions audited', async () => {
      const after = await api.get<NeedsReanchorResponse>(`/api/annotations/needs-reanchor?source_id=${up.source_id}`);
      expect(after.items).toEqual([]);
      expect(after.notes ?? []).toEqual([]);
      expect(after.detached?.notes.map((n) => n.note.id)).toEqual([note.entity_id]);
      const src = await api.get<{ annotations: AnnotationDTO[] }>(`/api/annotations/source/${up.source_id}`);
      const moved = src.annotations.filter((a) => a.id.startsWith(`E2EINK${stamp}`));
      expect(moved).toHaveLength(2);
      for (const a of moved) {
        expect(a.anchor_status).toBe('reanchored');
        expect(a.anchor.type === 'page' && a.anchor.page_index).toBe(1);
        expect(a.previous_anchor && a.previous_anchor.type === 'page' && a.previous_anchor.page_id).toBe('GONEPAGE');
      }
    });
  });
});
