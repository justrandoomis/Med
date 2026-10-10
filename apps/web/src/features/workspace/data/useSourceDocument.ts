// Loads what the reader needs for one source version: detail, pages and (for fixed-page formats) the PDF.
import { useCallback, useEffect, useState } from 'react';
import type { SourceDetail, SourcePageView, SourceVersionView } from '@medlevo/shared';
import { errorMessage, isApiError } from '../../../lib/api';
import { loadPdfHandle, type PdfHandle } from '../reader/pdfDoc';
import { fetchPages, fetchSource } from './api';

/** How a version is shown: fixed PDF pages, page images, or structured text (DOCX / slide text). */
export type RenderMode = 'pdf' | 'image' | 'text' | 'unsupported';

export function renderModeFor(version: SourceVersionView): { mode: RenderMode; pdfFileId: string | null } {
  switch (version.format) {
    case 'pdf':
      return { mode: 'pdf', pdfFileId: version.display_file_id ?? version.file_id };
    case 'pptx':
      // a LibreOffice rendering keeps the slides' look; without it the reader shows the slide text
      return version.display_file_id ? { mode: 'pdf', pdfFileId: version.display_file_id } : { mode: 'text', pdfFileId: null };
    case 'docx':
      // DOCX has no fixed pages: paragraphs keep their locators (§07)
      return { mode: 'text', pdfFileId: null };
    case 'image':
    case 'image_set':
      return { mode: 'image', pdfFileId: null };
    default:
      return { mode: 'unsupported', pdfFileId: null };
  }
}

export interface SourceDocument {
  detail: SourceDetail;
  version: SourceVersionView;
  pages: SourcePageView[];
  mode: RenderMode;
  pdf: PdfHandle | null;
  /** the PDF could not be opened (pages and metadata still are) */
  pdfError: string | null;
}

export type DocumentState =
  | { status: 'loading'; stage: string }
  | { status: 'error'; message: string; offline: boolean; notFound: boolean }
  | { status: 'ready'; doc: SourceDocument };

export function activeVersionId(d: Pick<SourceDetail, 'active_version_id' | 'frozen_version_id' | 'current_version_id' | 'versions'>): string | null {
  return d.active_version_id ?? d.frozen_version_id ?? d.current_version_id ?? d.versions[d.versions.length - 1]?.id ?? null;
}

function describeLoadError(e: unknown): { message: string; offline: boolean; notFound: boolean } {
  const offline = isApiError(e) && e.offline;
  const notFound = isApiError(e) && e.status === 404;
  return {
    offline,
    notFound,
    message: notFound
      ? 'هذا المصدر غير موجود، ربما حُذف نهائيًا أو نُقل إلى سلة المحذوفات.'
      : offline
        ? 'لا يوجد اتصال، وهذا المصدر غير محمّل على هذا الجهاز للقراءة دون اتصال.'
        : errorMessage(e, 'تعذّر فتح المصدر.'),
  };
}

export type DetailState = { status: 'loading' } | { status: 'error'; message: string; offline: boolean; notFound: boolean } | { status: 'ready'; detail: SourceDetail };

/** Source metadata (versions, links, library path). */
export function useSourceDetail(sourceId: string): { state: DetailState; retry: () => void } {
  const [state, setState] = useState<DetailState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  useEffect(() => {
    const ctrl = new AbortController();
    let cancelled = false;
    setState({ status: 'loading' });
    fetchSource(sourceId, ctrl.signal)
      .then((detail) => !cancelled && setState({ status: 'ready', detail }))
      .catch((e: unknown) => {
        if (cancelled || ctrl.signal.aborted) return;
        setState({ status: 'error', ...describeLoadError(e) });
      });
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [sourceId, attempt]);
  return { state, retry };
}

/** Pages (and the PDF, for fixed-page formats) of one version of a loaded source. */
export function useVersionDocument(detail: SourceDetail | null, versionId: string | null): { state: DocumentState; retry: () => void } {
  const [state, setState] = useState<DocumentState>({ status: 'loading', stage: 'جارٍ تحميل الصفحات…' });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    if (!detail || !versionId) return;
    const ctrl = new AbortController();
    let pdf: PdfHandle | null = null;
    let cancelled = false;
    setState({ status: 'loading', stage: 'جارٍ تحميل الصفحات…' });
    (async () => {
      try {
        const version = detail.versions.find((v) => v.id === versionId);
        if (!version) {
          setState({ status: 'error', message: 'لا يوجد إصدار قابل للعرض لهذا المصدر بعد. ارفع الملف أو انتظر انتهاء المعالجة.', offline: false, notFound: false });
          return;
        }
        const { pages } = await fetchPages(detail.id, version.id, ctrl.signal);
        const { mode, pdfFileId } = renderModeFor(version);
        let pdfError: string | null = null;
        if (mode === 'pdf' && pdfFileId) {
          if (!cancelled) setState({ status: 'loading', stage: 'جارٍ فتح ملف PDF…' });
          try {
            pdf = await loadPdfHandle(pdfFileId);
          } catch (e) {
            pdfError = isApiError(e) && e.offline ? 'ملف هذا المصدر غير محمّل على هذا الجهاز ولا يوجد اتصال.' : 'تعذّر فتح ملف PDF. قد يكون الملف تالفًا أو غير متاح حاليًا.';
          }
        } else if (mode === 'pdf') {
          pdfError = 'لا يوجد ملف قابل للعرض لهذا الإصدار.';
        }
        if (cancelled) {
          pdf?.destroy();
          return;
        }
        const sorted = [...pages].sort((a, b) => a.page_index - b.page_index);
        setState({ status: 'ready', doc: { detail, version, pages: sorted, mode, pdf, pdfError } });
      } catch (e) {
        if (cancelled || ctrl.signal.aborted) return;
        setState({ status: 'error', ...describeLoadError(e) });
      }
    })();
    return () => {
      cancelled = true;
      ctrl.abort();
      pdf?.destroy();
    };
  }, [detail, versionId, attempt]);

  return { state, retry };
}

/** Detail + the given version (null → the active version): used by the Split Study pane. */
export function useSourceDocument(sourceId: string, versionId: string | null): { state: DocumentState; retry: () => void } {
  const { state: d, retry: retryDetail } = useSourceDetail(sourceId);
  const detail = d.status === 'ready' ? d.detail : null;
  const vid = detail ? (versionId && detail.versions.some((v) => v.id === versionId) ? versionId : activeVersionId(detail)) : null;
  const { state: v, retry: retryVersion } = useVersionDocument(detail, vid);
  const retry = useCallback(() => {
    retryDetail();
    retryVersion();
  }, [retryDetail, retryVersion]);
  if (d.status === 'loading') return { state: { status: 'loading', stage: 'جارٍ فتح المصدر…' }, retry };
  if (d.status === 'error') return { state: d, retry };
  if (!vid) return { state: { status: 'error', message: 'لا يوجد إصدار قابل للعرض لهذا المصدر بعد.', offline: false, notFound: false }, retry };
  return { state: v, retry };
}
