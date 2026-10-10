// Personal Control Center check (track D2) against the REAL server (apps/server/src/index.ts, no AI key) serving the
// BUILT web app. Test tooling only — run from the repo root after `npm run build -w @medlevo/web`:
//   node apps/web/src/features/control/real-server-check.mjs [outDir]
// Steps: setup → upload + process two Golden Set PDFs through the real pipeline → the review queue lists the real
// items → the review desk shows the original clipping next to the extracted text → a correction through the UI
// (owner text, outcome, history) → processing, intelligence (impact preview of a rule change through the UI),
// sources & priorities, storage, capabilities, history → a sync conflict + a rejection in this device's outbox
// (IndexedDB) acknowledged / re-sent through the UI. Screenshots at 390×844 and 1280×800, light and dark; every
// screen is checked for horizontal overflow and console errors.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..', '..', '..');
const port = Number(process.env.PORT ?? 19311);
const base = `http://127.0.0.1:${port}`;
const dataDir = mkdtempSync(join(tmpdir(), 'medlevo-control-check-'));
const shots = process.argv[2] ?? join(root, 'apps/web/test-screenshots/control');
mkdirSync(shots, { recursive: true });
const results = [];
const problems = [];
const check = (ok, what) => {
  results.push(`${ok ? 'PASS' : 'FAIL'} ${what}`);
  if (!ok) problems.push(what);
};

const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', join(root, 'apps/server/src/index.ts')], {
  cwd: join(root, 'apps/server'),
  env: {
    ...process.env,
    MEDLEVO_DATA_DIR: dataDir,
    MEDLEVO_PORT: String(port),
    MEDLEVO_HOST: '127.0.0.1',
    MEDLEVO_ORIGIN: base,
    MEDLEVO_WEB_DIST: join(root, 'apps/web/dist'),
    MEDLEVO_SCRYPT_LOG_N: '12',
    MEDLEVO_LOG_LEVEL: 'warn',
    ANTHROPIC_API_KEY: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));

async function waitForServer() {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('server did not start:\n' + serverLog.slice(-2000));
}

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
try {
  await waitForServer();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'ar-IQ', colorScheme: 'light' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/favicon|401|Failed to load resource/.test(m.text())) problems.push(`console: ${m.text()}`);
  });
  await page.goto(`${base}/login`);
  const api = (method, path, body) =>
    page.evaluate(
      async ({ method, path, body }) => {
        const r = await fetch(path, { method, headers: { 'content-type': 'application/json', 'x-medlevo-csrf': '1' }, body: body ? JSON.stringify(body) : undefined });
        return { status: r.status, json: await r.json().catch(() => null) };
      },
      { method, path, body },
    );
  const upload = (bytes, name, nodeId, sourceType) =>
    page.evaluate(
      async ({ bytes, name, nodeId, sourceType }) => {
        const fd = new FormData();
        fd.append('node_id', nodeId);
        fd.append('source_type', sourceType);
        fd.append('files', new File([new Uint8Array(bytes)], name, { type: 'application/pdf' }));
        const r = await fetch('/api/sources/upload', { method: 'POST', headers: { 'x-medlevo-csrf': '1' }, body: fd });
        return { status: r.status, json: await r.json() };
      },
      { bytes: [...bytes], name, nodeId, sourceType },
    );

  const setup = await api('POST', '/api/auth/setup', { username: 'owner', password: 'correct horse battery staple' });
  check(setup.status === 200, `owner set up (${setup.status} ${setup.status === 200 ? '' : JSON.stringify(setup.json)})`);
  const node = (await api('POST', '/api/library/nodes', { parent_id: null, kind: 'course', title: 'الجراحة' })).json.node;
  const ids = [];
  for (const [file, type] of [
    ['lecture_appendicitis.pdf', 'lecture'],
    ['mixed_scanned_lecture.pdf', 'lecture'],
  ]) {
    const up = await upload(readFileSync(join(root, 'fixtures', 'golden', file)), file, node.id, type);
    ids.push(up.json?.results?.[0]?.source_id);
  }
  check(ids.every(Boolean), 'two Golden Set PDFs uploaded');
  for (const id of ids) {
    for (let i = 0; i < 240; i++) {
      const d = (await api('GET', `/api/sources/${id}`)).json;
      if (['ready', 'partial', 'failed', 'needs_review'].includes(d?.processing_status)) break;
      await page.waitForTimeout(1000);
    }
  }
  const lecture = (await api('GET', `/api/sources/${ids[0]}`)).json;
  check(['ready', 'needs_review', 'partial'].includes(lecture.processing_status), `lecture processed (${lecture.processing_status})`);

  const queue = (await api('GET', '/api/control/review')).json;
  const ocrItem = queue.items.find((i) => i.kind === 'ocr_error' && i.entity_type === 'source_region' && i.source_id === ids[0]);
  check(!!ocrItem, `real review items listed (${queue.counts.open} open; ocr_error on the lecture found)`);

  // a sync conflict and a rejection in THIS device's outbox (IndexedDB), as the sync engine records them
  await page.goto(`${base}/control`);
  await page.waitForLoadState('networkidle');
  await page.evaluate(async () => {
    const open = () =>
      new Promise((res, rej) => {
        const r = indexedDB.open('medlevo');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    const db = await open();
    const tx = db.transaction('outbox', 'readwrite');
    const s = tx.objectStore('outbox');
    const now = Date.now();
    s.add({
      op_id: `01K${now}CONFLICT`,
      entity_type: 'note',
      entity_id: `01K${now}NOTE`,
      op: 'upsert',
      base_rev: 2,
      payload: { title: 'تشخيص الزائدة', body: { v: 1, paragraphs: [{ dir: 'rtl', runs: [{ t: 'علامة ' }, { t: 'McBurney', dir: 'ltr', lang: 'en' }, { t: ' مهمة في الفحص' }] }] } },
      client_ts: now - 3600_000,
      status: 'conflict',
      attempts: 1,
      nextAttemptAt: 0,
      result: 'conflict_kept_both',
    });
    s.add({
      op_id: `01K${now}REJECTED`,
      entity_type: 'annotation',
      entity_id: `01K${now}ANN`,
      op: 'upsert',
      base_rev: null,
      payload: { kind: 'highlight', data: { text: 'right iliac fossa pain' } },
      client_ts: now - 1800_000,
      status: 'rejected',
      attempts: 1,
      nextAttemptAt: 0,
      result: 'rejected',
      resultDetail: 'الصفحة التي ترتبط بها هذه الكتابة لم تعد موجودة في هذه النسخة.',
    });
    await new Promise((res) => (tx.oncomplete = res));
    db.close();
  });

  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  const shoot = async (name, url, prep) => {
    for (const [w, h] of [
      [390, 844],
      [1280, 800],
    ]) {
      for (const scheme of ['light', 'dark']) {
        await page.setViewportSize({ width: w, height: h });
        await page.emulateMedia({ colorScheme: scheme });
        if (url) await page.goto(`${base}${url}`);
        await page.waitForLoadState('networkidle');
        if (prep) await prep(w);
        await page.waitForTimeout(400);
        const o = await overflow();
        check(o <= 1, `${name} ${w}px ${scheme}: no horizontal overflow (${o}px)`);
        await page.screenshot({ path: join(shots, `${name}-${w}-${scheme}.png`), fullPage: true });
      }
    }
  };

  await shoot('index', '/control');
  check((await page.locator('text=بانتظار مراجعتك').count()) > 0, 'index: one sentence of real state per section');
  await shoot('review-queue', '/control/review');
  check((await page.getByRole('link', { name: /نص مقروء قد يكون خاطئًا/ }).count()) > 0, 'queue lists the OCR item with its kind');

  if (ocrItem) {
    await shoot('review-desk', `/control/review/${ocrItem.id}`, async () => {
      await page.getByRole('region', { name: 'الأصل' }).locator('canvas').first().waitFor({ timeout: 20_000 });
      await page.waitForTimeout(800);
    });
    const painted = await page.evaluate(() => {
      const c = document.querySelector('.cc-orig canvas');
      if (!c) return false;
      const g = c.getContext('2d');
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let dark = 0;
      for (let i = 0; i < d.length; i += 16) if (d[i] < 128) dark++;
      return dark > 20;
    });
    check(painted, 'desk: the original region is drawn from the PDF (ink on the clipping)');
    check((await page.getByRole('region', { name: 'النسخة المنظمة' }).innerText()).includes('عادةS'), 'desk: the extracted text with the defect is shown next to it');
    // correct through the UI
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByRole('radio', { name: /تصحيح النص/ }).check();
    const editor = page.getByRole('textbox', { name: /النص الصحيح كما في الأصل/ });
    const before = await editor.inputValue();
    await editor.fill(before.replace('عادةS', 'عادةً'));
    await page.getByRole('button', { name: 'طبّق: تصحيح النص' }).click();
    await page.getByText('حُفظ قرارك').waitFor({ timeout: 15_000 });
    check((await page.getByRole('region', { name: 'سجل التصحيحات' }).innerText()).includes('عادةS'), 'after correction: the previous text is kept in the history');
    const reg = (await api('GET', `/api/control/review/${ocrItem.id}`)).json;
    check(reg.status === 'corrected' && reg.structured.region.text_origin === 'owner', 'after correction: region is owner text, item corrected');
    await shoot('review-desk-resolved', null, async () => {
      await page.reload();
      await page.waitForLoadState('networkidle');
    });
  }

  await shoot('processing', '/control/processing');
  await shoot('intelligence', '/control/intelligence', async () => {
    await page.getByRole('combobox', { name: 'مستوى الشرح' }).selectOption('detailed');
    await page.getByRole('button', { name: 'اعرض الأثر قبل الحفظ' }).click();
    await page.getByText(/لن يتأثر أي محتوى مخزّن|من المحتوى المخزّن|محتوى مخزّن واحد/).first().waitFor({ timeout: 15_000 });
  });
  check((await page.getByRole('button', { name: 'طبّق التغيير' }).count()) === 1, 'intelligence: rule change shows its impact first, apply is explicit');
  await page.getByRole('button', { name: 'طبّق التغيير' }).click();
  await page.getByText('طُبّق التغيير.').waitFor({ timeout: 15_000 });
  check((await api('GET', '/api/settings')).json.settings.explanation_level === 'detailed', 'intelligence: applied only after confirmation');
  await shoot('sources', '/control/sources', async () => {
    const up = page.getByRole('button', { name: /^قدّم «مرجع الكورس»/ }).first();
    if (await up.count()) await up.click();
    await page.getByRole('button', { name: 'اعرض الأثر قبل الحفظ' }).click();
    await page.getByText(/أثر التغيير قبل تطبيقه/).first().waitFor({ timeout: 15_000 });
  });
  await shoot('alerts', '/control/alerts');
  await shoot('storage', '/control/storage');
  await shoot('capabilities', '/control/capabilities');
  await shoot('history', '/control/history');
  await shoot('sync', '/control/sync');
  const issues = page.getByRole('list', { name: 'مشكلات المزامنة على هذا الجهاز' });
  check((await issues.getByRole('listitem').count()) === 2, 'sync: the conflict and the rejection are listed with what happened');
  await page.getByRole('button', { name: 'اطّلعت — أبقِ النسختين' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'تأكيد' }).click();
  await page.getByText('أُغلق التنبيه. النسختان باقيتان كما هما.').waitFor({ timeout: 10_000 });
  await page.getByRole('button', { name: 'أعد الإرسال' }).first().click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'أعد الإرسال' }).click();
  await page.getByText(/أُضيف التغيير إلى قائمة الإرسال/).waitFor({ timeout: 10_000 });
  const outbox = await page.evaluate(
    () =>
      new Promise((res) => {
        const r = indexedDB.open('medlevo');
        r.onsuccess = () => {
          const all = r.result.transaction('outbox').objectStore('outbox').getAll();
          all.onsuccess = () => res(all.result.map((o) => ({ status: o.status, ack: !!o.acknowledgedAt, retryOf: o.retryOf ?? null, superseded: o.supersededBy ?? null })));
        };
      }),
  );
  check(outbox.length >= 3 && outbox.some((o) => o.retryOf) && outbox.some((o) => o.superseded), 'sync: re-send queued a NEW op; the old one kept (superseded), nothing deleted');
  await shoot('sync-after', null, async () => {});
  await shoot('settings-link', '/settings');
  check((await page.getByRole('link', { name: /مركز التحكم/ }).count()) > 0, 'settings links to the Control Center');
} catch (e) {
  problems.push(`exception: ${e instanceof Error ? e.stack : String(e)}`);
} finally {
  await browser.close();
  server.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 500));
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(results.join('\n'));
console.log(`\n${results.filter((r) => r.startsWith('PASS')).length} PASS, ${results.filter((r) => r.startsWith('FAIL')).length} FAIL`);
if (problems.length) {
  console.log('\nProblems:\n' + problems.join('\n'));
  process.exitCode = 1;
}
