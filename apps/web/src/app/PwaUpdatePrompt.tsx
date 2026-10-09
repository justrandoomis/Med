import { useRegisterSW } from 'virtual:pwa-register/react';
import { RefreshCw, X } from 'lucide-react';
import { Button, IconButton } from '../design';

/**
 * Prompt-based PWA update (never auto-reloads: the owner might be writing). The new version is
 * activated only when the owner presses «تحديث الآن»; local writing is in IndexedDB and survives
 * the reload either way.
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

  if (!needRefresh && !offlineReady) return null;
  return (
    <div className="ml-update-banner ml-no-print" role="status" aria-live="polite">
      <div className="ml-update-banner__text">
        {needRefresh ? (
          <>
            <strong>يتوفر إصدار أحدث من MedLevo.</strong>
            <span>حدّث عندما تنتهي من الكتابة؛ ما كتبته محفوظ على هذا الجهاز.</span>
          </>
        ) : (
          <>
            <strong>أصبح التطبيق جاهزًا للعمل دون اتصال.</strong>
            <span>المحتوى نفسه يُحمَّل للعمل دون اتصال من مدير التنزيلات.</span>
          </>
        )}
      </div>
      <div className="ml-update-banner__actions">
        {needRefresh && (
          <Button size="sm" variant="primary" icon={<RefreshCw size={16} />} onClick={() => void updateServiceWorker(true)}>
            تحديث الآن
          </Button>
        )}
        <IconButton
          size="sm"
          label={needRefresh ? 'لاحقًا' : 'إغلاق'}
          icon={<X size={18} />}
          onClick={() => {
            setNeedRefresh(false);
            setOfflineReady(false);
          }}
        />
      </div>
    </div>
  );
}
