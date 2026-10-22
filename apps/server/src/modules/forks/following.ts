// Forks and followed copies of a published explanation, in the reader's OWN vault (P1-T5 step 3; ARCHITECTURE_DELTA
// §6.4, §6.5, §7.5; ADR-0004 §2.4; PRD AOS-2.19, 4.2, 4.3, 4.11, 4.14, 4.18, 4.20, Q25, Scenario 2).
//
//  * «ابدأ الدراسة بهذا الشرح» (POST /api/copies, mode `followed` | `independent_fork`): the stub of the lecture (with
//    the official version the explanation was written on), the copy's personal layer, and ONE copied layer:
//      followed — kind `followed`, read-only, items under the publication's STABLE ids, authored by the explainer
//                 (`author_user_id`), so an update upserts changed items, tombstones removed ones and leaves every
//                 reference to an unchanged item intact;
//      fork     — kind `forked`, writable, items under the fork's OWN ids (the reader's from now on), copied once from
//                 version k with attribution rows, never changed by the publication again.
//    The personal layer is the document's «ملاحظاتي» when no other copy of this lecture uses it; otherwise a new
//    personal layer of this copy («انقل ملاحظاتي من نسختي إليها» then copies the old copy's layer into it with P1-T2's
//    layer copy — the old copy unchanged).
//  * Updates (Q25): the default policy is `preview`: a new version waits as `pending_version_no` until «طبّق التحديث»
//    (or «تخطَّ هذا الإصدار»); `auto` applies it in the follow-sync job. Nothing an update does touches any other layer.
//  * A hidden (moderator), withdrawn (author) or author-deleted (Q14) publication stops updating: the copy keeps what
//    it had and says why. A former member of the subject keeps their copy; it no longer updates.
import {
  annotationTargetKey,
  COPY_MODE_LABELS_AR,
  defaultPersonalLayerId,
  endSentenceAr,
  hiddenByModeratorAr,
  sourceDocumentKey,
  type AnnotationAnchor,
  type ApplyUpstreamRequest,
  type ApplyUpstreamResponse,
  type DocumentCopyView,
  type StartStudyingRequest,
  type StartStudyingResponse,
  type UpstreamPreview,
} from '@medlevo/shared';
import { createHash } from 'node:crypto';
import type { AppContext } from '../../context';
import { toJson, type Db } from '../../db/db';
import { AppError } from '../../lib/errors';
import type { Viewer } from '../../system/binding';
import { publicDirectory } from '../../system/directory';
import { type PublicationResource } from '../authz/rules/publications';
import { copyLayer } from '../annotations/layerCopy';
import { writeAnnotationTarget } from '../annotations/repo';
import { getCopy, memberOf, notFound, refreshHoldings, type CopyRow } from './copies';
import { diffVersions, forkItemId, itemsAt, parseItem, upstreamPreview, versionRow, type CanonicalItem, type PublicationItemRow } from './pubItems';
import { derivedId, ensureStub, openableLecture, publishedVersions, recordStubFiles, spaceDb, stubOf } from './stubs';
import { forksSystem, publicationIndex, type PublicationRow } from './system';

const DEFAULT_LAYER_SORT = -1e9;

const AR = {
  notFollowed: 'هذه النسخة لا تتابع شرحًا؛ لا تصلها تحديثات.',
  fork: 'النسخة المستقلة تبقى على الإصدار الذي أخذتها منه؛ لا تصلها تحديثات الشرح.',
  stale: 'صدر إصدار أحدث من الشرح بعد أن فتحت التغييرات؛ راجعها من جديد قبل التطبيق. لم يتغير شيء.',
  formerMember: 'لم تعد عضوًا في هذه المادة؛ نسختك وما فيها باقيان، ولا تصلها تحديثات الشرح.',
  carrySame: 'اختر نسخة أخرى لهذه المحاضرة لتنقل منها ملاحظاتك.',
  wrongLecture: 'هذا الشرح ليس على هذه المحاضرة.',
} as const;

/** Why a copy of this publication no longer updates (null while it is active). */
export function publicationStatusNoteAr(pub: Pick<PublicationRow, 'status' | 'hidden_reason_ar'>): string | null {
  switch (pub.status) {
    case 'hidden_by_moderator':
      return `${endSentenceAr(hiddenByModeratorAr(pub.hidden_reason_ar ?? 'دون سبب مكتوب'))} ما عندك باقٍ كما هو، ولا تصل تحديثاته حتى يُعاد إظهاره.`;
    case 'withdrawn':
      return 'توقف التحديث — لم يعد الشرح منشورًا. ما عندك باقٍ كما هو.';
    case 'author_deleted':
      return 'توقف التحديث — حذف صاحب الشرح حسابه. ما عندك باقٍ كما هو.';
    default:
      return null;
  }
}

function authorDisplay(ctx: AppContext, viewer: Viewer, authorId: string): string {
  return publicDirectory(ctx.system).userRefs(viewer, [authorId]).get(authorId)?.display_name ?? 'طالب';
}

const clip = (s: string, n = 80) => (Array.from(s).length > n ? `${Array.from(s).slice(0, n - 1).join('')}…` : s);

/** What a deleted account's name becomes in the copies others keep (PRD Q14, AOS-21.44). */
export const FORMER_STUDENT_AR = 'طالب سابق';

/** The titles the server gives the layers of a fork / followed copy (one place, so a deleted author's name can be found). */
export function copyLayerTitlesAr(display: string): { followed: string; fork: string; personalFollowed: string; personalFork: string } {
  return {
    followed: clip(`شرح ${display}`),
    fork: clip(`نسخة مستقلة من شرح ${display}`),
    personalFollowed: clip(`ملاحظاتي (متابَعة شرح ${display})`),
    personalFork: clip(`ملاحظاتي (نسخة مستقلة من شرح ${display})`),
  };
}

/**
 * Review P1-T5 s3 R3-F (PRD Q14, AOS-21.44 «طالب سابق» everywhere at once): the author of `publicationId` deleted the
 * account — in the BOUND vault (a holder of a fork or followed copy), every name the server stored when the copy was
 * made becomes «طالب سابق»: the titles of the copy's server-made layers (and of its personal layer while the reader kept
 * the server's title), the layers' origin, and every attribution row naming that author (P1-T2's layer copies of his
 * items included). The content is not touched (copy, never move). Idempotent.
 */
export function eraseAuthorNameInVault(ctx: AppContext, publicationId: string, authorUserId: string): { layers: number; attributions: number } {
  const now = ctx.clock.now();
  let layers = 0;
  const after = copyLayerTitlesAr(FORMER_STUDENT_AR);
  const attributions = ctx.db.tx(() => {
    const rename = (id: string, title: string, origin: string | null) => {
      ctx.db.run('UPDATE annotation_layer SET title = ?, origin_json = ?, rev = rev + 1, updated_at = ? WHERE id = ?', [title, origin, now, id]);
      ctx.sync.touch('annotation_layer', id);
      layers++;
    };
    const copied = ctx.db.all<{ id: string; title: string; origin_json: string }>(
      `SELECT id, title, origin_json FROM annotation_layer WHERE origin_json IS NOT NULL AND json_extract(origin_json, '$.publication_id') = ? AND json_extract(origin_json, '$.author_user_id') = ?`,
      [publicationId, authorUserId],
    );
    for (const l of copied) {
      const origin = JSON.parse(l.origin_json) as Record<string, unknown>;
      const old = typeof origin.author_display === 'string' ? origin.author_display : null;
      if (old === FORMER_STUDENT_AR) continue;
      const before = old ? copyLayerTitlesAr(old) : null;
      const title = before && l.title === before.followed ? after.followed : before && l.title === before.fork ? after.fork : old && l.title.includes(old) ? l.title.split(old).join(FORMER_STUDENT_AR) : l.title;
      // what P1-T2's «انسخ الطبقة» recorded as the source of a layer copied from this one (its title)
      ctx.db.run(`UPDATE attribution SET author_display = ? WHERE entity_type = 'annotation_layer' AND author_display = ?`, [title, l.title]);
      rename(l.id, title, JSON.stringify({ ...origin, author_display: FORMER_STUDENT_AR }));
      // the copy's own personal layer, while it still has the title the server gave it
      if (before) {
        for (const p of ctx.db.all<{ id: string; title: string; origin_json: string | null }>(
          `SELECT l.id, l.title, l.origin_json FROM document_copy c JOIN annotation_layer l ON l.id = c.personal_layer_id WHERE c.publication_id = ? AND c.copied_layer_id = ?`,
          [publicationId, l.id],
        )) {
          if (p.title === before.personalFollowed) rename(p.id, after.personalFollowed, p.origin_json);
          else if (p.title === before.personalFork) rename(p.id, after.personalFork, p.origin_json);
        }
      }
    }
    return ctx.db.run('UPDATE attribution SET author_display = ? WHERE author_user_id = ? AND author_display <> ?', [FORMER_STUDENT_AR, authorUserId, FORMER_STUDENT_AR]).changes;
  });
  return { layers, attributions };
}

/** The copy's personal layer: «ملاحظاتي» if no other live copy of the document uses it, else a new personal layer. */
export function personalLayerFor(ctx: AppContext, sourceId: string, copyId: string, label: string, deviceId: string | null): string {
  const doc = sourceDocumentKey(sourceId);
  const def = defaultPersonalLayerId(doc);
  const used = ctx.db.get('SELECT 1 AS x FROM document_copy WHERE source_id = ? AND personal_layer_id = ? AND deleted_at IS NULL AND id <> ?', [sourceId, def, copyId]);
  const now = ctx.clock.now();
  if (!used) {
    const r = ctx.db.run(
      `INSERT INTO annotation_layer (id, document_key, kind, title, owner_user_id, writable, frozen, origin_json, visible, locked, color, sort_order, rev, device_id, created_at, updated_at, deleted_at)
       VALUES (?, ?, 'personal', 'ملاحظاتي', NULL, 1, 0, NULL, 1, 0, NULL, ?, 1, ?, ?, ?, NULL) ON CONFLICT(id) DO NOTHING`,
      [def, doc, DEFAULT_LAYER_SORT, deviceId, now, now],
    );
    if (r.changes > 0) ctx.sync.touch('annotation_layer', def);
    return def;
  }
  const id = derivedId('ly', copyId, 'personal');
  const sort = (ctx.db.get<{ m: number | null }>('SELECT MAX(sort_order) AS m FROM annotation_layer WHERE document_key = ? AND ABS(sort_order) < 1e9', [doc])?.m ?? 0) + 1;
  const r = ctx.db.run(
    `INSERT INTO annotation_layer (id, document_key, kind, title, owner_user_id, writable, frozen, origin_json, visible, locked, color, sort_order, rev, device_id, created_at, updated_at, deleted_at)
     VALUES (?, ?, 'personal', ?, NULL, 1, 0, NULL, 1, 0, NULL, ?, 1, ?, ?, ?, NULL) ON CONFLICT(id) DO NOTHING`,
    [id, doc, clip(`ملاحظاتي (${label})`), Math.max(1, sort), deviceId, now, now],
  );
  if (r.changes > 0) ctx.sync.touch('annotation_layer', id);
  return id;
}

interface PubContext {
  pub: PublicationRow;
  space: Db;
}

function pubFor(ctx: AppContext, spaceId: string, publicationId: string): PubContext | null {
  const pub = publicationIndex(ctx).get(publicationId);
  if (!pub || pub.space_id !== spaceId) return null;
  const space = spaceDb(ctx, spaceId);
  return space ? { pub, space } : null;
}

function pubResource(ctx: AppContext, viewer: Viewer, pub: PublicationRow): PublicationResource {
  return { type: 'publication', id: pub.id, spaceId: pub.space_id, authorUserId: pub.author_user_id, status: pub.status, viewerHoldsCopy: publicationIndex(ctx).holds(viewer.userId, pub.id) };
}

// ───────────────────────── writing items into the bound vault ─────────────────────────

interface Written {
  upserted: number;
  tombstoned: number;
}

function beforeImage(ctx: AppContext, type: 'annotation' | 'note', row: Record<string, unknown>, layerId: string, documentKey: string, action: 'followed_update' | 'delete'): void {
  ctx.db.run(
    `INSERT OR IGNORE INTO annotation_revision (entity_type, entity_id, rev, action, snapshot_json, actor_user_id, device_id, op_id, at, layer_id, document_key)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)`,
    [type, row.id as string, row.rev as number, action, JSON.stringify(row), ctx.clock.now(), layerId, documentKey],
  );
}

function noteTarget(anchor: AnnotationAnchor | null): { sourceId: string | null; key: string | null } {
  if (!anchor) return { sourceId: null, key: null };
  return { sourceId: anchor.type === 'page' ? anchor.source_id : null, key: annotationTargetKey(anchor) };
}

/** Insert or update one item in the bound vault (the stable id of a followed item, or a fork's own id). */
function upsertItem(
  ctx: AppContext,
  id: string,
  item: CanonicalItem,
  o: { layerId: string; documentKey: string; authorUserId: string | null; origin: 'follow_copy' | 'fork_copy' },
): void {
  const now = ctx.clock.now();
  if (item.t === 'annotation') {
    const existing = ctx.db.get<Record<string, unknown>>('SELECT * FROM annotation WHERE id = ?', [id]);
    if (existing) {
      beforeImage(ctx, 'annotation', existing, o.layerId, o.documentKey, 'followed_update');
      ctx.db.run(
        `UPDATE annotation SET kind = ?, tool = ?, anchor_json = ?, data_json = ?, layer = ?, z = ?, anchor_status = 'ok', deleted_at = NULL, rev = rev + 1, updated_at = ?, layer_id = ?, author_user_id = ? WHERE id = ?`,
        [item.kind, item.tool, toJson(item.anchor), toJson(item.data), item.layer, item.z, now, o.layerId, o.authorUserId, id],
      );
    } else {
      ctx.db.run(
        `INSERT INTO annotation (id, kind, tool, anchor_json, data_json, layer, z, locked, anchor_status, previous_anchor_json, input_json, device_id, rev, created_at, updated_at, deleted_at,
                                 conflict_of_id, layer_id, author_user_id, migrated_from_id, origin)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'ok', NULL, NULL, NULL, 1, ?, ?, NULL, NULL, ?, ?, NULL, ?)`,
        [id, item.kind, item.tool, toJson(item.anchor), toJson(item.data), item.layer, item.z, now, now, o.layerId, o.authorUserId, o.origin],
      );
    }
    writeAnnotationTarget(ctx.db, id, item.anchor);
    ctx.sync.touch('annotation', id);
    return;
  }
  const t = noteTarget(item.anchor);
  const existing = ctx.db.get<Record<string, unknown>>('SELECT * FROM note WHERE id = ?', [id]);
  if (existing) {
    beforeImage(ctx, 'note', existing, o.layerId, o.documentKey, 'followed_update');
    ctx.db.run(
      `UPDATE note SET title = ?, body_json = ?, anchor_json = ?, origin = ?, source_id = ?, anchor_target_key = ?, deleted_at = NULL, rev = rev + 1, updated_at = ?, layer_id = ?, author_user_id = ? WHERE id = ?`,
      [item.title, toJson(item.body), item.anchor ? toJson(item.anchor) : null, item.origin, t.sourceId, t.key, now, o.layerId, o.authorUserId, id],
    );
  } else {
    ctx.db.run(
      `INSERT INTO note (id, node_id, title, body_json, anchor_json, origin, ai_record_json, rev, base_rev, conflict_of_id, device_id, created_at, updated_at, deleted_at,
                         source_id, anchor_target_key, layer_id, author_user_id, migrated_from_id)
       VALUES (?, NULL, ?, ?, ?, ?, NULL, 1, NULL, NULL, NULL, ?, ?, NULL, ?, ?, ?, ?, NULL)`,
      [id, item.title, toJson(item.body), item.anchor ? toJson(item.anchor) : null, item.origin, now, now, t.sourceId, t.key, o.layerId, o.authorUserId],
    );
  }
  ctx.sync.touch('note', id);
}

function tombstone(ctx: AppContext, type: 'annotation' | 'note', id: string, layerId: string, documentKey: string): boolean {
  const existing = ctx.db.get<Record<string, unknown>>(`SELECT * FROM ${type} WHERE id = ? AND deleted_at IS NULL`, [id]);
  if (!existing) return false;
  beforeImage(ctx, type, existing, layerId, documentKey, 'delete');
  const now = ctx.clock.now();
  ctx.db.run(`UPDATE ${type} SET deleted_at = ?, rev = rev + 1, updated_at = ? WHERE id = ?`, [now, now, id]);
  ctx.sync.touch(type, id);
  return true;
}

function attribution(ctx: AppContext, type: 'annotation' | 'note', id: string, pub: PublicationRow, display: string, versionNo: number, itemId: string): void {
  ctx.db.run(
    `INSERT INTO attribution (entity_type, entity_id, author_user_id, author_display, derived_from_json, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(entity_type, entity_id) DO UPDATE SET derived_from_json = excluded.derived_from_json`,
    [type, id, pub.author_user_id, display, toJson([{ space_id: pub.space_id, publication_id: pub.id, version_no: versionNo, item_id: itemId }]), ctx.clock.now()],
  );
}

/** Make the followed layer equal to version `to` (from `from`): upsert added / changed, tombstone removed, nothing else. */
function applyFollowed(ctx: AppContext, copy: CopyRow, pc: PubContext, from: number, to: number, display: string): Written {
  const doc = sourceDocumentKey(copy.source_id);
  const layerId = copy.copied_layer_id!;
  const d = diffVersions(pc.space, pc.pub.id, from, to);
  let upserted = 0;
  let tombstoned = 0;
  ctx.db.tx(() => {
    for (const r of [...d.added, ...d.changed.map((c) => c.after)]) {
      const item = parseItem(r);
      upsertItem(ctx, r.item_id, item, { layerId, documentKey: doc, authorUserId: pc.pub.author_user_id, origin: 'follow_copy' });
      attribution(ctx, item.t, r.item_id, pc.pub, display, to, r.item_id);
      upserted++;
    }
    for (const r of d.removed) if (tombstone(ctx, r.entity_type === 'note' ? 'note' : 'annotation', r.item_id, layerId, doc)) tombstoned++;
    const layer = ctx.db.get<{ origin_json: string | null }>('SELECT origin_json FROM annotation_layer WHERE id = ?', [layerId]);
    const origin = { ...(layer?.origin_json ? (JSON.parse(layer.origin_json) as Record<string, unknown>) : {}), version_no: to };
    ctx.db.run('UPDATE annotation_layer SET origin_json = ?, rev = rev + 1, updated_at = ? WHERE id = ?', [toJson(origin), ctx.clock.now(), layerId]);
    ctx.sync.touch('annotation_layer', layerId);
    ctx.db.run('UPDATE document_copy SET applied_version_no = ?, pending_version_no = NULL, updated_at = ? WHERE id = ?', [to, ctx.clock.now(), copy.id]);
  });
  return { upserted, tombstoned };
}

/** The stub must hold the official version a publication version was written on (followers read its pages). */
function ensureStubFor(ctx: AppContext, spaceId: string, lectureId: string, versionIds: string[], folderId: string | null): string {
  const subjectTitle = forksSystem(ctx).spaceTitleOf(spaceId) ?? '';
  const held = stubOf(ctx, spaceId, lectureId);
  const already = held ? ctx.db.all<{ id: string }>('SELECT id FROM source_version WHERE source_id = ?', [held.id]).map((r) => r.id) : [];
  const want = [...new Set([...already, ...versionIds])];
  const space = spaceDb(ctx, spaceId);
  const published = space ? new Set(publishedVersions(space, openableLecture(space, lectureId, { allowWithdrawn: true }) ?? { id: lectureId, source_id: '' }).map((v) => v.id)) : new Set<string>();
  const r = ensureStub(ctx, { spaceId, lectureId, versionIds: want.filter((v) => published.has(v)), folderId, subjectTitle });
  recordStubFiles(ctx, r);
  return r.sourceId;
}

const bodyHash = (b: unknown) => createHash('sha256').update(JSON.stringify(b)).digest('hex');

// ───────────────────────── «ابدأ الدراسة بهذا الشرح» ─────────────────────────

export function startFromPublication(ctx: AppContext, viewer: Viewer, body: StartStudyingRequest, deviceId: string | null, view: (row: CopyRow) => DocumentCopyView): StartStudyingResponse {
  const hash = bodyHash({ space_id: body.space_id, lecture_id: body.lecture_id, mode: body.mode, publication_id: body.publication_id ?? null, version_no: body.version_no ?? null });
  const replay = getCopy(ctx, body.id);
  if (replay) {
    if (replay.client_body_hash !== hash) throw new AppError('CONFLICT', 'هذا المعرّف مستخدم لنسخة أخرى؛ لم يتغير شيء.', 409);
    refreshHoldings(ctx, viewer.userId, replay.source_id);
    return { copy: view(replay), created: false, job_id: null };
  }
  if (!memberOf(ctx, viewer, body.space_id)) throw notFound();
  const pc = pubFor(ctx, body.space_id, body.publication_id!);
  if (!pc) throw notFound();
  const { pub, space } = pc;
  ctx.authz.assert(viewer, 'view', pubResource(ctx, viewer, pub));
  if (pub.lecture_id !== body.lecture_id) throw new AppError('CONFLICT', AR.wrongLecture, 409);
  // the copy of this publication that exists (one per publication per vault) reopens
  const existing = ctx.db.get<CopyRow>('SELECT * FROM document_copy WHERE publication_id = ? AND deleted_at IS NULL', [pub.id]);
  if (existing) return { copy: view(existing), created: false, job_id: null };
  ctx.authz.assert(viewer, body.mode === 'followed' ? 'follow' : 'fork', pubResource(ctx, viewer, pub));
  const lecture = openableLecture(space, body.lecture_id);
  if (!lecture) throw notFound();
  const versionNo = body.mode === 'independent_fork' ? (body.version_no ?? pub.head_version_no) : pub.head_version_no;
  const pv = versionRow(space, pub.id, versionNo);
  if (!pv || versionNo > pub.head_version_no) throw notFound();
  let carryFrom: CopyRow | null = null;
  if (body.carry_personal_from_copy_id) {
    carryFrom = getCopy(ctx, body.carry_personal_from_copy_id);
    if (!carryFrom || carryFrom.deleted_at !== null || carryFrom.origin_lecture_id !== body.lecture_id || carryFrom.origin_space_id !== body.space_id) throw new AppError('NOT_FOUND', AR.carrySame, 404);
  }

  const sourceId = ensureStubFor(ctx, body.space_id, lecture.id, [lecture.head_version_id!, pv.lecture_version_id], body.library_folder_id ?? null);
  const display = authorDisplay(ctx, viewer, pub.author_user_id);
  const doc = sourceDocumentKey(sourceId);
  const items = [...itemsAt(space, pub.id, versionNo).values()];
  const now = ctx.clock.now();
  const followed = body.mode === 'followed';
  const label = followed ? `متابَعة شرح ${display}` : `نسخة مستقلة من شرح ${display}`;
  const titles = copyLayerTitlesAr(display);
  ctx.db.tx(() => {
    const personal = personalLayerFor(ctx, sourceId, body.id, label, deviceId);
    const copiedId = derivedId('ly', body.id, 'copied');
    const sort = (ctx.db.get<{ m: number | null }>('SELECT MAX(sort_order) AS m FROM annotation_layer WHERE document_key = ? AND ABS(sort_order) < 1e9', [doc])?.m ?? 0) + 1;
    ctx.db.run(
      `INSERT INTO annotation_layer (id, document_key, kind, title, owner_user_id, writable, frozen, origin_json, visible, locked, color, sort_order, rev, device_id, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, 1, 0, NULL, ?, 1, ?, ?, ?, NULL)`,
      [
        copiedId,
        doc,
        followed ? 'followed' : 'forked',
        followed ? titles.followed : titles.fork,
        followed ? pub.author_user_id : null,
        followed ? 0 : 1,
        toJson({ space_id: pub.space_id, publication_id: pub.id, version_no: versionNo, author_user_id: pub.author_user_id, author_display: display }),
        Math.max(1, sort),
        deviceId,
        now,
        now,
      ],
    );
    ctx.sync.touch('annotation_layer', copiedId);
    for (const r of items) {
      const item = parseItem(r);
      const itemId = followed ? r.item_id : forkItemId(body.id, r.item_id);
      upsertItem(ctx, itemId, item, { layerId: copiedId, documentKey: doc, authorUserId: followed ? pub.author_user_id : null, origin: followed ? 'follow_copy' : 'fork_copy' });
      attribution(ctx, item.t, itemId, pub, display, versionNo, r.item_id);
    }
    ctx.db.run(
      `INSERT INTO document_copy (id, source_id, origin_space_id, origin_lecture_id, mode, publication_id, applied_version_no, pending_version_no, update_policy, reanchor_policy,
                                  personal_layer_id, copied_layer_id, collab_doc_ref, client_body_hash, created_device_id, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'preview', 'preview', ?, ?, NULL, ?, ?, ?, ?, NULL)`,
      [body.id, sourceId, body.space_id, lecture.id, body.mode, pub.id, versionNo, personal, copiedId, hash, deviceId, now, now],
    );
    ctx.audit.record({
      entityType: 'document_copy',
      entityId: body.id,
      action: 'create',
      summary: `${COPY_MODE_LABELS_AR[body.mode]} من «${pub.title}» (الإصدار ${versionNo}) على «${lecture.title}»`,
      after: { source_id: sourceId, publication_id: pub.id, version_no: versionNo, items: items.length },
    });
  });
  publicationIndex(ctx).upsertCopy(viewer.userId, pub.id, followed ? 'followed' : 'independent', versionNo, null);
  if (carryFrom) {
    // «انقل ملاحظاتي من نسختي إليها»: P1-T2's layer copy (new ids, attribution to the old layer; the old copy unchanged)
    const created = getCopy(ctx, body.id)!;
    if (carryFrom.personal_layer_id !== created.personal_layer_id) {
      copyLayer(
        ctx,
        { from_layer_ids: [carryFrom.personal_layer_id], document_key: sourceDocumentKey(carryFrom.source_id), into: { layer_id: created.personal_layer_id, document_key: doc }, preview: false },
        { deviceId },
      );
    }
  }
  refreshHoldings(ctx, viewer.userId, sourceId);
  return { copy: view(getCopy(ctx, body.id)!), created: true, job_id: null };
}

// ───────────────────────── the copy's publication, updates ─────────────────────────

export function publicationOfCopy(ctx: AppContext, viewer: Viewer, row: CopyRow): DocumentCopyView['publication'] {
  if (!row.publication_id) return null;
  const pub = publicationIndex(ctx).get(row.publication_id);
  if (!pub) return null;
  const member = row.origin_space_id ? memberOf(ctx, viewer, row.origin_space_id) : null;
  const space = member && row.origin_space_id ? spaceDb(ctx, row.origin_space_id) : null;
  const builtOn = (n: number | null) => {
    if (!space || n === null) return null;
    const v = versionRow(space, pub.id, n);
    return v ? (space.get<{ version_no: number }>('SELECT version_no FROM source_version WHERE id = ?', [v.lecture_version_id])?.version_no ?? null) : null;
  };
  let note = publicationStatusNoteAr(pub);
  if (!note && row.mode === 'followed' && !member) note = AR.formerMember;
  if (!note && row.mode === 'followed' && pub.head_version_no > (row.applied_version_no ?? 0) && row.pending_version_no === null && row.update_policy === 'preview') {
    note = `بقيت نسختك على الإصدار ${row.applied_version_no} من الشرح وتخطّيت الإصدار ${pub.head_version_no}.`;
  }
  return {
    id: pub.id,
    space_id: pub.space_id,
    title: pub.title,
    author: publicDirectory(ctx.system).userRefs(viewer, [pub.author_user_id]).get(pub.author_user_id)!,
    applied_version_no: row.applied_version_no ?? 0,
    head_version_no: pub.head_version_no,
    status: pub.status,
    status_note_ar: note,
    built_on_version_no: builtOn(row.applied_version_no),
    pending_built_on_version_no: builtOn(row.pending_version_no),
  };
}

function followedCopy(ctx: AppContext, viewer: Viewer, copyId: string): { copy: CopyRow; pc: PubContext } {
  const copy = getCopy(ctx, copyId);
  if (!copy || copy.deleted_at !== null) throw notFound();
  if (copy.mode !== 'followed' || !copy.publication_id || !copy.origin_space_id) throw new AppError('CONFLICT', copy.mode === 'independent_fork' ? AR.fork : AR.notFollowed, 409);
  if (!memberOf(ctx, viewer, copy.origin_space_id)) throw new AppError('CONFLICT', AR.formerMember, 409);
  const pc = pubFor(ctx, copy.origin_space_id, copy.publication_id);
  if (!pc) throw notFound();
  return { copy, pc };
}

/** GET /api/copies/:id/upstream — what «طبّق التحديث» would change (nothing changes before the tap). */
export function upstream(ctx: AppContext, viewer: Viewer, copyId: string): UpstreamPreview {
  const { copy, pc } = followedCopy(ctx, viewer, copyId);
  const applied = copy.applied_version_no ?? 0;
  const target = pc.pub.status === 'active' && pc.pub.head_version_no > applied ? pc.pub.head_version_no : applied;
  return upstreamPreview(pc.space, pc.pub.id, applied, target);
}

/** POST /api/copies/:id/upstream/apply — «طبّق التحديث» or «تخطَّ هذا الإصدار» (idempotent; a stale version → 409). */
export function applyUpstream(ctx: AppContext, viewer: Viewer, copyId: string, body: ApplyUpstreamRequest, view: (row: CopyRow) => DocumentCopyView): ApplyUpstreamResponse {
  const { copy, pc } = followedCopy(ctx, viewer, copyId);
  const applied = copy.applied_version_no ?? 0;
  const head = pc.pub.head_version_no;
  // a replay (a lost answer, a second device): the same version already applied / skipped changes nothing
  if (body.version_no <= applied) return { copy: view(copy), skipped: !!body.skip, applied: body.skip ? null : { upserted: 0, tombstoned: 0 } };
  if (body.skip && copy.pending_version_no === null && body.version_no === head) return { copy: view(copy), skipped: true, applied: null };
  const note = publicationStatusNoteAr(pc.pub);
  if (note) throw new AppError('CONFLICT', note, 409);
  if (body.version_no !== head) throw new AppError('CONFLICT', AR.stale, 409, { head_version_no: head });
  if (body.skip) {
    ctx.db.run('UPDATE document_copy SET pending_version_no = NULL, updated_at = ? WHERE id = ?', [ctx.clock.now(), copy.id]);
    publicationIndex(ctx).upsertCopy(viewer.userId, pc.pub.id, 'followed', applied, null);
    return { copy: view(getCopy(ctx, copy.id)!), skipped: true, applied: null };
  }
  const lecture = openableLecture(pc.space, copy.origin_lecture_id!, { allowWithdrawn: true });
  const pv = versionRow(pc.space, pc.pub.id, head);
  if (lecture && pv) ensureStubFor(ctx, copy.origin_space_id!, lecture.id, [pv.lecture_version_id], null);
  const w = applyFollowed(ctx, copy, pc, applied, head, authorDisplay(ctx, viewer, pc.pub.author_user_id));
  publicationIndex(ctx).upsertCopy(viewer.userId, pc.pub.id, 'followed', head, null);
  refreshHoldings(ctx, viewer.userId, copy.source_id);
  ctx.audit.record({ entityType: 'document_copy', entityId: copy.id, action: 'apply_update', summary: `طُبّق الإصدار ${head} من «${pc.pub.title}» (عُدّل ${w.upserted}، حُذف ${w.tombstoned}؛ لم يتغير شيء من ملاحظاتك)` });
  return { copy: view(getCopy(ctx, copy.id)!), skipped: false, applied: w };
}

/**
 * The follow-sync job in ONE follower's vault: a new version waits for the preview (`pending_version_no`) or — with
 * «طبّق التحديثات تلقائيًا» — is applied at once. Idempotent: an applied or older version changes nothing.
 */
export function syncFollowedCopy(ctx: AppContext, userId: string, input: { space_id: string; publication_id: string; version_no: number }): { action: 'none' | 'pending' | 'applied' } {
  const copy = ctx.db.get<CopyRow>(`SELECT * FROM document_copy WHERE publication_id = ? AND mode = 'followed' AND deleted_at IS NULL`, [input.publication_id]);
  if (!copy || (copy.applied_version_no ?? 0) >= input.version_no) return { action: 'none' };
  const viewer: Viewer = { userId, deviceId: null, isPlatformAdmin: false };
  if (!memberOf(ctx, viewer, input.space_id)) return { action: 'none' };
  const pc = pubFor(ctx, input.space_id, input.publication_id);
  if (!pc || pc.pub.status !== 'active') return { action: 'none' };
  const target = Math.min(input.version_no, pc.pub.head_version_no);
  if (copy.update_policy === 'auto') {
    const lecture = openableLecture(pc.space, copy.origin_lecture_id!, { allowWithdrawn: true });
    const pv = versionRow(pc.space, pc.pub.id, target);
    if (lecture && pv) ensureStubFor(ctx, input.space_id, lecture.id, [pv.lecture_version_id], null);
    applyFollowed(ctx, copy, pc, copy.applied_version_no ?? 0, target, authorDisplay(ctx, viewer, pc.pub.author_user_id));
    publicationIndex(ctx).upsertCopy(userId, pc.pub.id, 'followed', target, null);
    refreshHoldings(ctx, userId, copy.source_id);
    return { action: 'applied' };
  }
  if ((copy.pending_version_no ?? 0) >= target) return { action: 'none' };
  ctx.db.run('UPDATE document_copy SET pending_version_no = ?, updated_at = ? WHERE id = ?', [target, ctx.clock.now(), copy.id]);
  publicationIndex(ctx).upsertCopy(userId, pc.pub.id, 'followed', copy.applied_version_no ?? 0, target);
  return { action: 'pending' };
}

export type { PublicationItemRow };
