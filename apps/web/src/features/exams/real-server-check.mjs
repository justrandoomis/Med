// End-to-end check of practice & exams against the REAL server (upload → processing → extraction → matching)
// serving the BUILT web app, in Chromium at 390×844 and 1280×800 (light + dark). Throwaway data dir and port.
// No AI provider: AI features must show the reason. Test tooling only.
// Usage (repo root, after `npm run build -w @medlevo/web`):
//   node apps/web/src/features/exams/real-server-check.mjs
// Screenshots: apps/web/test-screenshots/exams-*.png (git-ignored).
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..', '..', '..');
const port = Number(process.env.PORT ?? 18961);
const base = `http://127.0.0.1:${port}`;
const dataDir = mkdtempSync(join(tmpdir(), 'medlevo-ex-e2e-'));
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
      if (m.type() === 'error' && !/favicon|401|409|Failed to load resource|ERR_INTERNET_DISCONNECTED/.test(m.text())) problems.push(`console: ${m.text()}`);
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
  const noOverflow = async (p, what) => {
    const o = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(o <= 1, `${what}: no horizontal overflow (${o}px)`);
  };

  check((await api('POST', '/api/auth/setup', { username: 'owner', password: 'correct horse battery staple' })).status === 200, 'owner set up');
  const course = (await api('POST', '/api/library/nodes', { parent_id: null, kind: 'course', title: 'Surgery Course 1' })).json.node;
  const qs = await upload('questions_surgery_course1.pdf', 'application/pdf', 'question_source', course.id, 'Surgery Course 1 Questions');
  await upload('questions_previous_exam_2024.pdf', 'application/pdf', 'previous_exam', course.id, 'Previous exam 2024');
  const lec = await upload('lecture_appendicitis.pdf', 'application/pdf', 'lecture', course.id, 'Acute Appendicitis');
  check(await idle(), 'processing + extraction + matching finished');
  const list = (await api('GET', `/api/questions?source_id=${qs.source_id}&limit=50`)).json;
  const a3 = list.items.find((i) => /30-year-old/.test(i.stem_preview));
  check(!!a3, 'question A3 found');

  // ── history (empty) and the AI-gated generator ──
  await page.goto(`${base}/exams`);
  await page.getByRole('heading', { name: 'التدريب والامتحانات' }).waitFor();
  await page.getByText('لم تبدأ أي اختبار بعد').waitFor();
  check(true, 'history: honest empty state');
  check(await page.getByText(/توليد الأسئلة الصعبة: .*ANTHROPIC_API_KEY|توليد الأسئلة الصعبة: .*مزود/).isVisible(), 'history: generator disabled with the reason');
  await page.screenshot({ path: join(shots, 'exams-history-empty-1280.png') });

  // ── builder: scope, live preview with exclusion reasons ──
  await page.goto(`${base}/exams/new`);
  await page.getByRole('heading', { name: 'اختبار جديد' }).waitFor();
  await page.getByLabel('Surgery Course 1 Questions').check();
  await page.getByLabel('الوضع').selectOption('exam');
  await page.getByLabel('عدد الأسئلة').fill('20');
  await page.getByText(/ما استُبعد ولماذا/).waitFor({ timeout: 10_000 });
  check(await page.getByText(/مفتاحها غير محسوم/).isVisible(), 'builder: unresolved keys excluded from the assessed exam with the reason');
  check(await page.getByText(/قابلة للاحتساب: 6، غير قابلة: 1/).isVisible(), 'builder: real scorable / unscorable counts (6 / 1)');
  check(await page.getByRole('button', { name: /توليد أسئلة صعبة/ }).isDisabled(), 'builder: generation disabled without AI');
  await page.screenshot({ path: join(shots, 'exams-builder-1280.png'), fullPage: true });
  await page.getByRole('button', { name: /^ابدأ امتحان/ }).click();
  await page.waitForURL(/\/exams\/[0-9A-Z]+$/);
  const examUrl = page.url();
  await page.getByText(/^السؤال 1 من 6$/).waitFor();
  check(!(await page.getByRole('button', { name: 'تلميح' }).count()), 'exam: no hints');
  check(!(await page.getByRole('button', { name: 'إيقاف مؤقت' }).count()), 'exam: no pause (fixed policy)');
  const html = await page.content();
  check(!/Section A|Abdominal pain|Surgery Course 1 Questions|مفتاح المصدر/.test(html.replace(/<title>.*?<\/title>/, '')), 'exam: no source / section / key text in the delivered page (AC-19)');
  await page.keyboard.press('2');
  check((await page.locator('.ex-opt[aria-checked="true"]').count()) === 1, 'exam: key «2» selects an option');
  await page.getByRole('button', { name: 'واثق' }).click();
  check((await page.getByRole('button', { name: 'واثق' }).getAttribute('aria-pressed')) === 'true', 'exam: confidence recorded (aria-pressed)');
  await page.getByRole('button', { name: 'علّم للمراجعة' }).click();
  await page.keyboard.press('ArrowLeft');
  await page.getByText(/^السؤال 2 من 6$/).waitFor();
  check(true, 'exam: ArrowLeft moves to the next question (RTL)');
  await page.screenshot({ path: join(shots, 'exams-runner-exam-1280.png') });

  // offline: answers keep being saved on this device
  await ctx.setOffline(true);
  await page.keyboard.press('1');
  await page.getByText('محفوظ محليًا').first().waitFor({ timeout: 10_000 });
  check(true, 'offline: «محفوظ محليًا» after answering without a connection');
  await ctx.setOffline(false);
  // reload while the outbox cannot reach the server: the attempt resumes from IndexedDB (local copy merged)
  await page.route('**/api/sync/push', (r) => r.abort());
  await page.reload();
  await page.getByText(/^السؤال 2 من 6$/).waitFor({ timeout: 15_000 });
  check((await page.locator('.ex-opt[aria-checked="true"]').count()) === 1, 'reload before sync: the attempt resumes from IndexedDB with the unsynced answer');
  await page.unroute('**/api/sync/push');
  await page.waitForTimeout(1500);

  // finish → results
  await page.getByRole('button', { name: 'إنهاء الاختبار' }).click();
  const dialogText = await page.locator('.ml-dialog').innerText({ timeout: 10_000 }).catch(async () => {
    await page.screenshot({ path: join(shots, 'exams-debug-finish.png') });
    return '';
  });
  check(/أُجيب 2 من 6/.test(dialogText), `finish dialog shows answered counts («${dialogText.replace(/\s+/g, ' ').slice(0, 160)}»)`);
  await page.getByRole('button', { name: 'إنهاء وعرض النتيجة' }).click();
  await page.waitForURL(/\/results$/);
  await page.getByText('إجابة صحيحة من الأسئلة المحسوبة').waitFor({ timeout: 20_000 });
  check(await page.getByText(/الدقة = الإجابات الصحيحة ÷ الأسئلة المحسوبة/).isVisible(), 'results: explicit denominator');
  check(await page.getByText('حسب المحاضرة').isVisible(), 'results: by-lecture breakdown');
  await page.getByRole('button', { name: 'عرض التصحيح والأدلة' }).first().click();
  await page.getByRole('region', { name: 'التصحيح والشرح' }).first().waitFor();
  check(await page.getByText(/سؤال من مصدر الأسئلة/).first().isVisible(), 'results: correction shows the origin label after finishing');
  await page.screenshot({ path: join(shots, 'exams-results-1280.png'), fullPage: true });

  // ── practice from the lecture («تدرّب»): hints → check → feedback ──
  await page.goto(`${base}/practice?source_id=${lec.source_id}&question_id=${a3.id}`);
  await page.waitForURL(/\/exams\/[0-9A-Z]+$/);
  await page.getByText(/30-year-old woman/).waitFor();
  check(true, 'practice deep link starts with the chosen question');
  await page.getByRole('button', { name: 'تلميح' }).click();
  await page.getByText('التلميح الأول: أين تبحث').waitFor();
  check(!(await page.locator('.ex-hint').first().innerText()).includes('β-hCG'), 'hint 1 never names the answer');
  await page.getByRole('button', { name: 'تلميح أعمق' }).click();
  await page.getByText('التلميح الثاني: الكلمات المفتاحية في السؤال').waitFor();
  await page.getByRole('radio', { name: /Pregnancy test/ }).click();
  await page.getByRole('button', { name: 'تحقّق من إجابتي' }).click();
  await page.getByText('إجابة صحيحة').waitFor({ timeout: 15_000 });
  const fbText = (await page.getByRole('region', { name: 'التصحيح والشرح' }).innerText()).replace(/\s+/g, ' ');
  check(/صحيحة بعد تلميح/.test(fbText), `practice: a hint-assisted correct answer is labelled (AC-27) («${fbText.slice(0, 200)}»)`);
  await page.screenshot({ path: join(shots, 'exams-practice-1280.png'), fullPage: true });

  // ── generator page without AI ──
  await page.goto(`${base}/exams/generate`);
  await page.getByRole('heading', { name: /توليد أسئلة صعبة/ }).waitFor();
  check(await page.getByRole('button', { name: 'ولّد وتحقق' }).isDisabled(), 'generator: disabled without an AI provider');
  check(await page.getByText(/ANTHROPIC_API_KEY|مزود/).first().isVisible(), 'generator: the reason is shown');

  // ── written answer (quick-added short answer) ──
  const qa = await api('POST', '/api/questions/quick-add', { text: 'List the investigations used when the diagnosis of appendicitis is uncertain.', course_node_id: course.id });
  const wqid = qa.json?.question_id;
  check(!!wqid, 'short-answer question added');
  await page.goto(`${base}/exams/written/${wqid}`);
  await page.getByRole('heading', { name: 'إجابة مكتوبة' }).waitFor();
  await page.getByLabel('اكتب إجابتك').fill('Ultrasound first in children and pregnant women; CT in adults.');
  await page.getByRole('button', { name: 'احفظ الإجابة' }).click();
  await page.getByText('إجاباتك السابقة').waitFor();
  check(await page.getByRole('button', { name: 'قيّم إجابتي' }).isDisabled(), 'written: grading disabled without AI');
  check(await page.getByText(/التقييم الآلي:/).isVisible(), 'written: the reason is shown');
  await page.screenshot({ path: join(shots, 'exams-written-1280.png'), fullPage: true });

  // ── phone 390×844 (light + dark) ──
  for (const scheme of ['light', 'dark']) {
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ar-IQ', serviceWorkers: 'block', colorScheme: scheme, hasTouch: true, isMobile: true });
    await phone.addCookies((await ctx.cookies()).map((c) => ({ ...c })));
    const p = await phone.newPage();
    watch(p);
    await p.goto(`${base}/exams/new`);
    await p.getByRole('heading', { name: 'اختبار جديد' }).waitFor();
    await noOverflow(p, `builder 390 ${scheme}`);
    await p.screenshot({ path: join(shots, `exams-builder-390-${scheme}.png`) });
    await p.goto(`${examUrl}/results`);
    await p.getByText('إجابة صحيحة من الأسئلة المحسوبة').waitFor({ timeout: 15_000 });
    await noOverflow(p, `results 390 ${scheme}`);
    await p.screenshot({ path: join(shots, `exams-results-390-${scheme}.png`), fullPage: true });
    await p.goto(`${base}/practice?source_id=${lec.source_id}&question_id=${a3.id}`);
    await p.waitForURL(/\/exams\/[0-9A-Z]+$/);
    await p.getByText(/30-year-old woman/).waitFor();
    await noOverflow(p, `runner 390 ${scheme}`);
    const target = await p.locator('.ex-opt').first().boundingBox();
    check(!!target && target.height >= 44, `runner 390 ${scheme}: option touch target ≥ 44px (${target?.height})`);
    await p.screenshot({ path: join(shots, `exams-runner-390-${scheme}.png`), fullPage: true });
    await phone.close();
  }
} catch (e) {
  problems.push(`exception: ${e?.stack ?? e}`);
} finally {
  await browser.close();
  server.kill();
  rmSync(dataDir, { recursive: true, force: true });
}
console.log(results.join('\n'));
if (problems.length) {
  console.log('\nPROBLEMS:\n' + problems.join('\n'));
  process.exit(1);
}
console.log(`\nOK: ${results.length} checks passed.`);
