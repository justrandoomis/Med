// «ابدأ الدراسة» — study copies in the user's OWN vault (P1-T5 step 2; ARCHITECTURE_DELTA §6.5, §7.5; contract
// packages/shared/src/academic/copies-api.ts; PRD AOS-2.17–2.19, 4.1, Q35).
//
//  * POST /api/copies creates (or reopens) a PERSONAL copy: the stub of the official lecture's head version (stubs.ts),
//    the document's personal layer «ملاحظاتي», and a `document_copy` row. Idempotent by the client id (same id + same
//    body → the same copy, 200; same id + another body → 409); «ابدأ الدراسة» twice — with any id — reopens the copy
//    that exists. Forks and followed copies of a course-only publication (step 3) are created by following.ts.
//  * Who may: an approved member (or a role) of the subject, for a PUBLISHED lecture. Anybody else — a non-member, a
//    pending member, a moderator of another subject, a draft or an unknown id — gets the body of a missing item.
//  * Every change refreshes the user's `lecture_copy` rows (system, counts only) so jobs find the holders.
import { createHash } from 'node:crypto';
import {
  defaultPersonalLayerId,
  LECTURE_WITHDRAW_REASON_LABELS_AR,
  sourceDocumentKey,
  type CopyOfficialState,
  type DocumentCopiesResponse,
  type DocumentCopyView,
  type PatchDocumentCopyRequest,
  type StartStudyingRequest,
  type StartStudyingResponse,
} from '@medlevo/shared';
import type { AppContext } from '../../context';
import { AppError } from '../../lib/errors';
import type { Viewer } from '../../system/binding';
import { publicDirectory } from '../../system/directory';
import { DEFAULT_LAYER_TITLE_AR } from '../annotations/layers';
import { personalLayerFor, publicationOfCopy, startFromPublication } from './following';
import { forksSystem } from './system';
import { ensureStub, openableLecture, personalItemsByVersion, publishedVersions, recordStubFiles, spaceDb, spaceLecture, stubOf, type SpaceLectureRow } from './stubs';

export const NOT_FOUND_AR = 'العنصر غير موجود.';
export const notFound = () => new AppError('NOT_FOUND', NOT_FOUND_AR, 404);

const DEFAULT_LAYER_SORT = -1e9;
const CARRY_PERSONAL_AR = 'نقل ملاحظاتك من نسخة أخرى يكون عند بدء نسخة من شرح منشور (متابَعة أو مستقلة).';

export interface CopyRow {
  id: string;
  source_id: string;
  origin_space_id: string | null;
  origin_lecture_id: string | null;
  mode: DocumentCopyView['mode'];
  publication_id: string | null;
  applied_version_no: number | null;
  pending_version_no: number | null;
  update_policy: 'preview' | 'auto';
  reanchor_policy: 'preview' | 'auto';
  personal_layer_id: string;
  copied_layer_id: string | null;
  collab_doc_ref: string | null;
  client_body_hash: string | null;
  created_device_id: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

const bodyHash = (b: unknown) => createHash('sha256').update(JSON.stringify(b)).digest('hex');

/** Gate-2 access of the viewer to the subject of a space (null: not a member — the caller answers «not found»). */
export function memberOf(ctx: AppContext, viewer: Viewer, spaceId: string): { subjectNodeId: string; moderator: boolean } | null {
  const m = ctx.authz.memberships.accessToSpace(viewer, spaceId);
  if (!m || m.pending) return null;
  return { subjectNodeId: m.subjectNodeId, moderator: m.access === 'moderator' };
}

/** The personal layer «ملاحظاتي» of a document, materialised (document_copy references it). */
export function ensurePersonalLayer(ctx: AppContext, sourceId: string, deviceId: string | null): string {
  const documentKey = sourceDocumentKey(sourceId);
  const id = defaultPersonalLayerId(documentKey);
  const now = ctx.clock.now();
  const r = ctx.db.run(
    `INSERT INTO annotation_layer (id, document_key, kind, title, owner_user_id, writable, frozen, origin_json, visible, locked, color, sort_order, rev, device_id, created_at, updated_at, deleted_at)
     VALUES (?, ?, 'personal', ?, NULL, 1, 0, NULL, 1, 0, NULL, ?, 1, ?, ?, ?, NULL) ON CONFLICT(id) DO NOTHING`,
    [id, documentKey, DEFAULT_LAYER_TITLE_AR, DEFAULT_LAYER_SORT, deviceId, now, now],
  );
  if (r.changes > 0) ctx.sync.touch('annotation_layer', id);
  return id;
}

export function getCopy(ctx: AppContext, id: string): CopyRow | null {
  return ctx.db.get<CopyRow>('SELECT * FROM document_copy WHERE id = ?', [id]) ?? null;
}

/** Refresh the user's `lecture_copy` rows for the stub of `sourceId` (counts of personal items per held version). */
export function refreshHoldings(ctx: AppContext, userId: string, sourceId: string): void {
  const src = ctx.db.get<{ origin_space_id: string | null; origin_lecture_id: string | null; is_stub: number; deleted_at: number | null }>(
    'SELECT origin_space_id, origin_lecture_id, is_stub, deleted_at FROM source WHERE id = ?',
    [sourceId],
  );
  if (!src || src.is_stub !== 1 || !src.origin_space_id || !src.origin_lecture_id) return;
  const counts = personalItemsByVersion(ctx, sourceId);
  forksSystem(ctx).setHoldings(
    userId,
    src.origin_space_id,
    src.origin_lecture_id,
    [...counts].map(([version_id, personal_items]) => ({ version_id, personal_items })),
  );
}

/** The user who owns the bound vault (requests: the viewer; jobs: the registry). */
export function vaultUser(ctx: AppContext): string | null {
  const b = ctx.binding.current() ?? ctx.binding.harnessDefault();
  if (!b || b.kind !== 'vault') return null;
  return b.viewer?.userId ?? forksSystem(ctx).userOfVault(b.vaultId);
}

export class CopiesService {
  constructor(private readonly ctx: AppContext) {}

  // ───────── «ابدأ الدراسة» ─────────

  start(viewer: Viewer, body: StartStudyingRequest, deviceId: string | null): StartStudyingResponse {
    const { ctx } = this;
    // P1-T5 step 3: a fork or a followed copy of a published explanation
    if (body.mode !== 'personal') return startFromPublication(ctx, viewer, body, deviceId, (row) => this.view(viewer, row));
    const hash = bodyHash({ space_id: body.space_id, lecture_id: body.lecture_id, mode: body.mode, publication_id: body.publication_id ?? null, version_no: body.version_no ?? null });
    const replay = getCopy(ctx, body.id);
    if (replay) {
      if (replay.client_body_hash !== hash) throw new AppError('CONFLICT', 'هذا المعرّف مستخدم لنسخة أخرى؛ لم يتغير شيء.', 409);
      // a replay after a lost response: the first attempt may have stopped before the system index was written
      refreshHoldings(ctx, viewer.userId, replay.source_id);
      return { copy: this.view(viewer, replay), created: false, job_id: null };
    }
    // membership and the lecture first: a stranger learns nothing (same body as a missing lecture)
    const member = memberOf(ctx, viewer, body.space_id);
    if (!member) throw notFound();
    const space = spaceDb(ctx, body.space_id);
    if (!space) throw notFound();
    const lecture = openableLecture(space, body.lecture_id);
    if (!lecture) {
      // a withdrawn lecture the user already studies reopens their copy; nothing new is created for it
      const held = stubOf(ctx, body.space_id, body.lecture_id);
      const existing = held ? ctx.db.get<CopyRow>(`SELECT * FROM document_copy WHERE source_id = ? AND mode = 'personal' AND deleted_at IS NULL`, [held.id]) : undefined;
      if (existing) return { copy: this.view(viewer, existing), created: false, job_id: null };
      throw notFound();
    }
    if (body.carry_personal_from_copy_id) throw new AppError('VALIDATION_FAILED', CARRY_PERSONAL_AR, 400);

    const subjectTitle = publicDirectory(ctx.system).spaceTitle(viewer, body.space_id) ?? '';
    const stub = ensureStub(ctx, { spaceId: body.space_id, lectureId: lecture.id, versionIds: [lecture.head_version_id!], folderId: body.library_folder_id ?? null, subjectTitle });
    recordStubFiles(ctx, stub);
    const now = ctx.clock.now();
    const result = ctx.db.tx(() => {
      const open = ctx.db.get<CopyRow>(`SELECT * FROM document_copy WHERE source_id = ? AND mode = 'personal' AND deleted_at IS NULL`, [stub.sourceId]);
      if (open) return { row: open, created: false };
      // «ملاحظاتي» of the document, unless a fork / followed copy of this lecture already uses it (P1-T5 step 3)
      const layerId = personalLayerFor(ctx, stub.sourceId, body.id, 'نسختي', deviceId);
      ctx.db.run(
        `INSERT INTO document_copy (id, source_id, origin_space_id, origin_lecture_id, mode, publication_id, applied_version_no, pending_version_no, update_policy, reanchor_policy,
                                    personal_layer_id, copied_layer_id, collab_doc_ref, client_body_hash, created_device_id, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, 'personal', NULL, NULL, NULL, 'preview', 'preview', ?, NULL, NULL, ?, ?, ?, ?, NULL)`,
        [body.id, stub.sourceId, body.space_id, lecture.id, layerId, hash, deviceId, now, now],
      );
      ctx.audit.record({ entityType: 'document_copy', entityId: body.id, action: 'create', summary: `بدء دراسة «${lecture.title}» (نسخة شخصية)`, after: { source_id: stub.sourceId, lecture_id: lecture.id } });
      return { row: getCopy(ctx, body.id)!, created: true };
    });
    refreshHoldings(ctx, viewer.userId, stub.sourceId);
    return { copy: this.view(viewer, result.row), created: result.created, job_id: null };
  }

  // ───────── reads ─────────

  list(viewer: Viewer, q: { source_id?: string; space_id?: string; lecture_id?: string }): DocumentCopiesResponse {
    const where = ['deleted_at IS NULL'];
    const params: string[] = [];
    if (q.source_id) {
      where.push('source_id = ?');
      params.push(q.source_id);
    }
    if (q.space_id) {
      where.push('origin_space_id = ?');
      params.push(q.space_id);
    }
    if (q.lecture_id) {
      where.push('origin_lecture_id = ?');
      params.push(q.lecture_id);
    }
    const rows = this.ctx.db.all<CopyRow>(`SELECT * FROM document_copy WHERE ${where.join(' AND ')} ORDER BY updated_at DESC, id LIMIT 500`, params);
    return { copies: rows.map((r) => this.view(viewer, r)) };
  }

  get(viewer: Viewer, id: string): DocumentCopyView {
    const row = getCopy(this.ctx, id);
    if (!row || row.deleted_at !== null) throw notFound();
    // opening a copy refreshes what the jobs know about it (counts only)
    refreshHoldings(this.ctx, viewer.userId, row.source_id);
    return this.view(viewer, row);
  }

  patch(viewer: Viewer, id: string, body: PatchDocumentCopyRequest): DocumentCopyView {
    const { ctx } = this;
    const row = getCopy(ctx, id);
    if (!row || row.deleted_at !== null) throw notFound();
    const now = ctx.clock.now();
    ctx.db.run('UPDATE document_copy SET update_policy = COALESCE(?, update_policy), reanchor_policy = COALESCE(?, reanchor_policy), updated_at = ? WHERE id = ?', [
      body.update_policy ?? null,
      body.reanchor_policy ?? null,
      now,
      id,
    ]);
    return this.view(viewer, getCopy(ctx, id)!);
  }

  // ───────── the view ─────────

  view(viewer: Viewer, row: CopyRow): DocumentCopyView {
    const { ctx } = this;
    const src = ctx.db.get<{ title: string; current_version_id: string | null }>('SELECT title, current_version_id FROM source WHERE id = ?', [row.source_id]);
    const current = src?.current_version_id ? ctx.db.get<{ id: string; version_no: number }>('SELECT id, version_no FROM source_version WHERE id = ?', [src.current_version_id]) : undefined;
    let lecture: DocumentCopyView['lecture'] = null;
    let newer: DocumentCopyView['newer_official_version'] = null;
    let official: CopyOfficialState | null = null;
    if (row.origin_space_id && row.origin_lecture_id) {
      const member = memberOf(ctx, viewer, row.origin_space_id);
      const space = member ? spaceDb(ctx, row.origin_space_id) : null;
      const l: SpaceLectureRow | null = space ? spaceLecture(space, row.origin_lecture_id) : null;
      const subjectTitle = publicDirectory(ctx.system).spaceTitle(viewer, row.origin_space_id) ?? '';
      lecture = {
        space_id: row.origin_space_id,
        lecture_id: row.origin_lecture_id,
        subject: { id: l?.subject_node_id ?? member?.subjectNodeId ?? '', kind: 'subject', title: subjectTitle },
        title: l && l.head_version_id ? l.title : (src?.title ?? ''),
        version_id: current?.id ?? '',
        version_no: current?.version_no ?? 0,
      };
      official = officialState(ctx, l, member !== null, row.source_id);
      if (space && l && l.status === 'published' && l.head_version_id && l.head_version_id !== current?.id) {
        const head = publishedVersions(space, l).find((v) => v.id === l.head_version_id);
        if (head && (!current || head.version_no > current.version_no)) newer = { id: head.id, version_no: head.version_no };
      }
    }
    return {
      id: row.id,
      mode: row.mode,
      source_id: row.source_id,
      document_key: sourceDocumentKey(row.source_id),
      lecture,
      publication: publicationOfCopy(ctx, viewer, row),
      personal_layer_id: row.personal_layer_id,
      copied_layer_id: row.copied_layer_id,
      collab_doc_id: null,
      update_policy: row.update_policy,
      reanchor_policy: row.reanchor_policy,
      pending_version_no: row.pending_version_no,
      newer_official_version: newer,
      official,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}

/** What the copy says about its official lecture (counts, reasons — never anything of other people). */
export function officialState(ctx: AppContext, l: SpaceLectureRow | null, member: boolean, sourceId: string): CopyOfficialState {
  // the vault's own stub says it: a takedown nulled its file references (it reaches former members' vaults too, so the
  // space need not be readable to know it — review P1-T5 s2 R-I); published versions always have a file otherwise
  const fileRemoved = !!ctx.db.get(`SELECT 1 AS x FROM source_version WHERE source_id = ? AND file_id IS NULL AND original_file_id IS NULL LIMIT 1`, [sourceId]);
  if (!member) {
    return {
      status: 'unavailable',
      withdrawn: null,
      file_removed: fileRemoved,
      note_ar: fileRemoved
        ? 'لم تعد عضوًا في هذه المادة، وأُزيل ملف المحاضرة بطلب صاحب الحقوق؛ بقيت ملاحظاتك وكتابتك في مكتبتك على صفحات فارغة.'
        : 'لم تعد عضوًا في هذه المادة؛ نسختك وملاحظاتك باقية في مكتبتك، ولا تصلك إصدارات جديدة منها.',
    };
  }
  if (!l || !l.head_version_id) return { status: 'unavailable', withdrawn: null, file_removed: fileRemoved, note_ar: 'المحاضرة الرسمية لم تعد متاحة في المادة؛ نسختك وملاحظاتك باقية.' };
  if (l.status === 'withdrawn' && l.withdrawn_reason) {
    const reason = LECTURE_WITHDRAW_REASON_LABELS_AR[l.withdrawn_reason];
    return {
      status: 'withdrawn',
      withdrawn: { reason: l.withdrawn_reason, note_ar: l.withdrawn_note ?? '', at: l.withdrawn_at ?? 0 },
      file_removed: l.takedown_at !== null,
      note_ar:
        l.takedown_at !== null
          ? `سُحبت المحاضرة (${reason})، وأُزيل ملفها من كل النسخ؛ بقيت ملاحظاتك وكتابتك على صفحات فارغة تحمل السبب.`
          : `سُحبت المحاضرة (${reason}). نسختك وملاحظاتك باقية كما هي.`,
    };
  }
  return { status: 'published', withdrawn: null, file_removed: false, note_ar: null };
}
