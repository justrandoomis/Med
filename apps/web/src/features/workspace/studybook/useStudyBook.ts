// Study Book state for a source: the default version (frozen > published > in progress), whether a new one can
// be generated (and why not), and polling while a generation job runs (real section counts, never a %).
import { useCallback, useEffect, useRef, useState } from 'react';
import type { StudyBookStatusResponse, StudyBookView } from '@medlevo/shared';
import { errorMessage } from '../../../lib/api';
import { studybookApi } from '../../studybook/api';

export interface StudyBookState {
  status: 'loading' | 'ready' | 'error' | 'offline';
  data: StudyBookStatusResponse | null;
  /** a specific version the owner opened (else the default one) */
  book: StudyBookView | null;
  error: string | null;
}

const POLL_MS = 2500;

export function useStudyBook(sourceId: string, online: boolean) {
  const [state, setState] = useState<StudyBookState>({ status: online ? 'loading' : 'offline', data: null, book: null, error: null });
  const [openedId, setOpenedId] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    if (!online) {
      setState((s) => ({ ...s, status: s.data ? 'ready' : 'offline' }));
      return;
    }
    try {
      const data = await studybookApi.bookForSource(sourceId);
      const book = openedId && openedId !== data.book?.artifact.id ? await studybookApi.book(openedId) : data.book;
      setState({ status: 'ready', data, book, error: null });
    } catch (e) {
      setState((s) => ({ ...s, status: s.data ? 'ready' : 'error', error: errorMessage(e, 'تعذّر تحميل كتاب الدراسة.') }));
    }
  }, [sourceId, online, openedId]);

  useEffect(() => {
    void load();
  }, [load]);

  // poll while generating (the job's real progress)
  const generating = state.book?.artifact.status === 'generating';
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
    setBook: (book: StudyBookView) => setState((s) => ({ ...s, book, status: 'ready' })),
  };
}
