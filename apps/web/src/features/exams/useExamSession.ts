// The runner's session: server delivery payload (cached for offline), the resumable local state (IndexedDB first,
// outbox upsert with the full state), the active-time clock (paused / hidden tab → no time counted) and periodic
// autosave. A reload or crash resumes from IndexedDB; nothing the owner answered is lost.
import { useCallback, useEffect, useRef, useState } from 'react';
import { newId, type ExamSessionView } from '@medlevo/shared';
import { isApiError } from '../../lib/api';
import { getDb } from '../../lib/localdb';
import { getSyncEngine } from '../../lib/sync';
import { examsApi } from './api';
import { cacheSession, cachedSession, registerExamAppliers, resumeState, saveState } from './local';
import { tick, type LocalExamState } from './model';

export type SessionStatus = 'loading' | 'ready' | 'error';

const AUTOSAVE_MS = 5_000;

export interface ExamSessionApi {
  status: SessionStatus;
  error: string | null;
  session: ExamSessionView | null;
  state: LocalExamState | null;
  /** served from this device's copy because the server was not reachable */
  offline: boolean;
  /** apply a change; `persist` writes IndexedDB + outbox now (answers, flags, pause, finish do) */
  update: (fn: (s: LocalExamState) => LocalExamState, opts?: { persist?: boolean }) => Promise<LocalExamState | null>;
  persistNow: () => Promise<void>;
  reload: () => void;
  newClientId: () => string;
}

export function useExamSession(attemptId: string, opts: { clock?: () => number; tickMs?: number } = {}): ExamSessionApi {
  const clock = opts.clock ?? Date.now;
  const [status, setStatus] = useState<SessionStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<ExamSessionView | null>(null);
  const [state, setState] = useState<LocalExamState | null>(null);
  const [offline, setOffline] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const stateRef = useRef<LocalExamState | null>(null);
  const sessionRef = useRef<ExamSessionView | null>(null);
  const dirty = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setStatus('loading');
      setError(null);
      const db = getDb();
      try {
        registerExamAppliers(getSyncEngine());
      } catch {
        // tests / environments without a sync engine
      }
      let s: ExamSessionView | null = null;
      let fromCache = false;
      try {
        s = await examsApi.session(attemptId);
        await cacheSession(db, s);
      } catch (e) {
        if (isApiError(e) && (e.offline || e.status >= 500)) {
          s = await cachedSession(db, attemptId);
          fromCache = true;
          if (!s) {
            if (!cancelled) {
              setError('هذا الاختبار غير محفوظ على هذا الجهاز بعد، والخادم غير متاح الآن. افتحه مرة وأنت متصل، ثم يمكنك إكماله دون اتصال.');
              setStatus('error');
            }
            return;
          }
        } else {
          if (!cancelled) {
            setError(isApiError(e) ? e.message : 'تعذّر فتح الاختبار.');
            setStatus('error');
          }
          return;
        }
      }
      const st = await resumeState(db, s);
      if (cancelled) return;
      sessionRef.current = s;
      stateRef.current = st;
      setSession(s);
      setState(st);
      setOffline(fromCache);
      setStatus('ready');
    })();
    return () => {
      cancelled = true;
    };
  }, [attemptId, reloadKey]);

  const persistNow = useCallback(async () => {
    const s = sessionRef.current;
    const st = stateRef.current;
    if (!s || !st) return;
    dirty.current = false;
    await saveState(getDb(), { attemptId: s.attempt.id, examId: s.exam.id, startedAt: s.attempt.started_at }, st, clock());
  }, [clock]);

  const update = useCallback(
    async (fn: (s: LocalExamState) => LocalExamState, o: { persist?: boolean } = {}) => {
      const cur = stateRef.current;
      if (!cur) return null;
      const next = fn(cur);
      if (next === cur) return cur;
      stateRef.current = next;
      setState(next);
      dirty.current = true;
      if (o.persist) await persistNow();
      return next;
    },
    [persistNow],
  );

  // active-time clock: counts only while in progress and the page is visible
  useEffect(() => {
    if (status !== 'ready') return;
    let last = performance.now();
    let lastSave = performance.now();
    const id = setInterval(() => {
      const now = performance.now();
      const delta = now - last;
      last = now;
      const visible = typeof document === 'undefined' || document.visibilityState !== 'hidden';
      const cur = stateRef.current;
      if (!cur || cur.status !== 'in_progress' || !visible) return;
      const next = tick(cur, Math.min(delta, 5_000));
      stateRef.current = next;
      setState(next);
      dirty.current = true;
      if (now - lastSave >= AUTOSAVE_MS) {
        lastSave = now;
        void persistNow();
      }
    }, opts.tickMs ?? 1000);
    const flush = () => {
      if (dirty.current) void persistNow();
    };
    document.addEventListener('visibilitychange', flush);
    window.addEventListener('pagehide', flush);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', flush);
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, [status, persistNow, opts.tickMs]);

  return {
    status,
    error,
    session,
    state,
    offline,
    update,
    persistNow,
    reload: () => setReloadKey((k) => k + 1),
    newClientId: () => newId(clock()),
  };
}
