// The PWA update / offline-ready banner (rendered by app/PwaUpdatePrompt.tsx on every route). Never reloads by
// itself; with unsynced writes it says how many and asks before reloading — they stay in IndexedDB either way.
import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { RefreshCw, X } from 'lucide-react';
import { Button, ConfirmDialog, IconButton, buttonClass } from '../../design';
import { useSyncSnapshot } from '../../lib/sync';
import { changesAr } from './model';

export interface UpdateBannerProps {
  needRefresh: boolean;
  offlineReady: boolean;
  onUpdate: () => void;
  onDismiss: () => void;
}

export function UpdateBanner({ needRefresh, offlineReady, onUpdate, onDismiss }: UpdateBannerProps) {
  const sync = useSyncSnapshot();
  const location = useLocation();
  const [confirming, setConfirming] = useState(false);
  const unsynced = sync.pending + sync.conflicts;
  const inShell = !location.pathname.startsWith('/study') && !/^\/(login|setup|recover)(\/|$)/.test(location.pathname);
  if (!needRefresh && !offlineReady) return null;
  const pendingText = changesAr(unsynced);
  return (
    <div
      className="ml-update-banner ml-no-print"
      role="status"
      aria-live="polite"
      style={inShell ? undefined : { bottom: 'calc(var(--ml-safe-bottom) + var(--ml-space-3))' }}
    >
      <div className="ml-update-banner__text">
        {needRefresh ? (
          <>
            <strong>يتوفر إصدار أحدث من MedLevo.</strong>
            {unsynced > 0 ? (
              <span>
                على هذا الجهاز {pendingText} لم يُزامَن بعد. التحديث لا يحذفه — يبقى محفوظًا هنا ويُرسل بعده — لكن الأفضل أن تحدّث بعد اكتمال المزامنة.
              </span>
            ) : (
              <span>حدّث عندما تنتهي من الكتابة؛ ما كتبته محفوظ على هذا الجهاز.</span>
            )}
          </>
        ) : (
          <>
            <strong>أصبح التطبيق جاهزًا للعمل دون اتصال.</strong>
            <span>
              المحتوى نفسه يُنزَّل للعمل دون اتصال من{' '}
              {inShell ? (
                <Link to="/offline" className={buttonClass({ variant: 'plain', size: 'sm' })}>
                  مدير التنزيلات
                </Link>
              ) : (
                'مدير التنزيلات'
              )}
              .
            </span>
          </>
        )}
      </div>
      <div className="ml-update-banner__actions">
        {needRefresh && (
          <Button size="sm" variant="primary" icon={<RefreshCw size={16} />} onClick={() => (unsynced > 0 ? setConfirming(true) : onUpdate())}>
            تحديث الآن
          </Button>
        )}
        <IconButton size="sm" label={needRefresh ? 'لاحقًا' : 'إغلاق'} icon={<X size={18} />} onClick={onDismiss} />
      </div>
      <ConfirmDialog
        open={confirming}
        title="تحديث التطبيق الآن؟"
        impact={`ستُعاد تحميل الصفحة. على هذا الجهاز ${pendingText} لم يُزامَن بعد: يبقى محفوظًا ولن يُحذف، ويُرسل إلى الخادم بعد التحديث عند توفر الاتصال.`}
        confirmLabel="حدّث الآن"
        cancelLabel="لاحقًا"
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          onUpdate();
        }}
      />
    </div>
  );
}
