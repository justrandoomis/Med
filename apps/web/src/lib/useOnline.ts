import { useSyncExternalStore } from 'react';

function subscribe(cb: () => void): () => void {
  window.addEventListener('online', cb);
  window.addEventListener('offline', cb);
  return () => {
    window.removeEventListener('online', cb);
    window.removeEventListener('offline', cb);
  };
}

const getSnapshot = () => (typeof navigator === 'undefined' ? true : navigator.onLine !== false);

/**
 * Browser connectivity (navigator.onLine + online/offline events). `true` only means a network
 * exists, not that the server is reachable — API calls still report unreachable servers as
 * ApiError({ offline: true }).
 */
export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => true);
}
