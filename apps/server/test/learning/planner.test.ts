// Study planner (§45): deterministic schedule within the daily capacity, explicit «does not fit», rebalance when
// behind (moved tasks keep their history, never an impossible last day), task check-off, validation.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PlanRebalanceResponse, StudyPlanView } from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import { planCore, rebalanceCore, studyDays, type PlanCoreInput } from '../../src/modules/learning/planner';
import { api, createLearningApp, DAY, jump, ok, type LApp } from './helpers';

const base = (over: Partial<PlanCoreInput> = {}): PlanCoreInput => ({
  today: '2026-10-10',
  exam_date: '2026-10-20',
  weekdays: [0, 1, 2, 3, 4, 5, 6],
  daily_minutes: 90,
  blocked: [],
  include: { learn: true, review: true, mcq: true, flashcards: true, weakness: true },
  lectures: [
    { source_id: 'L1', title: 'Appendicitis', pages: 20, processing: 'ready', question_count: 8 },
    { source_id: 'L2', title: 'Cholecystitis', pages: 25, processing: 'ready', question_count: 0 },
    { source_id: 'L3', title: 'Shock', pages: null, processing: 'processing', question_count: 3 },
  ],
  flashcards_minutes: 12,
  weaknesses: [{ id: 'w1', label: 'Alvarado score' }],
  ...over,
});

function perDay(tasks: Array<{ day: string; minutes: number }>): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tasks) m.set(t.day, (m.get(t.day) ?? 0) + t.minutes);
  return m;
}

describe('planner core', () => {
  it('study days skip unavailable weekdays and blocked dates and stop before the exam', () => {
    const days = studyDays('2026-10-10', '2026-10-17', [0, 1, 2, 3, 4], ['2026-10-13']);
    // 10 Sat, 11 Sun, 12 Mon, 13 Tue (blocked), 14 Wed, 15 Thu, 16 Fri
    expect(days).toEqual(['2026-10-11', '2026-10-12', '2026-10-14', '2026-10-15']);
  });

  it('is deterministic, sized by page counts, never above the daily minutes, lectures in order', () => {
    const a = planCore(base());
    const b = planCore(base());
    expect(a).toEqual(b);
    for (const m of perDay(a.tasks).values()) expect(m).toBeLessThanOrEqual(90);
    const learn = a.tasks.filter((t) => t.kind === 'learn');
    expect(learn.filter((t) => t.ref!.source_id === 'L1').reduce((x, t) => x + t.minutes, 0)).toBe(80);
    expect(learn.filter((t) => t.ref!.source_id === 'L2').reduce((x, t) => x + t.minutes, 0)).toBe(100);
    expect(learn.filter((t) => t.ref!.source_id === 'L3').reduce((x, t) => x + t.minutes, 0)).toBe(45);
    // order kept: every L1 chunk is not after the first L2 chunk
    const lastL1 = learn.filter((t) => t.ref!.source_id === 'L1').at(-1)!.day;
    const firstL2 = learn.find((t) => t.ref!.source_id === 'L2')!.day;
    expect(lastL1 <= firstL2).toBe(true);
    // pages continue across chunks
    const l2 = learn.filter((t) => t.ref!.source_id === 'L2');
    expect(l2[0]!.ref!.page_from).toBe(1);
    expect(l2.at(-1)!.ref!.page_to).toBe(25);
    expect(a.tasks.find((t) => t.ref?.source_id === 'L3' && t.kind === 'learn')!.title_ar).toMatch(/تقديري/);
    // spaced reviews after the lecture, MCQ only where questions exist, weakness, flashcards, exam marker
    expect(a.tasks.filter((t) => t.kind === 'review' && t.ref?.source_id === 'L1').map((t) => t.ref!.offset_days)).toEqual([1, 3, 7]);
    expect(a.tasks.filter((t) => t.kind === 'mcq').map((t) => t.ref!.source_id)).toEqual(['L1', 'L3']);
    expect(a.tasks.some((t) => t.kind === 'weakness')).toBe(true);
    expect(a.tasks.filter((t) => t.kind === 'flashcards').length).toBeGreaterThan(0);
    expect(a.tasks.at(-1)).toMatchObject({ kind: 'exam', day: '2026-10-20', minutes: 0 });
    expect(a.feasibility.estimates_ar.join(' ')).toMatch(/تقديرًا/);
  });

  it('when time is short: what does not fit is listed, nothing is squeezed into the last day', () => {
    const r = planCore(base({ exam_date: '2026-10-13', daily_minutes: 60 }));
    expect(r.feasibility.feasible).toBe(false);
    expect(r.feasibility.unfit_ar.length).toBeGreaterThan(0);
    expect(r.feasibility.unfit_ar.join(' ')).toMatch(/لا تتسع/);
    expect(r.feasibility.summary_ar).toMatch(/لا تتسع/);
    for (const m of perDay(r.tasks).values()) expect(m).toBeLessThanOrEqual(60);
    const lastDay = studyDays('2026-10-10', '2026-10-13', [0, 1, 2, 3, 4, 5, 6], []).at(-1)!;
    expect(perDay(r.tasks).get(lastDay)!).toBeLessThanOrEqual(60);
    // no study day at all
    const none = planCore(base({ exam_date: '2026-10-10' }));
    expect(none.feasibility.feasible).toBe(false);
    expect(none.feasibility.study_days).toBe(0);
  });

  it('rebalance core: behind tasks move forward in priority order within capacity; the rest is dropped explicitly', () => {
    const pending = [
      { id: 'l1', day: '2026-10-08', kind: 'learn' as const, minutes: 60, priority: 0, ord: 0, title_ar: 'learn 1' },
      { id: 'l2', day: '2026-10-09', kind: 'learn' as const, minutes: 60, priority: 0, ord: 1, title_ar: 'learn 2' },
      { id: 'w', day: '2026-10-09', kind: 'weakness' as const, minutes: 20, priority: 4, ord: 2, title_ar: 'weak' },
      { id: 'r', day: '2026-10-11', kind: 'review' as const, minutes: 30, priority: 2, ord: 3, title_ar: 'review' },
    ];
    const r = rebalanceCore({ today: '2026-10-10', exam_date: '2026-10-12', weekdays: [0, 1, 2, 3, 4, 5, 6], daily_minutes: 90, blocked: [], doneMinutesByDay: { '2026-10-10': 30 } }, pending);
    const per = new Map<string, number>([['2026-10-10', 30]]);
    for (const p of r.placed) per.set(p.day, (per.get(p.day) ?? 0) + p.minutes);
    for (const m of per.values()) expect(m).toBeLessThanOrEqual(90);
    expect(r.placed.filter((p) => p.id === 'l1').map((p) => p.day)).toEqual(['2026-10-10']);
    expect(r.placed.find((p) => p.id === 'l2')!.day).toBe('2026-10-11');
    expect(r.placed.find((p) => p.id === 'r')!.day).toBe('2026-10-11');
    expect(r.dropped.join(' ')).toMatch(/weak/);
  });
});

describe('planner API', () => {
  let t: LApp;
  const T = Date.UTC(2026, 9, 10, 6, 0, 0); // 09:00 Baghdad, Saturday 2026-10-10
  let lecture: string;
  beforeEach(async () => {
    t = await createLearningApp({ now: T });
    lecture = newId();
    const v = newId();
    t.ctx.db.run(`INSERT INTO source (id, title, source_type, created_at, updated_at) VALUES (?, 'Acute Appendicitis', 'lecture', ?, ?)`, [lecture, T, T]);
    t.ctx.db.run(
      `INSERT INTO source_version (id, source_id, version_no, kind, content_hash, mime, format, page_count, processing_status, created_at) VALUES (?, ?, 1, 'original', 'h', 'application/pdf', 'pdf', 30, 'ready', ?)`,
      [v, lecture, T],
    );
    t.ctx.db.run('UPDATE source SET current_version_id = ? WHERE id = ?', [v, lecture]);
  });
  afterEach(async () => t.close());

  const config = (over: Record<string, unknown> = {}) => ({
    title: 'Surgery',
    exam_date: '2026-10-16',
    source_ids: [lecture],
    available_weekdays: [0, 1, 2, 3, 4, 5, 6],
    daily_minutes: 60,
    blocked_dates: [],
    include: { learn: true, review: true, mcq: false, flashcards: false, weakness: false },
    ...over,
  });

  it('preview = create; rebalance after missed days moves tasks (history kept) and reports what no longer fits', async () => {
    const preview = await ok(api(t).post('/api/learning/plans/preview', config()));
    const plan = await ok<StudyPlanView>(api(t).post('/api/learning/plans', config()));
    expect(plan.tasks.map((x) => [x.day, x.kind, x.minutes])).toEqual(preview.tasks.map((x: { day: string; kind: string; minutes: number }) => [x.day, x.kind, x.minutes]));
    expect(plan.today).toBe('2026-10-10');
    expect(plan.days_left).toBe(6);
    expect(plan.behind).toBe(0);
    expect(plan.feasibility.required_minutes).toBe(120 + 30 + 30); // 30 pages × 4 min + reviews (+1, +3 days)
    // check off the first task, skip nothing, then miss two days
    const first = plan.tasks.find((x) => x.kind === 'learn')!;
    await ok(api(t).patch(`/api/learning/plans/${plan.id}/tasks/${first.id}`, { status: 'done' }));
    await jump(t, T + 2 * DAY);
    const behind = await ok<StudyPlanView>(api(t).get(`/api/learning/plans/${plan.id}`));
    expect(behind.behind).toBeGreaterThan(0);
    const rb = await ok<PlanRebalanceResponse>(api(t).post(`/api/learning/plans/${plan.id}/rebalance`, {}));
    expect(rb.report.moved).toBeGreaterThan(0);
    expect(rb.report.moved_items_ar.length).toBe(rb.report.moved);
    expect(rb.plan.behind).toBe(0);
    const todo = rb.plan.tasks.filter((x) => x.status === 'todo' && x.kind !== 'exam');
    expect(todo.every((x) => x.day >= rb.plan.today)).toBe(true);
    for (const [day, m] of perDay(rb.plan.tasks.filter((x) => x.status === 'todo' || x.status === 'done'))) if (day >= rb.plan.today) expect(m).toBeLessThanOrEqual(60);
    // history: the old rows are 'moved', the new rows say where they came from
    expect(rb.plan.tasks.some((x) => x.status === 'moved')).toBe(true);
    expect(rb.plan.tasks.filter((x) => x.moved_from_day).length).toBeGreaterThan(0);
    expect(rb.plan.tasks.find((x) => x.id === first.id)!.status).toBe('done');
    expect(rb.plan.last_report).toMatchObject({ moved: rb.report.moved });
    // a moved row cannot be edited
    const movedRow = rb.plan.tasks.find((x) => x.status === 'moved')!;
    expect((await api(t).patch(`/api/learning/plans/${plan.id}/tasks/${movedRow.id}`, { status: 'done' })).statusCode).toBe(409);
    // the day before the exam, with almost nothing done: what does not fit is dropped AND reported
    await jump(t, Date.UTC(2026, 9, 15, 6, 0, 0));
    const late = await ok<PlanRebalanceResponse>(api(t).post(`/api/learning/plans/${plan.id}/rebalance`, {}));
    expect(late.report.feasible).toBe(false);
    expect(late.report.dropped_ar.length).toBeGreaterThan(0);
    expect(late.report.summary_ar).toMatch(/لم تُحشر/);
    const lastDay = perDay(late.plan.tasks.filter((x) => x.status === 'todo' && x.day === '2026-10-15'));
    expect(lastDay.get('2026-10-15') ?? 0).toBeLessThanOrEqual(60);
    expect(t.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM change_log WHERE entity_type = 'study_plan' AND action = 'rebalance'`)!.n).toBe(2);
  });

  it('validation: past exam date, unknown source, bad weekday', async () => {
    expect((await api(t).post('/api/learning/plans', config({ exam_date: '2026-10-01' }))).statusCode).toBe(400);
    expect((await api(t).post('/api/learning/plans', config({ source_ids: ['NOPE'] }))).statusCode).toBe(400);
    expect((await api(t).post('/api/learning/plans', config({ available_weekdays: [7] }))).statusCode).toBe(400);
    expect((await api(t).post('/api/learning/plans', config({ exam_date: '2026-13-01' }))).statusCode).toBe(400);
    expect((await api(t).post('/api/learning/plans', config({ daily_minutes: 5 }))).statusCode).toBe(400);
  });

  it('lists and archives plans', async () => {
    const plan = await ok<StudyPlanView>(api(t).post('/api/learning/plans', config()));
    const list = await ok(api(t).get('/api/learning/plans'));
    expect(list.items).toHaveLength(1);
    expect(list.items[0].exam_date).toBe('2026-10-16');
    const archived = await ok<StudyPlanView>(api(t).post(`/api/learning/plans/${plan.id}/archive`, {}));
    expect(archived.status).toBe('archived');
    expect((await api(t).post(`/api/learning/plans/${plan.id}/rebalance`, {})).statusCode).toBe(409);
  });
});
