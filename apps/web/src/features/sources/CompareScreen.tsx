// «قارن الإصدارات» (PRD AOS-3.12, Scenario 4): the old ↔ new page map side by side — page images, the change of each
// page (inserted / removed / changed / moved), a word difference for rewritten pages, and for an open «إصدار جديد من …»
// proposal the confirmation itself. Uncertain pairs are never decided by the app: the owner marks them «نفس الصفحة» or
// «ليست نفس الصفحة»; the decision is kept when the map is recomputed.
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Check, X } from 'lucide-react';
import type { CompareRow, ComparePageRef, DecideSuggestionResponse, VersionCompareResponse } from '@medlevo/shared';
import { Breadcrumbs, Button, EmptyState, ErrorState, LoadingState, StatusPill, useToast } from '../../design';
import { api, errorMessage } from '../../lib/api';
import { usePageTitle } from '../../lib/usePageTitle';
import { invalidate, useQuery } from '../library/data';
import { SuggestionCard } from './SuggestionCard';
import { CHANGE_TONE, changeLabel, countsSummary, needsReview, studyHref, thumbnailUrl } from './versionsModel';
import '../library/library.css';
import './sources.css';
// the action rows (`.ml-upload__row-actions`) and the suggestion card (R1-a critic pass, test/route-chunk-css.critic.test.ts)
import '../upload/upload.css';

export function CompareScreen() {
  const { sourceId = '' } = useParams();
  const [params] = useSearchParams();
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const valid = !!from && !!to && from !== to;
  const q = useQuery<VersionCompareResponse>(valid ? `/versions/compare?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}` : null);
  const navigate = useNavigate();
  usePageTitle('مقارنة نسختين');

  if (!valid) {
    return (
      <div className="ml-page">
        <h1 className="ml-visually-hidden">مقارنة نسختين</h1>
        <EmptyState title="اختر نسختين للمقارنة" description="افتح المصدر ثم «النسخ» واختر «قارن مع النسخة السابقة»." />
      </div>
    );
  }
  if (q.loading && !q.data) return <LoadingState stage="جارٍ مقارنة الصفحات…" />;
  if (q.error && !q.data) {
    return (
      <div className="ml-page">
        <ErrorState message={q.error.message} onRetry={() => void q.refresh()} />
      </div>
    );
  }
  const c = q.data!;
  const reviewCount = c.rows.filter(needsReview).length;
  // the breadcrumb names the source it links to (a «new version» proposal compares two different sources)
  const crumbTitle = sourceId === c.from.source_id ? c.from.source_title : c.to.source_title;
  return (
    <div className="ml-page ml-library ml-compare">
      <Breadcrumbs items={[{ label: 'المكتبة', to: '/library' }, { label: <bdi>{crumbTitle}</bdi>, to: `/sources/${encodeURIComponent(sourceId)}` }, { label: 'مقارنة نسختين' }]} />
      <header className="ml-page__header">
        <h1 className="ml-page__title">مقارنة نسختين</h1>
        <div className="ml-compare__heads" role="group" aria-label="النسختان">
          <VersionHead side="السابقة" title={c.from.source_title} versionNo={c.from.version_no} fileName={c.from.file_name} pages={c.from.page_count} />
          <VersionHead side="الجديدة" title={c.to.source_title} versionNo={c.to.version_no} fileName={c.to.file_name} pages={c.to.page_count} />
        </div>
      </header>

      {c.proposal && (
        <section className="ml-compare__proposal" aria-label="اقتراح إصدار جديد">
          <ul className="ml-list" role="list">
            <SuggestionCard
              suggestion={c.proposal}
              hideCompareLink
              onDecided={(r: DecideSuggestionResponse) => {
                if (r.new_version) navigate(`/sources/${encodeURIComponent(r.new_version.source_id)}`);
                else void q.refresh();
              }}
            />
          </ul>
        </section>
      )}

      {c.state !== 'ready' ? (
        <div className="ml-group">
          <div className="ml-group__row ml-group__row--stack">
            <StatusPill tone={c.state === 'failed' ? 'danger' : 'info'}>{c.state === 'failed' ? 'تعذّرت المقارنة' : 'يجري التحليل'}</StatusPill>
            <p className="ml-row__sub">{c.reason_ar}</p>
            <div>
              <Button size="sm" onClick={() => void q.refresh()}>
                تحديث
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <>
          <p className="ml-compare__summary" role="status">
            {countsSummary(c.counts)}
            {reviewCount > 0 && ` · تحتاج تأكيدك: ${reviewCount}`}
          </p>
          <p className="ml-trash-note">
            تُطابق الصفحات بنصها وبصورة الصفحة مع الحفاظ على ترتيبها؛ لا يُنقل أي شيء من ملاحظاتك من هذه الشاشة. الصفحة التي تغيّر نصها أو انتقلت من مكانها تُعلَّم «تحتاج تأكيدك» ولا يُقرَّر عنها تلقائيًا.
          </p>
          <ol className="ml-compare__rows" role="list" aria-label="الصفحات">
            {c.rows.map((r) => (
              <CompareRowView key={r.key} row={r} c={c} onChanged={() => void q.refresh()} />
            ))}
          </ol>
        </>
      )}
    </div>
  );
}

function VersionHead({ side, title, versionNo, fileName, pages }: { side: string; title: string; versionNo: number; fileName: string | null; pages: number | null }) {
  return (
    <div className="ml-compare__head">
      <span className="ml-field__label">النسخة {side}</span>
      <span className="ml-row__title">
        <bdi>{title}</bdi> · النسخة {versionNo}
      </span>
      <span className="ml-row__sub">
        {fileName && <bdi>{fileName}</bdi>}
        {pages !== null && ` · ${pages} صفحة`}
      </span>
    </div>
  );
}

function PageCell({ page, sourceId, versionId, side }: { page: ComparePageRef | null; sourceId: string; versionId: string; side: 'old' | 'new' }) {
  if (!page) return <div className="ml-compare__cell ml-compare__cell--empty">{side === 'old' ? 'لا مقابل في النسخة السابقة' : 'لا مقابل في النسخة الجديدة'}</div>;
  return (
    <div className="ml-compare__cell">
      {page.thumbnail ? (
        <img className="ml-compare__thumb" src={thumbnailUrl(page.page_id)} alt={`صورة ${page.label_ar} من النسخة ${side === 'old' ? 'السابقة' : 'الجديدة'}`} loading="lazy" decoding="async" />
      ) : (
        <div className="ml-compare__thumb ml-compare__thumb--text" aria-hidden="true" />
      )}
      <Link to={studyHref(sourceId, versionId, page.page_index)} className="ml-compare__label">
        {page.label_ar}
      </Link>
      {page.excerpt && (
        <p className="ml-compare__excerpt">
          <bdi>{page.excerpt}</bdi>
        </p>
      )}
    </div>
  );
}

function CompareRowView({ row, c, onChanged }: { row: CompareRow; c: VersionCompareResponse; onChanged: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<'confirm' | 'reject' | 'reset' | null>(null);
  const decide = async (action: 'confirm' | 'reject' | 'reset') => {
    if (!row.from) return;
    setBusy(action);
    try {
      await api.post('/versions/maps/decide', { from_version_id: c.from.version_id, to_version_id: c.to.version_id, from_page_id: row.from.page_id, action });
      toast.show({ title: action === 'confirm' ? 'حُفظ: هذه نفس الصفحة.' : action === 'reject' ? 'حُفظ: ليست نفس الصفحة.' : 'أُعيدت المطابقة التلقائية.', tone: 'success' });
      invalidate('/versions/compare');
      onChanged();
    } catch (e) {
      toast.show({ title: errorMessage(e), tone: 'danger' });
    } finally {
      setBusy(null);
    }
  };
  const review = needsReview(row);
  const decided = row.decided_by !== 'auto';
  return (
    <li className="ml-compare__row" data-change={row.change}>
      <div className="ml-compare__status">
        <StatusPill tone={CHANGE_TONE[row.change]}>{changeLabel(row.change)}</StatusPill>
        {review && <StatusPill tone="warning">تحتاج تأكيدك</StatusPill>}
        {decided && (
          <StatusPill tone={row.status === 'none' ? 'warning' : 'success'}>
            {row.status === 'confirmed' ? 'أكّدت أنها نفس الصفحة' : row.status === 'rejected' ? 'أكّدت أنها ليست نفسها' : 'قرارك يشير إلى صفحة لم تعد موجودة'}
          </StatusPill>
        )}
        {row.change === 'unchanged' && !row.layout_safe && row.status === 'safe' && <span className="ml-row__sub">النص نفسه بترتيب مختلف على الصفحة</span>}
      </div>
      <div className="ml-compare__pair">
        <PageCell page={row.from} sourceId={c.from.source_id} versionId={c.from.version_id} side="old" />
        <PageCell page={row.to} sourceId={c.to.source_id} versionId={c.to.version_id} side="new" />
      </div>
      {row.diff && (row.diff.removed.length > 0 || row.diff.added.length > 0) && (
        <div className="ml-compare__diff">
          {row.diff.removed.length > 0 && (
            <p>
              <span className="ml-compare__diff-label">حُذف من النص:</span> <bdi>{row.diff.removed.join(' ')}</bdi>
            </p>
          )}
          {row.diff.added.length > 0 && (
            <p>
              <span className="ml-compare__diff-label">أُضيف إلى النص:</span> <bdi>{row.diff.added.join(' ')}</bdi>
            </p>
          )}
        </div>
      )}
      {row.from && row.to && review && (
        <div className="ml-upload__row-actions">
          <Button size="sm" icon={<Check size={16} />} onClick={() => void decide('confirm')} loading={busy === 'confirm'} loadingLabel="جارٍ الحفظ…" disabled={!!busy}>
            نفس الصفحة
          </Button>
          <Button size="sm" variant="plain" icon={<X size={16} />} onClick={() => void decide('reject')} loading={busy === 'reject'} loadingLabel="جارٍ الحفظ…" disabled={!!busy}>
            ليست نفس الصفحة
          </Button>
        </div>
      )}
      {decided && row.from && (
        <div className="ml-upload__row-actions">
          <Button size="sm" variant="plain" onClick={() => void decide('reset')} loading={busy === 'reset'} loadingLabel="جارٍ الحفظ…" disabled={!!busy}>
            تراجع عن قراري
          </Button>
        </div>
      )}
    </li>
  );
}
