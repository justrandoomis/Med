// /planner — Study Planner (§45): the owner's plans (active first), each with its exam date, days left and whether it
// is behind. A plan is opened for its day list / calendar, check-off and rebalancing.
import { Link } from 'react-router-dom';
import { CalendarDays, Plus } from 'lucide-react';
import type { PlanListResponse } from '@medlevo/shared';
import { EmptyState, ErrorState, LoadingState, StatusPill, buttonClass } from '../../design';
import { usePageTitle } from '../../lib/usePageTitle';
import { BidiText } from '../evidence';
import { useQuery } from '../library/data';
import { LEARNING_PATHS } from '../review/api';
import { planUrl } from '../review/links';
import { dayLabelAr, daysCountAr } from '../review/local/time';
import '../review/learning.css';
import './planner.css';

export function PlannerScreen() {
  usePageTitle('مخطط الدراسة');
  const q = useQuery<PlanListResponse>(LEARNING_PATHS.plans, { cache: true });
  const items = [...(q.data?.items ?? [])].sort((a, b) => (a.status === b.status ? (a.exam_date < b.exam_date ? -1 : 1) : a.status === 'active' ? -1 : 1));
  return (
    <div className="ml-page lw-page">
      <header className="ml-page__header lw-head">
        <div>
          <h1 className="ml-page__title">مخطط الدراسة</h1>
          <p className="ml-page__lede">خطة واقعية حتى موعد الامتحان: تعلّم ومراجعة وأسئلة وبطاقات، لا يتجاوز أي يوم وقتك المتاح.</p>
        </div>
        <Link to="/planner/new" className={buttonClass({ variant: 'primary' })}>
          <Plus size={16} aria-hidden="true" />
          خطة جديدة
        </Link>
      </header>
      {q.fromCache && <p className="lw-note">معروضة من آخر نسخة محفوظة على هذا الجهاز (دون اتصال).</p>}
      {q.error && !q.data && <ErrorState message={q.error.message} onRetry={() => void q.refresh()} />}
      {!q.data && !q.error && <LoadingState stage="جارٍ تحميل خططك…" />}
      {q.data && items.length === 0 && (
        <EmptyState
          icon={<CalendarDays size={28} />}
          title="لا توجد خطة بعد"
          description="حدّد موعد الامتحان والمحاضرات والأيام المتاحة ووقتك اليومي، فتُبنى خطة يومية تُعاد موازنتها إن تأخرت — مع إظهار ما تغيّر."
          actions={
            <Link to="/planner/new" className={buttonClass({ variant: 'primary' })}>
              أنشئ خطة
            </Link>
          }
        />
      )}
      {items.length > 0 && (
        <ul className="ml-list">
          {items.map((p) => (
            <li key={p.id} className="ml-list__row">
              <Link to={planUrl(p.id)} className="lw-planrow">
                <span className="lw-planrow__title">
                  <BidiText as="span" text={p.title} />
                </span>
                <span className="lw-planrow__meta">
                  <span>{`الامتحان ${dayLabelAr(p.exam_date, { year: true })}`}</span>
                  {p.status === 'active' && p.days_left !== null && p.days_left >= 0 && <span>{p.days_left === 0 ? 'اليوم' : `بعد ${daysCountAr(p.days_left)}`}</span>}
                  {p.status === 'archived' ? <StatusPill tone="neutral">مؤرشفة</StatusPill> : p.behind > 0 ? <StatusPill tone="warning">{`متأخرة: ${p.behind} مهمة من أيام سابقة`}</StatusPill> : <StatusPill tone="success">في موعدها</StatusPill>}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
