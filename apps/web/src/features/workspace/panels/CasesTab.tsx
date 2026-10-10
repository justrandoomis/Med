// «حالات» rail section (§30, track F3): the clinical cases / OSCE stations / viva of THIS lecture (its focal lecture or
// the lecture of its Source Lock) — origin in words (written by the owner vs generated), status with its reasons, the
// last attempt, and a way in. Creating a case stays in the cases screens (one implementation, nothing duplicated).
// In «امتحن نفسك» a case is opened to be attempted — its definition (and so its solution) is never shown here.
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Stethoscope } from 'lucide-react';
import type { CaseListResponse, CaseSummaryView } from '@medlevo/shared';
import { EmptyState, ErrorState, Skeleton, StatusPill, buttonClass } from '../../../design';
import { api, errorMessage } from '../../../lib/api';
import { useCapabilities } from '../../../lib/capabilities';
import type { SourceDocument } from '../data/useSourceDocument';

function statusTone(s: CaseSummaryView['status']): 'success' | 'warning' | 'neutral' {
  return s === 'ready' ? 'success' : s === 'needs_review' ? 'warning' : 'neutral';
}

export function CasesTab({ doc, online, examMode }: { doc: SourceDocument; online: boolean; examMode: boolean }) {
  const caps = useCapabilities();
  const sourceId = doc.detail.id;
  const [data, setData] = useState<CaseListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get<CaseListResponse>('/cases', { query: { source_id: sourceId } });
      if (!r || !Array.isArray(r.cases)) throw new Error('bad response');
      setData(r);
      setError(null);
    } catch (e) {
      setError(errorMessage(e, 'تعذّر تحميل حالات هذه المحاضرة.'));
    }
  }, [sourceId]);

  useEffect(() => {
    if (online) void load();
  }, [load, online]);

  const generation = caps.feature('ai.cases');
  return (
    <div className="wk-rail-section">
      <p className="wk-rail-lede">حالات سريرية ومحطات OSCE وأسئلة شفهية مرتبطة بهذه المحاضرة. كل حالة تحمل أصلها وحالتها.</p>
      {!online && !data && <p className="wk-muted">لا يوجد اتصال؛ تظهر حالات المحاضرة عند عودته.</p>}
      {error && <ErrorState inline message={error} onRetry={() => void load()} />}
      {online && !data && !error && <Skeleton lines={3} />}
      {data && data.cases.length === 0 && (
        <EmptyState
          icon={<Stethoscope size={28} />}
          title="لا توجد حالات لهذه المحاضرة بعد"
          description="أنشئ حالة بنفسك من مادة المحاضرة؛ لا تُعرض حالة لم تُربط بها."
          headingLevel={3}
        />
      )}
      {data && data.cases.length > 0 && (
        <ul className="wk-cases" role="list" aria-label={`حالات المحاضرة (${data.cases.length})`}>
          {data.cases.map((c) => (
            <li key={c.id} className="wk-case">
              <p className="wk-case__title">
                <bdi>{c.title}</bdi>
              </p>
              <div className="wk-case__meta">
                <span>{c.kind_label_ar}</span>
                <span aria-hidden="true">·</span>
                <span>{c.origin_label_ar}</span>
                <StatusPill tone={statusTone(c.status)}>{c.status_label_ar}</StatusPill>
              </div>
              {!examMode && c.status_reasons_ar.length > 0 && <p className="wk-muted">{c.status_reasons_ar[0]}</p>}
              {c.last_attempt && <p className="wk-muted">{c.last_attempt.status === 'completed' ? 'آخر محاولة: مكتملة' : 'آخر محاولة: لم تكتمل بعد'}</p>}
              <div className="wk-rail-actions">
                <Link to={`/cases/${encodeURIComponent(c.id)}`} className={buttonClass({ variant: 'secondary', size: 'sm' })}>
                  {examMode ? 'ابدأ الحالة' : 'افتح الحالة'}
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="wk-rail-actions">
        <Link to="/cases/new?kind=case" className={buttonClass({ variant: 'plain', size: 'sm' })}>
          <Plus size={16} aria-hidden="true" />
          حالة جديدة
        </Link>
        <Link to="/cases" className={buttonClass({ variant: 'plain', size: 'sm' })}>
          كل الحالات
        </Link>
      </div>
      {!generation.available && <p className="wk-muted">{`توليد حالة بالذكاء الاصطناعي: ${generation.reason ?? 'غير متاح.'}`}</p>}
    </div>
  );
}
