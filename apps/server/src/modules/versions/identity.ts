// Lecture identity and the uploader's review queue (PRD AOS-3.2…3.5, 3.7, 3.11, 3.18, 19H.2).
//
// Rules (each with a test in test/versions/*):
//  * A CERTAIN lecture number / date is stored with origin 'detected' (suggestion status 'applied'); everything else
//    — uncertain values, titles, subjects, «new version of …» — waits as an OPEN suggestion with no downstream effect.
//  * A human decision (origin 'owner' / 'moderator', or a rejected suggestion) is never overridden by a later analysis:
//    (source, field, value) is unique, so a rejected value is remembered and never proposed again.
//  * Detection reads only this database (the caller's own library); nothing leaves it.
import {
  IMPORT_SUGGESTION_FIELD_LABELS_AR,
  type DecideSuggestionResponse,
  type ImportSuggestionField,
  type ImportSuggestionStatus,
  type ImportSuggestionValue,
  type ImportSuggestionView,
  type LectureIdentityView,
  type LectureNoOrigin,
  type SuggestionCertainty,
  type UpdateLectureIdentityRequest,
} from '@medlevo/shared';
import type { AppContext } from '../../context';
import { fromJson, toJson } from '../../db/db';
import { AppError } from '../../lib/errors';
import { newId } from '../../lib/ids';
import { onSourceVersionChanged } from '../evidence/dependencies';
import { pathTo } from '../library/service';
import { detectLectureDate, detectLectureNumber, IDENTITY_ALGO, proposeTitle, suggestSubjects, type SubjectNode } from '../sources/classify';
import { getSourceRow, SourcesService } from '../sources/service';
import { finishProcessingSetup } from '../sources/upload';

interface SuggestionRow {
  id: string;
  source_id: string;
  version_id: string | null;
  field: ImportSuggestionField;
  value_json: string;
  value_key: string;
  certainty: SuggestionCertainty;
  reasons_json: string;
  status: ImportSuggestionStatus;
  algo: string;
  decided_at: number | null;
  created_at: number;
  source_title?: string;
}

interface IdentityRow {
  id: string;
  title: string;
  node_id: string | null;
  deleted_at: number | null;
  current_version_id: string | null;
  frozen_version_id: string | null;
  lecture_no: number | null;
  lecture_no_origin: LectureNoOrigin | null;
  held_on: string | null;
  held_on_origin: LectureNoOrigin | null;
  is_stub: number;
}

function identityRow(ctx: AppContext, sourceId: string): IdentityRow {
  const r = ctx.db.get<IdentityRow>(
    'SELECT id, title, node_id, deleted_at, current_version_id, frozen_version_id, lecture_no, lecture_no_origin, held_on, held_on_origin, is_stub FROM source WHERE id = ?',
    [sourceId],
  );
  if (!r) throw new AppError('NOT_FOUND', 'المصدر غير موجود.', 404);
  return r;
}

export function identityView(ctx: AppContext, sourceId: string): LectureIdentityView {
  const r = identityRow(ctx, sourceId);
  const first = ctx.db.get<{ file_name: string | null }>('SELECT file_name FROM source_version WHERE source_id = ? ORDER BY version_no LIMIT 1', [sourceId]);
  return {
    source_id: r.id,
    title: r.title,
    original_file_name: first?.file_name ?? null,
    lecture_no: r.lecture_no,
    lecture_no_origin: r.lecture_no_origin,
    held_on: r.held_on,
    held_on_origin: r.held_on_origin,
    is_stub: r.is_stub === 1,
  };
}

function effectAr(v: ImportSuggestionValue): string {
  switch (v.field) {
    case 'lecture_no':
      return `يُحفظ رقم المحاضرة ${v.lecture_no} كقرار منك ويُستخدم في الترتيب «حسب الرقم». لا يتغير شيء آخر.`;
    case 'held_on':
      return `يُحفظ تاريخ المحاضرة ${v.held_on} كقرار منك ويُستخدم في الترتيب «حسب التاريخ». لا يتغير شيء آخر.`;
    case 'title':
      return `يصبح اسم المصدر «${v.title}». يبقى اسم الملف الأصلي محفوظًا في النسخة.`;
    case 'subject':
      return `يُنقل المصدر إلى «${v.path.join(' / ')}». لا يُحذف شيء ولا تتغير ملاحظاتك.`;
    case 'new_version_of':
      return `يُضاف هذا الملف كإصدار جديد من «${v.title}» وتبقى نسخه السابقة كما هي مع ملاحظاتك عليها. يُنقل الملف المرفوع إلى سلة المحذوفات إن لم يكن عليه شيء منك (كتابة أو ملاحظات أو بطاقات أو تسجيلات)، وإلا يبقى في مكانه.`;
  }
}

export function suggestionView(row: SuggestionRow, sourceTitle?: string): ImportSuggestionView {
  const value = fromJson<ImportSuggestionValue>(row.value_json)!;
  return {
    id: row.id,
    source_id: row.source_id,
    source_title: sourceTitle ?? row.source_title ?? '',
    version_id: row.version_id,
    field: row.field,
    value,
    certainty: row.certainty,
    status: row.status,
    reasons_ar: fromJson<string[]>(row.reasons_json, []) ?? [],
    effect_ar: effectAr(value),
    created_at: row.created_at,
    decided_at: row.decided_at,
  };
}

const SELECT_SUGGESTION = `SELECT g.*, s.title AS source_title FROM import_suggestion g JOIN source s ON s.id = g.source_id`;

export function listSuggestions(ctx: AppContext, opts: { sourceId?: string; status?: ImportSuggestionStatus | 'open_or_applied' } = {}): ImportSuggestionView[] {
  const where: string[] = ['s.deleted_at IS NULL'];
  const params: unknown[] = [];
  if (opts.sourceId) {
    where.length = 0; // a source's own screen lists its suggestions even while it is in the trash
    where.push('g.source_id = ?');
    params.push(opts.sourceId);
  }
  if (opts.status === 'open_or_applied') where.push(`g.status IN ('open','applied')`);
  else if (opts.status) {
    where.push('g.status = ?');
    params.push(opts.status);
  }
  const order = `CASE g.status WHEN 'open' THEN 0 WHEN 'applied' THEN 1 ELSE 2 END, CASE g.field WHEN 'new_version_of' THEN 0 WHEN 'lecture_no' THEN 1 WHEN 'held_on' THEN 2 WHEN 'subject' THEN 3 ELSE 4 END, g.created_at DESC, g.id`;
  return ctx.db.all<SuggestionRow>(`${SELECT_SUGGESTION} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT 500`, params).map((r) => suggestionView(r));
}

export function getSuggestion(ctx: AppContext, id: string): ImportSuggestionView {
  const row = ctx.db.get<SuggestionRow>(`${SELECT_SUGGESTION} WHERE g.id = ?`, [id]);
  if (!row) throw new AppError('NOT_FOUND', 'الاقتراح غير موجود.', 404);
  return suggestionView(row);
}

/**
 * Record a suggestion. Returns the stored row's status: an existing (source, field, value) keeps its status (a
 * rejected value stays rejected; an accepted one stays accepted), except an `open` / `superseded` one that is refreshed.
 */
function upsertSuggestion(
  ctx: AppContext,
  s: { sourceId: string; versionId: string | null; value: ImportSuggestionValue; key: string; certainty: SuggestionCertainty; reasons: string[]; status: 'open' | 'applied' },
): ImportSuggestionStatus {
  const now = ctx.clock.now();
  const existing = ctx.db.get<{ id: string; status: ImportSuggestionStatus }>('SELECT id, status FROM import_suggestion WHERE source_id = ? AND field = ? AND value_key = ?', [s.sourceId, s.value.field, s.key]);
  if (existing) {
    if (existing.status === 'open' || existing.status === 'superseded' || existing.status === 'applied') {
      ctx.db.run('UPDATE import_suggestion SET version_id = ?, value_json = ?, certainty = ?, reasons_json = ?, status = ?, algo = ?, updated_at = ? WHERE id = ?', [
        s.versionId,
        toJson(s.value),
        s.certainty,
        toJson(s.reasons),
        s.status,
        IDENTITY_ALGO,
        now,
        existing.id,
      ]);
      return s.status;
    }
    return existing.status;
  }
  ctx.db.run(
    `INSERT INTO import_suggestion (id, source_id, version_id, field, value_json, value_key, certainty, reasons_json, status, algo, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [newId(now), s.sourceId, s.versionId, s.value.field, toJson(s.value), s.key, s.certainty, toJson(s.reasons), s.status, IDENTITY_ALGO, now, now],
  );
  return s.status;
}

/** Open / applied suggestions of a field that this analysis no longer finds become `superseded`. */
function supersedeOthers(ctx: AppContext, sourceId: string, field: ImportSuggestionField, keepKeys: string[]): void {
  const keep = keepKeys.length ? `AND value_key NOT IN (${keepKeys.map(() => '?').join(',')})` : '';
  ctx.db.run(`UPDATE import_suggestion SET status = 'superseded', updated_at = ? WHERE source_id = ? AND field = ? AND status IN ('open','applied') ${keep}`, [
    ctx.clock.now(),
    sourceId,
    field,
    ...keepKeys,
  ]);
}

/** Text of the first pages (all region kinds, a header often carries «Lecture 5») and the first heading. */
function firstPages(ctx: AppContext, versionId: string): { text: string; heading: string | null; cover: string } {
  const rows = ctx.db.all<{ page_index: number; kind: string; text: string | null }>(
    `SELECT p.page_index, r.kind, r.text FROM source_region r JOIN source_page p ON p.id = r.page_id
      WHERE r.version_id = ? AND p.page_index < 2 AND r.status <> 'rejected' AND r.text IS NOT NULL
      ORDER BY p.page_index, r.reading_order`,
    [versionId],
  );
  const text = rows.map((r) => r.text!).join('\n').slice(0, 20_000);
  const cover = rows.filter((r) => r.page_index === 0).map((r) => r.text!).join('\n').slice(0, 4000);
  const heading = rows.find((r) => r.page_index === 0 && r.kind === 'heading' && (r.text ?? '').trim().length >= 4)?.text?.trim() ?? null;
  return { text, heading, cover };
}

/** Live subject / course folders (with their path) a source could be placed in. */
function subjectNodes(ctx: AppContext): SubjectNode[] {
  const nodes = ctx.db.all<{ id: string; title: string; kind: string }>(`SELECT id, title, kind FROM library_node WHERE deleted_at IS NULL AND kind IN ('subject','course') ORDER BY title LIMIT 500`);
  return nodes.map((n) => ({ ...n, path: pathTo(ctx, n.id).map((p) => p.title) }));
}

/**
 * (review) A value an earlier analysis stored as CERTAIN that the latest analysis contradicts (an uncertain, different
 * value) is withdrawn: an uncertain value has no downstream effect (AOS-3.18), and neither has a contradicted one.
 * Owner / moderator values are never touched; with no evidence at all the stored value stays.
 */
function withdrawDetected(ctx: AppContext, src: IdentityRow, field: 'lecture_no' | 'held_on', jobId: string | null): void {
  const origin = field === 'lecture_no' ? src.lecture_no_origin : src.held_on_origin;
  const value = field === 'lecture_no' ? src.lecture_no : src.held_on;
  if (origin !== 'detected' || value === null) return;
  const col = field === 'lecture_no' ? 'lecture_no' : 'held_on';
  ctx.db.run(`UPDATE source SET ${col} = NULL, ${col}_origin = NULL, updated_at = ? WHERE id = ?`, [ctx.clock.now(), src.id]);
  ctx.db.run(`UPDATE import_suggestion SET status = 'superseded', updated_at = ? WHERE source_id = ? AND field = ? AND status = 'applied'`, [ctx.clock.now(), src.id, field]);
  ctx.audit.record({
    entityType: 'source',
    entityId: src.id,
    action: 'identity',
    summary: field === 'lecture_no' ? `لم يعد رقم المحاضرة المكتشف (${value}) مؤكدًا؛ أُزيل حتى تؤكد رقمًا` : `لم يعد تاريخ المحاضرة المكتشف (${value}) مؤكدًا؛ أُزيل حتى تؤكد تاريخًا`,
    before: { [col]: value, [`${col}_origin`]: origin },
    after: { [col]: null, [`${col}_origin`]: null },
    actor: 'job',
    ...(jobId ? { jobId } : {}),
  });
}

export interface IdentityAnalysis {
  lecture_no: 'stored' | 'proposed' | 'kept_owner' | 'none';
  held_on: 'stored' | 'proposed' | 'kept_owner' | 'none';
  title: boolean;
  subjects: number;
}

/** (Phase 1 completion C2) Called after every identity analysis of a source (in the bound database). */
type IdentityObserver = (ctx: AppContext, sourceId: string) => void;
const identityObservers: IdentityObserver[] = [];
export function onIdentityAnalyzed(fn: IdentityObserver): () => void {
  identityObservers.push(fn);
  return () => {
    const i = identityObservers.indexOf(fn);
    if (i >= 0) identityObservers.splice(i, 1);
  };
}

/**
 * Detect lecture number, date, title and subject for the version the owner studies (current or frozen) and store the
 * results by the rules above. Idempotent; called by the analysis job after every processing run.
 */
export function analyzeIdentity(ctx: AppContext, sourceId: string, versionId: string, jobId: string | null): IdentityAnalysis | null {
  const src = identityRow(ctx, sourceId);
  if (src.deleted_at !== null || src.is_stub === 1) return null;
  if ((src.frozen_version_id ?? src.current_version_id) !== versionId && src.current_version_id !== versionId) return null;
  const v = ctx.db.get<{ file_name: string | null; format: string }>('SELECT file_name, format FROM source_version WHERE id = ?', [versionId]);
  if (!v || v.format === 'audio') return null;
  const fileName = v.file_name ?? '';
  const pages = firstPages(ctx, versionId);
  const now = ctx.clock.now();
  const out: IdentityAnalysis = { lecture_no: 'none', held_on: 'none', title: false, subjects: 0 };

  ctx.db.tx(() => {
    // ── lecture number ──
    const num = detectLectureNumber(fileName, pages.text);
    const ownerNo = src.lecture_no_origin === 'owner' || src.lecture_no_origin === 'moderator';
    if (ownerNo) out.lecture_no = 'kept_owner';
    else if (num) {
      const certain = num.certainty === 'certain';
      // (review) an uncertain value equal to the one an earlier analysis stored stays «applied» (it IS in effect, the
      // owner sees it as detected and can remove it); a stored value the evidence now contradicts is withdrawn
      const storedSame = src.lecture_no_origin === 'detected' && src.lecture_no === num.value;
      const status = upsertSuggestion(ctx, { sourceId, versionId, value: { field: 'lecture_no', lecture_no: num.value }, key: String(num.value), certainty: num.certainty, reasons: num.reasons_ar, status: certain || storedSame ? 'applied' : 'open' });
      supersedeOthers(ctx, sourceId, 'lecture_no', [String(num.value)]);
      if (!certain && !storedSame) withdrawDetected(ctx, src, 'lecture_no', jobId);
      if (certain && status === 'applied') {
        if (src.lecture_no !== num.value || src.lecture_no_origin !== 'detected') {
          ctx.db.run(`UPDATE source SET lecture_no = ?, lecture_no_origin = 'detected', updated_at = ? WHERE id = ?`, [num.value, now, sourceId]);
          ctx.audit.record({
            entityType: 'source',
            entityId: sourceId,
            action: 'identity',
            summary: `اكتُشف رقم المحاضرة ${num.value} تلقائيًا`,
            before: { lecture_no: src.lecture_no, lecture_no_origin: src.lecture_no_origin },
            after: { lecture_no: num.value, lecture_no_origin: 'detected' },
            actor: 'job',
            ...(jobId ? { jobId } : {}),
          });
        }
        out.lecture_no = 'stored';
      } else out.lecture_no = status === 'open' ? 'proposed' : status === 'applied' ? 'stored' : 'none';
    } else supersedeOthers(ctx, sourceId, 'lecture_no', []);

    // ── session date ──
    const date = detectLectureDate(fileName, pages.text);
    const ownerDate = src.held_on_origin === 'owner' || src.held_on_origin === 'moderator';
    if (ownerDate) out.held_on = 'kept_owner';
    else if (date) {
      const certain = date.certainty === 'certain';
      const storedSame = src.held_on_origin === 'detected' && src.held_on === date.value;
      const status = upsertSuggestion(ctx, { sourceId, versionId, value: { field: 'held_on', held_on: date.value }, key: date.value, certainty: date.certainty, reasons: date.reasons_ar, status: certain || storedSame ? 'applied' : 'open' });
      supersedeOthers(ctx, sourceId, 'held_on', [date.value]);
      if (!certain && !storedSame) withdrawDetected(ctx, src, 'held_on', jobId);
      if (certain && status === 'applied') {
        if (src.held_on !== date.value || src.held_on_origin !== 'detected') {
          ctx.db.run(`UPDATE source SET held_on = ?, held_on_origin = 'detected', updated_at = ? WHERE id = ?`, [date.value, now, sourceId]);
          ctx.audit.record({
            entityType: 'source',
            entityId: sourceId,
            action: 'identity',
            summary: `اكتُشف تاريخ المحاضرة ${date.value} تلقائيًا`,
            before: { held_on: src.held_on, held_on_origin: src.held_on_origin },
            after: { held_on: date.value, held_on_origin: 'detected' },
            actor: 'job',
            ...(jobId ? { jobId } : {}),
          });
        }
        out.held_on = 'stored';
      } else out.held_on = status === 'open' ? 'proposed' : status === 'applied' ? 'stored' : 'none';
    } else supersedeOthers(ctx, sourceId, 'held_on', []);

    // ── title (always held for confirmation) ──
    const title = proposeTitle(fileName, pages.heading, src.title);
    if (title) {
      const key = title.value.toLowerCase().replace(/\s+/g, ' ').slice(0, 300);
      out.title = upsertSuggestion(ctx, { sourceId, versionId, value: { field: 'title', title: title.value }, key, certainty: title.certainty, reasons: title.reasons_ar, status: 'open' }) === 'open';
      supersedeOthers(ctx, sourceId, 'title', [key]);
    } else supersedeOthers(ctx, sourceId, 'title', []);

    // ── subject placement (never applied automatically) ──
    const containing = new Set(pathTo(ctx, src.node_id).map((p) => p.id));
    const subjects = suggestSubjects(fileName, pages.cover, subjectNodes(ctx).filter((n) => !containing.has(n.id))).slice(0, 2);
    const keys: string[] = [];
    for (const s of subjects) {
      keys.push(s.node.id);
      const st = upsertSuggestion(ctx, {
        sourceId,
        versionId,
        value: { field: 'subject', node_id: s.node.id, node_title: s.node.title, node_kind: s.node.kind, path: s.node.path },
        key: s.node.id,
        certainty: s.certainty,
        reasons: s.reasons_ar,
        status: 'open',
      });
      if (st === 'open') out.subjects++;
    }
    supersedeOthers(ctx, sourceId, 'subject', keys);
  });
  // (Phase 1 completion C2) observers of a finished analysis — the lectures module mirrors a CERTAIN detected number /
  // date onto an official lecture that has none (an uncertain one waits in the subject's review queue, AOS-3.18)
  for (const fn of identityObservers) {
    try {
      fn(ctx, sourceId);
    } catch (e) {
      ctx.log.warn({ err: e instanceof Error ? e.message : String(e), sourceId }, 'an identity observer failed');
    }
  }
  return out;
}

/** Store a «new version of …» proposal (always held for confirmation). Returns false when the owner rejected it before. */
export function proposeNewVersion(
  ctx: AppContext,
  uploadSourceId: string,
  uploadVersionId: string,
  value: Extract<ImportSuggestionValue, { field: 'new_version_of' }>,
  reasons: string[],
): boolean {
  const key = `${value.source_id}:${value.version_id}`;
  let st: ImportSuggestionStatus = 'open';
  ctx.db.tx(() => {
    st = upsertSuggestion(ctx, { sourceId: uploadSourceId, versionId: uploadVersionId, value, key, certainty: 'uncertain', reasons, status: 'open' });
    supersedeOthers(ctx, uploadSourceId, 'new_version_of', [key]);
  });
  return st === 'open';
}

// ───────────────────────────── owner edits and decisions ─────────────────────────────
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
function validDate(s: string): boolean {
  const m = ISO_DATE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  return d.getUTCFullYear() === +m[1]! && d.getUTCMonth() === +m[2]! - 1 && d.getUTCDate() === +m[3]!;
}

/** The owner's own number / date: stored with origin 'owner' (null clears it and stops detection for the field). */
export function updateIdentity(ctx: AppContext, sourceId: string, p: UpdateLectureIdentityRequest): LectureIdentityView {
  const src = identityRow(ctx, sourceId);
  if (src.deleted_at !== null) throw new AppError('CONFLICT', 'هذا المصدر في سلة المحذوفات. استعده أولًا.', 409);
  if (p.held_on !== undefined && p.held_on !== null && !validDate(p.held_on)) throw new AppError('VALIDATION_FAILED', 'التاريخ غير صحيح. استخدم الصيغة YYYY-MM-DD.', 400);
  const now = ctx.clock.now();
  ctx.db.tx(() => {
    const before = { lecture_no: src.lecture_no, lecture_no_origin: src.lecture_no_origin, held_on: src.held_on, held_on_origin: src.held_on_origin };
    if (p.lecture_no !== undefined) {
      ctx.db.run(`UPDATE source SET lecture_no = ?, lecture_no_origin = 'owner', updated_at = ? WHERE id = ?`, [p.lecture_no, now, sourceId]);
      ctx.db.run(`UPDATE import_suggestion SET status = 'superseded', updated_at = ? WHERE source_id = ? AND field = 'lecture_no' AND status IN ('open','applied')`, [now, sourceId]);
    }
    if (p.held_on !== undefined) {
      ctx.db.run(`UPDATE source SET held_on = ?, held_on_origin = 'owner', updated_at = ? WHERE id = ?`, [p.held_on, now, sourceId]);
      ctx.db.run(`UPDATE import_suggestion SET status = 'superseded', updated_at = ? WHERE source_id = ? AND field = 'held_on' AND status IN ('open','applied')`, [now, sourceId]);
    }
    ctx.audit.record({ entityType: 'source', entityId: sourceId, action: 'identity', summary: 'عدّلت رقم المحاضرة أو تاريخها', before, after: { lecture_no: p.lecture_no, held_on: p.held_on } });
  });
  return identityView(ctx, sourceId);
}

/** Personal items written on a source (decides whether an upload merged as a new version may go to the trash). */
function personalItemCount(ctx: AppContext, sourceId: string): number {
  const n = (sql: string) => ctx.db.get<{ n: number }>(sql, [sourceId])?.n ?? 0;
  return (
    n(`SELECT COUNT(*) AS n FROM annotation a JOIN annotation_target t ON t.annotation_id = a.id AND t.target_type = 'source_page'
         JOIN source_page p ON p.id = t.target_id JOIN source_version v ON v.id = p.version_id WHERE v.source_id = ? AND a.deleted_at IS NULL`) +
    n(`SELECT COUNT(*) AS n FROM note WHERE source_id = ? AND deleted_at IS NULL`) +
    n(`SELECT COUNT(*) AS n FROM note_page WHERE source_id = ? AND deleted_at IS NULL`) +
    // (review) the owner's cards (and their review history) and recordings made while this file was open are theirs too
    n(`SELECT COUNT(*) AS n FROM flashcard WHERE source_id = ? AND deleted_at IS NULL`) +
    n(`SELECT COUNT(*) AS n FROM audio_recording WHERE linked_source_id = ?`)
  );
}

/**
 * Accept «this upload is a new version of lecture X»: a new `replacement` version of X made from the SAME stored file
 * (no byte copy), processed like any replacement (its page map from X's previous version follows). X's earlier versions
 * and every note on them are untouched. The uploaded source goes to the trash (restorable) only when nothing personal
 * was written on it.
 */
function acceptNewVersion(ctx: AppContext, s: ImportSuggestionView): NonNullable<DecideSuggestionResponse['new_version']> & { result_ar: string } {
  const v = s.value as Extract<ImportSuggestionValue, { field: 'new_version_of' }>;
  const target = getSourceRow(ctx, v.source_id);
  if (target.deleted_at !== null) throw new AppError('CONFLICT', `المحاضرة «${target.title}» في سلة المحذوفات. استعدها أولًا.`, 409);
  if (!s.version_id) throw new AppError('CONFLICT', 'لم تعد النسخة المرفوعة موجودة.', 409);
  const up = ctx.db.get<{ id: string; source_id: string; file_id: string | null; original_file_id: string | null; display_file_id: string | null; content_hash: string; mime: string; file_name: string | null; format: string; page_count: number | null; pagination: string }>(
    'SELECT id, source_id, file_id, original_file_id, display_file_id, content_hash, mime, file_name, format, page_count, pagination FROM source_version WHERE id = ?',
    [s.version_id],
  );
  if (!up) throw new AppError('CONFLICT', 'لم تعد النسخة المرفوعة موجودة.', 409);
  const same = ctx.db.get<{ version_no: number }>('SELECT version_no FROM source_version WHERE source_id = ? AND content_hash = ?', [v.source_id, up.content_hash]);
  if (same) throw new AppError('CONFLICT', `هذا الملف مطابق للنسخة ${same.version_no} من «${target.title}»؛ لم تُنشأ نسخة جديدة.`, 409);
  const now = ctx.clock.now();
  const versionId = newId(now);
  let versionNo = 0;
  ctx.db.tx(() => {
    const prev = ctx.db.get<{ current_version_id: string | null }>('SELECT current_version_id FROM source WHERE id = ?', [v.source_id])!.current_version_id;
    versionNo = (ctx.db.get<{ m: number }>('SELECT MAX(version_no) AS m FROM source_version WHERE source_id = ?', [v.source_id])?.m ?? 0) + 1;
    const note = `أُضيفت كإصدار جديد من الملف المرفوع «${up.file_name ?? s.source_title}» بعد تأكيدك.`;
    ctx.db.run(
      `INSERT INTO source_version (id, source_id, version_no, kind, derived_from_version_id, file_id, original_file_id, content_hash, mime, file_name, format,
         page_count, pagination, processing_status, note, created_at)
       VALUES (?, ?, ?, 'replacement', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      [versionId, v.source_id, versionNo, prev, up.file_id, up.original_file_id, up.content_hash, up.mime, up.file_name, up.format, up.page_count, up.pagination, note, now],
    );
    // image sets carry their pages from the upload (documents get pages from processing)
    for (const p of ctx.db.all<{ page_index: number; width: number | null; height: number | null; unit: string | null; render_file_id: string | null; section_key: string | null }>(
      `SELECT page_index, width, height, unit, render_file_id, section_key FROM source_page WHERE version_id = ? AND kind = 'image' ORDER BY page_index`,
      [up.id],
    )) {
      ctx.db.run(
        `INSERT INTO source_page (id, version_id, page_index, kind, width, height, unit, render_file_id, section_key, created_at, updated_at) VALUES (?, ?, ?, 'image', ?, ?, ?, ?, ?, ?, ?)`,
        [newId(now), versionId, p.page_index, p.width, p.height, p.unit, p.render_file_id, p.section_key, now, now],
      );
    }
    ctx.db.run(`UPDATE source SET current_version_id = ?, processing_status = 'pending', updated_at = ? WHERE id = ?`, [versionId, now, v.source_id]);
    onSourceVersionChanged(ctx, { sourceId: v.source_id, fromVersionId: null, toVersionId: versionId, kind: 'source_replaced' });
    ctx.audit.record({
      entityType: 'source',
      entityId: v.source_id,
      action: 'new_version',
      summary: `نسخة جديدة (${versionNo}) من «${target.title}» من ملف مرفوع بعد تأكيدك`,
      before: { current_version_id: prev },
      after: { current_version_id: versionId, from_upload_source_id: s.source_id, file_name: up.file_name },
    });
  });
  finishProcessingSetup(ctx, versionId, up.format as never, up.page_count, 'replacement');
  let trashed = false;
  const upload = ctx.db.get<{ deleted_at: number | null }>('SELECT deleted_at FROM source WHERE id = ?', [s.source_id]);
  if (upload && upload.deleted_at === null && personalItemCount(ctx, s.source_id) === 0) {
    new SourcesService(ctx).trash(s.source_id);
    trashed = true;
  }
  const result_ar = trashed
    ? `أُضيف الملف كإصدار ${versionNo} من «${target.title}». نُقل الملف المرفوع إلى سلة المحذوفات (يمكنك استعادته)، لأنه لا يحمل شيئًا منك.`
    : `أُضيف الملف كإصدار ${versionNo} من «${target.title}». بقي الملف المرفوع في مكتبتك لأن عليه شيئًا منك (كتابة أو ملاحظات أو بطاقات أو تسجيلات).`;
  return { source_id: v.source_id, version_id: versionId, version_no: versionNo, upload_trashed: trashed, result_ar };
}

export function decideSuggestion(ctx: AppContext, id: string, action: 'accept' | 'reject'): DecideSuggestionResponse {
  const s = getSuggestion(ctx, id);
  if (s.status !== 'open' && s.status !== 'applied') throw new AppError('CONFLICT', 'عولج هذا الاقتراح من قبل؛ قرارك محفوظ.', 409);
  const now = ctx.clock.now();
  const label = IMPORT_SUGGESTION_FIELD_LABELS_AR[s.field];
  const v = s.value;
  let result_ar = '';
  let new_version: DecideSuggestionResponse['new_version'];
  const svc = new SourcesService(ctx);
  const src = identityRow(ctx, s.source_id);
  if (src.deleted_at !== null && action === 'accept') throw new AppError('CONFLICT', 'هذا المصدر في سلة المحذوفات. استعده أولًا.', 409);

  if (action === 'reject') {
    let clearedStored = false;
    ctx.db.tx(() => {
      ctx.db.run(`UPDATE import_suggestion SET status = 'rejected', decided_at = ?, updated_at = ? WHERE id = ?`, [now, now, id]);
      // rejecting a value that is stored automatically clears it — and the owner's «no value» is then a decision.
      // (review) whatever the suggestion's status: the stored detected value IS the rejected value
      if (v.field === 'lecture_no' && src.lecture_no === v.lecture_no && src.lecture_no_origin === 'detected') {
        ctx.db.run(`UPDATE source SET lecture_no = NULL, lecture_no_origin = 'owner', updated_at = ? WHERE id = ?`, [now, s.source_id]);
        clearedStored = true;
      }
      if (v.field === 'held_on' && src.held_on === v.held_on && src.held_on_origin === 'detected') {
        ctx.db.run(`UPDATE source SET held_on = NULL, held_on_origin = 'owner', updated_at = ? WHERE id = ?`, [now, s.source_id]);
        clearedStored = true;
      }
      ctx.audit.record({ entityType: 'source', entityId: s.source_id, action: 'suggestion_rejected', summary: `رفضت اقتراح ${label}`, after: { suggestion_id: id, field: s.field, value: v } });
    });
    result_ar = clearedStored ? `أُزيل ${label} المكتشف تلقائيًا، ولن يُقترح مجددًا.` : 'رُفض الاقتراح ولن يُقترح مجددًا لهذا المصدر.';
  } else {
    switch (v.field) {
      case 'lecture_no':
        ctx.db.run(`UPDATE source SET lecture_no = ?, lecture_no_origin = 'owner', updated_at = ? WHERE id = ?`, [v.lecture_no, now, s.source_id]);
        result_ar = `حُفظ رقم المحاضرة ${v.lecture_no}.`;
        break;
      case 'held_on':
        ctx.db.run(`UPDATE source SET held_on = ?, held_on_origin = 'owner', updated_at = ? WHERE id = ?`, [v.held_on, now, s.source_id]);
        result_ar = `حُفظ تاريخ المحاضرة ${v.held_on}.`;
        break;
      case 'title':
        svc.patch(s.source_id, { title: v.title });
        result_ar = `صار اسم المصدر «${v.title}».`;
        break;
      case 'subject': {
        const node = ctx.db.get<{ deleted_at: number | null }>('SELECT deleted_at FROM library_node WHERE id = ?', [v.node_id]);
        if (!node || node.deleted_at !== null) throw new AppError('CONFLICT', 'المجلد المقترح لم يعد موجودًا.', 409);
        svc.move(s.source_id, { node_id: v.node_id });
        result_ar = `نُقل المصدر إلى «${v.path.join(' / ')}».`;
        break;
      }
      case 'new_version_of': {
        const r = acceptNewVersion(ctx, s);
        result_ar = r.result_ar;
        new_version = { source_id: r.source_id, version_id: r.version_id, version_no: r.version_no, upload_trashed: r.upload_trashed };
        break;
      }
    }
    ctx.db.tx(() => {
      ctx.db.run(`UPDATE import_suggestion SET status = 'accepted', decided_at = ?, updated_at = ? WHERE id = ?`, [now, now, id]);
      // one value per field: the other open proposals of the field are answered by this decision
      ctx.db.run(`UPDATE import_suggestion SET status = 'superseded', updated_at = ? WHERE source_id = ? AND field = ? AND id <> ? AND status IN ('open','applied')`, [now, s.source_id, s.field, id]);
      if (v.field === 'lecture_no' || v.field === 'held_on') {
        ctx.audit.record({ entityType: 'source', entityId: s.source_id, action: 'identity', summary: `أكّدت ${label}`, after: { suggestion_id: id, value: v } });
      }
    });
  }
  return { suggestion: getSuggestion(ctx, id), result_ar, ...(new_version ? { new_version } : {}) };
}

