// Content Change Alerts (§18, AC-26): what changed in a source, what is still valid, what needs
// regeneration or review — frozen items are listed with a warning (kept on their version, never changed
// silently). Layout-only changes are told apart from fact / answer changes. The owner acknowledges or
// closes an alert explicitly.
import { useCallback, useEffect, useState } from 'react';
import { BellRing, CircleCheck, Lock } from 'lucide-react';
import { DEPENDENT_TYPE_LABELS_AR, type AlertImpact, type ContentAlertView } from '@medlevo/shared';
import { Button, EmptyState, ErrorState, LoadingState, StatusPill, type StatusTone } from '../../design';
import { errorMessage, isApiError } from '../../lib/api';
import { formatDateTime } from '../../lib/time';
import { BidiText } from './BidiText';
import { acknowledgeAlert, fetchAlerts, resolveAlert } from './api';

const SEVERITY_TONE: Record<ContentAlertView['severity'], StatusTone> = { info: 'info', fact_change: 'warning', answer_change: 'danger' };
const IMPACT_TONE: Record<AlertImpact, StatusTone> = { still_valid: 'success', needs_regeneration: 'warning', needs_review: 'warning' };
const STATUS_AR: Record<ContentAlertView['status'], string> = { open: 'جديد', acknowledged: 'اطّلعت عليه', resolved: 'مغلق' };

function pagesList(pages: number[]): string {
  return pages.map((p) => p + 1).join('، ');
}

export function AlertCard({ alert, onChanged }: { alert: ContentAlertView; onChanged: (a: ContentAlertView) => void }) {
  const [busy, setBusy] = useState<'ack' | 'resolve' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const act = async (kind: 'ack' | 'resolve') => {
    setBusy(kind);
    setError(null);
    try {
      const r = kind === 'ack' ? await acknowledgeAlert(alert.id) : await resolveAlert(alert.id);
      onChanged(r.alert);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const c = alert.change;
  return (
    <li className="ev-alert" data-status={alert.status} data-kind={alert.kind}>
      <div className="ev-alert__head">
        <StatusPill tone={SEVERITY_TONE[alert.severity]}>{alert.severity_label_ar}</StatusPill>
        <span className="ev-alert__kind">{alert.kind_label_ar}</span>
        <span className="ev-alert__time">{formatDateTime(alert.created_at)}</span>
        {alert.status !== 'open' && <span className="ev-alert__state">{STATUS_AR[alert.status]}</span>}
      </div>
      {alert.source_title && <BidiText as="p" dir="rtl" className="ev-alert__source" text={alert.source_title} />}
      <BidiText as="p" dir="rtl" className="ev-alert__summary" text={alert.summary} />
      {c && c.state === 'compared' && !c.text_identical && (c.pages_changed.length > 0 || c.critical_added.length + c.critical_removed.length > 0) && (
        <dl className="ev-facts ev-alert__change">
          {c.pages_changed.length > 0 && (
            <div className="ev-facts__row">
              <dt>صفحات تغيّر نصها (ترتيب الملف)</dt>
              <dd>{pagesList(c.pages_changed)}</dd>
            </div>
          )}
          {c.critical_removed.length > 0 && (
            <div className="ev-facts__row">
              <dt>قيم لم تعد موجودة</dt>
              <dd>
                <bdi dir="ltr" lang="en">
                  {c.critical_removed.join(' ، ')}
                </bdi>
              </dd>
            </div>
          )}
          {c.critical_added.length > 0 && (
            <div className="ev-facts__row">
              <dt>قيم جديدة</dt>
              <dd>
                <bdi dir="ltr" lang="en">
                  {c.critical_added.join(' ، ')}
                </bdi>
              </dd>
            </div>
          )}
        </dl>
      )}
      {alert.items.length > 0 && (
        <details className="ev-alert__items">
          <summary>{`العناصر المتأثرة (${alert.items.length}): ما زال صالحًا ${alert.counts.still_valid}، يحتاج إعادة توليد ${alert.counts.needs_regeneration}، يحتاج مراجعة ${alert.counts.needs_review}`}</summary>
          <ul>
            {alert.items.map((i) => (
              <li key={`${i.type}:${i.id}`} className="ev-alert__item">
                <span className="ev-alert__item-type">{DEPENDENT_TYPE_LABELS_AR[i.type] ?? i.type}</span>
                {i.title && <BidiText as="span" dir="rtl" className="ev-alert__item-title" text={i.title} />}
                <StatusPill tone={IMPACT_TONE[i.impact]} icon={i.impact === 'still_valid' ? <CircleCheck size={14} /> : undefined}>
                  {i.impact_label_ar}
                </StatusPill>
                {i.frozen && (
                  <StatusPill tone="neutral" icon={<Lock size={14} />}>
                    مثبّت — لم يُغيَّر
                  </StatusPill>
                )}
                {i.reason_ar && <span className="ev-alert__item-reason">{i.reason_ar}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
      {error && (
        <p className="ev-note ev-note--danger" role="alert">
          {error}
        </p>
      )}
      {alert.status !== 'resolved' && (
        <div className="ev-alert__actions">
          {alert.status === 'open' && (
            <Button size="sm" variant="secondary" onClick={() => act('ack')} loading={busy === 'ack'}>
              اطّلعت عليه
            </Button>
          )}
          <Button size="sm" variant="plain" onClick={() => act('resolve')} loading={busy === 'resolve'}>
            تمت المعالجة
          </Button>
        </div>
      )}
    </li>
  );
}

export interface ContentAlertsPanelProps {
  /** only alerts of one source */
  sourceId?: string;
  /** 'active' (default) = open + acknowledged */
  status?: 'active' | 'all';
  className?: string;
}

export function ContentAlertsPanel({ sourceId, status = 'active', className }: ContentAlertsPanelProps) {
  const [alerts, setAlerts] = useState<ContentAlertView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try {
      setAlerts((await fetchAlerts(status, sourceId)).alerts);
    } catch (e) {
      setError(isApiError(e) && e.offline ? 'تنبيهات تغيّر المحتوى تحتاج الاتصال بالخادم.' : errorMessage(e));
    }
  }, [status, sourceId]);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className={['ev-alerts', className].filter(Boolean).join(' ')} aria-labelledby="ev-alerts-title">
      <h2 id="ev-alerts-title" className="ev-alerts__title">
        تنبيهات تغيّر المحتوى
      </h2>
      {error ? (
        <ErrorState inline message={error} onRetry={load} />
      ) : !alerts ? (
        <LoadingState inline stage="جارٍ تحميل التنبيهات…" />
      ) : alerts.length === 0 ? (
        <EmptyState icon={<BellRing size={24} />} title="لا توجد تنبيهات" description="عند تحديث مصدر أو تصحيح نصه ستظهر هنا العناصر المتأثرة وما يحتاج مراجعة." headingLevel={3} />
      ) : (
        <ul className="ev-alerts__list">
          {alerts.map((a) => (
            <AlertCard
              key={a.id}
              alert={a}
              onChanged={(next) => setAlerts((list) => (list ?? []).map((x) => (x.id === next.id ? next : x)).filter((x) => status === 'all' || x.status !== 'resolved'))}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
