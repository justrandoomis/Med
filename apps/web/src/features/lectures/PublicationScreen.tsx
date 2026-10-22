// The page of a published explanation (P1-T5 step 3; PRD AOS-2.8 / 5.27 Phase 1 parts, 5.12 course-only, 4.14, 21.16;
// ARCHITECTURE_DELTA §6.4, §7.6): /subjects/:spaceId/publications/:publicationId. Members of the subject only — anybody
// else gets the server's «not found», like a missing page. It shows the explanation as a STUDENT's («شرح طالب — ليس
// مصدرًا»), its author, how much of the lecture it covers («ص 3 من 40»), the official version it was written on, its
// versions with their change notes, what the last version changed, and previews of its pages over the official pages.
//   * a classmate: «ابدأ الدراسة بهذا الشرح» (follow or fork), «افتح نسختي» once they have one (with «اعرض التغييرات»
//     when an update waits), «أبلغ»;
//   * the author: «انشر إصدارًا جديدًا», «عدّل العنوان والملخص», «اسحب الشرح», and what the snapshot left out and why.
// A hidden or withdrawn explanation says so in words; copies people already have stay with them.
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { BookOpenCheck, Flag, PenLine, RefreshCw, Send, Undo2 } from 'lucide-react';
import {
  completenessAr,
  endSentenceAr,
  hiddenByModeratorAr,
  itemsCountAr,
  PUBLICATION_STATUS_LABELS_AR,
  type DocumentCopyView,
  type PublicationView,
  type UpstreamPreview,
} from '@medlevo/shared';
import { Button, ConfirmDialog, Dialog, ErrorState, LoadingState, StatusPill, TextArea, TextField, buttonClass, useToast } from '../../design';
import { errorMessage } from '../../lib/api';
import { MixedText } from '../../lib/MixedText';
import { typed } from '../../lib/typedText';
import { useOnline } from '../../lib/useOnline';
import { usePageTitle } from '../../lib/usePageTitle';
import { formatDate } from '../../lib/time';
import { copiesApi, copyStudyUrl, lectureUrl } from '../copies/api';
import { StartFromExplanationDialog } from '../copies/StartFromExplanationDialog';
import { UpdatePreviewDialog } from '../copies/UpdatePreviewDialog';
import { publicationsApi } from './api';
import { PagePreviewFrame } from './PagePreviewFrame';
import { machineContentAr, pagePreviews, type PagePreview } from './publicationPreview';
import { PublishDialog } from './PublishDialog';
import { ReportDialog } from './ReportDialog';
import '../copies/copies.css';
import './publications.css';

interface Loaded {
  pub: PublicationView;
  copies: DocumentCopyView[];
}

const STATUS_NOTE_AR: Partial<Record<PublicationView['status'], string>> = {
  withdrawn: 'سحب صاحبه هذا الشرح: لا يُتابَع ولا يُنسخ بعد الآن. النسخ المستقلة تبقى لأصحابها، وكل نسخة متابَعة تبقى عند آخر إصدار طبّقه صاحبها.',
  author_deleted: 'حذف صاحب هذا الشرح حسابه: لا يُتابَع ولا يُنسخ بعد الآن. النسخ الموجودة تبقى لأصحابها عند آخر إصدار أخذوه.',
};

function EditDetailsDialog({ open, onClose, pub, onSaved }: { open: boolean; onClose: () => void; pub: PublicationView; onSaved: (v: PublicationView) => void }) {
  const online = useOnline();
  const [title, setTitle] = useState(pub.title);
  const [summary, setSummary] = useState(pub.summary ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    if (!title.trim()) {
      setError('اكتب عنوانًا للشرح.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onSaved(await publicationsApi.patch(pub.space_id, pub.id, { title: title.trim(), summary: summary.trim() || null }));
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissible={!busy}
      title="عدّل العنوان والملخص"
      description="الإصدارات المنشورة لا تتغير؛ يتغير العنوان والملخص وحدهما."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            إلغاء
          </Button>
          <Button onClick={save} loading={busy} disabled={!online}>
            احفظ
          </Button>
        </>
      }
    >
      <div className="cp-sheet">
        <TextField label="عنوان الشرح" required value={title} maxLength={120} onChange={typed(setTitle)} />
        <TextArea label="ملخص (اختياري)" value={summary} maxLength={1000} rows={3} onChange={typed(setSummary, true)} />
        {error && (
          <p className="cp-sheet__error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

export function PublicationScreen() {
  const { spaceId = '', publicationId = '' } = useParams();
  const online = useOnline();
  const toast = useToast();
  const [state, setState] = useState<{ loading: boolean; error: string | null; data: Loaded | null }>({ loading: true, error: null, data: null });
  const [attempt, setAttempt] = useState(0);
  const [previews, setPreviews] = useState<PagePreview[] | null>(null);
  // (C2, AOS-19I.5) the version's machine-generated parts, said in words (null: none, or not known yet)
  const [machineAr, setMachineAr] = useState<string | null>(null);
  const [lastChange, setLastChange] = useState<UpstreamPreview | null>(null);
  const [dialog, setDialog] = useState<null | 'start' | 'report' | 'republish' | 'edit' | 'withdraw' | 'update'>(null);
  usePageTitle(state.data?.pub.title ?? 'شرح منشور');
  const request = `${spaceId}|${publicationId}|${attempt}`;
  const [requested, setRequested] = useState(request);
  if (requested !== request) {
    setRequested(request);
    setState((s) => ({ ...s, loading: true, error: null }));
  }

  useEffect(() => {
    let cancelled = false;
    publicationsApi
      .get(spaceId, publicationId)
      .then(async (pub) => {
        const { copies } = await copiesApi.list({ space_id: spaceId, lecture_id: pub.lecture.id });
        if (!cancelled) setState({ loading: false, error: null, data: { pub, copies } });
      })
      .catch((e) => !cancelled && setState({ loading: false, error: errorMessage(e), data: null }));
    return () => {
      cancelled = true;
    };
  }, [spaceId, publicationId, attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  // the newest version THIS viewer may read: the head, or — for a holder of a hidden / withdrawn explanation — the last
  // version the server lists for them (what their copy took; review P1-T5 s3 R3-B)
  const head = state.data ? (state.data.pub.versions.at(-1)?.no ?? 0) : 0;
  useEffect(() => {
    if (!head) return;
    let cancelled = false;
    publicationsApi
      .items(spaceId, publicationId, head)
      .then((r) => {
        if (cancelled) return;
        setPreviews(pagePreviews(r.items));
        setMachineAr(machineContentAr(r.notes));
      })
      // previews are an addition: without them the page still says everything in words
      .catch(() => !cancelled && setPreviews([]));
    if (head > 1)
      publicationsApi
        .diff(spaceId, publicationId, head - 1, head)
        .then((d) => !cancelled && setLastChange(d))
        .catch(() => !cancelled && setLastChange(null));
    return () => {
      cancelled = true;
    };
  }, [spaceId, publicationId, head]);

  if (state.loading && !state.data) return <LoadingState stage="جارٍ فتح الشرح…" />;
  if (state.error || !state.data) {
    return (
      <div className="pb-page">
        <ErrorState message={online ? (state.error ?? 'تعذّر فتح الشرح.') : 'أنت غير متصل: صفحة الشرح تحتاج الخادم. نسختك منه في مكتبتك تعمل دون اتصال.'} onRetry={retry} />
      </div>
    );
  }

  const { pub, copies } = state.data;
  const setPub = (p: PublicationView) => setState((s) => (s.data ? { ...s, data: { ...s.data, pub: p } } : s));
  const setCopy = (c: DocumentCopyView) => setState((s) => (s.data ? { ...s, data: { ...s.data, copies: [...s.data.copies.filter((x) => x.id !== c.id), c] } } : s));
  const mine = copies.find((c) => c.publication?.id === pub.id) ?? null;
  const personal = copies.find((c) => c.mode === 'personal') ?? null;
  const authorSource = personal?.source_id ?? copies[0]?.source_id ?? null;
  const headVersion = pub.versions.find((v) => v.no === pub.head_version_no) ?? pub.versions.at(-1) ?? null;
  const active = pub.status === 'active';
  const isAuthor = pub.viewer.can_edit;
  const pending = mine && mine.mode === 'followed' && mine.pending_version_no !== null && mine.publication?.status === 'active' ? mine.pending_version_no : null;

  const withdraw = async () => {
    const v = await publicationsApi.withdraw(pub.space_id, pub.id);
    setPub(v);
    setDialog(null);
    toast.show({ tone: 'success', title: 'سُحب الشرح.', description: 'النسخ التي أخذها زملاؤك تبقى لهم.' });
  };

  return (
    <article className="pb-page" aria-labelledby="publication-title">
      <header>
        <p className="cp-lecture__subject">{pub.subject.title}</p>
        <h1 id="publication-title" className="pb-page__title">
          <MixedText text={pub.title} />
        </h1>
      </header>
      <p className="pb-meta">
        <StatusPill tone="info">{pub.origin_label_ar}</StatusPill>
        <span>{`بقلم ${pub.author.display_name}`}</span>
        <span>{`الإصدار ${pub.versions.at(-1)?.no ?? pub.head_version_no}`}</span>
        <span>{completenessAr(pub.completeness)}</span>
        {headVersion && <span>{`مبني على الإصدار ${headVersion.lecture_version_no} من المحاضرة`}</span>}
        {!active && <StatusPill tone="warning">{PUBLICATION_STATUS_LABELS_AR[pub.status]}</StatusPill>}
      </p>
      {machineAr && (
        <p className="pb-notice" role="note">
          {machineAr}
        </p>
      )}
      <p className="pb-meta">
        <Link className="cp-bar__link" to={lectureUrl(pub.space_id, pub.lecture.id)}>
          {`المحاضرة: ${pub.lecture.title}`}
        </Link>
      </p>
      {pub.hidden && (
        <p className="pb-notice" role="note">
          {`${endSentenceAr(hiddenByModeratorAr(pub.hidden.reason_ar))} ${isAuthor ? 'لا يراه أعضاء المادة الآن.' : 'ما عندك باقٍ كما هو، ولا تصل تحديثاته حتى يُعاد إظهاره.'}`}
        </p>
      )}
      {STATUS_NOTE_AR[pub.status] && (
        <p className="pb-notice" role="note">
          {STATUS_NOTE_AR[pub.status]}
        </p>
      )}
      {pub.summary && <p className="cp-sheet__line">{pub.summary}</p>}
      {isAuthor && pub.snapshot && (
        <section className="pb-tab" aria-labelledby="publication-snapshot">
          <h2 id="publication-snapshot" className="pb-page__h2">
            ما نُشر في الإصدار الحالي
          </h2>
          <p className="cp-sheet__line">{`نُشر ${itemsCountAr(pub.snapshot.items)}.`}</p>
          {pub.snapshot.skipped.length > 0 && (
            <ul className="pb-versions" aria-label="ما لم يدخل الشرح">
              {pub.snapshot.skipped.map((s) => (
                <li key={s.reason_ar}>{`لم يُنشر ${itemsCountAr(s.items)}: ${s.reason_ar}`}</li>
              ))}
            </ul>
          )}
        </section>
      )}

      <div className="pb-tab__actions">
        {mine ? (
          <Link className={buttonClass({ variant: 'primary' })} to={copyStudyUrl(mine)}>
            <BookOpenCheck size={18} aria-hidden="true" />
            افتح نسختي
          </Link>
        ) : !isAuthor && active ? (
          <>
            <Button icon={<BookOpenCheck size={18} />} onClick={() => setDialog('start')} disabled={!online} aria-describedby={online ? undefined : 'publication-start-offline'}>
              ابدأ الدراسة بهذا الشرح
            </Button>
            {!online && (
              <p id="publication-start-offline" className="pb-meta" role="status">
                أنت غير متصل: نسخ الشرح إلى مكتبتك يحتاج الخادم مرة واحدة.
              </p>
            )}
          </>
        ) : null}
        {isAuthor && active && authorSource && (
          <Button variant="secondary" icon={<Send size={18} />} onClick={() => setDialog('republish')} disabled={!online}>
            انشر إصدارًا جديدًا
          </Button>
        )}
        {isAuthor && pub.status !== 'withdrawn' && pub.status !== 'author_deleted' && (
          <>
            <Button variant="secondary" icon={<PenLine size={18} />} onClick={() => setDialog('edit')} disabled={!online}>
              عدّل العنوان والملخص
            </Button>
            <Button variant="destructive" icon={<Undo2 size={18} />} onClick={() => setDialog('withdraw')} disabled={!online}>
              اسحب الشرح
            </Button>
          </>
        )}
        {pub.viewer.can_report && (
          <Button variant="plain" icon={<Flag size={18} />} onClick={() => setDialog('report')} disabled={!online}>
            أبلغ
          </Button>
        )}
      </div>
      {isAuthor && active && !authorSource && <p className="pb-meta">نسختك من المحاضرة ليست في مكتبتك الآن؛ ابدأ دراستها لتنشر إصدارًا جديدًا من طبقاتك.</p>}
      {pending !== null && mine && (
        <div className="pb-update" role="status">
          <p className="pb-update__text">{`تحديث متاح من ${pub.author.display_name}: الإصدار ${pending}`}</p>
          <Button size="sm" icon={<RefreshCw size={16} />} onClick={() => setDialog('update')} disabled={!online}>
            اعرض التغييرات
          </Button>
        </div>
      )}

      <section aria-labelledby="publication-versions">
        <h2 id="publication-versions" className="pb-page__h2">
          الإصدارات
        </h2>
        <ul className="pb-versions">
          {[...pub.versions].reverse().map((v) => (
            <li key={v.no}>
              <span>{`الإصدار ${v.no}`}</span>
              <span>{formatDate(v.created_at)}</span>
              <span>{`مبني على الإصدار ${v.lecture_version_no} من المحاضرة`}</span>
              <span>{itemsCountAr(v.item_count)}</span>
              {v.change_note && <MixedText text={v.change_note} />}
              {v.no === pub.head_version_no && <StatusPill tone="accent">الحالي</StatusPill>}
            </li>
          ))}
        </ul>
      </section>
      {lastChange && (
        <section aria-labelledby="publication-last-change">
          <h2 id="publication-last-change" className="pb-page__h2">
            {`ما الذي تغيّر في الإصدار ${lastChange.to_version_no}`}
          </h2>
          <p className="cp-sheet__line">{lastChange.summary_ar}</p>
        </section>
      )}
      <section aria-labelledby="publication-previews">
        <h2 id="publication-previews" className="pb-page__h2">
          معاينة الصفحات
        </h2>
        {previews === null ? (
          <LoadingState inline stage="جارٍ تحميل المعاينة…" />
        ) : previews.length === 0 ? (
          <p className="pb-meta">لا توجد معاينة لهذا الإصدار.</p>
        ) : (
          <ul className="pb-previews">
            {previews.map((p) => (
              <PagePreviewFrame key={p.pageId} spaceId={pub.space_id} pageId={p.pageId} paths={p.paths} boxes={p.boxes} caption={`ص ${p.pageIndex + 1} · ${itemsCountAr(p.items)}`} />
            ))}
          </ul>
        )}
      </section>

      {dialog === 'start' && (
        <StartFromExplanationDialog
          open
          onClose={() => setDialog(null)}
          personalCopy={personal}
          target={{ spaceId: pub.space_id, lectureId: pub.lecture.id, publicationId: pub.id, title: pub.title, authorName: pub.author.display_name, headVersionNo: pub.head_version_no }}
        />
      )}
      {dialog === 'report' && <ReportDialog open onClose={() => setDialog(null)} publication={pub} />}
      {dialog === 'republish' && authorSource && (
        <PublishDialog
          open
          onClose={() => setDialog(null)}
          spaceId={pub.space_id}
          lecture={pub.lecture}
          sourceId={authorSource}
          republish={{ id: pub.id, title: pub.title, headVersionNo: pub.head_version_no, layerIds: pub.viewer.source_layer_ids ?? [] }}
          onPublished={setPub}
        />
      )}
      {dialog === 'edit' && <EditDetailsDialog open onClose={() => setDialog(null)} pub={pub} onSaved={setPub} />}
      {dialog === 'update' && mine && <UpdatePreviewDialog open onClose={() => setDialog(null)} copy={mine} onApplied={setCopy} />}
      <ConfirmDialog
        open={dialog === 'withdraw'}
        title="اسحب الشرح"
        impact="يتوقف ظهور الشرح لأعضاء المادة ولا يمكن متابعته أو نسخه بعد الآن. من أخذ نسخة مستقلة تبقى له، ومن يتابعه تبقى نسخته عند آخر إصدار طبّقه ويرى فيها أنك سحبته. لا يمكن التراجع عن السحب."
        confirmLabel="اسحب الشرح"
        destructive
        onConfirm={withdraw}
        onCancel={() => setDialog(null)}
      />
    </article>
  );
}
