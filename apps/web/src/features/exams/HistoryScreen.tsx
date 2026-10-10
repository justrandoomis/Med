// Attempt history (§39): every practice / exam attempt, newest first, with its real status and — only once the
// solutions may be shown — its score as «n من m محسوبة». Unfinished attempts resume where they stopped.
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { GraduationCap, Play, Sparkles } from 'lucide-react';
import { EXAM_ATTEMPT_STATUS_LABELS_AR, EXAM_MODE_LABELS_AR, type ExamAttemptListItem } from '@medlevo/shared';
import { Button, EmptyState, ErrorState, LoadingState, StatusPill, buttonClass } from '../../design';
import { errorMessage } from '../../lib/api';
import { useCapabilities } from '../../lib/capabilities';
import { formatDateTime } from '../../lib/time';
import { usePageTitle } from '../../lib/usePageTitle';
import { examsApi } from './api';
import { MixedLine } from './MixedLine';
import { ofAr } from './model';
import './exams.css';

export function HistoryScreen() {
  usePageTitle('التدريب والامتحانات');
  const caps = useCapabilities();
  const [items, setItems] = useState<ExamAttemptListItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (c: string | null) => {
    setLoading(true);
    setError(null);
    try {
      const res = await examsApi.history(c);
      setItems((prev) => (c ? [...(prev ?? []), ...res.items] : res.items));
      setCursor(res.next_cursor);
    } catch (e) {
      setError(errorMessage(e, 'تعذّر تحميل سجل الاختبارات.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(null);
  }, [load]);

  const gen = caps.feature('ai.generate_questions');
  return (
    <div className="ml-page ex-page">
      <header className="ml-page__header ex-head">
        <div>
          <h1 className="ml-page__title">التدريب والامتحانات</h1>
          <p className="ml-page__lede">تدرّب على أسئلة مصادرك أو امتحن نفسك. الأسئلة غير المحسومة لا تدخل أي نتيجة.</p>
        </div>
        <div className="ml-cluster">
          <Link to="/exams/new" className={buttonClass({ variant: 'primary' })}>
            <GraduationCap size={18} aria-hidden="true" />
            اختبار جديد
          </Link>
          {gen.available && (
            <Link to="/exams/generate" className={buttonClass({ variant: 'secondary' })}>
              <Sparkles size={16} aria-hidden="true" />
              توليد أسئلة صعبة
            </Link>
          )}
          <Link to="/exams/simulate" className={buttonClass({ variant: 'plain' })}>
            محاكاة مولدة
          </Link>
        </div>
      </header>
      {!gen.available && gen.reason && <p className="ex-muted">توليد الأسئلة الصعبة: {gen.reason}</p>}

      {error && <ErrorState message={error} onRetry={() => void load(null)} />}
      {!error && items === null && loading && <LoadingState stage="جارٍ تحميل السجل…" />}
      {items && items.length === 0 && (
        <EmptyState
          title="لم تبدأ أي اختبار بعد"
          description="أنشئ اختبارًا من محاضراتك أو مصادر أسئلتك، أو اضغط «تدرّب» على سؤال في المحاضرة."
          actions={
            <Link to="/exams/new" className={buttonClass({ variant: 'primary' })}>
              اختبار جديد
            </Link>
          }
        />
      )}
      {items && items.length > 0 && (
        <ul className="ex-history">
          {items.map((a) => {
            const done = a.status === 'completed' || a.status === 'abandoned';
            return (
              <li key={a.attempt_id} className="ex-history__item">
                <div className="ex-history__main">
                  <Link to={done ? `/exams/${encodeURIComponent(a.attempt_id)}/results` : `/exams/${encodeURIComponent(a.attempt_id)}`} className="ex-history__title">
                    <MixedLine text={a.title} />
                  </Link>
                  <p className="ex-muted">
                    {EXAM_MODE_LABELS_AR[a.mode]} — {formatDateTime(a.started_at)} — أُجيب {ofAr(a.answered, a.item_count)}
                  </p>
                </div>
                <div className="ml-cluster">
                  <StatusPill tone={done ? 'success' : a.status === 'paused' ? 'warning' : 'info'} icon={false}>
                    {EXAM_ATTEMPT_STATUS_LABELS_AR[a.status]}
                  </StatusPill>
                  {a.correct !== null && a.scored_items > 0 && <span className="ex-history__score">{ofAr(a.correct, a.scored_items)} محسوبة</span>}
                  {!done && (
                    <Link to={`/exams/${encodeURIComponent(a.attempt_id)}`} className={buttonClass({ variant: 'secondary', size: 'sm' })}>
                      <Play size={14} aria-hidden="true" />
                      أكمل
                    </Link>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {cursor && (
        <Button variant="secondary" loading={loading} onClick={() => void load(cursor)}>
          المزيد
        </Button>
      )}
    </div>
  );
}
