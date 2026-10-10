// Attempts (§39, §44 signals; AC-14, AC-26, AC-27) — sync entities registered with ctx.sync:
//
// 'question_attempt'  append-only by client ULID (insert-if-absent → applied | duplicate). Graded ONCE, at
//                     insertion, against the PINNED version's key (snapshotted in key_at_answer_json); a later key
//                     correction creates a new version in the questions module and never re-grades this row.
//                     Scored only when the version had a scorable key and passed validation (AC-14).
//                     hints_used / solution_viewed_before_answer are never lower than what the server served.
//                     'upsert' may only change the owner's mistake type (the answer itself is immutable).
// 'exam_attempt'      created by POST /api/exams; 'upsert' carries the full mutable state (status, timer, current
//                     index, answers, flags). Answers merge per item by their own timestamp and are never dropped;
//                     the policy can never be changed (pause only if the policy allows it); a finished attempt is
//                     immutable. Finishing materializes one question_attempt per answered item (client ids).
import { z } from 'zod';
import {
  CONFIDENCE_LEVELS,
  MISTAKE_TYPES,
  isAssessedMode,
  richTextToPlain,
  type AnswerStatus,
  type ExamAnswerState,
  type ExamAttemptDTO,
  type ExamAttemptStatus,
  type ExamTimerState,
  type MistakeType,
  type QuestionValidation,
  type RichText,
  type SyncOp,
} from '@medlevo/shared';
import type { AppContext } from '../../context';
import type { Db } from '../../db/db';
import { fromJson, toJson } from '../../db/db';
import { AppError } from '../../lib/errors';
import { scorability } from '../questions/service';
import type { SyncApplyResult, SyncEntityHandler, SyncTx } from '../sync/registry';
import { suggestMistake } from './mistakes';
import {
  attemptDTO,
  examItems,
  examPolicy,
  findAttempt,
  findQuestionAttempt,
  getExam,
  questionAttemptDTO,
  type ExamAttemptRow,
  type ExamRow,
  type QuestionAttemptRow,
} from './store';

const MAX_SKEW_MS = 5 * 60 * 1000;

// ───────── payload normalization (Dexie rows are camelCase, the contract is snake_case) ─────────
function snake(k: string): string {
  return k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

export function normalizeKeys(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const s = snake(k);
    if (s !== k && Object.prototype.hasOwnProperty.call(v, s)) continue; // the snake_case key wins
    out[s] = val;
  }
  return out;
}

const idSchema = z.string().trim().min(1).max(64);
const confidenceSchema = z.enum(CONFIDENCE_LEVELS).nullable().optional();

const attemptPayloadSchema = z.object({
  question_id: idSchema,
  question_version_id: idSchema,
  exam_attempt_id: idSchema.nullable().optional(),
  exam_item_index: z.number().int().min(0).max(10_000).nullable().optional(),
  selected_option_ids: z.array(idSchema).max(12),
  confidence: confidenceSchema,
  hints_used: z.number().int().min(0).max(20).optional(),
  solution_viewed_before_answer: z.boolean().optional(),
  time_ms: z.number().int().min(0).max(24 * 3600 * 1000).nullable().optional(),
  flagged: z.boolean().optional(),
  answered_at: z.number().int().min(0),
});
export type AttemptInsertInput = z.infer<typeof attemptPayloadSchema>;

const signalsSchema = z.object({ mistake_type: z.enum(MISTAKE_TYPES).nullable() });

function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const r = schema.safeParse(value);
  if (!r.success) {
    const where = r.error.issues[0]?.path.join('.') || 'payload';
    throw new AppError('VALIDATION_FAILED', `بيانات المزامنة غير صالحة (${where}).`, 400);
  }
  return r.data;
}

// ───────── grading ─────────
interface VersionForGrading {
  id: string;
  question_id: string;
  qtype: string;
  answer_status: AnswerStatus;
  correct_option_ids_json: string | null;
  validation_json: string | null;
  has_negation: number;
  negation_terms_json: string | null;
  item_type: string | null;
  stem_json: string;
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((x) => s.has(x));
}

/** Insert one question attempt (graded now, against its pinned version). Idempotent by id. */
export function insertQuestionAttempt(
  db: Db,
  input: AttemptInsertInput & { id: string },
  opts: { now: number; deviceId: string | null; touch: (type: string, id: string) => void },
): { row: QuestionAttemptRow; inserted: boolean; conflict?: QuestionAttemptRow } {
  const existing = findQuestionAttempt(db, input.id);
  if (existing) return { row: existing, inserted: false };

  const v = db.get<VersionForGrading>(
    `SELECT id, question_id, qtype, answer_status, correct_option_ids_json, validation_json, has_negation, negation_terms_json, item_type, stem_json
       FROM question_version WHERE id = ?`,
    [input.question_version_id],
  );
  if (!v || v.question_id !== input.question_id) throw new AppError('VALIDATION_FAILED', 'نسخة السؤال غير موجودة أو لا تخص هذا السؤال.', 400);
  const q = db.get<{ id: string }>('SELECT id FROM question WHERE id = ?', [input.question_id]);
  if (!q) throw new AppError('NOT_FOUND', 'السؤال غير موجود (ربما حُذف مصدره نهائيًا).', 404);

  const optionIds = new Set(db.all<{ id: string }>('SELECT id FROM question_option WHERE question_version_id = ?', [v.id]).map((o) => o.id));
  const selected = [...new Set(input.selected_option_ids)];
  if (selected.length === 0) throw new AppError('VALIDATION_FAILED', 'لا توجد إجابة مختارة في هذه المحاولة.', 400);
  if (selected.some((id) => !optionIds.has(id))) throw new AppError('VALIDATION_FAILED', 'الخيار المختار لا يخص نسخة السؤال المثبتة.', 400);

  // exam context: the item must pin THIS version; one attempt per item and exam attempt
  let index: number | null = input.exam_item_index ?? null;
  let exam: ExamRow | null = null;
  let budgetMs: number | null = null;
  let itemScored = true;
  let itemReason: string | null = null;
  if (input.exam_attempt_id) {
    const at = findAttempt(db, input.exam_attempt_id);
    if (!at) throw new AppError('NOT_FOUND', 'محاولة الاختبار غير موجودة على الخادم.', 404);
    exam = getExam(db, at.exam_id);
    const solutionsAtEnd = isAssessedMode(exam.mode) || examPolicy(exam).show_solution === 'at_end';
    if (solutionsAtEnd && at.status !== 'completed' && at.status !== 'abandoned') {
      // during an exam the answers live in the attempt state and are graded when it is finished (AC-19)
      throw new AppError('CONFLICT', 'في هذا الاختبار تُحفظ الإجابات في المحاولة وتُصحَّح عند إنهائه، لا سؤالًا سؤالًا.', 409);
    }
    const items = examItems(exam);
    if (index === null) index = items.findIndex((i) => i.question_version_id === v.id);
    const item = index !== null && index >= 0 ? items[index] : undefined;
    if (!item || item.question_version_id !== v.id) throw new AppError('CONFLICT', 'هذا السؤال (بهذه النسخة) ليس ضمن هذه المحاولة.', 409);
    const other = db.get<QuestionAttemptRow>('SELECT * FROM question_attempt WHERE exam_attempt_id = ? AND exam_item_index = ?', [at.id, index]);
    if (other) return { row: other, inserted: false, conflict: other };
    itemScored = item.scored;
    itemReason = item.unscored_reason_ar;
    const policy = examPolicy(exam);
    budgetMs = policy.per_question_seconds ? policy.per_question_seconds * 1000 : null;
  }

  // what the server served for this item can never be hidden (AC-27 data)
  let hints = input.hints_used ?? 0;
  let solutionViewed = input.solution_viewed_before_answer ?? false;
  if (input.exam_attempt_id && index !== null) {
    const ev = db.all<{ kind: string }>('SELECT kind FROM exam_item_event WHERE exam_attempt_id = ? AND item_index = ?', [input.exam_attempt_id, index]);
    hints = Math.max(hints, ev.filter((e) => e.kind.startsWith('hint_')).length);
    solutionViewed = solutionViewed || ev.some((e) => e.kind === 'solution_viewed');
  }

  const s = scorability({ answer_status: v.answer_status, validation_json: v.validation_json, correct_option_ids_json: v.correct_option_ids_json });
  const key = fromJson<string[] | null>(v.correct_option_ids_json, null);
  const keyUsable = s.scorable && !!key && key.length > 0;
  const isCorrect = keyUsable ? sameSet(selected, key!) : null;
  let scored = keyUsable && itemScored;
  let reason = !keyUsable ? s.reason_ar : !itemScored ? itemReason : null;
  if (scored && solutionViewed) {
    scored = false;
    reason = 'أُجيب بعد عرض الحل — لا يُحتسب في النتيجة.';
  }
  const answeredAt = Math.min(input.answered_at, opts.now + MAX_SKEW_MS);
  const negation = fromJson<string[]>(v.negation_terms_json, []) ?? [];
  const mistake = suggestMistake({
    scored,
    is_correct: isCorrect,
    confidence: input.confidence ?? null,
    time_ms: input.time_ms ?? null,
    time_budget_ms: budgetMs,
    has_negation: v.has_negation === 1,
    negation_terms: negation,
    item_type: v.item_type,
    stem: richTextToPlain(fromJson<RichText | null>(v.stem_json, null)),
    qtype: v.qtype,
  });

  db.run(
    `INSERT INTO question_attempt (id, question_id, question_version_id, exam_attempt_id, selected_option_ids_json, is_correct, scored, confidence,
       hints_used, solution_viewed_before_answer, time_ms, flagged, mistake_type, mistake_origin, device_id, answered_at, created_at,
       exam_item_index, unscored_reason, key_status_at_answer, key_at_answer_json, time_budget_ms, auto_mistake_type, auto_mistake_reason, rev, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    [
      input.id,
      input.question_id,
      v.id,
      input.exam_attempt_id ?? null,
      toJson(selected),
      isCorrect === null ? null : isCorrect ? 1 : 0,
      scored ? 1 : 0,
      input.confidence ?? null,
      hints,
      solutionViewed ? 1 : 0,
      input.time_ms ?? null,
      input.flagged ? 1 : 0,
      mistake?.type ?? null,
      mistake ? 'auto' : null,
      opts.deviceId,
      answeredAt,
      opts.now,
      index,
      scored ? null : reason,
      v.answer_status,
      key ? toJson(key) : null,
      budgetMs,
      mistake?.type ?? null,
      mistake?.reason_ar ?? null,
      opts.now,
    ],
  );
  opts.touch('question_attempt', input.id);
  return { row: findQuestionAttempt(db, input.id)!, inserted: true };
}

/** Owner edit of the mistake type (origin 'owner'); the auto suggestion stays visible next to it. */
export function setMistakeType(db: Db, attemptId: string, type: MistakeType | null, now: number, touch: (t: string, id: string) => void): QuestionAttemptRow {
  const r = findQuestionAttempt(db, attemptId);
  if (!r) throw new AppError('NOT_FOUND', 'المحاولة غير موجودة على الخادم بعد؛ ستُرسل التعديلات بعد مزامنتها.', 404);
  // only a wrong answer has a mistake type — the same rule on every path (learning PATCH, exams PATCH, sync upsert)
  if (type !== null && r.is_correct !== 0) throw new AppError('CONFLICT', 'لا يُصنَّف إلا الخطأ: هذه الإجابة ليست خاطئة.', 409);
  if (r.mistake_type === type && r.mistake_origin === 'owner') return r;
  db.run('UPDATE question_attempt SET mistake_type = ?, mistake_origin = ?, rev = rev + 1, updated_at = ? WHERE id = ?', [type, 'owner', now, attemptId]);
  touch('question_attempt', attemptId);
  return findQuestionAttempt(db, attemptId)!;
}

export function questionAttemptHandler(ctx: AppContext): SyncEntityHandler {
  const serialize = (id: string) => {
    const r = findQuestionAttempt(ctx.db, id);
    return r ? questionAttemptDTO(r) : null;
  };
  return {
    serialize,
    apply(op: SyncOp, tx: SyncTx): SyncApplyResult {
      if (op.op === 'delete') throw new AppError('CONFLICT', 'لا تُحذف محاولات الإجابة؛ هي سجل تعلمك.', 409);
      const payload = normalizeKeys(op.payload);
      if (op.op === 'upsert') {
        const { mistake_type } = parse(signalsSchema, payload);
        const before = findQuestionAttempt(tx.db, op.entity_id);
        const after = setMistakeType(tx.db, op.entity_id, mistake_type, tx.now, tx.touch);
        return { result: before && before.rev === after.rev ? 'duplicate' : 'applied', entity: questionAttemptDTO(after) };
      }
      const input = parse(attemptPayloadSchema, payload);
      const res = insertQuestionAttempt(tx.db, { ...input, id: op.entity_id }, { now: tx.now, deviceId: tx.deviceId, touch: tx.touch });
      if (res.conflict) {
        return {
          result: 'rejected',
          entity: questionAttemptDTO(res.conflict),
          detail: 'لهذا السؤال إجابة مسجلة سابقًا في هذه المحاولة؛ بقيت كما هي ولم تُستبدل.',
        };
      }
      return { result: res.inserted ? 'applied' : 'duplicate', entity: questionAttemptDTO(res.row) };
    },
  };
}

// ───────── exam attempt state ─────────
const answerSchema = z.object({
  attempt_id: idSchema,
  selected_option_ids: z.array(idSchema).max(12),
  confidence: confidenceSchema,
  at: z.number().int().min(0),
  time_ms: z.number().int().min(0).max(24 * 3600 * 1000).nullable().optional(),
  hints_used: z.number().int().min(0).max(20).optional(),
  solution_viewed_before_answer: z.boolean().optional(),
  submitted: z.boolean().optional(),
});

const examAttemptPayloadSchema = z.object({
  status: z.enum(['in_progress', 'paused', 'completed', 'abandoned']),
  elapsed_ms: z.number().int().min(0).max(30 * 24 * 3600 * 1000),
  current_index: z.number().int().min(0).max(10_000),
  answers: z.record(z.string(), z.unknown()).default({}),
  flagged: z.array(z.number().int().min(0).max(10_000)).max(1000).default([]),
  timer: z
    .object({
      item_ms: z.record(z.string(), z.number().int().min(0)).default({}),
      pauses: z.number().int().min(0).max(10_000).default(0),
      paused_at: z.number().int().nullable().default(null),
    })
    .partial()
    .default({}),
  finished_at: z.number().int().nullable().optional(),
});

function normalizeAnswer(v: unknown): ExamAnswerState | null {
  const r = answerSchema.safeParse(normalizeKeys(v));
  if (!r.success) return null;
  const a = r.data;
  return {
    attempt_id: a.attempt_id,
    selected_option_ids: [...new Set(a.selected_option_ids)],
    confidence: a.confidence ?? null,
    at: a.at,
    time_ms: a.time_ms ?? null,
    hints_used: a.hints_used ?? 0,
    solution_viewed_before_answer: a.solution_viewed_before_answer ?? false,
    submitted: a.submitted ?? false,
  };
}

const TERMINAL: ReadonlySet<ExamAttemptStatus> = new Set(['completed', 'abandoned']);

export interface ExamStateChange {
  status: ExamAttemptStatus;
  elapsed_ms: number;
  current_index: number;
  answers: Record<string, unknown>;
  flagged: number[];
  timer: Partial<ExamTimerState>;
  finished_at?: number | null;
}

/**
 * Merge an incoming state into the server copy. Returns what to write, or a rejection (with the reason).
 * Exported for unit tests.
 */
export function mergeExamState(
  exam: ExamRow,
  server: ExamAttemptDTO,
  incoming: ExamStateChange,
  now: number,
): { ok: true; next: ExamAttemptDTO; merged: boolean; dropped: number } | { ok: false; reason_ar: string } {
  const items = examItems(exam);
  const policy = examPolicy(exam);
  if (TERMINAL.has(server.status)) {
    return { ok: false, reason_ar: server.status === 'completed' ? 'انتهت هذه المحاولة؛ إجاباتها ونتيجتها ثابتة ولا تتغير.' : 'تُركت هذه المحاولة؛ لا تتغير بعد ذلك.' };
  }
  if (incoming.status === 'paused' && !policy.pause_allowed) {
    return { ok: false, reason_ar: 'الإيقاف المؤقت غير مسموح في هذا الاختبار؛ سياسته ثابتة منذ إنشائه ولا تتغير أثناء المحاولة.' };
  }
  let merged = false;
  let dropped = 0;
  const answers: Record<string, ExamAnswerState> = { ...server.answers };
  for (const [k, raw] of Object.entries(incoming.answers ?? {})) {
    const idx = Number(k);
    const item = Number.isInteger(idx) ? items[idx] : undefined;
    const a = normalizeAnswer(raw);
    if (!item || !a || a.selected_option_ids.some((id) => !item.option_order.includes(id))) {
      dropped++;
      continue;
    }
    const cur = answers[k];
    if (!cur) {
      answers[k] = a;
      continue;
    }
    if (cur.submitted) {
      // a submitted (practice) answer is locked: an incoming different answer never replaces it
      if (!sameSet(a.selected_option_ids, cur.selected_option_ids) || a.attempt_id !== cur.attempt_id) merged = true;
      continue;
    }
    if (a.at > cur.at || (a.at === cur.at && a.submitted && !cur.submitted)) answers[k] = { ...a, hints_used: Math.max(a.hints_used, cur.hints_used), solution_viewed_before_answer: a.solution_viewed_before_answer || cur.solution_viewed_before_answer };
    else if (a.at < cur.at) merged = true; // the server already had a newer answer for this item
  }
  for (const k of Object.keys(server.answers)) if (!(k in (incoming.answers ?? {}))) merged = true;

  const wallCap = Math.max(0, now - server.started_at) + 60_000;
  const elapsed = Math.max(server.elapsed_ms, Math.min(incoming.elapsed_ms, wallCap));
  const itemMs: Record<string, number> = { ...server.timer.item_ms };
  for (const [k, ms] of Object.entries(incoming.timer?.item_ms ?? {})) {
    const idx = Number(k);
    if (!Number.isInteger(idx) || idx < 0 || idx >= items.length) continue;
    itemMs[k] = Math.max(itemMs[k] ?? 0, Math.min(ms, wallCap));
  }
  const status = incoming.status;
  const next: ExamAttemptDTO = {
    ...server,
    status,
    elapsed_ms: elapsed,
    current_index: Math.min(Math.max(0, incoming.current_index), Math.max(0, items.length - 1)),
    answers,
    flagged: [...new Set(incoming.flagged.filter((i) => i >= 0 && i < items.length))].sort((a, b) => a - b),
    timer: {
      item_ms: itemMs,
      pauses: Math.max(server.timer.pauses, incoming.timer?.pauses ?? 0),
      paused_at: status === 'paused' ? (incoming.timer?.paused_at ?? now) : null,
    },
    finished_at: TERMINAL.has(status) ? Math.min(incoming.finished_at ?? now, now) : null,
  };
  return { ok: true, next, merged, dropped };
}

function writeAttempt(db: Db, a: ExamAttemptDTO, now: number, deviceId: string | null): void {
  db.run(
    `UPDATE exam_attempt SET status = ?, finished_at = ?, elapsed_ms = ?, timer_json = ?, current_index = ?, answers_json = ?, flags_json = ?,
       rev = rev + 1, updated_at = ?, device_id = ? WHERE id = ?`,
    [a.status, a.finished_at, a.elapsed_ms, toJson(a.timer), a.current_index, toJson(a.answers), toJson(a.flagged), now, deviceId, a.id],
  );
}

/**
 * Finishing an attempt: one question_attempt per answered item (the client's ids; idempotent). Practice answers
 * that were chosen but not checked are attempts too (the owner answered them; nothing chosen is dropped).
 * Never throws for one item: an item whose pinned question no longer exists (purged with its source) is skipped
 * and counted, so finishing can never be rejected half-way with the other answers left ungraded.
 */
export function materializeAnswers(
  db: Db,
  exam: ExamRow,
  a: ExamAttemptDTO,
  now: number,
  deviceId: string | null,
  touch: (t: string, id: string) => void,
): { inserted: number; skipped: number } {
  const items = examItems(exam);
  let inserted = 0;
  let skipped = 0;
  for (const [k, ans] of Object.entries(a.answers)) {
    const idx = Number(k);
    const item = items[idx];
    if (!item || ans.selected_option_ids.length === 0) continue;
    try {
      const res = insertQuestionAttempt(
        db,
        {
          id: ans.attempt_id,
          question_id: item.question_id,
          question_version_id: item.question_version_id,
          exam_attempt_id: a.id,
          exam_item_index: idx,
          selected_option_ids: ans.selected_option_ids,
          confidence: ans.confidence,
          hints_used: ans.hints_used,
          solution_viewed_before_answer: ans.solution_viewed_before_answer,
          time_ms: ans.time_ms ?? a.timer.item_ms[k] ?? null,
          flagged: a.flagged.includes(idx),
          answered_at: Math.min(ans.at, now),
        },
        { now, deviceId, touch },
      );
      if (res.inserted) inserted++;
    } catch (e) {
      // checks run before any write, so nothing of this item was stored; the answer stays in the attempt state
      if (!(e instanceof AppError)) throw e;
      skipped++;
    }
  }
  return { inserted, skipped };
}

export function examAttemptHandler(ctx: AppContext): SyncEntityHandler {
  const serialize = (id: string) => {
    const r = findAttempt(ctx.db, id);
    return r ? attemptDTO(r) : null;
  };
  return {
    serialize,
    apply(op: SyncOp, tx: SyncTx): SyncApplyResult {
      if (op.op !== 'upsert') throw new AppError('CONFLICT', 'محاولات الاختبار لا تُحذف ولا تُضاف من الجهاز؛ تُنشأ من منشئ الاختبار.', 409);
      const row = findAttempt(tx.db, op.entity_id);
      if (!row) throw new AppError('NOT_FOUND', 'محاولة الاختبار غير موجودة على الخادم؛ أنشئ الاختبار وأنت متصل.', 404);
      const exam = getExam(tx.db, row.exam_id);
      const incoming = parse(examAttemptPayloadSchema, normalizeKeys(op.payload)) as ExamStateChange;
      const server = attemptDTO(row);
      const m = mergeExamState(exam, server, incoming, tx.now);
      if (!m.ok) {
        // identical terminal state re-sent (e.g. a retry after a lost response) → nothing to do
        if (TERMINAL.has(server.status) && incoming.status === server.status) return { result: 'duplicate', entity: server };
        return { result: 'rejected', entity: server, detail: m.reason_ar };
      }
      writeAttempt(tx.db, m.next, tx.now, tx.deviceId);
      tx.touch('exam_attempt', row.id);
      const mat = m.next.status === 'completed' ? materializeAnswers(tx.db, exam, m.next, tx.now, tx.deviceId, tx.touch) : { inserted: 0, skipped: 0 };
      const entity = attemptDTO(findAttempt(tx.db, row.id)!);
      const notes: string[] = [];
      if (m.dropped > 0) notes.push(`أُهملت ${m.dropped} إجابة غير صالحة (خيار لا يخص السؤال المثبت).`);
      if (mat.skipped > 0) notes.push(`أُنهيت المحاولة؛ ${mat.skipped} من الإجابات تخص سؤالًا لم يعد موجودًا (حُذف نهائيًا مع مصدره)، فبقيت في المحاولة دون تصحيح.`);
      const detail = notes.length ? notes.join(' ') : undefined;
      return { result: m.merged ? 'merged' : 'applied', entity, ...(detail ? { detail } : {}) };
    },
  };
}

export function registerAttemptSync(ctx: AppContext): void {
  ctx.sync.registerEntity('question_attempt', questionAttemptHandler(ctx));
  ctx.sync.registerEntity('exam_attempt', examAttemptHandler(ctx));
}

/** Read helper for validation status of a pinned version (feedback / results). */
export function versionValidation(db: Db, versionId: string): QuestionValidation | null {
  const r = db.get<{ validation_json: string | null }>('SELECT validation_json FROM question_version WHERE id = ?', [versionId]);
  return fromJson<QuestionValidation | null>(r?.validation_json ?? null, null);
}

export type { ExamAttemptRow };
