// Planner + owner-day display (§45, §47): plan days are YYYY-MM-DD in the PLAN's timezone and are shown as calendar
// dates whatever the device timezone; «today» / due-today boundaries follow the OWNER zone (Asia/Baghdad by default);
// rebalance diffs are computed from the server's rows; the month grid starts on Saturday.
import { afterEach, describe, expect, it } from 'vitest';
import type { PlanTaskView } from '@medlevo/shared';
import { configProblems, emptyConfig, groupByDay, monthGrid, rebalanceDiff, movedLineAr } from '../../src/features/planner/model';
import { addDays, dayEndMs, dayLabelAr, dayOf, dayStartMs, daysBetween, relativeDayAr } from '../../src/features/review/local/time';

const ORIGINAL_TZ = process.env.TZ;
afterEach(() => {
  process.env.TZ = ORIGINAL_TZ;
});

function task(over: Partial<PlanTaskView>): PlanTaskView {
  return { id: 't', plan_id: 'P', day: '2026-10-10', kind: 'learn', title_ar: 'تعلّم «Shock»', ref: null, minutes: 30, status: 'todo', moved_from_day: null, ...over };
}

describe('day keys are displayed as calendar dates, independent of the device timezone', () => {
  it('the same key gives the same label under five device timezones', () => {
    const labels = new Set<string>();
    for (const tz of ['Asia/Baghdad', 'America/Los_Angeles', 'Pacific/Kiritimati', 'Pacific/Pago_Pago', 'UTC']) {
      process.env.TZ = tz;
      labels.add(dayLabelAr('2026-10-10'));
    }
    expect([...labels]).toEqual(['السبت 10 أكتوبر']);
    expect(dayLabelAr('2027-01-05', { year: true })).toBe('الثلاثاء 5 يناير 2027');
  });

  it('owner day boundaries are Baghdad midnights (UTC+3), not the device or UTC day', () => {
    process.env.TZ = 'America/Los_Angeles';
    // 22:30 UTC on Oct 10 is already Oct 11 in Baghdad
    expect(dayOf(Date.UTC(2026, 9, 10, 22, 30), 'Asia/Baghdad')).toBe('2026-10-11');
    expect(dayOf(Date.UTC(2026, 9, 10, 20, 59), 'Asia/Baghdad')).toBe('2026-10-10');
    expect(dayStartMs('2026-10-11', 'Asia/Baghdad')).toBe(Date.UTC(2026, 9, 10, 21, 0));
    expect(dayEndMs('2026-10-10', 'Asia/Baghdad')).toBe(Date.UTC(2026, 9, 10, 21, 0));
  });

  it('a day whose midnight is skipped by DST starts at its first local instant (same rule as the server)', () => {
    // America/Santiago jumps from 00:00 to 01:00 on 2026-09-06
    const start = dayStartMs('2026-09-06', 'America/Santiago');
    expect(dayOf(start, 'America/Santiago')).toBe('2026-09-06');
    expect(dayOf(start - 1, 'America/Santiago')).toBe('2026-09-05');
  });

  it('relative labels and calendar arithmetic', () => {
    expect(relativeDayAr('2026-10-10', '2026-10-10')).toBe('اليوم');
    expect(relativeDayAr('2026-10-11', '2026-10-10')).toBe('غدًا');
    expect(relativeDayAr('2026-10-09', '2026-10-10')).toBe('أمس');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(daysBetween('2026-10-10', '2026-11-09')).toBe(30);
  });
});

describe('plan days', () => {
  const tasks = [
    task({ id: 'a', day: '2026-10-09', status: 'todo' }),
    task({ id: 'b', day: '2026-10-09', status: 'moved' }),
    task({ id: 'c', day: '2026-10-10', status: 'done', minutes: 45 }),
    task({ id: 'd', day: '2026-10-10', kind: 'flashcards', minutes: 15 }),
    task({ id: 'e', day: '2026-11-01', kind: 'exam', minutes: 0, title_ar: 'يوم الامتحان' }),
  ];
  it('groups by day in order; moved rows are history, not load', () => {
    const days = groupByDay(tasks, '2026-10-10');
    expect(days.map((d) => d.day)).toEqual(['2026-10-09', '2026-10-10', '2026-11-01']);
    expect(days[0]).toMatchObject({ isPast: true, open: 1, minutes: 30 });
    expect(days[1]).toMatchObject({ isToday: true, done: 1, open: 1, minutes: 60 });
    expect(days[2]).toMatchObject({ isExam: true, open: 0 });
  });

  it('rebalance diff: only the new rows that carry where they came from', () => {
    const before = [task({ id: 'x', day: '2026-10-08' }), task({ id: 'y', day: '2026-10-09', kind: 'mcq', title_ar: 'أسئلة' })];
    const after = [
      task({ id: 'x', day: '2026-10-08', status: 'moved' }),
      task({ id: 'y', day: '2026-10-09', status: 'moved', kind: 'mcq', title_ar: 'أسئلة' }),
      task({ id: 'x2', day: '2026-10-11', moved_from_day: '2026-10-08' }),
      task({ id: 'y2', day: '2026-10-10', moved_from_day: '2026-10-09', kind: 'mcq', title_ar: 'أسئلة' }),
      task({ id: 'n', day: '2026-10-12' }),
    ];
    const d = rebalanceDiff(before, after);
    expect(d.map((m) => [m.from, m.to])).toEqual([
      ['2026-10-09', '2026-10-10'],
      ['2026-10-08', '2026-10-11'],
    ]);
    expect(movedLineAr(d[0]!, '2026-10-10')).toBe('أسئلة: من أمس إلى اليوم');
  });

  it('the month grid starts on Saturday and covers the month', () => {
    const grid = monthGrid('2026-10-01', groupByDay(tasks, '2026-10-10'));
    expect(grid[0]![0]!.day).toBe('2026-09-26'); // a Saturday
    const inMonth = grid.flat().filter((c) => c.inMonth);
    expect(inMonth).toHaveLength(31);
    expect(grid.flat().find((c) => c.day === '2026-10-10')?.plan?.minutes).toBe(60);
  });

  it('client-side checks before asking the server', () => {
    const c = emptyConfig('2026-10-10');
    expect(configProblems(c, '2026-10-10')).toEqual(['اكتب اسمًا للخطة.', 'اختر محاضرة واحدة على الأقل.']);
    expect(configProblems({ ...c, title: 'x', source_ids: ['S'], exam_date: '2030-01-01' }, '2026-10-10')).toEqual(['تاريخ الامتحان بعيد جدًا (أكثر من 3 سنوات)؛ تحقق منه.']);
    expect(configProblems({ ...c, title: 'x', source_ids: ['S'], exam_date: '2026-10-10' }, '2026-10-10')).toEqual(['تاريخ الامتحان يجب أن يكون بعد اليوم.']);
  });
});
