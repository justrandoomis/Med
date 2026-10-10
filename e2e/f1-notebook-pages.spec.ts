// F1 — notebook pages & writing surfaces (§26, §25, §5) against the REAL server and the built app.
//  1. A notebook page: created from the library («دفتر الملاحظات»), ruled paper, ink written with the pen (mouse —
//     never reported as a pen, AC-28), a picture inserted with the image tool (file picker), a second page, a page link
//     drawn with the link tool that opens page 2 and «العودة إلى موضعك» returns. Everything is on the server (pages,
//     strokes, the image annotation AND its uploaded bytes), survives a reload, and the notebook opens OFFLINE from this
//     device (service worker allowed); a page written offline reaches the server once the connection returns.
//  2. The reader: a note page inserted after a lecture page («صفحة ملاحظات بعد هذه الصفحة…») sits between the source
//     pages, takes ink, and is still there after a reload.
import type { AnnotationDTO, NotebookContentResponse, NotePageView, SourceAnnotationsResponse } from '@medlevo/shared';
import type { Locator, Page } from '@playwright/test';
import { deflateSync, crc32 } from 'node:zlib';
import { expect, openWorkspace, screenshot, setupOwner, test, waitForWorkspace } from './support';
import { mouseStroke, pickInkTool, viewMenuItem } from './g6-helpers';

// offline, the browser reports the failing background requests (sync, capabilities) as console errors — expected here
test.use({ serviceWorkers: 'allow', allowedConsoleErrors: [/ERR_INTERNET_DISCONNECTED|Failed to load resource|Failed to fetch|NetworkError|net::ERR/i] });

/** A real PNG (colour blocks) for the image tool. */
function png(w = 120, h = 80): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = y * (1 + w * 3) + 1 + x * 3;
      raw[o] = x < w / 2 ? 40 : 200;
      raw[o + 1] = y < h / 2 ? 90 : 160;
      raw[o + 2] = 120;
    }
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const notePage = (page: Page, id?: string) => (id ? page.locator(`.wk-page--note[data-note-page-id="${id}"]`) : page.locator('.wk-page--note'));

/** Painted pixels of the committed-ink canvas inside a page group. */
async function inkPixels(group: Locator): Promise<number> {
  return group.locator('canvas.ml-ink-layer__canvas:not(.ml-ink-layer__canvas--highlight):not(.ml-ink-layer__canvas--live)').evaluate((c: HTMLCanvasElement) => {
    const ctx = c.getContext('2d');
    if (!ctx || !c.width || !c.height) return 0;
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let n = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i]! > 40) n++;
    return n;
  });
}

/** The part of a note sheet visible inside the scrolling canvas (fractions below are of this box, so input never lands on the bars). */
async function sheetBox(group: Locator) {
  const sheet = group.locator('.wk-sheet');
  await sheet.scrollIntoViewIfNeeded();
  const b = await sheet.boundingBox();
  const c = await group.page().locator('.wk-canvas').first().boundingBox();
  if (!b || !c) throw new Error('note sheet has no box');
  const top = Math.max(b.y, c.y);
  const bottom = Math.min(b.y + b.height, c.y + c.height);
  return { x: b.x, width: b.width, y: top, height: Math.max(40, bottom - top) };
}

async function waitForSync(page: Page) {
  // the outbox drains (save status «تمت المزامنة») — polled through IndexedDB, not the label
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            new Promise<number>((resolve) => {
              const open = indexedDB.open('medlevo');
              open.onsuccess = () => {
                const req = open.result.transaction('outbox', 'readonly').objectStore('outbox').getAll();
                req.onsuccess = () => {
                  resolve((req.result as Array<{ status: string }>).filter((o) => o.status === 'pending').length);
                  open.result.close();
                };
              };
              open.onerror = () => resolve(-1);
            }),
        ),
      { timeout: 30_000, message: 'outbox drained' },
    )
    .toBe(0);
}

test('notebook page: ruled paper, ink, a picture and a page link persist on the server, after a reload and offline', async ({ page, api, context }, testInfo) => {
  test.setTimeout(6 * 60_000);
  await setupOwner(page);
  const { notebook } = await api.createNotebookAndCourse();
  const nodeId = notebook.id;

  await test.step('create a ruled page from the library («دفتر الملاحظات»)', async () => {
    await page.goto(`/library/${nodeId}`);
    await expect(page.getByRole('heading', { name: 'دفتر الملاحظات' })).toBeVisible();
    await page.getByRole('button', { name: 'صفحة ملاحظات جديدة' }).click();
    const dialog = page.getByRole('dialog', { name: 'صفحة ملاحظات جديدة' });
    await dialog.getByRole('radio', { name: 'مسطّرة' }).click();
    await dialog.getByLabel('عنوان الصفحة (اختياري)').fill('خلاصة التهاب الزائدة');
    await dialog.getByRole('button', { name: 'أضف الصفحة' }).click();
    await expect(page).toHaveURL(/\/notebook\//);
    await expect(notePage(page)).toHaveCount(1);
    await expect(notePage(page).locator('.wk-sheet--note')).toHaveAttribute('data-template', 'ruled');
  });
  const p1 = (await notePage(page).first().getAttribute('data-note-page-id'))!;

  await test.step('write with the pen on the note page', async () => {
    await pickInkTool(page, /^القلم/);
    const b = await sheetBox(notePage(page, p1));
    await mouseStroke(page, { x: b.x + b.width * 0.2, y: b.y + b.height * 0.25 }, { x: b.x + b.width * 0.7, y: b.y + b.height * 0.3 });
    await expect.poll(() => inkPixels(notePage(page, p1)), { message: 'ink painted on the note page' }).toBeGreaterThan(50);
  });

  let imageKey = '';
  await test.step('insert a picture with the image tool (file picker); the page itself is not changed', async () => {
    await pickInkTool(page, /^إدراج صورة/);
    const b = await sheetBox(notePage(page, p1));
    await page.mouse.click(b.x + b.width * 0.5, b.y + b.height * 0.55);
    const card = page.getByRole('group', { name: 'إدراج صورة هنا' });
    await expect(card).toBeVisible();
    await card.getByLabel('اختر صورة من الجهاز').setInputFiles({ name: 'diagram.png', mimeType: 'image/png', buffer: png() });
    const fig = notePage(page, p1).locator('figure.ml-ink-image');
    await expect(fig).toHaveCount(1);
    await expect(fig.locator('img')).toBeVisible();
    expect(await fig.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(120);
    imageKey = (await fig.getAttribute('data-image-key'))!;
    expect(imageKey).toBeTruthy();
  });

  let p2 = '';
  await test.step('a second page (grid) for the link to open', async () => {
    await page.getByRole('button', { name: 'صفحة جديدة' }).click();
    const dialog = page.getByRole('dialog', { name: 'صفحة ملاحظات جديدة' });
    await dialog.getByRole('radio', { name: 'مربعات' }).click();
    await dialog.getByLabel('عنوان الصفحة (اختياري)').fill('الصفحة الثانية');
    await dialog.getByRole('button', { name: 'أضف الصفحة' }).click();
    await expect(notePage(page)).toHaveCount(2);
    p2 = (await notePage(page).nth(1).getAttribute('data-note-page-id'))!;
    expect(p2).not.toBe(p1);
  });

  await test.step('draw a link on page 1 with the link tool → page 2', async () => {
    await pickInkTool(page, /^رابط إلى صفحة/);
    const b = await sheetBox(notePage(page, p1));
    await mouseStroke(page, { x: b.x + b.width * 0.15, y: b.y + b.height * 0.12 }, { x: b.x + b.width * 0.55, y: b.y + b.height * 0.18 });
    const dialog = page.getByRole('dialog', { name: 'إلى أين يقود الرابط؟' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('صفحة الملاحظات').selectOption({ label: 'الصفحة الثانية' });
    await dialog.getByLabel('نص الرابط على الصفحة (اختياري)').fill('انظر المخطط');
    await dialog.getByRole('button', { name: 'أنشئ الرابط' }).click();
    await expect(notePage(page, p1).locator('.ml-ink-link')).toHaveCount(1);
    await screenshot(page, testInfo, 'f1-notebook-written');
  });

  await test.step('follow the link with the hand tool; «العودة إلى موضعك» returns', async () => {
    await pickInkTool(page, /^اليد/);
    const link = notePage(page, p1).getByRole('button', { name: /^رابط: انظر المخطط/ });
    await link.scrollIntoViewIfNeeded();
    await link.click();
    await expect(page.locator('.nb-bar__where')).toHaveText('صفحة 2 من 2');
    await page.getByRole('button', { name: 'العودة إلى موضعك' }).click();
    await expect(page.locator('.nb-bar__where')).toHaveText('صفحة 1 من 2');
  });

  await test.step('everything reached the server, the picture bytes included', async () => {
    await waitForSync(page);
    await expect
      .poll(async () => {
        const nb = await api.get<NotebookContentResponse>(`/api/annotations/notebook/${nodeId}`);
        return [nb.note_pages.length, ...['ink', 'image', 'link'].map((k) => nb.annotations.filter((a) => a.kind === k).length)].join(',');
      })
      .toBe('2,1,1,1');
    const nb = await api.get<NotebookContentResponse>(`/api/annotations/notebook/${nodeId}`);
    const link = nb.annotations.find((a) => a.kind === 'link')!;
    expect((link.data as { target: unknown }).target).toEqual({ type: 'note_page', note_page_id: p2 });
    expect(nb.note_pages.find((p: NotePageView) => p.id === p1)).toMatchObject({ template: 'ruled', title: 'خلاصة التهاب الزائدة', node_id: nodeId });
    await expect.poll(async () => (await api.call('GET', `/api/annotations/images/${imageKey}`)).status(), { timeout: 30_000, message: 'picture uploaded' }).toBe(200);
  });

  await test.step('reload: paper, ink, picture and link are still there', async () => {
    await page.reload();
    await expect(notePage(page)).toHaveCount(2);
    await expect(notePage(page, p1).locator('figure.ml-ink-image img')).toBeVisible();
    await expect(notePage(page, p1).locator('.ml-ink-link')).toHaveCount(1);
    await expect.poll(() => inkPixels(notePage(page, p1))).toBeGreaterThan(50);
  });

  await test.step('offline: the notebook opens from this device; a page written offline syncs when back online', async () => {
    await context.setOffline(true);
    await page.reload();
    await expect(notePage(page)).toHaveCount(2, { timeout: 30_000 });
    await expect(notePage(page, p1).locator('figure.ml-ink-image img')).toBeVisible();
    await expect.poll(() => inkPixels(notePage(page, p1))).toBeGreaterThan(50);
    await page.getByRole('button', { name: 'صفحة جديدة' }).click();
    const dialog = page.getByRole('dialog', { name: 'صفحة ملاحظات جديدة' });
    await dialog.getByRole('radio', { name: 'منقّطة' }).click();
    await dialog.getByRole('button', { name: 'أضف الصفحة' }).click();
    await expect(notePage(page)).toHaveCount(3);
    // «صفحة جديدة» inserts after the current page (page 1 after «العودة»): the new one sits between pages 1 and 2
    const ids = await notePage(page).evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.notePageId!));
    const p3 = ids.find((id) => id !== p1 && id !== p2)!;
    expect(ids).toEqual([p1, p3, p2]);
    await pickInkTool(page, /^القلم/);
    const b = await sheetBox(notePage(page, p3));
    await mouseStroke(page, { x: b.x + b.width * 0.3, y: b.y + b.height * 0.3 }, { x: b.x + b.width * 0.6, y: b.y + b.height * 0.5 });
    await expect.poll(() => inkPixels(notePage(page, p3))).toBeGreaterThan(50);
    await screenshot(page, testInfo, 'f1-notebook-offline');
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect
      .poll(
        async () => {
          const nb = await api.get<NotebookContentResponse>(`/api/annotations/notebook/${nodeId}`);
          return `${nb.note_pages.length},${nb.annotations.filter((a: AnnotationDTO) => a.kind === 'ink').length}`;
        },
        { timeout: 60_000, message: 'the offline page and its stroke reached the server' },
      )
      .toBe('3,2');
  });
});

test('reader: a note page inserted after a lecture page sits in the page sequence, takes ink and survives a reload', async ({ page, api }, testInfo) => {
  test.setTimeout(5 * 60_000);
  await setupOwner(page);
  const { course } = await api.createNotebookAndCourse();
  const up = await api.uploadFixture(course.id, 'lecture_appendicitis.pdf', { sourceType: 'lecture', onDuplicate: 'create', title: `F1 reader ${testInfo.project.name}` });
  expect((await api.waitForProcessing(up.version_id)).job?.status).toBe('completed');
  await openWorkspace(page, up.source_id, { pageIndex: 0 });

  await viewMenuItem(page, 'صفحة ملاحظات بعد هذه الصفحة…');
  const dialog = page.getByRole('dialog', { name: 'صفحة ملاحظات جديدة' });
  await dialog.getByRole('radio', { name: 'منقّطة' }).click();
  await dialog.getByRole('button', { name: 'أضف الصفحة' }).click();
  const note = page.locator('.wk-page--note');
  await expect(note).toHaveCount(1);
  // between source page 1 (index 0) and page 2 (index 1) in the canvas
  const order = await page.locator('.wk-canvas [data-seq]').evaluateAll((els) =>
    els.map((e) => ({ seq: Number((e as HTMLElement).dataset.seq), kind: (e as HTMLElement).dataset.notePageId ? 'note' : `p${(e as HTMLElement).dataset.pageIndex}` })).sort((a, b) => a.seq - b.seq).map((x) => x.kind),
  );
  expect(order.slice(0, 3)).toEqual(['p0', 'note', 'p1']);

  await pickInkTool(page, /^القلم/);
  const b = await sheetBox(note);
  await mouseStroke(page, { x: b.x + b.width * 0.25, y: b.y + b.height * 0.3 }, { x: b.x + b.width * 0.75, y: b.y + b.height * 0.35 });
  await expect.poll(() => inkPixels(note)).toBeGreaterThan(50);
  await waitForSync(page);
  const ann = await api.get<SourceAnnotationsResponse>(`/api/annotations/source/${up.source_id}?version_id=${up.version_id}`);
  expect(ann.note_pages).toHaveLength(1);
  expect(ann.note_pages[0]).toMatchObject({ template: 'dotted', after_page_index: 0 });
  expect(ann.annotations.filter((a) => a.anchor.type === 'note_page')).toHaveLength(1);
  await screenshot(page, testInfo, 'f1-reader-note-page');

  await page.reload();
  await waitForWorkspace(page);
  await expect(page.locator('.wk-page--note')).toHaveCount(1);
  await page.locator('.wk-page--note').scrollIntoViewIfNeeded();
  await expect.poll(() => inkPixels(page.locator('.wk-page--note'))).toBeGreaterThan(50);
});
