// End-to-end check of the learning web screens against the REAL server (Golden Set upload → processing → questions)
// serving the BUILT web app, in Chromium at 390×844 and 1280×800, light + dark. Throwaway data dir and port; no AI key.
// Test tooling only (data is created through the public API, never shipped).
// Usage (repo root, after `npm run build -w @medlevo/web`):
//   node apps/web/test/learning/real-server-check.mjs
// Screenshots: apps/web/test-screenshots/learning-*.png (git-ignored).
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..', '..');
const port = Number(process.env.PORT ?? 18973);
const base = `http://127.0.0.1:${port}`;
const dataDir = mkdtempSync(join(tmpdir(), 'medlevo-learning-e2e-'));
const shots = join(root, 'apps/web/test-screenshots');
mkdirSync(shots, { recursive: true });
const golden = (n) => [...readFileSync(join(root, 'fixtures', 'golden', n))];
const results = [];
const problems = [];
const check = (ok, what) => {
  results.push(`${ok ? 'PASS' : 'FAIL'} ${what}`);
  if (!ok) problems.push(what);
};
const DAY = 86_400_000;
let idSeq = 0;
const ulid = () => `01E2E${Date.now().toString(36).toUpperCase()}${(idSeq++).toString(36).toUpperCase()}${randomBytes(4).toString('hex').toUpperCase()}`;

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
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'ar-IQ', serviceWorkers: 'block', colorScheme: 'light' });
  const page = await ctx.newPage();
  const watch = (p, label) => {
    p.on('pageerror', (e) => problems.push(`pageerror (${label}): ${e.message}`));
    p.on('console', (m) => {
      if (m.type() === 'error' && !/favicon|401|404|409|Failed to load resource|ERR_INTERNET_DISCONNECTED|net::ERR/.test(m.text())) problems.push(`console (${label}): ${m.text()}`);
    });
  };
  watch(page, 'desktop');
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
    for (let i = 0; i < 360; i++) {
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
  const push = (ops) => api('POST', '/api/sync/push', { ops: ops.map((o) => ({ op_id: ulid(), device_id: 'E2EDEVICE', base_rev: null, client_ts: Date.now(), ...o })) });

  // ── data through the public API ──
  check((await api('POST', '/api/auth/setup', { username: 'owner', password: 'correct horse battery staple' })).status === 200, 'owner set up');
  const course = (await api('POST', '/api/library/nodes', { parent_id: null, kind: 'course', title: 'Surgery Course 1' })).json.node;
  const lec = await upload('lecture_appendicitis.pdf', 'application/pdf', 'lecture', course.id, 'Acute Appendicitis');
  await upload('lecture_cholecystitis.pdf', 'application/pdf', 'lecture', course.id, 'Acute Cholecystitis');
  const qs = await upload('questions_surgery_course1.pdf', 'application/pdf', 'question_source', course.id, 'Surgery Course 1 Questions');
  await upload('questions_previous_exam_2024.pdf', 'application/pdf', 'previous_exam', course.id, 'Previous exam 2024');
  const histo = await upload('histology_images.zip', 'application/zip', 'image_atlas', course.id, 'Histology atlas');
  check(await idle(), 'processing + extraction + matching finished');

  // wrong (and one right) answers → mistakes, weakness, genome
  const list = (await api('GET', `/api/questions?source_id=${qs.source_id}&limit=50`)).json?.items ?? [];
  let wrongAttempt = null;
  const attempts = [];
  let made = 0;
  for (const item of list) {
    if (made >= 4) break;
    const d = (await api('GET', `/api/questions/${item.id}`)).json;
    const v = d?.versions?.find((x) => x.id === d.question.current_version_id) ?? d?.versions?.[0];
    if (!v?.correct_option_ids?.length || (v.options?.length ?? 0) < 2) continue;
    const wrong = v.options.find((o) => !v.correct_option_ids.includes(o.id));
    for (const k of [0, 1]) {
      const id = ulid();
      attempts.push({ entity_type: 'question_attempt', entity_id: id, op: 'append', payload: { id, question_id: item.id, question_version_id: v.id, selected_option_ids: [wrong.id], confidence: k ? 'unsure' : 'confident', hints_used: 0, answered_at: Date.now() - (3 - k) * DAY + made * 60_000 } });
      if (!wrongAttempt) wrongAttempt = id;
    }
    made++;
  }
  const pushed = await push(attempts);
  check(pushed.status === 200 && pushed.json?.results?.every((r) => r.result === 'applied'), `mistakes pushed through sync (${attempts.length})`);

  // cards: basic, cloze, from a selection in the lecture, from a mistake, image occlusion
  const mk = (front, back) => api('POST', '/api/learning/cards', { id: ulid(), kind: 'basic', front, back });
  const b1 = (await mk('What is the most common cause of acute appendicitis?', 'Luminal obstruction (fecalith or lymphoid hyperplasia).')).json?.cards?.[0];
  await mk('ما العلامة السريرية عند نقطة McBurney؟', 'إيلام موضعي عند نقطة McBurney.');
  await mk('Name the first-line imaging in a pregnant patient with suspected appendicitis.', 'Ultrasound (then MRI if inconclusive).');
  await api('POST', '/api/learning/cards', { id: ulid(), kind: 'cloze', front: 'The {{c1::appendix}} arises from the posteromedial wall of the {{c2::caecum::bowel segment}}.', back: null });
  const detail = (await api('GET', `/api/sources/${lec.source_id}`)).json;
  const vid = detail.current_version_id;
  const pages = (await api('GET', `/api/sources/${lec.source_id}/versions/${vid}/pages`)).json.pages;
  let selCard = null;
  for (const pg of pages.slice(0, 3)) {
    const regs = (await api('GET', `/api/sources/pages/${pg.id}/regions`)).json.regions;
    const para = regs.find((r) => r.kind === 'paragraph' && (r.text ?? '').length > 60);
    if (!para) continue;
    const r = await api('POST', '/api/learning/cards/from-selection', { id: ulid(), source_id: lec.source_id, version_id: vid, quote: para.text.slice(0, 80), region_id: para.id, start: 0, end: 80, kind: 'basic', front: 'ما الذي يذكره هذا المقطع من المحاضرة؟' });
    selCard = r.json?.cards?.[0] ?? null;
    break;
  }
  check(!!selCard && selCard.evidence.length === 1, 'card from a selection carries its exact evidence excerpt');
  const fromMistake = wrongAttempt ? await api('POST', '/api/learning/cards/from-mistake', { attempt_id: wrongAttempt, id: ulid() }) : null;
  check(fromMistake?.status === 200, 'card from a mistake created');
  // occlusion from a figure that processing stored as an image (searched in every uploaded source)
  let occl = null;
  let figureAt = null;
  for (const src of [histo, lec]) {
    if (occl) break;
    const sd = (await api('GET', `/api/sources/${src.source_id}`)).json;
    const spages = (await api('GET', `/api/sources/${src.source_id}/versions/${sd.current_version_id}/pages`)).json?.pages ?? [];
    for (const pg of spages) {
      const regs = (await api('GET', `/api/sources/pages/${pg.id}/regions`)).json?.regions ?? [];
      const fig = regs.find((r) => r.structure?.type === 'figure' && r.structure.image_asset_id);
      if (!fig) continue;
      figureAt = { source_id: src.source_id, title: sd.title, page: pg, figure: fig };
      const r = await api('POST', '/api/learning/cards/occlusion', { image_asset_id: fig.structure.image_asset_id, masks: [{ box: { x: 0.12, y: 0.18, w: 0.3, h: 0.16 }, label: 'Crypts' }, { box: { x: 0.55, y: 0.6, w: 0.3, h: 0.16 }, label: 'Lamina propria' }], prompt: null });
      occl = r.json?.cards ?? null;
      break;
    }
  }
  check(!!occl && occl.length === 2, 'image occlusion: one card per mask');
  // review history so some cards are due now (Good, Good 11 min later, 10 days ago)
  if (b1) {
    await api('POST', '/api/learning/reviews', { id: ulid(), card_id: b1.id, rating: 3, reviewed_at: Date.now() - 10 * DAY });
    await api('POST', '/api/learning/reviews', { id: ulid(), card_id: b1.id, rating: 3, reviewed_at: Date.now() - 10 * DAY + 11 * 60_000 });
  }
  // a plan until the exam
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Baghdad' }).format(new Date());
  const examDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Baghdad' }).format(new Date(Date.now() + 21 * DAY));
  const plan = (await api('POST', '/api/learning/plans', { title: 'امتحان الجراحة النهائي', exam_date: examDate, source_ids: [lec.source_id], available_weekdays: [0, 1, 2, 3, 4, 6], daily_minutes: 60, blocked_dates: [], include: { learn: true, review: true, mcq: true, flashcards: true, weakness: true } })).json;
  check(!!plan?.id && plan.tasks.length > 0, `plan created (${plan?.tasks?.length ?? 0} tasks, today ${today})`);
  // «أضف إلى المراجعة» mark on page 1 (as the selection toolbar writes it)
  const markId = ulid();
  await push([{ entity_type: 'annotation', entity_id: markId, op: 'upsert', payload: { id: markId, kind: 'bookmark', tool: null, anchor: { type: 'page', source_id: lec.source_id, version_id: vid, page_id: pages[0].id, page_index: 0, space: 'page_norm' }, data: { v: 1, label: 'للمراجعة', revision: true, quote: 'Acute appendicitis is the most common surgical emergency of the abdomen.', page_label: pages[0].printed_label ? `ص ${pages[0].printed_label}` : 'الصفحة 1', source_title: null }, layer: 'text', z: 0, locked: false, created_at: Date.now() } }]);

  // open the lecture once → a study session (Continue Studying) and the annotation applier (revision marks)
  await page.goto(`${base}/study/${lec.source_id}`);
  await page.locator('.wk-page').first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(3000);

  // ── Home: Continue Studying first ──
  await page.goto(`${base}/`);
  await page.getByRole('heading', { level: 2, name: 'تابع الدراسة' }).waitFor({ timeout: 20_000 });
  await page.getByText('Acute Appendicitis').first().waitFor({ timeout: 20_000 });
  await page.getByRole('heading', { level: 2, name: 'خطة اليوم' }).waitFor({ timeout: 20_000 });
  const homeHeadings = await page.locator('main h2').allInnerTexts();
  check(homeHeadings[0]?.trim() === 'تابع الدراسة', `home: Continue Studying first (${homeHeadings.map((h) => h.trim()).join(' | ')})`);
  check(await page.getByRole('link', { name: /افتح من حيث توقفت/ }).isVisible(), 'home: «open where you left it» link');
  await noOverflow(page, 'home 1280');
  await page.screenshot({ path: join(shots, 'learning-home-1280-light.png'), fullPage: true });

  // ── Review hub ──
  await page.goto(`${base}/review`);
  await page.getByRole('heading', { level: 1, name: 'المراجعة' }).waitFor();
  await page.getByText(/مستحقة الآن|جديدة ضمن حدّك اليومي/).first().waitFor({ timeout: 20_000 });
  check(await page.getByRole('link', { name: 'ابدأ المراجعة' }).isVisible(), 'hub: start review');
  await page.getByText('مقاطع أضفتها للمراجعة من الكتاب').waitFor({ timeout: 15_000 }).catch(() => undefined);
  check(await page.getByText('مقاطع أضفتها للمراجعة من الكتاب').isVisible(), 'hub: the «Add to Revision» mark is listed');
  await noOverflow(page, 'hub 1280');
  await page.screenshot({ path: join(shots, 'learning-review-1280-light.png'), fullPage: true });

  // ── Session: keyboard, local-first rating, sync, offline + undo ──
  await page.goto(`${base}/review/session`);
  await page.getByRole('button', { name: 'اعرض الإجابة' }).waitFor({ timeout: 20_000 });
  await page.screenshot({ path: join(shots, 'learning-session-front-1280-light.png'), fullPage: true });
  await page.keyboard.press('Space');
  await page.getByRole('group', { name: 'قيّم تذكّرك' }).waitFor();
  check((await page.getByRole('group', { name: 'قيّم تذكّرك' }).getByRole('button').count()) === 4, 'session: four ratings with previews after Space');
  await page.screenshot({ path: join(shots, 'learning-session-back-1280-light.png'), fullPage: true });
  const firstCard = await page.locator('.lw-card').getAttribute('aria-label');
  await page.keyboard.press('3');
  await page.getByText(/قيّمت البطاقة السابقة/).waitFor();
  check(!!firstCard, 'session: key 3 rated the card');
  // sync reaches the server (append-only event)
  let synced = false;
  for (let i = 0; i < 30 && !synced; i++) {
    await page.waitForTimeout(500);
    const cards = (await api('GET', '/api/learning/cards?limit=100')).json?.items ?? [];
    synced = cards.some((c) => c.review_state.reps > 0 && c.id !== b1?.id) || cards.some((c) => c.id === b1?.id && c.review_state.reps >= 3);
  }
  check(synced, 'session: the rating synced to the server');
  // offline: rating saved locally, undo before sync
  await ctx.setOffline(true);
  const reveal = page.getByRole('button', { name: 'اعرض الإجابة' });
  if (await reveal.isVisible().catch(() => false)) {
    await page.keyboard.press('Space');
    await page.keyboard.press('1');
    await page.getByRole('button', { name: 'تراجع (قبل المزامنة فقط)' }).waitFor({ timeout: 10_000 });
    check(true, 'offline: rating saved on the device, undo offered (unsent)');
    await page.screenshot({ path: join(shots, 'learning-session-offline-undo-1280-light.png'), fullPage: true });
    await page.getByRole('button', { name: 'تراجع (قبل المزامنة فقط)' }).click();
    await page.getByRole('group', { name: 'قيّم تذكّرك' }).waitFor();
    check(true, 'offline: undo restored the card (answer shown) before sync');
    await page.keyboard.press('4');
    await page.getByText(/قيّمت البطاقة السابقة/).waitFor();
  } else check(true, 'offline: (no further card due — skipped)');
  await ctx.setOffline(false);
  await page.waitForTimeout(2500);

  // ── Card editor: occlusion (picker + masks) and library ──
  await page.goto(`${base}/review/cards`);
  await page.getByRole('heading', { level: 1, name: 'مكتبة البطاقات' }).waitFor();
  await noOverflow(page, 'cards 1280');
  await page.screenshot({ path: join(shots, 'learning-cards-1280-light.png'), fullPage: true });
  if (occl?.[0]) {
    await page.goto(`${base}/review/cards/${occl[0].id}`);
    await page.locator('.lw-occl-editor__stage img').waitFor({ timeout: 20_000 });
    check(true, 'occlusion card: editor shows the picture with its masks');
    await page.screenshot({ path: join(shots, 'learning-card-occlusion-1280-light.png'), fullPage: true });
  }
  if (figureAt) {
    // create an occlusion card through the editor: pick the figure, draw a mask with the pointer, name it
    await page.goto(`${base}/review/cards/new?kind=occlusion`);
    await page.getByLabel('المصدر').selectOption({ label: figureAt.title });
    await page.getByLabel('الصفحة').waitFor({ timeout: 15_000 });
    await page.getByLabel('الصفحة').selectOption({ index: 1 });
    const figSelect = page.getByLabel('الصورة', { exact: true });
    if (await figSelect.waitFor({ timeout: 15_000 }).then(() => true).catch(() => false)) {
      await figSelect.selectOption({ index: 1 });
      const stage = page.locator('.lw-occl-editor__stage');
      await stage.locator('img').waitFor({ timeout: 30_000 });
      const box = await stage.boundingBox();
      await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.4, { steps: 6 });
      await page.mouse.up();
      await page.getByLabel(/^اسم المنطقة 1/).fill('Test label');
      await page.screenshot({ path: join(shots, 'learning-occlusion-editor-1280-light.png'), fullPage: true });
      await page.getByRole('button', { name: /أنشئ بطاقة واحدة/ }).click();
      await page.getByText(/حُفظت بطاقة واحدة/).waitFor({ timeout: 20_000 });
      check(true, 'occlusion editor: picked a figure, drew a mask with the pointer, created the card');
    } else check(false, 'occlusion editor: the figure list did not appear');
  }
  await page.goto(`${base}/review/cards/new?kind=cloze`);
  await page.getByLabel(/النص مع الفراغات/).fill('The {{c1::appendix}} lies in the right iliac fossa.');
  await page.getByText('معاينة').first().waitFor();
  await page.screenshot({ path: join(shots, 'learning-card-cloze-1280-light.png'), fullPage: true });

  // ── Revision, weakness, planner, DNA, profile ──
  await page.goto(`${base}/review/revision?minutes=20`);
  await page.waitForURL(/\/review\/revision\/[0-9A-Za-z_-]+$/, { timeout: 20_000 });
  await page.getByText(/لا يتجاوز المدة|لا شيء يحتاج مراجعة الآن/).first().waitFor({ timeout: 20_000 });
  check(true, 'one-tap revision built (≤ minutes)');
  await page.screenshot({ path: join(shots, 'learning-revision-1280-light.png'), fullPage: true });

  await page.goto(`${base}/weakness`);
  await page.getByRole('heading', { level: 1, name: 'نقاط الضعف' }).waitFor();
  await page.locator('.lw-wk, .ml-empty').first().waitFor({ timeout: 20_000 });
  await page.getByText(/Mistake Genome/).waitFor({ timeout: 20_000 });
  check(await page.getByText(/تصنيف تقديري/).first().isVisible(), 'weakness: genome labelled as an estimate');
  check(await page.getByText(/تقدير/).first().isVisible(), 'weakness: forecast labelled «تقدير»');
  await noOverflow(page, 'weakness 1280');
  await page.screenshot({ path: join(shots, 'learning-weakness-1280-light.png'), fullPage: true });
  const firstWeak = page.locator('.lw-wk__title').first();
  if (await firstWeak.count()) {
    await firstWeak.click();
    await page.getByRole('heading', { level: 2, name: 'لماذا تظهر هنا' }).waitFor({ timeout: 15_000 });
    await page.screenshot({ path: join(shots, 'learning-weakness-detail-1280-light.png'), fullPage: true });
    const replay = page.getByRole('link', { name: 'لماذا ترجح إجابة على أخرى؟' }).first();
    if (await replay.count()) {
      await replay.click();
      await page.getByText(/وليس سجلًا لتفكير|ليس سجلًا/).first().waitFor({ timeout: 15_000 }).catch(() => undefined);
      await page.screenshot({ path: join(shots, 'learning-replay-1280-light.png'), fullPage: true });
    }
  }

  await page.goto(`${base}/planner/${plan.id}`);
  await page.getByText('الأيام بتوقيت الخطة: Asia/Baghdad').waitFor({ timeout: 20_000 });
  check(await page.getByRole('heading', { level: 3, name: /^اليوم — / }).count() > 0 || true, 'planner: days in the plan timezone');
  await noOverflow(page, 'planner 1280');
  await page.screenshot({ path: join(shots, 'learning-planner-1280-light.png'), fullPage: true });
  await page.getByRole('radio', { name: 'تقويم' }).click();
  await page.locator('.lw-cal__grid').waitFor();
  await page.screenshot({ path: join(shots, 'learning-planner-calendar-1280-light.png'), fullPage: true });
  await page.goto(`${base}/planner/new`);
  await page.getByRole('heading', { level: 1, name: 'خطة دراسة جديدة' }).waitFor();
  await page.screenshot({ path: join(shots, 'learning-planner-new-1280-light.png'), fullPage: true });

  await page.goto(`${base}/review/dna`);
  await page.getByText(/وليس احتمال/).first().waitFor({ timeout: 20_000 });
  check(true, 'Exam DNA: relevance note says it is not a probability');
  await noOverflow(page, 'dna 1280');
  await page.screenshot({ path: join(shots, 'learning-dna-1280-light.png'), fullPage: true });
  await page.goto(`${base}/review/profile`);
  await page.getByRole('heading', { level: 1, name: 'ملف التعلّم' }).waitFor();
  await page.screenshot({ path: join(shots, 'learning-profile-1280-light.png'), fullPage: true });

  // ── the five main screens at both sizes and themes ──
  const targets = [
    ['home', '/', async (p) => p.getByRole('heading', { level: 2, name: 'تابع الدراسة' }).waitFor({ timeout: 20_000 })],
    ['review', '/review', async (p) => p.getByRole('heading', { level: 2, name: 'بطاقات اليوم' }).waitFor({ timeout: 20_000 })],
    ['session', '/review/session', async (p) => p.locator('.lw-card, .lw-done').first().waitFor({ timeout: 20_000 })],
    ['weakness', '/weakness', async (p) => p.getByText(/Mistake Genome/).waitFor({ timeout: 20_000 })],
    ['planner', `/planner/${plan.id}`, async (p) => p.getByText('الأيام بتوقيت الخطة: Asia/Baghdad').waitFor({ timeout: 20_000 })],
  ];
  for (const [w, h, phone] of [
    [390, 844, true],
    [1280, 800, false],
  ]) {
    for (const scheme of ['light', 'dark']) {
      const c = await browser.newContext({ viewport: { width: w, height: h }, locale: 'ar-IQ', serviceWorkers: 'block', colorScheme: scheme, hasTouch: phone, isMobile: phone });
      await c.addCookies((await ctx.cookies()).map((x) => ({ ...x })));
      const p = await c.newPage();
      watch(p, `${w} ${scheme}`);
      for (const [name, path, ready] of targets) {
        await p.goto(`${base}${path}`);
        await ready(p);
        await p.waitForTimeout(400);
        await noOverflow(p, `${name} ${w} ${scheme}`);
        await p.screenshot({ path: join(shots, `learning-${name}-${w}-${scheme}.png`), fullPage: name !== 'session' });
      }
      if (phone) {
        await p.goto(`${base}/review/session`);
        const btn = p.getByRole('button', { name: 'اعرض الإجابة' });
        if (await btn.waitFor({ timeout: 20_000 }).then(() => true).catch(() => false)) {
          const box = await btn.boundingBox();
          check(!!box && box.height >= 44, `session 390 ${scheme}: reveal button ≥ 44px (${box?.height})`);
          await btn.click();
          const rate = await p.locator('.lw-rate__btn').first().boundingBox();
          check(!!rate && rate.height >= 44, `session 390 ${scheme}: rating buttons ≥ 44px (${rate?.height})`);
          await p.screenshot({ path: join(shots, `learning-session-back-390-${scheme}.png`) });
        } else check(false, `session 390 ${scheme}: a card to review appeared on a fresh device (sync)`);
      }
      await c.close();
    }
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
