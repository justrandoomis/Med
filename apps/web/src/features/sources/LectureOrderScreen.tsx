// «رتّب المحاضرات» (PRD AOS-3.5): the folder's lectures «حسب الرقم» or «حسب التاريخ» (natural-title fallback, stable
// ties). Looking changes nothing; «اعتمد هذا الترتيب» writes it as the folder's own manual order, which later uploads
// and detections never change.
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { LECTURE_ORDER_MODE_LABELS_AR, LECTURE_ORDER_MODES, type LectureOrderMode, type LectureOrderResponse } from '@medlevo/shared';
import { Breadcrumbs, Button, EmptyState, ErrorState, LoadingState, SegmentedControl, useToast } from '../../design';
import { api, errorMessage } from '../../lib/api';
import { usePageTitle } from '../../lib/usePageTitle';
import { invalidate, useQuery } from '../library/data';
import '../library/library.css';
import './sources.css';

export function LectureOrderScreen() {
  const { nodeId = '' } = useParams();
  const [mode, setMode] = useState<LectureOrderMode>('number');
  const q = useQuery<LectureOrderResponse>(`/versions/order?node_id=${encodeURIComponent(nodeId)}&mode=${mode}`);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  usePageTitle('ترتيب المحاضرات');

  const apply = async () => {
    setBusy(true);
    try {
      await api.post('/versions/order/apply', { node_id: nodeId, mode });
      toast.show({ title: `اعتُمد الترتيب ${LECTURE_ORDER_MODE_LABELS_AR[mode]} كترتيب يدوي للمجلد.`, tone: 'success' });
      invalidate('/library');
      await q.refresh();
    } catch (e) {
      toast.show({ title: errorMessage(e), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ml-page ml-page--narrow ml-library">
      <Breadcrumbs items={[{ label: 'المكتبة', to: '/library' }, { label: 'المجلد', to: `/library/${encodeURIComponent(nodeId)}` }, { label: 'ترتيب المحاضرات' }]} />
      <header className="ml-page__header">
        <h1 className="ml-page__title">ترتيب المحاضرات</h1>
        <p className="ml-page__lede">يُعرض الترتيب هنا فقط؛ لا يتغير ترتيب المجلد إلا إن اعتمدته. المحاضرات بلا رقم أو تاريخ تأتي في الآخر بترتيب أسمائها.</p>
      </header>
      <SegmentedControl<LectureOrderMode>
        label="طريقة الترتيب"
        showLabel
        options={LECTURE_ORDER_MODES.map((m) => ({ value: m, label: LECTURE_ORDER_MODE_LABELS_AR[m] }))}
        value={mode}
        onValueChange={setMode}
      />
      {q.loading && !q.data && <LoadingState stage="جارٍ الترتيب…" />}
      {q.error && !q.data && <ErrorState message={q.error.message} onRetry={() => void q.refresh()} />}
      {q.data && q.data.items.length === 0 && <EmptyState title="لا مصادر في هذا المجلد" description="ارفع محاضرات إلى المجلد ثم عد إلى هنا." />}
      {q.data && q.data.items.length > 0 && (
        <div className="ml-stack">
          {q.data.missing_key > 0 && (
            <p className="ml-field__hint" role="status">
              {mode === 'number' ? `${q.data.missing_key} بلا رقم محاضرة` : `${q.data.missing_key} بلا تاريخ`} — يمكنك تحديده من تبويب «المحاضرة» في كل مصدر.
            </p>
          )}
          <ol className="ml-list ml-order" role="list">
            {q.data.items.map((it) => (
              <li key={it.source_id} className="ml-order__row">
                <span className="ml-order__pos" aria-hidden="true">
                  {it.position}
                </span>
                <span className="ml-row__text">
                  <Link to={`/sources/${encodeURIComponent(it.source_id)}`} className="ml-row__title">
                    <bdi>{it.title}</bdi>
                  </Link>
                  <span className="ml-row__sub">
                    {it.lecture_no !== null ? `المحاضرة ${it.lecture_no}` : 'بلا رقم'}
                    {' · '}
                    {it.held_on ? <bdi dir="ltr">{it.held_on}</bdi> : 'بلا تاريخ'}
                  </span>
                </span>
              </li>
            ))}
          </ol>
          <div>
            <Button variant="primary" onClick={() => void apply()} loading={busy} loadingLabel="جارٍ الحفظ…">
              اعتمد هذا الترتيب للمجلد
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
