// The subject's content in its space (P1-T5 step 1; ARCHITECTURE_DELTA §4.4 `3010_subject_content`, §5.3 «subject
// attachment / exam date: publish — C: d (approval)»; PRD AOS-2.5, 2.9, 18.11; IA §4.2 «الملفات», «التحديثات»):
//   * attachments — summaries, previous exams (they feed the space's question bank through the existing processing
//     follow-up), references; a contributor's upload is a draft an official moderator publishes;
//   * exam dates — a table the subject's moderators keep (create / replace / cancel by a client id, idempotent);
//   * the updates feed — `subject_event`, appended in the same transaction as each change;
//   * duplicate files — byte-identical and near-identical files of THIS subject only (AOS-18.11).
import {
  DUPLICATE_NEAR_THRESHOLD,
  type CreateSubjectAttachmentRequest,
  type CursorPage,
  type PutSubjectExamDateRequest,
  type SourceType,
  type SubjectAttachmentKind,
  type SubjectAttachmentView,
  type SubjectDuplicateGroup,
  type SubjectDuplicateItem,
  type SubjectDuplicatesResponse,
  type SubjectEventView,
  type SubjectExamDateView,
} from '@medlevo/shared';
import type { AppContext } from '../../context';
import { fromJson, toJson } from '../../db/db';
import { AppError } from '../../lib/errors';
import { newId } from '../../lib/ids';
import type { IncomingFile } from '../sources/upload';
import { createSpaceSource, ingestVersion } from './ingest';
import { appendSubjectEvent, getLecture, lectureResource, notFound, type SpaceScope, ViewBuilder, visibleLecture } from './store';

interface AttachmentRow {
  id: string;
  subject_node_id: string;
  lecture_id: string | null;
  kind: SubjectAttachmentKind;
  title: string;
  source_id: string;
  uploaded_by: string;
  status: 'draft' | 'published' | 'withdrawn';
  visibility: 'course' | 'moderators';
  approved_by: string | null;
  created_at: number;
  updated_at: number;
  withdrawn_at: number | null;
}

interface ExamDateRow {
  id: string;
  subject_node_id: string;
  title: string;
  exam_on: string;
  starts_at: string | null;
  lecture_ids_json: string;
  published_by: string;
  status: 'published' | 'changed' | 'cancelled';
  created_at: number;
  updated_at: number;
}

/** previous exams feed the subject's question bank (the processing follow-up extracts their questions) */
const SOURCE_TYPE: Record<SubjectAttachmentKind, SourceType> = { summary: 'course_reference', previous_exam: 'previous_exam', reference: 'course_reference', other: 'course_reference' };

const AR = {
  moderatorsOnly: 'هذا الإجراء لمشرف المادة فقط.',
  noFile: 'أرفق الملف مع الطلب (ملف واحد).',
  lectureIds: 'بعض المحاضرات المختارة ليست من محاضرات هذه المادة.',
};

function requireModerator(scope: SpaceScope): void {
  if (!scope.powers.officialModerator) throw new AppError('FORBIDDEN', AR.moderatorsOnly, 403);
}

// ───────────────────────────── attachments ─────────────────────────────

/** May the viewer see this attachment (and its file)? Drafts: moderators and the uploader; withdrawn: moderators. */
export function attachmentVisible(scope: SpaceScope, a: Pick<AttachmentRow, 'status' | 'visibility' | 'uploaded_by'>): boolean {
  if (scope.powers.officialModerator) return true;
  if (a.visibility === 'moderators') return false;
  if (a.status === 'published') return true;
  return a.status === 'draft' && scope.powers.contributor && a.uploaded_by === scope.viewer.userId;
}

export function attachmentBySource(ctx: AppContext, sourceId: string): AttachmentRow | null {
  return ctx.db.get<AttachmentRow>('SELECT * FROM subject_attachment WHERE source_id = ?', [sourceId]) ?? null;
}

export class SubjectService {
  constructor(private readonly ctx: AppContext) {}

  /** The lecture if THIS viewer may see it (a draft is named to nobody but its moderators and uploader — review R8). */
  private seenLecture(scope: SpaceScope, id: string) {
    const row = getLecture(this.ctx, id);
    return row && this.ctx.authz.can(scope.viewer, 'view', lectureResource(scope, row)).allowed ? row : null;
  }

  private attachmentView(views: ViewBuilder, a: AttachmentRow, scope: SpaceScope): SubjectAttachmentView {
    const { ctx } = this;
    const lecture = a.lecture_id ? this.seenLecture(scope, a.lecture_id) : null;
    const file = ctx.db.get<{ id: string; original_name: string | null; mime: string; size: number }>(
      `SELECT f.id, f.original_name, f.mime, f.size FROM source s JOIN source_version v ON v.id = s.current_version_id
         JOIN stored_file f ON f.id = COALESCE(v.file_id, v.original_file_id) WHERE s.id = ?`,
      [a.source_id],
    );
    return {
      id: a.id,
      kind: a.kind,
      title: a.title,
      lecture: lecture ? { id: lecture.id, title: lecture.title } : null,
      status: a.status,
      visibility: a.visibility,
      uploaded_by: views.user(a.uploaded_by),
      source_id: a.source_id,
      file: file ? { file_id: file.id, name: file.original_name, mime: file.mime, size: file.size } : null,
      created_at: a.created_at,
      updated_at: a.updated_at,
    };
  }

  listAttachments(scope: SpaceScope): SubjectAttachmentView[] {
    const rows = this.ctx.db.all<AttachmentRow>('SELECT * FROM subject_attachment ORDER BY created_at DESC, id DESC').filter((a) => attachmentVisible(scope, a));
    const views = new ViewBuilder(this.ctx, scope);
    views.preload(rows.map((r) => r.uploaded_by));
    return rows.map((r) => this.attachmentView(views, r, scope));
  }

  async createAttachment(scope: SpaceScope, body: Omit<CreateSubjectAttachmentRequest, 'upload_id'>, file: IncomingFile | null): Promise<SubjectAttachmentView> {
    const { ctx } = this;
    ctx.authz.assert(scope.viewer, 'publish', { type: 'space', id: scope.spaceId });
    if (!file) throw new AppError('BAD_REQUEST', AR.noFile, 400);
    if (body.lecture_id) visibleLecture(ctx, scope, body.lecture_id); // one of THIS subject's lectures the uploader can see
    const byModerator = scope.powers.officialModerator;
    const id = newId(ctx.clock.now());
    const sourceId = ctx.db.tx(() => createSpaceSource(ctx, { title: body.title, sourceType: SOURCE_TYPE[body.kind] }));
    try {
      await ingestVersion(ctx, file, {
        sourceId,
        stillWritable: () => undefined,
        register: (versionId) => {
          const now = ctx.clock.now();
          ctx.db.run('UPDATE source SET current_version_id = ? WHERE id = ?', [versionId, sourceId]);
          ctx.db.run(
            `INSERT INTO subject_attachment (id, subject_node_id, lecture_id, kind, title, source_id, uploaded_by, status, visibility, approved_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'course', ?, ?, ?)`,
            [id, scope.subjectNodeId, body.lecture_id ?? null, body.kind, body.title, sourceId, scope.viewer.userId, byModerator ? 'published' : 'draft', byModerator ? scope.viewer.userId : null, now, now],
          );
          if (byModerator) appendSubjectEvent(ctx, { subjectNodeId: scope.subjectNodeId, kind: 'attachment_published', refType: 'subject_attachment', refId: id, title: `ملف جديد: ${body.title}` });
          ctx.audit.record({ entityType: 'subject_attachment', entityId: id, action: 'create', summary: `ملف «${body.title}»`, after: { kind: body.kind, status: byModerator ? 'published' : 'draft' } });
        },
      });
    } catch (e) {
      // the empty source of a refused file goes with it (nothing references it yet)
      ctx.db.run('DELETE FROM source WHERE id = ? AND NOT EXISTS (SELECT 1 FROM source_version WHERE source_id = ?)', [sourceId, sourceId]);
      throw e;
    }
    const views = new ViewBuilder(ctx, scope);
    return this.attachmentView(views, ctx.db.get<AttachmentRow>('SELECT * FROM subject_attachment WHERE id = ?', [id])!, scope);
  }

  patchAttachment(scope: SpaceScope, id: string, status: 'published' | 'withdrawn'): SubjectAttachmentView {
    const { ctx } = this;
    const a = ctx.db.get<AttachmentRow>('SELECT * FROM subject_attachment WHERE id = ?', [id]);
    if (!a || !attachmentVisible(scope, a)) throw notFound();
    ctx.authz.assert(scope.viewer, 'publish', { type: 'space', id: scope.spaceId });
    requireModerator(scope);
    if (a.status !== status) {
      const now = ctx.clock.now();
      ctx.db.tx(() => {
        ctx.db.run(
          `UPDATE subject_attachment SET status = ?, approved_by = CASE WHEN ? = 'published' THEN ? ELSE approved_by END,
             withdrawn_at = CASE WHEN ? = 'withdrawn' THEN ? ELSE NULL END, updated_at = ? WHERE id = ?`,
          [status, status, scope.viewer.userId, status, now, now, id],
        );
        if (status === 'published') appendSubjectEvent(ctx, { subjectNodeId: a.subject_node_id, kind: 'attachment_published', refType: 'subject_attachment', refId: id, title: `ملف جديد: ${a.title}`, moderatorsOnly: a.visibility === 'moderators' });
        ctx.audit.record({ entityType: 'subject_attachment', entityId: id, action: status === 'published' ? 'publish' : 'withdraw', summary: `${status === 'published' ? 'نشر' : 'سحب'} «${a.title}»` });
      });
    }
    const views = new ViewBuilder(ctx, scope);
    return this.attachmentView(views, ctx.db.get<AttachmentRow>('SELECT * FROM subject_attachment WHERE id = ?', [id])!, scope);
  }

  // ───────────────────────────── exam dates ─────────────────────────────

  private examView(views: ViewBuilder, r: ExamDateRow, scope: SpaceScope): SubjectExamDateView {
    return {
      id: r.id,
      title: r.title,
      exam_on: r.exam_on,
      starts_at: r.starts_at,
      // only lectures this viewer may see: a draft the moderator already listed stays unnamed to students (review R8)
      lecture_ids: (fromJson<string[]>(r.lecture_ids_json) ?? []).filter((id) => this.seenLecture(scope, id) !== null),
      status: r.status,
      published_by: views.user(r.published_by),
      updated_at: r.updated_at,
    };
  }

  listExamDates(scope: SpaceScope): SubjectExamDateView[] {
    const rows = this.ctx.db.all<ExamDateRow>('SELECT * FROM subject_exam_date ORDER BY exam_on, starts_at, id');
    const views = new ViewBuilder(this.ctx, scope);
    views.preload(rows.map((r) => r.published_by));
    return rows.map((r) => this.examView(views, r, scope));
  }

  putExamDate(scope: SpaceScope, id: string, body: PutSubjectExamDateRequest): SubjectExamDateView {
    const { ctx } = this;
    ctx.authz.assert(scope.viewer, 'publish', { type: 'space', id: scope.spaceId });
    requireModerator(scope);
    const lectureIds = [...new Set(body.lecture_ids ?? [])];
    for (const lid of lectureIds) {
      if (!getLecture(ctx, lid)) throw new AppError('VALIDATION_FAILED', AR.lectureIds, 400, { where: 'body', issues: [{ path: 'lecture_ids', code: 'invalid', message: AR.lectureIds }] });
    }
    const next = { title: body.title, exam_on: body.exam_on, starts_at: body.starts_at ?? null, lecture_ids_json: toJson(lectureIds) };
    const now = ctx.clock.now();
    ctx.db.tx(() => {
      const cur = ctx.db.get<ExamDateRow>('SELECT * FROM subject_exam_date WHERE id = ?', [id]);
      const when = `${next.exam_on}${next.starts_at ? ` ${next.starts_at}` : ''}`;
      if (!cur) {
        ctx.db.run(
          `INSERT INTO subject_exam_date (id, subject_node_id, title, exam_on, starts_at, lecture_ids_json, published_by, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'published', ?, ?)`,
          [id, scope.subjectNodeId, next.title, next.exam_on, next.starts_at, next.lecture_ids_json, scope.viewer.userId, now, now],
        );
        appendSubjectEvent(ctx, { subjectNodeId: scope.subjectNodeId, kind: 'exam_date_published', refType: 'subject_exam_date', refId: id, title: `موعد امتحان: ${next.title} — ${when}` });
        return;
      }
      const same = cur.title === next.title && cur.exam_on === next.exam_on && cur.starts_at === next.starts_at && cur.lecture_ids_json === next.lecture_ids_json && cur.status !== 'cancelled';
      if (same) return; // a replay of the same body changes nothing (no second update)
      ctx.db.run(`UPDATE subject_exam_date SET title = ?, exam_on = ?, starts_at = ?, lecture_ids_json = ?, published_by = ?, status = 'changed', updated_at = ? WHERE id = ?`, [
        next.title,
        next.exam_on,
        next.starts_at,
        next.lecture_ids_json,
        scope.viewer.userId,
        now,
        id,
      ]);
      appendSubjectEvent(ctx, { subjectNodeId: cur.subject_node_id, kind: 'exam_date_changed', refType: 'subject_exam_date', refId: id, title: `تغيّر موعد: ${next.title} — ${when}` });
    });
    const views = new ViewBuilder(ctx, scope);
    return this.examView(views, ctx.db.get<ExamDateRow>('SELECT * FROM subject_exam_date WHERE id = ?', [id])!, scope);
  }

  cancelExamDate(scope: SpaceScope, id: string): SubjectExamDateView {
    const { ctx } = this;
    ctx.authz.assert(scope.viewer, 'publish', { type: 'space', id: scope.spaceId });
    requireModerator(scope);
    const cur = ctx.db.get<ExamDateRow>('SELECT * FROM subject_exam_date WHERE id = ?', [id]);
    if (!cur) throw notFound();
    if (cur.status !== 'cancelled') {
      const now = ctx.clock.now();
      ctx.db.tx(() => {
        ctx.db.run(`UPDATE subject_exam_date SET status = 'cancelled', updated_at = ? WHERE id = ?`, [now, id]);
        appendSubjectEvent(ctx, { subjectNodeId: cur.subject_node_id, kind: 'exam_date_changed', refType: 'subject_exam_date', refId: id, title: `أُلغي موعد: ${cur.title}` });
      });
    }
    const views = new ViewBuilder(ctx, scope);
    return this.examView(views, ctx.db.get<ExamDateRow>('SELECT * FROM subject_exam_date WHERE id = ?', [id])!, scope);
  }

  // ───────────────────────────── updates feed ─────────────────────────────

  events(scope: SpaceScope, q: { cursor?: string; limit: number }): CursorPage<SubjectEventView> {
    const before = q.cursor && /^[A-Za-z0-9_-]+$/.test(q.cursor) ? Number(Buffer.from(q.cursor, 'base64url').toString('utf8')) : null;
    const rows = this.ctx.db.all<{ seq: number; kind: SubjectEventView['kind']; ref_type: string; ref_id: string; title: string; created_at: number }>(
      `SELECT seq, kind, ref_type, ref_id, title, created_at FROM subject_event
        WHERE (visibility_key IS NULL OR (visibility_key = 'mod' AND ?)) ${before !== null && Number.isFinite(before) ? 'AND seq < ?' : ''}
        ORDER BY seq DESC LIMIT ?`,
      [scope.powers.officialModerator ? 1 : 0, ...(before !== null && Number.isFinite(before) ? [before] : []), q.limit + 1],
    );
    const page = rows.slice(0, q.limit);
    return {
      items: page.map((r) => ({ seq: r.seq, kind: r.kind, ref: { type: r.ref_type, id: r.ref_id }, title: r.title, created_at: r.created_at })),
      next_cursor: rows.length > q.limit && page.length ? Buffer.from(String(page[page.length - 1]!.seq)).toString('base64url') : null,
    };
  }

  // ───────────────────────────── duplicate files (AOS-18.11) ─────────────────────────────

  duplicates(scope: SpaceScope): SubjectDuplicatesResponse {
    requireModerator(scope);
    const { ctx } = this;
    interface Candidate extends SubjectDuplicateItem {
      content_hash: string;
    }
    const items: Candidate[] = [];
    const versionOfSource = (sourceId: string, headId: string | null) =>
      ctx.db.get<{ id: string; version_no: number; file_name: string | null; page_count: number | null; content_hash: string }>(
        `SELECT id, version_no, file_name, page_count, content_hash FROM source_version WHERE ${headId ? 'id = ?' : 'source_id = ? ORDER BY version_no DESC LIMIT 1'}`,
        [headId ?? sourceId],
      );
    for (const l of ctx.db.all<{ id: string; title: string; status: string; source_id: string; head_version_id: string | null; takedown_at: number | null }>('SELECT id, title, status, source_id, head_version_id, takedown_at FROM official_lecture')) {
      if (l.takedown_at) continue;
      const v = versionOfSource(l.source_id, l.head_version_id);
      if (v) items.push({ type: 'lecture', id: l.id, title: l.title, status: l.status, version: { id: v.id, version_no: v.version_no, file_name: v.file_name, page_count: v.page_count }, content_hash: v.content_hash });
    }
    for (const a of ctx.db.all<{ id: string; title: string; status: string; source_id: string }>('SELECT id, title, status, source_id FROM subject_attachment')) {
      const v = versionOfSource(a.source_id, null);
      if (v) items.push({ type: 'attachment', id: a.id, title: a.title, status: a.status, version: { id: v.id, version_no: v.version_no, file_name: v.file_name, page_count: v.page_count }, content_hash: v.content_hash });
    }
    const strip = ({ content_hash: _h, ...rest }: Candidate): SubjectDuplicateItem => rest;
    const groups: SubjectDuplicateGroup[] = [];
    // byte-identical: the same sha256
    const byHash = new Map<string, Candidate[]>();
    for (const it of items) byHash.set(it.content_hash, [...(byHash.get(it.content_hash) ?? []), it]);
    const identicalOf = new Map<string, string>();
    for (const [hash, list] of byHash) {
      if (list.length < 2) continue;
      for (const it of list) identicalOf.set(`${it.type}:${it.id}`, hash);
      groups.push({ kind: 'identical', similarity: 1, basis_ar: `${list.length} ملفات متطابقة بايتًا ببايت (البصمة نفسها).`, items: list.map(strip) });
    }
    // near-duplicates: the share of pages whose text fingerprint (P1-T3) appears in the other file
    const prints = new Map<string, Set<string>>();
    let fingerprinted = 0;
    for (const it of items) {
      const hs = ctx.db.all<{ h: string }>('SELECT text_norm_hash AS h FROM page_fingerprint WHERE version_id = ? AND text_norm_hash IS NOT NULL', [it.version.id]).map((r) => r.h);
      if (hs.length) fingerprinted++;
      prints.set(`${it.type}:${it.id}`, new Set(hs));
    }
    const key = (it: Candidate) => `${it.type}:${it.id}`;
    const parent = new Map<string, string>();
    const find = (k: string): string => {
      let r = k;
      while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
      return r;
    };
    const pairs: Array<{ a: string; b: string; sim: number }> = [];
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i]!;
        const b = items[j]!;
        const ha = identicalOf.get(key(a));
        if (ha && ha === identicalOf.get(key(b))) continue; // already an identical group
        const pa = prints.get(key(a))!;
        const pb = prints.get(key(b))!;
        if (!pa.size || !pb.size) continue;
        let shared = 0;
        for (const h of pa) if (pb.has(h)) shared++;
        const sim = shared / Math.max(pa.size, pb.size);
        if (sim < DUPLICATE_NEAR_THRESHOLD) continue;
        pairs.push({ a: key(a), b: key(b), sim });
        const ra = find(key(a));
        const rb = find(key(b));
        if (ra !== rb) parent.set(ra, rb);
      }
    }
    const inPair = new Set(pairs.flatMap((p) => [p.a, p.b]));
    const comps = new Map<string, Candidate[]>();
    for (const it of items) {
      if (!inPair.has(key(it))) continue;
      const root = find(key(it));
      comps.set(root, [...(comps.get(root) ?? []), it]);
    }
    for (const [root, list] of comps) {
      const sim = Math.max(...pairs.filter((p) => find(p.a) === root).map((p) => p.sim));
      const shown = Math.round(sim * 100) / 100;
      groups.push({ kind: 'near', similarity: shown, basis_ar: `تتطابق ${Math.round(sim * 100)}٪ من صفحات ملفين في هذه المجموعة (بصمة نص الصفحة).`, items: list.map(strip) });
    }
    return { groups, checked: { versions: items.length, fingerprinted } };
  }
}
