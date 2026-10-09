import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { LogIn, RefreshCw, WifiOff } from 'lucide-react';
import { SYNC_STATE_LABELS_AR, type SyncState } from '@medlevo/shared';
import { Button, Popover, SaveStatus, SaveStatusContent, StatusPill, Tooltip, buttonClass, saveStatusClass } from '../design';
import { describeSyncSnapshot, getSyncEngine, useSyncSnapshot } from '../lib/sync';
import { useOnline } from '../lib/useOnline';
import { formatRelative } from '../lib/time';

/**
 * Global save/sync indicator for the shell: icon + text (never colour only). Opens a small panel
 * with the honest details and a "sync now" action. The visible text updates live (aria-live polite).
 */
export function GlobalSaveStatus({ compact }: { compact?: boolean }) {
  const snap = useSyncSnapshot();
  const location = useLocation();
  const detail = describeSyncSnapshot(snap);
  const announcement = useSaveAnnouncement(snap.state);
  // background sync never redirects (the owner may be writing); signing in is the owner's choice
  const loginHref = `/login?expired=1&next=${encodeURIComponent(location.pathname + location.search)}`;
  return (
    <>
      <span className="ml-visually-hidden" role="status" aria-live="polite">
        {announcement}
      </span>
      <Popover
        label="حالة الحفظ والمزامنة"
        align="end"
        trigger={
          <button type="button" className={saveStatusClass(snap.state, 'ml-save-status--button ml-shell-save')} data-state={snap.state} aria-label={`حالة الحفظ: ${SYNC_STATE_LABELS_AR[snap.state]} — عرض التفاصيل`}>
            <SaveStatusContent state={snap.state} compact={compact} />
          </button>
        }
      >
        {(close) => (
          <div className="ml-sync-panel">
            <SaveStatus state={snap.state} />
            <p className="ml-sync-panel__detail">{detail}</p>
            {snap.lastSyncedAt != null && <p className="ml-sync-panel__meta">آخر مزامنة ناجحة: {formatRelative(snap.lastSyncedAt)}</p>}
            {snap.authRequired && <p className="ml-sync-panel__meta">انتهت الجلسة على هذا الجهاز. سجّل الدخول لإكمال المزامنة؛ لن يُحذف شيء من التغييرات المحلية.</p>}
            {!snap.online && <p className="ml-sync-panel__meta">المزامنة تحتاج اتصالًا. تابع الكتابة؛ كل شيء يُحفظ على هذا الجهاز أولًا.</p>}
            <div className="ml-sync-panel__actions">
              {snap.authRequired && (
                <Link to={loginHref} className={buttonClass({ variant: 'primary', size: 'sm' })} onClick={() => close()}>
                  <span className="ml-btn__icon" aria-hidden="true">
                    <LogIn size={16} />
                  </span>
                  <span className="ml-btn__label">تسجيل الدخول</span>
                </Link>
              )}
              <Button
                size="sm"
                variant="secondary"
                icon={<RefreshCw size={16} />}
                disabled={!snap.online}
                loading={snap.phase !== 'idle'}
                loadingLabel="جارٍ المزامنة…"
                onClick={() => void getSyncEngine().syncNow()}
              >
                مزامنة الآن
              </Button>
              <Button size="sm" variant="plain" onClick={close}>
                إغلاق
              </Button>
            </div>
          </div>
        )}
      </Popover>
    </>
  );
}

/**
 * Text for the polite live region. Routine pending→synced cycles while typing are not announced
 * (they would be noise); problems are, and so is recovery from them.
 */
function useSaveAnnouncement(state: SyncState): string {
  const [text, setText] = useState('');
  const prev = useRef<SyncState>(state);
  useEffect(() => {
    const was = prev.current;
    prev.current = state;
    if (was === state) return;
    if (state === 'conflict' || state === 'error' || state === 'saved_locally') setText(`حالة الحفظ: ${SYNC_STATE_LABELS_AR[state]}`);
    else if (state === 'synced' && (was === 'conflict' || was === 'error' || was === 'saved_locally')) setText(`حالة الحفظ: ${SYNC_STATE_LABELS_AR.synced}`);
  }, [state]);
  return text;
}

/** Shown only while the browser reports no network: icon + text, with what still works in the tooltip. */
export function OfflineIndicator({ compact }: { compact?: boolean }) {
  const online = useOnline();
  if (online) return null;
  return (
    // The pill's own text names the state; the tooltip (linked via aria-describedby while shown) says
    // what still works. No aria-label on this generic span (not allowed on role=generic).
    <Tooltip content="دون اتصال: القراءة والكتابة على المحتوى المحمّل تعمل وتُحفظ على هذا الجهاز. AI والبحث الخارجي والرفع تحتاج اتصالًا.">
      <span tabIndex={0} className="ml-offline-pill">
        <StatusPill tone="warning" icon={<WifiOff size={14} />}>
          {compact ? <span className="ml-visually-hidden">دون اتصال</span> : 'دون اتصال'}
        </StatusPill>
      </span>
    </Tooltip>
  );
}
