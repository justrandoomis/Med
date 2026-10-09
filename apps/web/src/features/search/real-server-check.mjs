// Browser check of Universal Search and the evidence components against the REAL server (throwaway data
// dir): the built app serves /search; the Vite dev server serves the dev-only evidence harness with /api
// proxied to the same server (port 8787, as in vite.config.ts). Screenshots at 390×844 and 1280×800 in
// light and dark. Test tooling only. Usage (repo root, after `npm run build -w @medlevo/web`):
//   node apps/web/src/features/search/real-server-check.mjs [outDir]
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..', '..', '..');
const port = 8787; // the Vite dev proxy target
const devPort = 5199;
const base = `http://127.0.0.1:${port}`;
const dev = `http://127.0.0.1:${devPort}`;
const outDir = process.argv[2] ?? join(root, 'apps', 'web', 'test-screenshots');
mkdirSync(outDir, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), 'medlevo-search-e2e-'));
const golden = (n) => readFileSync(join(root, 'fixtures', 'golden', n));
const results = [];
const problems = [];
const check = (ok, what) => {
  results.push(`${ok ? 'PASS' : 'FAIL'} ${what}`);
  if (!ok) problems.push(what);
};

const procs = [];
let log = '';
function start(cmd, args, opts) {
  const p = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', (d) => (log += d));
  p.stderr.on('data', (d) => (log += d));
  procs.push(p);
  return p;
}
start(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', join(root, 'apps/server/src/index.ts')], {
  cwd: join(root, 'apps/server'),
  env: {
    ...process.env,
    MEDLEVO_DATA_DIR: dataDir,
    MEDLEVO_PORT: String(port),
    MEDLEVO_HOST: '127.0.0.1',
    MEDLEVO_ORIGIN: `${base},${dev}`,
    MEDLEVO_WEB_DIST: join(root, 'apps/web/dist'),
    MEDLEVO_SCRYPT_LOG_N: '12',
    MEDLEVO_LOG_LEVEL: 'warn',
    ANTHROPIC_API_KEY: '',
  },
});
start(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), '--port', String(devPort), '--strictPort', '--host', '127.0.0.1'], { cwd: join(root, 'apps/web'), env: process.env });

async function waitFor(url) {
  for (let i = 0; i < 160; i++) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${url} did not start:\n${log.slice(-3000)}`);
}

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
try {
  await waitFor(`${base}/api/health`);
  await waitFor(`${dev}/src/features/evidence/dev/harness.html`);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'ar-IQ', serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const watch = (p) => {
    p.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    p.on('console', (m) => {
      if (m.type() === 'error' && !/favicon|401|Failed to load resource/.test(m.text())) problems.push(`console: ${m.text()}`);
    });
  };
  watch(page);
  await page.goto(`${base}/login`);
  const api = (method, path, body) =>
    page.evaluate(
      async ({ method, path, body }) => {
        const r = await fetch(path, { method, headers: { 'content-type': 'application/json', 'x-medlevo-csrf': '1' }, body: body ? JSON.stringify(body) : undefined });
        return { status: r.status, json: await r.json().catch(() => null) };
      },
      { method, path, body },
    );
  check((await api('POST', '/api/auth/setup', { username: 'owner', password: 'correct horse battery staple' })).status === 200, 'owner set up');
  const node = (await api('POST', '/api/library/nodes', { parent_id: null, kind: 'subject', title: 'الجراحة' })).json.node;
  const upload = async (name, type) =>
    page.evaluate(
      async ({ bytes, nodeId, name, type }) => {
        const fd = new FormData();
        fd.append('node_id', nodeId);
        fd.append('source_type', type);
        fd.append('files', new File([new Uint8Array(bytes)], name, { type: 'application/pdf' }));
        const r = await fetch('/api/sources/upload', { method: 'POST', headers: { 'x-medlevo-csrf': '1' }, body: fd });
        return (await r.json()).results[0];
      },
      { bytes: [...golden(name)], nodeId: node.id, name, type },
    );
  const lecture = await upload('lecture_appendicitis.pdf', 'lecture');
  const reference = await upload('lecture_cholecystitis.pdf', 'course_reference');
  for (const s of [lecture, reference]) {
    let st = null;
    for (let i = 0; i < 180; i++) {
      st = (await api('GET', `/api/sources/${s.source_id}`)).json?.processing_status;
      if (['ready', 'partial', 'failed', 'needs_review'].includes(st)) break;
      await page.waitForTimeout(1000);
    }
    check(['ready', 'partial', 'needs_review'].includes(st), `processed ${s.source_id} (${st})`);
  }
  // a note written by the owner (synced like the reader does)
  const push = await api('POST', '/api/sync/push', {
    ops: [
      {
        op_id: '01JTESTOPSEARCH000000000001',
        device_id: '01JTESTDEVICE0000000000001',
        entity_type: 'note',
        entity_id: '01JTESTNOTE00000000000000A',
        op: 'upsert',
        payload: { title: 'تذكير', body: { v: 1, paragraphs: [{ dir: 'rtl', runs: [{ t: 'الألم يبدأ حول السرة ثم ينتقل — راجع ' }, { t: 'McBurney', dir: 'ltr' }] }] } },
      },
    ],
  });
  check(push.json?.results?.[0]?.result === 'applied', `note synced (${push.json?.results?.[0]?.result})`);
  // a replacement → a content change alert for the harness
  await page.evaluate(
    async ({ bytes, sid }) => {
      const fd = new FormData();
      fd.append('files', new File([new Uint8Array(bytes)], 'cholecystitis v2.pdf', { type: 'application/pdf' }));
      await fetch(`/api/sources/${sid}/versions`, { method: 'POST', headers: { 'x-medlevo-csrf': '1' }, body: fd });
    },
    { bytes: [...golden('lecture_appendicitis.pdf')], sid: reference.source_id },
  );

  // ───────── /search on the built app ─────────
  for (const [w, h, tag] of [
    [1280, 800, 'desktop'],
    [390, 844, 'phone'],
  ]) {
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width: w, height: h });
      await page.emulateMedia({ colorScheme: theme });
      await page.goto(`${base}/search?q=${encodeURIComponent('الالم')}`);
      await page.waitForLoadState('networkidle');
      await page.waitForSelector('.sr-item', { timeout: 20000 });
      const marks = await page.locator('.sr-item mark').allInnerTexts();
      check(marks.includes('الألم'), `[${tag}/${theme}] «الالم» found «الألم», highlighted (${marks.slice(0, 3).join('، ')})`);
      const heads = await page.locator('.sr-group__title').allInnerTexts();
      check(heads.some((t) => t.startsWith('من المصادر')) && heads.some((t) => t.startsWith('ملاحظاتي')), `[${tag}/${theme}] grouped: ${heads.join(' | ')}`);
      const label = await page.locator('.sr-item__page').first().innerText();
      check(/ص 11 \(الصفحة 1 في الملف\)/.test(label), `[${tag}/${theme}] page identity: ${label}`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check(overflow <= 1, `[${tag}/${theme}] no horizontal overflow (${overflow}px)`);
      await page.screenshot({ path: join(outDir, `search-${tag}-${theme}.png`), fullPage: true });
    }
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ colorScheme: 'light' });
  // keyboard: "/" focuses the field
  await page.goto(`${base}/search`);
  await page.waitForLoadState('networkidle');
  await page.locator('h1').click();
  await page.keyboard.press('/');
  check(await page.evaluate(() => document.activeElement?.getAttribute('type') === 'search'), '"/" focuses the search field');
  // exact mode verifies the phrase on the original text
  await page.goto(`${base}/search?q=${encodeURIComponent('does NOT exclude')}&mode=exact`);
  await page.waitForSelector('.sr-item mark');
  check((await page.locator('.sr-item mark').first().innerText()) === 'does NOT exclude', 'exact phrase highlighted');
  const semanticDisabled = await page.getByRole('radio', { name: 'دلالي' }).isDisabled();
  check(semanticDisabled, 'semantic mode disabled');
  check(await page.getByText(/البحث الدلالي يحتاج مزود embeddings/).isVisible(), 'semantic reason shown');
  await page.screenshot({ path: join(outDir, 'search-exact-desktop.png'), fullPage: true });
  // open a result → the reader at the exact page
  await page.goto(`${base}/search?q=${encodeURIComponent('Ultrasound first-line')}&source_type=lecture`);
  await page.waitForSelector('.sr-item a');
  await page.locator('.sr-item a').first().click();
  await page.waitForURL(/\/study\//);
  check(/page=1/.test(page.url()) && /region=/.test(page.url()), `result opens the reader at its page/region (${new URL(page.url()).search})`);
  // offline → local notes only, said clearly
  await page.goto(`${base}/search`);
  await page.waitForLoadState('networkidle');
  await ctx.setOffline(true);
  await page.locator('input[type=search]').fill('السره');
  await page.waitForSelector('.sr-offline');
  await page.waitForTimeout(800);
  check(await page.getByText(/يُبحث في ملاحظاتك المحفوظة على هذا الجهاز فقط/).isVisible(), 'offline notice shown');
  await page.screenshot({ path: join(outDir, 'search-offline-desktop.png'), fullPage: true });
  await ctx.setOffline(false);

  // ───────── evidence harness (dev server, real data) ─────────
  for (const [w, h, tag] of [
    [1280, 900, 'desktop'],
    [390, 844, 'phone'],
  ]) {
    for (const theme of ['light', 'dark']) {
      const hp = await ctx.newPage();
      watch(hp);
      await hp.setViewportSize({ width: w, height: h });
      await hp.goto(`${dev}/src/features/evidence/dev/harness.html?theme=${theme}`);
      await hp.waitForSelector('[data-harness="artifact"] .ev-chip', { timeout: 30000 });
      await hp.waitForLoadState('networkidle');
      const chips = await hp.locator('[data-harness="artifact"] .ml-source-chip').allInnerTexts();
      check(chips.length >= 5 && chips.every((c) => /^محاضرة ص1[1-4]$/.test(c.trim())), `[${tag}/${theme}] chips from real evidence: ${chips.join('، ')}`);
      const statuses = await hp.locator('.ev-claim__status').allInnerTexts();
      check(statuses.includes('يحتاج مراجعة') && statuses.includes('تعارض'), `[${tag}/${theme}] unverified claims marked: ${statuses.join('، ')}`);
      const overflow = await hp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check(overflow <= 1, `[${tag}/${theme}] harness: no horizontal overflow (${overflow}px)`);
      await hp.screenshot({ path: join(outDir, `evidence-${tag}-${theme}.png`), fullPage: true });
      // the reason a claim is not linked opens without hover (review fix): button → visible note
      const why = hp.locator('[data-harness="artifact"] .ev-claim__why').first();
      await why.click();
      const reason = await hp.locator('[data-harness="artifact"] .ev-claim__reason:not([hidden])').first().innerText();
      check(/التحقق المستقل/.test(reason), `[${tag}/${theme}] «لماذا؟» shows why a claim needs review`);
      const overflow2 = await hp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check(overflow2 <= 1, `[${tag}/${theme}] no horizontal overflow with the reason open (${overflow2}px)`);
      await hp.screenshot({ path: join(outDir, `evidence-why-${tag}-${theme}.png`) });
      await why.click();
      // peek via keyboard
      await hp.locator('[data-harness="artifact"] .ml-source-chip').first().focus();
      await hp.keyboard.press('Enter');
      await hp.waitForSelector('.ev-anchored');
      const peek = await hp.locator('.ev-anchored').innerText();
      check(/ص 1[1-4] \(الصفحة [1-4] في الملف\)/.test(peek) && /مرتبط بدليل/.test(peek) && /مستخرج|يحتاج مراجعة/.test(peek), `[${tag}/${theme}] peek opened with Enter and shows locator + statuses`);
      await hp.screenshot({ path: join(outDir, `evidence-peek-${tag}-${theme}.png`) });
      await hp.keyboard.press('Escape');
      check(await hp.evaluate(() => document.activeElement?.classList.contains('ml-source-chip')), `[${tag}/${theme}] Escape returns focus to the chip`);
      // Source Inspector: real page render with the region box
      await hp.locator('[data-harness="artifact"] .ml-source-chip').first().click();
      await hp.getByRole('button', { name: 'فحص الموضع في الصفحة' }).click();
      await hp.waitForSelector('.ev-inspect__stage canvas', { timeout: 30000 });
      await hp.waitForSelector('.ev-inspect__box', { timeout: 30000 });
      const box = await hp.locator('.ev-inspect__box').boundingBox();
      check(!!box && box.width > 20 && box.height > 5, `[${tag}/${theme}] inspector draws the cited region on the rendered page (${box && Math.round(box.width)}×${box && Math.round(box.height)})`);
      await hp.waitForTimeout(300);
      await hp.screenshot({ path: join(outDir, `evidence-inspector-${tag}-${theme}.png`) });
      await hp.keyboard.press('Escape');
      await hp.close();
    }
  }
  // scope picker + alerts content (desktop light)
  const hp = await ctx.newPage();
  watch(hp);
  await hp.goto(`${dev}/src/features/evidence/dev/harness.html`);
  await hp.waitForSelector('.ev-scope-picker__list li', { timeout: 30000 });
  await hp.waitForSelector('.ev-alert', { timeout: 30000 });
  check((await hp.locator('.ev-alert__kind').first().innerText()).length > 0, 'content alert listed');
  await hp.getByRole('radio', { name: /المحاضرة \+ المراجع/ }).check();
  await hp.waitForTimeout(800);
  check(await hp.getByRole('button', { name: 'طبّق النطاق' }).isEnabled(), 'scope change needs an explicit «طبّق النطاق»');
  await hp.locator('[data-harness="scope"]').screenshot({ path: join(outDir, 'evidence-scope-desktop-light.png') });
  await hp.locator('[data-harness="alerts"]').screenshot({ path: join(outDir, 'evidence-alerts-desktop-light.png') });
} catch (e) {
  problems.push(`exception: ${e?.stack ?? e}`);
} finally {
  await browser.close();
  for (const p of procs) p.kill('SIGTERM');
  rmSync(dataDir, { recursive: true, force: true });
}
console.log(results.join('\n'));
if (problems.length) {
  console.log('\nPROBLEMS:\n' + problems.join('\n'));
  process.exit(1);
}
console.log(`\nall ${results.length} checks passed; screenshots in ${outDir}`);
