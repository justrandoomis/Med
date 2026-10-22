// Academic OS P1-T5 step 3 — PRD Scenario 2 «نسخ شرح طالب» against the REAL server and the built web app, phone
// 390 × 844 and desktop 1280 × 800 (BUILD_PLAN §3.7; PRD AOS-2.8, 4.1–4.3, 4.10, 4.14, 5.12, 5.24, 5.27, 21.16, Q25):
//   1. حسن writes his explanation on p.1–3 of Lecture 5 (12 strokes, 2 text boxes) in «شرحي» and publishes it course-only;
//   2. زينب (the browser under test) opens the lecture → «الشروحات» → «شرح حسن · الإصدار 1 · ص 3 من 40» → the publication
//      page (previews) → «ابدأ الدراسة بهذا الشرح» → «تابِع الشرح», carrying the 8 strokes of her «نسختي» (variant d);
//   3. she writes ink on p.2 OFFLINE (over حسن's strokes) and a sticky + a typed note, then syncs;
//   4. the layers panel shows حسن's layer read-only; a raw delete op of his stroke is refused by the server;
//   5. حسن moves one stroke, deletes another, adds 6 on p.4 and republishes with a change note;
//   6. زينب sees «تحديث متاح من حسن» → «اعرض التغييرات» («أضاف 6 عناصر في صفحة واحدة، حذف 1، عدّل 1») → «طبّق التحديث»;
//   7. variants (a) علي's fork stays on version 1, (b) هدى's auto copy updates without a tap, (c) نور skips version 2,
//      (d) above, (e) ريم reports, مصطفى (Assistant) hides with a reason — the list loses it, زينب reads why and keeps
//      what she had — then restores; «راجعه مشرف المادة» does not exist in Phase 1.
// Pass: her personal items are identical before and after the update; her followed layer equals version 2 item for item
// with v1 ids kept; only 7 rows upserted and 1 tombstoned; nothing of her personal layer reaches حسن or a non-member.
// Mouse input through Playwright: says nothing about pen latency (CAPABILITY_MATRIX §27).
import type { Locator, Page } from '@playwright/test';
import type { ApplyUpstreamResponse, LayersResponse, LecturePublicationsResponse, NotificationsResponse, PublicationItemsResponse, PublicationView } from '@medlevo/shared';
import { expect, screenshot, test, waitForWorkspace } from './support';
import { axeInLooks } from './aos-p1-channels-helpers';
import { mouseStroke, pickInkTool } from './g6-helpers';
import {
  anchorOf,
  buildAosWorld,
  copyOf,
  createLayer,
  eventually,
  fixturePages,
  inkPayload,
  itemsOf,
  layerFingerprint,
  notePayload,
  op,
  pageIds,
  publishApi,
  push,
  startCopy,
  stickyPayload,
  textBoxPayload,
  waitForOutbox,
  type AosWorld,
} from './support/aos-world';

test.use({ allowedConsoleErrors: [/ERR_INTERNET_DISCONNECTED|Failed to load resource|Failed to fetch|NetworkError|net::ERR/i] });

const summary = (page: Page, i: number) => page.locator(`.wk-page[data-page-index="${i}"] .ml-ink-layer p.ml-visually-hidden`);

async function layersPanel(page: Page): Promise<Locator> {
  const tab = page.getByRole('tab', { name: 'الطبقات' });
  if (!(await tab.isVisible())) {
    const direct = page.getByRole('button', { name: 'الصفحات والفهرس والعلامات' });
    if (await direct.count()) await direct.first().click();
    else {
      await page.getByRole('button', { name: 'خيارات القراءة' }).first().click();
      await page.getByRole('menuitem', { name: 'الصفحات والفهرس والعلامات' }).click();
    }
  }
  await tab.click();
  const panel = page.locator('.ml-layers');
  await expect(panel).toBeVisible();
  return panel;
}

test('Scenario 2: follow a classmate’s explanation, write offline, preview and apply his update — personal notes untouched', async ({ page, context, playwright, baseURL }, testInfo) => {
  test.setTimeout(600_000);
  const w: AosWorld = await buildAosWorld({
    playwright,
    baseURL: baseURL!,
    project: testInfo.project.name,
    page: { key: 'zainab', page },
    people: {
      sara: { name: 'سارة', role: 'subject_moderator' },
      mustafa: { name: 'مصطفى', role: 'assistant' },
      hasan: { name: 'حسن' },
      zainab: { name: 'زينب' },
      ali: { name: 'علي' },
      huda: { name: 'هدى' },
      noor: { name: 'نور' },
      reem: { name: 'ريم' },
      ahmad: { name: 'أحمد', outsider: true },
    },
    lecture: { title: 'Lecture 5 — Anatomy of the Abdomen', pages: fixturePages('Lecture 5', 40, 41_000), fileName: 'lecture5.pdf' },
  });
  try {
    const { hasan, zainab, ali, huda, noor, reem, mustafa, ahmad } = w.people as Record<string, NonNullable<AosWorld['people'][string]>>;

    // ── step 1: حسن's explanation (his device writes through the sync API), published course-only ──
    const hCopy = await startCopy(w, hasan!, { mode: 'personal' });
    const src = hCopy.source_id;
    const v1 = hCopy.lecture!.version_id;
    const ids = await pageIds(hasan!, src, v1);
    expect(ids).toHaveLength(40);
    const A = (p: number) => anchorOf(src, v1, ids, p);
    const hLayer = await createLayer(hasan!, src, 'شرحي');
    const hStrokes: string[] = [];
    const ops = [];
    for (let i = 0; i < 12; i++) {
      const id = `${w.stamp}H${String(i).padStart(2, '0')}`.toUpperCase();
      hStrokes.push(id);
      ops.push(op('annotation', id, inkPayload(A(Math.floor(i / 4)), 0.1 + (i % 4) * 0.15, 0.2 + (i % 4) * 0.05, hLayer), 'append'));
    }
    ops.push(op('annotation', `${w.stamp}HT1`.toUpperCase(), textBoxPayload(A(0), 'الشريان الكلوي يتفرع من الأبهر', hLayer), 'append'));
    ops.push(op('annotation', `${w.stamp}HT2`.toUpperCase(), textBoxPayload(A(2), 'انتبه للعلاقة مع الوريد', hLayer), 'append'));
    await push(hasan!, ops);
    const pub = await publishApi(w, hasan!, [hLayer], 'شرح حسن');
    expect(pub).toMatchObject({ head_version_no: 1, completeness: { pages_covered: 3, pages_total: 40 }, origin_label_ar: 'شرح طالب — ليس مصدرًا' });
    const v1Items = (await zainab!.api.get<PublicationItemsResponse>(w.S(`/publications/${pub.id}/versions/1/items`))).items.map((i) => i.id).sort();
    expect(v1Items).toHaveLength(14);

    // ── variant (d): زينب already studies the lecture with 8 strokes in «نسختي» ──
    expect((await startCopy(w, zainab!, { mode: 'personal' })).mode).toBe('personal');
    await push(zainab!, Array.from({ length: 8 }, (_, i) => op('annotation', `${w.stamp}Z8${i}`.toUpperCase(), inkPayload(A(5), 0.1, 0.1 + i * 0.08, null, 'ink-red'), 'append')));
    const before = await itemsOf(zainab!, src);
    const nusukhatiBefore = layerFingerprint(before, [null]);
    expect(before.annotations.filter((a) => !a.layer_id)).toHaveLength(8);

    // ── variants (a)–(c) before the update: a fork, an automatic follower, a follower who will skip ──
    const aliFork = await startCopy(w, ali!, { mode: 'independent_fork', publication_id: pub.id });
    const hudaCopy = await startCopy(w, huda!, { mode: 'followed', publication_id: pub.id });
    expect((await huda!.api.patch<{ update_policy: string }>(`/api/copies/${hudaCopy.id}`, { update_policy: 'auto' })).update_policy).toBe('auto');
    const noorCopy = await startCopy(w, noor!, { mode: 'followed', publication_id: pub.id });
    const aliForkBefore = layerFingerprint(await itemsOf(ali!, src), [aliFork.copied_layer_id]);

    let copyId = '';
    await test.step('2. «الشروحات» → «شرح حسن · الإصدار 1 · ص 3 من 40» → the publication page → follow it, carrying «نسختي»', async () => {
      await page.goto(`/subjects/${w.spaceId}/lectures/${w.lecture.id}`);
      await expect(page.getByRole('heading', { level: 1, name: w.lecture.title })).toBeVisible();
      await page.getByRole('tab', { name: 'الشروحات' }).click();
      await expect(page.getByRole('note').filter({ hasText: 'شروحات الطلاب ليست مصدرًا رسميًا' })).toBeVisible();
      const card = page.getByRole('link', { name: /شرح حسن/ });
      await expect(card).toBeVisible();
      await expect(card).toContainText('شرح طالب — ليس مصدرًا');
      await expect(card).toContainText('الإصدار 1');
      await expect(card).toContainText('ص 3 من 40');
      await expect(page.getByRole('button', { name: 'انشر شرحك' })).toBeVisible();
      await screenshot(page, testInfo, 'aos-s2-explanations-tab');
      expect(await axeInLooks(page, 'explanations tab')).toEqual([]);
      await card.click();
      await expect(page.getByRole('heading', { level: 1, name: 'شرح حسن' })).toBeVisible();
      await expect(page.getByText('بقلم حسن')).toBeVisible();
      await expect(page.getByText('مبني على الإصدار 1 من المحاضرة').first()).toBeVisible();
      await expect(page.locator('.pb-preview')).toHaveCount(3, { timeout: 30_000 });
      await expect(page.locator('.pb-preview path').first()).toBeAttached();
      await screenshot(page, testInfo, 'aos-s2-publication-page');
      expect(await axeInLooks(page, 'publication page')).toEqual([]);
      await page.getByRole('button', { name: 'ابدأ الدراسة بهذا الشرح' }).click();
      const dialog = page.getByRole('dialog', { name: 'ابدأ الدراسة بهذا الشرح' });
      await expect(dialog.getByRole('radio', { name: /تابِع الشرح/ })).toBeChecked();
      await dialog.getByRole('checkbox', { name: /انسخ ملاحظاتي من نسختي إليها/ }).check();
      await screenshot(page, testInfo, 'aos-s2-start-dialog');
      expect(await axeInLooks(page, 'start from explanation', '[role="dialog"]')).toEqual([]);
      await dialog.getByRole('button', { name: 'ابدأ الدراسة' }).click();
      await waitForWorkspace(page);
      copyId = new URL(page.url()).searchParams.get('copy') ?? '';
      expect(copyId).not.toBe('');
      const bar = page.getByRole('region', { name: 'نسختي من المحاضرة الرسمية' });
      await expect(bar.getByText('متابَعة: شرح حسن · حسن · الإصدار 1')).toBeVisible({ timeout: 30_000 });
      await expect(bar.getByText('الشرح مبني على الإصدار 1 من المحاضرة')).toBeVisible();
    });
    const zCopy = await copyOf(zainab!, copyId);
    expect(zCopy).toMatchObject({ mode: 'followed', source_id: src, publication: { id: pub.id, applied_version_no: 1 } });
    // variant (d): the 8 strokes exist in both copies — the new one with attribution to her earlier layer; «نسختي» unchanged
    const afterStart = await itemsOf(zainab!, src);
    expect(layerFingerprint(afterStart, [null])).toBe(nusukhatiBefore);
    const carried = afterStart.annotations.filter((a) => a.layer_id === zCopy.personal_layer_id);
    expect(carried).toHaveLength(8);
    for (const a of carried) expect(a.migrated_from_id).toBeTruthy();
    // her followed layer is حسن's version 1, under the publication's stable item ids
    const followedV1 = afterStart.annotations.filter((a) => a.layer_id === zCopy.copied_layer_id);
    expect(followedV1.map((a) => a.id).sort()).toEqual(v1Items);

    await test.step('3. ink on p.2 while OFFLINE (over حسن’s strokes) goes to her own layer; a sticky and a typed note; then sync', async () => {
      await page.goto(`/study/${src}?page=1&copy=${copyId}`);
      await waitForWorkspace(page);
      const bar = page.getByRole('region', { name: 'نسختي من المحاضرة الرسمية' });
      await expect(bar.getByText('متابَعة: شرح حسن · حسن · الإصدار 1')).toBeVisible({ timeout: 30_000 });
      await expect(summary(page, 1)).toContainText('خطوط بالقلم 4', { timeout: 60_000 });
      await context.setOffline(true);
      await pickInkTool(page, /^القلم/);
      const layer = page.locator('.wk-page[data-page-index="1"] .ml-ink-layer');
      await layer.scrollIntoViewIfNeeded();
      const b = (await layer.boundingBox())!;
      await mouseStroke(page, { x: b.x + b.width * 0.12, y: b.y + b.height * 0.27 }, { x: b.x + b.width * 0.45, y: b.y + b.height * 0.3 });
      await mouseStroke(page, { x: b.x + b.width * 0.2, y: b.y + b.height * 0.4 }, { x: b.x + b.width * 0.6, y: b.y + b.height * 0.42 });
      await expect(summary(page, 1)).toContainText('خطوط بالقلم 6');
      await screenshot(page, testInfo, 'aos-s2-offline-ink');
      await context.setOffline(false);
      await waitForOutbox(page, zainab!.userId);
    });
    const zIds = await pageIds(zainab!, src, v1);
    expect(zIds).toEqual(ids);
    await push(zainab!, [
      op('annotation', `${w.stamp}ZST`.toUpperCase(), stickyPayload(A(1), 'سر زينب: راجع هذا مع حسن', zCopy.personal_layer_id), 'append'),
      op('note', `${w.stamp}ZNT`.toUpperCase(), notePayload(A(1), `سر زينب ${w.stamp} ملاحظتي على الصفحة 2`, zCopy.personal_layer_id)),
    ]);
    const mine = await itemsOf(zainab!, src);
    const offlineInk = mine.annotations.filter((a) => a.layer_id === zCopy.personal_layer_id && a.kind === 'ink' && !a.migrated_from_id);
    expect(offlineInk, 'the two offline strokes reached the server in HER layer of the followed copy').toHaveLength(2);
    const personalBefore = layerFingerprint(mine, [zCopy.personal_layer_id, null]);

    await test.step('4. حسن’s layer is read-only in the panel; a raw delete of his stroke is refused by the server', async () => {
      const panel = await layersPanel(page);
      const his = panel.locator(`li.ml-layer[data-layer-id="${zCopy.copied_layer_id}"]`);
      await expect(his).toBeVisible({ timeout: 30_000 });
      await expect(his.getByText('للقراءة فقط')).toBeVisible();
      await expect(his.getByText('من شرح حسن — الإصدار 1')).toBeVisible();
      await expect(his.getByRole('radio')).toHaveCount(0);
      const [r] = await push(zainab!, [op('annotation', followedV1.find((a) => a.kind === 'ink')!.id, {}, 'delete', 1)], false);
      expect(r!.result).toBe('rejected');
      expect(r!.detail_code).toBe('layer_read_only');
      // hide / show his layer in this session
      await his.getByRole('button', { name: /^أخفِ طبقة «شرح حسن»/ }).click();
      await expect(summary(page, 0)).toContainText('وفي طبقات مخفية');
      await his.getByRole('button', { name: /^أظهر طبقة «شرح حسن»/ }).click();
      await expect(summary(page, 0)).not.toContainText('وفي طبقات مخفية');
    });

    // ── step 5: حسن moves one stroke, deletes another, adds 6 on p.4, republishes with a change note ──
    await push(hasan!, [
      op('annotation', hStrokes[0]!, inkPayload(A(0), 0.5, 0.6, hLayer), 'upsert', 1),
      op('annotation', hStrokes[1]!, {}, 'delete', 1),
      ...Array.from({ length: 6 }, (_, i) => op('annotation', `${w.stamp}H4${i}`.toUpperCase(), inkPayload(A(3), 0.1, 0.1 + i * 0.1, hLayer), 'append')),
    ]);
    const before6 = layerFingerprint(await itemsOf(zainab!, src), [zCopy.copied_layer_id]);
    const v2 = await hasan!.api.post<PublicationView>(w.S(`/publications/${pub.id}/versions`), { layer_ids: [hLayer], change_note: 'أضفت مخطط الشرايين في الصفحة 4' });
    expect(v2.head_version_no).toBe(2);
    const v2Items = (await zainab!.api.get<PublicationItemsResponse>(w.S(`/publications/${pub.id}/versions/2/items`))).items.map((i) => i.id).sort();
    expect(v2Items).toHaveLength(19);

    await test.step('6. «تحديث متاح من حسن» → «اعرض التغييرات» (nothing changed yet) → «طبّق التحديث»', async () => {
      // variant (b): هدى's automatic copy is updated by the server without a tap
      await eventually(() => copyOf(huda!, hudaCopy.id), (c) => c.publication?.applied_version_no === 2 && c.pending_version_no === null, 'هدى’s auto copy applied version 2');
      await eventually(() => copyOf(zainab!, copyId), (c) => c.pending_version_no === 2, 'زينب’s copy has version 2 pending');
      expect(layerFingerprint(await itemsOf(zainab!, src), [zCopy.copied_layer_id]), 'before the tap nothing in her copy changed').toBe(before6);
      const inbox = await zainab!.api.get<NotificationsResponse>('/api/notifications');
      expect(inbox.items.find((n) => n.kind === 'publication_updated')?.text_ar).toBeTruthy();
      await page.goto(`/study/${src}?copy=${copyId}`);
      await waitForWorkspace(page);
      const bar = page.getByRole('region', { name: 'نسختي من المحاضرة الرسمية' });
      await expect(bar.getByText('تحديث متاح من حسن: الإصدار 2')).toBeVisible({ timeout: 30_000 });
      await bar.getByRole('button', { name: 'اعرض التغييرات' }).click();
      const dialog = page.getByRole('dialog', { name: 'تحديث الشرح' });
      await expect(dialog.getByText('حسن: أضاف 6 عناصر في صفحة واحدة، حذف 1، عدّل 1')).toBeVisible();
      await expect(dialog.getByText('ملاحظة الكاتب: أضفت مخطط الشرايين في الصفحة 4')).toBeVisible();
      await expect(dialog.getByText(/ملاحظاتك الشخصية: لا يتغيّر منها أي عنصر/)).toBeVisible();
      await expect(dialog.getByRole('list', { name: 'الصفحات التي تتغير' }).getByRole('listitem')).not.toHaveCount(0);
      // the changes are drawn on the pages: 6 added (solid), 1 changed (dashed), 1 removed (dotted), named in words
      const drawn = dialog.getByRole('list', { name: 'التغييرات على الصفحات' });
      await expect(drawn.locator('.pb-preview__mark--added')).toHaveCount(6);
      await expect(drawn.locator('.pb-preview__mark--changed')).toHaveCount(1);
      await expect(drawn.locator('.pb-preview__mark--removed')).toHaveCount(1);
      await expect(drawn.getByText(/أُضيف 6 \(خط متصل\)/)).toBeVisible();
      await screenshot(page, testInfo, 'aos-s2-update-preview');
      expect(await axeInLooks(page, 'update preview', '[role="dialog"]')).toEqual([]);
      const applied = page.waitForResponse((r) => r.url().endsWith(`/api/copies/${copyId}/upstream/apply`) && r.request().method() === 'POST');
      await dialog.getByRole('button', { name: 'طبّق التحديث' }).click();
      const res = (await (await applied).json()) as ApplyUpstreamResponse;
      expect(res.applied, 'only the changed and added items written, the removed one tombstoned').toEqual({ upserted: 7, tombstoned: 1 });
      await expect(bar.getByText('تحديث متاح من حسن: الإصدار 2')).toBeHidden();
      await expect(bar.getByText('متابَعة: شرح حسن · حسن · الإصدار 2')).toBeVisible();
    });

    // pass conditions
    const after = await itemsOf(zainab!, src);
    expect(layerFingerprint(after, [zCopy.personal_layer_id, null]), 'her personal items are identical before and after the update').toBe(personalBefore);
    const followed = after.annotations.filter((a) => a.layer_id === zCopy.copied_layer_id).map((a) => a.id).sort();
    expect(followed, 'her followed layer equals version 2 item for item').toEqual(v2Items);
    for (const id of v1Items.filter((i) => v2Items.includes(i))) expect(followed).toContain(id);
    expect(after.annotations.some((a) => /تعارض/.test(JSON.stringify(a.data)))).toBe(false);
    const layers = await zainab!.api.get<LayersResponse>(`/api/annotations/layers?document_key=${encodeURIComponent(`source:${src}`)}`);
    expect(layers.layers.find((l) => l.id === zCopy.copied_layer_id)).toMatchObject({ kind: 'followed', title: 'شرح حسن', access: 'read_only', origin: { version_no: 2 } });

    await test.step('7. variants (a) fork pinned to version 1, (c) skip, and the leak checks', async () => {
      expect(layerFingerprint(await itemsOf(ali!, src), [aliFork.copied_layer_id]), 'علي’s fork still equals version 1').toBe(aliForkBefore);
      await eventually(() => copyOf(noor!, noorCopy.id), (c) => c.pending_version_no === 2, 'نور has version 2 pending');
      const skipped = await noor!.api.post<ApplyUpstreamResponse>(`/api/copies/${noorCopy.id}/upstream/apply`, { version_no: 2, skip: true });
      expect(skipped.skipped).toBe(true);
      expect(skipped.copy.publication).toMatchObject({ applied_version_no: 1 });
      expect(skipped.copy.publication!.status_note_ar).toContain('بقيت نسختك على الإصدار 1 من الشرح');
      // حسن and أحمد (another subject) get nothing of her personal layer
      const secret = `سر زينب ${w.stamp}`;
      const hasanSees = JSON.stringify(await itemsOf(hasan!, src));
      for (const a of after.annotations.filter((x) => x.layer_id === zCopy.personal_layer_id || !x.layer_id)) expect(hasanSees).not.toContain(a.id);
      // (the answer echoes the query itself; no RESULT may carry her words)
      const search = (await (await hasan!.api.call('GET', `/api/search?q=${encodeURIComponent(secret)}`)).json()) as { results: unknown[] };
      expect(JSON.stringify(search.results)).not.toContain(secret);
      const missing = await ahmad!.api.call('GET', w.S(`/publications/NOPE${w.stamp}`));
      const hidden = await ahmad!.api.call('GET', w.S(`/publications/${pub.id}`));
      expect(hidden.status()).toBe(missing.status());
      expect(await hidden.text()).toBe(await missing.text());
    });

    await test.step('7e. ريم reports; مصطفى (Assistant) hides it with a reason, then restores it; no «راجعه مشرف المادة»', async () => {
      const report = await reem!.api.post<{ id: string }>('/api/moderation/reports', { target: { db: 'system', type: 'publication', id: pub.id }, reason: 'wrong_content', note: 'السهم في الصفحة 1 خاطئ' });
      await mustafa!.api.post('/api/moderation/actions', { report_id: report.id, action: 'hide', reason_ar: 'معلومة خاطئة في الصفحة 1.' });
      const list = await zainab!.api.get<LecturePublicationsResponse>(w.S(`/lectures/${w.lecture.id}/publications`));
      expect(list.items.map((p) => p.id)).toEqual([]);
      await page.goto(`/subjects/${w.spaceId}/lectures/${w.lecture.id}?tab=explanations`);
      await expect(page.getByText('لا توجد شروحات منشورة لهذه المحاضرة بعد.')).toBeVisible();
      await page.goto(`/study/${src}?copy=${copyId}`);
      await waitForWorkspace(page);
      const bar = page.getByRole('region', { name: 'نسختي من المحاضرة الرسمية' });
      await expect(bar.getByText(/أخفى المشرف هذا الشرح: معلومة خاطئة في الصفحة 1\./)).toBeVisible({ timeout: 30_000 });
      await expect(bar.getByRole('switch', { name: 'طبّق تحديثات الشرح تلقائيًا' })).toHaveCount(0);
      await screenshot(page, testInfo, 'aos-s2-hidden');
      expect((await itemsOf(zainab!, src)).annotations.filter((a) => a.layer_id === zCopy.copied_layer_id)).toHaveLength(19);
      const told = async (who: typeof hasan) => (await who!.api.get<NotificationsResponse>('/api/notifications')).items.some((n) => n.kind === 'moderation');
      await eventually(() => told(hasan), Boolean, 'حسن is told');
      await eventually(() => told(reem), Boolean, 'ريم is told');
      const reviewed = await mustafa!.api.call('POST', '/api/moderation/actions', { target: { db: 'system', type: 'publication', id: pub.id }, action: 'mark_reviewed', reason_ar: 'راجعته' });
      expect(reviewed.status()).toBe(400);
      await mustafa!.api.post('/api/moderation/actions', { target: { db: 'system', type: 'publication', id: pub.id }, action: 'restore', reason_ar: 'صُحّح الخطأ.' });
      expect((await zainab!.api.get<LecturePublicationsResponse>(w.S(`/lectures/${w.lecture.id}/publications`))).items.map((p) => p.id)).toEqual([pub.id]);
      await page.reload();
      await waitForWorkspace(page);
      await expect(bar.getByText('متابَعة: شرح حسن · حسن · الإصدار 2')).toBeVisible({ timeout: 30_000 });
      await expect(bar.getByText(/أخفى المشرف/)).toHaveCount(0);
    });
  } finally {
    await w.dispose();
  }
});
