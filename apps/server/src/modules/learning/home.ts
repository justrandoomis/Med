// Home (§45): the book the owner left open first (Continue Studying), then today's plan, due cards, the exam
// countdown, the top weakness and important questions — each with its reason (never a probability).
import { pageDisplayLabel, type HomeDetail, type HomeView } from '@medlevo/shared';
import type { AppContext } from '../../context';
import { AnnotationsService } from '../annotations/service';
import { repeatedQuestions } from './dna';
import { planView } from './planner';
import { reviewQueue } from './review';
import { srsContext } from './store';
import { DAY_MS, dayOf, daysBetween } from './time';
import { listStored, refreshWeaknesses } from './weakness';

export function homeView(ctx: AppContext): HomeDetail {
  const srs = srsContext(ctx);
  const now = ctx.clock.now();
  const today = dayOf(now, srs.timezone);

  const cont: HomeView['continue'] = new AnnotationsService(ctx).recentSessions(5).map((it) => ({
    source_id: it.source.id,
    title: it.source.title,
    version_id: it.version?.id ?? null,
    page_label_ar: it.page ? pageDisplayLabel({ page_index: it.page.page_index, printed_label: it.page.printed_label, kind: it.page.kind as never }) : null,
    mode: it.session.mode,
    updated_at: it.session.updated_at,
  }));

  // the active plan with the nearest exam that has not passed
  const plans = ctx.db.all<{ id: string; title: string; exam_date: string | null }>(`SELECT id, title, exam_date FROM study_plan WHERE status = 'active' AND exam_date IS NOT NULL ORDER BY exam_date, created_at`);
  const plan = plans.find((p) => p.exam_date && daysBetween(today, p.exam_date) >= 0) ?? null;
  let todayTasks: HomeView['today'] = [];
  let exam: HomeView['exam'] = null;
  if (plan) {
    const v = planView(ctx, plan.id);
    todayTasks = v.tasks.filter((t) => t.day === v.today && t.kind !== 'exam' && t.status !== 'moved');
    exam = { title: plan.title, date: plan.exam_date!, days_left: daysBetween(v.today, plan.exam_date!) };
  }

  const q = reviewQueue(ctx, { limit: 0 });
  refreshWeaknesses(ctx);
  const top = listStored(ctx, 'open')[0] ?? null;

  // important questions: repeated across the owner's files and not yet answered right independently, then recent mistakes
  const important: HomeView['important_questions'] = [];
  const independentRight = (qid: string) =>
    !!ctx.db.get(`SELECT 1 AS x FROM question_attempt WHERE question_id = ? AND is_correct = 1 AND confidence = 'confident' AND hints_used = 0 AND solution_viewed_before_answer = 0`, [qid]);
  for (const r of repeatedQuestions(ctx, 20)) {
    if (important.length >= 3) break;
    if (independentRight(r.question_id)) continue;
    important.push({ question_id: r.question_id, reason_ar: `ظهر في ${r.files === 2 ? 'ملفّين' : `${r.files} ملفات`} من مصادر أسئلتك (مؤشر أهمية داخل أرشيفك، وليس احتمال ظهوره) ولم تُجب عنه بثقة ودون مساعدة بعد.` });
  }
  const recentWrong = ctx.db.all<{ question_id: string; answered_at: number }>(
    `SELECT qa.question_id, qa.answered_at FROM question_attempt qa JOIN question q ON q.id = qa.question_id
      WHERE qa.scored = 1 AND qa.is_correct = 0 AND q.deleted_at IS NULL AND qa.answered_at >= ?
        AND qa.answered_at = (SELECT MAX(x.answered_at) FROM question_attempt x WHERE x.question_id = qa.question_id AND x.scored = 1 AND x.is_correct IS NOT NULL)
      ORDER BY qa.answered_at DESC LIMIT 10`,
    [now - 14 * DAY_MS],
  );
  for (const r of recentWrong) {
    if (important.length >= 5) break;
    if (important.some((x) => x.question_id === r.question_id)) continue;
    important.push({ question_id: r.question_id, reason_ar: `أخطأت فيه آخر مرة (${dayOf(r.answered_at, srs.timezone)}).` });
  }

  return {
    continue: cont,
    today: todayTasks,
    due_cards: q.counts.due_now,
    new_cards_available: q.counts.new_available,
    exam,
    top_weakness: top,
    important_questions: important,
    day: today,
    timezone: srs.timezone,
    due_today: q.counts.due_today,
    plan_id: plan?.id ?? null,
    generated_at: now,
  };
}
