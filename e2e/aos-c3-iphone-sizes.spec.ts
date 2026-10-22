// Track C3 — AOS-20.5 «Phone and desktop interfaces»: the part that does NOT need a real iPhone. The screens C3 added
// or changed (sign-out with «امسح بيانات هذا الجهاز عند الخروج», «أجهزتي» with «هذا جهاز مشترك», «الخصوصية» with the
// device-data section, the AI allowance line, the «إدارة القنوات» dialogs, the subject and publication headings) at the
// three iPhone widths (SE 375 × 667, 15 393 × 852, 15 Pro Max 430 × 932) on a touch context, at 100 % and 150 % text:
//   * no sideways scroll;
//   * every button, switch, select, text box and checkbox row is ≥ 44 × 44 px (Apple HIG minimum);
//   * every text box is ≥ 16 px (iOS Safari zooms the page into a smaller field on focus and does not zoom back);
//   * the viewport lets the person zoom (no user-scalable=no / maximum-scale=1) and is viewport-fit=cover, and the
//     bottom tab bar keeps clear of the home indicator through the safe-area tokens.
// axe 0 serious / critical on each screen in light, dark and e-ink (iPhone SE width).
// What only a device shows — Safari's own toolbars, the real safe-area insets, the on-screen keyboard over a field,
// Apple Pencil — stays «Not run (no device)»: Chromium cannot stand in for it and it is not claimed here.
import type { Page } from '@playwright/test';
import { expect, screenshot, setupOwner, test } from './support';
import { buildAosWorld, fixturePages } from './support/aos-world';
import { axeInLooks } from './aos-p1-channels-helpers';

const SIZES = [
  { name: 'iPhone SE', width: 375, height: 667 },
  { name: 'iPhone 15', width: 393, height: 852 },
  { name: 'iPhone 15 Pro Max', width: 430, height: 932 },
];

interface Measure {
  overflow: number;
  small: string[];
  tinyText: string[];
}

/** what a person can touch inside the screen's main area, and the text boxes' font size */
async function measure(page: Page): Promise<Measure> {
  return page.evaluate(() => {
    const shown = (el: Element) => {
      const b = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return b.width > 0 && b.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
    };
    const name = (el: Element) => (el.getAttribute('aria-label') || (el as HTMLElement).innerText || el.getAttribute('name') || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 40);
    const root = document.querySelector('main') ?? document.body;
    const scopes = [root, ...Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]'))];
    const small: string[] = [];
    const tinyText: string[] = [];
    const seen = new Set<Element>();
    for (const scope of scopes) {
      for (const el of Array.from(scope.querySelectorAll('button, select, textarea, input, [role="switch"], [role="button"]'))) {
        if (seen.has(el) || !shown(el)) continue;
        seen.add(el);
        const input = el as HTMLInputElement;
        if (el.tagName === 'INPUT' && ['hidden', 'file'].includes(input.type)) continue;
        // a checkbox / radio is touched through its whole label row
        const target = el.tagName === 'INPUT' && ['checkbox', 'radio'].includes(input.type) ? (el.closest('label') ?? el) : el;
        const r = target.getBoundingClientRect();
        // a control may keep its look and widen its touch area with a transparent ::before ring (the 51 × 31 switch)
        const ring = getComputedStyle(target, '::before');
        const out = (v: string) => (ring.content !== 'none' && ring.position === 'absolute' && v.endsWith('px') ? Math.max(0, -parseFloat(v)) : 0);
        const b = { width: r.width + out(ring.left) + out(ring.right), height: r.height + out(ring.top) + out(ring.bottom) };
        if (b.height < 43.5 || b.width < 43.5) small.push(`${name(target)} ${Math.round(b.width)}×${Math.round(b.height)}`);
        const typesText = el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || (el.tagName === 'INPUT' && !['checkbox', 'radio', 'range', 'color', 'button', 'submit'].includes(input.type));
        if (typesText) {
          const px = parseFloat(getComputedStyle(el).fontSize);
          if (px < 16) tinyText.push(`${name(el)} ${px}px`);
        }
      }
    }
    return { overflow: document.scrollingElement!.scrollWidth - window.innerWidth, small, tinyText };
  });
}

test('AOS-20.5 — the C3 screens at iPhone sizes: no sideways scroll, 44 px targets, 16 px text boxes, zoom allowed, safe areas', async ({ browser, playwright, baseURL }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'one run covers every size (each size opens its own touch context)');
  test.setTimeout(420_000);
  const w = await buildAosWorld({
    playwright,
    baseURL: baseURL!,
    project: testInfo.project.name,
    people: { mod: { name: 'المشرف', role: 'subject_moderator' } },
    lecture: { title: 'Lecture 7 — iPhone sizes fixture', pages: fixturePages('Lecture 7', 2, 71_000), fileName: 'lecture7.pdf' },
  });
  const problems: string[] = [];
  try {
    for (const size of SIZES) {
      const context = await browser.newContext({ baseURL, locale: 'ar-IQ', timezoneId: 'Asia/Baghdad', serviceWorkers: 'block', viewport: { width: size.width, height: size.height }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
      try {
        const page = await context.newPage();
        await setupOwner(page);

        // the document itself: zoom allowed, edge to edge, safe areas honoured by the bottom tab bar
        if (size === SIZES[0]) {
          const viewport = (await page.locator('meta[name="viewport"]').getAttribute('content')) ?? '';
          expect(viewport).toContain('width=device-width');
          expect(viewport).toContain('viewport-fit=cover');
          expect(viewport).not.toMatch(/user-scalable\s*=\s*(no|0)/);
          expect(viewport).not.toMatch(/maximum-scale\s*=\s*1(\.0*)?\b/);
          const safe = await page.evaluate(() => {
            const rules: string[] = [];
            const tokens: string[] = [];
            for (const sheet of Array.from(document.styleSheets)) {
              let list: CSSRuleList;
              try {
                list = sheet.cssRules;
              } catch {
                continue;
              }
              const walk = (rs: CSSRuleList) => {
                for (const r of Array.from(rs)) {
                  if (r instanceof CSSStyleRule && /\.ml-tabbar\b/.test(r.selectorText)) rules.push(r.cssText);
                  if (r instanceof CSSStyleRule && r.style.getPropertyValue('--ml-safe-bottom')) tokens.push(r.style.getPropertyValue('--ml-safe-bottom'));
                  else if ('cssRules' in r) walk((r as CSSGroupingRule).cssRules);
                }
              };
              walk(list);
            }
            // (the computed value is already the inset — 0px in a desktop browser — so the declaration is read)
            return { tabbar: rules.join('\n'), token: tokens.join(' ') };
          });
          expect(safe.token, 'the safe-area token reads the device inset').toMatch(/env\(safe-area-inset-bottom/);
          expect(safe.tabbar, 'the bottom tab bar keeps clear of the home indicator').toMatch(/--ml-safe-bottom|safe-area-inset-bottom/);
        }

        const screens: Array<{ name: string; open: () => Promise<void> }> = [
          { name: 'الإعدادات · تسجيل الخروج', open: async () => { await page.goto('/settings'); await expect(page.getByRole('checkbox', { name: /امسح بيانات هذا الجهاز عند الخروج/ })).toBeVisible(); } },
          { name: 'أنا · الخصوصية', open: async () => { await page.goto('/me/privacy'); await expect(page.getByRole('heading', { name: 'بياناتك على هذا الجهاز' })).toBeVisible(); } },
          {
            name: 'أنا · أجهزتي',
            open: async () => {
              // this browser is registered as a device by its first sync
              await expect(async () => {
                await page.goto('/me/devices');
                await expect(page.getByRole('switch', { name: /هذا جهاز مشترك/ })).toBeVisible({ timeout: 3_000 });
              }).toPass({ timeout: 60_000 });
            },
          },
          { name: 'الاختبارات · توليد (رصيد الذكاء الاصطناعي)', open: async () => { await page.goto('/exams/generate'); await expect(page.getByRole('note', { name: 'رصيد الذكاء الاصطناعي' }).first()).toBeVisible(); } },
          { name: 'المادة', open: async () => { await page.goto(`/subjects/${w.subject.id}`); await expect(page.getByRole('heading', { level: 1 })).toBeVisible(); } },
          {
            name: 'إدارة القنوات · عقدة جديدة (حوار)',
            open: async () => {
              await page.goto(`/admin/tree?node=${w.subject.parent_id}`);
              await page.getByRole('button', { name: /^أضف تحت / }).first().click();
              await expect(page.getByRole('dialog')).toBeVisible();
            },
          },
        ];

        for (const s of screens) {
          for (const scale of ['1', '1.5']) {
            await s.open();
            await page.evaluate((v) => {
              document.documentElement.style.setProperty('--ml-text-scale', v);
              document.documentElement.setAttribute('data-text-scale', v);
            }, scale);
            await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
            const m = await measure(page);
            const at = `${size.name} ${size.width}px · ${s.name} @ ${scale === '1' ? '100' : '150'} %`;
            if (m.overflow > 1) problems.push(`${at}: sideways scroll ${m.overflow}px`);
            for (const c of m.small) problems.push(`${at}: target under 44 px — ${c}`);
            for (const t of m.tinyText) problems.push(`${at}: text box under 16 px (Safari zooms on focus) — ${t}`);
            if (scale === '1' && size === SIZES[0]) {
              await screenshot(page, testInfo, `c3-iphone-se-${screens.indexOf(s)}`);
              // axe (WCAG 2.1 A / AA, serious + critical) in light, dark and e-ink, once per screen
              problems.push(...(await axeInLooks(page, `${size.name} · ${s.name}`)));
            }
          }
        }
      } finally {
        await context.close();
      }
    }
    expect(problems).toEqual([]);
  } finally {
    await w.dispose();
  }
});
