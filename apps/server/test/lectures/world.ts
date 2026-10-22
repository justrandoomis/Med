// Test world of P1-T5 (official lectures in subject spaces): one deployment with two subject spaces A and B registered
// through P1-T1's registry (the channel tree and memberships are P1-T4's, built at the same time — so the membership
// provider here is a test double with the SAME interface: access in ONE subject plus the roles held there).
//
// People (all real accounts with their own vaults):
//   owner      — user #1, platform admin; NOT a member of any subject unless a test adds it
//   mod        — Subject Moderator of A               modB — Subject Moderator of B (a stranger in A)
//   contrib    — Contributor in A                      contrib2 — another Contributor in A
//   student    — approved member of A                  assistant — Assistant of A (moderator access, no official powers)
//   outsider   — signed in, member of nothing          pending — a pending membership in A
// Every file is a TEST FIXTURE generated here (tiny PDFs with text).
import type { LightMyRequestResponse } from 'fastify';
import { expect } from 'vitest';
import type { ChannelRole } from '@medlevo/shared';
import type { SubjectMembership } from '../../src/modules/authz/rules/lectures';
import type { MembershipProvider } from '../../src/modules/authz/policy';
import type { SpaceAccess } from '../../src/system/binding';
import type { AuthHeaders, TestApp } from '../helpers/app';
import { makePdf, text } from '../helpers/pdfgen';
import { addUser } from '../helpers/tenancy';
import { createProcessingApp } from '../processing/helpers';

export const SUBJ_A = 'SUBJ-A';
export const SUBJ_B = 'SUBJ-B';
export const SPACE_A = 'SPACEA';
export const SPACE_B = 'SPACEB';

export type Person = 'owner' | 'mod' | 'modB' | 'contrib' | 'contrib2' | 'student' | 'assistant' | 'outsider' | 'pending';

export interface LectureWorld {
  t: TestApp;
  h: Record<Person, AuthHeaders>;
  id: Record<Person, string>;
  /** set or clear one person's membership in a space */
  setAccess(person: Person, spaceId: string, m: { access: SpaceAccess; roles?: ChannelRole[]; pending?: boolean; subject?: string } | null): void;
  req(person: Person, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, payload?: unknown, extraHeaders?: Record<string, string>): Promise<LightMyRequestResponse>;
  /** JSON request that must answer `status`; returns the parsed body */
  ok<T>(person: Person, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, payload?: unknown, status?: number): Promise<T>;
  upload(person: Person, path: string, file: { name: string; data: Buffer; mime?: string }, fields?: Record<string, string>): Promise<LightMyRequestResponse>;
  close(): Promise<void>;
}

/** /api/spaces/:space + rest */
export const sp = (space: string, rest: string) => `/api/spaces/${space}${rest}`;

/** A small text PDF: one page per entry (several lines each, enough for fingerprints and regions). */
export function lecturePdf(pages: string[][]): Buffer {
  return makePdf(
    pages.map((lines) => ({
      content: lines.map((l, i) => text(72, 720 - i * 22, 13, l)).join('\n'),
    })),
  );
}

/** Pages with distinctive text: `Lecture <n> page <i>: …` (≥ 40 normalised characters per page). */
export function pagesFor(label: string, count: number, edit: Record<number, string> = {}): string[][] {
  return Array.from({ length: count }, (_, i) => [
    edit[i] ?? `${label} page ${i + 1}: the renal artery arises from the abdominal aorta`,
    `Anatomy notes ${label} section ${i + 1} with distinct wording number ${i * 7 + 3}`,
    `Clinical correlation ${i + 1} for ${label} and its blood supply`,
  ]);
}

export function multipart(fields: Record<string, string>, file: { name: string; data: Buffer; mime?: string } | null): { body: Buffer; contentType: string } {
  const boundary = '----p1t5lectures';
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  if (file) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.mime ?? 'application/pdf'}\r\n\r\n`));
    parts.push(file.data);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

export async function createLectureWorld(opts: { app?: () => Promise<TestApp> } = {}): Promise<LectureWorld> {
  const t = await (opts.app ?? createProcessingApp)();
  const h = {} as Record<Person, AuthHeaders>;
  const id = {} as Record<Person, string>;
  h.owner = await t.login();
  id.owner = t.ctx.system.users.findForAuth('owner')!.id;
  for (const p of ['mod', 'modB', 'contrib', 'contrib2', 'student', 'assistant', 'outsider', 'pending'] as const) {
    const u = await addUser(t, `u-${p.toLowerCase()}`);
    h[p] = await u.login();
    id[p] = u.user.id;
  }
  for (const [spaceId, title] of [
    [SPACE_A, 'Anatomy A'],
    [SPACE_B, 'Physiology B'],
  ] as const) {
    const dbFile = t.ctx.pool.createFile('space', spaceId);
    t.ctx.system.vaults.registerSpaceInternal({ id: spaceId, title, dbFile });
  }
  const access = new Map<string, SubjectMembership>();
  const provider: MembershipProvider = { accessToSpace: (v, spaceId) => access.get(`${v.userId}/${spaceId}`) ?? null };
  t.ctx.authz.setMembershipProvider(provider);
  const setAccess: LectureWorld['setAccess'] = (person, spaceId, m) => {
    const key = `${id[person]}/${spaceId}`;
    if (!m) access.delete(key);
    else access.set(key, { subjectNodeId: m.subject ?? (spaceId === SPACE_A ? SUBJ_A : SUBJ_B), access: m.access, roles: m.roles ?? [], pending: m.pending });
  };
  setAccess('mod', SPACE_A, { access: 'moderator', roles: ['subject_moderator'] });
  setAccess('modB', SPACE_B, { access: 'moderator', roles: ['subject_moderator'] });
  setAccess('contrib', SPACE_A, { access: 'member', roles: ['contributor'] });
  setAccess('contrib2', SPACE_A, { access: 'member', roles: ['contributor'] });
  setAccess('student', SPACE_A, { access: 'member' });
  setAccess('assistant', SPACE_A, { access: 'moderator', roles: ['assistant'] });
  setAccess('pending', SPACE_A, { access: 'member', pending: true });

  const req: LectureWorld['req'] = (person, method, path, payload, extraHeaders) =>
    t.app.inject({ method, url: path, headers: { ...h[person], ...(extraHeaders ?? {}) }, ...(payload === undefined ? {} : { payload: payload as object }) });
  const ok: LectureWorld['ok'] = async <T>(person: Person, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, payload?: unknown, status = 200) => {
    const res = await req(person, method, path, payload === undefined && method !== 'GET' && method !== 'DELETE' ? {} : payload);
    expect(res.statusCode, `${person} ${method} ${path}: ${res.body}`).toBe(status);
    return (res.body ? res.json() : null) as T;
  };
  const upload: LectureWorld['upload'] = (person, path, file, fields = {}) => {
    const mp = multipart(fields, file);
    return t.app.inject({ method: 'POST', url: path, headers: { ...h[person], 'content-type': mp.contentType }, payload: mp.body });
  };
  return { t, h, id, setAccess, req, ok, upload, close: () => t.close() };
}

/** Run every queued job (processing, analysis, page maps, corrections) in every database. */
export async function drain(w: LectureWorld): Promise<void> {
  await w.t.ctx.jobs.drain();
}

/** Run `fn` with the space's database bound (direct assertions on rows). */
export function inSpace<T>(w: LectureWorld, spaceId: string, fn: () => T): T {
  return w.t.ctx.binding.run({ kind: 'space', spaceId, subjectNodeId: spaceId === SPACE_A ? SUBJ_A : SUBJ_B, viewer: null, access: 'moderator', route: null }, fn);
}
