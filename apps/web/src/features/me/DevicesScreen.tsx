// «أجهزتي» — /me/devices (P1-T4 step 3; IA §3.2 «أجهزتي»; P1-T1's /api/accounts/me/devices). The devices that use this
// account, which one this is, when each was last seen, and «ألغِ هذا الجهاز» for one the student no longer uses: the
// server then refuses every change from it. The open sign-in sessions live in Settings › الأمان (linked).
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Smartphone } from 'lucide-react';
import type { DeviceView } from '@medlevo/shared';
import { Breadcrumbs, Button, ConfirmDialog, EmptyState, ErrorState, LoadingState, StatusPill, useToast } from '../../design';
import { formatRelative } from '../../lib/time';
import { usePageTitle } from '../../lib/usePageTitle';
import { useOnline } from '../../lib/useOnline';
import { useFetched } from '../channels/useFetched';
import { meApi } from './api';
import './me.css';

const PLATFORM_AR: Record<string, string> = { web: 'متصفح', ios: 'iPhone / iPad', android: 'Android', other: 'جهاز آخر' };

export function DevicesScreen() {
  usePageTitle('أجهزتي');
  const toast = useToast();
  const online = useOnline();
  const list = useFetched('devices', () => meApi.devices());
  const devices = list.data?.devices ?? null;
  const error = list.error;
  const load = list.reload;
  const [revoking, setRevoking] = useState<DeviceView | null>(null);

  return (
    <div className="ml-page ml-page--narrow me-screen">
      <Breadcrumbs items={[{ label: 'أنا', to: '/me' }, { label: 'أجهزتي' }]} />
      <header className="ml-page__header">
        <h1 className="ml-page__title">أجهزتي</h1>
        <p className="ml-page__lede">الأجهزة التي سجّلت الدخول إلى حسابك. ألغِ جهازًا لم تعد تستخدمه: لن يُقبل منه أي تغيير بعد ذلك.</p>
      </header>
      {error && !devices ? (
        <ErrorState message={error} onRetry={load} />
      ) : !devices ? (
        <LoadingState stage="جارٍ تحميل أجهزتك…" />
      ) : devices.length === 0 ? (
        <EmptyState icon={<Smartphone size={28} />} title="لا توجد أجهزة مسجلة بعد" description="يُسجَّل الجهاز عند أول مزامنة منه." />
      ) : (
        <ul role="list" className="ml-list">
          {devices.map((d) => (
            <li key={d.device_id} className="ml-list__row me-device">
              <Smartphone size={20} aria-hidden="true" className="me-device__icon" />
              <div className="me-device__text">
                <span className="me-device__label">{d.label ?? 'جهاز بلا اسم'}</span>
                <span className="me-device__meta">
                  {d.platform ? PLATFORM_AR[d.platform] : 'نوع غير معروف'} · آخر استخدام {formatRelative(d.last_seen_at)}
                </span>
              </div>
              <div className="me-device__end">
                {d.current && <StatusPill tone="success">هذا الجهاز</StatusPill>}
                {d.revoked_at !== null && <StatusPill tone="warning">أُلغي</StatusPill>}
                {!d.current && d.revoked_at === null && (
                  <Button size="sm" variant="plain" disabled={!online} aria-describedby={online ? undefined : 'me-devices-offline'} onClick={() => setRevoking(d)}>
                    ألغِ هذا الجهاز
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {!online && (
        <p id="me-devices-offline" className="ml-group-footer">
          إلغاء جهاز يحتاج اتصالًا بالخادم.
        </p>
      )}
      <p className="ml-group-footer">
        جلسات الدخول المفتوحة وتسجيل الخروج منها في <Link to="/settings#security">الإعدادات › الأمان</Link>.
      </p>
      <ConfirmDialog
        open={revoking !== null}
        title="إلغاء الجهاز"
        impact={`لن يُقبل من «${revoking?.label ?? 'هذا الجهاز'}» أي تغيير بعد الآن حتى يُسجَّل من جديد. ما خُزّن على ذلك الجهاز نفسه لا يُحذف من هنا.`}
        confirmLabel="ألغِ الجهاز"
        destructive
        onCancel={() => setRevoking(null)}
        onConfirm={async () => {
          const d = revoking!;
          await meApi.revokeDevice(d.device_id);
          setRevoking(null);
          toast.show({ title: 'أُلغي الجهاز.', tone: 'success' });
          load();
        }}
      />
    </div>
  );
}
