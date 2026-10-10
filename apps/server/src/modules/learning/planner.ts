// Study Planner (§45). StudyPlanConfig → a deterministic schedule of owner days (YYYY-MM-DD in the plan's timezone,
// default the owner setting Asia/Baghdad; computed with Intl, never the device timezone; times stay UTC epoch ms).
//  * sized by lecture page counts (estimate: minutes per page; an unprocessed lecture gets a labelled default),
//    spaced reviews after each lecture (+1, +3, +7 days), MCQ practice where the lecture has linked questions,
//    daily flashcards sized from the due load, weakness revisions;
//  * capacity: a day never holds more than the daily minutes — what does not fit is listed explicitly (never an
//    impossible last day);
//  * rebalance when behind: unfinished tasks of past days and the following ones are moved forward in priority order
//    (learn → MCQ → review → flashcards → weakness); moved tasks keep their history row (status 'moved') and the new row
//    says where it came from; what no longer fits is skipped AND reported.
import {
  type PlanRebalanceReport,
  type PlanFeasibility,
  type PlanListResponse,
  type PlanPreviewResponse,
  type PlanRebalanceResponse,
  type PlanTaskView,
  type StudyPlanConfig,
  type StudyPlanView,
} from '@medlevo/shared';
import { z } from 'zod';
import type { AppContext } from '../../context';
import { fromJson, toJson } from '../../db/db';
import { AppError } from '../../lib/errors';
import { newId } from '../../lib/ids';
import { isValidTimeZone } from '../../lib/time';
import { measuredPace } from './profile';
import { reviewQueue } from './review';
import { pushTo, srsContext } from './store';
import { addDays, dayOf, daysBetween, isDay, weekdayOf } from './time';
import { listStored, refreshWeaknesses } from './weakness';

export const PLANNER_VERSION = 'planner-v1';
export const MIN_PER_PAGE = 4;
export const UNKNOWN_LECTURE_MINUTES = 45;
export const MIN_CHUNK = 15;
export const MCQ_MIN_PER_QUESTION = 1.5;
export const REVIEW_OFFSETS = [1, 3, 7] as const;
/** longest plan horizon (days from today to the exam) */
export const MAX_PLAN_DAYS = 1100;
const PRIORITY: Record<PlanTaskView['kind'], number> = { learn: 0, mcq: 1, review: 2, flashcards: 3, weakness: 4, exam: 9 };

export const planConfigSchema = z.object({
  title: z.string().trim().min(1).max(200),
  exam_date: z.string().refine(isDay, 'التاريخ يجب أن يكون بالصيغة YYYY-MM-DD.'),
  source_ids: z.array(z.string().trim().min(1).max(64)).min(1).max(200),
  available_weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  daily_minutes: z.number().int().min(15).max(960),
  blocked_dates: z.array(z.string().refine(isDay, 'تاريخ غير صالح.')).max(366).default([]),
  include: z.object({ learn: z.boolean(), review: z.boolean(), mcq: z.boolean(), flashcards: z.boolean(), weakness: z.boolean() }),
});

// ───────── pure core ─────────
export interface LectureInput {
  source_id: string;
  title: string;
  pages: number | null;
  processing: string;
  question_count: number;
}

export interface PlanCoreInput {
  today: string;
  exam_date: string;
  weekdays: number[];
  daily_minutes: number;
  blocked: string[];
  include: StudyPlanConfig['include'];
  lectures: LectureInput[];
  /** minutes of flashcards per study day (0 → no flashcard tasks) */
  flashcards_minutes: number;
  weaknesses: Array<{ id: string; label: string }>;
}

export interface PlannedTask {
  day: string;
  kind: PlanTaskView['kind'];
  title_ar: string;
  ref: Record<string, unknown> | null;
  minutes: number;
  priority: number;
  ord: number;
}

/** Study days from today (inclusive) to the day BEFORE the exam, on available weekdays, minus blocked dates. */
export function studyDays(today: string, examDate: string, weekdays: number[], blocked: string[]): string[] {
  const out: string[] = [];
  const skip = new Set(blocked);
  const allowed = new Set(weekdays);
  for (let d = today; daysBetween(d, examDate) > 0; d = addDays(d, 1)) if (allowed.has(weekdayOf(d)) && !skip.has(d)) out.push(d);
  return out;
}

function minutesAr(m: number): string {
  if (m < 60) return `${m} دقيقة`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  const hs = h === 1 ? 'ساعة' : h === 2 ? 'ساعتان' : `${h} ساعات`;
  return r ? `${hs} و${r} دقيقة` : hs;
}

class Calendar {
  readonly cap: number[];
  constructor(
    readonly days: string[],
    daily: number,
  ) {
    this.cap = days.map(() => daily);
  }
  indexOnOrAfter(day: string): number {
    const i = this.days.findIndex((d) => daysBetween(day, d) >= 0);
    return i < 0 ? this.days.length : i;
  }
  /** earliest day index ≥ from with capacity ≥ minutes, or -1 */
  fit(from: number, minutes: number): number {
    for (let i = Math.max(0, from); i < this.days.length; i++) if (this.cap[i]! >= minutes) return i;
    return -1;
  }
}

export interface CoreResult {
  tasks: PlannedTask[];
  feasibility: PlanFeasibility;
}

export function planCore(input: PlanCoreInput): CoreResult {
  const days = studyDays(input.today, input.exam_date, input.weekdays, input.blocked);
  const cal = new Calendar(days, input.daily_minutes);
  const tasks: PlannedTask[] = [];
  const unfit: string[] = [];
  const estimates = new Set<string>();
  let required = 0;
  let ord = 0;
  const add = (i: number, t: Omit<PlannedTask, 'day' | 'priority' | 'ord'>) => {
    cal.cap[i]! -= t.minutes;
    tasks.push({ ...t, day: days[i]!, priority: PRIORITY[t.kind], ord: ord++ });
  };

  // 1) learn: lectures in the owner's order, split into chunks across days
  const finished = new Map<string, number>();
  let cursor = 0;
  for (const l of input.lectures) {
    const known = l.pages !== null && l.pages > 0;
    const total = known ? l.pages! * MIN_PER_PAGE : UNKNOWN_LECTURE_MINUTES;
    if (known) estimates.add(`تعلّم المحاضرة: ${MIN_PER_PAGE} دقائق تقديرًا لكل صفحة.`);
    else estimates.add(`محاضرة لم يكتمل تحليلها (عدد صفحاتها غير معروف): ${UNKNOWN_LECTURE_MINUTES} دقيقة تقديرًا حتى تكتمل المعالجة.`);
    if (!input.include.learn) {
      finished.set(l.source_id, cursor);
      continue;
    }
    required += total;
    let left = total;
    let pageFrom = 1;
    while (left > 0) {
      const want = Math.min(left, MIN_CHUNK);
      const i = cal.fit(cursor, want);
      if (i < 0) {
        const pagesLeft = known ? `، الصفحات ${pageFrom}–${l.pages}` : '';
        unfit.push(`لا تتسع الأيام المتاحة لإكمال تعلّم «${l.title}»: تبقّى ${minutesAr(left)}${pagesLeft}.`);
        break;
      }
      const take = Math.min(cal.cap[i]!, left);
      const isLast = take === left;
      let pageTo: number | null = null;
      if (known) {
        pageFrom = Math.min(pageFrom, l.pages!);
        pageTo = isLast ? l.pages! : Math.min(l.pages!, pageFrom + Math.max(1, Math.round(take / MIN_PER_PAGE)) - 1);
      }
      const range = known ? ` — ص ${pageFrom}–${pageTo}` : '';
      add(i, {
        kind: 'learn',
        title_ar: `تعلّم «${l.title}»${range}${known ? '' : ' (الحجم تقديري)'}`,
        ref: { source_id: l.source_id, ...(known ? { page_from: pageFrom, page_to: pageTo } : {}) },
        minutes: take,
      });
      if (pageTo !== null) pageFrom = pageTo + 1;
      left -= take;
      cursor = i;
      if (left === 0) finished.set(l.source_id, i);
    }
  }

  // 2) MCQ practice on the lecture's linked questions (the day it is finished, else the next day with room)
  if (input.include.mcq) {
    for (const l of input.lectures) {
      if (l.question_count <= 0 || !finished.has(l.source_id)) continue;
      const minutes = Math.max(10, Math.min(30, Math.round(Math.min(l.question_count, 20) * MCQ_MIN_PER_QUESTION)));
      estimates.add(`أسئلة الاختيار من متعدد: ${MCQ_MIN_PER_QUESTION} دقيقة تقديرًا لكل سؤال (حتى 20 سؤالًا في الجلسة).`);
      required += minutes;
      const i = cal.fit(finished.get(l.source_id)!, minutes);
      if (i < 0) unfit.push(`لا يتسع وقت لتدريب أسئلة «${l.title}» (${minutesAr(minutes)}).`);
      else add(i, { kind: 'mcq', title_ar: `أسئلة على «${l.title}» (${Math.min(l.question_count, 20)} سؤالًا كحد أقصى)`, ref: { source_id: l.source_id, question_count: l.question_count }, minutes });
    }
  }

  // 3) spaced reviews after each lecture
  if (input.include.review) {
    estimates.add('المراجعة المتباعدة: دقيقة لكل صفحة (10–30 دقيقة) بعد يوم و3 أيام و7 أيام من إنهاء المحاضرة.');
    for (const l of input.lectures) {
      const fi = finished.get(l.source_id);
      if (fi === undefined || !input.include.learn) continue;
      const minutes = l.pages ? Math.max(10, Math.min(30, l.pages)) : 15;
      for (const off of REVIEW_OFFSETS) {
        const target = addDays(days[fi]!, off);
        if (daysBetween(target, input.exam_date) <= 0) continue; // after the exam: not needed
        required += minutes;
        const i = cal.fit(cal.indexOnOrAfter(target), minutes);
        if (i < 0) unfit.push(`لا تتسع مراجعة «${l.title}» بعد ${off === 1 ? 'يوم' : `${off} أيام`} (${minutesAr(minutes)}).`);
        else add(i, { kind: 'review', title_ar: `مراجعة «${l.title}» (بعد ${off === 1 ? 'يوم' : `${off} أيام`} من إنهائها)`, ref: { source_id: l.source_id, offset_days: off }, minutes });
      }
    }
    // a closing review on the last study day, only with the room that is left
    const last = days.length - 1;
    if (last >= 2 && input.lectures.length > 0 && cal.cap[last]! >= MIN_CHUNK) {
      add(last, { kind: 'review', title_ar: 'مراجعة ختامية خفيفة لأهم ما درست', ref: { source_ids: input.lectures.map((l) => l.source_id), closing: true }, minutes: Math.min(60, cal.cap[last]!) });
    }
  }

  // 4) daily flashcards (what is left of each day, never more than a quarter of the day)
  if (input.include.flashcards && input.flashcards_minutes > 0) {
    const per = Math.min(input.flashcards_minutes, Math.max(5, Math.floor(input.daily_minutes / 4)));
    estimates.add(`البطاقات اليومية: ${per} دقيقة تقديرًا من عدد البطاقات المستحقة والجديدة.`);
    let missed = 0;
    days.forEach((_, i) => {
      required += per;
      if (cal.cap[i]! >= Math.min(per, 5)) add(i, { kind: 'flashcards', title_ar: 'مراجعة البطاقات المستحقة', ref: null, minutes: Math.min(per, cal.cap[i]!) });
      else missed++;
    });
    if (missed) unfit.push(`لا يتسع وقت للبطاقات في ${missed === 1 ? 'يوم واحد' : missed === 2 ? 'يومين' : `${missed} أيام`} مزدحمة بالتعلّم.`);
  }

  // 5) weakness revisions: one per weakness, spread every third study day
  if (input.include.weakness) {
    input.weaknesses.slice(0, 5).forEach((w, k) => {
      const minutes = 20;
      required += minutes;
      const i = cal.fit(Math.min(days.length - 1, 1 + k * 3), minutes);
      if (i < 0) unfit.push(`لا يتسع وقت لمراجعة نقطة الضعف «${w.label}».`);
      else add(i, { kind: 'weakness', title_ar: `مراجعة مخصصة لنقطة ضعف: «${w.label}»`, ref: { weakness_id: w.id }, minutes });
    });
  }

  // exam day marker
  tasks.push({ day: input.exam_date, kind: 'exam', title_ar: 'يوم الامتحان', ref: null, minutes: 0, priority: PRIORITY.exam, ord: ord++ });

  const available = days.length * input.daily_minutes;
  const feasible = unfit.length === 0;
  const summary = days.length === 0
    ? 'لا توجد أيام دراسة متاحة قبل موعد الامتحان بحسب الأيام والقيود التي حددتها.'
    : feasible
      ? `الخطة تتسع: ${minutesAr(required)} مطلوبة تقديرًا من ${minutesAr(available)} متاحة خلال ${days.length} يوم دراسة.`
      : `الأيام المتاحة لا تتسع لكل شيء: ${minutesAr(required)} مطلوبة تقديرًا مقابل ${minutesAr(available)} متاحة. ما لا يتسع مذكور أدناه ولم يُحشر في الأيام الأخيرة.`;
  tasks.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.priority - b.priority || a.ord - b.ord));
  return {
    tasks,
    feasibility: { feasible: feasible && days.length > 0, required_minutes: required, available_minutes: available, study_days: days.length, summary_ar: summary, unfit_ar: unfit, estimates_ar: [...estimates] },
  };
}

// ───────── inputs from the database ─────────
function lectureInputs(ctx: AppContext, sourceIds: string[]): LectureInput[] {
  const out: LectureInput[] = [];
  for (const id of sourceIds) {
    const s = ctx.db.get<{ id: string; title: string; deleted_at: number | null; current_version_id: string | null; frozen_version_id: string | null }>(
      'SELECT id, title, deleted_at, current_version_id, frozen_version_id FROM source WHERE id = ?',
      [id],
    );
    if (!s || s.deleted_at !== null) throw new AppError('VALIDATION_FAILED', 'أحد المصادر المختارة غير موجود أو في سلة المحذوفات.', 400, { source_id: id });
    const vid = s.frozen_version_id ?? s.current_version_id;
    const v = vid ? ctx.db.get<{ page_count: number | null; processing_status: string }>('SELECT page_count, processing_status FROM source_version WHERE id = ?', [vid]) : undefined;
    const pages = v?.page_count ?? (vid ? (ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM source_page WHERE version_id = ?', [vid])?.n ?? 0) : 0);
    const qc =
      ctx.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM question_lecture_link l JOIN question q ON q.id = l.question_id
          WHERE l.lecture_source_id = ? AND l.status <> 'rejected' AND l.relation <> 'course_related_only' AND q.deleted_at IS NULL AND q.status <> 'retired'`,
        [id],
      )?.n ?? 0;
    out.push({ source_id: id, title: s.title.replace(/[\r\n\t]+/g, ' ').trim(), pages: pages > 0 ? pages : null, processing: v?.processing_status ?? 'pending', question_count: qc });
  }
  return out;
}

function flashcardMinutes(ctx: AppContext): number {
  const q = reviewQueue(ctx, { limit: 0 });
  const load = q.counts.due_today + Math.min(q.counts.new_limit, q.counts.new_available);
  if (load === 0) return 0;
  const secs = measuredPace(ctx.db).median_seconds_per_card ?? 30;
  return Math.max(5, Math.ceil((load * secs) / 60));
}

function coreInput(ctx: AppContext, c: StudyPlanConfig, today: string): PlanCoreInput {
  if (daysBetween(today, c.exam_date) < 0) throw new AppError('VALIDATION_FAILED', 'موعد الامتحان في الماضي؛ اختر تاريخًا قادمًا.', 400);
  // a plan is a day-by-day schedule: an unbounded horizon (a typo like 2206) would build hundreds of thousands of days
  if (daysBetween(today, c.exam_date) > MAX_PLAN_DAYS) {
    throw new AppError('VALIDATION_FAILED', `موعد الامتحان بعيد جدًا: الخطة تُبنى يومًا بيوم حتى ${MAX_PLAN_DAYS} يومًا (نحو ثلاث سنوات) كحد أقصى. تحقّق من التاريخ.`, 400);
  }
  let weaknesses: Array<{ id: string; label: string }> = [];
  if (c.include.weakness) {
    refreshWeaknesses(ctx);
    weaknesses = listStored(ctx, 'open').slice(0, 5).map((w) => ({ id: w.id, label: w.label }));
  }
  return {
    today,
    exam_date: c.exam_date,
    weekdays: c.available_weekdays,
    daily_minutes: c.daily_minutes,
    blocked: c.blocked_dates,
    include: c.include,
    lectures: lectureInputs(ctx, [...new Set(c.source_ids)]),
    flashcards_minutes: c.include.flashcards ? flashcardMinutes(ctx) : 0,
    weaknesses,
  };
}

// ───────── persistence ─────────
interface PlanRow {
  id: string;
  title: string;
  exam_date: string | null;
  config_json: string;
  status: 'active' | 'archived';
  version: number;
  last_rebalanced_at: number | null;
  created_at: number;
  updated_at: number;
  timezone: string | null;
  feasibility_json: string | null;
  report_json: string | null;
}

interface TaskRow {
  id: string;
  plan_id: string;
  day: string;
  kind: PlanTaskView['kind'];
  ref_json: string | null;
  minutes: number;
  status: PlanTaskView['status'];
  moved_from_day: string | null;
  title_ar: string | null;
  ord: number;
  priority: number;
  done_at: number | null;
  created_at: number;
}

const taskView = (t: TaskRow): PlanTaskView => ({
  id: t.id,
  plan_id: t.plan_id,
  day: t.day,
  kind: t.kind,
  title_ar: t.title_ar ?? '',
  ref: fromJson<Record<string, unknown>>(t.ref_json),
  minutes: t.minutes,
  status: t.status,
  moved_from_day: t.moved_from_day,
});

function requirePlan(ctx: AppContext, id: string): PlanRow {
  const p = ctx.db.get<PlanRow>('SELECT * FROM study_plan WHERE id = ?', [id]);
  if (!p) throw new AppError('NOT_FOUND', 'الخطة غير موجودة.', 404);
  return p;
}

function planTz(ctx: AppContext, p: Pick<PlanRow, 'timezone'>): string {
  return p.timezone && isValidTimeZone(p.timezone) ? p.timezone : srsContext(ctx).timezone;
}

export function planView(ctx: AppContext, id: string): StudyPlanView {
  const p = requirePlan(ctx, id);
  const tz = planTz(ctx, p);
  const today = dayOf(ctx.clock.now(), tz);
  const tasks = ctx.db.all<TaskRow>('SELECT * FROM plan_task WHERE plan_id = ? ORDER BY day, priority, ord, created_at', [id]);
  const config = fromJson<StudyPlanConfig>(p.config_json)!;
  return {
    id: p.id,
    title: p.title,
    status: p.status,
    config,
    timezone: tz,
    version: p.version,
    today,
    days_left: p.exam_date ? daysBetween(today, p.exam_date) : null,
    tasks: tasks.map(taskView),
    feasibility: fromJson<PlanFeasibility>(p.feasibility_json) ?? { feasible: false, required_minutes: 0, available_minutes: 0, study_days: 0, summary_ar: '', unfit_ar: [], estimates_ar: [] },
    last_report: fromJson<PlanRebalanceReport>(p.report_json),
    last_rebalanced_at: p.last_rebalanced_at,
    behind: tasks.filter((t) => t.status === 'todo' && t.kind !== 'exam' && t.day < today).length,
    created_at: p.created_at,
    updated_at: p.updated_at,
  };
}

export function previewPlan(ctx: AppContext, config: StudyPlanConfig): PlanPreviewResponse {
  const tz = srsContext(ctx).timezone;
  const today = dayOf(ctx.clock.now(), tz);
  const r = planCore(coreInput(ctx, config, today));
  return { tasks: r.tasks.map((t, k) => ({ id: `preview-${k}`, plan_id: 'preview', day: t.day, kind: t.kind, title_ar: t.title_ar, ref: t.ref, minutes: t.minutes, status: 'todo', moved_from_day: null })), feasibility: r.feasibility, today };
}

export function createPlan(ctx: AppContext, config: StudyPlanConfig): StudyPlanView {
  const tz = srsContext(ctx).timezone;
  const now = ctx.clock.now();
  const today = dayOf(now, tz);
  const r = planCore(coreInput(ctx, config, today));
  const id = newId(now);
  ctx.db.tx(() => {
    ctx.db.run(
      `INSERT INTO study_plan (id, title, exam_date, config_json, status, version, last_rebalanced_at, created_at, updated_at, timezone, feasibility_json, report_json, generator_version)
       VALUES (?, ?, ?, ?, 'active', 1, NULL, ?, ?, ?, ?, NULL, ?)`,
      [id, config.title, config.exam_date, toJson(config), now, now, tz, toJson(r.feasibility), PLANNER_VERSION],
    );
    for (const t of r.tasks) insertTask(ctx, id, t, null, now);
    ctx.audit.record({ entityType: 'study_plan', entityId: id, action: 'create', summary: `أنشأت خطة دراسة «${config.title}» حتى ${config.exam_date}.` });
  });
  return planView(ctx, id);
}

function insertTask(ctx: AppContext, planId: string, t: Pick<PlannedTask, 'day' | 'kind' | 'title_ar' | 'ref' | 'minutes' | 'priority' | 'ord'>, movedFrom: string | null, now: number): string {
  const id = newId(now);
  ctx.db.run(
    `INSERT INTO plan_task (id, plan_id, day, kind, ref_json, minutes, status, moved_from_day, created_at, updated_at, title_ar, ord, priority, done_at)
     VALUES (?, ?, ?, ?, ?, ?, 'todo', ?, ?, ?, ?, ?, ?, NULL)`,
    [id, planId, t.day, t.kind, t.ref ? toJson(t.ref) : null, t.minutes, movedFrom, now, now, t.title_ar, t.ord, t.priority],
  );
  return id;
}

export function listPlans(ctx: AppContext): PlanListResponse {
  const rows = ctx.db.all<PlanRow>(`SELECT * FROM study_plan ORDER BY status = 'active' DESC, exam_date, created_at DESC`);
  return {
    items: rows.map((p) => {
      const v = planView(ctx, p.id);
      return { id: p.id, title: p.title, status: p.status, today: v.today, days_left: v.days_left, behind: v.behind, created_at: p.created_at, updated_at: p.updated_at, exam_date: p.exam_date ?? '' };
    }),
  };
}

export function setTaskStatus(ctx: AppContext, planId: string, taskId: string, status: 'todo' | 'done' | 'skipped'): StudyPlanView {
  ctx.db.tx(() => {
    requirePlan(ctx, planId);
    const t = ctx.db.get<TaskRow>('SELECT * FROM plan_task WHERE id = ? AND plan_id = ?', [taskId, planId]);
    if (!t) throw new AppError('NOT_FOUND', 'المهمة غير موجودة في هذه الخطة.', 404);
    if (t.status === 'moved') throw new AppError('CONFLICT', 'نُقلت هذه المهمة إلى يوم آخر؛ عدّل النسخة الجديدة منها.', 409);
    if (t.kind === 'exam') throw new AppError('VALIDATION_FAILED', 'يوم الامتحان ليس مهمة تُنجز.', 400);
    const now = ctx.clock.now();
    ctx.db.run('UPDATE plan_task SET status = ?, done_at = ?, updated_at = ? WHERE id = ?', [status, status === 'done' ? now : null, now, taskId]);
    ctx.db.run('UPDATE study_plan SET updated_at = ? WHERE id = ?', [now, planId]);
    ctx.audit.record({ entityType: 'plan_task', entityId: taskId, action: `status_${status}`, summary: `${status === 'done' ? 'أنجزت' : status === 'skipped' ? 'تخطيت' : 'أعدت فتح'} مهمة «${t.title_ar ?? ''}» (${t.day}).` });
  });
  return planView(ctx, planId);
}

export function archivePlan(ctx: AppContext, planId: string): StudyPlanView {
  requirePlan(ctx, planId);
  const now = ctx.clock.now();
  ctx.db.run(`UPDATE study_plan SET status = 'archived', updated_at = ? WHERE id = ?`, [now, planId]);
  ctx.audit.record({ entityType: 'study_plan', entityId: planId, action: 'archive', summary: 'أرشفت خطة دراسة (مهامها وسجلها محفوظة).' });
  return planView(ctx, planId);
}

// ───────── rebalance ─────────
/** Pure rebalance core: place unfinished tasks from today on, in priority order, within capacity (exported for tests). */
export function rebalanceCore(
  input: { today: string; exam_date: string; weekdays: number[]; daily_minutes: number; blocked: string[]; doneMinutesByDay: Record<string, number> },
  pending: Array<{ id: string; day: string; kind: PlanTaskView['kind']; minutes: number; priority: number; ord: number; title_ar: string }>,
): { placed: Array<{ id: string; day: string; minutes: number; part: number }>; dropped: string[] } {
  const days = studyDays(input.today, input.exam_date, input.weekdays, input.blocked);
  const cal = new Calendar(days, input.daily_minutes);
  days.forEach((d, i) => (cal.cap[i]! -= Math.min(cal.cap[i]!, input.doneMinutesByDay[d] ?? 0)));
  const placed: Array<{ id: string; day: string; minutes: number; part: number }> = [];
  const dropped: string[] = [];
  const order = [...pending].sort((a, b) => a.priority - b.priority || (a.day < b.day ? -1 : a.day > b.day ? 1 : 0) || a.ord - b.ord);
  let learnCursor = 0;
  for (const t of order) {
    const from = Math.max(cal.indexOnOrAfter(t.day < input.today ? input.today : t.day), t.kind === 'learn' ? learnCursor : 0);
    const whole = cal.fit(from, t.minutes);
    if (whole >= 0) {
      cal.cap[whole]! -= t.minutes;
      placed.push({ id: t.id, day: days[whole]!, minutes: t.minutes, part: 0 });
      if (t.kind === 'learn') learnCursor = whole;
      continue;
    }
    if (t.kind === 'learn' && t.minutes > MIN_CHUNK) {
      // split a learning block across the days that still have room (each part ≥ MIN_CHUNK)
      let left = t.minutes;
      let part = 0;
      const parts: Array<{ i: number; m: number }> = [];
      let i = cal.fit(from, MIN_CHUNK);
      while (left > 0 && i >= 0) {
        const m = Math.min(left, cal.cap[i]!);
        parts.push({ i, m });
        left -= m;
        i = cal.fit(i + 1, Math.min(MIN_CHUNK, left));
      }
      if (left === 0) {
        for (const p of parts) {
          cal.cap[p.i]! -= p.m;
          placed.push({ id: t.id, day: days[p.i]!, minutes: p.m, part: part++ });
          learnCursor = p.i;
        }
        continue;
      }
    }
    dropped.push(`«${t.title_ar}» (${minutesAr(t.minutes)}) لم تعد تتسع قبل الامتحان.`);
  }
  return { placed, dropped };
}

export function rebalancePlan(ctx: AppContext, planId: string): PlanRebalanceResponse {
  const p = requirePlan(ctx, planId);
  if (p.status !== 'active') throw new AppError('CONFLICT', 'الخطة مؤرشفة؛ أنشئ خطة جديدة.', 409);
  const config = fromJson<StudyPlanConfig>(p.config_json)!;
  const tz = planTz(ctx, p);
  const now = ctx.clock.now();
  const today = dayOf(now, tz);
  const report = ctx.db.tx(() => {
    const tasks = ctx.db.all<TaskRow>(`SELECT * FROM plan_task WHERE plan_id = ? AND status = 'todo' AND kind <> 'exam' ORDER BY day, priority, ord`, [planId]);
    const notes: string[] = [];
    // flashcards of past days are not carried over (today's review already contains everything due)
    const pastCards = tasks.filter((t) => t.kind === 'flashcards' && t.day < today);
    for (const t of pastCards) ctx.db.run(`UPDATE plan_task SET status = 'skipped', updated_at = ? WHERE id = ?`, [now, t.id]);
    if (pastCards.length) notes.push(`لم تُرحَّل بطاقات ${pastCards.length === 1 ? 'يوم مضى' : `${pastCards.length} أيام مضت`}: مراجعة اليوم تشمل كل ما استحق.`);
    const pending = tasks.filter((t) => !(t.kind === 'flashcards' && t.day < today));
    const done = ctx.db.all<{ day: string; m: number }>(`SELECT day, SUM(minutes) AS m FROM plan_task WHERE plan_id = ? AND status = 'done' GROUP BY day`, [planId]);
    const r = rebalanceCore(
      { today, exam_date: config.exam_date, weekdays: config.available_weekdays, daily_minutes: config.daily_minutes, blocked: config.blocked_dates, doneMinutesByDay: Object.fromEntries(done.map((d) => [d.day, d.m])) },
      pending.map((t) => ({ id: t.id, day: t.day, kind: t.kind, minutes: t.minutes, priority: t.priority, ord: t.ord, title_ar: t.title_ar ?? '' })),
    );
    const byTask = new Map<string, Array<{ day: string; minutes: number }>>();
    for (const pl of r.placed) pushTo(byTask, pl.id, { day: pl.day, minutes: pl.minutes });
    let moved = 0;
    const movedItems: string[] = [];
    for (const t of pending) {
      const places = byTask.get(t.id);
      if (!places) {
        ctx.db.run(`UPDATE plan_task SET status = 'skipped', updated_at = ? WHERE id = ?`, [now, t.id]);
        continue;
      }
      if (places.length === 1 && places[0]!.day === t.day) continue; // stays where it is
      ctx.db.run(`UPDATE plan_task SET status = 'moved', updated_at = ? WHERE id = ?`, [now, t.id]);
      for (const pl of places) {
        insertTask(ctx, planId, { day: pl.day, kind: t.kind, title_ar: t.title_ar ?? '', ref: fromJson(t.ref_json), minutes: pl.minutes, priority: t.priority, ord: t.ord }, t.day, now);
      }
      moved++;
      movedItems.push(`«${t.title_ar ?? ''}»: من ${t.day} إلى ${places.map((x) => x.day).join(' و')}`);
    }
    const feasible = r.dropped.length === 0;
    const summary = feasible
      ? moved
        ? `أُعيد توزيع ${moved} ${moved === 1 ? 'مهمة' : 'مهام'} على الأيام القادمة دون تجاوز ${minutesAr(config.daily_minutes)} في اليوم.`
        : 'لا حاجة لإعادة التوزيع: كل المهام في أيام تتسع لها.'
      : `أُعيد توزيع ما يتسع (${moved}). ${r.dropped.length === 1 ? 'مهمة واحدة لم تعد تتسع' : `${r.dropped.length} مهام لم تعد تتسع`} قبل الامتحان — مذكورة صراحة وعُلّمت «متخطاة»، ولم تُحشر في الأيام الأخيرة.`;
    const rep: PlanRebalanceReport & { moved_items_ar: string[] } = { moved, dropped_ar: [...r.dropped, ...notes], feasible, summary_ar: summary, moved_items_ar: movedItems };
    const remaining = ctx.db.get<{ m: number }>(`SELECT COALESCE(SUM(minutes), 0) AS m FROM plan_task WHERE plan_id = ? AND status = 'todo'`, [planId])!.m;
    const days = studyDays(today, config.exam_date, config.available_weekdays, config.blocked_dates);
    const prev = fromJson<PlanFeasibility>(p.feasibility_json);
    const feas: PlanFeasibility = {
      feasible,
      required_minutes: remaining,
      available_minutes: days.length * config.daily_minutes,
      study_days: days.length,
      summary_ar: summary,
      unfit_ar: r.dropped,
      estimates_ar: prev?.estimates_ar ?? [],
    };
    ctx.db.run('UPDATE study_plan SET version = version + 1, last_rebalanced_at = ?, report_json = ?, feasibility_json = ?, updated_at = ? WHERE id = ?', [now, toJson(rep), toJson(feas), now, planId]);
    ctx.audit.record({ entityType: 'study_plan', entityId: planId, action: 'rebalance', summary });
    return rep;
  });
  return { plan: planView(ctx, planId), report };
}
