// «اقتراحات الاستيراد» — the uploader's review queue across files (PRD AOS-3.18): every suggestion waiting for a
// decision, with its reasons and the stated effect. Nothing here was applied; a decision is remembered.
import { Link } from 'react-router-dom';
import type { ImportSuggestionListResponse } from '@medlevo/shared';
import { buttonClass, EmptyState, ErrorState, LoadingState } from '../../design';
import { usePageTitle } from '../../lib/usePageTitle';
import { useQuery } from '../library/data';
import { SuggestionCard } from '../sources/SuggestionCard';
import '../library/library.css';
import '../sources/sources.css';
import './upload.css';

export function ImportSuggestionsScreen() {
  usePageTitle('اقتراحات الاستيراد');
  const q = useQuery<ImportSuggestionListResponse>('/versions/suggestions?status=open');
  return (
    <div className="ml-page ml-page--narrow ml-upload">
      <header className="ml-page__header">
        <h1 className="ml-page__title">اقتراحات الاستيراد</h1>
        <p className="ml-page__lede">ما قرأه التطبيق من أسماء ملفاتك وصفحاتها الأولى: رقم المحاضرة وتاريخها واسمها ومادتها، والملفات التي تبدو إصدارًا جديدًا من محاضرة موجودة. لا يتغير شيء قبل أن تؤكده.</p>
      </header>
      {q.loading && !q.data && <LoadingState stage="جارٍ تحميل الاقتراحات…" />}
      {q.error && !q.data && <ErrorState message={q.error.message} onRetry={() => void q.refresh()} />}
      {q.data && q.data.suggestions.length === 0 && (
        <EmptyState
          title="لا اقتراحات بانتظارك"
          description="تظهر هنا اقتراحات الملفات التي ترفعها بعد معالجتها."
          actions={
            <Link to="/upload" className={buttonClass({ variant: 'primary' })}>
              رفع مصادر
            </Link>
          }
        />
      )}
      {q.data && q.data.suggestions.length > 0 && (
        <ul className="ml-list" role="list">
          {q.data.suggestions.map((s) => (
            <SuggestionCard key={s.id} suggestion={s} showSource onDecided={() => void q.refresh()} />
          ))}
        </ul>
      )}
    </div>
  );
}
