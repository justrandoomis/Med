// «سجل الإجراءات» (P1-T4 step 3; IA §4.10; PRD AOS-18.14): the security audit of the viewer's scope — who did what,
// with which role, when. Titles, ids and counts only: no private content and no IP address ever reach this view (the
// server builds the rows without them). Filter by kind of action; newest first; paged.
import { useState } from 'react';
import { ScrollText } from 'lucide-react';
import { CHANNEL_ROLE_LABELS_AR, type ChannelRole, type SecurityAuditView } from '@medlevo/shared';
import { EmptyState, ErrorState, LoadingState, Select, useToast } from '../../design';
import { errorMessage } from '../../lib/api';
import { formatDateTime } from '../../lib/time';
import { useFetched } from '../channels/useFetched';
import { adminApi } from './api';
import { ReasonedButton } from '../channels/ui';
import { ScopeBar, useAdminScope, useAdminViewer } from './viewer';

export const AUDIT_ACTION_LABELS_AR: Record<string, string> = {
  channel_node_create: 'إنشاء عقدة',
  channel_node_edit: 'تعديل عقدة',
  channel_node_move: 'نقل عقدة',
  channel_node_archive: 'أرشفة',
  channel_code_create: 'إنشاء رمز',
  channel_code_revoke: 'إلغاء رمز',
  channel_join: 'انضمام',
  channel_membership_decide: 'قرار عضوية',
  channel_invite: 'دعوة',
  channel_invitation_decline: 'اعتذار عن دعوة',
  channel_role_grant: 'منح دور',
  channel_role_revoke: 'سحب دور',
  register: 'إنشاء حساب',
  moderation_hide: 'إخفاء محتوى',
  moderation_restore: 'إعادة إظهار',
  moderation_dismiss: 'بلاغ دون مخالفة',
};

/** «مشرف المادة» from 'subject_moderator@<node>', «مسؤول المنصة», «بنفسه». */
export function actorRoleAr(role: string | null): string | null {
  if (!role) return null;
  if (role === 'platform_admin') return 'مسؤول المنصة';
  if (role === 'self') return 'بنفسه';
  const r = role.split('@')[0] as ChannelRole;
  return CHANNEL_ROLE_LABELS_AR[r] ?? null;
}

export function AuditSection() {
  const v = useAdminViewer();
  const toast = useToast();
  const scope = useAdminScope(['admin', 'assistant']);
  const nodeId = scope.current?.node.id ?? null;
  const [action, setAction] = useState('');
  const list = useFetched(nodeId ? `audit.${nodeId}.${action}` : null, () => adminApi.audit(nodeId!, { action }));
  const rows: { items: SecurityAuditView[]; next: string | null } | null = list.data ? { items: list.data.items, next: list.data.next_cursor } : null;
  const error = list.error;
  const load = list.reload;

  return (
    <div className="ml-page ml-page--narrow ad-section">
      <h1 className="ml-page__title">سجل الإجراءات</h1>
      <ScopeBar scope={scope} />
      {!nodeId ? (
        <EmptyState icon={<ScrollText size={28} />} title="لا توجد عقدة تديرها هنا" />
      ) : (
        <>
          <div className="ad-actions">
            <Select
              label="نوع الإجراء"
              value={action}
              onValueChange={setAction}
              options={[{ value: '', label: 'كل الإجراءات' }, ...Object.entries(AUDIT_ACTION_LABELS_AR).map(([value, label]) => ({ value, label }))]}
            />
          </div>
          {error ? (
            <ErrorState message={error} onRetry={load} />
          ) : !rows ? (
            <LoadingState stage="جارٍ تحميل السجل…" />
          ) : rows.items.length === 0 ? (
            <EmptyState icon={<ScrollText size={28} />} title="لا توجد إجراءات مسجلة بهذا الشرط" />
          ) : (
            <ul role="list" className="ml-list">
              {rows.items.map((e) => (
                <li key={e.id} className="ml-list__row ad-member">
                  <div className="ad-member__text">
                    <span className="ad-member__name">{e.summary_ar}</span>
                    <span className="ad-member__meta">
                      {AUDIT_ACTION_LABELS_AR[e.action] ?? e.action} · {e.actor ? e.actor.display_name : 'النظام'}
                      {actorRoleAr(e.actor_role) ? ` (${actorRoleAr(e.actor_role)})` : ''} · {e.scope?.title ?? ''} · <time dateTime={new Date(e.created_at).toISOString()}>{formatDateTime(e.created_at)}</time>
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {rows?.next && (
            <ReasonedButton
              className="ch-more"
              reason={v.cachedAt !== null ? 'يحتاج اتصالًا بالإنترنت.' : null}
              onClick={async () => {
                try {
                  const r = await adminApi.audit(nodeId, { action, cursor: rows.next });
                  list.update((x) => ({ items: [...x.items, ...r.items], next_cursor: r.next_cursor }));
                } catch (e) {
                  toast.show({ title: errorMessage(e), tone: 'danger' });
                }
              }}
            >
              الأقدم
            </ReasonedButton>
          )}
          <p className="ml-group-footer">لا يظهر في السجل أي محتوى خاص ولا عناوين IP. يرى المديرون والمساعدون سجل نطاقهم وما تحته فقط.</p>
        </>
      )}
    </div>
  );
}

export const Component = AuditSection;
