// /review/session?source_id=&cards=id,id — the focused flashcard session (full-bleed, calm, one card at a time).
// Works offline: everything it needs is on this device (cards, review log, FSRS parameters). The bar says how many
// cards are left right now (real counts) and the save state of the ratings.
import { useCallback, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { buttonClass } from '../../design';
import { GlobalSaveStatus, OfflineIndicator } from '../../app/SyncIndicators';
import { usePageTitle } from '../../lib/usePageTitle';
import { CardReviewer } from './components/CardReviewer';
import { cardsAr } from './local/time';
import { safeBack as inAppBack } from './links';
import './learning.css';

export function ReviewSession() {
  usePageTitle('جلسة مراجعة البطاقات');
  const [params] = useSearchParams();
  const sourceId = params.get('source_id');
  const cards = params.get('cards')?.split(',').filter(Boolean) ?? null;
  const [progress, setProgress] = useState({ remaining: 0, reviewed: 0 });
  const onProgress = useCallback((p: { remaining: number; reviewed: number }) => setProgress(p), []);
  // in-app paths only (no `//host` or `/\host`, which browsers treat as another site)
  const safeBack = inAppBack(params.get('back'), '/review');

  return (
    <div className="lw-session">
      <header className="lw-session__bar">
        <Link to={safeBack} className={buttonClass({ variant: 'plain', size: 'sm' })}>
          <ArrowRight size={18} aria-hidden="true" />
          إنهاء الجلسة
        </Link>
        <p className="lw-session__progress" aria-live="polite">
          {progress.remaining > 0 ? `متبقٍّ الآن: ${cardsAr(progress.remaining)}` : 'لا بطاقات متبقية الآن'}
          {progress.reviewed > 0 && ` · راجعت ${cardsAr(progress.reviewed)}`}
        </p>
        <div className="lw-session__status">
          <OfflineIndicator />
          <GlobalSaveStatus />
        </div>
      </header>
      <main id="main" className="lw-session__main">
        <h1 className="ml-visually-hidden">جلسة مراجعة البطاقات</h1>
        <CardReviewer
          sourceId={sourceId}
          cardIds={cards}
          onProgress={onProgress}
          doneActions={
            <>
              <Link to={safeBack} className={buttonClass({ variant: 'primary' })}>
                العودة
              </Link>
              <Link to="/review/cards" className={buttonClass({ variant: 'secondary' })}>
                مكتبة البطاقات
              </Link>
            </>
          }
        />
      </main>
    </div>
  );
}
