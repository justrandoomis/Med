// Progress separation (§45): reading progress (pages shown — annotations' source_progress), explanation coverage
// (Study Book sections generated with verified content / sections planned), practice (attempts and card reviews) and a
// mastery ESTIMATE (AC-27 weights over scored answers) are four different numbers. Opening or scrolling a file is never
// completion and never mastery.
import { MASTERY_WEIGHTS, masterySignal, type SourceProgressDetail, type SourceProgressListResponse } from '@medlevo/shared';
import type { AppContext } from '../../context';
import { AppError } from '../../lib/errors';
import { AnnotationsService } from '../annotations/service';
import { signalResets } from './profile';

export const MASTERY_MIN_SAMPLE = 3;

/** Mastery estimate from scored answers (null below the minimum sample). Exported for tests. */
export function masteryEstimate(attempts: Array<{ is_correct: boolean | null; confidence: 'guess' | 'unsure' | 'confident' | null; hints_used: number; solution_viewed_before_answer: boolean }>): { value: number | null; sample: number } {
  const ws: number[] = [];
  for (const a of attempts) {
    const s = masterySignal(a);
    if (s !== null) ws.push(MASTERY_WEIGHTS[s]);
  }
  if (ws.length < MASTERY_MIN_SAMPLE) return { value: null, sample: ws.length };
  const mean = ws.reduce((a, b) => a + b, 0) / ws.length;
  return { value: Math.round(Math.max(0, Math.min(1, mean)) * 100) / 100, sample: ws.length };
}

export function sourceProgress(ctx: AppContext, sourceId: string): SourceProgressDetail {
  const s = ctx.db.get<{ id: string; title: string; deleted_at: number | null }>('SELECT id, title, deleted_at FROM source WHERE id = ?', [sourceId]);
  if (!s) throw new AppError('NOT_FOUND', 'المصدر غير موجود.', 404);
  const reading = new AnnotationsService(ctx).progress(sourceId);

  const book = ctx.db.get<{ id: string; status: string }>(
    `SELECT id, status FROM artifact WHERE primary_source_id = ? AND kind = 'study_book' AND status IN ('published','partial','stale','generating')
      ORDER BY CASE WHEN is_frozen = 1 THEN 0 WHEN status IN ('published','partial') THEN 1 WHEN status = 'stale' THEN 2 ELSE 3 END, version_no DESC, created_at DESC LIMIT 1`,
    [sourceId],
  );
  const sections = book
    ? ctx.db.get<{ total: number; complete: number }>(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'complete' THEN 1 ELSE 0 END) AS complete FROM artifact_section WHERE artifact_id = ?`,
        [book.id],
      )
    : undefined;
  const total = sections?.total ?? 0;
  const covered = sections?.complete ?? 0;

  const resets = signalResets(ctx.db);
  const attempts = ctx.db.all<{ is_correct: number | null; scored: number; confidence: 'guess' | 'unsure' | 'confident' | null; hints_used: number; solution_viewed_before_answer: number; answered_at: number }>(
    `SELECT qa.is_correct, qa.scored, qa.confidence, qa.hints_used, qa.solution_viewed_before_answer, qa.answered_at
       FROM question_attempt qa JOIN question q ON q.id = qa.question_id
      WHERE q.deleted_at IS NULL AND qa.answered_at >= ?
        AND (EXISTS (SELECT 1 FROM question_lecture_link l WHERE l.question_id = qa.question_id AND l.lecture_source_id = ? AND l.status <> 'rejected' AND l.relation <> 'course_related_only')
          OR EXISTS (SELECT 1 FROM question_occurrence o WHERE o.question_id = qa.question_id AND o.source_id = ?))`,
    [resets.mcq_attempts ?? 0, sourceId, sourceId],
  );
  const cardReviews =
    ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM review_event e JOIN flashcard f ON f.id = e.card_id WHERE f.source_id = ? AND e.reviewed_at >= ?', [sourceId, resets.card_reviews ?? 0])?.n ?? 0;
  const scoredRows = attempts.filter((a) => a.scored === 1 && a.is_correct !== null);
  const m = masteryEstimate(
    scoredRows.map((a) => ({
      is_correct: a.is_correct === 1,
      confidence: resets.confidence !== null && a.answered_at < resets.confidence ? null : a.confidence,
      hints_used: a.hints_used,
      solution_viewed_before_answer: a.solution_viewed_before_answer === 1,
    })),
  );
  return {
    source_id: sourceId,
    title: s.title,
    reading_progress: reading.reading_progress,
    explanation_coverage: total > 0 ? Math.round((covered / total) * 100) / 100 : 0,
    practice_count: attempts.length + cardReviews,
    mastery_estimate: m.value,
    reading: { version_id: reading.version_id, pages_viewed: reading.pages_viewed.length, pages_total: reading.pages_total },
    explanation: { artifact_id: book?.id ?? null, sections_covered: covered, sections_total: total, status: book?.status ?? null },
    practice: { question_attempts: attempts.length, scored_attempts: scoredRows.length, card_reviews: cardReviews },
    mastery: {
      sample: m.sample,
      basis_ar:
        m.value === null
          ? `لا يُقدَّر الإتقان قبل ${MASTERY_MIN_SAMPLE} إجابات محسوبة على الأقل (لديك ${m.sample}).`
          : `متوسط وزن ${m.sample} إجابات محسوبة: الصحيحة بثقة ودون مساعدة 1، بتردد 0.6، بعد تلميح 0.35، بالتخمين 0.2، بعد رؤية الحل 0، الخطأ −0.6 (ثم يُحصر بين 0 و1).`,
    },
    notes_ar: [
      'فتح الملف أو التمرير لا يُعد إتمامًا للمحاضرة ولا إتقانًا: القراءة والشرح والتدريب والإتقان أرقام منفصلة.',
      'نسبة القراءة = الصفحات التي عُرضت ÷ صفحات النسخة. تغطية الشرح = أقسام كتاب الدراسة المكتملة ÷ أقسامه.',
      'الإتقان تقدير من إجاباتك فقط، وليس قياسًا يقينيًا.',
      ...(s.deleted_at !== null ? ['المصدر في سلة المحذوفات.'] : []),
    ],
  };
}

export function progressList(ctx: AppContext, opts: { courseNodeId?: string | null } = {}): SourceProgressListResponse {
  const params: unknown[] = [];
  let where = `deleted_at IS NULL AND source_type IN ('lecture','course_reference','textbook','practical_manual','guideline')`;
  if (opts.courseNodeId) {
    where += ' AND (course_node_id = ? OR node_id = ? OR subject_node_id = ?)';
    params.push(opts.courseNodeId, opts.courseNodeId, opts.courseNodeId);
  }
  const ids = ctx.db.all<{ id: string }>(`SELECT id FROM source WHERE ${where} ORDER BY sort_order, created_at LIMIT 200`, params);
  return { items: ids.map((r) => sourceProgress(ctx, r.id)) };
}
