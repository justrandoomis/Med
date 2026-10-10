import { useRegisterSW } from 'virtual:pwa-register/react';
import { UpdateBanner } from '../features/offline/UpdateBanner';

/**
 * Prompt-based PWA update (never auto-reloads: the owner might be writing). The new version is activated only
 * when the owner presses «تحديث الآن»; local writing is in IndexedDB and survives the reload either way.
 *
 * Track D1: mounted once in the ROOT layout (layouts.tsx), so the service worker is registered and the prompt is
 * shown on every route — the shell, the study workspace (/study/…) and the sign-in screens. When writes are still
 * waiting for the server, the banner says so and asks for confirmation before reloading (nothing is lost either
 * way: unsynced writes stay in IndexedDB and are sent after the reload). The banner itself is
 * features/offline/UpdateBanner.tsx (testable without the virtual PWA module).
 */
export function PwaUpdatePrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    offlineReady: [offlineReady, setOfflineReady],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisterError() {
      // registration failure only means no offline shell; the app keeps working online
    },
  });
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
