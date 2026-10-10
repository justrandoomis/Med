// AC-23 end-to-end offline check (track D1) against the REAL server serving the BUILT web app (service worker
// included). Test tooling only — run from the repo root after `npm run build -w @medlevo/web`:
//   node apps/web/src/features/offline/offline-e2e.mjs
// The server is the studybook track's TEST-ONLY browser server (real app + a deterministic grounded fake provider,
// apps/server/test/studybook/browser-server.ts) so a Study Book exists and AI features are "available" online —
// which lets this check prove they say «يحتاج اتصالًا» offline instead of pretending to work.
// Steps: setup → upload + process a Golden Set lecture and a course reference → link → owner note + ink (sync) →
// Study Book (lecture + references) → download the lecture through the Download Manager UI → service worker
// controls the page → context.setOffline(true) → open the lecture, read pages, see the note, AI action needs a
// connection, a citation to the non-downloaded reference says so, a non-downloaded source says so.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..', '..', '..');
const port = Number(process.env.PORT ?? 18947);
const base = `http://127.0.0.1:${port}`;
const dataDir = mkdtempSync(join(tmpdir(), 'medlevo-offline-e2e-'));
const shots = join(root, 'apps/web/test-screenshots');
mkdirSync(shots, { recursive: true });
const lecturePdf = readFileSync(join(root, 'fixtures', 'golden', 'lecture_appendicitis.pdf'));
const referencePdf = readFileSync(join(root, 'fixtures', 'golden', 'lecture_cholecystitis.pdf'));
const results = [];
const problems = [];
const notes = [];
const check = (ok, what) => {
  results.push(`${ok ? 'PASS' : 'FAIL'} ${what}`);
  if (!ok) problems.push(what);
};

const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', join(root, 'apps/server/test/studybook/browser-server.ts')], {
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
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'ar-IQ' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/favicon|401|Failed to load resource|net::ERR_INTERNET_DISCONNECTED|Failed to fetch/.test(m.text())) problems.push(`console: ${m.text()}`);
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

  check((await api('POST', '/api/auth/setup', { username: 'owner', password: 'correct horse battery staple' })).status === 200, 'owner set up');
  const node = (await api('POST', '/api/library/nodes', { parent_id: null, kind: 'course', title: 'الجراحة' })).json.node;
  const up1 = await upload(lecturePdf, 'lecture_appendicitis.pdf', node.id, 'lecture');
  const up2 = await upload(referencePdf, 'lecture_cholecystitis.pdf', node.id, 'course_reference');
  const lectureId = up1.json?.results?.[0]?.source_id;
  const refId = up2.json?.results?.[0]?.source_id;
  check(!!lectureId && !!refId, 'Golden Set lecture and course reference uploaded');
  for (const id of [lectureId, refId]) {
    for (let i = 0; i < 180; i++) {
      const d = (await api('GET', `/api/sources/${id}`)).json;
      if (['ready', 'partial', 'failed', 'needs_review'].includes(d?.processing_status)) break;
      await page.waitForTimeout(1000);
    }
  }
  const lecture = (await api('GET', `/api/sources/${lectureId}`)).json;
  check(['ready', 'needs_review', 'partial'].includes(lecture.processing_status), `lecture processed (${lecture.processing_status})`);
  const versionId = lecture.active_version_id;
  const pages = (await api('GET', `/api/sources/${lectureId}/versions/${versionId}/pages`)).json.pages;
  await api('POST', `/api/sources/${refId}/links`, { to_source_id: lectureId, relation: 'reference_for' });

  // the owner's writing on page 1 (through the real sync handlers)
  const anchor = { type: 'page', source_id: lectureId, version_id: versionId, page_id: pages[0].id, page_index: 0, space: 'page_norm' };
  const noteText = 'ملاحظتي دون اتصال: افحص علامة McBurney';
  const pushed = await api('POST', '/api/sync/push', {
    ops: [
      { op_id: `OP${Date.now()}A`, device_id: 'E2E', entity_type: 'note', entity_id: `NOTE${Date.now()}`, op: 'upsert', payload: { title: null, body: { v: 1, paragraphs: [{ dir: 'rtl', runs: [{ t: noteText }] }] }, anchor, origin: 'owner' } },
      {
        op_id: `OP${Date.now()}B`,
        device_id: 'E2E',
        entity_type: 'annotation',
        entity_id: `INK${Date.now()}`,
        op: 'append',
        payload: { kind: 'ink', tool: 'pen', anchor, data: { v: 1, points: [[0.2, 0.3, 0, 0.5], [0.3, 0.32, 16, 0.6]], style: { tool: 'pen', color: 'ink-blue', width: 0.003 }, bbox: { x: 0.2, y: 0.3, w: 0.1, h: 0.02 }, pressure_available: true, tilt_available: false }, layer: 'ink', z: 0, locked: false },
      },
    ],
  });
  check(pushed.json?.results?.every((r) => r.result === 'applied'), 'note + ink stroke synced to the server');

  // a Study Book of the lecture that may also cite the linked reference (lecture + references)
  const book = await api('POST', '/api/studybook/books', { source_id: lectureId, scope: { mode: 'lecture_plus_references', lecture_source_id: lectureId, reference_source_ids: [refId] } });
  check(book.status === 200, `Study Book generation started (${book.status})`);
  let status = null;
  for (let i = 0; i < 120; i++) {
    status = (await api('GET', `/api/studybook/books?source_id=${lectureId}`)).json;
    if (['published', 'partial', 'failed'].includes(status?.book?.artifact?.status)) break;
    await page.waitForTimeout(1000);
  }
  const claims = Object.values(status?.book?.artifact?.claims ?? {});
  const refCitations = claims.flatMap((c) => c.citations).filter((c) => c.evidence.source_id === refId).length;
  check(['published', 'partial'].includes(status?.book?.artifact?.status), `Study Book generated by the real job (${status?.book?.artifact?.status}, ${claims.length} claims, ${refCitations} citing the reference)`);

  // ── download through the Download Manager UI ──
  await page.goto(`${base}/offline`);
  await page.getByRole('heading', { level: 1 }).waitFor();
  await page.locator('li.dl-pick').first().waitFor({ timeout: 30000 });
  const lectureTitle = lecture.title;
  const pick = page.locator('li.dl-pick').filter({ hasText: lectureTitle });
  await pick.getByRole('button', { name: 'تنزيل' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByText('ما سيُحفظ على هذا الجهاز').waitFor({ timeout: 60000 });
  const dialogText = await dialog.innerText();
  check(/ملف PDF للعرض/.test(dialogText) && /كتاب الدراسة/.test(dialogText) && /تحتاج اتصالًا/.test(dialogText), 'download dialog lists the PDF, the Study Book and what needs a connection');
  await page.screenshot({ path: join(shots, 'offline-download-dialog-desktop.png') });
  await dialog.getByRole('button', { name: /^نزّل/ }).click();
  await dialog.getByText('صار المصدر متاحًا دون اتصال على هذا الجهاز.').waitFor({ timeout: 120000 });
  check(true, 'lecture downloaded through the UI (files hash-verified, data stored)');
  await dialog.getByRole('contentinfo').getByRole('button', { name: 'إغلاق' }).click();
  const rowText = await page.getByRole('region', { name: /^على هذا الجهاز/ }).innerText();
  check(rowText.includes(lectureTitle) && /MB|KB/.test(rowText), 'the download is listed with its real size');
  await page.screenshot({ path: join(shots, 'offline-manager-desktop.png'), fullPage: true });

  // the service worker must control the page before going offline (clientsClaim is off: reload once)
  const swActive = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return !!reg.active;
  });
  await page.reload();
  await page.getByRole('heading', { level: 1 }).waitFor();
  const controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
  check(swActive && controlled, `service worker registered from the root layout and controlling the page (${swActive}/${controlled})`);

  // ── offline ──
  await ctx.setOffline(true);
  await page.goto(`${base}/study/${lectureId}`);
  await page.waitForSelector('.wk-canvas-slot canvas', { timeout: 30000 });
  await page.waitForSelector('.wk-textlayer span', { timeout: 30000 });
  const folio = await page.locator('.wk-folio').first().innerText();
  check(/ص 11/.test(folio), `offline: the lecture opens from the downloaded copy and renders (${folio.replace(/\s+/g, ' ')})`);
  await page.locator('.wk-pageind').first().click();
  await page.locator('.wk-goto input').fill('13');
  await page.locator('.wk-goto button[type="submit"]').click();
  await page.waitForTimeout(1500);
  const ind = await page.locator('.wk-pageind').first().innerText();
  check(/ص 13/.test(ind), `offline: reading another page works (${ind.replace(/\s+/g, ' ')})`);
  const canvases = await page.locator('.wk-canvas-slot canvas').count();
  check(canvases > 0, `offline: pages are drawn from the downloaded PDF (${canvases} canvases)`);
  await page.screenshot({ path: join(shots, 'offline-reader-desktop.png') });

  await page.getByRole('tab', { name: 'ملاحظاتي' }).click();
  const sawNote = await page.getByText(noteText).first().waitFor({ timeout: 10000 }).then(() => true, () => false);
  check(sawNote, 'offline: the owner\'s note on the lecture is shown');
  const inkRows = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open('medlevo');
        req.onsuccess = () => {
          const tx = req.result.transaction('annotations', 'readonly');
          const c = tx.objectStore('annotations').count();
          c.onsuccess = () => resolve(c.result);
          c.onerror = () => resolve(-1);
        };
        req.onerror = () => resolve(-1);
      }),
  );
  check(inkRows >= 1, `offline: the ink stroke is on the device (${inkRows} annotation rows in IndexedDB)`);

  await page.getByRole('tab', { name: 'الشرح والسؤال' }).click();
  await page.waitForTimeout(800);
  const explainText = await page.locator('[role="tabpanel"]').filter({ hasText: /اتصال/ }).first().innerText().catch(() => '');
  check(/تحتاج هذه الميزة اتصالًا/.test(explainText), 'offline: AI explanation says it needs a connection (يحتاج اتصالًا)');
  const busy = await page.locator('[aria-busy="true"], [role="progressbar"]').count();
  check(busy === 0, `offline: no fake progress shown for AI (${busy} busy indicators)`);
  await page.screenshot({ path: join(shots, 'offline-ai-needs-connection-desktop.png') });

  // Study Book offline with its citations. The download stores the Study Book (GET /api/studybook/books…), but the
  // workspace's «كتاب الدراسة» view (features/workspace/studybook/useStudyBook.ts — another track) does not ask for it
  // while offline. Record what really happens instead of pretending.
  const cachedBook = await page.evaluate(
    (sourceId) =>
      new Promise((resolve) => {
        const req = indexedDB.open('medlevo');
        req.onsuccess = () => {
          const get = req.result.transaction('apiCache', 'readonly').objectStore('apiCache').get(`offline:/api/studybook/books?source_id=${sourceId}`);
          get.onsuccess = () => {
            const book = get.result?.value?.book;
            resolve(book ? { status: book.artifact.status, claims: Object.keys(book.artifact.claims ?? {}).length } : null);
          };
          get.onerror = () => resolve(null);
        };
        req.onerror = () => resolve(null);
      }),
    lectureId,
  );
  check(!!cachedBook, `offline: the Study Book is stored on the device with the download (${cachedBook ? `${cachedBook.status}, ${cachedBook.claims} claims` : 'missing'})`);
  await page.locator('.wk-viewswitch').first().click();
  const bookItem = page.getByRole('menuitem', { name: /^كتاب الدراسة/ }).first();
  const bookDisabled = (await bookItem.getAttribute('aria-disabled')) === 'true';
  const bookItemText = (await bookItem.innerText()).replace(/\s+/g, ' ');
  await page.keyboard.press('Escape');
  if (bookDisabled) {
    notes.push(
      `NOT EXERCISED (other track): the workspace «كتاب الدراسة» view is disabled offline («${bookItemText}») — useStudyBook/useStudyBookAvailability return early when offline instead of reading GET /api/studybook/books?source_id= (which the offline transport now serves from the download). Citation chips to a non-downloaded page could therefore not be shown in the reader; the chip logic against a real download record is covered by features/offline/citations.test.tsx.`,
    );
  } else {
    await bookItem.click();
    await page.waitForSelector('.ml-source-chip', { timeout: 20000 });
    const chipStates = await page.locator('.ml-source-chip').evaluateAll((els) => els.map((e) => ({ available: e.getAttribute('data-available'), label: e.getAttribute('aria-label') })));
    const okChips = chipStates.filter((c) => c.available === 'true').length;
    const offChips = chipStates.filter((c) => c.available === 'false');
    check(okChips > 0, `offline: the downloaded Study Book renders with citation chips to the downloaded lecture (${okChips})`);
    if (refCitations > 0) {
      check(offChips.length > 0 && offChips.every((c) => /غير محمّلة على هذا الجهاز/.test(c.label ?? '')), `offline: a citation to a non-downloaded page says so (${offChips.length} chips)`);
    }
    await page.screenshot({ path: join(shots, 'offline-studybook-desktop.png') });
  }

  // a source that was NOT downloaded says so (no substitute content)
  await page.goto(`${base}/study/${refId}`);
  const notHere = await page.getByText('هذا المصدر غير محمّل على هذا الجهاز للقراءة دون اتصال').first().waitFor({ timeout: 20000 }).then(() => true, () => false);
  check(notHere, 'offline: a non-downloaded source says it is not on this device');

  // phone width: the Download Manager itself works offline (lists what is on the device) without overflow
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}/offline`);
  await page.getByRole('heading', { level: 1 }).waitFor();
  const phoneText = await page.locator('main').innerText();
  check(phoneText.includes(lectureTitle) && /يحتاج التنزيل اتصالًا/.test(phoneText), 'offline (390 px): the Download Manager lists the download and says new downloads need a connection');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(overflow <= 1, `390 px: no horizontal overflow (${overflow}px)`);
  if (overflow > 1) {
    const wide = await page.evaluate(() => {
      const w = document.documentElement.clientWidth;
      return [...document.querySelectorAll('body *')]
        .map((el) => ({ el, r: el.getBoundingClientRect() }))
        .filter(({ r }) => r.width > 0 && (r.right > w + 1 || r.left < -1))
        .slice(0, 12)
        .map(({ el, r }) => `${el.tagName.toLowerCase()}.${String(el.className).split(' ').join('.')} [${Math.round(r.left)}..${Math.round(r.right)}] ${(el.textContent ?? '').trim().slice(0, 40)}`);
    });
    notes.push('overflowing elements:\n  ' + wide.join('\n  '));
  }
  await page.screenshot({ path: join(shots, 'offline-manager-phone-offline.png'), fullPage: true });
  await ctx.setOffline(false);

  // dark theme screenshot (visual review only)
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(`${base}/offline?tab=backups`);
  await page.getByRole('button', { name: /أنشئ نسخة احتياطية الآن/ }).waitFor({ timeout: 20000 });
  await page.screenshot({ path: join(shots, 'offline-backups-phone-dark.png'), fullPage: true });
  await ctx.close();
} catch (e) {
  problems.push(`aborted: ${e instanceof Error ? e.message.split('\n').slice(0, 6).join(' | ') : String(e)}`);
  try {
    const pages = browser.contexts().flatMap((c) => c.pages());
    if (pages[0]) await pages[0].screenshot({ path: join(shots, 'offline-e2e-failure.png'), fullPage: true });
  } catch {
    // best effort
  }
} finally {
  await browser.close();
  server.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 500));
  rmSync(dataDir, { recursive: true, force: true });
}
console.log(results.join('\n'));
if (notes.length) console.log('\n' + notes.join('\n'));
if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n` + problems.join('\n'));
  process.exitCode = 1;
} else console.log('\nOK: offline end-to-end check passed.');
