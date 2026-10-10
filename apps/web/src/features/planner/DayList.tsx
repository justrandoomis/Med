// The plan as a list of days (or a month calendar), in the PLAN's timezone. Each task: check-off (done / todo),
// skip, what it is, its minutes, where it came from after a rebalance, and a link to do it now.
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { BookOpen, ChevronLeft, ChevronRight, FileQuestion, Flag, Layers, RotateCcw, SkipForward, Target } from 'lucide-react';
import type { PlanTaskView } from '@medlevo/shared';
import { Checkbox, IconButton, SegmentedControl, StatusPill, cx } from '../../design';
import { BidiText } from '../evidence';
import { sessionUrl, studyUrl, weaknessUrl } from '../review/links';
import { dayLabelAr, minutesAr, relativeDayAr, WEEKDAYS_AR } from '../review/local/time';
import { TASK_KIND_AR, TASK_STATUS_AR, groupByDay, monthGrid, monthLabelAr, type PlanDay } from './model';

const KIND_ICON: Record<PlanTaskView['kind'], React.ReactNode> = {
  learn: <BookOpen size={16} aria-hidden="true" />,
  review: <RotateCcw size={16} aria-hidden="true" />,
  mcq: <FileQuestion size={16} aria-hidden="true" />,
  flashcards: <Layers size={16} aria-hidden="true" />,
  weakness: <Target size={16} aria-hidden="true" />,
  exam: <Flag size={16} aria-hidden="true" />,
};

const SHORT_DAYS = ['أحد', 'اثنين', 'ثلاثاء', 'أربعاء', 'خميس', 'جمعة', 'سبت'];

function taskLink(t: PlanTaskView, back: string): { to: string; label: string } | null {
  const r = (t.ref ?? {}) as Record<string, unknown>;
  if ((t.kind === 'learn' || t.kind === 'review') && typeof r.source_id === 'string') {
    const from = typeof r.page_from === 'number' ? r.page_from - 1 : null;
    return { to: studyUrl(r.source_id, { pageIndex: from }), label: t.kind === 'learn' ? 'افتح في الكتاب' : 'افتح للمراجعة' };
  }
  if (t.kind === 'mcq' && typeof r.source_id === 'string') return { to: `/practice?source_id=${encodeURIComponent(r.source_id)}`, label: 'ابدأ الأسئلة' };
  if (t.kind === 'flashcards') return { to: sessionUrl({ back }), label: 'ابدأ البطاقات' };
  if (t.kind === 'weakness' && typeof r.weakness_id === 'string') return { to: weaknessUrl(r.weakness_id), label: 'افتح نقطة الضعف' };
  return null;
}

function TaskRow({ t, today, readOnly, onSet, back }: { t: PlanTaskView; today: string; readOnly: boolean; onSet?: (t: PlanTaskView, s: 'todo' | 'done' | 'skipped') => void; back: string }) {
  const link = !readOnly && t.status !== 'moved' ? taskLink(t, back) : null;
  const history = t.status === 'moved';
  const meta = (
    <span className="lw-task__meta">
      {KIND_ICON[t.kind]} {TASK_KIND_AR[t.kind]}
      {t.minutes > 0 && ` · ${minutesAr(t.minutes)}`}
      {t.moved_from_day && ` · نُقلت إليه من ${relativeDayAr(t.moved_from_day, today)}`}
    </span>
  );
  return (
    <li className={cx('lw-task', history && 'lw-task--history')} data-status={t.status}>
      {t.kind === 'exam' ? (
        <p className="lw-task__exam">
          <Flag size={16} aria-hidden="true" /> {t.title_ar}
        </p>
      ) : readOnly || history ? (
        <div className="lw-task__text">
          <BidiText as="span" text={t.title_ar} />
          {meta}
        </div>
      ) : (
        <Checkbox
          checked={t.status === 'done'}
          onCheckedChange={(v) => onSet?.(t, v ? 'done' : 'todo')}
          label={<BidiText as="span" text={t.title_ar} />}
          description={meta}
        />
      )}
      <span className="lw-task__end">
        {(t.status === 'skipped' || history) && <StatusPill tone="neutral">{TASK_STATUS_AR[t.status]}</StatusPill>}
        {link && (
          <Link className="lw-link" to={link.to}>
            {link.label}
          </Link>
        )}
        {!readOnly && !history && t.kind !== 'exam' && t.status !== 'done' && (
          <IconButton
            label={t.status === 'skipped' ? `أعد «${t.title_ar}» إلى المهام` : `تخطَّ «${t.title_ar}»`}
            icon={t.status === 'skipped' ? <RotateCcw size={16} /> : <SkipForward size={16} />}
            onClick={() => onSet?.(t, t.status === 'skipped' ? 'todo' : 'skipped')}
          />
        )}
      </span>
    </li>
  );
}

function DayBlock({ d, today, daily, readOnly, onSet, back }: { d: PlanDay; today: string; daily: number; readOnly: boolean; onSet?: (t: PlanTaskView, s: 'todo' | 'done' | 'skipped') => void; back: string }) {
  return (
    <section className={cx('lw-day', d.isToday && 'lw-day--today', d.isPast && 'lw-day--past')} aria-labelledby={`day-${d.day}-h`} id={`day-${d.day}`}>
      <header className="lw-day__head">
        <h3 id={`day-${d.day}-h`} className="lw-day__title">
          {d.isToday ? `اليوم — ${dayLabelAr(d.day)}` : relativeDayAr(d.day, today) === dayLabelAr(d.day) ? dayLabelAr(d.day) : `${relativeDayAr(d.day, today)} — ${dayLabelAr(d.day)}`}
        </h3>
        {!d.isExam && <span className="lw-day__load">{`${minutesAr(d.minutes)} من ${minutesAr(daily)}`}</span>}
        {d.isPast && d.open > 0 && <StatusPill tone="warning">{`لم تُنجز ${d.open}`}</StatusPill>}
      </header>
      <ul className="lw-tasks">
        {d.tasks.map((t) => (
          <TaskRow key={t.id} t={t} today={today} readOnly={readOnly} onSet={onSet} back={back} />
        ))}
      </ul>
    </section>
  );
}

export interface DayListProps {
  tasks: PlanTaskView[];
  today: string;
  timezone: string;
  dailyMinutes: number;
  readOnly?: boolean;
  onSet?: (t: PlanTaskView, s: 'todo' | 'done' | 'skipped') => void;
  back?: string;
  /** show at most this many upcoming days (preview) */
  limit?: number;
}

export function DayList({ tasks, today, timezone, dailyMinutes, readOnly = false, onSet, back = '/planner', limit }: DayListProps) {
  const [view, setView] = useState<'list' | 'calendar'>('list');
  const days = useMemo(() => groupByDay(tasks, today), [tasks, today]);
  const past = days.filter((d) => d.isPast);
  const upcoming = days.filter((d) => !d.isPast);
  const shown = limit ? upcoming.slice(0, limit) : upcoming;
  const [month, setMonth] = useState(() => (upcoming[0]?.day ?? today).slice(0, 7) + '-01');
  const grid = useMemo(() => monthGrid(month, days), [month, days]);
  const shiftMonth = (n: number) => {
    const [y, m] = month.split('-').map(Number) as [number, number];
    const t = new Date(Date.UTC(y, m - 1 + n, 1));
    setMonth(`${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-01`);
  };

  return (
    <div className="lw-daylist">
      <div className="lw-head">
        <p className="lw-muted">{`الأيام بتوقيت الخطة: ${timezone}`}</p>
        <SegmentedControl<'list' | 'calendar'>
          label="طريقة العرض"
          options={[
            { value: 'list', label: 'قائمة الأيام' },
            { value: 'calendar', label: 'تقويم' },
          ]}
          value={view}
          onValueChange={setView}
          size="sm"
        />
      </div>
      {view === 'list' ? (
        <>
          {past.length > 0 && (
            <details className="lw-past">
              <summary>{`أيام سابقة (${past.length})${past.some((d) => d.open) ? ` — فيها ${past.reduce((a, d) => a + d.open, 0)} مهمة لم تُنجز` : ''}`}</summary>
              {past.map((d) => (
                <DayBlock key={d.day} d={d} today={today} daily={dailyMinutes} readOnly={readOnly} onSet={onSet} back={back} />
              ))}
            </details>
          )}
          {shown.map((d) => (
            <DayBlock key={d.day} d={d} today={today} daily={dailyMinutes} readOnly={readOnly} onSet={onSet} back={back} />
          ))}
          {limit && upcoming.length > limit && <p className="lw-muted">{`و${upcoming.length - limit} يومًا آخر في الخطة الكاملة.`}</p>}
        </>
      ) : (
        <div className="lw-cal">
          <div className="lw-cal__nav">
            <IconButton label="الشهر السابق" icon={<ChevronRight size={18} />} onClick={() => shiftMonth(-1)} />
            <h3 className="lw-cal__month" aria-live="polite">
              {monthLabelAr(month)}
            </h3>
            <IconButton label="الشهر التالي" icon={<ChevronLeft size={18} />} onClick={() => shiftMonth(1)} />
          </div>
          <table className="lw-cal__grid">
            <caption className="ml-visually-hidden">{`تقويم ${monthLabelAr(month)}: دقائق كل يوم وما أُنجز`}</caption>
            <thead>
              <tr>
                {[6, 0, 1, 2, 3, 4, 5].map((w) => (
                  <th key={w} scope="col" abbr={WEEKDAYS_AR[w]}>
                    {SHORT_DAYS[w]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {grid.map((week, i) => (
                <tr key={i}>
                  {week.map((c) => {
                    const p = c.plan;
                    const label = p ? (p.isExam ? 'الامتحان' : `${minutesAr(p.minutes)}، أُنجز ${p.done} من ${p.tasks.filter((t) => t.status !== 'moved' && t.kind !== 'exam').length}`) : 'لا مهام';
                    return (
                      <td key={c.day} className={cx('lw-cal__cell', !c.inMonth && 'lw-cal__cell--out', c.day === today && 'lw-cal__cell--today', p?.isExam && 'lw-cal__cell--exam')}>
                        {p && c.inMonth ? (
                          <button
                            type="button"
                            className="lw-cal__btn"
                            aria-label={`${dayLabelAr(c.day)}: ${label}`}
                            onClick={() => {
                              setView('list');
                              requestAnimationFrame(() => {
                                const el = document.getElementById(`day-${c.day}`);
                                const past = el?.closest('details');
                                if (past) past.open = true;
                                el?.scrollIntoView({ block: 'start' });
                              });
                            }}
                          >
                            <span className="lw-cal__num">{Number(c.day.slice(8))}</span>
                            <span className="lw-cal__info">{p.isExam ? 'امتحان' : `${p.minutes} د`}</span>
                            {!p.isExam && p.done > 0 && <span className="lw-cal__done">{`✓${p.done}`}</span>}
                          </button>
                        ) : (
                          <span className="lw-cal__num" aria-hidden={!c.inMonth}>
                            {Number(c.day.slice(8))}
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="lw-muted">كل خانة: دقائق اليوم في الخطة وعدد ما أنجزته. اضغط يومًا لفتح مهامه.</p>
        </div>
      )}
    </div>
  );
}
