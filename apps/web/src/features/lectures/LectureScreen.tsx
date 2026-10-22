// The official lecture page of a subject (P1-T5 steps 2–3): /subjects/:spaceId/lectures/:lectureId — reached from a
// search hit in a subject's official text, a notification or the copy bar of the reader. It shows the lecture as the
// server lets the viewer see it (a lecture the viewer may not see answers «not found», like a missing one) in two tabs:
//   * «الرسمي» — its published versions and «ابدأ الدراسة» (or «افتح نسختي» when the viewer already studies it);
//   * «الشروحات» (step 3) — the explanations classmates published on it, labelled «شرح طالب — ليس مصدرًا», and
//     «انشر شرحك» (PublicationsTab). `?tab=explanations` opens it directly (a notification of a new explanation).
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { BookOpenCheck } from 'lucide-react';
import { LECTURE_WITHDRAW_REASON_LABELS_AR, type DocumentCopyView, type OfficialLectureDetail } from '@medlevo/shared';
import { Button, ErrorState, LoadingState, StatusPill, Tab, TabList, TabPanel, Tabs, buttonClass } from '../../design';
import { errorMessage } from '../../lib/api';
import { useOnline } from '../../lib/useOnline';
import { usePageTitle } from '../../lib/usePageTitle';
import { formatDate } from '../../lib/time';
import { copiesApi } from '../copies/api';
import { StartStudyingDialog } from '../copies/StartStudyingDialog';
import { studyUrl } from '../workspace/nav/SourceNavigation';
import { lecturesApi } from './api';
import { PublicationsTab } from './PublicationsTab';
import '../copies/copies.css';

interface Loaded {
  lecture: OfficialLectureDetail;
  copy: DocumentCopyView | null;
  /** every copy of the lecture in the viewer's library (they share one stub: any of them carries the viewer's layers) */
  sourceId: string | null;
}

export function LectureScreen() {
  const { spaceId = '', lectureId = '' } = useParams();
  const [sp, setSp] = useSearchParams();
  const tab = sp.get('tab') === 'explanations' ? 'explanations' : 'official';
  const setTab = (v: string) =>
    setSp(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (v === 'explanations') next.set('tab', 'explanations');
        else next.delete('tab');
        return next;
      },
      { replace: true },
    );
  const page = Number.parseInt(sp.get('page') ?? '', 10);
  const pageIndex = Number.isFinite(page) && page >= 0 ? page : null;
  const online = useOnline();
  const [state, setState] = useState<{ loading: boolean; error: string | null; data: Loaded | null }>({ loading: true, error: null, data: null });
  const [attempt, setAttempt] = useState(0);
  const [startOpen, setStartOpen] = useState(false);
  usePageTitle(state.data?.lecture.title ?? 'محاضرة رسمية');
  // a new lecture (or a retry) shows its loading state at once, while rendering; the request runs in the effect
  const request = `${spaceId}|${lectureId}|${attempt}`;
  const [requested, setRequested] = useState(request);
  if (requested !== request) {
    setRequested(request);
    setState((s) => ({ ...s, loading: true, error: null }));
  }

  useEffect(() => {
    let cancelled = false;
    Promise.all([lecturesApi.detail(spaceId, lectureId), copiesApi.list({ space_id: spaceId, lecture_id: lectureId })])
      .then(([lecture, copies]) => !cancelled && setState({ loading: false, error: null, data: { lecture, copy: copies.copies.find((c) => c.mode === 'personal') ?? null, sourceId: copies.copies[0]?.source_id ?? null } }))
      .catch((e) => !cancelled && setState({ loading: false, error: errorMessage(e), data: null }));
    return () => {
      cancelled = true;
    };
  }, [spaceId, lectureId, attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  if (state.loading && !state.data) return <LoadingState stage="جارٍ فتح المحاضرة…" />;
  if (state.error || !state.data) {
    return (
      <div className="cp-lecture">
        <ErrorState message={online ? (state.error ?? 'تعذّر فتح المحاضرة.') : 'أنت غير متصل: صفحة المحاضرة الرسمية تحتاج الخادم. نسختك منها في مكتبتك تعمل دون اتصال إن نزّلتها.'} onRetry={retry} />
      </div>
    );
  }

  const { lecture, copy, sourceId } = state.data;
  const head = lecture.head_version;
  const published = lecture.versions.filter((v) => v.status !== 'draft' && v.published_at !== null);
  return (
    <article className="cp-lecture" aria-labelledby="cp-lecture-title">
      <header>
        <p className="cp-lecture__subject">{lecture.subject.title}</p>
        <h1 id="cp-lecture-title" className="cp-lecture__title">
          <bdi>{lecture.title}</bdi>
        </h1>
      </header>
      <p className="cp-lecture__meta">
        {lecture.lecture_no !== null && <span>{`المحاضرة ${lecture.lecture_no}`}</span>}
        {lecture.held_on && <span>{lecture.held_on}</span>}
        {head && <span>{`الإصدار ${head.version_no}${head.page_count ? ` · ${head.page_count} صفحة` : ''}`}</span>}
        {lecture.status === 'withdrawn' ? <StatusPill tone="warning">مسحوبة</StatusPill> : lecture.status === 'published' ? <StatusPill tone="success">منشورة</StatusPill> : null}
      </p>
      {lecture.withdrawn && (
        <p className="cp-lecture__notice" role="note">
          {`${LECTURE_WITHDRAW_REASON_LABELS_AR[lecture.withdrawn.reason]}: ${lecture.withdrawn.note_ar}`}
          {copy ? ' نسختك وملاحظاتك عليها باقية في مكتبتك.' : ''}
        </p>
      )}
      <Tabs value={tab} onValueChange={setTab}>
        <TabList label="المحاضرة وشروحاتها">
          <Tab value="official">الرسمي</Tab>
          <Tab value="explanations">الشروحات</Tab>
        </TabList>
        <TabPanel value="official">
          <div className="cp-lecture__actions">
            {copy ? (
              <Link className={buttonClass({ variant: 'primary' })} to={studyUrl({ sourceId: copy.source_id, pageIndex })}>
                <BookOpenCheck size={18} aria-hidden="true" />
                افتح نسختي
              </Link>
            ) : lecture.status === 'published' && head ? (
              <>
                <Button icon={<BookOpenCheck size={18} />} onClick={() => setStartOpen(true)} disabled={!online} aria-describedby={online ? undefined : 'cp-lecture-offline'}>
                  ابدأ الدراسة
                </Button>
                {/* review P1-T5 s2 R-H: a disabled control says why (AOS-23.3) */}
                {!online && (
                  <p id="cp-lecture-offline" className="cp-lecture__notice" role="status">
                    أنت غير متصل: بدء الدراسة يحتاج الخادم مرة واحدة لإضافة المحاضرة إلى مكتبتك.
                  </p>
                )}
              </>
            ) : null}
          </div>
          {published.length > 0 && (
            <section aria-labelledby="cp-lecture-versions">
              <h2 id="cp-lecture-versions" className="cp-lecture__h2">
                الإصدارات المنشورة
              </h2>
              <ul className="cp-lecture__versions">
                {published.map((v) => (
                  <li key={v.id} className="cp-lecture__version">
                    <span>{`الإصدار ${v.version_no}`}</span>
                    {v.published_at !== null && <span>{`نُشر ${formatDate(v.published_at)}`}</span>}
                    {v.change_note && <span>{v.change_note}</span>}
                    {v.id === head?.id && <StatusPill tone="accent">الحالي</StatusPill>}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </TabPanel>
        <TabPanel value="explanations">
          <PublicationsTab spaceId={spaceId} lecture={{ id: lecture.id, title: lecture.title }} studySourceId={copy?.source_id ?? sourceId} canPublish={lecture.status === 'published' && !!head} />
        </TabPanel>
      </Tabs>
      {startOpen && head && (
        <StartStudyingDialog
          open
          onClose={() => setStartOpen(false)}
          pageIndex={pageIndex}
          target={{ spaceId, lectureId, title: lecture.title, subjectTitle: lecture.subject.title, versionNo: head.version_no }}
        />
      )}
    </article>
  );
}
