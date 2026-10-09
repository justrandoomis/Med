// End-to-end check of the workspace against the REAL server (auth, library, sources upload + processing,
// annotations sync + read APIs) serving the BUILT web app. Uses a throwaway data dir and port.
// Test tooling only. Usage (from the repo root, after `npm run build -w @medlevo/web`):
//   node apps/web/src/features/workspace/real-server-check.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..', '..', '..');
const port = Number(process.env.PORT ?? 18931);
const base = `http://127.0.0.1:${port}`;
const dataDir = mkdtempSync(join(tmpdir(), 'medlevo-ws-e2e-'));
const pdf = readFileSync(join(root, 'fixtures', 'golden', 'lecture_appendicitis.pdf'));
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
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return;
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
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'ar-IQ', serviceWorkers: 'block' });
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
  const setup = await api('POST', '/api/auth/setup', { username: 'owner', password: 'correct horse battery staple' });
  check(setup.status === 200, `owner set up (${setup.status})`);
  const node = await api('POST', '/api/library/nodes', { parent_id: null, kind: 'subject', title: 'الجراحة' });
  check(node.status === 200, `library node created (${node.status})`);
  const upload = await page.evaluate(
    async ({ bytes, nodeId }) => {
      const fd = new FormData();
      fd.append('node_id', nodeId);
      fd.append('source_type', 'lecture');
      fd.append('files', new File([new Uint8Array(bytes)], 'lecture_appendicitis.pdf', { type: 'application/pdf' }));
      const r = await fetch('/api/sources/upload', { method: 'POST', headers: { 'x-medlevo-csrf': '1' }, body: fd });
      return { status: r.status, json: await r.json() };
    },
    { bytes: [...pdf], nodeId: node.json.node.id },
  );
  const sourceId = upload.json?.results?.[0]?.source_id;
  check(upload.status === 200 && !!sourceId, `PDF uploaded (${upload.status}, ${upload.json?.results?.[0]?.status})`);

  // wait for processing (real counts in the server; we only poll the status)
  let detail = null;
  for (let i = 0; i < 180; i++) {
    detail = (await api('GET', `/api/sources/${sourceId}`)).json;
    if (['ready', 'partial', 'failed', 'needs_review'].includes(detail?.processing_status)) break;
    await page.waitForTimeout(1000);
  }
  check(['ready', 'partial', 'needs_review'].includes(detail?.processing_status), `processing finished (${detail?.processing_status})`);
  const versionId = detail.active_version_id;
  const pagesRes = (await api('GET', `/api/sources/${sourceId}/versions/${versionId}/pages`)).json;
  const p0 = pagesRes.pages[0];
  check(p0.printed_label === '11', `processing read the printed label from /PageLabels (${p0.printed_label})`);

  // open the reader
  await page.goto(`${base}/study/${sourceId}`);
  await page.waitForSelector('.wk-canvas-slot canvas', { timeout: 30000 });
  await page.waitForSelector('.wk-textlayer span', { timeout: 30000 });
  const folio = await page.locator('.wk-folio').first().innerText();
  check(/ص 11/.test(folio) && /الصفحة 1 في الملف/.test(folio), `folio from real data: ${folio.replace(/\s+/g, ' ')}`);

  // highlight → IndexedDB + outbox → /api/sync/push → stored by the annotations module
  await page.evaluate(() => {
    const span = [...document.querySelectorAll('.wk-textlayer span')].find((s) => /periumbilical/.test(s.textContent ?? ''));
    const r = document.createRange();
    r.selectNodeContents(span);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  });
  await page.dispatchEvent('body', 'pointerup');
  await page.locator('.wk-seltoolbar button', { hasText: 'تظليل' }).click();
  await page.waitForTimeout(2500);
  const anns = (await api('GET', `/api/annotations/by-targets?keys=source_page:${p0.id}`)).json;
  const hl = anns?.annotations?.find((a) => a.kind === 'text_highlight');
  check(!!hl && /periumbilical/.test(hl.data.quote.exact) && hl.rev === 1, `highlight synced to the server with its quote (rev ${hl?.rev})`);
  check(!!hl && hl.data.rects.every((b) => b.x >= 0 && b.y >= 0 && b.x + b.w <= 1.0001 && b.y + b.h <= 1.0001), 'highlight rects are normalized to the page');

  // bookmark from the rail, synced
  await page.getByRole('tab', { name: 'ملاحظاتي' }).click();
  await page.getByRole('radio', { name: 'العلامات' }).click();
  await page.getByRole('button', { name: 'ضع علامة على هذه الصفحة' }).click();
  await page.waitForTimeout(1500);
  const bm = (await api('GET', `/api/annotations/source/${sourceId}?version_id=${versionId}`)).json;
  check(bm.annotations.some((a) => a.kind === 'bookmark'), 'bookmark synced (GET /source/:id lists it)');

  // regions produced by processing are listed and can be shown on the page
  await page.getByRole('tab', { name: 'المصادر' }).click();
  await page.waitForSelector('.wk-region-row', { timeout: 10000 }).catch(() => undefined);
  const regionRows = await page.locator('.wk-region-row').count();
  check(regionRows > 0, `real regions listed in «المصادر» (${regionRows})`);
  if (regionRows > 0) {
    await page.getByRole('button', { name: 'إظهار في الصفحة' }).first().click();
    await page.waitForTimeout(500);
    check((await page.locator('.wk-region-hl').count()) === 1, 'region highlighted on the page');
    await page.screenshot({ path: join(root, 'apps/web/test-screenshots/workspace-real-region-desktop-light.png') });
    await page.getByRole('button', { name: 'العودة إلى موضعك' }).click();
    await page.waitForTimeout(400);
    check((await page.locator('.wk-region-hl').count()) === 0, '«العودة إلى موضعك» returns and clears the highlight');
  }

  // move to page 13, wait for autosave + sync, then the server has the session and progress
  await page.locator('.wk-pageind').first().click();
  await page.locator('.wk-goto input').fill('13');
  await page.locator('.wk-goto button[type="submit"]').click();
  await page.waitForTimeout(5000);
  const latest = (await api('GET', `/api/annotations/sessions/latest?source_id=${sourceId}`)).json;
  check(latest?.session?.location?.page_index === 2, `session synced to the server at page index 2 (${latest?.session?.location?.page_index})`);
  const progress = (await api('GET', `/api/annotations/progress/${sourceId}`)).json;
  check(progress?.pages_viewed?.length >= 1 && progress.pages_total === 4, `reading progress recorded: viewed ${JSON.stringify(progress?.pages_viewed)} of ${progress?.pages_total}`);
  const recent = (await api('GET', '/api/annotations/sessions/recent')).json;
  check(recent?.items?.[0]?.page?.label_ar === 'ص 13 (الصفحة 3 في الملف)', `Continue Studying shows «${recent?.items?.[0]?.page?.label_ar}»`);

  // a new device (fresh browser profile) resumes from the server
  const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, locale: 'ar-IQ', serviceWorkers: 'block' });
  await ctx2.addCookies(await ctx.cookies());
  const page2 = await ctx2.newPage();
  await page2.goto(`${base}/study/${sourceId}`);
  await page2.waitForSelector('.wk-canvas-slot canvas', { timeout: 30000 });
  await page2.waitForTimeout(800);
  const ind2 = await page2.locator('.wk-pageind').first().innerText();
  check(/ص 13/.test(ind2), `another device resumes at the server position (${ind2.replace(/\s+/g, ' ')})`);
  await page2.screenshot({ path: join(root, 'apps/web/test-screenshots/workspace-real-resume-phone-light.png') });
  await ctx2.close();
  await ctx.close();
} finally {
  await browser.close();
  server.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 500));
  rmSync(dataDir, { recursive: true, force: true });
}
console.log(results.join('\n'));
if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n` + problems.join('\n'));
  process.exitCode = 1;
} else console.log('\nOK: real-server workspace check passed.');
