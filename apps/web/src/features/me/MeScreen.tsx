// «أنا» — /me (P1-T4 step 3; IA §3.1 destination 5, §3.2). The account and everything that is the student's own:
// Settings (moved here from the tab bar, same URL /settings), the Personal Control Center, downloads and backups,
// devices, privacy and data, usage — and «إدارة القنوات» only for someone who holds a channel role (or the platform
// admin). Later-phase entries (profile, publications, followers) are not listed before their phase (AOS-23.3).
import { useEffect, useState } from 'react';
import { ChevronLeft, CloudDownload, Gauge, Network, Settings, ShieldCheck, SlidersHorizontal, Smartphone } from 'lucide-react';
import type { ChannelRole, MeResponse } from '@medlevo/shared';
import { ErrorState, ListItem, LoadingState } from '../../design';
import { errorMessage } from '../../lib/api';
import { usePageTitle } from '../../lib/usePageTitle';
import { accountApi, channelsApi } from '../channels/api';
import { withCache } from '../channels/cache';
import { holdsAnyRole } from '../channels/model';
import { CachedBanner, RoleBadge } from '../channels/ui';
import './me.css';

const chevron = <ChevronLeft size={18} aria-hidden="true" />;

export function MeScreen() {
  usePageTitle('أنا');
  const [me, setMe] = useState<{ data: MeResponse; cachedAt: number | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [roles, setRoles] = useState<ChannelRole[]>([]);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    withCache('me', () => accountApi.me())
      .then((r) => {
        if (!alive) return;
        setMe(r);
        setError(null);
        // channel roles come from the tree (inherited down it); the platform admin administers everything
        return withCache('tree', () => channelsApi.tree()).then((t) => alive && setRoles(holdsAnyRole(t.data.nodes, r.data.is_platform_admin)));
      })
      .catch((e) => alive && setError(errorMessage(e)));
    return () => {
      alive = false;
    };
  }, [attempt]);

  return (
    <div className="ml-page ml-page--narrow me-screen">
      <header className="ml-page__header">
        <h1 className="ml-page__title">أنا</h1>
      </header>
      {me?.cachedAt != null && <CachedBanner at={me.cachedAt} />}
      {error && !me ? (
        <ErrorState message={error} onRetry={() => setAttempt((a) => a + 1)} />
      ) : !me ? (
        <LoadingState stage="جارٍ تحميل حسابك…" />
      ) : (
        <section className="me-account" aria-label="حسابك">
          <p className="me-account__name">{me.data.display_name}</p>
          <p className="me-account__user">
            <bdi dir="ltr">@{me.data.username}</bdi>
            {me.data.is_platform_admin && <span className="me-account__badge">مسؤول المنصة</span>}
            {roles
              .filter((r) => !me.data.is_platform_admin || r !== 'admin')
              .map((r) => (
                <RoleBadge key={r} role={r} />
              ))}
          </p>
        </section>
      )}

      <ul role="list" className="ml-list me-links">
        <ListItem to="/settings" leading={<Settings size={20} />} title="الإعدادات" subtitle="المظهر ووضع الحبر الإلكتروني، والقراءة والشرح، والوقت، والأمان وكلمة المرور والجلسات." trailing={chevron} />
        <ListItem to="/control" leading={<SlidersHorizontal size={20} />} title="مركز التحكم" subtitle="قائمة المراجعة، والمعالجة، والتخزين، وتعارضات المزامنة، والسجل — لبياناتك أنت." trailing={chevron} />
        <ListItem to="/offline" leading={<CloudDownload size={20} />} title="التنزيلات والنسخ الاحتياطي" subtitle="ما نُزّل على هذا الجهاز للدراسة دون اتصال، والنسخ الاحتياطية، والتصدير." trailing={chevron} />
        <ListItem to="/me/devices" leading={<Smartphone size={20} />} title="أجهزتي" subtitle="الأجهزة التي تستخدم حسابك، وإلغاء جهاز لم تعد تستخدمه." trailing={chevron} />
        <ListItem to="/me/privacy" leading={<ShieldCheck size={20} />} title="الخصوصية والبيانات" subtitle="نسخة من بياناتي، وحذف الحساب وما يترتب عليه." trailing={chevron} />
        <ListItem to="/me/usage" leading={<Gauge size={20} />} title="الاستهلاك" subtitle="مساحة التخزين، ورصيد الذكاء الاصطناعي والتفريغ الصوتي هذا الشهر." trailing={chevron} />
      </ul>

      {roles.length > 0 && (
        <ul role="list" className="ml-list me-links">
          <ListItem to="/admin" leading={<Network size={20} />} title="إدارة القنوات" subtitle="للقنوات التي لك فيها دور: الشجرة والأعضاء والرموز والأدوار والإشراف وسجل الإجراءات." trailing={chevron} />
        </ul>
      )}
    </div>
  );
}
