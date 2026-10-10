// Planner helpers (§45): days are YYYY-MM-DD in the PLAN's timezone (stored with the plan); the screens format day keys
// as calendar dates (never re-interpreted in the device timezone). Pure functions — tested.
import type { PlanTaskView, StudyPlanConfig } from '@medlevo/shared';
import { addDays, dayLabelAr, daysBetween, relativeDayAr, weekdayOf } from '../review/local/time';

export const TASK_KIND_AR: Record<PlanTaskView['kind'], string> = {
  learn: 'تعلّم',
  review: 'مراجعة',
  mcq: 'أسئلة',
  flashcards: 'بطاقات',
  weakness: 'نقطة ضعف',
  exam: 'الامتحان',
};

export const TASK_STATUS_AR: Record<PlanTaskView['status'], string> = { todo: 'لم تُنجز بعد', done: 'أنجزتها', skipped: 'تخطيتها', moved: 'نُقلت' };

export interface PlanDay {
  day: string;
  tasks: PlanTaskView[];
  /** minutes of the tasks that count for the day (moved rows are history, not load) */
  minutes: number;
  done: number;
  open: number;
  isToday: boolean;
  isPast: boolean;
  isExam: boolean;
}

/** Tasks grouped by day in order; moved rows stay visible as history but do not count as load. */
export function groupByDay(tasks: readonly PlanTaskView[], today: string): PlanDay[] {
  const map = new Map<string, PlanTaskView[]>();
  for (const t of tasks) {
    const list = map.get(t.day) ?? [];
    list.push(t);
    map.set(t.day, list);
  }
  return [...map.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([day, list]) => {
      const live = list.filter((t) => t.status !== 'moved');
      return {
        day,
        tasks: list,
        minutes: live.reduce((a, t) => a + t.minutes, 0),
        done: live.filter((t) => t.status === 'done').length,
        open: live.filter((t) => t.status === 'todo' && t.kind !== 'exam').length,
        isToday: day === today,
        isPast: daysBetween(today, day) < 0,
        isExam: list.some((t) => t.kind === 'exam'),
      };
    });
}

export interface RebalanceDiffItem {
  title_ar: string;
  kind: PlanTaskView['kind'];
  from: string;
  to: string;
  minutes: number;
}

/** What a rebalance moved: tasks that are new after it and carry `moved_from_day` (the old rows stay as `moved`). */
export function rebalanceDiff(before: readonly PlanTaskView[], after: readonly PlanTaskView[]): RebalanceDiffItem[] {
  const had = new Set(before.map((t) => t.id));
  return after
    .filter((t) => !had.has(t.id) && t.moved_from_day)
    .map((t) => ({ title_ar: t.title_ar, kind: t.kind, from: t.moved_from_day!, to: t.day, minutes: t.minutes }))
    .sort((a, b) => (a.to < b.to ? -1 : a.to > b.to ? 1 : 0));
}

/** «من الأحد 12 أكتوبر إلى الثلاثاء 14 أكتوبر» for a moved task. */
export function movedLineAr(m: RebalanceDiffItem, today: string): string {
  return `${m.title_ar}: من ${relativeDayAr(m.from, today)} إلى ${relativeDayAr(m.to, today)}`;
}

export interface CalendarCell {
  day: string;
  inMonth: boolean;
  plan: PlanDay | null;
}

/** A month grid (weeks start on Saturday, as in Iraqi calendars) for the month containing `anchor`. */
export function monthGrid(anchor: string, days: readonly PlanDay[], weekStart = 6): CalendarCell[][] {
  const [y, m] = anchor.split('-').map(Number) as [number, number];
  const first = `${y}-${String(m).padStart(2, '0')}-01`;
  const offset = (weekdayOf(first) - weekStart + 7) % 7;
  let cursor = addDays(first, -offset);
  const byDay = new Map(days.map((d) => [d.day, d]));
  const weeks: CalendarCell[][] = [];
  for (let w = 0; w < 6; w++) {
    const row: CalendarCell[] = [];
    for (let i = 0; i < 7; i++) {
      row.push({ day: cursor, inMonth: cursor.slice(0, 7) === first.slice(0, 7), plan: byDay.get(cursor) ?? null });
      cursor = addDays(cursor, 1);
    }
    weeks.push(row);
    if (cursor.slice(0, 7) !== first.slice(0, 7) && w >= 3) break;
  }
  return weeks;
}

export const monthLabelAr = (day: string) => dayLabelAr(day, { year: true, weekday: false }).replace(/^\d+\s+/, '');

export function emptyConfig(today: string): StudyPlanConfig {
  return {
    title: '',
    exam_date: addDays(today, 30),
    source_ids: [],
    available_weekdays: [0, 1, 2, 3, 4, 6],
    daily_minutes: 120,
    blocked_dates: [],
    include: { learn: true, review: true, mcq: true, flashcards: true, weakness: true },
  };
}

/** Client checks before asking the server (it validates again). */
export function configProblems(c: StudyPlanConfig, today: string): string[] {
  const out: string[] = [];
  if (!c.title.trim()) out.push('اكتب اسمًا للخطة.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(c.exam_date)) out.push('حدّد تاريخ الامتحان.');
  else if (daysBetween(today, c.exam_date) < 1) out.push('تاريخ الامتحان يجب أن يكون بعد اليوم.');
  else if (daysBetween(today, c.exam_date) > 1100) out.push('تاريخ الامتحان بعيد جدًا (أكثر من 3 سنوات)؛ تحقق منه.');
  if (c.source_ids.length === 0) out.push('اختر محاضرة واحدة على الأقل.');
  if (c.available_weekdays.length === 0) out.push('اختر يومًا واحدًا على الأقل في الأسبوع.');
  if (!(c.daily_minutes >= 15 && c.daily_minutes <= 960)) out.push('وقت الدراسة اليومي بين 15 و960 دقيقة.');
  if (!Object.values(c.include).some(Boolean)) out.push('اختر نوعًا واحدًا على الأقل مما تتضمنه الخطة.');
  return out;
}
