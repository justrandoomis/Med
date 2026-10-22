// «اعرض التغييرات» → «طبّق التحديث» (P1-T5 step 3; PRD Scenario 2, AOS-4.14, Q25; ARCHITECTURE_DELTA §6.4). What a
// new version of a followed explanation would change — «أضاف 6 عناصر في صفحة واحدة، حذف 1، عدّل 1» with the pages —
// read from the server BEFORE anything changes. Applying writes the followed layer only; the viewer's own notes are
// never part of it (the server says so with `personal_items_affected: 0`, shown here). A version can be skipped; the
// copy then stays as it is.
import { useEffect, useState } from 'react';
import { RefreshCw, SkipForward } from 'lucide-react';
import type { DocumentCopyView, UpstreamPreview } from '@medlevo/shared';
import { Button, Dialog, LoadingState, useToast } from '../../design';
import { ApiError, errorMessage } from '../../lib/api';
import { useOnline } from '../../lib/useOnline';
import { publicationsApi } from '../lectures/api';
import { marksCaptionAr, PagePreviewFrame } from '../lectures/PagePreviewFrame';
import { changeMarks, pagePreviews, type ChangeMark, type PagePreview } from '../lectures/publicationPreview';
import { copiesApi, pullCopyChanges } from './api';
import './copies.css';
import '../lectures/publications.css';

/** at most this many changed pages are drawn (the list names every page) */
const DRAWN_PAGES = 4;

interface DrawnPage {
  pageId: string;
  label: string;
  view: PagePreview | null;
  marks: ChangeMark[];
}

/** The changed pages drawn with the marks of what changes (read from the publication's two versions). */
async function drawPages(spaceId: string, preview: UpstreamPreview): Promise<DrawnPage[]> {
  const pages = preview.pages.filter((p) => p.page.thumbnail).slice(0, DRAWN_PAGES);
  return Promise.all(
    pages.map(async (p) => {
      const [from, to] = await Promise.all([
        publicationsApi.items(spaceId, preview.publication_id, preview.from_version_no, p.page.page_id),
        publicationsApi.items(spaceId, preview.publication_id, preview.to_version_no, p.page.page_id),
      ]);
      return { pageId: p.page.page_id, label: p.page.label_ar, view: pagePreviews(to.items)[0] ?? null, marks: changeMarks(from.items, to.items) };
    }),
  );
}

function pageLine(p: UpstreamPreview['pages'][number]): string {
  const parts: string[] = [];
  if (p.added) parts.push(`أُضيف ${p.added}`);
  if (p.removed) parts.push(`حُذف ${p.removed}`);
  if (p.changed) parts.push(`عُدّل ${p.changed}`);
  return `${p.page.label_ar}: ${parts.join('، ')}`;
}

export function UpdatePreviewDialog({ open, onClose, copy, onApplied }: { open: boolean; onClose: () => void; copy: DocumentCopyView; onApplied?: (copy: DocumentCopyView) => void }) {
  const online = useOnline();
  const toast = useToast();
  const pub = copy.publication!;
  const [preview, setPreview] = useState<UpstreamPreview | null>(null);
  const [drawn, setDrawn] = useState<DrawnPage[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState<'apply' | 'skip' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    copiesApi
      .upstream(copy.id)
      .then((p) => {
        if (cancelled) return;
        setPreview(p);
        // the pictures are an addition: the counts and the page list above already say everything
        drawPages(pub.space_id, p)
          .then((d) => !cancelled && setDrawn(d))
          .catch(() => !cancelled && setDrawn([]));
      })
      .catch((e) => !cancelled && setLoadError(errorMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [copy.id, attempt, pub.space_id]);

  const run = async (skip: boolean) => {
    if (!preview) return;
    setBusy(skip ? 'skip' : 'apply');
    setError(null);
    try {
      const res = await copiesApi.applyUpstream(copy.id, skip ? { version_no: preview.to_version_no, skip: true } : { version_no: preview.to_version_no });
      if (!res.skipped) pullCopyChanges();
      toast.show(
        res.skipped
          ? { tone: 'info', title: `تخطّيت الإصدار ${preview.to_version_no}؛ بقيت نسختك كما هي.` }
          : { tone: 'success', title: `طُبّق الإصدار ${preview.to_version_no} من الشرح.`, description: 'لم يتغير شيء من ملاحظاتك الشخصية.' },
      );
      onApplied?.(res.copy);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      // the author published again meanwhile (409): show the newer change before anything is applied
      if (e instanceof ApiError && e.status === 409) {
        setPreview(null);
        setAttempt((n) => n + 1);
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissible={busy === null}
      size="md"
      title="تحديث الشرح"
      description={preview ? `«${pub.title}» — من الإصدار ${preview.from_version_no} إلى الإصدار ${preview.to_version_no}` : `«${pub.title}»`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy !== null}>
            إلغاء
          </Button>
          <Button variant="secondary" icon={<SkipForward size={18} />} onClick={() => void run(true)} loading={busy === 'skip'} disabled={!online || !preview || busy !== null}>
            تخطَّ هذا الإصدار
          </Button>
          <Button icon={<RefreshCw size={18} />} onClick={() => void run(false)} loading={busy === 'apply'} disabled={!online || !preview || busy !== null}>
            طبّق التحديث
          </Button>
        </>
      }
    >
      <div className="cp-sheet">
        {loadError ? (
          <p className="cp-sheet__error" role="alert">
            {loadError}
          </p>
        ) : !preview ? (
          <LoadingState stage="جارٍ تجهيز المعاينة…" />
        ) : (
          <>
            <p className="cp-sheet__line">
              <strong>{`${pub.author.display_name}: ${preview.summary_ar}`}</strong>
            </p>
            {preview.change_note && <p className="cp-sheet__line">{`ملاحظة الكاتب: ${preview.change_note}`}</p>}
            {preview.pages.length > 0 && (
              <ul className="pb-versions" aria-label="الصفحات التي تتغير">
                {preview.pages.map((p) => (
                  <li key={p.page.page_id}>{pageLine(p)}</li>
                ))}
              </ul>
            )}
            {drawn.length > 0 && (
              <ul className="pb-previews" aria-label="التغييرات على الصفحات">
                {drawn.map((d) => (
                  <PagePreviewFrame key={d.pageId} spaceId={pub.space_id} pageId={d.pageId} paths={d.view?.paths ?? []} boxes={d.view?.boxes ?? []} marks={d.marks} caption={`${d.label}: ${marksCaptionAr(d.marks)}`} />
                ))}
              </ul>
            )}
            <p className="pb-banner" role="note">
              ملاحظاتك الشخصية: لا يتغيّر منها أي عنصر. التحديث يخص طبقة الشرح المتابَع وحدها.
            </p>
          </>
        )}
        {!online && (
          <p className="cp-sheet__line cp-sheet__line--muted" role="status">
            أنت غير متصل: تطبيق التحديث يحتاج الخادم.
          </p>
        )}
        {error && (
          <p className="cp-sheet__error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
