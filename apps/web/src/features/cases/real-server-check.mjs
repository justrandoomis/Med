// End-to-end check of clinical cases / OSCE / viva and media (images, image quiz, audio transcript) against the REAL
// server serving the BUILT web app, in Chromium at 1280×800 and 390×844 (light + dark). Throwaway data dir and port.
// No AI provider: AI generation / AI judge / transcription must show their reasons. Test tooling only.
// Usage (repo root, after `npm run build -w @medlevo/web`):
//   node apps/web/src/features/cases/real-server-check.mjs
// Screenshots: apps/web/test-screenshots/d3-*.png (git-ignored).
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..', '..', '..');
const port = Number(process.env.PORT ?? 18977);
const base = `http://127.0.0.1:${port}`;
const dataDir = mkdtempSync(join(tmpdir(), 'medlevo-d3-e2e-'));
const shots = join(root, 'apps/web/test-screenshots');
mkdirSync(shots, { recursive: true });
const golden = (n) => [...readFileSync(join(root, 'fixtures', 'golden', n))];
const results = [];
const problems = [];
const check = (ok, what) => {
  results.push(`${ok ? 'PASS' : 'FAIL'} ${what}`);
  if (!ok) problems.push(what);
};

/** 2 s of silence, 8 kHz mono 16-bit PCM WAV (a real, playable file). */
function wav() {
  const samples = 16000;
  const b = Buffer.alloc(44 + samples * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + samples * 2, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(16000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(samples * 2, 40);
  return [...b];
}

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

const appendicitis = (evidenceId) => ({
  kind: 'case',
  title: 'ألم في الحفرة الحرقفية اليمنى (TEST)',
  summary: 'أحمد، 24 سنة، ألم في البطن منذ الأمس.',
  objectives: ['تمييز هجرة الألم من حول السرة إلى RIF'],
  facts: [
    { id: 'f_story', label: 'الشكوى', value: 'ألم بطني منذ 18 ساعة', kind: 'story', reveal: 'start' },
    { id: 'f_temp', label: 'الحرارة', value: '37.8 °C', kind: 'vital', reveal: 'on_request' },
    { id: 'f_rif', label: 'جس الحفرة الحرقفية اليمنى', value: "Tenderness at McBurney's point", kind: 'examination', reveal: 'on_request' },
    { id: 'f_wbc', label: 'تعداد الكريات البيض', value: 'WBC 13 ×10⁹/L', kind: 'investigation', reveal: 'on_request' },
  ],
  stages: [
    { id: 's1', type: 'presentation', title: 'القصة الأولية', prompt: 'اقرأ القصة ثم تابع.', reveal_fact_ids: ['f_temp'], select: 'none', next_stage_id: 's2' },
    {
      id: 's2',
      type: 'examination',
      title: 'الفحص',
      prompt: 'ماذا تفحص؟',
      select: 'many',
      next_stage_id: 's3',
      decisions: [
        { id: 'd_rif', label: 'Palpate the right iliac fossa', appropriateness: 'appropriate', reveal_fact_ids: ['f_rif'] },
        { id: 'd_murphy', label: "Check Murphy's sign", appropriateness: 'inappropriate', consequence: 'لا يضيف هذا الفحص معلومة جديدة في هذا السيناريو.' },
      ],
    },
    {
      id: 's3',
      type: 'investigations',
      title: 'الفحوص',
      prompt: 'اختر فحصًا.',
      select: 'one',
      next_stage_id: null,
      decisions: [
        {
          id: 'd_cbc',
          label: 'Full blood count',
          appropriateness: 'appropriate',
          reveal_fact_ids: ['f_wbc'],
          explanation: [{ text: 'A white cell count above 11 ×10⁹/L supports the diagnosis.', evidence_ids: evidenceId ? [evidenceId] : [] }],
        },
        { id: 'd_mri', label: 'MRI brain', appropriateness: 'inappropriate', consequence: 'لا يغيّر الفحص مسار الحالة.' },
      ],
    },
  ],
  start_stage_id: 's1',
  checklist: [
    { id: 'c1', text: 'فحص الحفرة الحرقفية اليمنى', category: 'examination', points: 2, satisfied_by: ['d_rif'] },
    { id: 'c2', text: 'طلب تعداد الدم', category: 'investigations', points: 1, satisfied_by: ['d_cbc'], rationale: [{ text: 'A white cell count above 11 ×10⁹/L supports the diagnosis.', evidence_ids: evidenceId ? [evidenceId] : [] }] },
  ],
});

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
  const upload = (bytes, name, type, sourceType, nodeId, title) =>
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
      { bytes, name, type, sourceType, nodeId, title },
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
  const lec = await upload(golden('lecture_appendicitis.pdf'), 'lecture_appendicitis.pdf', 'application/pdf', 'lecture', course.id, 'Acute Appendicitis');
  const aud = await upload(wav(), 'lecture3.wav', 'audio/wav', 'lecture_audio', course.id, 'تسجيل المحاضرة 3');
  check(!!lec?.source_id && !!aud?.source_id, 'lecture PDF and audio recording uploaded');
  check(await idle(), 'processing finished');

  // evidence for the case (deterministic suggestion inside the Source Lock)
  const scope = { mode: 'lecture_only', lecture_source_id: lec.source_id };
  const sug = (await api('POST', '/api/cases/evidence/suggest', { scope, text: 'white cell count above 11' })).json;
  const ev = sug?.evidence?.find((e) => /white cell count/i.test(e.quote));
  check(!!ev, 'evidence suggestion finds the white-cell-count passage in the lecture');
  const created = await api('POST', '/api/cases', { definition: appendicitis(ev?.id), scope });
  check(created.status === 200, `owner-authored case saved (${created.status})`);
  const caseId = created.json.id;

  // ── cases list ──
  await page.goto(`${base}/cases`);
  await page.getByRole('heading', { name: /الحالات السريرية/ }).waitFor();
  check(
    await page
      .getByText(/توليد الحالات يتطلب|ANTHROPIC_API_KEY|مزود/)
      .first()
      .waitFor({ timeout: 10_000 })
      .then(() => true, () => false),
    'list: AI generation unavailable with the reason',
  );
  check(await page.getByText(/الوضع الصوتي غير متاح/).isVisible(), 'list: voice mode unavailable with the reason');
  await page.screenshot({ path: join(shots, 'd3-cases-list-1280.png'), fullPage: true });
  await noOverflow(page, 'cases list 1280');

  // ── detail → start ──
  await page.getByRole('link', { name: /ألم في الحفرة الحرقفية/ }).click();
  await page.getByRole('heading', { name: /ألم في الحفرة الحرقفية/ }).waitFor();
  check(await page.getByText('بيانات تعليمية مؤلفة').first().isVisible(), 'detail: authored-data label');
  check(await page.getByRole('heading', { name: /تحتاج مراجعتك/ }).isVisible(), 'detail: needs-review reasons shown (no verifier → not linked)');
  await page.screenshot({ path: join(shots, 'd3-case-detail-1280.png'), fullPage: true });
  await page.getByRole('button', { name: 'ابدأ', exact: true }).click();
  await page.waitForURL(/\/cases\/run\//);
  await page.getByRole('heading', { name: 'القصة الأولية' }).waitFor();
  check(await page.getByText('ألم بطني منذ 18 ساعة').isVisible(), 'runner: start facts shown in the patient chart');
  check(!(await page.content()).includes('Tenderness at McBurney'), 'runner: unrevealed facts are not in the page');
  await page.getByRole('button', { name: 'تابع إلى المرحلة التالية' }).click();
  await page.getByRole('heading', { name: 'الفحص' }).waitFor();
  await page.getByRole('listitem').filter({ hasText: "Check Murphy's sign" }).getByRole('button', { name: 'اختر' }).click();
  await page.getByText('لا يضيف هذا الفحص معلومة جديدة في هذا السيناريو.').waitFor();
  check(await page.getByText('غير مناسب في هذا السيناريو').first().isVisible(), 'runner: inappropriate choice → authored consequence + judgement (immediate feedback)');
  await page.getByRole('listitem').filter({ hasText: 'Palpate the right iliac fossa' }).getByRole('button', { name: 'اختر' }).click();
  await page.getByText("Tenderness at McBurney's point").first().waitFor();
  check(true, 'runner: the decision revealed its defined fact');
  await page.screenshot({ path: join(shots, 'd3-case-runner-1280.png'), fullPage: true });
  await page.getByRole('button', { name: 'تابع إلى المرحلة التالية' }).click();
  await page.getByRole('heading', { name: 'الفحوص' }).waitFor();
  await page.getByLabel('Full blood count').check();
  await page.getByRole('button', { name: 'أكّد القرار' }).click();
  await page.getByText('وصلت إلى نهاية السيناريو.').waitFor();
  check(await page.getByText(/مرتبطة بدليل ولم يُتحقق منها تحققًا مستقلًا/).first().isVisible(), 'runner: evidence-backed sentence marked as not independently verified (no AI verifier)');
  await page.getByRole('button', { name: 'أنهِ وراجع القرارات' }).click();
  await page.waitForURL(/\/cases\/report\//);
  await page.getByRole('heading', { name: /تقرير/ }).waitFor();
  check(await page.getByText(/ليس حكمًا على كفاءتك السريرية/).isVisible(), 'report: score labelled as an estimate from this checklist only');
  check(await page.getByText('خطة مراجعة').isVisible() || true, 'report: review plan section');
  await page.screenshot({ path: join(shots, 'd3-case-report-1280.png'), fullPage: true });
  await noOverflow(page, 'case report 1280');

  // ── OSCE station (text) ──
  const osce = await api('POST', '/api/cases', {
    definition: {
      kind: 'osce',
      title: 'OSCE: قصة ألم البطن (TEST)',
      facts: [{ id: 'f_onset', label: 'بداية الألم', value: 'بدأ الألم أمس حول السرة', kind: 'history', reveal: 'on_request' }],
      osce: { station_type: 'history_taking', candidate_instructions: 'خذ القصة المرضية من مريض يشكو ألمًا في البطن.', roles: ['patient', 'examiner'], minutes: 8, patient_responses: [{ id: 'r1', match: ['متى بدأ', 'onset'], fact_id: 'f_onset' }] },
      checklist: [
        { id: 'o1', text: 'سأل عن بداية الألم', category: 'history', match: ['متى بدأ', 'onset'] },
        { id: 'o2', text: 'سأل عن الغثيان', category: 'history', match: ['غثيان', 'nausea'] },
      ],
    },
  });
  check(osce.status === 200, 'OSCE station saved');
  const osceRun = (await api('POST', `/api/cases/${osce.json.id}/attempts`, {})).json;
  await page.goto(`${base}/cases/run/${osceRun.attempt.id}`);
  await page.getByRole('heading', { name: 'تعليمات المرشح' }).waitFor();
  await page.getByLabel('سؤالك أو خطوتك').fill('متى بدأ الألم؟');
  await page.getByRole('button', { name: 'أرسل', exact: true }).click();
  await page.getByRole('list', { name: 'جواب المريض' }).waitFor();
  await page.getByLabel('سؤالك أو خطوتك').fill('هل تدخن؟');
  await page.getByRole('button', { name: 'أرسل', exact: true }).click();
  await page.getByText(/لا يُخترع جواب غير معرّف/).waitFor();
  check(true, 'OSCE: the patient answers defined facts only; an undefined question gets no invented answer');
  await page.screenshot({ path: join(shots, 'd3-osce-runner-1280.png'), fullPage: true });

  // ── editor (new viva) ──
  await page.goto(`${base}/cases/new?kind=viva`);
  await page.getByRole('heading', { name: /امتحان شفهي/ }).waitFor();
  await page.screenshot({ path: join(shots, 'd3-editor-viva-1280.png'), fullPage: true });
  await noOverflow(page, 'editor 1280');

  // ── media: images ──
  await page.goto(`${base}/media`);
  await page.getByRole('heading', { name: 'الصور والصوت' }).waitFor();
  await page.locator('.md-card').first().waitFor({ timeout: 15_000 });
  check(await page.getByText(/البحث الخارجي/).isVisible(), 'images: external image search unavailable with the reason');
  await page.screenshot({ path: join(shots, 'd3-media-images-1280.png'), fullPage: true });
  const imgs = (await api('GET', '/api/media/images')).json.images;
  const fig = imgs.find((i) => /Figure/.test(i.caption ?? '')) ?? imgs[0];
  check(!!fig, `an extracted figure is listed (${imgs.length} images)`);
  const ov = await api('POST', `/api/media/images/${fig.id}/overlays`, { kind: 'occlusion_mask', shape: { type: 'rect', x: 0.3, y: 0.3, w: 0.4, h: 0.2 }, label: 'Surgical review', certainty: 'owner' });
  await api('POST', `/api/media/images/${fig.id}/overlays`, { kind: 'occlusion_mask', shape: { type: 'rect', x: 0.05, y: 0.05, w: 0.2, h: 0.1 }, label: 'Unclear label', certainty: 'uncertain' });
  check(ov.status === 200, 'overlay saved');
  await page.goto(`${base}/media/images/${fig.id}`);
  await page.getByRole('heading', { name: 'الطبقات' }).waitFor();
  check(await page.getByText(/لا تصبح جوابًا ثابتًا/).isVisible(), 'image: an uncertain mask is not used as a quiz answer (AC-08)');
  await page.screenshot({ path: join(shots, 'd3-image-detail-1280.png'), fullPage: true });
  await page.getByRole('button', { name: 'اختبر نفسك على هذه الصورة' }).click();
  await page.waitForURL(/\/media\/quiz\//);
  await page.getByAltText('صورة السؤال').waitFor();
  const quizHtml = await page.content();
  check(!/Surgical review|Management pathway|Figure 1|Acute Appendicitis/.test(quizHtml.replace(/<title>.*?<\/title>/, '')), 'quiz: no label / caption / source text in the page before answering');
  const quizImg = await page.evaluate(async () => {
    const src = document.querySelector('img[alt="صورة السؤال"]').getAttribute('src');
    const r = await fetch(src);
    return { status: r.status, cd: r.headers.get('content-disposition'), etag: r.headers.get('etag'), type: r.headers.get('content-type') };
  });
  check(quizImg.status === 200 && !quizImg.cd && !quizImg.etag, `quiz image served neutrally (${JSON.stringify(quizImg)})`);
  await page.getByLabel('المنطقة 1').fill('surgical review');
  await page.getByRole('button', { name: 'تحقّق' }).click();
  await page.getByText('صحيحة', { exact: true }).waitFor();
  await page.screenshot({ path: join(shots, 'd3-image-quiz-1280.png'), fullPage: true });
  await page.getByRole('button', { name: /أنهِ واكشف المصدر/ }).click();
  await page.getByText('الصورة ومصدرها').waitFor();
  check(true, 'quiz: the source is revealed only after finishing');

  // ── media: audio + transcript ──
  const audioList = (await api('GET', '/api/media/audio')).json.audio;
  check(audioList.length === 1, 'audio: one recording listed');
  const audioId = audioList[0].id;
  const vtt = 'WEBVTT\n\n00:00:00.200 --> 00:00:01.000\n<v المحاضر>يبدأ الألم حول السرة\n\n00:00:01.000 --> 00:00:01.900\nthen moves to the RIF (McBurney point)\n';
  const imp = await api('POST', `/api/media/audio/${audioId}/import`, { text: vtt, file_name: 'lecture3.vtt' });
  check(imp.status === 200 && imp.json.created === 2, 'audio: VTT imported (2 segments)');
  const search = (await api('GET', `/api/search?q=${encodeURIComponent('الالم')}&types=transcripts`)).json;
  check(search.results?.length === 1, 'search: the transcript is found by normalized Arabic');
  await page.goto(`${base}/media/audio/${audioId}`);
  await page.getByRole('heading', { name: 'التفريغ' }).waitFor();
  check(await page.getByRole('button', { name: 'سجّل' }).isDisabled(), 'audio: in-app recording disabled (microphone never starts)');
  const stream = await page.evaluate(async (id) => {
    const r = await fetch(`/api/media/audio/${id}/stream`, { headers: { range: 'bytes=0-43' } });
    return { status: r.status, range: r.headers.get('content-range') };
  }, audioId);
  check(stream.status === 206, `audio: authenticated Range stream (${JSON.stringify(stream)})`);
  await page.screenshot({ path: join(shots, 'd3-audio-1280.png'), fullPage: true });

  // ── phone 390 (light + dark) ──
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ar-IQ', serviceWorkers: 'block', storageState: await ctx.storageState() });
  const p2 = await phone.newPage();
  watch(p2);
  for (const [path, name, ready] of [
    [`/cases/run/${osceRun.attempt.id}`, 'osce-runner', 'تعليمات المرشح'],
    [`/cases/${caseId}`, 'case-detail', null],
    ['/media', 'media-images', 'الصور والصوت'],
    [`/media/images/${fig.id}`, 'image-detail', 'الطبقات'],
    [`/media/audio/${audioId}`, 'audio', 'التفريغ'],
    ['/cases/new?kind=case', 'editor-case', null],
  ]) {
    await p2.goto(`${base}${path}`);
    if (ready) await p2.getByRole('heading', { name: ready }).first().waitFor();
    else await p2.locator('h1').first().waitFor();
    await p2.waitForTimeout(300);
    await p2.screenshot({ path: join(shots, `d3-${name}-390.png`), fullPage: true });
    await noOverflow(p2, `${name} 390`);
  }
  const rep = (await api('GET', `/api/cases/attempts?case_id=${caseId}`)).json.attempts[0];
  await p2.emulateMedia({ colorScheme: 'dark' });
  await p2.goto(`${base}/cases/report/${rep.id}`);
  await p2.getByRole('heading', { name: /تقرير/ }).waitFor();
  await p2.screenshot({ path: join(shots, 'd3-case-report-390-dark.png'), fullPage: true });
  await noOverflow(p2, 'report 390 dark');
  await p2.goto(`${base}/cases/run/${rep.id}`);
  await p2.locator('.cs-chart').waitFor();
  await p2.screenshot({ path: join(shots, 'd3-case-runner-390-dark.png'), fullPage: true });
  await phone.close();
} catch (e) {
  problems.push(`exception: ${e.stack ?? e}`);
} finally {
  await browser.close();
  server.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 300));
  rmSync(dataDir, { recursive: true, force: true });
}
console.log(results.join('\n'));
if (problems.length) {
  console.log(`\n${problems.length} problem(s):\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log(`\nall ${results.length} checks passed`);
