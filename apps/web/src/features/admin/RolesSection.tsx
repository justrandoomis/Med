// «الأدوار» (P1-T4 step 3; IA §4.10; PRD AOS-18.6, 2.14, 21.18): the roles that apply on one node — given here, or
// inherited from a node above (shown with where they come from; they are managed there). Roles flow DOWN the tree,
// never sideways. An Admin gives and takes back roles below Admin in their subtree; only the platform admin gives
// «مدير القناة». A role is given to a member of the node.
import { useMemo, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { CHANNEL_ROLE_LABELS_AR, CHANNEL_ROLES, type ChannelRole, type ChannelRoleView, type MemberView } from '@medlevo/shared';
import { Button, ConfirmDialog, EmptyState, ErrorState, LoadingState, Select, useToast } from '../../design';
import { errorMessage } from '../../lib/api';
import { channelsApi } from '../channels/api';
import { ReasonedButton, RoleBadge } from '../channels/ui';
import { useFetched } from '../channels/useFetched';
import { ScopeBar, useAdminScope, useAdminViewer } from './viewer';

export function RolesSection() {
  const v = useAdminViewer();
  const toast = useToast();
  const scope = useAdminScope(['admin']);
  const node = scope.current?.node ?? null;
  const rolesList = useFetched(node ? `roles.${node.id}` : null, () => channelsApi.roles(node!.id));
  const membersList = useFetched(node ? `role-members.${node.id}` : null, () => channelsApi.members(node!.id, { status: 'approved' }));
  const roles: ChannelRoleView[] | null = rolesList.data?.roles ?? null;
  const members: MemberView[] = membersList.data?.items ?? [];
  const error = rolesList.error;
  const load = () => {
    rolesList.reload();
    membersList.reload();
  };
  const [person, setPerson] = useState('');
  const [role, setRole] = useState<ChannelRole>('assistant');
  const [busy, setBusy] = useState(false);
  const [revoking, setRevoking] = useState<ChannelRoleView | null>(null);
  const offline = v.cachedAt !== null;

  const grantable = useMemo(() => CHANNEL_ROLES.filter((r) => r !== 'admin' || v.isPlatformAdmin), [v.isPlatformAdmin]);

  const grant = async () => {
    if (!node || !person) return;
    setBusy(true);
    try {
      await channelsApi.assignRole(node.id, { user_id: person, role });
      toast.show({ title: `مُنح دور «${CHANNEL_ROLE_LABELS_AR[role]}».`, tone: 'success' });
      setPerson('');
      load();
    } catch (e) {
      toast.show({ title: errorMessage(e), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ml-page ml-page--narrow ad-section">
      <h1 className="ml-page__title">الأدوار</h1>
      <ScopeBar scope={scope} />
      {!node ? (
        <EmptyState icon={<ShieldCheck size={28} />} title="لا توجد عقدة تديرها هنا" />
      ) : (
        <>
          {error ? (
            <ErrorState message={error} onRetry={load} />
          ) : !roles ? (
            <LoadingState stage="جارٍ تحميل الأدوار…" />
          ) : roles.length === 0 ? (
            <EmptyState icon={<ShieldCheck size={28} />} title="لا أدوار على هذه العقدة أو فوقها" />
          ) : (
            <ul role="list" className="ml-list">
              {roles.map((r) => {
                const here = r.node.id === node.id;
                const mayRevoke = here && !offline && (r.role !== 'admin' || v.isPlatformAdmin);
                return (
                  <li key={r.id} className="ml-list__row ad-member">
                    <div className="ad-member__text">
                      <span className="ad-member__name">{r.user.display_name}</span>
                      <span className="ad-member__meta">
                        {here ? 'على هذه العقدة' : `موروث من ${r.node.title}`} · منحه {r.granted_by.display_name}
                      </span>
                    </div>
                    <RoleBadge role={r.role} />
                    {mayRevoke && (
                      <Button size="sm" variant="destructive" aria-label={`اسحب دور ${CHANNEL_ROLE_LABELS_AR[r.role]} من ${r.user.display_name}`} onClick={() => setRevoking(r)}>
                        اسحب
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <section className="ad-card" aria-labelledby="ad-grant-h">
            <h2 id="ad-grant-h" className="ad-card__title">
              امنح دورًا على {node.title}
            </h2>
            {members.length === 0 ? (
              <p className="ch-node__state">لا يوجد أعضاء على هذه العقدة بعد. يُمنح الدور لعضو فيها: أضفه أولًا برمز أو دعوة.</p>
            ) : (
              <div className="ad-two">
                <Select
                  label="الشخص"
                  value={person}
                  onValueChange={setPerson}
                  options={[{ value: '', label: 'اختر عضوًا' }, ...members.map((m) => ({ value: m.user.id, label: m.user.display_name }))]}
                />
                <Select label="الدور" value={role} onValueChange={(x) => setRole(x)} options={grantable.map((r) => ({ value: r, label: CHANNEL_ROLE_LABELS_AR[r] }))} />
              </div>
            )}
            <ReasonedButton variant="primary" loading={busy} reason={offline ? 'يحتاج اتصالًا بالإنترنت.' : !person ? 'اختر عضوًا أولًا.' : null} onClick={() => void grant()}>
              امنح الدور
            </ReasonedButton>
          </section>
          <p className="ml-group-footer">الأدوار تنتقل إلى ما تحت العقدة، لا إلى ما بجانبها. الطالب عضو وليس دورًا.</p>
        </>
      )}
      <ConfirmDialog
        open={revoking !== null}
        title="سحب الدور"
        impact={`يفقد ${revoking?.user.display_name ?? ''} صلاحيات «${revoking ? CHANNEL_ROLE_LABELS_AR[revoking.role] : ''}» هنا وفيما تحتها. تبقى عضويته كما هي.`}
        confirmLabel="اسحب الدور"
        destructive
        onCancel={() => setRevoking(null)}
        onConfirm={async () => {
          await channelsApi.revokeRole(revoking!.id);
          setRevoking(null);
          toast.show({ title: 'سُحب الدور.', tone: 'success' });
          load();
        }}
      />
    </div>
  );
}

export const Component = RolesSection;
