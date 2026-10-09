// Visual check of the web core with a MOCKED /api (page.route). Test tooling only — the mock data
// below never ships in the app. Usage:
//   npm run build -w @medlevo/web && npx vite preview --port 4173 (in apps/web)
//   node apps/web/scripts/visual-check.mjs [baseUrl]
// Screenshots → apps/web/test-screenshots/<name>-<viewport>-<scheme>.png
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'test-screenshots');
const base = process.argv[2] ?? 'http://127.0.0.1:4173';
const fallback = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const executablePath = process.env.CHROMIUM_PATH ?? (existsSync(fallback) ? fallback : undefined);

const FEATURE_KEYS = [
  'library', 'upload', 'processing.pdf', 'processing.docx', 'processing.pptx', 'processing.images', 'processing.zip',
  'processing.legacy_office', 'processing.ocr', 'processing.vision', 'workspace.reader', 'workspace.ink',
  'workspace.handwriting_recognition', 'workspace.audio', 'search.keyword', 'search.semantic', 'evidence.citations',
  'ai.explain', 'ai.chat', 'ai.study_book', 'ai.summaries', 'ai.figure_explain', 'ai.generate_questions', 'ai.grade_written',
  'ai.cases', 'external.evidence', 'external.images', 'questions.vault', 'questions.extraction', 'questions.matching', 'exams',
  'flashcards', 'weakness', 'planner', 'exam_dna', 'sync', 'offline', 'backup', 'export.markdown', 'export.anki_tsv',
  'export.pdf', 'export.docx',
];

const DEFAULT_SETTINGS = {
  timezone: 'Asia/Baghdad', ui_language: 'ar', theme: 'system', paper_texture: true, reduce_motion: 'system', text_scale: 1,
  explanation_level: 'medium', dialect: 'fusha_simple', custom_instruction: '', answer_style: 'detailed', socratic_default: false,
  check_question_density: 'low', margin_density: 'normal', default_scope_mode: 'lecture_only',
  source_priority: { lecture_explanation: ['lecture'], source_question_practice: ['question_source'], clinical_expansion: ['course_reference'] },
  practice_hints: 'progressive', anti_shortcut_mode: false, daily_new_cards: 20, desired_retention: 0.9, self_level: '',
  rail_width: 380, rail_open: true, page_layout: 'continuous', page_flip_animation: false,
};

function mockApi(state) {
  const now = Date.now();
  const session = (id, label, current, ago) => ({
    id, device_label: label, device_id: null, user_agent: null, ip: '127.0.0.1',
    created_at: now - 9 * 86400_000, last_seen_at: now - ago, expires_at: now + 20 * 86400_000, current,
  });
  return async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const method = req.method();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/auth/status') {
      return json({
        setup_required: state.mode === 'setup',
        authenticated: state.mode === 'authed',
        owner: state.mode === 'authed' ? { username: 'owner' } : null,
        session: state.mode === 'authed' ? session('S1', 'Chrome على Mac', true, 0) : null,
        remaining_recovery_codes: state.mode === 'authed' ? 10 : undefined,
        password_min_length: 12,
      });
    }
    if (path === '/api/auth/setup' && method === 'POST') {
      state.mode = 'authed';
      return json({
        ok: true,
        recovery_codes: ['7KQ2-9MFD-XW4P', 'H3TN-6RVA-2CZL', 'Q8JB-4YEK-M7SD', 'P2WX-5HNG-9TQF', 'C6LM-3DZR-8KVA', 'N4FT-7QPB-2XEJ', 'V9AS-1KWM-6HDR', 'E5ZC-8LTN-3PGY', 'R7HD-2JXQ-5MWB', 'B3YK-9FVE-4NCT'],
        session: session('S1', 'Chrome على Mac', true, 0),
        notice_ar: 'احفظ رموز الاسترداد الآن في مكان آمن خارج هذا الجهاز. لن تظهر مرة أخرى، وكل رمز يُستخدم مرة واحدة فقط.',
      });
    }
    if (path === '/api/auth/sessions') return json({ sessions: [session('S1', 'Chrome على Mac', true, 0), session('S2', 'Safari على iPad', false, 3 * 3600_000)] });
    if (path === '/api/settings' && method === 'GET') return json({ settings: { ...DEFAULT_SETTINGS, ...state.settings } });
    if (path === '/api/settings' && method === 'PATCH') {
      state.settings = { ...state.settings, ...JSON.parse(req.postData() ?? '{}') };
      return json({ settings: { ...DEFAULT_SETTINGS, ...state.settings } });
    }
    if (path === '/api/capabilities') {
      const features = Object.fromEntries(
        FEATURE_KEYS.map((k) => [
          k,
          k.startsWith('ai.')
            ? { key: k, state: 'requires_configuration', reason_ar: 'لم يُضبط مزوّد AI على الخادم (ANTHROPIC_API_KEY).' }
            : k === 'sync'
              ? { key: k, state: 'available' }
              : { key: k, state: 'not_implemented', reason_ar: 'هذه الميزة لم تُبنَ بعد.' },
        ]),
      );
      return json({ features, ai: { configured: false }, server_time: now, app_version: '0.1.0' });
    }
    if (path === '/api/sync/push') return json({ results: [], server_seq: 0 });
    if (path === '/api/sync/pull') return json({ changes: [], next_since: 0, has_more: false });
    return json({ error: { code: 'NOT_FOUND', message: 'غير موجود (mock)' } }, 404);
  };
}

const viewports = [
  { name: 'phone', width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  { name: 'desktop', width: 1280, height: 800, isMobile: false, hasTouch: false, deviceScaleFactor: 1 },
];
const schemes = ['light', 'dark'];
const only = process.env.ONLY ? process.env.ONLY.split(',') : null;

await mkdir(outDir, { recursive: true });
const browser = await chromium.launch(executablePath ? { executablePath } : {});
const problems = [];
try {
  for (const vp of viewports) {
    for (const scheme of schemes) {
      const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: vp.deviceScaleFactor,
        isMobile: vp.isMobile,
        hasTouch: vp.hasTouch,
        colorScheme: scheme,
        locale: 'ar-IQ',
        timezoneId: 'Asia/Baghdad',
        serviceWorkers: 'block',
      });
      const page = await ctx.newPage();
      page.on('pageerror', (e) => problems.push(`[${vp.name}/${scheme}] pageerror: ${e.message}`));
      page.on('console', (m) => {
        if (m.type() === 'error') problems.push(`[${vp.name}/${scheme}] console: ${m.text()}`);
      });
      const state = { mode: 'setup', settings: {} };
      await page.route('**/api/**', mockApi(state));
      const shot = async (name) => {
        if (only && !only.includes(name)) return;
        await page.waitForTimeout(350);
        const file = join(outDir, `${name}-${vp.name}-${scheme}.png`);
        await page.screenshot({ path: file, fullPage: true });
        // horizontal overflow check (RTL layouts often overflow to the left)
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        if (overflow > 1) problems.push(`[${vp.name}/${scheme}] ${name}: horizontal overflow ${overflow}px`);
        console.log('shot', file);
      };

      // 1. setup form
      await page.goto(`${base}/`);
      await page.waitForURL('**/setup');
      await page.getByRole('heading', { name: 'إنشاء حساب المالك' }).waitFor();
      await shot('setup');
      await page.locator('input[name="username"]').fill('owner');
      await page.locator('input[name="new-password"]').fill('correct horse battery');
      await page.locator('input[name="confirm-password"]').fill('correct horse battery');
      await shot('setup-filled');
      await page.getByRole('button', { name: 'إنشاء الحساب' }).click();
      await page.getByRole('heading', { name: 'احفظ رموز الاسترداد' }).waitFor();
      await shot('setup-codes');
      await page.getByRole('checkbox', { name: 'حفظت رموز الاسترداد في مكان آمن خارج هذا الجهاز' }).check();
      await page.getByRole('button', { name: 'متابعة إلى MedLevo' }).click();

      // 2. shell + home placeholder
      await page.getByRole('heading', { name: 'الرئيسية', level: 1 }).waitFor();
      await shot('home');
      // sync details popover
      await page.getByRole('button', { name: /حالة الحفظ/ }).click();
      await page.getByRole('dialog', { name: 'حالة الحفظ والمزامنة' }).waitFor();
      await shot('sync-popover');
      await page.keyboard.press('Escape');
      // offline: indicator appears, nothing else breaks
      await ctx.setOffline(true);
      await page.getByText('دون اتصال').first().waitFor();
      await shot('home-offline');
      await ctx.setOffline(false);

      // 3. settings
      await page.goto(`${base}/settings`);
      await page.getByRole('heading', { name: 'الإعدادات', level: 1 }).waitFor();
      await page.getByText('Safari على iPad').waitFor();
      await shot('settings');
      // destructive confirmation shows its impact
      await page.getByRole('button', { name: 'إنهاء الجلسة' }).click();
      await page.getByRole('alertdialog').waitFor();
      await shot('settings-confirm');
      await page.keyboard.press('Escape');

      // 4. login (signed out)
      state.mode = 'login';
      await page.evaluate(() => localStorage.removeItem('medlevo.lastAuth.v1'));
      await page.goto(`${base}/login?expired=1`);
      await page.getByRole('heading', { name: 'تسجيل الدخول' }).waitFor();
      await shot('login');

      await ctx.close();
    }
  }
} finally {
  await browser.close();
}
if (problems.length) {
  console.log('\nPROBLEMS:\n' + problems.join('\n'));
  process.exitCode = 1;
} else {
  console.log('\nno console errors, no horizontal overflow');
}
