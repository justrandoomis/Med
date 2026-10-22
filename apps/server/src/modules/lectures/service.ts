// Official lectures in a subject's space (P1-T5 step 1; ARCHITECTURE_DELTA §6.2, §6.3, §7.4; PRD AOS-2.2, 2.3, 4.5, 18.3,
// 18.4, 18.10, 19H.1): drafts, approval, upload into the space, publishing a version through P1-T3's page map, the
// moderator's page-map decisions, withdrawal and the rights takedown. Every method runs in the SPACE binding of the
// request and asserts the authz decision of ITS action (rules/lectures.ts) on top of gate 2.
//
// Statuses (lectures-api.ts): a lecture is a `draft` (no file yet, a moderator's own draft, or a contributor's draft a
// moderator approved), `in_review` (a contributor uploaded a file: it waits for a Subject Moderator, Q5), `published`
// (its head version is the official version students see) or `withdrawn`. Versions: a draft version (uploaded, not
// published), the published head, or superseded. A published version is never changed again (§6.7).
import {
  emptyChangeCounts,
  groupCount,
  type CreateOfficialLectureRequest,
  type CursorPage,
  type OfficialLectureDetail,
  type OfficialLectureView,
  type OfficialPageMapDecisionsRequest,
  type PatchOfficialLectureRequest,
  type PublishOfficialVersionPreview,
  type PublishOfficialVersionRequest,
  type PublishOfficialVersionResponse,
  type UploadOfficialVersionResponse,
  type VersionCompareResponse,
  type WithdrawOfficialLectureRequest,
} from '@medlevo/shared';
import { createHash } from 'node:crypto';
import type { AppContext } from '../../context';
import { AppError } from '../../lib/errors';
import { newId } from '../../lib/ids';
import type { OfficialLectureResource } from '../authz/rules/lectures';
import { removeStoredFileIfUnreferenced } from '../sources/purge';
import type { IncomingFile } from '../sources/upload';
import { compareVersions } from '../versions/compare';
import { fingerprintsComplete } from '../processing/fingerprint';
import { computeAndStorePageMap, decidePage, pageMapIsCurrent, readPageMap } from '../versions/pagemap';
import { enqueueOfficialFanout } from '../forks/fanout';
import { retokenizeVersions } from '../search/scopeTokens';
import { forksSystem } from '../forks/system';
import { createSpaceSource, ingestVersion } from './ingest';
import {
  appendSubjectEvent,
  getLecture,
  lectureResource,
  type LectureRow,
  notFound,
  publishOf,
  type SpaceScope,
  versionOf,
  versionVisibleTo,
  ViewBuilder,
  visibleLecture,
  visibleVersion,
} from './store';

export const OFFICIAL_PAGE_MAP_JOB = 'official_page_map';

const AR = {
  notReady: 'لم تنتهِ معالجة هذا الإصدار بعد؛ انشره بعد انتهائها حتى لا يرى الطلاب صفحات ناقصة.',
  failed: 'فشلت معالجة هذا الإصدار؛ أعد معالجته أو ارفع الملف من جديد قبل نشره.',
  superseded: 'هذا إصدار سابق حلّ محله إصدار أحدث؛ لا يُعاد نشره. ارفعه من جديد إن كان هو الصحيح.',
  noFile: 'لا يوجد ملف لهذه المسودة بعد؛ ارفع ملف المحاضرة أولًا.',
  idConflict: 'هذا المعرّف مستخدم لمحاضرة أخرى بمحتوى مختلف.',
  takedownDone: 'نُفّذ سحب الحقوق على هذه المحاضرة من قبل؛ لا يمكن التراجع عنه.',
};

const READY_STATES = new Set(['ready', 'partial', 'needs_review']);
const CURSOR_RE = /^[A-Za-z0-9_-]+$/;

function encodeCursor(key: unknown[]): string {
  return Buffer.from(JSON.stringify(key)).toString('base64url');
}
function decodeCursor(c: string | undefined): unknown[] | null {
  if (!c || !CURSOR_RE.test(c)) return null;
  try {
    const v = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as unknown;
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** AOS-2.2: by lecture number, then the session date, then the title (lectures without a number or date last). */
function sortKey(r: LectureRow): [number, number, string, string, string] {
  return [r.lecture_no ?? 1_000_000, r.held_on ? 0 : 1, r.held_on ?? '', r.title, r.id];
}
function compareKeys(a: unknown[], b: unknown[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] as number | string;
    const y = b[i] as number | string;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}

const bodyHash = (b: unknown) => createHash('sha256').update(JSON.stringify(b)).digest('hex');

export class LecturesService {
  constructor(private readonly ctx: AppContext) {}

  private views(scope: SpaceScope): ViewBuilder {
    return new ViewBuilder(this.ctx, scope);
  }

  /** The lecture after an authz check of `action` (404 when it cannot even be seen, 403 when only the action is refused). */
  private forAction(scope: SpaceScope, id: string, action: 'create' | 'edit' | 'approve' | 'publish' | 'withdraw'): LectureRow {
    const row = getLecture(this.ctx, id);
    if (!row) throw notFound();
    this.ctx.authz.assert(scope.viewer, action, lectureResource(scope, row));
    return row;
  }

  // ───────── reads ─────────

  list(scope: SpaceScope, q: { cursor?: string; limit: number; status?: LectureRow['status'] }): CursorPage<OfficialLectureView> {
    const rows = this.ctx.db
      .all<LectureRow>(`SELECT * FROM official_lecture ${q.status ? 'WHERE status = ?' : ''}`, q.status ? [q.status] : [])
      .filter((r) => this.ctx.authz.can(scope.viewer, 'view', lectureResource(scope, r)).allowed)
      .sort((a, b) => compareKeys(sortKey(a), sortKey(b)));
    const after = decodeCursor(q.cursor);
    const start = after ? rows.findIndex((r) => compareKeys(sortKey(r), after) > 0) : 0;
    const page = start < 0 ? [] : rows.slice(start, start + q.limit);
    const more = start >= 0 && start + q.limit < rows.length;
    const v = this.views(scope);
    v.preload(page.flatMap((r) => [r.uploaded_by, r.approved_by]));
    return { items: page.map((r) => v.lecture(r)), next_cursor: more && page.length ? encodeCursor(sortKey(page[page.length - 1]!)) : null };
  }

  detail(scope: SpaceScope, id: string): OfficialLectureDetail {
    return this.views(scope).detail(visibleLecture(this.ctx, scope, id));
  }

  // ───────── drafts ─────────

  create(scope: SpaceScope, body: CreateOfficialLectureRequest): OfficialLectureView {
    const { ctx } = this;
    const fresh: OfficialLectureResource = { type: 'official_lecture', spaceId: scope.spaceId, id: '', status: 'draft', subjectNodeId: scope.subjectNodeId, uploadedBy: scope.viewer.userId };
    ctx.authz.assert(scope.viewer, 'create', fresh);
    const hash = bodyHash({ title: body.title, lecture_no: body.lecture_no ?? null, held_on: body.held_on ?? null, by: scope.viewer.userId });
    if (body.id) {
      const existing = getLecture(ctx, body.id);
      if (existing) {
        if (existing.client_body_hash !== hash) throw new AppError('CONFLICT', AR.idConflict, 409);
        return this.views(scope).lecture(visibleLecture(ctx, scope, existing.id));
      }
    }
    const now = ctx.clock.now();
    const id = body.id ?? newId(now);
    ctx.db.tx(() => {
      const sourceId = createSpaceSource(ctx, { title: body.title, sourceType: 'lecture', lectureNo: body.lecture_no ?? null, heldOn: body.held_on ?? null });
      ctx.db.run(
        `INSERT INTO official_lecture (id, subject_node_id, source_id, title, lecture_no, lecture_no_origin, held_on, status, uploaded_by, client_body_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
        [id, scope.subjectNodeId, sourceId, body.title, body.lecture_no ?? null, body.lecture_no ? 'moderator' : null, body.held_on ?? null, scope.viewer.userId, hash, now, now],
      );
      ctx.audit.record({ entityType: 'official_lecture', entityId: id, action: 'create', summary: `مسودة محاضرة رسمية «${body.title}»`, after: { lecture_no: body.lecture_no ?? null, held_on: body.held_on ?? null } });
    });
    return this.views(scope).lecture(getLecture(ctx, id)!);
  }

  patch(scope: SpaceScope, id: string, body: PatchOfficialLectureRequest): OfficialLectureView {
    const { ctx } = this;
    const row = this.forAction(scope, id, 'edit');
    const next = {
      title: body.title ?? row.title,
      lecture_no: body.lecture_no === undefined ? row.lecture_no : body.lecture_no,
      held_on: body.held_on === undefined ? row.held_on : body.held_on,
    };
    const origin = body.lecture_no === undefined ? row.lecture_no_origin : next.lecture_no === null ? null : 'moderator';
    // a contributor changing their approved draft asks for the approval again (it was given to other details — review R11)
    const changed = next.title !== row.title || next.lecture_no !== row.lecture_no || next.held_on !== row.held_on;
    const reapprove = changed && !scope.powers.officialModerator && row.approved_by !== null && (row.status === 'draft' || row.status === 'in_review');
    ctx.db.tx(() => {
      ctx.db.run('UPDATE official_lecture SET title = ?, lecture_no = ?, lecture_no_origin = ?, held_on = ?, updated_at = ? WHERE id = ?', [next.title, next.lecture_no, origin, next.held_on, ctx.clock.now(), id]);
      if (reapprove) {
        const hasFile = !!ctx.db.get('SELECT 1 AS x FROM source_version WHERE source_id = ? LIMIT 1', [row.source_id]);
        ctx.db.run(`UPDATE official_lecture SET status = ?, approved_by = NULL, approved_at = NULL WHERE id = ?`, [hasFile ? 'in_review' : 'draft', id]);
      }
      ctx.db.run(`UPDATE source SET title = ?, lecture_no = ?, lecture_no_origin = ?, held_on = ?, held_on_origin = CASE WHEN ? IS NULL THEN NULL ELSE 'moderator' END, updated_at = ? WHERE id = ?`, [
        next.title,
        next.lecture_no,
        origin,
        next.held_on,
        next.held_on,
        ctx.clock.now(),
        row.source_id,
      ]);
      ctx.audit.record({ entityType: 'official_lecture', entityId: id, action: 'update', summary: `تعديل بيانات «${next.title}»`, before: { title: row.title, lecture_no: row.lecture_no, held_on: row.held_on }, after: next });
    });
    return this.views(scope).lecture(getLecture(ctx, id)!);
  }

  async upload(scope: SpaceScope, id: string, file: IncomingFile): Promise<UploadOfficialVersionResponse> {
    const { ctx } = this;
    const row = this.forAction(scope, id, 'create');
    const byModerator = scope.powers.officialModerator;
    const res = await ingestVersion(ctx, file, {
      sourceId: row.source_id,
      stillWritable: () => {
        const now = getLecture(ctx, id);
        if (!now) throw notFound();
        ctx.authz.assert(scope.viewer, 'create', lectureResource(scope, now));
      },
      register: (versionId, versionNo) => {
        const now = ctx.clock.now();
        ctx.db.run('INSERT INTO official_version_upload (version_id, lecture_id, uploaded_by, kind, created_at) VALUES (?, ?, ?, ?, ?)', [versionId, id, scope.viewer.userId, 'upload', now]);
        if (versionNo === 1) ctx.db.run('UPDATE source SET current_version_id = ? WHERE id = ?', [versionId, row.source_id]);
        const current = getLecture(ctx, id)!;
        if (!byModerator && (current.status === 'draft' || current.status === 'in_review')) {
          // a contributor's file waits for a Subject Moderator (Q5); an earlier approval was for other content
          ctx.db.run(`UPDATE official_lecture SET status = 'in_review', approved_by = NULL, approved_at = NULL, updated_at = ? WHERE id = ?`, [now, id]);
        } else ctx.db.run('UPDATE official_lecture SET updated_at = ? WHERE id = ?', [now, id]);
        ctx.audit.record({ entityType: 'official_lecture', entityId: id, action: 'upload', summary: `رفع الإصدار ${versionNo} من «${current.title}»`, after: { version_id: versionId, file_name: file.fileName } });
      },
    });
    const dup = this.visibleDuplicate(scope, row, res.contentHash, res.versionId);
    return {
      version_id: res.versionId,
      job_id: res.jobId,
      duplicate_of: dup,
      duplicate_note_ar: dup ? `هذا الملف مطابق للإصدار ${dup.version_no} من «${dup.title}» في هذه المادة؛ رُفع كما طلبت، وتجده المادة في «الملفات المكررة».` : null,
    };
  }

  /**
   * (Phase 1 completion C2, AOS-3.6 / 2.3) Another official lecture of this subject holding the same bytes — named only
   * when the uploader may see that lecture AND that version (a contributor never learns of another's hidden draft).
   */
  private visibleDuplicate(scope: SpaceScope, row: LectureRow, contentHash: string, newVersionId: string): UploadOfficialVersionResponse['duplicate_of'] {
    const { ctx } = this;
    for (const v of ctx.db.all<{ id: string; source_id: string; version_no: number }>('SELECT id, source_id, version_no FROM source_version WHERE content_hash = ? AND id <> ? AND source_id <> ? ORDER BY created_at', [
      contentHash,
      newVersionId,
      row.source_id,
    ])) {
      const other = ctx.db.get<LectureRow>('SELECT * FROM official_lecture WHERE source_id = ?', [v.source_id]);
      if (!other || other.takedown_at) continue;
      if (!ctx.authz.can(scope.viewer, 'view', lectureResource(scope, other)).allowed) continue;
      if (!versionVisibleTo(ctx, scope, other, v.id)) continue;
      return { lecture_id: other.id, title: other.title, version_no: v.version_no };
    }
    return null;
  }

  /** The upload check alone (the route asks it before reading the multipart body; `upload` asks it again). */
  assertCanUpload(scope: SpaceScope, id: string): void {
    this.forAction(scope, id, 'create');
  }

  approve(scope: SpaceScope, id: string): OfficialLectureView {
    const { ctx } = this;
    const row = this.forAction(scope, id, 'approve');
    if (row.status === 'draft' || row.status === 'in_review') {
      if (!ctx.db.get('SELECT 1 AS x FROM source_version WHERE source_id = ? LIMIT 1', [row.source_id])) throw new AppError('CONFLICT', AR.noFile, 409);
      if (row.status === 'in_review' || !row.approved_by) {
        const now = ctx.clock.now();
        ctx.db.tx(() => {
          ctx.db.run(`UPDATE official_lecture SET status = 'draft', approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ?`, [scope.viewer.userId, now, now, id]);
          ctx.audit.record({ entityType: 'official_lecture', entityId: id, action: 'approve', summary: `موافقة على «${row.title}»` });
        });
      }
    }
    return this.views(scope).lecture(getLecture(ctx, id)!);
  }

  // ───────── publish ─────────

  private changesBetween(fromId: string, toId: string): PublishOfficialVersionPreview['changes'] {
    const { ctx } = this;
    if (!fingerprintsComplete(ctx, fromId) || !fingerprintsComplete(ctx, toId)) return null;
    const map = pageMapIsCurrent(ctx, fromId, toId) ? readPageMap(ctx, fromId, toId) : computeAndStorePageMap(ctx, fromId, toId);
    return map ? { ...emptyChangeCounts(), ...map.counts } : null;
  }

  publish(scope: SpaceScope, id: string, versionId: string, body: PublishOfficialVersionRequest): PublishOfficialVersionPreview | PublishOfficialVersionResponse {
    const { ctx } = this;
    const row = this.forAction(scope, id, 'publish');
    const v = visibleVersion(ctx, scope, row, versionId);
    const already = publishOf(ctx, v.id);
    const holders = groupCount(forksSystem(ctx).holderCount(scope.spaceId, id)); // students holding a copy (system lecture_copy)
    if (already) {
      if (row.head_version_id !== v.id) throw new AppError('CONFLICT', AR.superseded, 409);
      if (body.preview) {
        const prev = already.previous_version_id ? versionOf(ctx, already.previous_version_id) : null;
        return { lecture_id: id, version: { id: v.id, version_no: v.version_no, page_count: v.page_count }, previous: prev ? { id: prev.id, version_no: prev.version_no } : null, changes: prev ? this.changesBetween(prev.id, v.id) : null, holders };
      }
      const job = ctx.db.get<{ id: string }>(`SELECT id FROM processing_job WHERE kind = ? AND json_extract(input_json, '$.to') = ? ORDER BY created_at DESC LIMIT 1`, [OFFICIAL_PAGE_MAP_JOB, v.id]);
      // a replayed publish whose page-map job never got queued (a crash in between) queues it now (idempotent key)
      const jobId = job?.id ?? (already.previous_version_id && already.page_map_status === 'pending' ? this.enqueuePageMap(id, already.previous_version_id, v.id) : null);
      return { head_version_id: v.id, page_map_job_id: jobId, holders };
    }
    if (v.processing_status === 'failed') throw new AppError('CONFLICT', AR.failed, 409, { processing_status: v.processing_status });
    if (!READY_STATES.has(v.processing_status)) throw new AppError('CONFLICT', AR.notReady, 409, { processing_status: v.processing_status });
    const prev = row.head_version_id ? versionOf(ctx, row.head_version_id) : null;
    // an UPLOAD older than the head's own upload is superseded; a correction of the head (version n+1 derived from it)
    // does not supersede a newer upload that was waiting as a draft (review R4: it became unpublishable for ever)
    if (prev && uploadBaseNo(ctx, prev.id) > v.version_no) throw new AppError('CONFLICT', AR.superseded, 409);
    if (body.preview) {
      return { lecture_id: id, version: { id: v.id, version_no: v.version_no, page_count: v.page_count }, previous: prev ? { id: prev.id, version_no: prev.version_no } : null, changes: prev ? this.changesBetween(prev.id, v.id) : null, holders };
    }
    this.publishVersion(scope.viewer.userId, row, v.id, { changeNote: body.change_note ?? null, kind: 'upload' });
    const jobId = prev ? this.enqueuePageMap(id, prev.id, v.id) : null;
    return { head_version_id: v.id, page_map_job_id: jobId, holders };
  }

  /** Make `versionId` the official head (used by publish and by the correction job). Call outside a transaction. */
  publishVersion(publisher: string, row: LectureRow, versionId: string, o: { changeNote: string | null; kind: 'upload' | 'correction' }): void {
    const { ctx } = this;
    const now = ctx.clock.now();
    const v = versionOf(ctx, versionId)!;
    let firstPublish = false;
    ctx.db.tx(() => {
      const current = getLecture(ctx, row.id)!;
      if (current.status === 'withdrawn') throw new AppError('FORBIDDEN', 'سُحبت هذه المحاضرة؛ لا يمكن نشر إصدار لها.', 403);
      const first = current.head_version_id === null;
      firstPublish = first;
      ctx.db.run(
        `INSERT INTO official_version_publish (version_id, lecture_id, published_by, published_at, change_note, previous_version_id, kind, page_map_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [versionId, row.id, publisher, now, o.changeNote, current.head_version_id, o.kind, current.head_version_id ? 'pending' : 'ready'],
      );
      // publishing a contributor's lecture IS the Subject Moderator's approval (Q5)
      const approve = current.approved_by === null && current.uploaded_by !== publisher;
      ctx.db.run(
        `UPDATE official_lecture SET status = 'published', head_version_id = ?, approved_by = CASE WHEN ? THEN ? ELSE approved_by END,
           approved_at = CASE WHEN ? THEN ? ELSE approved_at END, updated_at = ? WHERE id = ?`,
        [versionId, approve ? 1 : 0, publisher, approve ? 1 : 0, now, now, row.id],
      );
      ctx.db.run('UPDATE source SET current_version_id = ?, processing_status = (SELECT processing_status FROM source_version WHERE id = ?), updated_at = ? WHERE id = ?', [versionId, versionId, now, row.source_id]);
      // P1-T5 step 2: the federated search's «published head» token moves from the old head to the new one (3300)
      retokenizeVersions(ctx.db, [current.head_version_id, versionId]);
      appendSubjectEvent(ctx, {
        subjectNodeId: current.subject_node_id,
        kind: first ? 'lecture_published' : 'version_published',
        refType: 'official_lecture',
        refId: row.id,
        title: first ? `محاضرة جديدة: ${current.title}` : o.kind === 'correction' ? `تصحيح في «${current.title}» — الإصدار ${v.version_no}` : `الإصدار ${v.version_no} من «${current.title}»`,
      });
      ctx.audit.record({ entityType: 'official_lecture', entityId: row.id, action: 'publish', summary: `نشر الإصدار ${v.version_no} من «${current.title}»`, after: { version_id: versionId, kind: o.kind, previous_version_id: current.head_version_id } });
    });
    // P1-T5 step 2: a lecture's FIRST version reaches «تابع المادة» followers now; a later version reaches the holders of
    // a copy once its page map is computed (the page-map job queues that fan-out), so their note copy uses the map
    if (firstPublish) enqueueOfficialFanout(ctx, { lecture_id: row.id, version_id: versionId, reason: 'published' });
  }

  enqueuePageMap(lectureId: string, from: string, to: string): string {
    return this.ctx.jobs.enqueue(OFFICIAL_PAGE_MAP_JOB, { lecture_id: lectureId, from, to }, { idempotencyKey: `${OFFICIAL_PAGE_MAP_JOB}:${from}:${to}` }).id;
  }

  compare(scope: SpaceScope, id: string, fromId: string, toId: string): VersionCompareResponse {
    const row = visibleLecture(this.ctx, scope, id);
    visibleVersion(this.ctx, scope, row, fromId);
    visibleVersion(this.ctx, scope, row, toId);
    if (row.takedown_at) throw notFound();
    return compareVersions(this.ctx, fromId, toId);
  }

  pageMapDecisions(scope: SpaceScope, id: string, body: OfficialPageMapDecisionsRequest): VersionCompareResponse {
    const { ctx } = this;
    const row = this.forAction(scope, id, 'edit');
    visibleVersion(ctx, scope, row, body.from_version_id);
    visibleVersion(ctx, scope, row, body.to_version_id);
    for (const d of body.decisions) {
      decidePage(ctx, body.from_version_id, body.to_version_id, { from_page_id: d.from_page_id, action: d.action, ...(d.to_page_id ? { to_page_id: d.to_page_id } : {}) });
      // the human decision is the Subject Moderator's (method «moderator», §6.2 step 5), not an owner's
      ctx.db.run(`UPDATE version_page_map SET method = 'moderator' WHERE from_version_id = ? AND to_version_id = ? AND from_page_id = ? AND status IN ('confirmed','rejected')`, [
        body.from_version_id,
        body.to_version_id,
        d.from_page_id,
      ]);
    }
    return compareVersions(ctx, body.from_version_id, body.to_version_id);
  }

  // ───────── withdraw and the rights takedown ─────────

  withdraw(scope: SpaceScope, id: string, body: WithdrawOfficialLectureRequest): OfficialLectureDetail {
    const { ctx } = this;
    const row = this.forAction(scope, id, 'withdraw');
    const takedown = body.reason === 'rights_takedown';
    if (row.status === 'withdrawn' && (row.takedown_at !== null || !takedown)) return this.views(scope).detail(row); // nothing more to do
    const now = ctx.clock.now();
    let released: string[] = [];
    ctx.db.tx(() => {
      const first = row.status !== 'withdrawn';
      const everPublished = row.head_version_id !== null;
      ctx.db.run(
        `UPDATE official_lecture SET status = 'withdrawn', withdrawn_reason = ?, withdrawn_note = ?, withdrawn_by = ?, withdrawn_at = COALESCE(withdrawn_at, ?), updated_at = ? WHERE id = ?`,
        [body.reason, body.note_ar, scope.viewer.userId, now, now, id],
      );
      // a lecture students never saw (a rejected draft) leaves no public line in the updates feed (review R1) — its
      // uploader alone reads why (C2, AOS-11.27: a per-viewer line, key `u:<uploader>`)
      if (first && everPublished) appendSubjectEvent(ctx, { subjectNodeId: row.subject_node_id, kind: 'lecture_withdrawn', refType: 'official_lecture', refId: id, title: `سُحبت: ${row.title}` });
      else if (first && row.uploaded_by !== scope.viewer.userId)
        appendSubjectEvent(ctx, { subjectNodeId: row.subject_node_id, kind: 'lecture_withdrawn', refType: 'official_lecture', refId: id, title: `لم تُعتمد مسودتك «${row.title}»: ${body.note_ar}`, forUser: row.uploaded_by });
      // P1-T5 step 2: a withdrawn lecture leaves the federated search (its head loses the «published head» token)
      retokenizeVersions(ctx.db, [row.head_version_id]);
      if (takedown) {
        released = takeDownFiles(ctx, row.source_id);
        closeCorrectionsOnTakedown(ctx, id, now);
        ctx.db.run('UPDATE official_lecture SET takedown_at = ? WHERE id = ?', [now, id]);
      }
      ctx.audit.record({ entityType: 'official_lecture', entityId: id, action: takedown ? 'rights_takedown' : 'withdraw', summary: `سحب «${row.title}»`, after: { reason: body.reason, files_released: released.length } });
    });
    // the space's rows go now; the bytes wait for the blob GC (shared content-addressed store, P1-T1)
    for (const fileId of released) removeStoredFileIfUnreferenced(ctx, fileId);
    if (takedown) cancelJobsOf(ctx, row.source_id);
    // P1-T5 step 2: copy holders learn it (and a takedown removes the file from their stubs; their notes stay)
    if (row.head_version_id !== null) enqueueOfficialFanout(ctx, { lecture_id: id, version_id: null, reason: takedown ? 'takedown' : 'withdrawn' });
    return this.views(scope).detail(getLecture(ctx, id)!);
  }
}

/**
 * The rights takedown inside the space (§6.3): every file reference of the lecture's versions is set to NULL (they
 * REFERENCE stored_file with foreign_keys = ON, so the file rows could not be deleted before), the extracted text
 * leaves search and AI (chunks deleted — their FTS rows go with them — and region text cleared), and the pages stay as
 * placeholders (size, order, labels) so students' ink and notes in their vaults keep their places. Returns the file
 * ids to release after the transaction. Vault stubs are handled by the step-2 fan-out through `lecture_copy`.
 */
function takeDownFiles(ctx: AppContext, sourceId: string): string[] {
  const versions = ctx.db.all<{ id: string; file_id: string | null; original_file_id: string | null; display_file_id: string | null }>(
    'SELECT id, file_id, original_file_id, display_file_id FROM source_version WHERE source_id = ?',
    [sourceId],
  );
  const files = new Set<string>();
  for (const v of versions) {
    for (const f of [v.file_id, v.original_file_id, v.display_file_id]) if (f) files.add(f);
    for (const p of ctx.db.all<{ render_file_id: string | null; thumbnail_file_id: string | null }>('SELECT render_file_id, thumbnail_file_id FROM source_page WHERE version_id = ?', [v.id])) {
      if (p.render_file_id) files.add(p.render_file_id);
      if (p.thumbnail_file_id) files.add(p.thumbnail_file_id);
    }
    for (const r of ctx.db.all<{ file_id: string | null }>('SELECT file_id FROM version_rendition WHERE version_id = ?', [v.id])) if (r.file_id) files.add(r.file_id);
    for (const a of ctx.db.all<{ file_id: string | null }>('SELECT file_id FROM image_asset WHERE version_id = ?', [v.id])) if (a.file_id) files.add(a.file_id);
    ctx.db.run('UPDATE source_version SET file_id = NULL, original_file_id = NULL, display_file_id = NULL WHERE id = ?', [v.id]);
    ctx.db.run('UPDATE source_page SET render_file_id = NULL, thumbnail_file_id = NULL WHERE version_id = ?', [v.id]);
    ctx.db.run('UPDATE version_rendition SET file_id = NULL WHERE version_id = ?', [v.id]);
    ctx.db.run('UPDATE image_asset SET file_id = NULL, caption = NULL, title = NULL WHERE version_id = ?', [v.id]);
    ctx.db.run('DELETE FROM document_chunk WHERE version_id = ?', [v.id]);
    ctx.db.run('UPDATE source_region SET text = NULL, structure_json = NULL WHERE version_id = ?', [v.id]);
    takeDownDerivedText(ctx, v.id);
  }
  return [...files];
}

/**
 * The follow-up jobs of processing (Course Brain, figure reading) keep verbatim sentences of the version in the space:
 * mention and relation-statement quotes, algorithm steps, figure readings and the reasons of suggested relations. A
 * rights takedown removes them too (review R9) — the same treatment the sources purge gives a deleted version
 * (migration 0801), applied to a version that stays as placeholders. Concept NAMES (short terms shared by the subject)
 * stay; nothing of the lecture's prose does.
 */
function takeDownDerivedText(ctx: AppContext, versionId: string): void {
  ctx.db.run('UPDATE concept_mention SET quote = NULL WHERE version_id = ?', [versionId]);
  ctx.db.run('DELETE FROM concept_relation_statement WHERE version_id = ?', [versionId]);
  ctx.db.run('DELETE FROM knowledge_algorithm WHERE version_id = ?', [versionId]);
  ctx.db.run(`UPDATE figure_reading SET structure_json = NULL, reviewed_structure_json = NULL, notes_json = '[]' WHERE version_id = ?`, [versionId]);
  ctx.db.run(
    `UPDATE concept_relation
        SET reasons_json = COALESCE((SELECT json_group_array(json(j.value)) FROM json_each(concept_relation.reasons_json) AS j WHERE instr(j.value, ?) = 0), '[]')
      WHERE reasons_json IS NOT NULL AND json_valid(reasons_json) AND json_type(reasons_json) = 'array' AND instr(reasons_json, ?) > 0`,
    [versionId, versionId],
  );
  ctx.db.run(`DELETE FROM concept_relation WHERE origin = 'auto' AND status = 'suggested' AND reasons_json = '[]'`);
  ctx.db.run(
    `UPDATE concept_relation SET reasons_json = json_array(json_object('kind', 'basis_removed', 'text_ar', ?)) WHERE reasons_json = '[]'`,
    ['سُحب المصدر الذي بُني عليه هذا الاقتراح بطلب صاحب الحقوق؛ بقي القرار وحده، ولا يُعرض شيء من نصه.'],
  );
}

/** Jobs still queued or running for the taken-down versions are cancelled (they would write its text back). */
function cancelJobsOf(ctx: AppContext, sourceId: string): void {
  const jobs = ctx.db.all<{ id: string }>(
    `SELECT j.id FROM processing_job j
      WHERE j.status IN ('queued', 'running', 'waiting_for_input') AND json_valid(j.input_json)
        AND json_extract(j.input_json, '$.version_id') IN (SELECT id FROM source_version WHERE source_id = ?)`,
    [sourceId],
  );
  for (const j of jobs) {
    try {
      ctx.jobs.cancel(j.id);
    } catch (e) {
      ctx.log.warn({ err: e, jobId: j.id }, 'could not cancel a job of a taken-down official lecture');
    }
  }
}

/**
 * The version number of the UPLOAD a version stands for: a correction (kind 'owner_correction', derived from the version
 * it corrected) stands for the upload it corrected, so publishing a newer upload after a correction is not «superseded».
 */
function uploadBaseNo(ctx: AppContext, versionId: string): number {
  let cur = ctx.db.get<{ id: string; version_no: number; kind: string; derived_from_version_id: string | null }>('SELECT id, version_no, kind, derived_from_version_id FROM source_version WHERE id = ?', [versionId]);
  for (let hops = 0; cur && cur.kind === 'owner_correction' && cur.derived_from_version_id && hops < 1000; hops++) {
    const next = ctx.db.get<{ id: string; version_no: number; kind: string; derived_from_version_id: string | null }>('SELECT id, version_no, kind, derived_from_version_id FROM source_version WHERE id = ?', [cur.derived_from_version_id]);
    if (!next) break;
    cur = next;
  }
  return cur?.version_no ?? 0;
}

/**
 * A rights takedown also removes the lecture's text from the moderators' correction queue (review R5): every correction
 * of the lecture keeps its row (audit) but no item text or note; an open proposal is closed as rejected and a queued one
 * fails (the job would refuse a withdrawn lecture anyway), each with the reason.
 */
function closeCorrectionsOnTakedown(ctx: AppContext, lectureId: string, now: number): void {
  ctx.db.run(
    `UPDATE official_correction
        SET items_json = '[]', note = NULL,
            status = CASE status WHEN 'open' THEN 'rejected' WHEN 'queued' THEN 'failed' ELSE status END,
            decision_note = CASE WHEN status = 'open' THEN ? ELSE decision_note END,
            decided_at = CASE WHEN status = 'open' THEN ? ELSE decided_at END,
            failure_reason = CASE WHEN status = 'queued' THEN ? ELSE failure_reason END,
            updated_at = ?
      WHERE lecture_id = ?`,
    [TAKEDOWN_CLOSED_AR, now, TAKEDOWN_CLOSED_AR, now, lectureId],
  );
}

const TAKEDOWN_CLOSED_AR = 'سُحبت المحاضرة بطلب صاحب الحقوق؛ أُغلق الاقتراح وحُذف نصه.';

/** The page-map job of a newly published official version (§6.2): fingerprints when missing, then the stored map. */
export function pageMapStatus(ctx: AppContext, to: string, status: 'ready' | 'failed'): void {
  ctx.db.run('UPDATE official_version_publish SET page_map_status = ? WHERE version_id = ?', [status, to]);
}

export function lectureOfVersion(ctx: AppContext, versionId: string): LectureRow | null {
  const v = versionOf(ctx, versionId);
  if (!v) return null;
  return ctx.db.get<LectureRow>('SELECT * FROM official_lecture WHERE source_id = ?', [v.source_id]) ?? null;
}
