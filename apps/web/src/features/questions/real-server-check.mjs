// End-to-end check of the Question Vault against the REAL server (sources upload → processing → questions
// hook → extraction → matching) serving the BUILT web app. Throwaway data dir and port. Test tooling only.
// Usage (repo root, after `npm run build -w @medlevo/web`):
//   node apps/web/src/features/questions/real-server-check.mjs
// Screenshots: apps/web/test-screenshots/questions-*.png (git-ignored) at 390×844 and 1280×800, light + dark.
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
const dataDir = mkdtempSync(join(tmpdir(), 'medlevo-qv-e2e-'));
const shots = join(root, 'apps/web/test-screenshots');
mkdirSync(shots, { recursive: true });
const golden = (n) => [...readFileSync(join(root, 'fixtures', 'golden', n))];
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
  const upload = (name, type, sourceType, nodeId, title) =>
    page.evaluate(
      async ({ bytes, name, type, sourceType, nodeId, title }) => {
        const fd = new FormData();
        fd.append('node_id', nodeId);
        fd.append('source_type', sourceType);
        fd.append('title', title);
        fd.append('files', new File([new Uint8Array(bytes)], name, { type }));
        const r = await fetch('/api/sources/upload', { method: 'POST', headers: { 'x-medlevo-csrf': '1' }, body: fd });
        return (await r.json()).results?.[0];
      },
      { bytes: golden(name), name, type, sourceType, nodeId, title },
    );
  const idle = async () => {
    for (let i = 0; i < 240; i++) {
      const q = (await api('GET', '/api/jobs?status=queued&limit=5')).json?.jobs?.length ?? 0;
      const r = (await api('GET', '/api/jobs?status=running&limit=5')).json?.jobs?.length ?? 0;
      if (q + r === 0) return true;
      await page.waitForTimeout(500);
    }
    return false;
  };

  check((await api('POST', '/api/auth/setup', { username: 'owner', password: 'correct horse battery staple' })).status === 200, 'owner set up');
  const course = (await api('POST', '/api/library/nodes', { parent_id: null, kind: 'course', title: 'Surgery Course 1' })).json.node;
  // question sources FIRST, the lecture later (AC-16)
  const qs = await upload('questions_surgery_course1.pdf', 'application/pdf', 'question_source', course.id, 'Surgery Course 1 Questions');
  const prev = await upload('questions_previous_exam_2024.pdf', 'application/pdf', 'previous_exam', course.id, 'Previous exam 2024');
  check(await idle(), 'processing + extraction of the question sources finished');
  const lec = await upload('lecture_appendicitis.pdf', 'application/pdf', 'lecture', course.id, 'Acute Appendicitis');
  check(await idle(), 'processing + matching of the lecture finished');
  check(!!qs?.source_id && !!prev?.source_id && !!lec?.source_id, 'three sources uploaded');

  const list = (await api('GET', `/api/questions?source_id=${qs.source_id}&limit=50`)).json;
  check(list.total === 7, `7 questions extracted (${list.total})`);
  const a2 = list.items.find((i) => /NOT typically/.test(i.stem_preview));
  const a3 = list.items.find((i) => /30-year-old/.test(i.stem_preview));
  check(!!a2 && !!a3, 'A2 and A3 found');

  // quick add through the UI: a photographed question → image source → OCR → extraction (AC-13)
  await page.goto(`${base}/questions/add`);
  await page.getByLabel('يُحفظ في').selectOption(course.id);
  await page.setInputFiles('#qv-file', join(root, 'fixtures', 'golden', 'question_photo_circled.png'));
  await page.getByRole('button', { name: 'حفظ الصورة واستخراج السؤال' }).click();
  await page.getByText('حُفظت الصورة', { exact: true }).waitFor({ timeout: 30000 });
  check(await idle(), 'quick-add photo processed (OCR) and extracted');
  const photoSrc = (await api('GET', '/api/library/tree')).json?.sources?.find((x) => x.title === 'سؤال مضاف سريعًا');
  const photoQs = photoSrc ? (await api('GET', `/api/questions?source_id=${photoSrc.id}`)).json : null;
  const pq = photoQs?.items?.[0];
  check(!!pq && pq.answer_status === 'missing_key' && pq.open_review.some((r) => r.kind === 'unofficial_mark'), `photo question: no official key, circled option flagged (${pq?.answer_status}, ${pq?.open_review.map((r) => r.kind).join(',')})`);

  // keyboard: the key dialog opens with Enter and Escape returns focus to its opener
  await page.goto(`${base}/questions/${a2.id}`);
  const keyBtn = page.getByRole('button', { name: 'تحديد المفتاح بنفسي' });
  await keyBtn.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('dialog').waitFor({ timeout: 5000 });
  check((await page.getByRole('radio').count()) === 4, 'key dialog: one radio per printed option');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  check((await page.getByRole('dialog').count()) === 0 && (await page.evaluate(() => document.activeElement?.textContent ?? '')).includes('تحديد المفتاح'), 'key dialog: Escape closes and focus returns to the opener');

  for (const [w, h, tag] of [
    [1280, 800, 'desktop'],
    [390, 844, 'phone'],
  ]) {
    for (const scheme of ['light', 'dark']) {
      const c = await browser.newContext({ viewport: { width: w, height: h }, locale: 'ar-IQ', serviceWorkers: 'block', colorScheme: scheme, isMobile: tag === 'phone', hasTouch: tag === 'phone' });
      await c.addCookies(await ctx.cookies());
      const p = await c.newPage();
      watch(p);
      const overflow = async (what) => {
        const o = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        check(o <= 1, `${what} ${tag}/${scheme}: no horizontal overflow (${o}px)`);
      };
      // vault
      await p.goto(`${base}/questions`);
      await p.waitForSelector('.qv-row', { timeout: 20000 });
      check((await p.locator('.qv-row').count()) >= 9, `vault lists the questions (${tag}/${scheme})`);
      if (tag === 'phone') {
        check(!(await p.locator('#qv-filter-grid').isVisible()), `vault: filters collapsed on phones (${scheme})`);
        await p.getByRole('button', { name: /^التصفية/ }).click();
        check(await p.locator('#qv-filter-grid').isVisible(), `vault: filter toggle opens the filters (${scheme})`);
      }
      await overflow('vault');
      await p.screenshot({ path: join(shots, `questions-vault-${tag}-${scheme}.png`), fullPage: tag === 'desktop' });
      // detail
      await p.goto(`${base}/questions/${a2.id}`);
      await p.waitForSelector('.qv-sheet', { timeout: 20000 });
      check((await p.locator('.qv-stem em', { hasText: 'NOT' }).count()) === 1, `detail: NOT emphasized (${tag}/${scheme})`);
      check((await p.getByText('الإجابة — حسب مفتاح المصدر').count()) === 1, `detail: answer marked with its origin (${tag}/${scheme})`);
      check(await p.getByRole('button', { name: 'تدرّب' }).isDisabled(), `detail: «تدرّب» disabled with a reason (${tag}/${scheme})`);
      await overflow('detail');
      await p.screenshot({ path: join(shots, `questions-detail-${tag}-${scheme}.png`), fullPage: tag === 'desktop' });
      // side-by-side review: the original page with the highlighted region
      await p.goto(`${base}/questions/${a3.id}/review`);
      await p.waitForSelector('.qv-orig__sheet canvas', { timeout: 30000 });
      await p.waitForSelector('.qv-orig__box', { timeout: 30000 });
      check((await p.locator('.qv-orig__page').count()) === 2, `review: A3 shows both original pages (${tag}/${scheme})`);
      check((await p.locator('.qv-orig__box').count()) >= 2, `review: question regions highlighted (${tag}/${scheme})`);
      await overflow('review');
      await p.screenshot({ path: join(shots, `questions-review-${tag}-${scheme}.png`), fullPage: tag === 'desktop' });
      // review queue + quick add
      await p.goto(`${base}/questions/review`);
      await p.waitForSelector('h1', { timeout: 20000 });
      await overflow('queue');
      await p.screenshot({ path: join(shots, `questions-queue-${tag}-${scheme}.png`) });
      await p.goto(`${base}/questions/add`);
      await p.waitForSelector('form.qv-quick', { timeout: 20000 });
      await overflow('quick add');
      await p.screenshot({ path: join(shots, `questions-quickadd-${tag}-${scheme}.png`) });
      // workspace rail «الأسئلة» on page 13 (index 2)
      await p.goto(`${base}/study/${lec.source_id}?page=2`);
      await p.waitForSelector('.wk-canvas-slot canvas', { timeout: 30000 });
      if (tag === 'phone') {
        const railBtn = p.getByRole('button', { name: /لوحة الدراسة|الأسئلة|أدوات الدراسة/ }).first();
        if (await railBtn.count()) await railBtn.click().catch(() => undefined);
      }
      const tab = p.getByRole('tab', { name: 'الأسئلة' });
      if (await tab.count()) {
        await tab.first().click();
        await p.waitForSelector('.qv-rail__item', { timeout: 20000 });
        const firstGroup = await p.locator('.qv-rail__h').first().innerText();
        check(/في هذه الصفحة/.test(firstGroup), `rail: this page's questions first («${firstGroup}», ${tag}/${scheme})`);
        check((await p.locator('.qv-rail__item').count()) >= 4, `rail: linked questions listed (${tag}/${scheme})`);
        await p.screenshot({ path: join(shots, `questions-rail-${tag}-${scheme}.png`) });
        if (tag === 'phone') {
          const hgt = await p.locator('.qv-rail__origin').first().evaluate((el) => el.getBoundingClientRect().height);
          check(hgt >= 44, `rail: origin action is a ≥44px touch target (${Math.round(hgt)}px, ${scheme})`);
        }
        // «افتح الأصل» jumps into the question source at the question's page
        await p.locator('.qv-rail__origin').first().click();
        await p.waitForURL(/\/study\//, { timeout: 15000 });
        await p.waitForTimeout(1500);
        check(p.url().includes(qs.source_id) || p.url().includes(prev.source_id), `rail: «افتح الأصل» opened the question source (${tag}/${scheme})`);
      } else {
        check(false, `rail tab «الأسئلة» reachable (${tag}/${scheme})`);
      }
      await c.close();
    }
  }
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
} else console.log('\nOK: real-server Question Vault check passed.');
