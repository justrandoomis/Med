// Academic OS P1-T4 step 3 — «no decorative controls» (PRD AOS-23.3; BUILD_PLAN §3.6) against the REAL server and the
// built web app, phone 390 × 844 and desktop 1280 × 800. On every screen this step built (the app shell, «القنوات», the
// subject page and its tabs, the invite landing, «التنبيهات», «أنا» and its pages, «إدارة القنوات» and its sections) every
// visible control either ACTS or is disabled WITH ITS REASON:
//   * a disabled control names why (aria-describedby text on screen, or a title);
//   * a link has a real in-app destination that opens (not the missing page) — or a download / file URL that answers;
//   * a field has an accessible name;
//   * a button, switch, tab, radio or checkbox — clicked on a freshly loaded screen — changes something the person can
//     notice (the page, the address, a request to the server, a file chooser, a download, a dialog).
// Each screen is also checked with axe in light, dark and e-ink (0 serious / critical) and, on the phone, for 44 px
// targets. The controls INSIDE dialogs are exercised by the journeys (aos-p1-join, aos-p1-admin) and the unit tests.
import type { Page, TestInfo } from '@playwright/test';
import { expect, screenshot, setupOwner, test } from './support';
import { axeInLooks, buildWorld, CLIENT_HEADERS, createCode, joinPath, ownerSession, registerStudent, stampFor, type World } from './aos-p1-channels-helpers';

interface Control {
  i: number;
  tag: string;
  role: string;
  type: string;
  name: string;
  href: string | null;
  disabled: boolean;
  why: string;
  current: boolean;
  h: number;
  w: number;
  cls: string;
}

/** Every visible, enabled-or-disabled control of the page (or of `scope`), in document order. */
async function controls(page: Page, scope = 'body'): Promise<Control[]> {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel) ?? document.body;
    const q = 'a[href], button, [role=button], [role=switch], [role=tab], [role=radio], [role=checkbox], [role=menuitem], input:not([type=hidden]), select, textarea, summary';
    const visible = (el: HTMLElement) => {
      if (el.closest('[aria-hidden="true"], [inert]')) return false;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0;
    };
    const nameOf = (el: HTMLElement) => {
      const by = el.getAttribute('aria-labelledby');
      const labelled = by
        ? by
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
            .join(' ')
        : '';
      const label = (el as HTMLInputElement).labels?.[0]?.textContent?.trim() ?? '';
      return (el.getAttribute('aria-label') || labelled || label || el.textContent?.trim() || el.getAttribute('title') || '').replace(/\s+/g, ' ').slice(0, 80);
    };
    return Array.from(root.querySelectorAll<HTMLElement>(q))
      .filter(visible)
      .map((el, i) => {
        const ids = (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
        const why = [...ids.map((id) => document.getElementById(id)?.textContent?.trim() ?? ''), el.getAttribute('title') ?? ''].join(' ').trim();
        const r = el.getBoundingClientRect();
        return {
          i,
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role') ?? '',
          type: el.getAttribute('type') ?? '',
          name: nameOf(el),
          href: el.tagName === 'A' ? el.getAttribute('href') : null,
          disabled: (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true',
          why,
          current: el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-current') === 'page',
          h: r.height,
          w: r.width,
          cls: el.className && typeof el.className === 'string' ? el.className : '',
        };
      });
  }, scope);
}

/** Clicks the i-th control of a freshly loaded screen and reports whether anything the person could notice happened. */
async function actsWhenClicked(page: Page, c: Control, scope: string): Promise<{ acted: boolean; how: string }> {
  const url = page.url();
  let requests = 0;
  let events = '';
  const onReq = (r: { url(): string }) => {
    if (new URL(r.url()).origin === new URL(url).origin) requests++;
  };
  const onChooser = () => (events += 'file chooser ');
  const onDownload = () => (events += 'download ');
  const onPopup = () => (events += 'popup ');
  page.on('request', onReq);
  page.on('filechooser', onChooser);
  page.on('download', onDownload);
  page.on('popup', onPopup);
  try {
    await page.evaluate(() => {
      const w = window as unknown as { __sweep: number; __sweepMo?: MutationObserver };
      w.__sweep = 0;
      w.__sweepMo?.disconnect();
      w.__sweepMo = new MutationObserver((records) => {
        for (const m of records) {
          const t = m.target instanceof Element ? m.target : m.target.parentElement;
          if (t?.closest('[role=tooltip]')) continue;
          w.__sweep++;
        }
      });
      w.__sweepMo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    });
    // re-find the same control on the fresh screen: same position among the visible ones, same name
    const now = await controls(page, scope);
    const same = now.find((x) => x.i === c.i && x.name === c.name && x.tag === c.tag) ?? now.find((x) => x.name === c.name && x.tag === c.tag && x.role === c.role);
    if (!same) return { acted: true, how: 'gone after an earlier control changed the state (that control acted)' };
    // map the visible index back to the element
    const handle = await page.evaluateHandle(
      ({ sel, i }) => {
        const root = document.querySelector(sel) ?? document.body;
        const q = 'a[href], button, [role=button], [role=switch], [role=tab], [role=radio], [role=checkbox], [role=menuitem], input:not([type=hidden]), select, textarea, summary';
        const vis = Array.from(root.querySelectorAll<HTMLElement>(q)).filter((el) => {
          if (el.closest('[aria-hidden="true"], [inert]')) return false;
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0;
        });
        return vis[i] ?? null;
      },
      { sel: scope, i: same.i },
    );
    const el = handle.asElement();
    if (!el) return { acted: false, how: 'could not be located' };
    await el.click({ timeout: 5_000 });
    for (let t = 0; t < 20; t++) {
      const mutations = await page.evaluate(() => (window as unknown as { __sweep: number }).__sweep).catch(() => 1);
      if (mutations > 0) return { acted: true, how: `${mutations} change(s) on the page` };
      if (page.url() !== url) return { acted: true, how: `opened ${page.url()}` };
      if (requests > 0) return { acted: true, how: `${requests} request(s)` };
      if (events) return { acted: true, how: events.trim() };
      await page.waitForTimeout(100);
    }
    return { acted: false, how: 'nothing changed in 2 s' };
  } finally {
    page.off('request', onReq);
    page.off('filechooser', onChooser);
    page.off('download', onDownload);
    page.off('popup', onPopup);
  }
}

interface ScreenSpec {
  path: string;
  /** a visible element that says the screen is ready */
  ready: (page: Page) => ReturnType<Page['getByRole']>;
  /** only the controls inside this element (default: the whole page) */
  scope?: string;
  /** control names never clicked here, with why */
  skip?: Record<string, string>;
  name: string;
}

async function openScreen(page: Page, s: ScreenSpec) {
  await page.goto(s.path);
  await expect(s.ready(page)).toBeVisible({ timeout: 20_000 });
  await page.waitForLoadState('networkidle');
}

/** The sweep of one screen; returns the problems found (empty = every control acts or says why it cannot). */
async function sweep(page: Page, s: ScreenSpec, testInfo: TestInfo, seenLinks: Set<string>): Promise<string[]> {
  const scope = s.scope ?? 'body';
  const problems: string[] = [];
  await openScreen(page, s);
  await screenshot(page, testInfo, `aos-sweep-${s.name}`);
  problems.push(...(await axeInLooks(page, s.name, s.scope)));
  const list = await controls(page, scope);
  const stats = { controls: list.length, disabled: list.filter((c) => c.disabled).length, clicked: 0, links: 0 };
  const clicked = new Set<string>();
  const links: string[] = [];
  for (const c of list) {
    const label = `${s.name}: ${c.tag}${c.role ? `[${c.role}]` : ''} «${c.name}»`;
    if (!c.name) problems.push(`${label}: has no accessible name`);
    if (testInfo.project.name === 'phone' && (c.cls.includes('ml-btn') || c.cls.includes('ml-icon-btn')) && c.h < 43.5) problems.push(`${label}: ${Math.round(c.h)} px tall (< 44 px target)`);
    if (c.disabled) {
      if (!c.why) problems.push(`${label}: disabled without saying why`);
      continue;
    }
    if (c.tag === 'a') {
      if (!c.href || c.href === '#' || c.href.startsWith('javascript:')) problems.push(`${label}: link without a destination`);
      else links.push(c.href);
      continue;
    }
    if (c.tag === 'input' || c.tag === 'select' || c.tag === 'textarea') continue; // named fields accept input
    if (c.current) continue; // the selected tab / option / current place: choosing it again is a no-op by design
    const key = `${c.tag}|${c.role}|${c.name}`;
    if (clicked.has(key)) continue; // one of each repeated row action
    clicked.add(key);
    // at most 40 different controls are CLICKED per screen; every control is still checked for a name and a reason
    // (review P1-T4 step 3: a `break` here used to skip those checks for the rest of a long screen)
    if (clicked.size > 40) {
      testInfo.annotations.push({ type: 'not-clicked', description: `${label}: more than 40 different controls on this screen` });
      continue;
    }
    if (s.skip?.[c.name]) {
      testInfo.annotations.push({ type: 'not-clicked', description: `${label}: ${s.skip[c.name]}` });
      continue;
    }
    await openScreen(page, s);
    const r = await actsWhenClicked(page, c, scope);
    stats.clicked++;
    if (!r.acted) problems.push(`${label}: does nothing (${r.how})`);
  }
  // every in-app link opens a real screen; a file link answers
  for (const href of links) {
    const url = new URL(href, page.url());
    const key = url.pathname + url.search;
    if (seenLinks.has(key)) continue;
    seenLinks.add(key);
    if (url.origin !== new URL(page.url()).origin) continue;
    stats.links++;
    if (url.pathname.startsWith('/api/')) {
      const res = await page.request.get(key);
      if (res.status() >= 400) problems.push(`${s.name}: link ${key} answers ${res.status()}`);
      continue;
    }
    await page.goto(key);
    await page.waitForLoadState('networkidle');
    if (await page.getByRole('heading', { name: 'هذه الصفحة غير موجودة' }).isVisible()) problems.push(`${s.name}: link ${key} leads to the missing page`);
  }
  testInfo.annotations.push({ type: 'sweep', description: `${s.name}: ${stats.controls} controls (${stats.disabled} disabled), ${stats.clicked} clicked, ${stats.links} links opened` });
  return problems;
}

const h1 = (name: string | RegExp) => (page: Page) => page.getByRole('heading', { level: 1, name });

test.describe('no decorative controls (AOS-23.3)', () => {
  test.setTimeout(600_000);
  // Following the links of «أنا» opens the Control Center, which asks every account for the server's off-site backup
  // status (GET /api/data/offsite, PL-0) — the platform admin's alone, so another account gets the plain 404 and the
  // browser logs it; the screen shows no error (features/control, not this track's; reported).
  test.use({ allowedConsoleErrors: [/status of 404/] });

  let world: World;
  let inviteToken = '';
  let studentPending = '';
  test.beforeEach(async ({ playwright, baseURL }, testInfo) => {
    const owner = await ownerSession(playwright, baseURL!);
    try {
      world = await buildWorld(owner.api, stampFor(testInfo.project.name));
      inviteToken = joinPath((await createCode(owner.api, world.open.id, 'invite_link', false)).link!).split('/').pop()!;
      studentPending = (await createCode(owner.api, world.approval.id, 'class_code', true)).code!;
    } finally {
      await owner.dispose();
    }
  });

  test('a student’s screens: «القنوات», the subject page and its tabs, «التنبيهات», «أنا» and its pages', async ({ page, playwright, baseURL }, testInfo) => {
    const stamp = stampFor(testInfo.project.name);
    const owner = await ownerSession(playwright, baseURL!);
    try {
      // a member of one subject (approved → an inbox entry), a pending request in another, an invitation to a third
      const reg = await registerStudent(page.request, { username: `sweep_${stamp}`, display_name: `مسح ${stamp}` }, { code: studentPending });
      await owner.api.post(`/api/channels/nodes/${world.approval.id}/members/${reg.user.id}/decision`, { decision: 'approve' });
      const pendingSubject = await owner.api.post<{ id: string }>('/api/channels/nodes', { parent_id: world.college.id, kind: 'subject', title: `علم الأدوية ${stamp}`, create_space: true, join_policy: 'approval' });
      const code = await createCode(owner.api, pendingSubject.id, 'class_code', true);
      expect((await page.request.post('/api/channels/join', { headers: { ...CLIENT_HEADERS }, data: { code: code.code } })).status()).toBe(200);
      await owner.api.post(`/api/channels/nodes/${world.open.id}/invitations`, { user_ids: [reg.user.id] });
    } finally {
      await owner.dispose();
    }
    const seen = new Set<string>();
    const screens: ScreenSpec[] = [
      { name: 'shell', path: '/', ready: h1('الرئيسية'), scope: 'header.ml-topbar' },
      { name: 'tabbar', path: '/', ready: h1('الرئيسية'), scope: 'nav.ml-tabbar' },
      { name: 'channels', path: '/channels', ready: h1('القنوات'), scope: 'main' },
      { name: 'browse', path: `/channels/${world.university.id}`, ready: h1(world.university.title), scope: 'main' },
      { name: 'subject-lectures', path: `/subjects/${world.approval.id}`, ready: h1(world.approval.title), scope: 'main' },
      { name: 'subject-files', path: `/subjects/${world.approval.id}?tab=files`, ready: h1(world.approval.title), scope: 'main' },
      { name: 'subject-updates', path: `/subjects/${world.approval.id}?tab=updates`, ready: h1(world.approval.title), scope: 'main' },
      { name: 'subject-locked', path: `/subjects/${world.open.id}`, ready: h1(world.open.title), scope: 'main' },
      { name: 'notifications', path: '/notifications', ready: h1('التنبيهات'), scope: 'main' },
      { name: 'me', path: '/me', ready: h1('أنا'), scope: 'main' },
      { name: 'me-devices', path: '/me/devices', ready: h1('أجهزتي'), scope: 'main' },
      { name: 'me-privacy', path: '/me/privacy', ready: h1('الخصوصية والبيانات'), scope: 'main' },
      { name: 'me-usage', path: '/me/usage', ready: h1('الاستهلاك'), scope: 'main' },
    ];
    const problems: string[] = [];
    for (const s of screens) problems.push(...(await sweep(page, s, testInfo, seen)));
    expect(problems, problems.join('\n')).toEqual([]);
  });

  test('the platform admin’s screens: «إدارة القنوات» and every section, «أنا», «التنبيهات»', async ({ page }, testInfo) => {
    await setupOwner(page);
    const seen = new Set<string>();
    const screens: ScreenSpec[] = [
      { name: 'admin-me', path: '/me', ready: h1('أنا'), scope: 'main' },
      { name: 'admin-notifications', path: '/notifications', ready: h1('التنبيهات'), scope: 'main' },
      { name: 'admin-index', path: `/admin?node=${world.university.id}`, ready: h1('إدارة القنوات'), scope: 'main' },
      { name: 'admin-tree', path: `/admin/tree?node=${world.university.id}`, ready: h1('الشجرة'), scope: 'main' },
      { name: 'admin-members', path: `/admin/members?node=${world.approval.id}`, ready: h1(/الأعضاء/), scope: 'main' },
      { name: 'admin-codes', path: `/admin/codes?node=${world.open.id}`, ready: h1('الرموز والدعوات'), scope: 'main' },
      { name: 'admin-roles', path: `/admin/roles?node=${world.open.id}`, ready: h1('الأدوار'), scope: 'main' },
      { name: 'admin-moderation', path: `/admin/moderation?node=${world.open.id}`, ready: h1('الإشراف'), scope: 'main' },
      { name: 'admin-audit', path: `/admin/audit?node=${world.open.id}`, ready: h1('سجل الإجراءات'), scope: 'main' },
    ];
    const problems: string[] = [];
    for (const s of screens) problems.push(...(await sweep(page, s, testInfo, seen)));
    expect(problems, problems.join('\n')).toEqual([]);
  });

  test('the sweep itself notices a control that does nothing, and one disabled without a reason', async ({ page }) => {
    await page.goto(`/join/${inviteToken}`);
    await expect(h1('دعوة للانضمام')(page)).toBeVisible();
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => {
      const main = document.querySelector('main')!;
      const dead = document.createElement('button');
      dead.textContent = 'زر لا يفعل شيئًا';
      const mute = document.createElement('button');
      mute.textContent = 'زر معطّل بلا سبب';
      mute.disabled = true;
      main.append(dead, mute);
    });
    const list = await controls(page, 'main');
    const dead = list.find((c) => c.name === 'زر لا يفعل شيئًا')!;
    const mute = list.find((c) => c.name === 'زر معطّل بلا سبب')!;
    expect(mute.disabled && mute.why === '').toBe(true);
    expect((await actsWhenClicked(page, dead, 'main')).acted).toBe(false);
    const real = list.find((c) => c.name === 'أنشئ حسابًا بهذه الدعوة')!;
    expect((await actsWhenClicked(page, real, 'main')).acted).toBe(true);
  });

  // Review of P1-T4 step 3: the self-test above runs on the public landing, where nothing else runs. On a screen of the
  // app shell the bell polls, the sync engine and the save status work beside the page — the sweep must still tell a
  // dead control from that background activity, and still notice a disabled one without a reason.
  test('the sweep notices a dead control on a screen of the app shell too', async ({ page }) => {
    await setupOwner(page);
    for (const path of ['/channels', '/me', '/notifications']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
      await page.waitForLoadState('networkidle');
      await page.evaluate(() => {
        const main = document.querySelector('main')!;
        const dead = document.createElement('button');
        dead.textContent = 'زر لا يفعل شيئًا';
        const mute = document.createElement('button');
        mute.textContent = 'زر معطّل بلا سبب';
        mute.disabled = true;
        main.append(dead, mute);
      });
      const list = await controls(page, 'main');
      const mute = list.find((c) => c.name === 'زر معطّل بلا سبب')!;
      expect(mute.disabled && mute.why === '', `${path}: a disabled control without a reason is noticed`).toBe(true);
      const r = await actsWhenClicked(page, list.find((c) => c.name === 'زر لا يفعل شيئًا')!, 'main');
      expect(r.acted, `${path}: a dead control is noticed (${r.how})`).toBe(false);
    }
  });

  test('the invite landing before sign-in', async ({ page }, testInfo) => {
    const problems = await sweep(page, { name: 'join-landing', path: `/join/${inviteToken}`, ready: h1('دعوة للانضمام'), scope: 'main' }, testInfo, new Set());
    expect(problems, problems.join('\n')).toEqual([]);
  });
});
