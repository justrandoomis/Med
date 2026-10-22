// The subject a «إدارة القنوات» section of P1-T5 works on: the viewer's subjects with an official role (from P1-T4's
// channel tree), the chosen one remembered per viewer in the URL (?subject=) so a link opens the same scope.
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { errorMessage } from '../../../lib/api';
import { type AdminSubject, loadAdminSubjects } from '../api';

export interface AdminSubjectsState {
  status: 'loading' | 'ready' | 'error';
  subjects: AdminSubject[];
  current: AdminSubject | null;
  error: string | null;
  choose(id: string): void;
  reload(): void;
}

export function useAdminSubjects(roles: readonly string[]): AdminSubjectsState {
  const [params, setParams] = useSearchParams();
  const [subjects, setSubjects] = useState<AdminSubject[]>([]);
  const [status, setStatus] = useState<AdminSubjectsState['status']>('loading');
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const rolesKey = roles.join(',');

  useEffect(() => {
    let alive = true;
    loadAdminSubjects(rolesKey.split(',').filter(Boolean))
      .then((list) => {
        if (!alive) return;
        setSubjects(list);
        setStatus('ready');
        setError(null);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setError(errorMessage(e));
        setStatus('error');
      });
    return () => {
      alive = false;
    };
  }, [rolesKey, nonce]);

  const wanted = params.get('subject');
  const current = subjects.find((s) => s.id === wanted) ?? subjects[0] ?? null;
  const choose = useCallback(
    (id: string) => {
      const next = new URLSearchParams(params);
      next.set('subject', id);
      setParams(next, { replace: true });
    },
    [params, setParams],
  );
  return {
    status,
    subjects,
    current,
    error,
    choose,
    reload: () => {
      setStatus('loading');
      setNonce((n) => n + 1);
    },
  };
}
