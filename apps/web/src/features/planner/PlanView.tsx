// /planner/:id — one plan (§45): exam countdown in the plan's timezone, feasibility, today first, check-off, and a
// realistic rebalance when behind — with a VISIBLE diff of what moved where, what no longer fits, and whether the rest
// is still feasible. Moved tasks stay as history rows; nothing is squeezed into the last day.
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Archive, ArrowRight, CircleAlert, CircleCheck, Pencil, Scale } from 'lucide-react';
import type { PlanRebalanceResponse, PlanTaskView, StudyPlanView } from '@medlevo/shared';
import { Button, ConfirmDialog, ErrorState, LoadingState, StatusPill, buttonClass, useToast } from '../../design';
import { errorMessage } from '../../lib/api';
import { useCapabilities } from '../../lib/capabilities';
import { getDb, kvGet, kvSet } from '../../lib/localdb';
import { formatDateTime } from '../../lib/time';
import { usePageTitle } from '../../lib/usePageTitle';
import { BidiText } from '../evidence';
import { learningApi } from '../review/api';
import { dayLabelAr, daysCountAr, minutesAr } from '../review/local/time';
import { DayList } from './DayList';
import { movedLineAr, rebalanceDiff, type RebalanceDiffItem } from './model';
import '../review/learning.css';
import './planner.css';

const cacheKey = (id: string) => `learning.plan.${id}`;

export function PlanView() {
  const { id = '' } = useParams();
  const caps = useCapabilities();
  const toast = useToast();
  const [plan, setPlan] = useState<StudyPlanView | null>(null);
  const [fromCache, setFromCache] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [diff, setDiff] = useState<{ moved: RebalanceDiffItem[]; report: PlanRebalanceResponse['report'] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  usePageTitle(plan?.title ?? 'الخطة');

  const keep = (p: StudyPlanView) => {
    setPlan(p);
    setFromCache(false);
    void kvSet(getDb(), cacheKey(p.id), p).catch(() => undefined);
  };
  useEffect(() => {
    let cancelled = false;
    void learningApi
      .plan(id)
      .then((p) => !cancelled && keep(p))
      .catch(async (e) => {
        const cached = await kvGet<StudyPlanView>(getDb(), cacheKey(id)).catch(() => undefined);
        if (cancelled) return;
        if (cached) {
          setPlan(cached);
          setFromCache(true);
        } else setError(errorMessage(e, 'تعذّر تحميل الخطة.'));
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const setTask = async (t: PlanTaskView, status: 'todo' | 'done' | 'skipped') => {
    if (!plan) return;
    // optimistic, then the server's copy
    setPlan({ ...plan, tasks: plan.tasks.map((x) => (x.id === t.id ? { ...x, status } : x)) });
    try {
      keep(await learningApi.setTask(plan.id, t.id, status));
    } catch (e) {
      setPlan(plan);
      toast.show({ title: errorMessage(e, 'تعذّر حفظ حالة المهمة.'), tone: 'danger' });
    }
  };

  const rebalance = async () => {
    if (!plan) return;
    setBusy(true);
    try {
      const r = await learningApi.rebalance(plan.id);
      setDiff({ moved: rebalanceDiff(plan.tasks, r.plan.tasks), report: r.report });
      keep(r.plan);
    } catch (e) {
      toast.show({ title: errorMessage(e, 'تعذّرت إعادة الموازنة.'), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  if (error) return <div className="ml-page lw-page"><ErrorState message={error} /></div>;
  if (!plan) return <div className="ml-page lw-page"><LoadingState stage="جارٍ تحميل الخطة…" /></div>;
  const f = plan.feasibility;
  const archived = plan.status === 'archived';
  const readOnly = archived || fromCache || !caps.online;

  return (
    <div className="ml-page lw-page">
      <header className="ml-page__header lw-head">
        <div>
          <h1 className="ml-page__title">
            <BidiText as="span" text={plan.title} />
          </h1>
          <p className="ml-page__lede">
            {`الامتحان ${dayLabelAr(plan.config.exam_date, { year: true })}`}
            {plan.days_left !== null && plan.days_left >= 0 && ` — ${plan.days_left === 0 ? 'اليوم' : `بعد ${daysCountAr(plan.days_left)}`}`}
            {` · ${minutesAr(plan.config.daily_minutes)} يوميًا`}
          </p>
        </div>
        <div className="ml-cluster">
          <Link to="/planner" className={buttonClass({ variant: 'plain' })}>
            <ArrowRight size={16} aria-hidden="true" />
            الخطط
          </Link>
          {!archived && (
            <>
              <Link to={`/planner/${encodeURIComponent(plan.id)}/edit`} className={buttonClass({ variant: 'secondary', size: 'sm' })}>
                <Pencil size={16} aria-hidden="true" />
                عدّل المدخلات
              </Link>
              <Button size="sm" variant="plain" icon={<Archive size={16} />} disabled={!caps.online} onClick={() => setConfirmArchive(true)}>
                أرشف
              </Button>
            </>
          )}
        </div>
      </header>

      {fromCache && <p className="lw-note">معروضة من آخر نسخة محفوظة على هذا الجهاز؛ تحديد المهام يحتاج اتصالًا.</p>}
      {archived && <p className="lw-note">خطة مؤرشفة — للعرض فقط، بما أنجزته فيها.</p>}

      <div className="lw-editor lw-editor--plan">
        <div className="lw-stack">
          {!archived && plan.behind > 0 && (
            <section className="lw-sheet lw-behind" aria-labelledby="pl-behind">
              <h2 id="pl-behind" className="lw-sheet__title">
                <CircleAlert size={18} aria-hidden="true" /> {`تأخرت ${plan.behind} مهمة من أيام سابقة`}
              </h2>
              <p className="lw-muted">إعادة الموازنة توزّع ما لم يُنجز على الأيام القادمة دون تجاوز وقتك اليومي، وتقول بوضوح ما لم يعد يتسع.</p>
              <Button variant="primary" icon={<Scale size={16} />} loading={busy} disabled={!caps.online} onClick={() => void rebalance()}>
                أعد موازنة الخطة
              </Button>
            </section>
          )}

          {diff && (
            <section className="lw-sheet" aria-labelledby="pl-diff" role="status">
              <h2 id="pl-diff" className="lw-sheet__title">
                ما تغيّر بإعادة الموازنة
              </h2>
              <p className={diff.report.feasible ? 'lw-feasible' : 'lw-feasible lw-feasible--no'}>
                {diff.report.feasible ? <CircleCheck size={18} aria-hidden="true" /> : <CircleAlert size={18} aria-hidden="true" />}
                <span>{diff.report.summary_ar}</span>
              </p>
              {diff.moved.length > 0 ? (
                <ul className="lw-items" aria-label="المهام المنقولة">
                  {diff.moved.map((m, i) => (
                    <li key={i}>{`${movedLineAr(m, plan.today)} (${minutesAr(m.minutes)})`}</li>
                  ))}
                </ul>
              ) : (
                <p className="lw-muted">لم تُنقل أي مهمة.</p>
              )}
              {diff.report.dropped_ar.length > 0 && (
                <>
                  <h3 className="lw-sheet__subtitle">لم يعد يتسع</h3>
                  <ul className="lw-warnings">
                    {diff.report.dropped_ar.map((d) => (
                      <li key={d}>
                        <CircleAlert size={16} aria-hidden="true" />
                        <span>{d}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <p className="lw-muted">المهام المنقولة تبقى في أيامها الأصلية بحالة «نُقلت» للتاريخ.</p>
            </section>
          )}

          <section className="lw-sheet" aria-labelledby="pl-days">
            <h2 id="pl-days" className="lw-sheet__title">
              الأيام
            </h2>
            <DayList tasks={plan.tasks} today={plan.today} timezone={plan.timezone} dailyMinutes={plan.config.daily_minutes} readOnly={readOnly} onSet={(t, s) => void setTask(t, s)} back={`/planner/${encodeURIComponent(plan.id)}`} />
          </section>
        </div>

        <aside className="lw-editor__preview" aria-label="هل الخطة ممكنة؟">
          <h2 className="lw-sheet__subtitle">هل تتسع الأيام؟</h2>
          <p className={f.feasible ? 'lw-feasible' : 'lw-feasible lw-feasible--no'}>
            {f.feasible ? <CircleCheck size={18} aria-hidden="true" /> : <CircleAlert size={18} aria-hidden="true" />}
            <span>{f.summary_ar}</span>
          </p>
          {f.unfit_ar.length > 0 && (
            <ul className="lw-warnings">
              {f.unfit_ar.map((u) => (
                <li key={u}>
                  <CircleAlert size={16} aria-hidden="true" />
                  <span>{u}</span>
                </li>
              ))}
            </ul>
          )}
          <ul className="lw-basis" aria-label="أساس التقدير">
            {f.estimates_ar.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
          {plan.last_report && plan.last_rebalanced_at && !diff && (
            <p className="lw-muted">{`آخر إعادة موازنة ${formatDateTime(plan.last_rebalanced_at)}: ${plan.last_report.summary_ar}`}</p>
          )}
          <p className="lw-muted">
            بتوقيت <bdi dir="ltr">{plan.timezone}</bdi> — الأيام لا تتغير بتغيير منطقة الجهاز.
          </p>
          {plan.behind === 0 && !archived && <StatusPill tone="success">في موعدها</StatusPill>}
        </aside>
      </div>

      <ConfirmDialog
        open={confirmArchive}
        title="أرشفة الخطة؟"
        impact={<p>تتوقف الخطة عن الظهور في الرئيسية. تبقى للعرض بكل ما أنجزته فيها، ولا يُحذف شيء.</p>}
        confirmLabel="أرشف الخطة"
        onCancel={() => setConfirmArchive(false)}
        onConfirm={async () => {
          try {
            keep(await learningApi.archivePlan(plan.id));
            toast.show({ title: 'أُرشفت الخطة.', tone: 'success' });
          } catch (e) {
            toast.show({ title: errorMessage(e, 'تعذّرت الأرشفة.'), tone: 'danger' });
          }
          setConfirmArchive(false);
        }}
      />
    </div>
  );
}
