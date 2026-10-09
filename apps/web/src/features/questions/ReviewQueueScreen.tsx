// قائمة مراجعة الأسئلة (§48): truncated questions, missing options, conflicting / unbound keys, unofficial marks,
// failed checks, uncertain lecture links and duplicate suggestions — each with its specific reason and a way to
// open the original next to the structured version.
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ClipboardCheck, ScanSearch } from 'lucide-react';
import type { ReviewQueueResponse } from '@medlevo/shared';
import { Breadcrumbs, Button, buttonClass, EmptyState, ErrorState, LoadingState, SegmentedControl, StatusPill } from '../../design';
import { errorMessage } from '../../lib/api';
import { formatRelative } from '../../lib/time';
import { usePageTitle } from '../../lib/usePageTitle';
import { questionsApi } from './api';
import { MixedText } from './labels';
import './questions.css';

type StatusFilter = 'open' | 'resolved' | 'all';

const STATUS_AR: Record<string, string> = { open: 'مفتوح', accepted: 'قُبل', corrected: 'صُحح', rejected: 'رُفض', dismissed: 'تُجوهل' };

export function ReviewQueueScreen() {
  usePageTitle('قائمة مراجعة الأسئلة');
  const [status, setStatus] = useState<StatusFilter>('open');
  const [data, setData] = useState<ReviewQueueResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await questionsApi.reviewQueue({ status }));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  const dismiss = async (id: string) => {
    setBusy(id);
    try {
      await questionsApi.resolveItem(id, 'dismissed');
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="ml-page qv-page">
      <Breadcrumbs items={[{ label: 'خزنة أسئلتي', to: '/questions' }, { label: 'قائمة المراجعة' }]} />
      <header className="ml-page__header qv-head">
        <div>
          <h1 className="ml-page__title">قائمة مراجعة الأسئلة</h1>
          <p className="ml-page__lede">ما يحتاج نظرتك قبل أن يُعتمد: لكل عنصر سببه المحدد، ويمكنك فتح الأصل بجانب النسخة المنظمة.</p>
        </div>
        <SegmentedControl<StatusFilter>
          label="حالة العناصر"
          value={status}
          onValueChange={setStatus}
          options={[
            { value: 'open', label: data && status === 'open' ? `مفتوحة (${data.total_open})` : 'مفتوحة' },
            { value: 'resolved', label: 'عولجت' },
            { value: 'all', label: 'الكل' },
          ]}
        />
      </header>
      {!data && !error ? (
        <LoadingState stage="جارٍ تحميل قائمة المراجعة…" />
      ) : error && !data ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : data && data.items.length === 0 ? (
        <EmptyState
          icon={<ClipboardCheck size={28} />}
          title={status === 'open' ? 'لا شيء ينتظر مراجعتك' : 'لا توجد عناصر'}
          description={status === 'open' ? 'كل الأسئلة المستخرجة اجتازت فحوصها أو راجعتها بنفسك.' : undefined}
          actions={
            <Link to="/questions" className={buttonClass({ variant: 'secondary' })}>
              العودة إلى الخزنة
            </Link>
          }
        />
      ) : (
        <ul className="qv-cards" role="list">
          {data!.items.map((it) => (
            <li key={it.id} className={it.status === 'open' ? 'qv-card' : 'qv-card qv-card--muted'}>
              <div className="ml-cluster">
                <StatusPill tone={it.status === 'open' ? 'warning' : 'neutral'}>{it.kind_label_ar}</StatusPill>
                <span className="qv-muted">
                  {STATUS_AR[it.status] ?? it.status} · {formatRelative(it.created_at)}
                </span>
              </div>
              <p className="qv-reason">
                <MixedText text={it.reason} />
              </p>
              {it.question_stem_preview && (
                <p className="qv-card__stem">
                  <MixedText text={it.question_stem_preview} />
                </p>
              )}
              {it.origin_label_ar && (
                <p className="qv-muted">
                  <MixedText text={it.origin_label_ar} />
                </p>
              )}
              <div className="ml-cluster">
                {it.question_id && (
                  <Link to={`/questions/${it.question_id}/review`} className={buttonClass({ variant: 'secondary', size: 'sm' })}>
                    <ScanSearch size={14} aria-hidden="true" />
                    راجع مع الأصل
                  </Link>
                )}
                {it.question_id && (
                  <Link to={`/questions/${it.question_id}`} className={buttonClass({ variant: 'plain', size: 'sm' })}>
                    تفاصيل السؤال
                  </Link>
                )}
                {!it.question_id && it.source_id && (
                  <Link to={`/sources/${it.source_id}`} className={buttonClass({ variant: 'secondary', size: 'sm' })}>
                    افتح المصدر
                  </Link>
                )}
                {it.status === 'open' && (
                  <Button size="sm" variant="plain" loading={busy === it.id} onClick={() => void dismiss(it.id)}>
                    تجاهل
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {error && data && <ErrorState inline message={error} />}
    </div>
  );
}
