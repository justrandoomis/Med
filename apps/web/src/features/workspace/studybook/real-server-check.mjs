// Browser check of track C2 (explanations, Study Book, chat, terms, rules) against the REAL server code.
//  Phase A: the production entry (src/index.ts) WITHOUT an AI key → every AI feature says why it is unavailable,
//           deterministic screens (terms, rules) work.
//  Phase B: the same app with the TEST-ONLY grounded fake provider (apps/server/test/studybook/browser-server.ts —
//           it copies evidence sentences verbatim; no model, no medicine of its own) → generated content through the
//           real retrieval / validation / publishing pipeline: explain, selection → rail, Study Book generation,
//           Lecture Twin, split view, chat + save as note; phone width; light and dark.
// Test tooling only. Usage (repo root, after `npm run build -w @medlevo/web`):
//   node apps/web/src/features/workspace/studybook/real-server-check.mjs [outDir]
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..', '..', '..', '..');
const outDir = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'medlevo-c2-shots-'));
mkdirSync(outDir, { recursive: true });
const golden = (n) => readFileSync(join(root, 'fixtures', 'golden', n));
const results = [];
const problems = [];
const check = (ok, what) => {
  results.push(`${ok ? 'PASS' : 'FAIL'} ${what}`);
  if (!ok) problems.push(what);
};

let log = '';
function startServer(entry, port, dataDir) {
  const base = `http://127.0.0.1:${port}`;
  const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', join(root, entry)], {
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
      MEDLEVO_AI_MONTHLY_BUDGET_USD: '5',
      ANTHROPIC_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.on('data', (d) => (log += d));
  p.stderr.on('data', (d) => (log += d));
  return { p, base };
}

async function waitUp(url) {
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
const procs = [];
const dirs = [];

async function setup(base, page) {
  await page.goto(`${base}/login`);
  const api = (method, path, body) =>
    page.evaluate(
      async ({ method, path, body }) => {
        const r = await fetch(path, { method, headers: { 'content-type': 'application/json', 'x-medlevo-csrf': '1' }, body: body ? JSON.stringify(body) : undefined });
        return { status: r.status, json: await r.json().catch(() => null) };
      },
      { method, path, body },
    );
  check((await api('POST', '/api/auth/setup', { username: 'owner', password: 'correct horse battery staple' })).status === 200, `[${base}] owner set up`);
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
  let st = null;
  for (let i = 0; i < 180; i++) {
    st = (await api('GET', `/api/sources/${lecture.source_id}`)).json?.processing_status;
    if (['ready', 'partial', 'failed', 'needs_review'].includes(st)) break;
    await page.waitForTimeout(1000);
  }
  check(['ready', 'partial', 'needs_review'].includes(st), `[${base}] lecture processed by the real pipeline (${st})`);
  return { api, lecture, node };
}

function watch(p) {
  p.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  p.on('console', (m) => {
    if (m.type() === 'error' && !/favicon|401|409|Failed to load resource/.test(m.text())) problems.push(`console: ${m.text()}`);
  });
}

const overflowOf = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function selectText(page, re) {
  await page.waitForSelector('.wk-textlayer span', { timeout: 30000 });
  const ok = await page.evaluate((src) => {
    const re = new RegExp(src);
    const span = [...document.querySelectorAll('.wk-textlayer span')].find((s) => re.test(s.textContent ?? ''));
    if (!span) return false;
    span.scrollIntoView({ block: 'center' });
    const r = document.createRange();
    r.selectNodeContents(span);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
    return true;
  }, re.source);
  await page.dispatchEvent('body', 'pointerup');
  return ok;
}

try {
  // ───────────────────────── Phase A: no AI provider ─────────────────────────
  {
    const dataDir = mkdtempSync(join(tmpdir(), 'medlevo-c2-a-'));
    dirs.push(dataDir);
    const srv = startServer('apps/server/src/index.ts', 8791, dataDir);
    procs.push(srv.p);
    await waitUp(`${srv.base}/api/health`);
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'ar-IQ', serviceWorkers: 'block' });
    const page = await ctx.newPage();
    watch(page);
    const { api, lecture } = await setup(srv.base, page);
    const caps = (await api('GET', '/api/capabilities')).json;
    check(['ai.explain', 'ai.chat', 'ai.study_book', 'ai.summaries', 'ai.figure_explain'].every((k) => caps.features[k].state === 'requires_configuration' && /ANTHROPIC_API_KEY/.test(caps.features[k].reason_ar)), 'A: AI capabilities are requires_configuration with the key reason');

    await page.goto(`${srv.base}/study/${lecture.source_id}`);
    await page.waitForSelector('.wk-canvas-slot canvas', { timeout: 30000 });
    await page.getByRole('tab', { name: 'الشرح والسؤال' }).click();
    check(await page.getByText('الشرح غير متاح الآن').isVisible(), 'A: Explain tab says it is unavailable');
    check(await page.getByRole('button', { name: 'اشرح', exact: true }).isDisabled(), 'A: «اشرح» disabled');
    check(await page.locator('.wk-disabled-card').getByText(/ANTHROPIC_API_KEY/).isVisible(), 'A: the server reason is visible');
    // view switch: Study Book disabled with the server's reason (no book, cannot generate)
    await page.locator('.wk-viewswitch').click();
    const sbItem = page.getByRole('menuitem', { name: /كتاب الدراسة/ }).first();
    check((await sbItem.getAttribute('aria-disabled')) === 'true' && /ANTHROPIC_API_KEY|غير مفعّلة|الذكاء/.test(await sbItem.innerText()), `A: «كتاب الدراسة» disabled with reason (${(await sbItem.innerText()).replace(/\s+/g, ' ').slice(0, 120)})`);
    await page.keyboard.press('Escape');
    // selection → «اشرح» opens the rail tab with the selection (and the reason)
    await page.getByRole('tab', { name: 'المصادر' }).click();
    check(await selectText(page, /periumbilical|Ultrasound/), 'A: text selected on the page');
    await page.locator('.wk-seltoolbar button', { hasText: 'اشرح' }).click();
    await page.waitForSelector('.sb-context .sb-quote', { timeout: 10000 });
    check((await page.getByRole('tab', { name: 'الشرح والسؤال' }).getAttribute('aria-selected')) === 'true', 'A: selection «اشرح» opened the «الشرح والسؤال» tab');
    check(/periumbilical|Ultrasound/.test(await page.locator('.sb-context .sb-quote').innerText()), 'A: the rail shows the selected text');
    await page.screenshot({ path: join(outDir, 'a-workspace-not-configured-desktop.png') });

    // terms + rules work without AI
    for (const [w, h, tag] of [
      [1280, 800, 'desktop'],
      [390, 844, 'phone'],
    ]) {
      for (const theme of ['light', 'dark']) {
        await page.setViewportSize({ width: w, height: h });
        await page.emulateMedia({ colorScheme: theme });
        await page.goto(`${srv.base}/terms`);
        await page.waitForLoadState('networkidle');
        if (tag === 'desktop' && theme === 'light') {
          check(await page.getByText('القاموس فارغ').isVisible(), 'A: empty dictionary (nothing seeded)');
          await page.getByRole('button', { name: 'أضف مصطلحًا' }).click();
          const dlg = page.getByRole('dialog', { name: 'مصطلح جديد' });
          await dlg.getByLabel(/المصطلح بالإنجليزية/).fill("McBurney's point");
          await dlg.getByLabel(/الاختصار/).fill('');
          await dlg.getByLabel(/ترجمتك المفضلة/).fill('نقطة ماكبرني');
          await dlg.getByLabel(/المرادفات/).fill('McBurney point');
          await dlg.getByRole('button', { name: 'أضف إلى القاموس' }).click();
          await page.waitForSelector('.sbx-term');
          const server = (await api('GET', '/api/studybook/terms')).json.terms;
          check(server.length === 1 && server[0].owner_preferred_ar === 'نقطة ماكبرني' && server[0].synonyms[0] === 'McBurney point', 'A: term saved through /api/studybook/terms');
        }
        check((await overflowOf(page)) <= 1, `A: [${tag}/${theme}] /terms no horizontal overflow`);
        await page.screenshot({ path: join(outDir, `a-terms-${tag}-${theme}.png`), fullPage: true });
        await page.goto(`${srv.base}/explanation-rules`);
        await page.waitForSelector('.sbx-facts');
        check((await overflowOf(page)) <= 1, `A: [${tag}/${theme}] /explanation-rules no horizontal overflow`);
        await page.screenshot({ path: join(outDir, `a-rules-${tag}-${theme}.png`), fullPage: true });
      }
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.emulateMedia({ colorScheme: 'light' });
    const before = (await api('GET', '/api/studybook/rules')).json.rules.rules_version;
    await page.getByRole('switch', { name: /أمثلة تعليمية/ }).click();
    await page.getByRole('button', { name: 'احفظ القواعد' }).click();
    await page.waitForTimeout(800);
    const after = (await api('GET', '/api/studybook/rules')).json;
    check(after.rules.include.examples === false && after.rules.rules_version !== before, `A: owner rules saved; rules_version changed (${before} → ${after.rules.rules_version})`);
    await ctx.close();
    srv.p.kill('SIGTERM');
  }

  // ───────────────────────── Phase B: test-only grounded fake provider ─────────────────────────
  {
    const dataDir = mkdtempSync(join(tmpdir(), 'medlevo-c2-b-'));
    dirs.push(dataDir);
    const srv = startServer('apps/server/test/studybook/browser-server.ts', 8792, dataDir);
    procs.push(srv.p);
    await waitUp(`${srv.base}/api/health`);
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'ar-IQ', serviceWorkers: 'block' });
    const page = await ctx.newPage();
    watch(page);
    const { api, lecture } = await setup(srv.base, page);

    await page.goto(`${srv.base}/study/${lecture.source_id}`);
    await page.waitForSelector('.wk-canvas-slot canvas', { timeout: 30000 });
    await page.getByRole('tab', { name: 'الشرح والسؤال' }).click();
    await page.getByRole('button', { name: 'اشرح', exact: true }).click();
    await page.waitForSelector('.sb-result .ev-artifact', { timeout: 60000 });
    const chips = await page.locator('.sb-result .ml-source-chip').allInnerTexts();
    check(chips.length >= 1 && chips.every((c) => /^محاضرة ص1[1-4]$/.test(c.trim())), `B: page explanation rendered with real evidence chips (${chips.join('، ')})`);
    check(await page.locator('.sb-result').getByText('محتوى مولَّد من مصادرك').isVisible(), 'B: generated content is labelled');
    await page.locator('.wk-rail').screenshot({ path: join(outDir, 'b-rail-explain-desktop.png') });

    // selection → «المزيد» → «بسّط»
    await page.getByRole('tab', { name: 'المصادر' }).click();
    check(await selectText(page, /periumbilical|Ultrasound/), 'B: text selected');
    await page.locator('.wk-seltoolbar button', { hasText: 'المزيد' }).click();
    await page.getByRole('menuitem', { name: /بسّط/ }).click();
    await page.waitForSelector('.sb-result .ev-artifact__title', { timeout: 60000 });
    check(/تبسيط/.test(await page.locator('.sb-result .ev-artifact__title').innerText()), 'B: selection «بسّط» ran in the rail with the selection anchor');
    const mcq = page.locator('.wk-seltoolbar');
    check((await mcq.count()) === 0, 'B: the selection toolbar closed after handing over');

    // ask + save as note
    await page.getByRole('radio', { name: 'سؤال' }).click();
    await page.getByLabel('سؤالك عن هذا الموضع').fill('ما الفحص الأول عند الأطفال؟');
    await page.getByRole('button', { name: 'اسأل' }).click();
    await page.waitForSelector('.sb-msg--assistant .ev-artifact, .sb-msg--assistant .ev-abstain', { timeout: 60000 });
    const saveBtn = page.getByRole('button', { name: 'احفظ الإجابة كملاحظة' });
    if (await saveBtn.count()) {
      await saveBtn.first().click();
      await page.waitForTimeout(1500);
      const notes = (await api('GET', `/api/annotations/notes?source_id=${lecture.source_id}`)).json?.notes ?? [];
      check(notes.some((n) => n.origin === 'ai_answer'), `B: answer saved as an ai_answer note (${notes.map((n) => n.origin).join(',')})`);
    } else {
      check(false, 'B: chat answer was final (save as note offered)');
    }
    const railOverflow = await page.evaluate(() => {
      const els = [...document.querySelectorAll('.wk-rail .wk-rail-panel, .wk-rail .sb-chat, .wk-rail .sb-messages')];
      return Math.max(0, ...els.map((el) => el.scrollWidth - el.clientWidth));
    });
    check(railOverflow <= 1, `B: chat thread fits the rail (overflow ${railOverflow}px)`);
    await page.locator('.wk-rail').screenshot({ path: join(outDir, 'b-rail-chat-desktop.png') });

    // Study Book: generate from the view switch
    await page.locator('.wk-viewswitch').click();
    const item = page.getByRole('menuitem', { name: 'كتاب الدراسة', exact: true });
    check((await item.getAttribute('aria-disabled')) !== 'true', 'B: «كتاب الدراسة» enabled (can generate)');
    await item.click();
    await page.getByRole('button', { name: /أنشئ كتاب الدراسة/ }).click();
    await page.waitForSelector('.sb-book', { timeout: 30000 });
    let published = false;
    for (let i = 0; i < 90 && !published; i++) {
      const s = (await api('GET', `/api/studybook/books?source_id=${lecture.source_id}`)).json?.book?.artifact?.status;
      published = s === 'published' || s === 'partial';
      if (!published) await page.waitForTimeout(1000);
    }
    check(published, 'B: Study Book job finished (published/partial) through the real job queue');
    await page.waitForTimeout(3000); // the pane polls
    const sections = await page.locator('.sb-toc__item').count();
    const blocks = await page.locator('.sb-book__body [data-block]').count();
    check(sections >= 2 && blocks >= 2, `B: sections (${sections}) and blocks (${blocks}) rendered`);
    check(!/\d+\s?%/.test(await page.locator('.sb-pane').innerText()), 'B: no percentages in the Study Book');
    for (const theme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: theme });
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(outDir, `b-studybook-desktop-${theme}.png`) });
    }
    await page.emulateMedia({ colorScheme: 'light' });

    // a note on a Study Book paragraph (local-first → sync), then a regeneration keeps its semantic anchor (AC-22)
    await page.getByText('ملاحظاتي على هذا الكتاب', { exact: false }).first().click();
    await page.getByLabel('ملاحظة على هذه الفقرة').fill('ملاحظتي على هذه الفقرة');
    await page.getByRole('button', { name: 'احفظ الملاحظة' }).click();
    await page.waitForTimeout(3500); // outbox → /api/sync/push
    const bookNow = (await api('GET', `/api/studybook/books?source_id=${lecture.source_id}`)).json.book.artifact;
    const regen = (await api('POST', '/api/studybook/books', { source_id: lecture.source_id, scope: { mode: 'lecture_only', lecture_source_id: lecture.source_id }, regenerate: true })).json;
    check(regen?.book?.artifact?.version_no === bookNow.version_no + 1, `B: regeneration is a new version (v${regen?.book?.artifact?.version_no})`);
    let v2 = null;
    for (let i = 0; i < 90; i++) {
      v2 = (await api('GET', `/api/studybook/books/${regen.book.artifact.id}`)).json;
      if (['published', 'partial', 'failed'].includes(v2?.artifact?.status)) break;
      await page.waitForTimeout(1000);
    }
    check(v2?.reanchor?.some((r) => r.target_kind === 'note' && r.status === 'matched'), `B: the owner's block note synced and kept its anchor in the new version (${JSON.stringify(v2?.reanchor?.map((r) => r.status))})`);
    await page.reload();
    await page.waitForSelector('.sb-book__body [data-block]', { timeout: 30000 });

    // Lecture Twin: scroll the book to its last block, switch back → the lecture is at that block's page
    await page.evaluate(() => {
      const all = document.querySelectorAll('.sb-book__body [data-block]');
      all[all.length - 1]?.scrollIntoView({ block: 'start' });
    });
    await page.waitForTimeout(1200);
    await page.locator('.wk-viewswitch').click();
    await page.getByRole('menuitem', { name: 'المحاضرة الأصلية' }).click();
    await page.waitForSelector('.wk-canvas-slot canvas', { timeout: 30000 });
    await page.waitForTimeout(800);
    const folio = (await page.locator('.wk-pageind, .wk-folio').first().innerText()).replace(/\s+/g, ' ');
    check(!/ص 11\b/.test(folio.split('—')[0] ?? folio), `B: Lecture Twin — back in the original at the page of the last block read (${folio})`);

    // split: lecture | Study Book with sync
    await page.locator('.wk-viewswitch').click();
    await page.getByRole('menuitem', { name: /المحاضرة \+ كتاب الدراسة/ }).click();
    await page.waitForSelector('.wk-body--split .sb-pane', { timeout: 20000 });
    check((await page.locator('.wk-body--split .wk-canvas-slot canvas').count()) > 0, 'B: split shows the lecture and the Study Book');
    const syncBtn = page.getByRole('button', { name: /التمرير متزامن|التمرير مستقل/ });
    check((await syncBtn.getAttribute('aria-pressed')) === 'true', 'B: sync scrolling on by default (aria-pressed)');
    check((await overflowOf(page)) <= 1, 'B: split — no horizontal overflow');
    await page.screenshot({ path: join(outDir, 'b-split-desktop-light.png') });
    await page.locator('.wk-viewswitch').click();
    await page.getByRole('menuitem', { name: 'المحاضرة الأصلية' }).click();

    // phone: Study Book from the «more» menu
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.emulateMedia({ colorScheme: theme });
      await page.goto(`${srv.base}/study/${lecture.source_id}`);
      await page.waitForLoadState('networkidle');
      await page.getByRole('button', { name: 'خيارات القراءة' }).click();
      await page.getByRole('menuitem', { name: 'كتاب الدراسة', exact: true }).click();
      await page.waitForSelector('.sb-book__body [data-block]', { timeout: 30000 });
      check((await overflowOf(page)) <= 1, `B: [phone/${theme}] Study Book — no horizontal overflow`);
      const barTop = await page.locator('.wk-topbar').boundingBox();
      const docScroll = await page.evaluate(() => document.scrollingElement?.scrollTop ?? 0);
      check(!!barTop && barTop.y >= 0 && docScroll === 0, `B: [phone/${theme}] Lecture Twin scrolled the pane only — the reading bar stays on screen (doc scroll ${docScroll})`);
      await page.screenshot({ path: join(outDir, `b-studybook-phone-${theme}.png`) });
      await page.getByRole('button', { name: 'خيارات القراءة' }).click();
      await page.getByRole('menuitem', { name: 'المحاضرة الأصلية' }).click();
      await page.waitForSelector('.wk-canvas-slot canvas', { timeout: 30000 });
      await page.getByRole('button', { name: 'لوحة الدراسة' }).click();
      await page.getByRole('tab', { name: 'الشرح والسؤال' }).click();
      await page.waitForTimeout(500);
      check((await overflowOf(page)) <= 1, `B: [phone/${theme}] rail sheet — no horizontal overflow`);
      await page.screenshot({ path: join(outDir, `b-rail-phone-${theme}.png`) });
    }
    await ctx.close();
    srv.p.kill('SIGTERM');
  }
} catch (e) {
  problems.push(`exception: ${e?.stack ?? e}`);
} finally {
  await browser.close();
  for (const p of procs) p.kill('SIGTERM');
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}
console.log(results.join('\n'));
if (problems.length) {
  console.log('\nPROBLEMS:\n' + problems.join('\n'));
  console.log(log.slice(-2000));
  process.exit(1);
}
console.log(`\nall ${results.length} checks passed; screenshots in ${outDir}`);
