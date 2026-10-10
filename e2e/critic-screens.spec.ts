// Screen sweep (acceptance critic, §22, §23, §55, §58): every top-level screen of the app, on the real server, at
// the project's viewport (phone 390 px / desktop 1280 px), in light AND dark colour scheme. For each screen:
//   * baseline health (`expectHealthyScreen`: <html lang="ar" dir="rtl">, no error state, no sideways scroll),
//   * no control without an accessible name, no <img> without alt, exactly one level-1 heading,
//   * no honesty red flags in the visible text (fake accuracy %, «AI Verified», «100%», raw `undefined`/`NaN`),
//   * a contrast probe (text colour vs the first opaque background behind it) — reported, and asserted for
//     ratios under 3:1 (clearly unreadable),
//   * a full-page screenshot per scheme in e2e/.artifacts/critic/<project>/ (git-ignored) for a human look.
// The real data comes from the Golden Set fixtures (TEST FIXTURE documents, never shown as medical content).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import type { CardCreateResponse, ExamCreateResponse, PageRegionsResponse, QuestionListResponse, SourcePagesResponse } from '@medlevo/shared';
import { E2E_ARTIFACTS_DIR, expect, expectHealthyScreen, setupOwner, test } from './support';

interface Probe {
  unnamed: string[];
  imgNoAlt: string[];
  h1: number;
  redFlags: string[];
  lowContrast: Array<{ text: string; ratio: number; fg: string; bg: string; size: number }>;
  smallTargets: string[];
  overflowers: string[];
}

/** Runs in the page: structural a11y probes + contrast + red-flag text. */
async function probe(page: Page): Promise<Probe> {
  return page.evaluate(() => {
    const visible = (el: Element) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const cs = getComputedStyle(el as HTMLElement);
      return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
    };
    const desc = (el: Element) => {
      const h = el as HTMLElement;
      const cls = typeof h.className === 'string' ? h.className.split(/\s+/).filter(Boolean).slice(0, 2).join('.') : '';
      return `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}${h.getAttribute('aria-label') ? `[aria-label=${h.getAttribute('aria-label')}]` : ''} «${(h.textContent ?? '').trim().slice(0, 40)}»`;
    };
    const nameOf = (el: Element): string => {
      const h = el as HTMLElement;
      const aria = h.getAttribute('aria-label');
      if (aria && aria.trim()) return aria.trim();
      const lb = h.getAttribute('aria-labelledby');
      if (lb) {
        const t = lb.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ').trim();
        if (t) return t;
      }
      if (h instanceof HTMLInputElement || h instanceof HTMLSelectElement || h instanceof HTMLTextAreaElement) {
        if (h.id) {
          const l = document.querySelector(`label[for="${CSS.escape(h.id)}"]`);
          if (l?.textContent?.trim()) return l.textContent.trim();
        }
        const wrap = h.closest('label');
        if (wrap?.textContent?.trim()) return wrap.textContent.trim();
        if (h instanceof HTMLInputElement && (h.type === 'submit' || h.type === 'button') && h.value) return h.value;
        if (h.getAttribute('title')) return h.getAttribute('title')!;
        return '';
      }
      const txt = (h.innerText ?? h.textContent ?? '').trim();
      if (txt) return txt;
      const img = h.querySelector('img[alt]');
      if (img && img.getAttribute('alt')!.trim()) return img.getAttribute('alt')!.trim();
      if (h.getAttribute('title')) return h.getAttribute('title')!;
      return '';
    };

    const hiddenForAt = (el: Element) => !!el.closest('[aria-hidden="true"], .ml-visually-hidden, [inert]');
    const controls = Array.from(
      document.querySelectorAll('button, a[href], [role="button"], [role="tab"], [role="menuitem"], [role="switch"], [role="checkbox"], input:not([type="hidden"]), select, textarea'),
    ).filter(visible);
    const unnamed = controls.filter((el) => !hiddenForAt(el) && !nameOf(el)).map(desc);
    const imgNoAlt = Array.from(document.querySelectorAll('img')).filter((i) => visible(i) && !i.hasAttribute('alt')).map(desc);
    const h1 = Array.from(document.querySelectorAll('h1')).filter(visible).length;

    const text = document.body.innerText;
    const redFlags: string[] = [];
    const patterns: Array<[RegExp, string]> = [
      [/AI\s*Verified|موثّق بالذكاء|تحقق منه الذكاء/i, 'AI verified badge'],
      [/(دقة|صحة|صحيح|موثوق|accura|correct|verified)[^\n]{0,24}(100\s*[%٪]|٪\s*100)|(100\s*[%٪]|٪\s*100)[^\n]{0,24}(دقة|صحة|صحيح|موثوق|accura|correct|verified)/i, '100% claim'],
      [/دقة\s*\d+|accuracy\s*\d+/i, 'accuracy number'],
      [/\bundefined\b|\bNaN\b|\[object Object\]|\bnull\b/, 'raw value'],
      [/lorem ipsum|TODO|FIXME|placeholder/i, 'placeholder text'],
    ];
    for (const [re, label] of patterns) {
      const m = text.match(re);
      if (m) {
        const i = m.index ?? 0;
        redFlags.push(`${label}: «${text.slice(Math.max(0, i - 40), i + 40).replace(/\s+/g, ' ')}»`);
      }
    }

    // contrast: element with own text node vs first opaque background up the tree
    const parse = (c: string) => {
      const m = c.match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const p = m[1]!.split(/[ ,/]+/).filter(Boolean).map(Number);
      return { r: p[0]!, g: p[1]!, b: p[2]!, a: p.length > 3 ? p[3]! : 1 };
    };
    const lum = (c: { r: number; g: number; b: number }) => {
      const f = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
    };
    const bgOf = (el: Element | null): { r: number; g: number; b: number } | null => {
      let cur: Element | null = el;
      while (cur) {
        const cs = getComputedStyle(cur);
        if (cs.backgroundImage && cs.backgroundImage !== 'none' && !cs.backgroundImage.includes('gradient')) return null; // image: unknown
        const c = parse(cs.backgroundColor);
        if (c && c.a > 0.9) return c;
        cur = cur.parentElement;
      }
      return { r: 255, g: 255, b: 255 };
    };
    const lowContrast: Probe['lowContrast'] = [];
    const seen = new Set<string>();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const n = walker.currentNode as Text;
      const t = (n.textContent ?? '').trim();
      if (t.length < 2) continue;
      const el = n.parentElement;
      if (!el || !visible(el) || el.closest('[aria-hidden="true"], .ml-visually-hidden, canvas, svg, .wk-textlayer, .textLayer')) continue;
      const cs = getComputedStyle(el);
      if (cs.color === 'transparent') continue;
      const fg = parse(cs.color);
      const bg = bgOf(el);
      if (!fg || !bg) continue;
      // blend translucent text over its background
      const mix = { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a) };
      const l1 = lum(mix);
      const l2 = lum(bg);
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      const size = parseFloat(cs.fontSize);
      const large = size >= 24 || (size >= 18.6 && Number(cs.fontWeight) >= 700);
      const need = large ? 3 : 4.5;
      if (el.closest('button:disabled, [aria-disabled="true"], input:disabled')) continue; // disabled controls are exempt (WCAG 1.4.3)
      if (ratio < need) {
        const key = `${t.slice(0, 30)}|${ratio.toFixed(2)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        lowContrast.push({ text: t.slice(0, 50), ratio: Math.round(ratio * 100) / 100, fg: cs.color, bg: `rgb(${bg.r},${bg.g},${bg.b})`, size });
      }
    }

    const coarse = matchMedia('(pointer: coarse)').matches;
    const smallTargets = coarse
      ? controls
          .filter((el) => {
            if (el.closest('p, li > span, .ml-prose')) return false; // inline links inside running text are exempt (WCAG 2.5.5 inline)
            const r = el.getBoundingClientRect();
            return r.width < 43.5 || r.height < 43.5;
          })
          .map((el) => {
            const r = el.getBoundingClientRect();
            return `${desc(el)} ${Math.round(r.width)}×${Math.round(r.height)}`;
          })
      : [];

    const vw = document.documentElement.clientWidth;
    const overflowers = Array.from(document.querySelectorAll('body *'))
      .filter((el) => {
        if (!visible(el)) return false;
        const r = el.getBoundingClientRect();
        return r.right > vw + 1 || r.left < -1;
      })
      .filter((el) => {
        // skip descendants of a horizontally scrollable / clipping ancestor
        let p = el.parentElement;
        while (p && p !== document.body) {
          const cs = getComputedStyle(p);
          if (/(auto|scroll|hidden|clip)/.test(cs.overflowX)) return false;
          p = p.parentElement;
        }
        return true;
      })
      .slice(0, 8)
      .map(desc);

    return { unnamed, imgNoAlt, h1, redFlags, lowContrast: lowContrast.slice(0, 12), smallTargets: smallTargets.slice(0, 15), overflowers };
  });
}

/**
 * Phone only (coarse pointer): the controls the critic round fixed must keep a 44px touch target (ARCHITECTURE §4):
 * segmented options (the small variant was 30px), the switch (31px look, 45px transparent ring), the brand link and
 * the save-status button in the top bar. Scrolls each switch into view, so run it after the screenshots.
 */
async function touchProbe(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const bad: string[] = [];
    const shown = (el: Element) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    };
    for (const el of Array.from(document.querySelectorAll('.ml-segmented__option, a.ml-brand, button.ml-save-status')).filter(shown)) {
      const h = el.getBoundingClientRect().height;
      if (h < 43.5) bad.push(`${el.className} «${(el.textContent ?? '').trim().slice(0, 20)}» ${Math.round(h)}px tall`);
    }
    for (const sw of Array.from(document.querySelectorAll<HTMLElement>('.ml-switch')).filter(shown)) {
      // instant: the app scrolls smoothly, and a rect read mid-animation would sit under the bottom tab bar
      sw.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      const r = sw.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      for (const y of [r.top - 6, r.bottom + 6]) {
        const hit = document.elementFromPoint(cx, y);
        if (hit && hit.closest('.ml-topbar, .ml-tabbar, .ml-toasts')) continue; // covered by fixed chrome, not the ring's fault
        if (!hit || !hit.closest('.ml-switch')) bad.push(`switch «${sw.getAttribute('aria-labelledby') ?? ''}» has no touch ring at ${Math.round(y - r.top)}px`);
      }
    }
    return bad;
  });
}

async function settle(page: Page) {
  await page.waitForLoadState('networkidle', { timeout: 6_000 }).catch(() => undefined);
  await expect(page.locator('.ml-spinner:visible, .ml-skeleton:visible').first()).toHaveCount(0, { timeout: 12_000 }).catch(() => undefined);
  await page.waitForTimeout(350);
}

test('screen sweep: every top-level screen, light and dark', async ({ page, api }, testInfo) => {
  test.setTimeout(900_000);
  const project = testInfo.project.name;
  const outDir = join(E2E_ARTIFACTS_DIR, 'critic', project);
  mkdirSync(outDir, { recursive: true });

  await setupOwner(page);
  const { notebook, course } = await api.createNotebookAndCourse();
  const lecture = await api.uploadFixture(course.id, 'lecture_appendicitis.pdf', { sourceType: 'lecture', onDuplicate: 'create' });
  const qs = await api.uploadFixture(course.id, 'questions_surgery_course1.pdf', { sourceType: 'question_source', onDuplicate: 'create' });
  await api.waitForProcessing(lecture.version_id);
  await api.waitForProcessing(qs.version_id, { questions: true });

  // a card from a real region, a practice attempt and an exam attempt
  const { pages } = await api.get<SourcePagesResponse>(`/api/sources/${lecture.source_id}/versions/${lecture.version_id}/pages`);
  const { regions } = await api.get<PageRegionsResponse>(`/api/sources/pages/${pages[0]!.id}/regions`);
  const region = regions.find((r) => (r.kind === 'paragraph' || r.kind === 'text_block') && (r.text ?? '').length > 40)!;
  const card = await api.post<CardCreateResponse>('/api/learning/cards/from-selection', {
    source_id: lecture.source_id,
    version_id: lecture.version_id,
    quote: region.text,
    region_id: region.id,
    kind: 'basic',
    front: 'Critic sweep — what does this passage say?',
  });
  const list = await api.get<QuestionListResponse>(`/api/questions?source_id=${qs.source_id}&limit=50`);
  const qid = list.items[0]!.id;
  const exam = await api.post<ExamCreateResponse>('/api/exams', { title: '', mode: 'exam', count: 3, source_ids: [qs.source_id] });

  const screens: Array<[string, string]> = [
    ['home', '/'],
    ['library', '/library'],
    ['library-notebook', `/library/${notebook.id}`],
    ['library-course', `/library/${course.id}`],
    ['upload', `/upload?node=${course.id}`],
    ['source', `/sources/${lecture.source_id}`],
    ['study', `/study/${lecture.source_id}`],
    ['search', '/search?q=McBurney'],
    ['questions', '/questions'],
    ['questions-add', '/questions/add'],
    ['questions-review-queue', '/questions/review'],
    ['question-detail', `/questions/${qid}`],
    ['question-review', `/questions/${qid}/review`],
    ['exams', '/exams'],
    ['exams-new', '/exams/new'],
    ['exams-generate', '/exams/generate'],
    ['exam-runner', `/exams/${exam.session.attempt.id}`],
    ['practice', '/practice'],
    ['review', '/review'],
    ['review-session', '/review/session'],
    ['review-cards', '/review/cards'],
    ['review-card-edit', `/review/cards/${card.cards[0]!.id}`],
    ['review-cards-new', '/review/cards/new'],
    ['review-revision', '/review/revision'],
    ['review-dna', '/review/dna'],
    ['review-profile', '/review/profile'],
    ['weakness', '/weakness'],
    ['planner', '/planner'],
    ['planner-new', '/planner/new'],
    ['cases', '/cases'],
    ['cases-new', '/cases/new'],
    ['media', '/media'],
    ['terms', '/terms'],
    ['explanation-rules', '/explanation-rules'],
    ['settings', '/settings'],
    ['offline', '/offline'],
    ['control', '/control'],
    ['control-review', '/control/review'],
    ['control-alerts', '/control/alerts'],
    ['control-sync', '/control/sync'],
    ['control-processing', '/control/processing'],
    ['control-sources', '/control/sources'],
    ['control-intelligence', '/control/intelligence'],
    ['control-storage', '/control/storage'],
    ['control-capabilities', '/control/capabilities'],
    ['control-history', '/control/history'],
    ['not-found', '/no-such-screen'],
  ];

  const report: Record<string, { light: Probe; dark: Probe }> = {};
  for (const [name, path] of screens) {
    await test.step(`${name} (${path})`, async () => {
      await page.emulateMedia({ colorScheme: 'light' });
      await page.goto(path);
      await settle(page);
      await expectHealthyScreen(page, name).catch((e: Error) => expect.soft(e.message, `${name}: healthy screen`).toBe(''));
      const light = await probe(page);
      await page.screenshot({ path: join(outDir, `${name}-light.png`), fullPage: true });
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.waitForTimeout(250);
      const dark = await probe(page);
      await page.screenshot({ path: join(outDir, `${name}-dark.png`), fullPage: true });
      report[name] = { light, dark };
      expect.soft(light.unnamed, `${name}: controls without an accessible name`).toEqual([]);
      expect.soft(light.imgNoAlt, `${name}: <img> without alt`).toEqual([]);
      expect.soft(light.redFlags, `${name}: honesty red flags in visible text`).toEqual([]);
      expect.soft(light.h1, `${name}: exactly one visible <h1>`).toBe(1);
      for (const [scheme, p] of [['light', light], ['dark', dark]] as const) {
        expect.soft(p.lowContrast.filter((c) => c.ratio < 3), `${name} (${scheme}): text under 3:1 contrast`).toEqual([]);
      }
      if (project === 'phone') expect.soft(await touchProbe(page), `${name}: 44px touch targets on the phone`).toEqual([]);
    });
  }
  writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2));
});

test('screen sweep: public screens (signed out), light and dark', async ({ browser, baseURL }, testInfo) => {
  const outDir = join(E2E_ARTIFACTS_DIR, 'critic', testInfo.project.name);
  mkdirSync(outDir, { recursive: true });
  const ctx = await browser.newContext({ baseURL, locale: 'ar-IQ', viewport: testInfo.project.use.viewport ?? undefined, isMobile: testInfo.project.use.isMobile, hasTouch: testInfo.project.use.hasTouch });
  const page = await ctx.newPage();
  const report: Record<string, { light: Probe; dark: Probe }> = {};
  for (const [name, path] of [
    ['login', '/login'],
    ['recover', '/recover'],
  ] as const) {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(path);
    await settle(page);
    await expectHealthyScreen(page, name);
    const light = await probe(page);
    await page.screenshot({ path: join(outDir, `${name}-light.png`), fullPage: true });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForTimeout(250);
    const dark = await probe(page);
    await page.screenshot({ path: join(outDir, `${name}-dark.png`), fullPage: true });
    report[name] = { light, dark };
    expect.soft(light.unnamed, `${name}: controls without an accessible name`).toEqual([]);
    expect.soft(light.h1, `${name}: exactly one visible <h1>`).toBe(1);
    for (const [scheme, p] of [['light', light], ['dark', dark]] as const) {
      expect.soft(p.lowContrast.filter((c) => c.ratio < 3), `${name} (${scheme}): text under 3:1 contrast`).toEqual([]);
    }
  }
  writeFileSync(join(outDir, 'report-public.json'), JSON.stringify(report, null, 2));
  await ctx.close();
});
