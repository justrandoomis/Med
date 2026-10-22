// The lecture page's «الشروحات» tab (P1-T5 step 3; PRD AOS-2.8 / 5.27 Phase 1 parts, 5.12 course-only, 19I.3): the
// explanations classmates published on this lecture — newest first, only those the viewer may see (the server filters
// before paginating) — each labelled «شرح طالب — ليس مصدرًا», with «انشر شرحك» for a viewer who studies the lecture.
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Send } from 'lucide-react';
import { completenessAr, type LecturePublicationsResponse, type PublicationCard } from '@medlevo/shared';
import { Button, EmptyState, ErrorState, LoadingState, StatusPill } from '../../design';
import { errorMessage } from '../../lib/api';
import { MixedText } from '../../lib/MixedText';
import { useOnline } from '../../lib/useOnline';
import { formatDate } from '../../lib/time';
import { publicationsApi, publicationUrl } from './api';
import { PublishDialog } from './PublishDialog';
import './publications.css';

export const STUDENT_EXPLANATIONS_BANNER_AR = 'شروحات الطلاب ليست مصدرًا رسميًا: كتبها طلاب المادة، ولا تُستعمل دليلًا في الإجابات. المرجع هو المحاضرة الرسمية.';

export function PublicationsTab({
  spaceId,
  lecture,
  studySourceId,
  canPublish,
}: {
  spaceId: string;
  lecture: { id: string; title: string };
  /** the viewer's copy of the lecture (its layers can be published); null when the viewer does not study it */
  studySourceId: string | null;
  /** the lecture is published (an explanation is written on a published version) */
  canPublish: boolean;
}) {
  const online = useOnline();
  const [cards, setCards] = useState<PublicationCard[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [publishOpen, setPublishOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    publicationsApi
      .list(spaceId, lecture.id)
      .then((r: LecturePublicationsResponse) => {
        if (cancelled) return;
        setCards(r.items);
        setNext(r.next_cursor);
        setError(null);
      })
      .catch((e) => !cancelled && setError(errorMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [spaceId, lecture.id, attempt]);

  const loadMore = useCallback(async () => {
    if (!next) return;
    setMore(true);
    try {
      const r = await publicationsApi.list(spaceId, lecture.id, next);
      setCards((c) => [...(c ?? []), ...r.items.filter((x) => !(c ?? []).some((y) => y.id === x.id))]);
      setNext(r.next_cursor);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setMore(false);
    }
  }, [spaceId, lecture.id, next]);

  return (
    <div className="pb-tab">
      <p className="pb-banner" role="note">
        {STUDENT_EXPLANATIONS_BANNER_AR}
      </p>
      {canPublish && (
        <div className="pb-tab__actions">
          {studySourceId ? (
            <>
              <Button icon={<Send size={18} />} onClick={() => setPublishOpen(true)} disabled={!online} aria-describedby={online ? undefined : 'publish-offline-reason'}>
                انشر شرحك
              </Button>
              {!online && (
                <p id="publish-offline-reason" className="pb-meta" role="status">
                  أنت غير متصل: النشر يحتاج الخادم.
                </p>
              )}
            </>
          ) : (
            <p className="pb-meta">لتنشر شرحك: ابدأ دراسة المحاضرة واكتب على نسختك، ثم انشره من هنا.</p>
          )}
        </div>
      )}
      {error && !cards ? (
        <ErrorState message={error} onRetry={() => setAttempt((n) => n + 1)} />
      ) : !cards ? (
        <LoadingState stage="جارٍ تحميل الشروحات…" />
      ) : cards.length === 0 ? (
        <EmptyState title="لا توجد شروحات منشورة لهذه المحاضرة بعد." />
      ) : (
        <>
          <ul className="pb-list" aria-label="الشروحات المنشورة">
            {cards.map((c) => (
              <li key={c.id}>
                <Link className="pb-card" to={publicationUrl(spaceId, c.id)}>
                  <span className="pb-card__title">
                    <MixedText text={c.title} />
                  </span>
                  <span className="pb-card__meta">
                    <StatusPill tone="info">{c.label_ar}</StatusPill>
                    <span>{c.author.display_name}</span>
                    <span>{`الإصدار ${c.head_version_no}`}</span>
                    <span>{completenessAr(c.completeness)}</span>
                    <span>{`حُدّث ${formatDate(c.updated_at)}`}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {error && (
            <p className="cp-sheet__error" role="alert">
              {error}
            </p>
          )}
          {next && (
            <div className="pb-tab__actions">
              <Button variant="secondary" onClick={() => void loadMore()} loading={more}>
                عرض المزيد
              </Button>
            </div>
          )}
        </>
      )}
      {publishOpen && studySourceId && <PublishDialog open onClose={() => setPublishOpen(false)} spaceId={spaceId} lecture={lecture} sourceId={studySourceId} />}
    </div>
  );
}
