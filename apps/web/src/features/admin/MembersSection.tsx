// «الأعضاء وطلبات الانضمام» (P1-T4 step 3; IA §4.10; PRD AOS-2.15): requests waiting for approval, members, rejected
// and removed people of one node — approve (one or several), reject or remove with an optional reason the person reads
// in their inbox. Admins and Assistants of the node or above decide (the server checks; nobody decides about their own
// membership). Memberships inherited from a node above are decided there.
import { useState } from 'react';
import { Users } from 'lucide-react';
import { type MemberDecision, type MembershipStatus, type MemberView } from '@medlevo/shared';
import { Button, Checkbox, Dialog, EmptyState, ErrorState, LoadingState, SegmentedControl, TextArea, useToast } from '../../design';
import { errorMessage } from '../../lib/api';
import { formatRelative } from '../../lib/time';
import { channelsApi } from '../channels/api';
import { ReasonedButton } from '../channels/ui';
import { useFetched } from '../channels/useFetched';
import { ScopeBar, useAdminScope, useAdminViewer } from './viewer';

const METHOD_AR: Record<string, string> = {
  class_code: 'برمز الصف',
  qr: 'برمز QR',
  invite_link: 'برابط دعوة',
  invitation: 'بدعوة',
  added_by_admin: 'أضافه المشرف',
  legacy_owner: 'المالك الأول',
};
const FILTERS: Array<{ value: MembershipStatus; label: string }> = [
  { value: 'pending', label: 'طلبات الانضمام' },
  { value: 'approved', label: 'الأعضاء' },
  { value: 'rejected', label: 'المرفوضة' },
  { value: 'removed', label: 'المُزالون' },
];

export function MembersSection() {
  const v = useAdminViewer();
  const toast = useToast();
  const scope = useAdminScope(['admin', 'assistant']);
  const nodeId = scope.current?.node.id ?? null;
  const [status, setStatus] = useState<MembershipStatus>('pending');
  const list = useFetched(nodeId ? `members.${nodeId}.${status}` : null, () => channelsApi.members(nodeId!, { status }));
  const rows = list.data ? { items: list.data.items, next: list.data.next_cursor } : null;
  const error = list.error;
  const load = list.reload;
  // the ticked requests belong to ONE list (node + status): another scope or filter starts with none ticked, so
  // «وافق على المحدد» never approves someone the admin did not tick there (review R4)
  const listKey = `${nodeId ?? ''}|${status}`;
  const [ticked, setTicked] = useState<{ key: string; ids: Set<string> }>({ key: listKey, ids: new Set() });
  const selected = ticked.key === listKey ? ticked.ids : new Set<string>();
  const setSelected = (fn: Set<string> | ((s: Set<string>) => Set<string>)) =>
    setTicked((t) => {
      const base = t.key === listKey ? t.ids : new Set<string>();
      return { key: listKey, ids: typeof fn === 'function' ? fn(base) : fn };
    });
  const [asking, setAsking] = useState<{ member: MemberView; decision: Exclude<MemberDecision, 'approve'> } | null>(null);
  const [busy, setBusy] = useState(false);
  const offline = v.cachedAt !== null;


  const decide = async (members: MemberView[], decision: MemberDecision, reason?: string) => {
    if (!nodeId) return;
    setBusy(true);
    let done = 0;
    try {
      for (const m of members) {
        await channelsApi.decide(nodeId, m.user.id, reason ? { decision, reason } : { decision });
        done++;
      }
      toast.show({ title: decision === 'approve' ? `وُوفق على ${done}.` : decision === 'reject' ? 'رُفض الطلب.' : 'أُزيل العضو.', tone: 'success' });
    } catch (e) {
      toast.show({ title: `${done > 0 ? `نُفّذ ${done} ثم توقف: ` : ''}${errorMessage(e)}`, tone: 'danger' });
    } finally {
      setBusy(false);
      setSelected(new Set());
      load();
    }
  };

  const items = rows?.items ?? [];
  const chosen = items.filter((m) => selected.has(m.user.id));
  return (
    <div className="ml-page ml-page--narrow ad-section">
      <h1 className="ml-page__title">الأعضاء وطلبات الانضمام</h1>
      <ScopeBar scope={scope} />
      {!nodeId ? (
        <EmptyState icon={<Users size={28} />} title="لا توجد عقدة تديرها هنا" />
      ) : (
        <>
          <div className="ad-actions">
            <SegmentedControl label="ما يُعرض" value={status} onValueChange={setStatus} options={FILTERS} />
          </div>
          {error ? (
            <ErrorState message={error} onRetry={load} />
          ) : !rows ? (
            <LoadingState stage="جارٍ تحميل الأعضاء…" />
          ) : items.length === 0 ? (
            <EmptyState icon={<Users size={28} />} title={status === 'pending' ? 'لا توجد طلبات انضمام بانتظارك' : 'لا أحد في هذه القائمة'} />
          ) : (
            <>
              {status === 'pending' && (
                <div className="ad-actions">
                  <ReasonedButton
                    variant="primary"
                    loading={busy}
                    reason={offline ? 'يحتاج اتصالًا بالإنترنت.' : chosen.length === 0 ? 'حدّد طلبًا واحدًا على الأقل.' : null}
                    onClick={() => void decide(chosen, 'approve')}
                  >
                    {`وافق على المحدد (${chosen.length})`}
                  </ReasonedButton>
                </div>
              )}
              <ul role="list" className="ml-list">
                {items.map((m) => (
                  <li key={m.membership_id} className="ml-list__row ad-member">
                    {status === 'pending' && (
                      <Checkbox
                        label={<span className="ml-visually-hidden">{`حدّد ${m.user.display_name}`}</span>}
                        checked={selected.has(m.user.id)}
                        onCheckedChange={(on) =>
                          setSelected((s) => {
                            const next = new Set(s);
                            if (on) next.add(m.user.id);
                            else next.delete(m.user.id);
                            return next;
                          })
                        }
                      />
                    )}
                    <div className="ad-member__text">
                      <span className="ad-member__name">{m.user.display_name}</span>
                      <span className="ad-member__meta">
                        {METHOD_AR[m.join_method] ?? m.join_method} · {formatRelative(m.created_at)}
                        {m.decided_by ? ` · قرّر ${m.decided_by.display_name}` : ''}
                        {m.reason_ar ? ` · السبب: ${m.reason_ar}` : ''}
                      </span>
                    </div>
                    {!offline && (
                      <div className="ad-member__actions">
                        {(m.status === 'pending' || m.status === 'rejected') && (
                          <Button size="sm" variant="primary" aria-label={`وافق على ${m.user.display_name}`} disabled={busy} onClick={() => void decide([m], 'approve')}>
                            وافق
                          </Button>
                        )}
                        {m.status === 'pending' && (
                          <Button size="sm" aria-label={`ارفض ${m.user.display_name}`} disabled={busy} onClick={() => setAsking({ member: m, decision: 'reject' })}>
                            ارفض
                          </Button>
                        )}
                        {m.status === 'approved' && (
                          <Button size="sm" variant="destructive" aria-label={`أزِل ${m.user.display_name}`} disabled={busy} onClick={() => setAsking({ member: m, decision: 'remove' })}>
                            أزِل
                          </Button>
                        )}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
              {rows.next && (
                <ReasonedButton
                  className="ch-more"
                  reason={offline ? 'يحتاج اتصالًا بالإنترنت.' : null}
                  onClick={async () => {
                    try {
                      const r = await channelsApi.members(nodeId, { status, cursor: rows.next });
                      list.update((x) => ({ items: [...x.items, ...r.items], next_cursor: r.next_cursor }));
                    } catch (e) {
                      toast.show({ title: errorMessage(e), tone: 'danger' });
                    }
                  }}
                >
                  المزيد
                </ReasonedButton>
              )}
            </>
          )}
          <p className="ml-group-footer">تُعرض هنا العضويات على هذه العقدة نفسها؛ من انضم إلى ما فوقها يُدار هناك. يصل الشخصَ تنبيه بكل قرار.</p>
        </>
      )}
      {asking && (
        <ReasonDialog
          title={asking.decision === 'reject' ? `رفض طلب ${asking.member.user.display_name}` : `إزالة ${asking.member.user.display_name}`}
          confirm={asking.decision === 'reject' ? 'ارفض' : 'أزِل'}
          optional
          onCancel={() => setAsking(null)}
          onConfirm={async (reason) => {
            const a = asking;
            setAsking(null);
            await decide([a.member], a.decision, reason || undefined);
          }}
        />
      )}
    </div>
  );
}

/** A decision that the affected person reads: the reason goes into their notice (titles and text only). */
export function ReasonDialog({
  title,
  confirm,
  label = 'السبب (يصل إلى صاحب الطلب)',
  optional,
  min = 2,
  onCancel,
  onConfirm,
}: {
  title: string;
  confirm: string;
  label?: string;
  optional?: boolean;
  min?: number;
  onCancel: () => void;
  onConfirm: (reason: string) => Promise<void> | void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ok = optional ? reason.trim().length === 0 || reason.trim().length >= min : reason.trim().length >= min;
  return (
    <Dialog
      open
      onClose={busy ? () => undefined : onCancel}
      title={title}
      footer={
        <>
          <Button onClick={onCancel} disabled={busy}>
            إلغاء
          </Button>
          <ReasonedButton
            variant="primary"
            loading={busy}
            reason={ok ? null : `اكتب السبب أولًا (${min} أحرف على الأقل).`}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await onConfirm(reason.trim());
              } catch (e) {
                setError(errorMessage(e));
                setBusy(false);
              }
            }}
          >
            {confirm}
          </ReasonedButton>
        </>
      }
    >
      <TextArea label={label} hint={optional ? 'اختياري.' : `حرفان على الأقل، حتى 500 حرف.`} rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
      {error && <p className="ml-field__error">{error}</p>}
    </Dialog>
  );
}

export const Component = MembersSection;
