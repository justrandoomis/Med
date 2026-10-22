// «صفحة المادة» — /subjects/:subjectId (P1-T4 step 3; IA §4.2). The subject's header (name, breadcrumb, «تابع المادة»,
// the viewer's role, a progress line with real counts) and the Phase 1 tabs:
//  * «المحاضرات» — official lectures by number then date (P1-T5's API), each with «لديك نسخة» / «إصدار جديد» /
//    «لم تبدأ دراستها» from the viewer's OWN copies, opening the lecture page where «ابدأ الدراسة» lives;
//  * «الملفات» — attachments by type with their uploader; drafts say «بانتظار موافقة المشرف»;
//  * «التحديثات» — the subject's updates feed, each linking to its place.
// Tabs of later phases (النقاشات, التسجيلات, الغرف) are not shown (AOS-23.3). Someone who may not enter sees only the
// title and how to join; the space's routes are never asked for them. Offline, the saved copy is shown read-only.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useParams, useSearchParams } from 'react-router-dom';
import { BookOpen, Clock, FileText, GraduationCap, Megaphone, Plus, Settings2 } from 'lucide-react';
import {
  OFFICIAL_LECTURE_STATUS_LABELS_AR,
  SUBJECT_ATTACHMENT_KIND_LABELS_AR,
  SUBJECT_ATTACHMENT_KINDS,
  SUBJECT_EVENT_KIND_LABELS_AR,
  type ChannelNodeDetail,
  type DocumentCopyView,
  type OfficialLectureView,
  type SubjectAttachmentView,
  type SubjectEventView,
} from '@medlevo/shared';
import { Breadcrumbs, EmptyState, ErrorState, LoadingState, StatusPill, Switch, Tab, TabList, TabPanel, Tabs, buttonClass, useToast } from '../../design';
import { errorMessage, isApiError } from '../../lib/api';
import { formatDate, formatRelative } from '../../lib/time';
import { usePageTitle } from '../../lib/usePageTitle';
import { useOnline } from '../../lib/useOnline';
import { adminSections } from '../admin/sections';
import { lectureUrl } from '../copies/api';
import { channelsApi } from './api';
import { dropCache, withCache, type Cached } from './cache';
import { JoinSheet } from './JoinSheet';
import { subjectApi } from './subjectApi';
import { CachedBanner, ReasonedButton, RoleBadge } from './ui';
import './channels.css';

type TabId = 'lectures' | 'files' | 'updates';
const TABS: readonly TabId[] = ['lectures', 'files', 'updates'];
const MODERATING = new Set(['admin', 'assistant', 'subject_moderator']);

function formatSize(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function SubjectScreen() {
  const { subjectId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const online = useOnline();
  const toast = useToast();
  const [node, setNode] = useState<Cached<ChannelNodeDetail> | null>(null);
  const [state, setState] = useState<{ error: string | null; missing: boolean }>({ error: null, missing: false });
  const [attempt, setAttempt] = useState(0);
  const [joinOpen, setJoinOpen] = useState(false);
  const [following, setFollowing] = useState<boolean | null>(null);
  const [followBusy, setFollowBusy] = useState(false);
  usePageTitle(node?.data.title ?? 'صفحة المادة');

  const request = `${subjectId}|${attempt}`;
  const [requested, setRequested] = useState(request);
  if (requested !== request) {
    setRequested(request);
    setNode(null);
    setState({ error: null, missing: false });
  }
  useEffect(() => {
    let alive = true;
    withCache(`node.${subjectId}`, () => channelsApi.node(subjectId))
      .then((r) => {
        if (!alive) return;
        setNode(r);
        setFollowing(r.data.viewer.course_follow !== null);
      })
      .catch((e) => alive && setState({ error: errorMessage(e), missing: isApiError(e) && e.status === 404 }));
    return () => {
      alive = false;
    };
  }, [subjectId, attempt]);
  const reload = useCallback(() => setAttempt((a) => a + 1), []);

  const tab: TabId = TABS.includes(params.get('tab') as TabId) ? (params.get('tab') as TabId) : 'lectures';
  const setTab = (t: string) => {
    const next = new URLSearchParams(params);
    if (t === 'lectures') next.delete('tab');
    else next.set('tab', t);
    setParams(next, { replace: true });
  };

  if (state.missing)
    return (
      <div className="ml-page ml-page--narrow">
        <EmptyState
          headingLevel={1}
          icon={<GraduationCap size={28} />}
          title="هذه المادة غير موجودة أو لا تملك الوصول إليها"
          description="ربما تغيّر الرابط، أو أن المادة لم تعد متاحة لك. ابدأ من «القنوات»."
          actions={
            <Link to="/channels" className={buttonClass({ variant: 'primary' })}>
              القنوات
            </Link>
          }
        />
      </div>
    );
  if (state.error)
    return (
      <div className="ml-page ml-page--narrow">
        <ErrorState message={state.error} onRetry={reload} />
      </div>
    );
  if (!node) return <LoadingState stage="جارٍ فتح المادة…" />;
  const n = node.data;
  if (n.kind !== 'subject') return <Navigate to={`/channels/${n.id}`} replace />;

  const cached = node.cachedAt !== null;
  const netReason = cached || !online ? 'يحتاج اتصالًا بالإنترنت.' : null;
  const membership = n.viewer.membership;
  const moderating = n.viewer.roles.some((r) => MODERATING.has(r));

  const toggleFollow = async (on: boolean) => {
    setFollowBusy(true);
    try {
      if (on) await channelsApi.follow(n.id);
      else await channelsApi.unfollow(n.id);
      setFollowing(on);
      dropCache(`node.${n.id}`);
      dropCache('tree');
      toast.show({ title: on ? 'تتابع المادة: تُضاف محاضراتها الجديدة إلى مكتبتك.' : 'ألغيت متابعة المادة. ما أُضيف إلى مكتبتك يبقى فيها.', tone: 'success' });
    } catch (e) {
      toast.show({ title: errorMessage(e), tone: 'danger' });
    } finally {
      setFollowBusy(false);
    }
  };

  return (
    <div className="ml-page ch-screen ch-subject">
      <Breadcrumbs items={[{ label: 'القنوات', to: '/channels' }, ...n.path.map((p) => ({ label: p.title, to: `/channels/${p.id}` })), { label: n.title }]} />
      <header className="ml-page__header ch-subject__header">
        <h1 className="ml-page__title">
          <bdi>{n.title}</bdi>
        </h1>
        <p className="ch-subject__meta">
          <span>مادة</span>
          {n.title_en && <bdi dir="ltr">{n.title_en}</bdi>}
          {n.viewer.roles.map((r) => (
            <RoleBadge key={r} role={r} />
          ))}
          {n.status === 'archived' && <StatusPill tone="warning">مؤرشفة — للقراءة فقط</StatusPill>}
        </p>
      </header>
      {cached && <CachedBanner at={node.cachedAt!} />}

      {!n.space_id ? (
        <section className="ch-section" aria-label="الانضمام">
          {membership?.status === 'pending' ? (
            <p className="ch-section__title">
              <Clock size={20} aria-hidden="true" /> طلبك قيد المراجعة
            </p>
          ) : membership && (membership.status === 'removed' || membership.status === 'left') ? (
            <p>لم تعد عضوًا في هذه المادة — ملاحظاتك الشخصية باقية لديك.</p>
          ) : n.join_policy === 'closed' ? (
            // no code or link is ever accepted here (the server refuses them): never ask for one (review R8)
            <>
              <p className="ch-section__title">الانضمام بدعوة فقط</p>
              <p className="ch-node__state">يرسل مشرف المادة الدعوات؛ تصلك الدعوة في «القنوات» وفي «التنبيهات».</p>
            </>
          ) : (
            <>
              <p className="ch-section__title">يتطلب رمز انضمام</p>
              <p className="ch-node__state">اطلب من مشرف المادة رمز الانضمام أو رابط الدعوة، ثم:</p>
              <div className="ch-screen__actions">
                <ReasonedButton variant="primary" icon={<Plus size={18} />} reason={netReason} onClick={() => setJoinOpen(true)}>
                  انضم برمز أو QR
                </ReasonedButton>
              </div>
            </>
          )}
          {membership?.status === 'pending' && <p className="ch-node__state">يصلك تنبيه عند قرار المشرف. حتى ذلك الحين لا تظهر محاضرات المادة.</p>}
        </section>
      ) : (
        <>
          <div className="ch-subject__follow">
            {following !== null && (
              <Switch
                label="تابع المادة"
                description={netReason ? `تتطلب المتابعة اتصالًا. ${following ? 'تتابعها الآن.' : ''}` : following ? 'تتابعها — تُضاف محاضراتها الجديدة إلى مكتبتك تلقائيًا.' : 'عند المتابعة تُضاف محاضراتها الجديدة إلى مكتبتك تلقائيًا (روابط، لا نسخ).'}
                checked={following}
                disabled={followBusy || !!netReason}
                onCheckedChange={(v) => void toggleFollow(v)}
              />
            )}
          </div>
          {moderating && (
            <p className="ch-screen__actions">
              <Link className={buttonClass({ variant: 'secondary', size: 'sm' })} to={`/admin?node=${encodeURIComponent(n.id)}`}>
                <Settings2 size={16} aria-hidden="true" /> إدارة المادة
              </Link>
            </p>
          )}
          <Tabs value={tab} onValueChange={setTab} className="ch-tabs">
            <TabList label="أقسام المادة">
              <Tab value="lectures" icon={<BookOpen size={16} />}>
                المحاضرات
              </Tab>
              <Tab value="files" icon={<FileText size={16} />}>
                الملفات
              </Tab>
              <Tab value="updates" icon={<Megaphone size={16} />}>
                التحديثات
              </Tab>
            </TabList>
            <TabPanel value="lectures" className="ch-tabpanel">
              <LecturesTab subject={n} spaceId={n.space_id} />
            </TabPanel>
            <TabPanel value="files" className="ch-tabpanel">
              <FilesTab spaceId={n.space_id} />
            </TabPanel>
            <TabPanel value="updates" className="ch-tabpanel">
              <UpdatesTab spaceId={n.space_id} />
            </TabPanel>
          </Tabs>
        </>
      )}
      <JoinSheet open={joinOpen} onClose={() => setJoinOpen(false)} onJoined={reload} />
    </div>
  );
}

/** Loads one tab's data with the offline copy (AOS-20.17) and an honest error. */
function useTabData<T>(key: string, fetcher: () => Promise<T>) {
  const [s, setS] = useState<{ data: Cached<T> | null; error: string | null }>({ data: null, error: null });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    withCache(key, fetcher)
      .then((data) => alive && setS({ data, error: null }))
      .catch((e) => alive && setS({ data: null, error: errorMessage(e) }));
    return () => {
      alive = false;
    };
    // the fetcher is recreated each render; the key names what it fetches
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt]);
  return { ...s, retry: () => setAttempt((a) => a + 1) };
}

function LecturesTab({ subject, spaceId }: { subject: ChannelNodeDetail; spaceId: string }) {
  const toast = useToast();
  const online = useOnline();
  const lectures = useTabData(`subject.${spaceId}.lectures`, () => subjectApi.lectures(spaceId));
  // the viewer's OWN copies (their vault): kept with the page for offline use. While they are unknown (loading, failed)
  // the page says nothing about what the viewer has or has not started — never «لم تبدأ دراستها» on a guess (review R1)
  const copiesRead = useTabData(`subject.${spaceId}.copies`, () => subjectApi.copies(spaceId));
  const copies: DocumentCopyView[] | null = copiesRead.data?.data.copies ?? null;
  const [more, setMore] = useState<{ items: OfficialLectureView[]; next: string | null } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const items = useMemo(() => [...(lectures.data?.data.items ?? []), ...(more?.items ?? [])], [lectures.data, more]);
  const next = more ? more.next : (lectures.data?.data.next_cursor ?? null);
  const copyOf = useMemo(() => {
    const m = new Map<string, DocumentCopyView>();
    for (const c of copies ?? []) if (c.lecture && !m.has(c.lecture.lecture_id)) m.set(c.lecture.lecture_id, c);
    return m;
  }, [copies]);
  const officialAdmin = subject.viewer.roles.some((r) => r === 'admin' || r === 'subject_moderator' || r === 'contributor') && adminSections().some((s) => s.id === 'official');
  const moreReason = lectures.data?.cachedAt != null || !online ? 'تحميل المزيد يحتاج اتصالًا بالإنترنت.' : null;

  if (lectures.error) return <ErrorState inline message={lectures.error} onRetry={lectures.retry} />;
  if (!lectures.data) return <LoadingState inline stage="جارٍ تحميل المحاضرات…" />;
  if (items.length === 0)
    return (
      <EmptyState
        icon={<BookOpen size={28} />}
        title="لا توجد محاضرات رسمية بعد"
        description="لا توجد محاضرات رسمية منشورة في هذه المادة بعد."
        actions={
          officialAdmin ? (
            <Link className={buttonClass({ variant: 'primary' })} to={`/admin/official?subject=${encodeURIComponent(subject.id)}`}>
              ارفع محاضرة
            </Link>
          ) : undefined
        }
      />
    );
  const published = items.filter((l) => l.status === 'published');
  const studied = published.filter((l) => copyOf.has(l.id)).length;
  return (
    <div className="ml-stack">
      {copies !== null && !next && published.length > 0 && <p className="ch-node__state">{`بدأت دراسة ${studied} من ${published.length} محاضرة منشورة.`}</p>}
      {copiesRead.error && copies === null && <p className="ch-node__state">تعذّر التحقق من نسخك من محاضرات هذه المادة الآن؛ ما بدأت دراسته محفوظ في مكتبتك.</p>}
      <ul role="list" className="ml-list">
        {items.map((l) => {
          const copy = copyOf.get(l.id);
          const head = l.head_version;
          const meta = [l.lecture_no !== null ? `المحاضرة ${l.lecture_no}` : null, l.held_on ? formatDate(Date.parse(`${l.held_on}T12:00:00Z`)) : null, head ? `الإصدار ${head.version_no}` : null].filter(Boolean).join(' · ');
          return (
            <li key={l.id} className="ml-list__row">
              <Link to={lectureUrl(spaceId, l.id)} className="ml-list-item ml-list-item--interactive">
                <span className="ml-list-item__leading" aria-hidden="true">
                  <BookOpen size={20} />
                </span>
                <span className="ml-list-item__text">
                  <span className="ml-list-item__subtitle">{meta}</span>
                  <span className="ml-list-item__title ch-lecture-row__title">
                    <bdi>{l.title}</bdi>
                  </span>
                </span>
                <span className="ml-list-item__trailing ch-row__badges">
                  {l.status !== 'published' && <StatusPill tone="warning">{OFFICIAL_LECTURE_STATUS_LABELS_AR[l.status]}</StatusPill>}
                  {copy ? <StatusPill tone="success">لديك نسخة</StatusPill> : copies !== null && l.status === 'published' && <StatusPill tone="neutral">لم تبدأ دراستها</StatusPill>}
                  {copy?.newer_official_version && <StatusPill tone="info">إصدار جديد</StatusPill>}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
      {next && (
        <ReasonedButton
          className="ch-more"
          loading={loadingMore}
          reason={moreReason}
          onClick={async () => {
            setLoadingMore(true);
            try {
              const r = await subjectApi.lectures(spaceId, next);
              setMore((m) => ({ items: [...(m?.items ?? []), ...r.items], next: r.next_cursor }));
            } catch (e) {
              toast.show({ title: errorMessage(e), tone: 'danger' });
            } finally {
              setLoadingMore(false);
            }
          }}
        >
          المزيد من المحاضرات
        </ReasonedButton>
      )}
    </div>
  );
}

function FilesTab({ spaceId }: { spaceId: string }) {
  const files = useTabData(`subject.${spaceId}.files`, () => subjectApi.attachments(spaceId));
  if (files.error) return <ErrorState inline message={files.error} onRetry={files.retry} />;
  if (!files.data) return <LoadingState inline stage="جارٍ تحميل الملفات…" />;
  const list = files.data.data.attachments.filter((a) => a.status !== 'withdrawn');
  if (list.length === 0) return <EmptyState icon={<FileText size={28} />} title="لا توجد ملفات بعد" description="تظهر هنا الملخصات وأسئلة السنوات السابقة والمراجع التي ينشرها مشرفو المادة." />;
  const byKind = SUBJECT_ATTACHMENT_KINDS.map((k) => ({ kind: k, items: list.filter((a) => a.kind === k) })).filter((g) => g.items.length > 0);
  return (
    <div>
      {byKind.map((g) => (
        <section key={g.kind} className="ch-files-group" aria-labelledby={`ch-files-${g.kind}`}>
          <h3 id={`ch-files-${g.kind}`} className="ml-group-header">
            {SUBJECT_ATTACHMENT_KIND_LABELS_AR[g.kind]}
          </h3>
          <ul role="list" className="ml-list">
            {g.items.map((a) => (
              <AttachmentRow key={a.id} a={a} spaceId={spaceId} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function AttachmentRow({ a, spaceId }: { a: SubjectAttachmentView; spaceId: string }) {
  const sub = [`رفعه ${a.uploaded_by.display_name}`, a.lecture ? `مرتبط بـ ${a.lecture.title}` : null, a.file ? formatSize(a.file.size) : null].filter(Boolean).join(' · ');
  const body = (
    <>
      <span className="ml-list-item__leading" aria-hidden="true">
        <FileText size={20} />
      </span>
      <span className="ml-list-item__text">
        <span className="ml-list-item__title">
          <bdi>{a.title}</bdi>
        </span>
        <span className="ml-list-item__subtitle">{sub}</span>
      </span>
      {a.status === 'draft' && (
        <span className="ml-list-item__trailing">
          <StatusPill tone="warning">بانتظار موافقة المشرف</StatusPill>
        </span>
      )}
    </>
  );
  return (
    <li className="ml-list__row">
      {a.file ? (
        <a className="ml-list-item ml-list-item--interactive" href={subjectApi.fileUrl(spaceId, a.file.file_id)} target="_blank" rel="noopener">
          {body}
        </a>
      ) : (
        <div className="ml-list-item">{body}</div>
      )}
    </li>
  );
}

function UpdatesTab({ spaceId }: { spaceId: string }) {
  const toast = useToast();
  const online = useOnline();
  const events = useTabData(`subject.${spaceId}.events`, () => subjectApi.events(spaceId));
  const [more, setMore] = useState<{ items: SubjectEventView[]; next: string | null } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  if (events.error) return <ErrorState inline message={events.error} onRetry={events.retry} />;
  if (!events.data) return <LoadingState inline stage="جارٍ تحميل التحديثات…" />;
  const items = [...events.data.data.items, ...(more?.items ?? [])];
  const next = more ? more.next : events.data.data.next_cursor;
  if (items.length === 0) return <EmptyState icon={<Megaphone size={28} />} title="لا تحديثات بعد" description="يظهر هنا كل جديد في المادة: محاضرة أو إصدار جديد، ملف، سحب محاضرة." />;
  return (
    <div className="ml-stack">
      <ul role="list" className="ml-list">
        {items.map((e) => {
          const to = e.ref.type === 'official_lecture' ? lectureUrl(spaceId, e.ref.id) : e.ref.type === 'subject_attachment' ? '?tab=files' : null;
          const body = (
            <>
              <span className="ml-list-item__text">
                <span className="ch-event__kind">{SUBJECT_EVENT_KIND_LABELS_AR[e.kind]}</span>
                <span className="ml-list-item__title">
                  <bdi>{e.title}</bdi>
                </span>
              </span>
              <span className="ml-list-item__trailing">{formatRelative(e.created_at)}</span>
            </>
          );
          return (
            <li key={e.seq} className="ml-list__row">
              {to ? (
                <Link to={to} className="ml-list-item ml-list-item--interactive">
                  {body}
                </Link>
              ) : (
                <div className="ml-list-item">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
      {next && (
        <ReasonedButton
          className="ch-more"
          loading={loadingMore}
          reason={events.data.cachedAt !== null || !online ? 'تحميل الأقدم يحتاج اتصالًا بالإنترنت.' : null}
          onClick={async () => {
            setLoadingMore(true);
            try {
              const r = await subjectApi.events(spaceId, next);
              setMore((m) => ({ items: [...(m?.items ?? []), ...r.items], next: r.next_cursor }));
            } catch (e) {
              toast.show({ title: errorMessage(e), tone: 'danger' });
            } finally {
              setLoadingMore(false);
            }
          }}
        >
          الأقدم
        </ReasonedButton>
      )}
    </div>
  );
}
