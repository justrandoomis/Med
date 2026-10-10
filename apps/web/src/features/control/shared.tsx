// Small shared pieces of the Control Center: the section header (with a way back on phones), an async loader
// hook with honest error states, and the overview context the layout provides to every section.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import type { ControlOverviewResponse } from '@medlevo/shared';
import { isApiError, errorMessage } from '../../lib/api';
import { usePageTitle } from '../../lib/usePageTitle';

export interface ControlOutletContext {
  overview: ControlOverviewResponse | null;
  reloadOverview: () => void;
}

const NO_CONTEXT: ControlOutletContext = { overview: null, reloadOverview: () => undefined };

/** Overview context from the layout (a no-op default when a section is rendered on its own, e.g. in tests). */
export function useControlContext(): ControlOutletContext {
  return useOutletContext<ControlOutletContext | undefined>() ?? NO_CONTEXT;
}

export function SectionHeader({ title, lede, actions }: { title: string; lede?: ReactNode; actions?: ReactNode }) {
  usePageTitle(title);
  return (
    <header className="cc-head">
      <Link to="/control" className="cc-back">
        <ChevronRight size={18} aria-hidden="true" />
        <span>مركز التحكم</span>
      </Link>
      <div className="cc-head__row">
        <h1 className="ml-page__title cc-head__title">{title}</h1>
        {actions && <div className="cc-head__actions">{actions}</div>}
      </div>
      {lede && <p className="cc-head__lede">{lede}</p>}
    </header>
  );
}

export interface Loaded<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
  setData: (d: T) => void;
}

/** Loads on mount and on `deps` change; offline / server errors become one honest Arabic sentence. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[], offlineMessage = 'هذا القسم يقرأ من الخادم؛ لا يوجد اتصال الآن.'): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fnRef
      .current()
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e) => {
        if (!cancelled) setError(isApiError(e) && e.offline ? offlineMessage : errorMessage(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload, setData };
}
