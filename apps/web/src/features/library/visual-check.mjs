// DEV-ONLY visual check of the library / upload / sources screens against a REAL MedLevo server
// (not part of the build). Start the server with a throwaway data dir and the built web, e.g.:
//   NODE_ENV=production MEDLEVO_DATA_DIR=/tmp/x MEDLEVO_PORT=18911 MEDLEVO_ORIGIN=http://127.0.0.1:18911 \
//   MEDLEVO_WEB_DIST=apps/web/dist npx tsx apps/server/src/index.ts
//   node apps/web/src/features/library/visual-check.mjs http://127.0.0.1:18911 /tmp/shots
// Creates the owner through the API, builds a small library, uploads Golden Set fixtures through the
// real upload screen, then screenshots each screen at 390×844 and 1280×800 in light and dark.
// Fails on console errors, page errors and horizontal overflow.
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { chromium, request as pwRequest } from '@playwright/test';

const base = process.argv[2] ?? 'http://127.0.0.1:18911';
const out = resolve(process.argv[3] ?? 'test-screenshots/library');
const GOLDEN = resolve(new URL('../../../../../fixtures/golden', import.meta.url).pathname);
mkdirSync(out, { recursive: true });
const problems = [];
const log = (...a) => console.log(...a);

// ───────── owner + library via the API ─────────
const api = await pwRequest.newContext({ baseURL: base, extraHTTPHeaders: { 'x-medlevo-csrf': '1' } });
const must = async (res, what) => {
  if (!res.ok()) throw new Error(`${what}: ${res.status()} ${await res.text()}`);
  return res.json();
};
const status = await must(await api.get('/api/auth/status'), 'status');
if (status.setup_required) await must(await api.post('/api/auth/setup', { data: { username: 'owner', password: 'quiet library pages 42' } }), 'setup');
else await must(await api.post('/api/auth/login', { data: { username: 'owner', password: 'quiet library pages 42' } }), 'login');
const node = async (body) => (await must(await api.post('/api/library/nodes', { data: { parent_id: null, kind: 'folder', ...body } }), 'node')).node;
const surgery = await node({ kind: 'notebook', title: 'الجراحة', cover: { style: 'linen', color: 'rose', symbol: 'syringe' } });
const course = await node({ kind: 'course', title: 'Course 1 — البطن الحاد', parent_id: surgery.id, cover: { style: 'grid', color: 'slate', symbol: 'book' } });
const lectures = await node({ title: 'المحاضرات', parent_id: course.id });
const refs = await node({ title: 'المراجع', parent_id: course.id });
const qs = await node({ title: 'مصادر الأسئلة', parent_id: course.id });
await node({ kind: 'notebook', title: 'الأدوية', cover: { style: 'dots', color: 'teal', symbol: 'pill' }, is_favorite: true });
await node({ kind: 'notebook', title: 'Internal medicine — الباطنية', cover: { style: 'linen', color: 'indigo', symbol: 'stethoscope' } });
await must(await api.post('/api/library/nodes/from-template', { data: { template_key: 'anatomy', parent_id: null } }), 'template');
const old = await node({ kind: 'notebook', title: 'ملخصات السنة الماضية', cover: { style: 'plain', color: 'amber', symbol: 'book' } });
const tag = (await must(await api.post('/api/library/tags', { data: { name: 'مهم للامتحان', color: 'amber' } }), 'tag')).tag;
await must(await api.post(`/api/library/tags/${tag.id}/links`, { data: { entity_type: 'library_node', entity_id: surgery.id } }), 'tag link');

const uploadApi = async (nodeId, name) =>
  (
    await must(
      await api.post('/api/sources/upload', { multipart: { node_id: nodeId, files: { name, mimeType: 'application/octet-stream', buffer: readFileSync(join(GOLDEN, name)) } } }),
      `upload ${name}`,
    )
  ).results[0];
const refSrc = await uploadApi(refs.id, 'lecture_notes_shock.docx');
const qSrc = await uploadApi(qs.id, 'questions_surgery_course1.pdf');
await uploadApi(lectures.id, 'slides_shock.pptx');
// something in the trash
const trashMe = await node({ title: 'مسودة قديمة', parent_id: old.id });
await uploadApi(trashMe.id, 'low_quality_scan.png');
await must(await api.post(`/api/library/nodes/${trashMe.id}/trash`, { data: {} }), 'trash');
const state = await api.storageState();

// ───────── browser ─────────
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const COMBOS = [
  { name: 'phone', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
  { name: 'desktop', viewport: { width: 1280, height: 800 } },
];
let firstPdfSourceId = null;
let firstPdfVersionId = null;

for (const combo of COMBOS) {
  for (const scheme of ['light', 'dark']) {
    const tag = `${combo.name}-${scheme}`;
    const ctx = await browser.newContext({ ...combo, colorScheme: scheme, storageState: state, serviceWorkers: 'block', locale: 'ar' });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => problems.push(`${tag} pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error' && !/status of (401|404|409)/.test(m.text())) problems.push(`${tag} console: ${m.text()}`);
    });
    const shot = async (name, opts = {}) => {
      await page.waitForTimeout(250);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (overflow > 1) problems.push(`${tag} ${name}: horizontal overflow ${overflow}px`);
      await page.screenshot({ path: join(out, `${name}-${tag}.png`), fullPage: opts.fullPage ?? true });
      log('  shot', `${name}-${tag}.png`);
    };

    // shelf
    await page.goto(`${base}/library`);
    await page.getByRole('heading', { level: 1, name: 'المكتبة' }).waitFor();
    await page.locator('.ml-shelf').waitFor();
    await shot('library-shelf');

    // upload screen with real uploads (a fresh unique PNG each run so it is accepted)
    await page.goto(`${base}/upload?node=${lectures.id}`);
    await page.getByRole('heading', { level: 1, name: 'رفع مصادر' }).waitFor();
    const png = readFileSync(join(GOLDEN, 'flowchart.png'));
    const files = [
      { name: 'lecture_appendicitis.pdf', mimeType: 'application/pdf', buffer: readFileSync(join(GOLDEN, 'lecture_appendicitis.pdf')) },
      { name: `flowchart ${tag}.png`, mimeType: 'image/png', buffer: Buffer.concat([png, randomBytes(16)]) },
      { name: 'histology_images.zip', mimeType: 'application/zip', buffer: readFileSync(join(GOLDEN, 'histology_images.zip')) },
      { name: 'notes.pdf', mimeType: 'application/pdf', buffer: Buffer.from('this is not really a pdf') },
    ];
    await page.locator('input[type=file]').first().setInputFiles(files);
    await shot('upload-queued');
    await page.getByRole('button', { name: /^رفع \d|^رفع ملفان|^رفع ملف/ }).click();
    await page.getByText(/قُبل \d/).first().waitFor({ timeout: 60_000 });
    await page.waitForTimeout(1500);
    await shot('upload-results');

    // first pdf source id
    if (!firstPdfSourceId) {
      const tree = await (await page.request.get(`${base}/api/library/tree`)).json();
      const pdf = tree.sources.find((s) => s.title === 'lecture appendicitis');
      firstPdfSourceId = pdf.id;
      firstPdfVersionId = pdf.current_version_id;
      await page.request.post(`${base}/api/sources/${refSrc.source_id}/links`, { headers: { 'x-medlevo-csrf': '1' }, data: { to_source_id: pdf.id, relation: 'reference_for' } });
      await page.request.post(`${base}/api/sources/${qSrc.source_id}/links`, { headers: { 'x-medlevo-csrf': '1' }, data: { to_source_id: pdf.id, relation: 'question_source_for' } });
      await page.request.post(`${base}/api/sources/${pdf.id}/open`, { headers: { 'x-medlevo-csrf': '1' } });
    }

    // course view + folder view
    await page.goto(`${base}/library/${course.id}`);
    await page.getByRole('heading', { level: 1 }).waitFor();
    await page.getByRole('heading', { level: 2, name: 'المحاضرات' }).first().waitFor();
    await shot('library-course');
    await page.goto(`${base}/library/${lectures.id}`);
    await page.getByRole('heading', { level: 2, name: 'المصادر' }).waitFor();
    await shot('library-folder');

    // node actions menu + move dialog (keyboard alternative to drag & drop)
    if (combo.name === 'desktop') {
      await page.goto(`${base}/library/${surgery.id}`);
      await page.getByRole('button', { name: /خيارات «Course 1/ }).click();
      await shot('menu-node', { fullPage: false });
      await page.getByRole('menuitem', { name: 'نقل…' }).click();
      await page.getByRole('dialog', { name: /^نقل «/ }).waitFor();
      await shot('dialog-move', { fullPage: false });
      await page.keyboard.press('Escape');
      await page.goto(`${base}/library`);
      await page.getByRole('button', { name: 'جديد', exact: true }).click();
      await page.getByRole('menuitem', { name: 'دفتر جديد' }).click();
      await page.getByRole('dialog', { name: 'دفتر جديد' }).waitFor();
      await page.getByLabel('الاسم').fill('الأطفال');
      await shot('dialog-notebook', { fullPage: false });
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'جديد', exact: true }).click();
      await page.getByRole('menuitem', { name: /قالب/ }).click();
      await page.getByRole('dialog', { name: 'قوالب الدراسة' }).waitFor();
      await page.getByRole('button', { name: /الجراحة/ }).first().click();
      await shot('dialog-templates', { fullPage: false });
      await page.keyboard.press('Escape');
    }

    // source screen tabs
    await page.goto(`${base}/sources/${firstPdfSourceId}`);
    await page.getByRole('heading', { level: 1 }).waitFor();
    await page.waitForTimeout(800);
    await shot('source-pages');
    await page.getByRole('tab', { name: 'البيانات' }).click();
    await shot('source-meta');
    await page.getByRole('tab', { name: /النسخ/ }).click();
    await shot('source-versions');
    await page.getByRole('tab', { name: /الروابط/ }).click();
    await shot('source-links');

    // trash + permanent delete confirmation showing the impact
    await page.goto(`${base}/library?view=trash`);
    await page.getByRole('button', { name: 'استعادة' }).first().waitFor();
    await shot('library-trash');
    await page.getByRole('button', { name: /حذف نهائي: «مسودة قديمة»/ }).click();
    await page.getByRole('alertdialog').waitFor();
    await page.getByText(/سيُحذف نهائيًا/).first().waitFor();
    await shot('dialog-purge', { fullPage: false });
    await page.keyboard.press('Escape');

    // recent + favorites
    await page.goto(`${base}/library?view=recent`);
    await page.locator('.ml-list').first().waitFor();
    await shot('library-recent');

    await ctx.close();
    log('✓', tag);
  }
}

// offline: the tree cached on this device is shown read-only
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, storageState: state, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  await page.goto(`${base}/library`);
  await page.locator('.ml-shelf').waitFor();
  await page.waitForTimeout(500);
  await page.route('**/api/library/**', (r) => r.abort('internetdisconnected'));
  await page.getByRole('tab', { name: 'المفضلة' }).click();
  await page.getByRole('tab', { name: 'الرف' }).click();
  await page.reload().catch(() => undefined);
  await page.waitForTimeout(1500);
  const notice = await page.getByText(/نسختها المحفوظة على هذا الجهاز/).count();
  if (notice === 0) problems.push('offline: cached library notice not shown');
  await page.screenshot({ path: join(out, 'library-offline-phone-light.png'), fullPage: true });
  log('✓ offline (cached, read-only)');
  await ctx.close();
}

await browser.close();
await api.dispose();
if (problems.length) {
  console.log('\nPROBLEMS:');
  for (const p of problems) console.log(' -', p);
  process.exit(1);
}
console.log('\nall screens captured without console errors or horizontal overflow →', out);
