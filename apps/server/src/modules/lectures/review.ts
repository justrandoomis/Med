// The subject's review queue (Phase 1 completion C2; PRD AOS-3.18 role-scoped review, AOS-3.11 «إصدار جديد من …» with
// follower notification; ARCHITECTURE_DELTA §6.1 «through the review queue (§19H)»).
//
//  * P1-T3's import intelligence runs on every official upload INSIDE the space (the processing follow-up job): it
//    detects the lecture number, the date and a title, and proposes «إصدار جديد من …» when ≥ 60 % of an existing
//    lecture's pages match. Its `import_suggestion` rows live in the space; this module is their only reader there.
//  * Role-scoped: the subject's OFFICIAL moderators (Subject Moderator, Admin above, platform admin) read and decide it;
//    an Assistant has no power over official content (Q5) and gets 403; members get 403 at gate 2; strangers 404. A
//    student's own uploads have their own queue in their vault (`GET /api/versions/suggestions`) — the two never mix.
//  * Uncertain values have NO effect until accepted. A certain detected number / date fills an official lecture that
//    has none (origin «detected»); a moderator's value is never overwritten, a rejected value never comes back.
//  * Accepting «إصدار جديد من X»: the upload's file becomes a new DRAFT version of X (the same stored file — no byte
//    copy), processed in the space; the duplicate draft lecture is withdrawn as «replaced» (students never saw it). The
//    moderator publishes the new version with the usual preview; the page map and the holders' / followers'
//    notifications (`official_version`) follow from that publish (P1-T5 step 2 fan-out).
import {
  IMPORT_SUGGESTION_FIELD_LABELS_AR,
  type DecideSubjectReviewResponse,
  type ImportSuggestionValue,
  type ImportSuggestionView,
  type SubjectReviewItem,
  type SubjectReviewResponse,
} from '@medlevo/shared';
import type { AppContext } from '../../context';
import { AppError } from '../../lib/errors';
import { newId } from '../../lib/ids';
import { finishProcessingSetup } from '../sources/upload';
import { getSuggestion, listSuggestions } from '../versions/identity';
import { appendSubjectEvent, getLecture, type LectureRow, notFound, type SpaceScope } from './store';

const NOT_OFFICIAL_AR = 'قائمة المراجعة الرسمية لمشرفي المادة فقط؛ المساعد لا يملك صلاحية على المحتوى الرسمي.';

/** The review queue is the official moderators' (an Assistant passes gate 2 but holds no official power, Q5). */
function requireOfficialModerator(scope: SpaceScope): void {
  if (!scope.powers.officialModerator) throw new AppError('FORBIDDEN', NOT_OFFICIAL_AR, 403);
}

const lectureOfSource = (ctx: AppContext, sourceId: string): LectureRow | null => ctx.db.get<LectureRow>('SELECT * FROM official_lecture WHERE source_id = ?', [sourceId]) ?? null;

function headNo(ctx: AppContext, l: LectureRow): number | null {
  return l.head_version_id ? (ctx.db.get<{ n: number }>('SELECT version_no AS n FROM source_version WHERE id = ?', [l.head_version_id])?.n ?? null) : null;
}

/** Fields a subject's review shows (a library folder placement means nothing in a space). */
const SPACE_FIELDS = new Set<ImportSuggestionView['field']>(['lecture_no', 'held_on', 'title', 'new_version_of']);

export class SubjectReviewService {
  constructor(private readonly ctx: AppContext) {}

  private item(s: ImportSuggestionView): SubjectReviewItem | null {
    const { ctx } = this;
    const l = lectureOfSource(ctx, s.source_id);
    const isAttachment = !l && !!ctx.db.get('SELECT 1 AS x FROM subject_attachment WHERE source_id = ?', [s.source_id]);
    if (!l && !isAttachment) return null;
    let target: SubjectReviewItem['target_lecture'] = null;
    if (s.value.field === 'new_version_of') {
      const t = lectureOfSource(ctx, s.value.source_id);
      if (!t) return null; // a match with an attachment is never a new version of a lecture
      target = { id: t.id, title: t.title, status: t.status, head_version_no: headNo(ctx, t) };
    }
    return { suggestion: s, lecture: l ? { id: l.id, title: l.title, status: l.status, lecture_no: l.lecture_no } : null, target_lecture: target };
  }

  list(scope: SpaceScope): SubjectReviewResponse {
    requireOfficialModerator(scope);
    const items = listSuggestions(this.ctx, { status: 'open' })
      .filter((s) => SPACE_FIELDS.has(s.field))
      .map((s) => this.item(s))
      .filter((i): i is SubjectReviewItem => !!i)
      // a lecture taken down for rights has nothing left to review
      .filter((i) => !i.lecture || !getLecture(this.ctx, i.lecture.id)?.takedown_at);
    return { items };
  }

  decide(scope: SpaceScope, suggestionId: string, action: 'accept' | 'reject'): DecideSubjectReviewResponse {
    requireOfficialModerator(scope);
    const { ctx } = this;
    let s: ImportSuggestionView;
    try {
      s = getSuggestion(ctx, suggestionId);
    } catch {
      throw notFound();
    }
    const before = this.item(s);
    if (!before || !SPACE_FIELDS.has(s.field)) throw notFound();
    if (s.status !== 'open' && s.status !== 'applied') throw new AppError('CONFLICT', 'عولج هذا الاقتراح من قبل؛ قرار المشرف محفوظ.', 409);
    const now = ctx.clock.now();
    const label = IMPORT_SUGGESTION_FIELD_LABELS_AR[s.field];
    const lecture = before.lecture ? getLecture(ctx, before.lecture.id) : null;
    let result_ar = '';
    let new_version: DecideSubjectReviewResponse['new_version'];

    const settle = (status: 'accepted' | 'rejected') => {
      ctx.db.run(`UPDATE import_suggestion SET status = ?, decided_at = ?, updated_at = ? WHERE id = ?`, [status, now, now, s.id]);
      // one value per field: the other open proposals of the field are answered by this decision
      if (status === 'accepted') ctx.db.run(`UPDATE import_suggestion SET status = 'superseded', updated_at = ? WHERE source_id = ? AND field = ? AND id <> ? AND status IN ('open','applied')`, [now, s.source_id, s.field, s.id]);
    };

    if (action === 'reject') {
      ctx.db.tx(() => {
        settle('rejected');
        ctx.audit.record({ entityType: 'official_lecture', entityId: lecture?.id ?? s.source_id, action: 'review_rejected', summary: `رفض المشرف اقتراح ${label}`, after: { suggestion_id: s.id, field: s.field, value: s.value } });
      });
      result_ar = 'رُفض الاقتراح ولن يُقترح مجددًا لهذا الملف. لم يتغير شيء.';
    } else {
      const v = s.value;
      if (v.field === 'new_version_of') {
        const r = this.acceptNewVersion(scope, s, v, lecture);
        result_ar = r.result_ar;
        new_version = r.new_version;
        ctx.db.tx(() => settle('accepted'));
      } else {
        if (!lecture) throw new AppError('CONFLICT', 'هذا الاقتراح لملف مرفق؛ لا يُطبَّق على محاضرة.', 409);
        if (lecture.status === 'withdrawn') throw new AppError('CONFLICT', 'سُحبت هذه المحاضرة؛ لا يُطبَّق عليها اقتراح.', 409);
        ctx.db.tx(() => {
          if (v.field === 'lecture_no') {
            ctx.db.run(`UPDATE official_lecture SET lecture_no = ?, lecture_no_origin = 'moderator', updated_at = ? WHERE id = ?`, [v.lecture_no, now, lecture.id]);
            ctx.db.run(`UPDATE source SET lecture_no = ?, lecture_no_origin = 'moderator', updated_at = ? WHERE id = ?`, [v.lecture_no, now, lecture.source_id]);
            result_ar = `صار رقم المحاضرة ${v.lecture_no}.`;
          } else if (v.field === 'held_on') {
            ctx.db.run(`UPDATE official_lecture SET held_on = ?, updated_at = ? WHERE id = ?`, [v.held_on, now, lecture.id]);
            ctx.db.run(`UPDATE source SET held_on = ?, held_on_origin = 'moderator', updated_at = ? WHERE id = ?`, [v.held_on, now, lecture.source_id]);
            result_ar = `صار تاريخ المحاضرة ${v.held_on}.`;
          } else if (v.field === 'title') {
            ctx.db.run(`UPDATE official_lecture SET title = ?, updated_at = ? WHERE id = ?`, [v.title, now, lecture.id]);
            ctx.db.run(`UPDATE source SET title = ?, updated_at = ? WHERE id = ?`, [v.title, now, lecture.source_id]);
            result_ar = `صار عنوان المحاضرة «${v.title}».`;
          }
          settle('accepted');
          ctx.audit.record({ entityType: 'official_lecture', entityId: lecture.id, action: 'review_accepted', summary: `أكّد المشرف ${label}`, before: { lecture_no: lecture.lecture_no, held_on: lecture.held_on, title: lecture.title }, after: { suggestion_id: s.id, value: v } });
        });
      }
    }
    const after = this.item(getSuggestion(ctx, s.id)) ?? before;
    return { item: after, result_ar, ...(new_version ? { new_version } : {}) };
  }

  /**
   * «هذا إصدار جديد من X»: the upload's version becomes a new DRAFT version of X from the same stored file (no byte
   * copy), processed in the space like any upload; the duplicate draft is withdrawn as «replaced». A published lecture is
   * never folded into another one here (its students hold copies of it): the moderator withdraws it first.
   */
  private acceptNewVersion(
    scope: SpaceScope,
    s: ImportSuggestionView,
    v: Extract<ImportSuggestionValue, { field: 'new_version_of' }>,
    upload: LectureRow | null,
  ): { result_ar: string; new_version: NonNullable<DecideSubjectReviewResponse['new_version']> } {
    const { ctx } = this;
    const target = lectureOfSource(ctx, v.source_id);
    if (!target || !upload || !s.version_id) throw new AppError('CONFLICT', 'لم تعد إحدى المحاضرتين موجودة؛ لم يتغير شيء.', 409);
    if (target.status === 'withdrawn') throw new AppError('CONFLICT', `سُحبت «${target.title}»؛ لا يُضاف إليها إصدار.`, 409);
    if (upload.status === 'published' || upload.head_version_id) throw new AppError('CONFLICT', `«${upload.title}» منشورة وللطلاب نسخ منها؛ اسحبها أولًا ثم ارفع ملفها إصدارًا جديدًا من «${target.title}».`, 409);
    const up = ctx.db.get<{ id: string; file_id: string | null; original_file_id: string | null; display_file_id: string | null; content_hash: string; mime: string; file_name: string | null; format: string; page_count: number | null; pagination: string }>(
      'SELECT id, file_id, original_file_id, display_file_id, content_hash, mime, file_name, format, page_count, pagination FROM source_version WHERE id = ?',
      [s.version_id],
    );
    if (!up) throw new AppError('CONFLICT', 'لم يعد الملف المرفوع موجودًا؛ لم يتغير شيء.', 409);
    const same = ctx.db.get<{ version_no: number }>('SELECT version_no FROM source_version WHERE source_id = ? AND content_hash = ?', [target.source_id, up.content_hash]);
    if (same) throw new AppError('CONFLICT', `هذا الملف مطابق للإصدار ${same.version_no} من «${target.title}»؛ لم يُنشأ إصدار جديد.`, 409);
    const uploader = ctx.db.get<{ uploaded_by: string }>('SELECT uploaded_by FROM official_version_upload WHERE version_id = ?', [up.id])?.uploaded_by ?? upload.uploaded_by;
    const now = ctx.clock.now();
    const versionId = newId(now);
    let versionNo = 0;
    ctx.db.tx(() => {
      const prev = ctx.db.get<{ id: string } | undefined>('SELECT id FROM source_version WHERE source_id = ? ORDER BY version_no DESC LIMIT 1', [target.source_id]);
      versionNo = (ctx.db.get<{ m: number | null }>('SELECT MAX(version_no) AS m FROM source_version WHERE source_id = ?', [target.source_id])?.m ?? 0) + 1;
      ctx.db.run(
        `INSERT INTO source_version (id, source_id, version_no, kind, derived_from_version_id, file_id, original_file_id, content_hash, mime, file_name, format,
           page_count, pagination, processing_status, note, created_at)
         VALUES (?, ?, ?, 'replacement', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        [versionId, target.source_id, versionNo, prev?.id ?? null, up.file_id, up.original_file_id, up.content_hash, up.mime, up.file_name, up.format, up.page_count, up.pagination, `أُضيف إصدارًا جديدًا من الملف المرفوع «${up.file_name ?? upload.title}» بعد تأكيد المشرف.`, now],
      );
      // image sets carry their pages from the upload (documents get pages from processing)
      for (const p of ctx.db.all<{ page_index: number; width: number | null; height: number | null; unit: string | null; render_file_id: string | null; section_key: string | null }>(
        `SELECT page_index, width, height, unit, render_file_id, section_key FROM source_page WHERE version_id = ? AND kind = 'image' ORDER BY page_index`,
        [up.id],
      )) {
        ctx.db.run(`INSERT INTO source_page (id, version_id, page_index, kind, width, height, unit, render_file_id, section_key, created_at, updated_at) VALUES (?, ?, ?, 'image', ?, ?, ?, ?, ?, ?, ?)`, [
          newId(now),
          versionId,
          p.page_index,
          p.width,
          p.height,
          p.unit,
          p.render_file_id,
          p.section_key,
          now,
          now,
        ]);
      }
      // who uploaded this version: the person who uploaded the file (shown on every official file, AOS-18.18)
      ctx.db.run('INSERT INTO official_version_upload (version_id, lecture_id, uploaded_by, kind, created_at) VALUES (?, ?, ?, ?, ?)', [versionId, target.id, uploader, 'upload', now]);
      ctx.db.run('UPDATE official_lecture SET updated_at = ? WHERE id = ?', [now, target.id]);
      // the duplicate draft leaves: students never saw it (a withdrawn never-published lecture stays a moderators' row)
      ctx.db.run(
        `UPDATE official_lecture SET status = 'withdrawn', withdrawn_reason = 'replaced', withdrawn_note = ?, withdrawn_by = ?, withdrawn_at = ?, updated_at = ? WHERE id = ?`,
        [`أُضيف ملفها إصدارًا جديدًا (${versionNo}) من «${target.title}».`, scope.viewer.userId, now, now, upload.id],
      );
      appendSubjectEvent(ctx, { subjectNodeId: target.subject_node_id, kind: 'version_published', refType: 'official_lecture', refId: target.id, title: `إصدار جديد بانتظار النشر: «${target.title}» — الإصدار ${versionNo}`, moderatorsOnly: true });
      ctx.audit.record({
        entityType: 'official_lecture',
        entityId: target.id,
        action: 'new_version',
        summary: `إصدار جديد (${versionNo}) من «${target.title}» من ملف «${upload.title}» بعد تأكيد المشرف`,
        after: { version_id: versionId, from_lecture_id: upload.id, from_version_id: up.id, suggestion_id: s.id },
      });
    });
    const job = finishProcessingSetup(ctx, versionId, up.format as never, up.page_count, 'replacement');
    if (!job) throw new AppError('INTERNAL', 'أُنشئ الإصدار لكن تعذّر بدء معالجته. أعد المعالجة من «المحتوى الرسمي».', 500);
    return {
      result_ar: `أُضيف الملف كالإصدار ${versionNo} من «${target.title}» (مسودة). انشره بعد انتهاء معالجته ليصل إلى طلابه، ويُخبَر من يدرسها. سُحبت المسودة المكررة «${upload.title}» ولم يرها الطلاب.`,
      new_version: { lecture_id: target.id, version_id: versionId, version_no: versionNo },
    };
  }
}

/**
 * After every identity analysis in a SPACE: a CERTAIN detected number fills an official lecture that has none
 * (origin «detected»), likewise an empty date. A moderator's value, or a number a moderator cleared, is never touched;
 * nothing is ever cleared by analysis. Uncertain values only wait in the review queue.
 */
export function mirrorDetectedIdentity(ctx: AppContext, sourceId: string): void {
  const b = ctx.binding.current() ?? ctx.binding.harnessDefault();
  if (!b || b.kind !== 'space') return;
  const l = ctx.db.get<LectureRow>('SELECT * FROM official_lecture WHERE source_id = ?', [sourceId]);
  if (!l || l.status === 'withdrawn') return;
  const s = ctx.db.get<{ lecture_no: number | null; lecture_no_origin: string | null; held_on: string | null; held_on_origin: string | null }>(
    'SELECT lecture_no, lecture_no_origin, held_on, held_on_origin FROM source WHERE id = ?',
    [sourceId],
  );
  if (!s) return;
  const now = ctx.clock.now();
  if (l.lecture_no === null && l.lecture_no_origin === null && s.lecture_no !== null && s.lecture_no_origin === 'detected') {
    ctx.db.run(`UPDATE official_lecture SET lecture_no = ?, lecture_no_origin = 'detected', updated_at = ? WHERE id = ? AND lecture_no IS NULL AND lecture_no_origin IS NULL`, [s.lecture_no, now, l.id]);
    ctx.audit.record({ entityType: 'official_lecture', entityId: l.id, action: 'identity', summary: `اكتُشف رقم المحاضرة ${s.lecture_no} تلقائيًا من ملفها`, after: { lecture_no: s.lecture_no, lecture_no_origin: 'detected' }, actor: 'job' });
  }
  if (l.held_on === null && s.held_on !== null && s.held_on_origin === 'detected') {
    ctx.db.run('UPDATE official_lecture SET held_on = ?, updated_at = ? WHERE id = ? AND held_on IS NULL', [s.held_on, now, l.id]);
  }
}
