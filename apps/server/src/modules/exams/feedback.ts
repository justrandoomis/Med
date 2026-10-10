// Feedback after answering (practice 'after_each') or after finishing (exam): key, explanation, distractor
// explanations with evidence (claims → citations → evidence), occurrences and origin label, mistake suggestion.
// Never during an exam (AC-19). The result shown is the one stored at answer time; a later key correction is
// reported next to it, never applied silently (AC-26).
import {
  ANSWER_STATUS_LABELS_AR,
  LECTURE_LINK_LABELS_AR,
  isAssessedMode,
  masterySignal,
  type AnswerStatus,
  type AttemptFeedbackView,
  type RichText,
} from '@medlevo/shared';
import type { AppContext } from '../../context';
import { fromJson } from '../../db/db';
import { AppError } from '../../lib/errors';
import { getClaimViews } from '../evidence/services';
import { getQuestion } from '../questions/service';
import { itemEvents, recordItemEvent } from './hints';
import { examItems, examPolicy, questionAttemptDTO, type ExamAttemptRow, type ExamRow, type QuestionAttemptRow } from './store';

interface VersionFull {
  id: string;
  version_no: number;
  stem_json: string;
  answer_status: AnswerStatus;
  correct_option_ids_json: string | null;
  explanation_json: string | null;
  distractor_explanations_json: string | null;
  learning_objective: string | null;
  difficulty_est: string | null;
  negation_terms_json: string | null;
}

function claimIdsOf(rt: RichText | null | undefined, out: Set<string>): void {
  for (const p of rt?.paragraphs ?? []) for (const r of p.runs) if (r.claim) out.add(r.claim);
}

/** Map stored distractor-explanation keys (option_key 'o2' or option id) to option ids. */
function distractorsById(raw: Record<string, RichText> | null, options: Array<{ id: string; option_key: string }>): Record<string, RichText> | null {
  if (!raw) return null;
  const byKey = new Map(options.map((o) => [o.option_key, o.id]));
  const ids = new Set(options.map((o) => o.id));
  const out: Record<string, RichText> = {};
  for (const [k, v] of Object.entries(raw)) {
    const id = ids.has(k) ? k : byKey.get(k);
    if (id) out[id] = v;
  }
  return Object.keys(out).length ? out : null;
}

export function feedbackGate(ctx: AppContext, exam: ExamRow, attempt: ExamAttemptRow, index: number, qa: QuestionAttemptRow | null): void {
  const policy = examPolicy(exam);
  const finished = attempt.status === 'completed' || attempt.status === 'abandoned';
  if (isAssessedMode(exam.mode) || policy.show_solution === 'at_end') {
    if (!finished) throw new AppError('CONFLICT', 'الحلول والأدلة تظهر بعد إنهاء الاختبار، لا أثناءه.', 409);
    return;
  }
  if (!qa && !itemEvents(ctx, attempt.id, index).has('solution_viewed') && !finished) {
    throw new AppError('CONFLICT', 'أجب عن السؤال أولًا (أو اطلب عرض الحل)، ثم يظهر التصحيح.', 409);
  }
}

export function itemAttempt(ctx: AppContext, attemptId: string, index: number): QuestionAttemptRow | null {
  return ctx.db.get<QuestionAttemptRow>('SELECT * FROM question_attempt WHERE exam_attempt_id = ? AND exam_item_index = ?', [attemptId, index]) ?? null;
}

export function buildFeedback(ctx: AppContext, exam: ExamRow, attempt: ExamAttemptRow, index: number): AttemptFeedbackView {
  const item = examItems(exam)[index];
  if (!item) throw new AppError('NOT_FOUND', 'السؤال غير موجود في هذه المحاولة.', 404);
  const qa = itemAttempt(ctx, attempt.id, index);
  feedbackGate(ctx, exam, attempt, index, qa);

  const v = ctx.db.get<VersionFull>(
    `SELECT id, version_no, stem_json, answer_status, correct_option_ids_json, explanation_json, distractor_explanations_json, learning_objective,
            difficulty_est, negation_terms_json FROM question_version WHERE id = ?`,
    [item.question_version_id],
  );
  if (!v) throw new AppError('NOT_FOUND', 'نسخة السؤال لم تعد موجودة.', 404);
  const options = ctx.db.all<{ id: string; option_key: string; text_json: string }>('SELECT id, option_key, text_json FROM question_option WHERE question_version_id = ?', [v.id]);
  const optById = new Map(options.map((o) => [o.id, o]));
  const q = getQuestion(ctx, item.question_id);

  const key = qa ? fromJson<string[] | null>(qa.key_at_answer_json, null) : fromJson<string[] | null>(v.correct_option_ids_json, null);
  const status = (qa?.key_status_at_answer as AnswerStatus | null) ?? v.answer_status;
  const explanation = fromJson<RichText | null>(v.explanation_json, null);
  const distractors = distractorsById(fromJson<Record<string, RichText> | null>(v.distractor_explanations_json, null), options);
  const claimIds = new Set<string>();
  claimIdsOf(explanation, claimIds);
  for (const rt of Object.values(distractors ?? {})) claimIdsOf(rt, claimIds);

  // a later version with a different key: reported, never applied to this attempt (AC-26)
  let newer: string | null = null;
  if (q.current.id !== v.id) {
    const keyOptKeys = (key ?? []).map((id) => optById.get(id)?.option_key).filter(Boolean).sort().join('|');
    const curKeys = (q.current.correct_option_ids ?? []).map((id) => q.current.options.find((o) => o.id === id)?.option_key).filter(Boolean).sort().join('|');
    if (keyOptKeys !== curKeys || q.current.answer_status !== status) {
      const labels = (q.current.correct_option_ids ?? [])
        .map((id) => q.current.options.find((o) => o.id === id))
        .filter(Boolean)
        .map((o) => o!.source_label ?? o!.option_key);
      const now = `النسخة ${q.current.version_no}: ${ANSWER_STATUS_LABELS_AR[q.current.answer_status]}${labels.length ? ` — ${labels.join('، ')}` : ''}`;
      // when did the change happen relative to THIS answer? (the exam pinned version v when it was created)
      // (track F3) a derived translation / paraphrase is never a key change
      const changedAt =
        ctx.db.get<{ at: number | null }>(
          `SELECT MIN(created_at) AS at FROM question_version WHERE question_id = ? AND version_no > ? AND kind NOT IN ('translation','paraphrase')`,
          [item.question_id, v.version_no],
        )?.at ?? null;
      if (qa && changedAt !== null && changedAt < qa.answered_at) {
        newer = `صُحّح مفتاح هذا السؤال قبل إجابتك، لكن هذا الاختبار ثبّت النسخة ${v.version_no} عند إنشائه فقُيّمت إجابتك على مفتاحها (المفتاح الحالي — ${now}). لم يتغير شيء تلقائيًا؛ أنشئ اختبارًا جديدًا ليُستخدم المفتاح المصحح.`;
      } else if (qa) {
        newer = `تغيّر مفتاح هذا السؤال بعد محاولتك (${now}). بقيت نتيجة محاولتك كما قُيّمت وقت الإجابة ولم يُعَد تقييمها.`;
      } else {
        newer = `هذا الاختبار ثبّت النسخة ${v.version_no} من السؤال، ولمفتاحه الآن نسخة أحدث (${now}). يُعرض هنا مفتاح النسخة المثبتة.`;
      }
    }
  }

  const dto = qa ? questionAttemptDTO(qa) : null;
  return {
    is_correct: dto ? dto.is_correct : null,
    scored: dto ? dto.scored : false,
    correct_option_ids: key && key.length ? key : null,
    answer_status: status,
    explanation,
    distractor_explanations: distractors,
    occurrences: q.occurrences,
    suggested_mistake_type: dto?.auto_mistake_type ?? null,
    question_id: item.question_id,
    question_version_id: v.id,
    attempt: dto,
    origin_type: q.origin_type,
    origin_label_ar: q.origin_label_ar,
    answer_status_label_ar: ANSWER_STATUS_LABELS_AR[status],
    options: item.option_order
      .map((id, i) => {
        const o = optById.get(id);
        return o ? { id, display_label: item.display_labels[i] ?? String(i + 1), text: fromJson<RichText>(o.text_json, { v: 1, paragraphs: [] })! } : null;
      })
      .filter((o): o is NonNullable<typeof o> => !!o),
    stem: fromJson<RichText>(v.stem_json, { v: 1, paragraphs: [] })!,
    negation_terms: fromJson<string[]>(v.negation_terms_json, []) ?? [],
    unscored_reason_ar: dto ? dto.unscored_reason_ar : item.scored ? null : item.unscored_reason_ar,
    mastery_signal: dto ? masterySignal(dto) : null,
    mistake_reason_ar: dto?.auto_mistake_reason_ar ?? null,
    claims: getClaimViews(ctx, [...claimIds]),
    lecture_links: q.lecture_links
      .filter((l) => l.status !== 'rejected')
      .map((l) => ({
        lecture_source_id: l.lecture_source_id,
        lecture_title: l.lecture_title,
        relation_label_ar: LECTURE_LINK_LABELS_AR[l.relation],
        pages: l.lecture_pages.map((p) => ({ page_id: p.page_id, label_ar: p.label_ar })),
      })),
    newer_version_note_ar: newer,
    learning_objective: v.learning_objective,
    difficulty_est: v.difficulty_est,
  };
}

/** Practice: «اعرض الحل» before answering — recorded (solution_viewed_before_answer), refused in Anti-shortcut mode. */
export function viewSolution(ctx: AppContext, exam: ExamRow, attempt: ExamAttemptRow, index: number): AttemptFeedbackView {
  const policy = examPolicy(exam);
  if (isAssessedMode(exam.mode) || policy.show_solution === 'at_end') {
    if (attempt.status !== 'completed' && attempt.status !== 'abandoned') throw new AppError('CONFLICT', 'الحلول تظهر بعد إنهاء الاختبار، لا أثناءه.', 409);
    return buildFeedback(ctx, exam, attempt, index);
  }
  const item = examItems(exam)[index];
  if (!item) throw new AppError('NOT_FOUND', 'السؤال غير موجود في هذه المحاولة.', 404);
  const answered = itemAttempt(ctx, attempt.id, index);
  if (!answered) {
    const chosen = (fromJson<Record<string, { selected_option_ids?: string[] }>>(attempt.answers_json, {}) ?? {})[String(index)];
    if (policy.anti_shortcut && !(chosen?.selected_option_ids?.length)) {
      throw new AppError('CONFLICT', 'وضع منع الاختصار مفعّل: اختر إجابة أولًا، ثم يظهر الحل.', 409);
    }
    ctx.db.tx(() => recordItemEvent(ctx, attempt.id, index, item.question_version_id, 'solution_viewed'));
  }
  return buildFeedback(ctx, exam, attempt, index);
}
