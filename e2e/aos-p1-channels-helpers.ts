// Helpers of the P1-T4 step 3 E2E specs (channels, join, administration, the no-decorative sweep; BUILD_PLAN §3.6):
// a separate signed-in owner (the platform admin) next to the page under test, a small channel tree built through the
// REAL API, students who register with a join proof (there is no open sign-up), QR pictures generated here, axe and
// the three looks (light / dark / e-ink).
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import qrcode from 'qrcode-generator';
import { expect, type APIRequestContext, type Page, type PlaywrightWorkerArgs } from '@playwright/test';
import type { ChannelNodeView, CreateJoinCodeResponse, RegisterWithJoinResponse } from '@medlevo/shared';
import { apiAs, CSRF_HEADERS, E2E_ARTIFACTS_DIR, setupOwner, type E2eApi } from './support';

export const STUDENT_PASSWORD = 'night shift wards 2026';

/**
 * What the multi-user web client sends with a mutation: the CSRF header and its version (`x-medlevo-client`, at least
 * MIN_CLIENT_VERSION of packages/shared — the client-version gate answers 426 to a versionless write of any account but
 * user #1).
 */
export const CLIENT_HEADERS = { 'x-medlevo-csrf': '1', 'x-medlevo-client': '0.1.0' } as const;

/** A unique, short stamp for titles and user names (the servers live through the whole run). */
export function stampFor(project: string): string {
  return `${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 5)}${project === 'phone' ? 'p' : 'd'}`;
}

export interface OwnerSession {
  api: E2eApi;
  request: APIRequestContext;
  dispose(): Promise<void>;
}

/** The owner (user #1, platform admin) signed in through the API in its OWN cookie jar, beside the page under test. */
export async function ownerSession(playwright: PlaywrightWorkerArgs['playwright'], baseURL: string): Promise<OwnerSession> {
  const request = await playwright.request.newContext({ baseURL });
  await setupOwner(request);
  return { api: apiAs(request), request, dispose: () => request.dispose() };
}

export interface World {
  stamp: string;
  university: ChannelNodeView;
  college: ChannelNodeView;
  /** joins straight away with a code or link */
  open: ChannelNodeView;
  /** a moderator approves each request */
  approval: ChannelNodeView;
}

function node(owner: E2eApi, body: Record<string, unknown>): Promise<ChannelNodeView> {
  return owner.post<ChannelNodeView>('/api/channels/nodes', body);
}

/** University → college → two subjects (one open with a code, one by approval), all with Arabic titles. */
export async function buildWorld(owner: E2eApi, stamp: string): Promise<World> {
  const university = await node(owner, { parent_id: null, kind: 'university', title: `جامعة الرافدين ${stamp}` });
  const college = await node(owner, { parent_id: university.id, kind: 'college', title: `كلية الطب ${stamp}` });
  const open = await node(owner, { parent_id: college.id, kind: 'subject', title: `الجراحة ${stamp}`, create_space: true, join_policy: 'open_with_code' });
  const approval = await node(owner, { parent_id: college.id, kind: 'subject', title: `الباطنية ${stamp}`, create_space: true, join_policy: 'approval' });
  return { stamp, university, college, open, approval };
}

export function createCode(owner: E2eApi, nodeId: string, kind: 'class_code' | 'invite_link', requiresApproval: boolean): Promise<CreateJoinCodeResponse> {
  return owner.post<CreateJoinCodeResponse>(`/api/channels/nodes/${nodeId}/codes`, { kind, expires_in_hours: 24, requires_approval: requiresApproval });
}

/** The path of an invite link (`/join/<token>`) on THIS server, whatever origin the server printed. */
export function joinPath(link: string): string {
  return new URL(link).pathname;
}

/** A new account WITH a join proof (POST /api/auth/register) — signed in in `target`'s cookie jar. */
export async function registerStudent(
  target: APIRequestContext,
  who: { username: string; display_name: string },
  joinProof: { code: string } | { invite_token: string },
): Promise<RegisterWithJoinResponse> {
  const res = await target.post('/api/auth/register', {
    headers: { ...CSRF_HEADERS },
    data: { username: who.username, display_name: who.display_name, password: STUDENT_PASSWORD, join: joinProof, device_label: 'Playwright' },
  });
  expect(res.status(), `register ${who.username}: ${await res.text()}`).toBe(200);
  return (await res.json()) as RegisterWithJoinResponse;
}

export function tokenOf(link: string): string {
  return joinPath(link).split('/').pop()!;
}

/** A QR picture (GIF) of `text`, as the admin's screen or a screenshot of it would hold it. */
export function qrGif(text: string, cell = 8): Buffer {
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  return Buffer.from(qr.createDataURL(cell, 4).split(',')[1]!, 'base64');
}

/**
 * A fake camera recording (YUV4MPEG2, 4:2:0) that shows the QR of `text` — Chromium plays it through
 * `--use-file-for-fake-video-capture`, so the in-app scanner decodes REAL camera frames.
 */
export function qrY4m(text: string, size = 480): string {
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  const cell = Math.floor(size / (n + 8));
  const offset = Math.floor((size - n * cell) / 2);
  const y = Buffer.alloc(size * size, 235);
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++) {
      if (!qr.isDark(r, c)) continue;
      for (let dy = 0; dy < cell; dy++) y.fill(16, (offset + r * cell + dy) * size + offset + c * cell, (offset + r * cell + dy) * size + offset + (c + 1) * cell);
    }
  const chroma = Buffer.alloc((size / 2) * (size / 2), 128);
  const frame = Buffer.concat([Buffer.from('FRAME\n'), y, chroma, chroma]);
  const dir = join(E2E_ARTIFACTS_DIR, 'fake-camera');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `qr-${Date.now().toString(36)}.y4m`);
  writeFileSync(file, Buffer.concat([Buffer.from(`YUV4MPEG2 W${size} H${size} F10:1 Ip A1:1 C420jpeg\n`), frame, frame, frame]));
  return file;
}

// ───────────────────────────── looks and axe ─────────────────────────────

export type Look = 'light' | 'dark' | 'eink';
export const LOOKS: Look[] = ['light', 'dark', 'eink'];

/** Switch the look of the page in place (the attributes the theme and display stores write on <html>). */
export async function setLook(page: Page, look: Look): Promise<void> {
  await page.evaluate((l) => {
    const root = document.documentElement;
    root.setAttribute('data-theme', l === 'dark' ? 'dark' : 'light');
    // no colour transitions while axe measures (e-ink has none anyway)
    root.setAttribute('data-reduce-motion', 'on');
    if (l === 'eink') root.setAttribute('data-eink', 'on');
    else root.removeAttribute('data-eink');
  }, look);
  // let any running transition settle before colours are read
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 350)))));
}

/** axe-core's bundle, evaluated in the page (the app's CSP forbids injected <script> tags — rightly). */
const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

export interface AxeFinding {
  id: string;
  impact: string;
  help: string;
  targets: string[];
}

/** axe-core (WCAG 2.0 / 2.1 A and AA) on the current page: the serious and critical violations only. */
export async function seriousAxe(page: Page, include?: string): Promise<AxeFinding[]> {
  if (!(await page.evaluate(() => 'axe' in window))) await page.evaluate(axeSource);
  return page.evaluate(async (inc) => {
    const axe = (window as unknown as { axe: { run: (ctx: Document | { include: string[] }, opts: unknown) => Promise<{ violations: Array<{ id: string; impact: string | null; help: string; nodes: Array<{ target: unknown[]; failureSummary?: string }> }> }> } }).axe;
    const r = await axe.run(inc ? { include: [inc] } : document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] }, resultTypes: ['violations'] });
    return r.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => ({ id: v.id, impact: v.impact ?? '', help: v.help, targets: v.nodes.slice(0, 5).map((n) => `${n.target.map(String).join(' ')} ${(n.failureSummary ?? '').replace(/\s+/g, ' ').slice(0, 200)}`) }));
  }, include ?? null);
}

/** axe in the three looks (optionally only inside `include`); returns «look: rule (targets)» lines for an assertion message. */
export async function axeInLooks(page: Page, name: string, include?: string): Promise<string[]> {
  const out: string[] = [];
  for (const look of LOOKS) {
    await setLook(page, look);
    for (const f of await seriousAxe(page, include)) out.push(`${name} [${look}] ${f.impact} ${f.id}: ${f.help} — ${f.targets.join(' | ')}`);
  }
  await setLook(page, 'light');
  return out;
}
