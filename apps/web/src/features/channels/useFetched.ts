// One server read keyed by what it reads (P1-T4 step 3): loading is derived from the key (no synchronous setState in an
// effect), a different key never shows another key's answer, `reload()` asks again while the current answer stays on
// screen (no flash of «loading» after every decision), `update()` edits the shown copy after a change the viewer made.
// Used by the account and administration screens.
import { useCallback, useEffect, useState } from 'react';
import { errorMessage } from '../../lib/api';

export interface Fetched<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
  update: (fn: (d: T) => T) => void;
}

export function useFetched<T>(key: string | null, fetcher: () => Promise<T>): Fetched<T> {
  const [nonce, setNonce] = useState(0);
  const k = key === null ? null : `${key}#${nonce}`;
  const [state, setState] = useState<{ k: string | null; base: string | null; data: T | null; error: string | null }>({ k: null, base: null, data: null, error: null });
  useEffect(() => {
    if (k === null) return;
    let alive = true;
    fetcher()
      .then((data) => alive && setState({ k, base: key, data, error: null }))
      .catch((e) => alive && setState({ k, base: key, data: null, error: errorMessage(e) }));
    return () => {
      alive = false;
    };
    // the fetcher is recreated every render; the key names what it reads
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [k]);
  const current = k !== null && state.k === k;
  const sameRead = key !== null && state.base === key;
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const update = useCallback((fn: (d: T) => T) => setState((s) => (s.data === null ? s : { ...s, data: fn(s.data) })), []);
  return { data: sameRead ? state.data : null, error: current ? state.error : null, loading: k !== null && !current, reload, update };
}
