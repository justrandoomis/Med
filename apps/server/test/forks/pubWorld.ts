// P1-T5 step 3 test world — course-only publications with P1-T4's REAL channels (moderation, notifications and the
// subject's moderators need the channel tree): university → subject «Anatomy» (+ «Physiology» for the other-subject
// cases), an official lecture published by سارة, and the PRD §8 people:
//   hasan    — student who publishes            zainab — student who follows        ali  — forks       huda — auto
//   noor     — skips                            reem   — variant (d): «نسختي» first   sara — Subject Moderator
//   mustafa  — Assistant (moderates, no official powers)                              ahmad — signed in, member of nothing
//   physio   — a student of the OTHER subject   modB   — Subject Moderator of the other subject
// Every file and every stroke is a TEST FIXTURE generated here.
import { expect } from 'vitest';
import { createHash } from 'node:crypto';
import type { ChannelNodeView, DocumentCopyView, OfficialLectureView, PublicationView, StartStudyingResponse, SyncOp, SyncOpResult, UploadOfficialVersionResponse } from '@medlevo/shared';
import { defaultPersonalLayerId, sourceDocumentKey, stableStringify } from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import { notificationsOf } from '../../src/modules/notifications/service';
import { inkData, rt } from '../annotations/helpers';
import { assignRole, call, createCode, createNode, ok, person, type Person } from '../channels/helpers';
import type { TestApp } from '../helpers/app';
import { lecturePdf, multipart, pagesFor } from '../lectures/world';
import { createProcessingApp } from '../processing/helpers';

export const PEOPLE = ['hasan', 'zainab', 'ali', 'huda', 'noor', 'reem', 'sara', 'mustafa', 'ahmad', 'physio', 'modB'] as const;
export type Who = (typeof PEOPLE)[number];

export interface PubWorld {
  t: TestApp;
  p: Record<Who, Person>;
  subject: ChannelNodeView;
  other: ChannelNodeView;
  space: string;
  otherSpace: string;
  lecture: { id: string; sourceId: string; versionId: string; pageIds: string[] };
  S(rest: string): string;
  close(): Promise<void>;
}

export async function createPubWorld(pages = 6): Promise<PubWorld> {
  const t = await createProcessingApp();
  const pa = await t.login();
  const uni = await createNode(t, pa, null, 'university', 'جامعة تجريبية');
  const subject = await createNode(t, pa, uni.id, 'subject', 'Anatomy', { join_policy: 'open_with_code' });
  const other = await createNode(t, pa, uni.id, 'subject', 'Physiology', { join_policy: 'open_with_code' });
  const p = {} as Record<Who, Person>;
  for (const w of PEOPLE) p[w] = await person(t, `pw_${w}`);
  await assignRole(t, pa, subject.id, p.sara.user.id, 'subject_moderator');
  await assignRole(t, pa, subject.id, p.mustafa.user.id, 'assistant');
  await assignRole(t, pa, other.id, p.modB.user.id, 'subject_moderator');
  const code = (await createCode(t, pa, subject.id, { requires_approval: false })).code!;
  for (const w of ['hasan', 'zainab', 'ali', 'huda', 'noor', 'reem'] as const) ok(await call(t, p[w].h, 'POST', '/api/channels/join', { code }));
  const codeB = (await createCode(t, pa, other.id, { requires_approval: false })).code!;
  ok(await call(t, p.physio.h, 'POST', '/api/channels/join', { code: codeB }));

  const space = subject.space_id!;
  const S = (rest: string) => `/api/spaces/${space}${rest}`;
  const l = ok<OfficialLectureView>(await call(t, p.sara.h, 'POST', S('/lectures'), { title: 'Lecture 5 — Anatomy of the Abdomen', lecture_no: 5 }));
  const mp = multipart({}, { name: 'lecture5.pdf', data: lecturePdf(pagesFor('Lecture 5', pages)) });
  const up = await t.app.inject({ method: 'POST', url: S(`/lectures/${l.id}/upload`), headers: { ...p.sara.h, 'content-type': mp.contentType }, payload: mp.body });
  expect(up.statusCode, up.body).toBe(200);
  const v = up.json() as UploadOfficialVersionResponse;
  await t.ctx.jobs.drain();
  ok(await call(t, p.sara.h, 'POST', S(`/lectures/${l.id}/versions/${v.version_id}/publish`), {}));
  await t.ctx.jobs.drain();
  const db = t.ctx.dbs.space(space);
  const sourceId = db.get<{ source_id: string }>('SELECT source_id FROM official_lecture WHERE id = ?', [l.id])!.source_id;
  const pageIds = db.all<{ id: string }>('SELECT id FROM source_page WHERE version_id = ? ORDER BY page_index', [v.version_id]).map((r) => r.id);
  return { t, p, subject, other, space, otherSpace: other.space_id!, lecture: { id: l.id, sourceId, versionId: v.version_id, pageIds }, S, close: () => t.close() };
}

export function vaultOf(w: PubWorld, who: Who): string {
  return w.t.ctx.system.vaults.ofUserInternal(w.p[who].user.id)!.id;
}

/** Run `fn` with a person's vault bound (direct row assertions). */
export function inVault<T>(w: PubWorld, who: Who, fn: () => T): T {
  return w.t.ctx.binding.run({ kind: 'vault', vaultId: vaultOf(w, who), viewer: null }, fn);
}

export async function startPersonal(w: PubWorld, who: Who): Promise<DocumentCopyView> {
  return ok<StartStudyingResponse>(await call(w.t, w.p[who].h, 'POST', '/api/copies', { id: newId(), space_id: w.space, lecture_id: w.lecture.id, mode: 'personal' })).copy;
}

let n = 0;
export function op(o: Partial<SyncOp> & Pick<SyncOp, 'entity_type' | 'entity_id'>): SyncOp {
  n++;
  return { op_id: `${newId()}${String(n).padStart(4, '0').slice(-4)}`, device_id: 'DEVICE_P', op: 'upsert', payload: {}, client_ts: Date.now(), ...o };
}

export async function push(w: PubWorld, who: Who, ops: SyncOp[]): Promise<SyncOpResult[]> {
  const res = await call(w.t, w.p[who].h, 'POST', '/api/sync/push', { ops });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().results as SyncOpResult[];
}

export function pageAnchor(w: PubWorld, pageIndex: number, versionId = w.lecture.versionId, pageIds = w.lecture.pageIds) {
  return { type: 'page' as const, source_id: w.lecture.sourceId, version_id: versionId, page_id: pageIds[pageIndex]!, page_index: pageIndex, space: 'page_norm' as const };
}

/** A layer of `kind` on the stub document of the lecture in the person's vault (created through the sync push). */
export async function createLayer(w: PubWorld, who: Who, title: string, kind: 'explanation' | 'personal' = 'explanation'): Promise<string> {
  const id = newId();
  const [r] = await push(w, who, [op({ entity_type: 'annotation_layer', entity_id: id, payload: { document_key: sourceDocumentKey(w.lecture.sourceId), kind, title } })]);
  expect(r!.result, JSON.stringify(r)).toBe('applied');
  return id;
}

/** `count` strokes on a page of the lecture, in a layer (null = «ملاحظاتي»). Returns their ids. */
export async function strokes(w: PubWorld, who: Who, layerId: string | null, pageIndex: number, count: number, opts: { y?: number; versionId?: string; pageIds?: string[] } = {}): Promise<string[]> {
  const ids: string[] = [];
  const ops: SyncOp[] = [];
  for (let i = 0; i < count; i++) {
    const id = newId();
    ids.push(id);
    ops.push(
      op({
        entity_type: 'annotation',
        entity_id: id,
        payload: { kind: 'ink', tool: 'pen', anchor: pageAnchor(w, pageIndex, opts.versionId, opts.pageIds), data: inkData(0.05 + (i % 8) * 0.1, ((opts.y ?? 0.2) + (Math.floor(i / 8) % 16) * 0.05) % 0.9), layer: 'ink', z: 0, locked: false, layer_id: layerId },
      }),
    );
  }
  for (let i = 0; i < ops.length; i += 500) for (const r of await push(w, who, ops.slice(i, i + 500))) expect(r.result, JSON.stringify(r)).toBe('applied');
  return ids;
}

/** A text box on a page, in a layer. */
export async function textBox(w: PubWorld, who: Who, layerId: string | null, pageIndex: number, text: string): Promise<string> {
  const id = newId();
  const [r] = await push(w, who, [
    op({
      entity_type: 'annotation',
      entity_id: id,
      payload: { kind: 'text', tool: 'text', anchor: pageAnchor(w, pageIndex), data: { v: 1, text: rt(text), box: { x: 0.2, y: 0.6, w: 0.4, h: 0.05 }, color: 'ink-blue', font_scale: 1 }, layer: 'text', z: 0, locked: false, layer_id: layerId },
    }),
  ]);
  expect(r!.result, JSON.stringify(r)).toBe('applied');
  return id;
}

/** A typed note anchored to a page, in a layer. */
export async function typedNote(w: PubWorld, who: Who, layerId: string | null, pageIndex: number, text: string): Promise<string> {
  const id = newId();
  const [r] = await push(w, who, [op({ entity_type: 'note', entity_id: id, payload: { node_id: null, title: null, body: rt(text), anchor: pageAnchor(w, pageIndex), origin: 'owner', layer_id: layerId } })]);
  expect(r!.result, JSON.stringify(r)).toBe('applied');
  return id;
}

export async function publish(w: PubWorld, who: Who, layerIds: string[], title = 'شرح حسن', extra: Record<string, unknown> = {}, headers: Record<string, string> = {}): Promise<PublicationView> {
  return ok<PublicationView>(
    await call(w.t, w.p[who].h, 'POST', w.S('/publications'), { lecture_id: w.lecture.id, layer_ids: layerIds, title, kind: 'explanation', visibility: 'course', ...extra }, headers),
  );
}

/** Live annotations + notes of a layer in a vault, as rows (null layer = the document's «ملاحظاتي»). */
export function layerRows(w: PubWorld, who: Who, layerId: string | null): Array<Record<string, unknown>> {
  return inVault(w, who, () => {
    const doc = sourceDocumentKey(w.lecture.sourceId);
    const isDefault = layerId === null || layerId === defaultPersonalLayerId(doc);
    const a = isDefault
      ? w.t.ctx.db.all<Record<string, unknown>>(`SELECT * FROM annotation WHERE layer_id IS NULL AND deleted_at IS NULL AND json_extract(anchor_json, '$.source_id') = ? ORDER BY id`, [w.lecture.sourceId])
      : w.t.ctx.db.all<Record<string, unknown>>('SELECT * FROM annotation WHERE layer_id = ? AND deleted_at IS NULL ORDER BY id', [layerId]);
    const nn = isDefault
      ? w.t.ctx.db.all<Record<string, unknown>>(`SELECT * FROM note WHERE layer_id IS NULL AND deleted_at IS NULL AND source_id = ? ORDER BY id`, [w.lecture.sourceId])
      : w.t.ctx.db.all<Record<string, unknown>>('SELECT * FROM note WHERE layer_id = ? AND deleted_at IS NULL ORDER BY id', [layerId]);
    return [...a, ...nn];
  });
}

/** sha256 over every row of a layer (byte-identical check of personal items). */
export function layerHash(w: PubWorld, who: Who, layerId: string | null): string {
  return createHash('sha256').update(stableStringify(layerRows(w, who, layerId))).digest('hex');
}

/** Run every queued job, then deliver every pending notification fan-out (P1-T4's worker). */
export async function settle(w: PubWorld): Promise<void> {
  await w.t.ctx.jobs.drain();
  await notificationsOf(w.t.ctx).fanout.drain();
}
