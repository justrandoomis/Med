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
import { CSRF_HEADERS, expect, openWorkspace, screenshot, setupOwner, test, waitForWorkspace } from './support';
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
    // (review F1) a link drawn smaller than a finger keeps a 44 px touch area around it
    await link.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    const lb = (await link.boundingBox())!;
    const edgeY = lb.height < 44 ? lb.y - (44 - lb.height) / 2 + 2 : lb.y + 2;
    const hit = await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      return el?.closest('.ml-ink-link') ? 'link' : `${el?.tagName ?? 'none'}.${el?.className ?? ''}`;
    }, { x: lb.x + lb.width / 2, y: edgeY });
    expect(hit, `touch area of the link (height ${lb.height})`).toBe('link');
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
  // (review F1) the reader opens the page it just added (the reading line is on it)
  await expect(page.locator('.wk-note-chip').first()).toHaveText('صفحة ملاحظات بعدها');
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

  // (review F1) the reading place follows its PAGE when the note pages load after the first layout (they come from
  // IndexedDB / the server a moment later): opened at the 2nd page (the note page sits before it), the reader stays
  // there — and saves that place. (Not the 3rd of 4: near the end of a book the reading line slides down, and a
  // restored offset there lands one page later even without note pages — a separate, pre-existing reader issue.)
  const indicator = page.locator('.wk-pageind').first();
  await openWorkspace(page, up.source_id, { pageIndex: 1 });
  await expect(indicator).toHaveAttribute('aria-label', /، 2 من 4\./);
  await page.waitForTimeout(2000); // note pages loaded, the session saved (debounced)
  await expect(indicator).toHaveAttribute('aria-label', /، 2 من 4\./);
  await page.goto(`/study/${up.source_id}`); // no place in the URL: the saved session decides
  await waitForWorkspace(page);
  await page.waitForTimeout(1000);
  await expect(indicator).toHaveAttribute('aria-label', /، 2 من 4\./);
});

/**
 * A small digital PDF (TEST FIXTURE) whose first page carries two real Link annotations: an internal one to page 3
 * (explicit destination) and an external URI. Built by hand (byte offsets in the xref), so no fixture file is needed.
 */
function linkedPdf(externalUrl: string): Buffer {
  const lines = (n: number) => [`TEST FIXTURE - linked document, page ${n}.`, `Synthetic structural text for automated tests (page ${n}).`, 'Not a medical reference.'];
  const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const content = (n: number, extra: string[] = []) => {
    const body = [...lines(n), ...extra].map((t, i) => `BT /F1 14 Tf 72 ${780 - i * 40} Td (${esc(t)}) Tj ET`).join('\n');
    return `<< /Length ${Buffer.byteLength(body, 'latin1')} >>\nstream\n${body}\nendstream`;
  };
  // page 1: the two link areas sit on the 4th and 5th text lines (y = 660 and 620)
  const objs: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 6 0 R >> >> /Contents 7 0 R /Annots [10 0 R 11 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 6 0 R >> >> /Contents 8 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 6 0 R >> >> /Contents 9 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    content(1, ['Go to the third page (internal link).', 'Visit the external site (external link).']),
    content(2),
    content(3, ['Third page: the internal link lands here.']),
    // objects 10 and 11: the two Link annotations of page 1
    '<< /Type /Annot /Subtype /Link /Rect [66 652 420 680] /Border [0 0 0] /Dest [5 0 R /XYZ null null null] >>',
    `<< /Type /Annot /Subtype /Link /Rect [66 612 420 640] /Border [0 0 0] /A << /S /URI /URI (${esc(externalUrl)}) >> >>`,
  ];
  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

test('PDF links: an internal link opens its page (Back returns); an external URL opens only after an explicit confirmation (review F1)', async ({ page, api, context }, testInfo) => {
  test.setTimeout(4 * 60_000);
  await setupOwner(page);
  const { course } = await api.createNotebookAndCourse();
  const external = 'https://example.org/medlevo-e2e?from=pdf';
  const res = await page.request.post('/api/sources/upload', {
    headers: { ...CSRF_HEADERS },
    multipart: {
      node_id: course.id,
      source_type: 'lecture',
      title: `F1 PDF links ${testInfo.project.name}`,
      on_duplicate: 'create',
      files: { name: 'linked.pdf', mimeType: 'application/pdf', buffer: linkedPdf(external) },
    },
  });
  expect(res.ok(), await res.text()).toBe(true);
  const up = ((await res.json()) as { results: Array<{ source_id: string; version_id: string }> }).results[0]!;
  expect((await api.waitForProcessing(up.version_id)).job?.status).toBe('completed');

  // every request the browser makes to the external site is recorded (none may happen before the confirmation)
  const externalRequests: string[] = [];
  context.on('request', (r) => {
    if (r.url().startsWith('https://example.org/')) externalRequests.push(r.url());
  });
  await context.route('https://example.org/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>external</title>' }));

  await openWorkspace(page, up.source_id, { pageIndex: 0 });
  const indicator = page.locator('.wk-pageind').first();
  await expect(indicator).toHaveAttribute('aria-label', /، 1 من 3\./);
  const firstPage = page.locator('.wk-page[data-page-index="0"]');

  // internal: «رابط داخلي إلى الصفحة 3 في الملف» → page 3, Back returns to page 1
  const internal = firstPage.getByRole('button', { name: 'رابط داخلي إلى الصفحة 3 في الملف' });
  await expect(internal).toHaveCount(1, { timeout: 30_000 });
  await internal.click();
  await expect(indicator).toHaveAttribute('aria-label', /، 3 من 3\./);
  await page.getByRole('button', { name: 'العودة إلى موضعك' }).first().click();
  await expect(indicator).toHaveAttribute('aria-label', /، 1 من 3\./);

  // external: a confirmation first — cancelling opens nothing; confirming opens a NEW window (no opener)
  const ext = firstPage.getByRole('button', { name: 'رابط خارجي: example.org' });
  await ext.scrollIntoViewIfNeeded();
  await ext.click();
  const confirm = page.getByRole('alertdialog', { name: 'فتح رابط خارجي؟' });
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText('الخادم لا يزوره ولا يجلب محتواه');
  await expect(confirm).toContainText(external);
  await screenshot(page, testInfo, 'f1-pdf-external-confirm');
  await confirm.getByRole('button', { name: 'إلغاء' }).click();
  await expect(confirm).toHaveCount(0);
  expect(externalRequests, 'nothing was requested from the external site before a confirmation').toEqual([]);
  expect(context.pages()).toHaveLength(1);

  await ext.click();
  const popupPromise = context.waitForEvent('page');
  await page.getByRole('alertdialog', { name: 'فتح رابط خارجي؟' }).getByRole('button', { name: 'افتح في نافذة جديدة' }).click();
  const popup = await popupPromise;
  await popup.waitForLoadState('domcontentloaded');
  expect(popup.url()).toBe(external);
  expect(await popup.evaluate(() => window.opener)).toBeNull();
  await popup.close();
  // the reader did not move
  await expect(indicator).toHaveAttribute('aria-label', /، 1 من 3\./);
});
