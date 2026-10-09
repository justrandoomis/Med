// Results (§39): explicit denominators (scored items), time, hints, by lecture / concept, unscored reasons, strong
// and weak lists and deterministic review suggestions. No fake percentages: every ratio is shown with its counts.
import {
  MASTERY_SIGNAL_LABELS_AR,
  isAssessedMode,
  masterySignal,
  pageDisplayLabel,
  stemPreview,
  type ExamAttemptListItem,
  type ExamAttemptListResponse,
  type ExamResultDetail,
  type ExamResultItem,
  type ReviewSuggestion,
  type RichText,
} from '@medlevo/shared';
import type { AppContext } from '../../context';
import { fromJson } from '../../db/db';
import { AppError } from '../../lib/errors';
import {
  PURGED_ITEM_REASON_AR,
  attemptDTO,
  examItems,
  examPolicy,
  existingVersions,
  questionAttemptDTO,
  questionsAr,
  type ExamAttemptRow,
  type ExamRow,
  type QuestionAttemptRow,
} from './store';

const RELATION_RANK: Record<string, number> = { directly_covered: 0, strongly_related: 1, partially_covered: 2, course_related_only: 3 };

interface LinkInfo {
  lecture_source_id: string;
  title: string;
  page_ids: string[];
  concepts: string[];
}

function bestLinks(ctx: AppContext, questionId: string): LinkInfo[] {
  const rows = ctx.db.all<{ lecture_source_id: string; title: string; relation: string; status: string; reason_json: string | null }>(
    `SELECT l.lecture_source_id, s.title, l.relation, l.status, l.reason_json FROM question_lecture_link l JOIN source s ON s.id = l.lecture_source_id
      WHERE l.question_id = ? AND l.status <> 'rejected' AND s.deleted_at IS NULL`,
    [questionId],
  );
  rows.sort((a, b) => (a.status === 'accepted' ? 0 : 1) - (b.status === 'accepted' ? 0 : 1) || (RELATION_RANK[a.relation] ?? 9) - (RELATION_RANK[b.relation] ?? 9));
  return rows.map((r) => {
    const rj = fromJson<{ concepts?: string[]; lecture_page_ids?: string[] }>(r.reason_json, {}) ?? {};
    const concepts = rj.concepts?.length
      ? ctx.db
          .all<{ name_en: string | null; name_ar: string | null }>(
            `SELECT name_en, name_ar FROM concept WHERE status <> 'rejected' AND id IN (${rj.concepts.map(() => '?').join(',')})`,
            rj.concepts,
          )
          .map((c) => c.name_ar || c.name_en || '')
          .filter(Boolean)
      : [];
    return { lecture_source_id: r.lecture_source_id, title: r.title, page_ids: rj.lecture_page_ids ?? [], concepts };
  });
}

function generatedMeta(ctx: AppContext, questionId: string): { concepts: string[]; page_ids: string[] } | null {
  const c = ctx.db.get<{ concepts_json: string | null; evidence_json: string }>(
    'SELECT concepts_json, evidence_json FROM generated_question_candidate WHERE question_id = ? ORDER BY created_at DESC LIMIT 1',
    [questionId],
  );
  if (!c) return null;
  return { concepts: fromJson<string[]>(c.concepts_json, []) ?? [], page_ids: fromJson<{ lecture_page_ids?: string[] }>(c.evidence_json, {})?.lecture_page_ids ?? [] };
}

function pageLabelAr(ctx: AppContext, pageId: string): string | null {
  const p = ctx.db.get<{ page_index: number; printed_label: string | null; kind: string }>('SELECT page_index, printed_label, kind FROM source_page WHERE id = ?', [pageId]);
  if (!p) return null;
  return pageDisplayLabel({ page_index: p.page_index, printed_label: p.printed_label, kind: p.kind as never }, { withFileIndex: false });
}

const pct = (c: number, t: number) => (t > 0 ? `${c} من ${t}` : '—');

export function computeResult(ctx: AppContext, exam: ExamRow, attempt: ExamAttemptRow): ExamResultDetail {
  const policy = examPolicy(exam);
  const finished = attempt.status === 'completed' || attempt.status === 'abandoned';
  if ((isAssessedMode(exam.mode) || policy.show_solution === 'at_end') && !finished) {
    throw new AppError('CONFLICT', 'النتيجة تظهر بعد إنهاء الاختبار؛ لا تُكشف الإجابات أثناءه.', 409);
  }
  const items = examItems(exam);
  const state = attemptDTO(attempt);
  const rows = ctx.db.all<QuestionAttemptRow>('SELECT * FROM question_attempt WHERE exam_attempt_id = ?', [attempt.id]);
  const byIndex = new Map<number, QuestionAttemptRow>();
  for (const r of rows) if (r.exam_item_index !== null) byIndex.set(r.exam_item_index, r);
  const budgetMs = policy.per_question_seconds ? policy.per_question_seconds * 1000 : null;

  const resultItems: ExamResultItem[] = [];
  const unscored: ExamResultDetail['unscored_reasons'] = [];
  const conceptAgg = new Map<string, { correct: number; total: number }>();
  const lectureAgg = new Map<string, { id: string | null; label: string; correct: number; total: number }>();
  const suggestions: ReviewSuggestion[] = [];
  const seenPages = new Set<string>();
  const signals = { correct_guess: 0, correct_after_hint: 0, solution_viewed: 0, confident_wrong: 0 };
  let scoredItems = 0;
  let correct = 0;
  let hints = 0;
  let missing = 0;
  const overBudget = { total: 0, correct: 0 };
  const withinBudget = { total: 0, correct: 0 };

  const alive = existingVersions(ctx.db, items);

  items.forEach((item, index) => {
    const qa = byIndex.get(index) ?? null;
    const dto = qa ? questionAttemptDTO(qa) : null;
    const answerState = state.answers[String(index)];
    const purged = !alive.has(item.question_version_id);
    // an answer the server will still receive (never one of a purged question: it can no longer be graded)
    if (!qa && !purged && answerState && answerState.selected_option_ids.length > 0 && (answerState.submitted || finished)) missing++;
    if (purged && !dto) item = { ...item, scored: false, unscored_reason_ar: PURGED_ITEM_REASON_AR };
    const counted = dto ? dto.scored : item.scored;
    const v = ctx.db.get<{ stem_json: string }>('SELECT stem_json FROM question_version WHERE id = ?', [item.question_version_id]);
    const links = bestLinks(ctx, item.question_id);
    const gen = item.origin_type === 'generated' ? generatedMeta(ctx, item.question_id) : null;
    const concepts = [...new Set([...(gen?.concepts ?? []), ...(links[0]?.concepts ?? [])])].slice(0, 4);
    const timeMs = dto?.time_ms ?? state.timer.item_ms[String(index)] ?? null;
    const over = budgetMs !== null && timeMs !== null && timeMs > budgetMs;
    const sig = dto ? masterySignal(dto) : null;

    if (counted) {
      scoredItems++;
      const ok = dto?.is_correct === true;
      if (ok) correct++;
      for (const c of concepts.length ? concepts : ['بلا مفهوم محدد']) {
        const a = conceptAgg.get(c) ?? { correct: 0, total: 0 };
        a.total++;
        if (ok) a.correct++;
        conceptAgg.set(c, a);
      }
      const lk = links[0] ? links[0].lecture_source_id : '∅';
      const la = lectureAgg.get(lk) ?? { id: links[0]?.lecture_source_id ?? null, label: links[0]?.title ?? 'غير مرتبط بمحاضرة', correct: 0, total: 0 };
      la.total++;
      if (ok) la.correct++;
      lectureAgg.set(lk, la);
      if (budgetMs !== null && dto) {
        const bucket = over ? overBudget : withinBudget;
        bucket.total++;
        if (ok) bucket.correct++;
      }
    } else {
      unscored.push({ question_id: item.question_id, reason_ar: dto?.unscored_reason_ar ?? item.unscored_reason_ar ?? 'لا يُحتسب في النتيجة.' });
    }
    if (dto) {
      hints += dto.hints_used;
      if (sig === 'correct_guess') signals.correct_guess++;
      if (sig === 'correct_after_hint') signals.correct_after_hint++;
      if (dto.solution_viewed_before_answer) signals.solution_viewed++;
      if (dto.is_correct === false && dto.confidence === 'confident') signals.confident_wrong++;
    }

    // review suggestions (deterministic): wrong or not-independent answers → lecture pages, then the question again
    const weakAnswer = counted && (!dto || dto.is_correct === false);
    const lucky = sig === 'correct_guess' || sig === 'correct_after_hint' || sig === 'correct_after_solution_viewed';
    if (weakAnswer || lucky) {
      const pageIds = (links[0]?.page_ids.length ? links[0].page_ids : gen?.page_ids ?? []).slice(0, 2);
      for (const pid of pageIds) {
        const key = `${links[0]?.lecture_source_id ?? ''}:${pid}`;
        if (seenPages.has(key) || !links[0]) continue;
        seenPages.add(key);
        const label = pageLabelAr(ctx, pid);
        if (!label) continue;
        suggestions.push({
          kind: 'lecture_pages',
          label_ar: `راجع «${links[0].title}» — ${label}`,
          reason_ar: weakAnswer ? `السؤال ${index + 1} ${dto ? 'أُجيب خطأً' : 'لم يُجب'}` : `السؤال ${index + 1}: ${MASTERY_SIGNAL_LABELS_AR[sig!]}`,
          source_id: links[0].lecture_source_id,
          page_id: pid,
        });
      }
      suggestions.push({
        kind: 'retry_question',
        label_ar: `أعد حل السؤال ${index + 1} لاحقًا`,
        reason_ar: weakAnswer ? (dto ? 'إجابة خاطئة' : 'لم يُجب') : MASTERY_SIGNAL_LABELS_AR[sig!],
        question_id: item.question_id,
      });
    }
    if (!counted && dto) {
      suggestions.push({ kind: 'check_unscored', label_ar: `راجع مفتاح السؤال ${index + 1} في مخزن الأسئلة`, reason_ar: dto.unscored_reason_ar ?? 'غير محسوب', question_id: item.question_id });
    }

    resultItems.push({
      index,
      question_id: item.question_id,
      question_version_id: item.question_version_id,
      stem_preview: stemPreview(fromJson<RichText | null>(v?.stem_json ?? null, null), 140),
      origin_type: item.origin_type,
      scored: counted,
      unscored_reason_ar: counted ? null : (dto?.unscored_reason_ar ?? item.unscored_reason_ar),
      answered: !!dto,
      is_correct: dto ? dto.is_correct : null,
      confidence: dto?.confidence ?? null,
      hints_used: dto?.hints_used ?? 0,
      solution_viewed_before_answer: dto?.solution_viewed_before_answer ?? false,
      time_ms: timeMs,
      over_time_budget: over,
      flagged: state.flagged.includes(index),
      mistake_type: dto?.mistake_type ?? null,
      mistake_origin: dto?.mistake_origin ?? null,
      attempt_id: dto?.id ?? null,
      mastery_signal: sig,
      lecture_titles: links.slice(0, 2).map((l) => l.title),
      concepts,
    });
  });

  const groups = [
    ...[...conceptAgg.entries()].filter(([k]) => k !== 'بلا مفهوم محدد').map(([label, a]) => ({ label, ...a })),
    ...[...lectureAgg.values()].filter((l) => l.id !== null).map((l) => ({ label: `محاضرة «${l.label}»`, correct: l.correct, total: l.total })),
  ];
  const strong = groups.filter((g) => g.total >= 2 && g.correct / g.total >= 0.8).map((g) => `${g.label} (${pct(g.correct, g.total)})`);
  const weak = groups.filter((g) => g.total >= 2 && g.correct / g.total <= 0.5).map((g) => `${g.label} (${pct(g.correct, g.total)})`);
  const answered = resultItems.filter((i) => i.answered).length;
  const time =
    policy.total_seconds || policy.per_question_seconds
      ? {
          total_seconds: policy.total_seconds,
          per_question_seconds: policy.per_question_seconds,
          over_budget: overBudget,
          within_budget: withinBudget,
          note_ar: 'تجاوز الوقت المحدد لسؤال لا يعني أن الخطأ سببه ضغط الوقت؛ هو مؤشر للمراجعة فقط، وتصنيف الخطأ قابل للتعديل.',
        }
      : null;

  return {
    attempt_id: attempt.id,
    total_items: items.length,
    scored_items: scoredItems,
    correct,
    accuracy: scoredItems > 0 ? correct / scoredItems : null,
    elapsed_ms: attempt.elapsed_ms,
    hints_used: hints,
    by_concept: [...conceptAgg.entries()].map(([label, a]) => ({ label, correct: a.correct, total: a.total })),
    unscored_reasons: unscored,
    strong,
    weak,
    title: exam.title,
    mode: exam.mode,
    status: attempt.status,
    finished_at: attempt.finished_at,
    answered,
    unanswered: items.length - answered,
    by_lecture: [...lectureAgg.values()].map((l) => ({ lecture_source_id: l.id, label: l.label, correct: l.correct, total: l.total })),
    items: resultItems,
    suggested_review: suggestions.slice(0, 30),
    time,
    signals,
    denominator_note_ar: `الدقة = الإجابات الصحيحة ÷ الأسئلة المحسوبة (${questionsAr(scoredItems)} من أصل ${questionsAr(items.length)}). الأسئلة غير المحسوبة لا تدخل في المقام، والأسئلة المحسوبة التي لم تُجب تُعد غير صحيحة.`,
    missing_on_server: missing,
  };
}

/** Attempt history, newest first (offset cursor). */
export function listAttempts(ctx: AppContext, limit: number, cursor: string | null): ExamAttemptListResponse {
  const offset = cursor ? Math.max(0, Number.parseInt(cursor, 10) || 0) : 0;
  const rows = ctx.db.all<ExamAttemptRow & { title: string; mode: ExamRow['mode']; items_json: string }>(
    `SELECT a.*, e.title, e.mode, e.items_json FROM exam_attempt a JOIN exam e ON e.id = a.exam_id ORDER BY a.started_at DESC, a.id DESC LIMIT ? OFFSET ?`,
    [limit + 1, offset],
  );
  const items: ExamAttemptListItem[] = rows.slice(0, limit).map((r) => {
    const finished = r.status === 'completed' || r.status === 'abandoned';
    const exam = { items_json: r.items_json };
    const n = examItems(exam).length;
    const agg = ctx.db.get<{ answered: number; scored: number; correct: number }>(
      `SELECT COUNT(*) AS answered, SUM(scored) AS scored, SUM(CASE WHEN scored = 1 AND is_correct = 1 THEN 1 ELSE 0 END) AS correct
         FROM question_attempt WHERE exam_attempt_id = ?`,
      [r.id],
    );
    const answersCount = Object.values(fromJson<Record<string, { selected_option_ids?: string[] }>>(r.answers_json, {}) ?? {}).filter((a) => a.selected_option_ids?.length).length;
    const scoredItems = examItems(exam).filter((i, idx) => {
      const qa = ctx.db.get<{ scored: number }>('SELECT scored FROM question_attempt WHERE exam_attempt_id = ? AND exam_item_index = ?', [r.id, idx]);
      return qa ? qa.scored === 1 : i.scored;
    }).length;
    const showScore = finished || !(isAssessedMode(r.mode) || examPolicy({ policy_json: (ctx.db.get<{ policy_json: string }>('SELECT policy_json FROM exam WHERE id = ?', [r.exam_id])?.policy_json ?? '{}') }).show_solution === 'at_end');
    return {
      attempt_id: r.id,
      exam_id: r.exam_id,
      title: r.title,
      mode: r.mode,
      status: r.status,
      started_at: r.started_at,
      finished_at: r.finished_at,
      item_count: n,
      answered: Math.max(agg?.answered ?? 0, answersCount),
      scored_items: scoredItems,
      correct: showScore ? (agg?.correct ?? 0) : null,
    };
  });
  return { items, next_cursor: rows.length > limit ? String(offset + limit) : null };
}

