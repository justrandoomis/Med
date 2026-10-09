// Workspace visual + behaviour check with a MOCKED /api (page.route) and the REAL Golden Set PDF
// (fixtures/golden/lecture_appendicitis.pdf). Test tooling only — nothing here ships in the app.
// Usage (dev server on a free port, from the repo root):
//   (cd apps/web && npx vite --port 5299 --strictPort) &
//   node apps/web/src/features/workspace/visual-check.mjs http://127.0.0.1:5299
// Screenshots → apps/web/test-screenshots/workspace-<name>-<viewport>-<scheme>.png
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..', '..', '..');
const outDir = join(here, '..', '..', '..', 'test-screenshots');
const base = process.argv[2] ?? 'http://127.0.0.1:5299';
const executablePath = '/opt/pw-browsers/chromium';
const pdfBytes = await readFile(join(root, 'fixtures', 'golden', 'lecture_appendicitis.pdf'));
const pngBytes = await readFile(join(root, 'fixtures', 'golden', 'scanned_page.png'));

const FEATURE_KEYS = [
  'library', 'upload', 'processing.pdf', 'processing.docx', 'processing.pptx', 'processing.images', 'processing.zip',
  'processing.legacy_office', 'processing.ocr', 'processing.vision', 'workspace.reader', 'workspace.ink',
  'workspace.handwriting_recognition', 'workspace.audio', 'search.keyword', 'search.semantic', 'evidence.citations',
  'ai.explain', 'ai.chat', 'ai.study_book', 'ai.summaries', 'ai.figure_explain', 'ai.generate_questions', 'ai.grade_written',
  'ai.cases', 'external.evidence', 'external.images', 'questions.vault', 'questions.extraction', 'questions.matching', 'exams',
  'flashcards', 'weakness', 'planner', 'exam_dna', 'sync', 'offline', 'backup', 'export.markdown', 'export.anki_tsv',
  'export.pdf', 'export.docx',
];
const AVAILABLE = new Set(['library', 'upload', 'processing.pdf', 'workspace.reader', 'workspace.ink', 'sync']);
const DEFAULT_SETTINGS = {
  timezone: 'Asia/Baghdad', ui_language: 'ar', theme: 'system', paper_texture: true, reduce_motion: 'system', text_scale: 1,
  explanation_level: 'medium', dialect: 'fusha_simple', custom_instruction: '', answer_style: 'detailed', socratic_default: false,
  check_question_density: 'low', margin_density: 'normal', default_scope_mode: 'lecture_only',
  source_priority: { lecture_explanation: ['lecture'], source_question_practice: ['question_source'], clinical_expansion: ['course_reference'] },
  practice_hints: 'progressive', anti_shortcut_mode: false, daily_new_cards: 20, desired_retention: 0.9, self_level: '',
  rail_width: 380, rail_open: true, page_layout: 'continuous', page_flip_animation: false,
};

const now = Date.now();
const version = {
  id: 'V1', source_id: 'S1', version_no: 1, kind: 'original', format: 'pdf', pagination: 'pages', mime: 'application/pdf',
  file_name: 'lecture_appendicitis.pdf', file_id: 'F1', original_file_id: 'F1', display_file_id: 'F1', content_hash: 'h',
  page_count: 4, processing_status: 'ready', processing_summary: null, is_frozen: false, created_at: now, note: null,
};
const detail = {
  id: 'S1', title: 'Acute appendicitis — المحاضرة 3', source_type: 'lecture', node_id: 'N1', subject_node_id: null, course_node_id: null,
  lecture_kind: 'theoretical', lecture_kind_origin: 'owner', processing_status: 'ready', current_version_id: 'V1', frozen_version_id: null,
  active_version_id: 'V1', format: 'pdf', page_count: 4, is_favorite: false, last_opened_at: null, archived_at: null, deleted_at: null,
  created_at: now, updated_at: now, tags: [], language: 'mixed', edition: null, authors: null, publication_date: null, original_url: null,
  metadata_status: 'unknown', priority: 0, selection_reason: null, versions: [version],
  links: [{ id: 'L1', from_source_id: 'S1', to_source_id: 'S2', relation: 'reference_for', other_title: 'Surgery reference — chapter 12', other_type: 'course_reference' }],
  path: [{ id: 'N1', title: 'الجراحة', kind: 'subject' }],
};
const pages = [0, 1, 2, 3].map((i) => ({
  id: `P${i + 1}`, version_id: 'V1', page_index: i, printed_label: String(11 + i), printed_label_origin: 'pdf_page_labels', kind: 'page',
  width: 595.304, height: 841.89, unit: 'pt', rotation: 0, text_status: i === 3 ? 'mixed' : 'digital', ocr_confidence: i === 3 ? 0.87 : null,
  has_images: i === 3, processing_status: 'ready', error_code: null, error_detail_ar: null, thumbnail_file_id: null, render_file_id: null, section_key: null,
}));
const region = (id, pageId, kind, bbox, text, order, status = 'checks_passed') => ({
  id, version_id: 'V1', page_id: pageId, parent_region_id: null, kind, reading_order: order, bbox, locator: null, text,
  text_origin: 'digital', lang: /[؀-ۿ]/.test(text) ? 'ar' : 'en', confidence: null, structure: null, status,
});
const regionsByPage = {
  P1: [
    region('R1', 'P1', 'heading', { x: 0.1, y: 0.08, w: 0.8, h: 0.05 }, 'Acute appendicitis', 0),
    region('R2', 'P1', 'paragraph', { x: 0.1, y: 0.16, w: 0.8, h: 0.12 }, 'Pain typically starts periumbilical then migrates to McBurney point.', 1),
    region('R3', 'P1', 'paragraph', { x: 0.1, y: 0.32, w: 0.8, h: 0.1 }, 'يبدأ الألم عادةً حول السرة ثم ينتقل إلى الحفرة الحرقفية اليمنى.', 2, 'needs_review'),
  ],
};

// a reference (same fixture file) for Split Study, and a DOCX lecture (paragraph locators, no fixed pages)
const detail2 = { ...detail, id: 'S2', title: 'Surgery reference — chapter 12', source_type: 'course_reference', links: [], current_version_id: 'V2', active_version_id: 'V2', versions: [{ ...version, id: 'V2', source_id: 'S2' }] };
const pages2 = pages.map((p) => ({ ...p, id: `Q${p.page_index + 1}`, version_id: 'V2' }));
const version3 = { ...version, id: 'V3', source_id: 'S3', format: 'docx', pagination: 'paragraphs', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', file_name: 'lecture_notes_shock.docx', file_id: 'F3', display_file_id: null, page_count: 2 };
const detail3 = { ...detail, id: 'S3', title: 'الصدمة — ملاحظات المحاضرة', language: 'ar', format: 'docx', links: [], current_version_id: 'V3', active_version_id: 'V3', versions: [version3] };
const pages3 = [0, 1].map((i) => ({ ...pages[0], id: `D${i + 1}`, version_id: 'V3', page_index: i, printed_label: null, printed_label_origin: null, kind: 'docx_section', width: null, height: null, unit: null, text_status: 'digital' }));
regionsByPage.D1 = [
  { ...region('DR1', 'D1', 'heading', null, 'تعريف الصدمة (Shock)', 0), version_id: 'V3', locator: { paragraph_index: 0, heading_path: ['تعريف الصدمة'] } },
  { ...region('DR2', 'D1', 'paragraph', null, 'الصدمة حالة يقل فيها تروية الأنسجة (tissue perfusion) عن حاجتها، ويُقاس ضغط الدم المتوسط MAP بوحدة mmHg.', 1), version_id: 'V3', locator: { paragraph_index: 1, heading_path: ['تعريف الصدمة'] } },
];
regionsByPage.D2 = [
  { ...region('DR3', 'D2', 'heading', null, 'أنواع الصدمة', 0), version_id: 'V3', locator: { paragraph_index: 2, heading_path: ['أنواع الصدمة'] } },
  { ...region('DR4', 'D2', 'list_item', null, 'Hypovolemic shock — نقص الحجم', 1), version_id: 'V3', locator: { paragraph_index: 3, heading_path: ['أنواع الصدمة'] } },
  { ...region('DR5', 'D2', 'list_item', null, 'Septic shock — الإنتان', 2), version_id: 'V3', locator: { paragraph_index: 4, heading_path: ['أنواع الصدمة'] } },
];

// a page-image source (scanned page) with OCR regions → image + selectable OCR text layer
const version4 = { ...version, id: 'V4', source_id: 'S4', format: 'image', pagination: 'images', mime: 'image/png', file_name: 'scanned_page.png', file_id: 'F4', display_file_id: null, page_count: 1 };
const detail4 = { ...detail, id: 'S4', title: 'Scanned page — H. pylori', language: 'en', format: 'image', links: [], current_version_id: 'V4', active_version_id: 'V4', versions: [version4] };
const pages4 = [{ ...pages[0], id: 'I1', version_id: 'V4', printed_label: null, printed_label_origin: null, kind: 'image', width: 1240, height: 1754, unit: 'px', text_status: 'ocr', ocr_confidence: 0.81, render_file_id: 'F4' }];
regionsByPage.I1 = [{ ...region('IR1', 'I1', 'paragraph', { x: 0.1, y: 0.1, w: 0.8, h: 0.05 }, 'Helicobacter pylori is diagnosed with the urea breath test.', 0, 'needs_review'), version_id: 'V4', text_origin: 'ocr', confidence: 0.81 }];

function mockApi(state) {
  return async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const method = req.method();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/auth/status') {
      return json({
        setup_required: false, authenticated: true, owner: { username: 'owner' },
        session: { id: 'SESS', device_label: 'Chrome', device_id: null, user_agent: null, ip: null, created_at: now, last_seen_at: now, expires_at: now + 1e9, current: true },
        remaining_recovery_codes: 10, password_min_length: 12,
      });
    }
    if (path === '/api/settings' && method === 'GET') return json({ settings: { ...DEFAULT_SETTINGS, ...state.settings } });
    if (path === '/api/settings' && method === 'PATCH') {
      state.settings = { ...state.settings, ...JSON.parse(req.postData() ?? '{}') };
      return json({ settings: { ...DEFAULT_SETTINGS, ...state.settings } });
    }
    if (path === '/api/capabilities') {
      const features = Object.fromEntries(
        FEATURE_KEYS.map((k) => [
          k,
          AVAILABLE.has(k)
            ? { key: k, state: 'available' }
            : k.startsWith('ai.')
              ? { key: k, state: 'requires_configuration', reason_ar: 'تتطلب ضبط مزود ذكاء اصطناعي على الخادم (ANTHROPIC_API_KEY).' }
              : { key: k, state: 'not_implemented', reason_ar: 'لم تُبنَ هذه الميزة بعد في هذا الإصدار.' },
        ]),
      );
      return json({ features, ai: { configured: false }, server_time: now, app_version: '0.1.0' });
    }
    if (path === '/api/sync/push') {
      const ops = JSON.parse(req.postData() ?? '{}').ops ?? [];
      state.pushed.push(...ops);
      return json({ results: ops.map((o) => ({ op_id: o.op_id, result: 'applied', entity: o.entity_type === 'study_session' ? { ...o.payload, id: o.entity_id, rev: (o.base_rev ?? 0) + 1, device_id: o.device_id, updated_at: Date.now(), created_at: Date.now() } : undefined })), server_seq: 1 });
    }
    if (path === '/api/sync/pull') return json({ changes: [], next_since: 0, has_more: false });
    if (path === '/api/sources/S1') return json(detail);
    if (path === '/api/sources/S2') return json(detail2);
    if (path === '/api/sources/S2/versions/V2/pages') return json({ version: detail2.versions[0], pages: pages2 });
    if (path === '/api/sources/S4') return json(detail4);
    if (path === '/api/sources/S4/versions/V4/pages') return json({ version: version4, pages: pages4 });
    if (path === '/api/files/F4') return route.fulfill({ status: 200, contentType: 'image/png', body: pngBytes });
    if (path === '/api/sources/S3') return json(detail3);
    if (path === '/api/sources/S3/versions/V3/pages') return json({ version: version3, pages: pages3 });
    if (path === '/api/sources/S1/versions/V1/pages') return json({ version, pages });
    if (path === '/api/sources/S1/open') return json({ source: detail });
    const rm = /^\/api\/sources\/pages\/([^/]+)\/regions$/.exec(path);
    if (rm) return json({ page: pages.find((p) => p.id === rm[1]) ?? pages[0], regions: regionsByPage[rm[1]] ?? [] });
    if (path === '/api/files/F1') return route.fulfill({ status: 200, contentType: 'application/pdf', body: pdfBytes });
    if (path === '/api/annotations/sessions/latest') return json({ session: state.latest ?? null });
    if (path === '/api/annotations/sessions/recent') return json({ items: [{ session: { id: 'X', source_id: 'S2', version_id: 'V2', mode: 'learn', view: 'original', location: { page_index: 0 }, scope: null, device_id: 'IPAD', rev: 1, created_at: now, updated_at: now }, source: { id: 'S2', title: detail2.title, source_type: 'course_reference', archived: false }, version: { id: 'V2', version_no: 1, is_active: true }, page: null, reading: null }] });
    if (/^\/api\/annotations\/source\/S[234]$/.test(path)) return json({ source_id: path.slice(-2), version_ids: [], annotations: [], notes: [], note_pages: [] });
    if (path === '/api/annotations/source/S1') return json({ source_id: 'S1', version_ids: ['V1'], annotations: [], notes: [], note_pages: [] });
    if (path === '/api/annotations/notes') return json({ notes: [] });
    if (path === '/api/annotations/needs-reanchor') return json({ items: [] });
    if (path === '/api/annotations/progress' && method === 'POST') {
      const b = JSON.parse(req.postData() ?? '{}');
      state.viewed = [...new Set([...(state.viewed ?? []), ...(b.page_indexes ?? [])])].sort();
      return json({ source_id: 'S1', version_id: 'V1', pages_viewed: state.viewed, pages_total: 4, reading_progress: state.viewed.length / 4, updated_at: Date.now() });
    }
    if (/^\/api\/sources\/S[234]\/open$/.test(path)) return json({});
    if (/^\/api\/annotations\/progress\/S[234]$/.test(path)) return json({ source_id: path.slice(-2), version_id: null, pages_viewed: [], pages_total: null, reading_progress: 0, updated_at: null });
    if (path === '/api/annotations/progress/S1') return json({ source_id: 'S1', version_id: null, pages_viewed: [], pages_total: null, reading_progress: 0, updated_at: null });
    return json({ error: { code: 'NOT_FOUND', message: 'غير موجود (mock)' } }, 404);
  };
}

const viewports = [
  { name: 'phone', width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  { name: 'desktop', width: 1280, height: 800, isMobile: false, hasTouch: false, deviceScaleFactor: 1 },
];
const schemes = (process.env.SCHEMES ?? 'light,dark').split(',');
const onlyVp = process.env.VIEWPORTS ? process.env.VIEWPORTS.split(',') : null;

await mkdir(outDir, { recursive: true });
const browser = await chromium.launch({ executablePath });
const problems = [];
const results = [];
const shot = (page, name, vp, scheme) => page.screenshot({ path: join(outDir, `workspace-${name}-${vp.name}-${scheme}.png`) });
const check = (ok, what) => {
  results.push(`${ok ? 'PASS' : 'FAIL'} ${what}`);
  if (!ok) problems.push(`FAIL ${what}`);
};

try {
  for (const vp of viewports) {
    if (onlyVp && !onlyVp.includes(vp.name)) continue;
    for (const scheme of schemes) {
      const tag = `${vp.name}/${scheme}`;
      const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.deviceScaleFactor, isMobile: vp.isMobile, hasTouch: vp.hasTouch,
        colorScheme: scheme, locale: 'ar-IQ', timezoneId: 'Asia/Baghdad', serviceWorkers: 'block',
      });
      const state = { settings: {}, pushed: [] };
      await ctx.route('**/api/**', mockApi(state));
      const page = await ctx.newPage();
      page.on('pageerror', (e) => problems.push(`[${tag}] pageerror: ${e.message}`));
      page.on('console', (m) => {
        if (m.type() === 'error' && !/favicon/.test(m.text())) problems.push(`[${tag}] console: ${m.text()}`);
      });
      await page.goto(`${base}/study/S1`);
      await page.waitForSelector('.wk-canvas-slot canvas', { timeout: 20000 });
      await page.waitForSelector('.wk-textlayer span', { timeout: 20000 });
      await page.waitForTimeout(400);
      await shot(page, 'open', vp, scheme);

      // no horizontal page overflow
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check(overflow <= 1, `[${tag}] no horizontal overflow (${overflow}px)`);

      // folio shows printed label + file position (AC-04)
      const folio = await page.locator('.wk-page').first().locator('.wk-folio').innerText();
      check(/ص 11/.test(folio) && /الصفحة 1 في الملف/.test(folio), `[${tag}] folio shows printed label and file position: ${folio.replace(/\s+/g, ' ')}`);

      // the text layer is selectable: select a word range and read it back
      const selected = await page.evaluate(() => {
        const span = [...document.querySelectorAll('.wk-textlayer span')].find((s) => /periumbilical/.test(s.textContent ?? ''));
        if (!span) return null;
        const r = document.createRange();
        r.selectNodeContents(span);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
        return sel.toString();
      });
      check(!!selected && /periumbilical/.test(selected), `[${tag}] text layer selectable (“${(selected ?? '').slice(0, 40)}”)`);
      await page.dispatchEvent('body', 'pointerup');
      await page.waitForSelector('.wk-seltoolbar:not(.wk-seltoolbar--measuring)', { timeout: 3000 }).catch(() => undefined);
      check((await page.locator('.wk-seltoolbar').count()) === 1, `[${tag}] selection toolbar appears`);
      await shot(page, 'selection', vp, scheme);
      // highlight it (local-first: IndexedDB + outbox → push)
      await page.locator('.wk-seltoolbar button', { hasText: 'تظليل' }).click();
      await page.waitForSelector('.wk-mark--highlight', { timeout: 3000 }).catch(() => undefined);
      check((await page.locator('.wk-mark--highlight').count()) > 0, `[${tag}] text highlight drawn on the page`);
      await page.waitForTimeout(800);
      check(state.pushed.some((o) => o.entity_type === 'annotation' && o.payload?.kind === 'text_highlight' && o.payload?.data?.quote?.exact?.includes('periumbilical')), `[${tag}] highlight pushed with its text quote`);

      // go to page 13 by printed label, then zoom + rotate keep the place
      await page.locator('.wk-pageind').first().click();
      await page.locator('.wk-goto input').fill('13');
      await page.locator('.wk-goto button[type="submit"]').click();
      await page.waitForTimeout(600);
      const ind1 = await page.locator('.wk-pageind').first().innerText();
      check(/ص 13/.test(ind1), `[${tag}] go to printed page 13 → indicator «${ind1.replace(/\s+/g, ' ')}»`);
      await shot(page, 'page13', vp, scheme);
      if (vp.name === 'desktop') {
        await page.getByRole('button', { name: 'تكبير', exact: true }).click();
        await page.getByRole('button', { name: 'تكبير', exact: true }).click();
      } else {
        await page.keyboard.press('+');
        await page.keyboard.press('+');
      }
      await page.waitForTimeout(700);
      const ind2 = await page.locator('.wk-pageind').first().innerText();
      check(/ص 13/.test(ind2), `[${tag}] zoom keeps the page (${ind2.replace(/\s+/g, ' ')})`);
      await shot(page, 'zoomed', vp, scheme);
      await page.evaluate(() => document.querySelector('.wk-canvas')?.focus());
      if (vp.name === 'desktop') {
        await page.getByRole('button', { name: 'خيارات العرض' }).click();
        await page.getByRole('menuitem', { name: /تدوير مع عقارب الساعة/ }).click();
      } else {
        await page.getByRole('button', { name: 'خيارات القراءة' }).click();
        await page.getByRole('menuitem', { name: /تدوير مع عقارب الساعة/ }).click();
      }
      await page.waitForTimeout(800);
      const ind3 = await page.locator('.wk-pageind').first().innerText();
      check(/ص 13/.test(ind3), `[${tag}] rotation keeps the page (${ind3.replace(/\s+/g, ' ')})`);
      await shot(page, 'rotated', vp, scheme);
      // re-open: the session restores page, zoom and rotation from IndexedDB
      await page.waitForTimeout(1600);
      await page.reload();
      await page.waitForSelector('.wk-canvas-slot canvas', { timeout: 20000 });
      await page.waitForTimeout(800);
      const ind4 = await page.locator('.wk-pageind').first().innerText();
      check(/ص 13/.test(ind4), `[${tag}] re-open restores the page (${ind4.replace(/\s+/g, ' ')})`);
      const rot = await page.locator('.wk-sheet').first().getAttribute('data-rot');
      check(rot === '90', `[${tag}] re-open restores the rotation (data-rot=${rot})`);
      await shot(page, 'reopened', vp, scheme);

      // rail: sources tab and a region jump with back
      if (vp.name === 'desktop') {
        await page.getByRole('tab', { name: 'المصادر' }).click();
      } else {
        await page.getByRole('button', { name: 'لوحة الدراسة' }).click();
        await page.getByRole('tab', { name: 'المصادر' }).click();
      }
      await page.waitForTimeout(300);
      await shot(page, 'rail-sources', vp, scheme);
      if (vp.name === 'desktop') {
        await page.getByRole('button', { name: 'خيارات العرض' }).click();
        await page.getByRole('menuitem', { name: /تدوير عكس عقارب الساعة/ }).click();
        await page.waitForTimeout(300);
        await page.locator('.wk-pageind').first().click();
        await page.locator('.wk-goto input').fill('#1');
        await page.locator('.wk-goto button[type="submit"]').click();
        await page.waitForTimeout(500);
        await page.getByRole('button', { name: 'إظهار في الصفحة' }).nth(1).click();
        await page.waitForTimeout(500);
        check((await page.locator('.wk-region-hl').count()) === 1, `[${tag}] region highlighted after «إظهار في الصفحة»`);
        await shot(page, 'region', vp, scheme);
        await page.getByRole('tab', { name: 'ملاحظاتي' }).click();
        await page.waitForTimeout(300);
        await shot(page, 'rail-mine', vp, scheme);
        await page.getByRole('tab', { name: 'الشرح والسؤال' }).click();
        await page.waitForTimeout(200);
        await shot(page, 'rail-explain', vp, scheme);
        // search
        await page.keyboard.press('Control+f');
        await page.locator('.wk-search__input').fill('appendicitis');
        await page.waitForSelector('.wk-search__hit', { timeout: 8000 }).catch(() => undefined);
        await page.waitForTimeout(500);
        check((await page.locator('.wk-search__hit').count()) > 0, `[${tag}] search finds results`);
        await shot(page, 'search', vp, scheme);
        await page.keyboard.press('Escape');
        // left panel
        await page.keyboard.press('[');
        await page.waitForTimeout(600);
        await shot(page, 'left-panel', vp, scheme);
      }
      const overflow2 = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check(overflow2 <= 1, `[${tag}] no horizontal overflow at the end (${overflow2}px)`);
      await ctx.close();
    }
  }

  // ── extra scenarios (desktop light + phone light) ──
  if (!onlyVp || onlyVp.includes('desktop')) {
    const vp = viewports[1];
    const tag = 'desktop/extra';
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'light', locale: 'ar-IQ', timezoneId: 'Asia/Baghdad', serviceWorkers: 'block' });
    const state = { settings: {}, pushed: [] };
    await ctx.route('**/api/**', mockApi(state));
    const page = await ctx.newPage();
    page.on('pageerror', (e) => problems.push(`[${tag}] pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error' && !/favicon/.test(m.text())) problems.push(`[${tag}] console: ${m.text()}`);
    });
    await page.goto(`${base}/study/S1`);
    await page.waitForSelector('.wk-canvas-slot canvas', { timeout: 20000 });
    // two-page spread (close the rail so two pages fit)
    await page.keyboard.press(']');
    await page.getByRole('button', { name: 'خيارات العرض' }).click();
    await page.getByRole('menuitem', { name: /صفحتان متقابلتان/ }).click();
    await page.waitForTimeout(900);
    const sheets = await page.locator('.wk-page').count();
    check(sheets === 2, `[${tag}] two-page spread shows 2 pages (${sheets})`);
    await shot(page, 'spread', vp, 'light');
    await page.evaluate(() => document.body.focus());
    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(500);
    const ind = await page.locator('.wk-pageind').first().innerText();
    check(/ص 13/.test(ind), `[${tag}] ArrowLeft (RTL next) flips to the next spread (${ind.replace(/\s+/g, ' ')})`);
    await shot(page, 'spread-next', vp, 'light');
    await page.getByRole('button', { name: 'خيارات العرض' }).click();
    await page.getByRole('menuitem', { name: /تمرير متصل/ }).click();
    await page.keyboard.press(']');
    await page.waitForTimeout(500);
    // Ctrl + wheel zooms around the pointer and keeps the page
    const zoomBefore = await page.locator('.wk-zoom__value').innerText();
    const box = await page.locator('.wk-canvas').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -240);
    await page.keyboard.up('Control');
    await page.waitForTimeout(700);
    const zoomAfter = await page.locator('.wk-zoom__value').innerText();
    const indZ = await page.locator('.wk-pageind').first().innerText();
    check(zoomAfter !== zoomBefore && /ص 13/.test(indZ), `[${tag}] Ctrl+wheel zooms (${zoomBefore} → ${zoomAfter}) and keeps the page (${indZ.replace(/\s+/g, ' ')})`);
    // notes: select text → «ملاحظة» → write → saved locally and pushed
    await page.evaluate(() => {
      const box = document.querySelector('.wk-canvas').getBoundingClientRect();
      const span = [...document.querySelectorAll('.wk-textlayer span')].find((s) => {
        const r = s.getBoundingClientRect();
        return (s.textContent ?? '').trim().length > 10 && r.top > box.top + 40 && r.bottom < box.bottom - 40;
      });
      const r = document.createRange();
      r.selectNodeContents(span);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
    });
    await page.dispatchEvent('body', 'pointerup');
    await page.waitForSelector('.wk-seltoolbar:not(.wk-seltoolbar--measuring)', { timeout: 3000 });
    await page.locator('.wk-seltoolbar button', { hasText: 'ملاحظة' }).click();
    await page.waitForSelector('.wk-note-editor textarea', { timeout: 3000 });
    await page.locator('.wk-note-editor textarea').fill('أراجع هذا قبل الامتحان (McBurney point).');
    await page.waitForTimeout(900);
    await shot(page, 'note-editor', vp, 'light');
    await page.locator('.wk-note-editor button', { hasText: 'تم' }).click();
    await page.waitForTimeout(1200);
    check((await page.locator('.wk-note').count()) === 1, `[${tag}] the note is listed on this page`);
    check(state.pushed.some((o) => o.entity_type === 'note' && JSON.stringify(o.payload).includes('McBurney')), `[${tag}] note pushed through the outbox`);
    await shot(page, 'note-saved', vp, 'light');
    // split study with the linked reference
    await page.getByRole('button', { name: 'المحاضرة الأصلية' }).click();
    await page.getByRole('menuitem', { name: 'جنبًا إلى جنب' }).click();
    await page.getByRole('dialog').getByRole('button', { name: /Surgery reference/ }).click();
    await page.waitForSelector('.wk-split .wk-canvas-slot canvas', { timeout: 20000 });
    await page.waitForTimeout(500);
    check((await page.locator('.wk-split').count()) === 1, `[${tag}] split study shows a second source`);
    await shot(page, 'split', vp, 'light');
    await page.getByRole('button', { name: 'إغلاق المصدر الثاني' }).click();
    // focus mode (CSS fallback in headless)
    await page.keyboard.press('f');
    await page.waitForTimeout(400);
    check((await page.locator('.wk-focusbar').count()) === 1, `[${tag}] focus mode hides the chrome`);
    await shot(page, 'focus', vp, 'light');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    // a newer position from another device → asked, not applied
    await page.locator('.wk-pageind').first().click();
    await page.locator('.wk-goto input').fill('12');
    await page.locator('.wk-goto button[type="submit"]').click();
    await page.waitForTimeout(1800);
    state.latest = { id: 'OTHER_SESSION', source_id: 'S1', version_id: 'V1', mode: 'learn', view: 'original', location: { page_index: 3, page_offset: 0 }, scope: null, device_id: 'IPAD', rev: 4, created_at: now, updated_at: Date.now() + 60_000 };
    await page.reload();
    await page.waitForSelector('[role="dialog"]', { timeout: 15000 }).catch(() => undefined);
    const dlg = page.getByRole('dialog', { name: 'موضع أحدث من جهاز آخر' });
    check((await dlg.count()) === 1, `[${tag}] newer session from another device → the owner is asked`);
    const stillHere = await page.locator('.wk-pageind').first().innerText();
    check(/ص 12/.test(stillHere), `[${tag}] the local place is kept until the owner chooses (${stillHere.replace(/\s+/g, ' ')})`);
    await shot(page, 'session-conflict', vp, 'light');
    await dlg.getByRole('button', { name: /الانتقال إلى/ }).click();
    await page.waitForTimeout(800);
    const moved = await page.locator('.wk-pageind').first().innerText();
    check(/ص 14/.test(moved), `[${tag}] choosing the other device's place goes there (${moved.replace(/\s+/g, ' ')})`);
    // DOCX: structured paragraphs, no ink, no fake page numbers
    state.latest = null;
    await page.goto(`${base}/study/S3`);
    await page.waitForSelector('.wk-textsheet__block', { timeout: 15000 });
    await page.waitForTimeout(500);
    const folioDocx = await page.locator('.wk-folio').first().innerText();
    check(/قسم 1/.test(folioDocx), `[${tag}] DOCX sections are named «قسم n», not pages (${folioDocx})`);
    check((await page.locator('bdi[dir="ltr"]').filter({ hasText: 'tissue perfusion' }).count()) >= 1, `[${tag}] English terms inside Arabic paragraphs are isolated (bdi dir=ltr)`);
    await shot(page, 'docx', vp, 'light');
    // page images: the image plus a selectable OCR text layer
    await page.goto(`${base}/study/S4`);
    await page.waitForSelector('.wk-page-image', { timeout: 15000 });
    await page.waitForSelector('.wk-ocrlayer__run', { timeout: 15000 });
    await page.waitForTimeout(600);
    const ocrText = await page.locator('.wk-ocrlayer__run').first().innerText();
    check(/urea breath test/.test(ocrText), `[${tag}] OCR text layer over the page image is present (${ocrText.slice(0, 30)}…)`);
    const folioImg = await page.locator('.wk-folio').first().innerText();
    check(/صورة 1/.test(folioImg), `[${tag}] image pages are named «صورة n» (${folioImg})`);
    await shot(page, 'image', vp, 'light');
    await ctx.close();
  }

  // ── touch: swipe turns the page in a paged layout; a finger STROKE never does (§24, review of B1) ──
  if (!onlyVp || onlyVp.includes('phone')) {
    const tag = 'phone/touch';
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'light', locale: 'ar-IQ', timezoneId: 'Asia/Baghdad', serviceWorkers: 'block' });
    const state = { settings: { page_layout: 'single', rail_open: false }, pushed: [] };
    await ctx.route('**/api/**', mockApi(state));
    const page = await ctx.newPage();
    page.on('pageerror', (e) => problems.push(`[${tag}] pageerror: ${e.message}`));
    await page.goto(`${base}/study/S1`);
    await page.waitForSelector('.wk-canvas-slot canvas', { timeout: 20000 });
    await page.waitForTimeout(600);
    const cdp = await ctx.newCDPSession(page);
    const drag = async (x1, x2, y) => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x1, y, radiusX: 4, radiusY: 4 }] });
      for (let i = 1; i <= 8; i++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x1 + ((x2 - x1) * i) / 8, y, radiusX: 4, radiusY: 4 }] });
        await page.waitForTimeout(12);
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.waitForTimeout(700);
    };
    const ind = async () => (await page.locator('.wk-pageind').first().innerText()).replace(/\s+/g, ' ');
    const start = await ind();
    await drag(320, 80, 420); // hand tool: a quick horizontal swipe (LTR-language book: right→left = next)
    const swiped = await ind();
    check(start !== swiped, `[${tag}] a finger swipe turns the page in the single-page layout (${start} → ${swiped})`);
    await page.getByRole('button', { name: 'القلم' }).first().click(); // phones: fingers write by default
    await page.waitForTimeout(300);
    await drag(320, 80, 420); // the same gesture with the pen tool is a stroke, not a page turn
    const afterStroke = await ind();
    check(afterStroke === swiped, `[${tag}] a quick horizontal finger STROKE does not turn the page (${swiped} → ${afterStroke})`);
    await page.waitForTimeout(1200);
    check(state.pushed.some((o) => o.entity_type === 'annotation'), `[${tag}] the finger stroke was saved and pushed`);
    await ctx.close();
  }
} finally {
  await browser.close();
}
console.log(results.join('\n'));
if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n` + problems.join('\n'));
  process.exitCode = 1;
} else {
  console.log('\nOK: no console errors, all checks passed.');
}
