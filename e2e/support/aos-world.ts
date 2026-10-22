// The world of the P1-T5 step 3 E2E specs (BUILD_PLAN §3.7: Scenario 2, Scenario 4, the Phase 1 vertical slice), built
// through the REAL API of the per-project server the harness started:
//   * the owner (user #1, platform admin) in its own cookie jar builds a university → college → subject with a space,
//     a class code, and the roles (Subject Moderator, Assistant);
//   * every student is a REAL account that registers WITH the class code (there is no open sign-up) — one of them in the
//     page's own cookie jar, so the browser under test is that student; the others in API contexts of their own;
//   * the Subject Moderator creates an official lecture, uploads a TEST FIXTURE PDF (P1-T3's synthetic generator, a per-run
//     tag keeps the bytes unique on the shared server) and publishes it once processing is ready.
// Every helper speaks as one person, with the CSRF header and the client version a multi-user client sends (the client-
// version gate answers 426 to a versionless write of anyone but user #1). Types only come from @medlevo/shared.
import { randomBytes } from 'node:crypto';
import type { APIRequestContext, APIResponse, Page, PlaywrightWorkerArgs } from '@playwright/test';
import type {
  AnnotationDTO,
  ChannelNodeView,
  CreateJoinCodeResponse,
  DocumentCopyView,
  NoteDTO,
  OfficialLectureView,
  PublicationView,
  RegisterWithJoinResponse,
  SourceAnnotationsResponse,
  SourcePagesResponse,
  StartStudyingResponse,
  SyncOpResult,
  UploadOfficialVersionResponse,
} from '@medlevo/shared';
import { pdfFrom, sentences, type FixturePage } from '../../apps/server/test/fixtures/versions/build';
import { ApiCallError, CSRF_HEADERS } from './api';
import { expect } from './fixtures';
import { setupOwner } from './ui';

/** What the multi-user web client sends with every request (P1-T1 step 3 client-version gate; MIN_CLIENT_VERSION). */
export const CLIENT_HEADERS = { ...CSRF_HEADERS, 'x-medlevo-client': '0.1.0' } as const;
export const MEMBER_PASSWORD = 'night shift wards 2026';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A ULID-shaped id (26 Crockford characters, time first) — what the web client generates for new entities. */
export function ulid(): string {
  let t = Date.now();
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32]! + time;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(16);
  let rand = '';
  for (let i = 0; i < 16; i++) rand += CROCKFORD[bytes[i]! % 32];
  return time + rand;
}

/** A unique, short stamp for titles and user names (the servers live through the whole run). */
export function runStamp(project: string): string {
  return `${Date.now().toString(36).slice(-5)}${randomBytes(2).toString('hex')}${project === 'phone' ? 'p' : 'd'}`;
}

export interface Api {
  readonly request: APIRequestContext;
  call(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, data?: unknown, headers?: Record<string, string>): Promise<APIResponse>;
  get<T = unknown>(path: string): Promise<T>;
  post<T = unknown>(path: string, data?: unknown, headers?: Record<string, string>): Promise<T>;
  patch<T = unknown>(path: string, data?: unknown): Promise<T>;
}

/** An API client acting as the signed-in account of `request`'s cookie jar, as the multi-user web client would. */
export function clientApi(request: APIRequestContext): Api {
  const call: Api['call'] = (method, path, data, headers = {}) => request.fetch(path, { method, headers: { ...CLIENT_HEADERS, ...headers }, ...(data === undefined ? {} : { data }) });
  const parse = async <T>(method: string, path: string, res: APIResponse): Promise<T> => {
    const text = await res.text();
    if (!res.ok()) throw new ApiCallError(method, path, res.status(), text);
    return (text ? JSON.parse(text) : null) as T;
  };
  return {
    request,
    call,
    get: async (path) => parse('GET', path, await call('GET', path)),
    post: async (path, data, headers) => parse('POST', path, await call('POST', path, data ?? {}, headers)),
    patch: async (path, data) => parse('PATCH', path, await call('PATCH', path, data ?? {})),
  };
}

export interface Member {
  key: string;
  name: string;
  userId: string;
  api: Api;
}

export interface WorldLecture {
  id: string;
  title: string;
  versionId: string;
}

export interface AosWorld {
  stamp: string;
  owner: Api;
  subject: ChannelNodeView;
  spaceId: string;
  code: string;
  people: Record<string, Member>;
  lecture: WorldLecture;
  /** /api/spaces/<space><rest> */
  S(rest: string): string;
  dispose(): Promise<void>;
}

export interface PersonSpec {
  name: string;
  role?: 'subject_moderator' | 'assistant';
  /** a member of ANOTHER subject only (leak checks) */
  outsider?: boolean;
}

/** Lecture pages of a TEST FIXTURE (its own deterministic text; `seed` keeps two specs' lectures apart). */
export function fixturePages(label: string, count: number, seed: number): FixturePage[] {
  return Array.from({ length: count }, (_, i) => ({
    heading: i === 0 ? `${label}: The abdominal wall (TEST FIXTURE)` : `${label} - section ${i + 1}`,
    lines: i === 0 ? ['TEST FIXTURE - synthetic structural document for automated tests. Not a medical reference.', `${label} - Anatomy course`] : sentences(seed + i, 8),
  }));
}

async function register(request: APIRequestContext, username: string, displayName: string, code: string): Promise<RegisterWithJoinResponse> {
  const res = await request.post('/api/auth/register', {
    headers: { ...CSRF_HEADERS },
    data: { username, display_name: displayName, password: MEMBER_PASSWORD, join: { code }, device_label: 'Playwright' },
  });
  expect(res.status(), `register ${username}: ${await res.text()}`).toBe(200);
  return (await res.json()) as RegisterWithJoinResponse;
}

/** Publish a version of an official lecture once its processing is ready (the server answers 409 «not ready» before). */
export async function publishWhenReady(m: Member, spaceId: string, lectureId: string, versionId: string, changeNote: string | null = null, timeoutMs = 180_000): Promise<void> {
  const path = `/api/spaces/${spaceId}/lectures/${lectureId}/versions/${versionId}/publish`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await m.api.call('POST', path, { change_note: changeNote });
    if (res.ok()) return;
    const body = await res.text();
    if (res.status() !== 409 || /failed|تعذّرت|فشل/.test(body) || Date.now() > deadline) throw new ApiCallError('POST', path, res.status(), body);
    await sleep(750);
  }
}

/** Upload a new version of an official lecture (multipart, as the admin screen does). */
export async function uploadOfficial(m: Member, spaceId: string, lectureId: string, name: string, data: Buffer): Promise<string> {
  const res = await m.api.request.post(`/api/spaces/${spaceId}/lectures/${lectureId}/upload`, {
    headers: { ...CLIENT_HEADERS },
    multipart: { file: { name, mimeType: 'application/pdf', buffer: data } },
    timeout: 120_000,
  });
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()) as UploadOfficialVersionResponse).version_id;
}

/**
 * University → college → subject (with its space, joined with a class code), the people, their roles, and an official
 * lecture published by the Subject Moderator. `pageMember` registers in the page's own cookie jar.
 */
export async function buildAosWorld(opts: {
  playwright: PlaywrightWorkerArgs['playwright'];
  baseURL: string;
  project: string;
  people: Record<string, PersonSpec>;
  page?: { key: string; page: Page };
  /** more people signed in in a browser page of their own */
  pages?: Array<{ key: string; page: Page }>;
  lecture: { title: string; pages: FixturePage[]; fileName: string };
}): Promise<AosWorld> {
  const inPage = new Map<string, Page>([...(opts.page ? [opts.page] : []), ...(opts.pages ?? [])].map((x) => [x.key, x.page]));
  const stamp = runStamp(opts.project);
  const contexts: APIRequestContext[] = [];
  const ownerReq = await opts.playwright.request.newContext({ baseURL: opts.baseURL });
  contexts.push(ownerReq);
  await setupOwner(ownerReq);
  const owner = clientApi(ownerReq);
  const node = (body: Record<string, unknown>) => owner.post<ChannelNodeView>('/api/channels/nodes', body);
  const university = await node({ parent_id: null, kind: 'university', title: `جامعة الرافدين ${stamp}` });
  const college = await node({ parent_id: university.id, kind: 'college', title: `كلية الطب ${stamp}` });
  const subject = await node({ parent_id: college.id, kind: 'subject', title: `التشريح ${stamp}`, create_space: true, join_policy: 'open_with_code' });
  const other = await node({ parent_id: college.id, kind: 'subject', title: `الفسلجة ${stamp}`, create_space: true, join_policy: 'open_with_code' });
  expect(subject.space_id).toBeTruthy();
  const codeOf = async (id: string) => (await owner.post<CreateJoinCodeResponse>(`/api/channels/nodes/${id}/codes`, { kind: 'class_code', expires_in_hours: 24, requires_approval: false })).code!;
  const code = await codeOf(subject.id);
  const otherCode = await codeOf(other.id);

  const people: Record<string, Member> = {};
  for (const [key, spec] of Object.entries(opts.people)) {
    const own = inPage.get(key);
    const request = own ? own.request : await opts.playwright.request.newContext({ baseURL: opts.baseURL });
    if (!own) contexts.push(request);
    const r = await register(request, `${key}_${stamp}`, `${spec.name}`, spec.outsider ? otherCode : code);
    people[key] = { key, name: spec.name, userId: r.user.id, api: clientApi(request) };
    if (spec.role) await owner.post(`/api/channels/nodes/${subject.id}/roles`, { user_id: r.user.id, role: spec.role });
  }

  const spaceId = subject.space_id!;
  const S = (rest: string) => `/api/spaces/${spaceId}${rest}`;
  const mod = Object.values(people).find((p) => opts.people[p.key]!.role === 'subject_moderator');
  if (!mod) throw new Error('the world needs a Subject Moderator');
  const created = await mod.api.post<OfficialLectureView>(S('/lectures'), { title: opts.lecture.title, lecture_no: 5 });
  const versionId = await uploadOfficial(mod, spaceId, created.id, opts.lecture.fileName, pdfFrom(opts.lecture.pages, { tag: `TEST FIXTURE ${stamp}` }));
  await publishWhenReady(mod, spaceId, created.id, versionId);
  return {
    stamp,
    owner,
    subject,
    spaceId,
    code,
    people,
    lecture: { id: created.id, title: opts.lecture.title, versionId },
    S,
    dispose: async () => {
      for (const c of contexts) await c.dispose();
    },
  };
}

// ───────────────────────────── a member's own data ─────────────────────────────

export async function startCopy(w: AosWorld, m: Member, body: { mode: 'personal' | 'followed' | 'independent_fork'; publication_id?: string; carry_personal_from_copy_id?: string }): Promise<DocumentCopyView> {
  return (await m.api.post<StartStudyingResponse>('/api/copies', { id: ulid(), space_id: w.spaceId, lecture_id: w.lecture.id, ...body })).copy;
}

export async function copyOf(m: Member, id: string): Promise<DocumentCopyView> {
  return m.api.get<DocumentCopyView>(`/api/copies/${id}`);
}

/** Page ids of a version of the stub in the member's vault (the same ids as the official version). */
export async function pageIds(m: Member, sourceId: string, versionId: string): Promise<string[]> {
  return (await m.api.get<SourcePagesResponse>(`/api/sources/${sourceId}/versions/${versionId}/pages`)).pages.map((p) => p.id);
}

export interface Anchor {
  type: 'page';
  source_id: string;
  version_id: string;
  page_id: string;
  page_index: number;
  space: 'page_norm';
}

export function anchorOf(sourceId: string, versionId: string, ids: string[], pageIndex: number): Anchor {
  return { type: 'page', source_id: sourceId, version_id: versionId, page_id: ids[pageIndex]!, page_index: pageIndex, space: 'page_norm' };
}

export interface Op {
  op_id: string;
  device_id: string;
  entity_type: string;
  entity_id: string;
  op: 'upsert' | 'append' | 'delete';
  client_ts: number;
  payload: unknown;
  base_rev?: number;
}

export function op(entityType: string, entityId: string, payload: unknown, kind: Op['op'] = 'upsert', baseRev?: number): Op {
  return { op_id: ulid(), device_id: 'E2E_DEVICE', entity_type: entityType, entity_id: entityId, op: kind, client_ts: Date.now(), payload, ...(baseRev !== undefined ? { base_rev: baseRev } : {}) };
}

export function inkPayload(anchor: Anchor, x: number, y: number, layerId: string | null, color = 'ink-blue') {
  return {
    kind: 'ink',
    tool: 'pen',
    anchor,
    layer: 'ink',
    z: 0,
    locked: false,
    layer_id: layerId,
    data: { v: 1, points: [[x, y, 0, 0.5], [x + 0.12, y + 0.01, 16, 0.6], [x + 0.2, y + 0.03, 32, 0.6]], style: { tool: 'pen', color, width: 0.0025 }, bbox: { x, y, w: 0.2, h: 0.03 }, pressure_available: true, tilt_available: false },
  };
}

const rt = (t: string) => ({ v: 1, paragraphs: [{ dir: 'rtl', runs: [{ t }] }] });

export function textBoxPayload(anchor: Anchor, text: string, layerId: string | null, y = 0.6) {
  return { kind: 'text', tool: 'text', anchor, layer: 'text', z: 0, locked: false, layer_id: layerId, data: { v: 1, text: rt(text), box: { x: 0.2, y, w: 0.4, h: 0.05 }, color: 'ink-blue', font_scale: 1 } };
}

export function stickyPayload(anchor: Anchor, text: string, layerId: string | null) {
  return { kind: 'sticky', tool: 'sticky', anchor, layer: 'text', z: 0, locked: false, layer_id: layerId, data: { v: 1, at: [0.8, 0.2], text, color: 'note-yellow', collapsed: false } };
}

export function notePayload(anchor: Anchor, text: string, layerId: string | null) {
  return { node_id: null, title: null, body: rt(text), anchor, origin: 'owner', layer_id: layerId };
}

/** POST /api/sync/push as a device; every op must be applied unless `expectApplied` is false. */
export async function push(m: Member, ops: Op[], expectApplied = true): Promise<SyncOpResult[]> {
  const out: SyncOpResult[] = [];
  for (let i = 0; i < ops.length; i += 200) {
    const { results } = await m.api.post<{ results: SyncOpResult[] }>('/api/sync/push', { ops: ops.slice(i, i + 200) });
    out.push(...results);
  }
  if (expectApplied) for (const r of out) expect(r.result, JSON.stringify(r)).toBe('applied');
  return out;
}

/** A layer of the member's copy (created through the sync push, as the layers panel does). */
export async function createLayer(m: Member, sourceId: string, title: string, kind: 'explanation' | 'personal' = 'explanation'): Promise<string> {
  const id = ulid();
  await push(m, [op('annotation_layer', id, { document_key: `source:${sourceId}`, kind, title })]);
  return id;
}

/** Live items of the member's copy of a source (all versions), annotations and notes. */
export async function itemsOf(m: Member, sourceId: string, versionId?: string): Promise<{ annotations: AnnotationDTO[]; notes: NoteDTO[] }> {
  const r = await m.api.get<SourceAnnotationsResponse>(`/api/annotations/source/${sourceId}${versionId ? `?version_id=${versionId}` : ''}`);
  return { annotations: r.annotations.filter((a) => a.deleted_at == null), notes: r.notes.filter((n) => n.deleted_at == null) };
}

/** A stable fingerprint of the items of some layers (null = the document's «ملاحظاتي»): ids, revisions and data. */
export function layerFingerprint(items: { annotations: AnnotationDTO[]; notes: NoteDTO[] }, layerIds: Array<string | null>, defaultLayerId?: string): string {
  const inLayer = (l: string | null | undefined) => layerIds.includes(l ?? null) || (defaultLayerId !== undefined && l === defaultLayerId && layerIds.includes(null));
  const a = items.annotations.filter((x) => inLayer(x.layer_id)).map((x) => ({ id: x.id, rev: x.rev, data: x.data, anchor: x.anchor })).sort((p, q) => p.id.localeCompare(q.id));
  const n = items.notes.filter((x) => inLayer((x as NoteDTO & { layer_id?: string | null }).layer_id)).map((x) => ({ id: x.id, rev: x.rev, body: x.body, anchor: x.anchor })).sort((p, q) => p.id.localeCompare(q.id));
  return JSON.stringify({ a, n });
}

export async function publishApi(w: AosWorld, m: Member, layerIds: string[], title: string): Promise<PublicationView> {
  return m.api.post<PublicationView>(w.S('/publications'), { lecture_id: w.lecture.id, layer_ids: layerIds, title, kind: 'explanation', visibility: 'course' }, { 'idempotency-key': ulid() });
}

/** Wait until the page's outbox (the signed-in account's own IndexedDB `medlevo:<userId>`) has no pending op. */
export async function waitForOutbox(page: Page, userId: string, timeout = 60_000): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          (name) =>
            new Promise<number>((resolve) => {
              const open = indexedDB.open(name);
              open.onerror = () => resolve(-1);
              open.onsuccess = () => {
                const db = open.result;
                if (!db.objectStoreNames.contains('outbox')) {
                  db.close();
                  resolve(0);
                  return;
                }
                const req = db.transaction('outbox', 'readonly').objectStore('outbox').getAll();
                req.onsuccess = () => {
                  resolve((req.result as Array<{ status: string }>).filter((o) => o.status === 'pending').length);
                  db.close();
                };
                req.onerror = () => resolve(-1);
              };
            }),
          `medlevo:${userId}`,
        ),
      { timeout, message: 'the outbox drains' },
    )
    .toBe(0);
}

/**
 * Poll a condition through the API (jobs and notification fan-outs run in the server's workers). An error answer counts
 * as «not yet» (e.g. the new version is not in the vault before its fan-out job ran) until the deadline.
 */
export async function eventually<T>(fn: () => Promise<T>, ok: (v: T) => boolean, what: string, timeout = 60_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    let last: unknown;
    try {
      const v = await fn();
      if (ok(v)) return v;
      last = v;
    } catch (e) {
      last = e instanceof Error ? e.message : e;
    }
    if (Date.now() > deadline) throw new Error(`timed out: ${what} — last value ${JSON.stringify(last ?? null).slice(0, 600)}`);
    await sleep(500);
  }
}
