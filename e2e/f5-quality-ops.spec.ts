// F5 — Quality ops against the REAL server (built web app, production server, no AI key):
//  1. client error tracking: an error and an unhandled rejection raised in the page reach the server REDACTED (no
//     quoted document text, no e-mail, no token), grouped, and are listed in the Control Center «صحة النظام» next to the
//     daily trend sentences; the owner clears the log through a confirm dialog;
//  2. evaluation: «تقييم الجودة» explains how to run `npm run eval`; the REAL CLI then evaluates a subset (bidi cases)
//     and records the report in this server's database; the screen shows rates with their denominators — never «100%»
//     — and the Markdown report downloads;
//  3. DOCX export: «بياناتك» → «التصدير» → questions as Word (DOCX) downloads a real Word file (RTL paragraphs).
// The synthetic errors are DISPATCHED events (not real uncaught exceptions), so the console guard stays strict.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import JSZip from 'jszip';
import type { ClientErrorsResponse, EvaluationOverviewResponse } from '@medlevo/shared';
import { E2E_TMP_DIR, REPO_ROOT } from './support/paths';
import { expect, screenshot, serverFor, setupOwner, test } from './support';

const QUOTED = 'The appendix is a blind-ended tube connected to the cecum';

test('F5: a page error reaches «صحة النظام» redacted, next to the daily trends; the owner clears the log', async ({ page, api }, testInfo) => {
  await setupOwner(page);
  await page.goto('/control');
  // the section list (on a wide screen the side navigation carries the same links)
  const healthLink = page.getByRole('link', { name: /^صحة النظام ما منعه التحقق/ });
  await expect(healthLink).toBeVisible();
  await expect(page.getByRole('link', { name: /^تقييم الجودة آخر تقييم/ })).toBeVisible();

  await test.step('an error event and an unhandled rejection are reported (redacted, batched)', async () => {
    await page.evaluate((quoted) => {
      const err = new Error(`F5 e2e synthetic failure while rendering "${quoted}" for owner@example.com`);
      window.dispatchEvent(new ErrorEvent('error', { message: err.message, error: err }));
      window.dispatchEvent(new ErrorEvent('error', { message: err.message, error: err })); // the same problem again → one row, count 2
      window.dispatchEvent(
        new PromiseRejectionEvent('unhandledrejection', { promise: Promise.resolve(), reason: new TypeError('F5 e2e synthetic rejection token=abc123secret') }),
      );
      // leaving the page flushes the batch (keepalive); otherwise it goes within 5 s
      window.dispatchEvent(new Event('pagehide'));
    }, QUOTED);
    await expect.poll(async () => (await api.get<ClientErrorsResponse>('/api/control/client-errors')).items.length, { timeout: 20_000 }).toBe(2);
    const { items } = await api.get<ClientErrorsResponse>('/api/control/client-errors');
    const failure = items.find((i) => i.message.includes('F5 e2e synthetic failure'))!;
    expect(failure.kind).toBe('error');
    expect(failure.count).toBe(2);
    expect(failure.message).toContain('[quoted-text]');
    expect(failure.message).toContain('[email]');
    expect(failure.message).not.toContain('cecum');
    expect(failure.message).not.toContain('owner@example.com');
    expect(failure.route).toBe('/control');
    const rejection = items.find((i) => i.kind === 'unhandledrejection')!;
    expect(rejection.message).toContain('token=[redacted]');
    expect(rejection.message).not.toContain('abc123secret');
  });

  await test.step('«صحة النظام»: trend sentences with their denominators, the error list, the strip hidden from AT', async () => {
    await healthLink.click();
    await expect(page.getByRole('heading', { name: 'صحة النظام', level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'يومًا بيوم' })).toBeVisible();
    for (const label of ['استشهادات مرفوضة', 'جمل لم يثبتها الدليل', 'تغييرات رفضها الخادم', 'تعارضات حُفظت فيها النسختان']) {
      await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
    }
    await expect(page.getByText(/^لا شيء في آخر 14 يومًا \(فُحص 0\)\.$/).first()).toBeVisible();
    // the strips are decoration: the numbers are in the sentences and in the table
    await expect(page.locator('svg.cc-strip').first()).toHaveAttribute('aria-hidden', 'true');
    await page.getByText('الأرقام يومًا بيوم').click();
    await expect(page.getByRole('region', { name: 'الأعداد اليومية' })).toBeVisible();

    await expect(page.getByRole('heading', { name: 'أخطاء الواجهة المسجلة' })).toBeVisible();
    await expect(page.getByText(/F5 e2e synthetic failure/)).toBeVisible();
    await expect(page.getByText('2 مرات', { exact: false })).toBeVisible();
    await expect(page.getByText('عملية لم تكتمل (وعد مرفوض)')).toBeVisible();
    await expect(page.getByText('cecum')).toHaveCount(0);
    await screenshot(page, testInfo, 'f5-health');
  });

  await test.step('clearing the log asks first, then the list is empty', async () => {
    await page.getByRole('button', { name: 'امسح السجل' }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('لا يمس هذا أي ملاحظة');
    await dialog.getByRole('button', { name: 'امسح السجل' }).click();
    await expect(page.getByText('لا أخطاء مسجلة')).toBeVisible();
    expect((await api.get<ClientErrorsResponse>('/api/control/client-errors')).items).toHaveLength(0);
  });
});

test('F5: «تقييم الجودة» — how to run, then a real `npm run eval` report with denominators (never «100%»)', async ({ page, api }, testInfo) => {
  test.setTimeout(300_000);
  await setupOwner(page);
  const before = await api.get<EvaluationOverviewResponse>('/api/control/evaluation');
  await page.goto('/control/evaluation');
  await expect(page.getByRole('heading', { name: 'تقييم الجودة', level: 1 })).toBeVisible();
  if (!before.latest) {
    await expect(page.getByRole('heading', { name: 'لم يُسجَّل تقييم بعد' })).toBeVisible();
    await expect(page.getByText(/npm run eval/)).toBeVisible();
    await expect(page.getByText(new RegExp(`الكتالوج الحالي: ${before.catalogue.cases} حالة`))).toBeVisible();
    await screenshot(page, testInfo, 'f5-evaluation-empty');
  }

  const { dataDir } = serverFor(testInfo.project.name);
  test.skip(!dataDir, 'an external server (E2E_BASE_URL): its database is not reachable from here');

  await test.step('the real CLI evaluates the bidi cases and records the run in this server', async () => {
    const out = join(E2E_TMP_DIR, `eval-${testInfo.project.name}`);
    const res = spawnSync('npm', ['run', 'eval', '--', '--only=bidi.', `--data-dir=${dataDir}`, `--out=${out}`, '--label=e2e-f5'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 240_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    await testInfo.attach('npm-run-eval.log', { body: `${res.stdout}\n${res.stderr}`, contentType: 'text/plain' });
    expect(res.status, res.stderr.slice(-2000)).toBe(0);
    expect(res.stdout).toContain('recorded in');
    const latest = JSON.parse(readFileSync(join(out, 'latest.json'), 'utf8')) as { run_id: string; cases: unknown[] };
    expect(latest.cases.length).toBeGreaterThan(0);
  });

  await test.step('the screen shows the report: per-axis rates with denominators and intervals, no «100%»', async () => {
    await page.reload();
    await expect(page.getByRole('heading', { name: 'آخر تقييم' })).toBeVisible();
    const overview = await api.get<EvaluationOverviewResponse>('/api/control/evaluation');
    const r = overview.latest!;
    expect(r.label).toBe('e2e-f5');
    const bidi = r.axes.find((a) => a.axis === 'rtl_bidi')!;
    const total = bidi.regression.total + bidi.tuning.total;
    expect(total).toBeGreaterThan(0);
    const table = page.getByRole('region', { name: 'نتائج المحاور' });
    await expect(table).toBeVisible();
    await expect(table.getByRole('rowheader', { name: /تنسيق العربية والإنجليزية/ })).toBeVisible();
    // a rate is always «passed / total» (+ the interval), small samples say so
    await expect(table.getByText(new RegExp(`${bidi.regression.passed} / ${bidi.regression.total}`)).first()).toBeVisible();
    await expect(page.getByText(/عينة صغيرة/).first()).toBeVisible();
    await expect(page.locator('main')).not.toContainText(/100\s*[%٪]/);
    await expect(page.getByText('e2e-f5')).toBeVisible();
    // the full Markdown report downloads from the server
    const md = await page.request.get(`/api/control/evaluation/runs/${encodeURIComponent(r.run_id)}/report.md`);
    expect(md.status()).toBe(200);
    expect(md.headers()['content-type']).toContain('text/markdown');
    expect(await md.text()).toContain(r.run_id);
    await expect(page.getByRole('link', { name: 'نزّل التقرير الكامل (Markdown)' })).toHaveAttribute('href', new RegExp(`${r.run_id}/report\\.md$`));
    await screenshot(page, testInfo, 'f5-evaluation-report');
  });
});

test('F5: questions export as Word (DOCX) from «بياناتك» → «التصدير»', async ({ page, api }, testInfo) => {
  test.setTimeout(300_000);
  await setupOwner(page);
  const { course } = await api.createNotebookAndCourse();
  const title = `Bank F5 ${Date.now().toString(36)}`;
  const bank = await api.uploadFixture(course.id, 'questions_surgery_course1.pdf', { sourceType: 'question_source', onDuplicate: 'create', title });
  await api.waitForProcessing(bank.version_id, { questions: true });

  await page.goto('/offline?tab=export');
  await expect(page.getByRole('tab', { name: 'التصدير' })).toHaveAttribute('aria-selected', 'true');
  await page.getByLabel('ما الذي تصدّره').selectOption({ label: 'الأسئلة' });
  await page.getByLabel('من أي مصدر (اختياري)').selectOption({ label: title });
  await page.getByRole('radio', { name: 'Word (DOCX)' }).click();
  await expect(page.getByRole('radio', { name: 'Word (DOCX)' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByText(/دون روابط/).first()).toBeVisible();
  await screenshot(page, testInfo, 'f5-export-docx');

  const download = page.waitForEvent('download');
  const response = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/data/export/questions');
  await page.getByRole('button', { name: 'نزّل الملف' }).click();
  const res = await response;
  expect(res.headers()['content-type']).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  expect(decodeURIComponent(/filename\*=UTF-8''([^;]+)/.exec(res.headers()['content-disposition'] ?? '')?.[1] ?? '')).toBe(`أسئلة - ${title}.docx`);
  const file = await download;
  // the browser keeps that name — except a Chromium without a UTF-8 locale (this container: LANG unset), which cannot
  // represent an Arabic file name and falls back to «download» (measured with a standalone probe; not an app issue)
  if (/utf-?8/i.test(`${process.env.LC_ALL ?? ''}${process.env.LANG ?? ''}`)) expect(file.suggestedFilename()).toBe(`أسئلة - ${title}.docx`);
  const path = join(E2E_TMP_DIR, `f5-${testInfo.project.name}.docx`);
  await file.saveAs(path);
  const zip = await JSZip.loadAsync(readFileSync(path));
  const xml = await zip.file('word/document.xml')!.async('string');
  expect(xml).toContain('<w:bidi/>');
  expect(xml).toContain('يتضمن هذا الملف الحلول');
  expect(xml).not.toContain('<w:hyperlink');
  await expect(page.getByText('جُهّز الملف للحفظ على جهازك.')).toBeVisible();
});
