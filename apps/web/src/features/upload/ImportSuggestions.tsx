// After an upload is processed: the import suggestions of that file (lecture number, date, title, subject, «إصدار جديد
// من …»), held for the uploader's confirmation (PRD AOS-3.2, 3.3, 3.7, 3.11, 3.18). The analysis runs in the background
// after processing; this polls the source's identity until it is done (bounded), then shows what waits for a decision.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { SourceIdentityResponse } from '@medlevo/shared';
import { buttonClass } from '../../design';
import { useQuery } from '../library/data';
import { SuggestionCard } from '../sources/SuggestionCard';

const POLL_MS = 1500;
const MAX_POLLS = 120;

export function ImportSuggestions({ sourceId, processed }: { sourceId: string; processed: boolean }) {
  const q = useQuery<SourceIdentityResponse>(processed ? `/versions/sources/${encodeURIComponent(sourceId)}/identity` : null);
  const [polls, setPolls] = useState(0);
  const state = q.data?.analysis?.state;
  const waiting = processed && (state === 'pending' || state === 'not_run' || state === undefined) && polls < MAX_POLLS;
  const refresh = q.refresh;
  useEffect(() => {
    if (!waiting || q.loading) return;
    const timer = setTimeout(() => {
      setPolls((n) => n + 1);
      void refresh();
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [waiting, q.loading, refresh, polls]);

  if (!processed || !q.data) return null;
  // an answer without the list (an older server mid-deploy) shows nothing rather than breaking the upload screen
  const all: SourceIdentityResponse['suggestions'] = Array.isArray(q.data.suggestions) ? q.data.suggestions : [];
  const open = all.filter((s) => s.status === 'open' || s.status === 'applied');
  if (waiting && open.length === 0) {
    return (
      <p className="ml-row__sub" role="status">
        يحلّل الملف لاقتراح رقم المحاضرة واسمها ومادتها…
      </p>
    );
  }
  if (open.length === 0) return null;
  return (
    <section className="ml-upload__suggestions" aria-label={`اقتراحات لملف «${q.data.identity.title}»`}>
      <p className="ml-field__label">اقتراحات بانتظار تأكيدك ({open.length})</p>
      <ul className="ml-list" role="list">
        {open.map((s) => (
          <SuggestionCard key={s.id} suggestion={s} onDecided={() => void q.refresh()} />
        ))}
      </ul>
      <Link to="/upload/suggestions" className={buttonClass({ size: 'sm', variant: 'plain' })}>
        كل الاقتراحات
      </Link>
    </section>
  );
}
