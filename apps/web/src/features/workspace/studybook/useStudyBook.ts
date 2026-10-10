// Study Book state for a source: the default version (frozen > published > in progress), whether a new one can
// be generated (and why not), and polling while a generation job runs (real section counts, never a %).
//
// Offline (or when the server cannot be reached) the book is read from the copy the Download Manager stored on this
// device (lib/offline.ts → IndexedDB `apiCache`, the server's own GET answers). When this source — or this version of
// its Study Book — was not downloaded, the hook says so plainly; it never shows something else instead.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { StudyBookStatusResponse, StudyBookView } from '@medlevo/shared';
import { ApiError, errorMessage } from '../../../lib/api';
import { readOfflineAnswer } from '../../../lib/offline';
import { studybookApi } from '../../studybook/api';

export interface StudyBookState {
  status: 'loading' | 'ready' | 'error' | 'offline';
  data: StudyBookStatusResponse | null;
  /** a specific version the owner opened (else the default one) */
  book: StudyBookView | null;
  error: string | null;
  /** set when the view comes from the copy downloaded on this device (no connection to the server) */
  offlineCopy: { storedAt: number; notice: string | null } | null;
  /** why nothing can be shown offline (not downloaded / another version of the source) */
  offlineReason: string | null;
}

const POLL_MS = 2500;

export const STUDY_BOOK_OFFLINE_AR = 'كتاب الدراسة يُقرأ من الخادم؛ لا يوجد اتصال الآن.';
export const STUDY_BOOK_NOT_DOWNLOADED_AR = 'كتاب الدراسة غير محمّل على هذا الجهاز. نزّل هذه المحاضرة من «بياناتك» وأنت متصل لتقرأه دون اتصال، أو انتظر عودة الاتصال.';
export const STUDY_BOOK_OTHER_VERSION_AR = 'كتاب الدراسة المتاح لهذا المصدر مبني على إصدار آخر، فلم يُنزَّل مع هذا الإصدار. يظهر عند عودة الاتصال.';
export const STUDY_BOOK_VERSION_NOT_DOWNLOADED_AR = 'هذه النسخة من كتاب الدراسة غير محمّلة على هذا الجهاز؛ تُعرض النسخة المحمّلة.';
/** generation and every other change need the server */
export const STUDY_BOOK_NEEDS_CONNECTION_AR = 'يحتاج التوليد اتصالًا بالخادم.';

export const statusPath = (sourceId: string) => `/api/studybook/books?source_id=${encodeURIComponent(sourceId)}`;
export const bookPath = (artifactId: string) => `/api/studybook/books/${encodeURIComponent(artifactId)}`;

export type DownloadedStudyBook =
  | { kind: 'not_downloaded'; reason: string }
  | { kind: 'ready'; data: StudyBookStatusResponse; book: StudyBookView | null; storedAt: number; notice: string | null };

/**
 * The Study Book of a source as stored by the Download Manager. The status answer is always part of a download; the
 * book itself only when it was built on the downloaded version (data/offline.ts) — otherwise it is NOT shown.
 */
export async function readDownloadedStudyBook(sourceId: string, openedId: string | null = null): Promise<DownloadedStudyBook> {
  const status = await readOfflineAnswer<StudyBookStatusResponse>(statusPath(sourceId));
  if (!status) return { kind: 'not_downloaded', reason: STUDY_BOOK_NOT_DOWNLOADED_AR };
  // nothing can be generated or changed without the server
  const data: StudyBookStatusResponse = { ...status.value, can_generate: { available: false, reason_ar: STUDY_BOOK_NEEDS_CONNECTION_AR } };
  const defaultId = status.value.book?.artifact.id ?? null;
  if (!defaultId) return { kind: 'ready', data, book: null, storedAt: status.storedAt, notice: null };
  const full = await readOfflineAnswer<StudyBookView>(bookPath(defaultId));
  if (!full) return { kind: 'not_downloaded', reason: STUDY_BOOK_OTHER_VERSION_AR };
  if (openedId && openedId !== defaultId) {
    const opened = await readOfflineAnswer<StudyBookView>(bookPath(openedId));
    if (opened) return { kind: 'ready', data, book: opened.value, storedAt: opened.storedAt, notice: null };
    return { kind: 'ready', data, book: full.value, storedAt: full.storedAt, notice: STUDY_BOOK_VERSION_NOT_DOWNLOADED_AR };
  }
  return { kind: 'ready', data, book: full.value, storedAt: full.storedAt, notice: null };
}

const unreachable = (e: unknown) => e instanceof ApiError && e.offline;

export function useStudyBook(sourceId: string, online: boolean) {
  const [state, setState] = useState<StudyBookState>({ status: 'loading', data: null, book: null, error: null, offlineCopy: null, offlineReason: null });
  const [openedId, setOpenedId] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadDownloaded = useCallback(async () => {
    const r = await readDownloadedStudyBook(sourceId, openedId);
    if (r.kind === 'not_downloaded') {
      setState({ status: 'offline', data: null, book: null, error: null, offlineCopy: null, offlineReason: r.reason });
      return;
    }
    setState({ status: 'ready', data: r.data, book: r.book, error: null, offlineCopy: { storedAt: r.storedAt, notice: r.notice }, offlineReason: null });
  }, [sourceId, openedId]);

  const load = useCallback(async () => {
    if (!online) {
      await loadDownloaded();
      return;
    }
    try {
      const data = await studybookApi.bookForSource(sourceId);
      const book = openedId && openedId !== data.book?.artifact.id ? await studybookApi.book(openedId) : data.book;
      setState({ status: 'ready', data, book, error: null, offlineCopy: null, offlineReason: null });
    } catch (e) {
      // the browser says online but the server cannot be reached: the downloaded copy, when there is one
      if (unreachable(e)) {
        const r = await readDownloadedStudyBook(sourceId, openedId);
        if (r.kind === 'ready') {
          setState({ status: 'ready', data: r.data, book: r.book, error: null, offlineCopy: { storedAt: r.storedAt, notice: r.notice }, offlineReason: null });
          return;
        }
      }
      setState((s) => ({ ...s, status: s.data ? 'ready' : 'error', error: errorMessage(e, 'تعذّر تحميل كتاب الدراسة.') }));
    }
  }, [sourceId, online, openedId, loadDownloaded]);

  useEffect(() => {
    void load();
  }, [load]);

  // poll while generating (the job's real progress) — only against the server, never the stored copy
  const generating = state.book?.artifact.status === 'generating' && !state.offlineCopy;
  useEffect(() => {
    if (!generating || !online) return;
    timer.current = setTimeout(() => void load(), POLL_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [generating, online, load, state.book]);

  return {
    ...state,
    reload: load,
    openVersion: (id: string | null) => setOpenedId(id),
    /** replace the current view after an action (create / resume / freeze …) */
    setBook: (book: StudyBookView) => setState((s) => ({ ...s, book, status: 'ready', offlineCopy: null })),
  };
}

/**
 * Whether the «كتاب الدراسة» view can be opened for a source: a version exists (readable without AI), or one can
 * be generated now. Otherwise the server's own reason (e.g. AI not configured, source not processed) is returned.
 * Offline, a book downloaded on this device can be opened; otherwise the reason says it is not downloaded.
 */
export function useStudyBookAvailability(sourceId: string, online: boolean): { reason: string | null; hasBook: boolean; refresh: () => void } {
  const [state, setState] = useState<{ reason: string | null; hasBook: boolean }>({ reason: online ? 'جارٍ التحقق من كتاب الدراسة…' : STUDY_BOOK_OFFLINE_AR, hasBook: false });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const fromDownload = async (fallback: string | null) => {
      const r = await readDownloadedStudyBook(sourceId);
      if (cancelled) return;
      if (r.kind === 'ready' && r.book) setState({ hasBook: true, reason: null });
      else if (r.kind === 'ready') setState({ hasBook: false, reason: 'لم يكن لهذه المحاضرة كتاب دراسة عند تنزيلها، والتوليد يحتاج اتصالًا بالخادم.' });
      else setState({ hasBook: false, reason: fallback ?? r.reason });
    };
    if (!online) {
      void fromDownload(null);
      return () => {
        cancelled = true;
      };
    }
    studybookApi
      .bookForSource(sourceId)
      .then((r) => {
        if (cancelled) return;
        const hasBook = !!r.book;
        setState({ hasBook, reason: hasBook || r.can_generate.available ? null : (r.can_generate.reason_ar ?? 'لا يمكن إنشاء كتاب الدراسة الآن.') });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        if (unreachable(e)) void fromDownload(null);
        else setState({ hasBook: false, reason: errorMessage(e, 'تعذّر التحقق من كتاب الدراسة.') });
      });
    return () => {
      cancelled = true;
    };
  }, [sourceId, online, tick]);
  return { ...state, refresh: () => setTick((n) => n + 1) };
}
