import { useEffect, useRef } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { UpdateBanner } from '../features/offline/UpdateBanner';
import { setClientTooOldHandler } from '../lib/api';
import { onStorageAccountChange } from '../lib/userStorage';

/**
 * Prompt-based PWA update (never auto-reloads: the owner might be writing). The new version is activated only
 * when the owner presses «تحديث الآن»; local writing is in IndexedDB and survives the reload either way.
 *
 * Track D1: mounted once in the ROOT layout (layouts.tsx), so the service worker is registered and the prompt is
 * shown on every route — the shell, the study workspace (/study/…) and the sign-in screens. When writes are still
 * waiting for the server, the banner says so and asks for confirmation before reloading (nothing is lost either
 * way: unsynced writes stay in IndexedDB and are sent after the reload). The banner itself is
 * features/offline/UpdateBanner.tsx (testable without the virtual PWA module).
 *
 * P1-T1 step 3 (ADR-0003 §3.7): two moments apply a waiting update without the button — when the server answers
 * 426 CLIENT_TOO_OLD (this build is older than the server accepts: check for the new one and take it), and when
 * another account signs in on this page (nobody is writing at a sign-in; the new account starts on the newest build).
 */
export function PwaUpdatePrompt() {
  const registration = useRef<ServiceWorkerRegistration | null>(null);
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    offlineReady: [offlineReady, setOfflineReady],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, r) {
      registration.current = r ?? null;
    },
    onRegisterError() {
      // registration failure only means no offline shell; the app keeps working online
    },
  });
  const waiting = useRef(needRefresh);
  useEffect(() => {
    waiting.current = needRefresh;
  }, [needRefresh]);
  useEffect(() => {
    setClientTooOldHandler(() => {
      if (waiting.current) void updateServiceWorker(true);
      else void registration.current?.update().catch(() => undefined);
    });
    const off = onStorageAccountChange((account, previous) => {
      if (account && previous && account.userId !== previous.userId && waiting.current) void updateServiceWorker(true);
    });
    return () => {
      setClientTooOldHandler(null);
      off();
    };
  }, [updateServiceWorker]);
  return (
    <UpdateBanner
      needRefresh={needRefresh}
      offlineReady={offlineReady}
      onUpdate={() => void updateServiceWorker(true)}
      onDismiss={() => {
        setNeedRefresh(false);
        setOfflineReady(false);
      }}
    />
  );
}
