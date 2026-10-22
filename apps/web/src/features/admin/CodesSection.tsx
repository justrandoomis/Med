// «الرموز والدعوات» (P1-T4 step 3; IA §4.10, §8.2 QrCard; PRD AOS-2.11–2.13, 18.5): class codes and invite links of one
// node — expiry, uses, whether a join waits for approval, revoke. A new code or link is shown ONCE (the server keeps only
// its hash): the class code in large LTR groups, the invite link as text with its QR. A node whose policy is «بدعوة فقط»
// takes no codes; one that requires approval takes only codes that wait for it — the form says so before the server
// would refuse.
import { useState } from 'react';
import { KeyRound, Link2, Ticket } from 'lucide-react';
import { type CreateJoinCodeResponse, type JoinCodeKind, type JoinCodeView } from '@medlevo/shared';
import { Button, ConfirmDialog, EmptyState, ErrorState, LoadingState, SegmentedControl, Select, StatusPill, Switch, TextField, useToast } from '../../design';
import { errorMessage } from '../../lib/api';
import { formatRelative } from '../../lib/time';
import { channelsApi } from '../channels/api';
import { QrCard } from '../channels/QrCard';
import { ReasonedButton, useCopy } from '../channels/ui';
import { useFetched } from '../channels/useFetched';
import { ScopeBar, useAdminScope, useAdminViewer } from './viewer';

const EXPIRY = [
  { value: '24', label: 'يوم واحد' },
  { value: '168', label: '7 أيام' },
  { value: '720', label: '30 يومًا' },
  { value: '4320', label: '180 يومًا' },
];

function codeState(c: JoinCodeView, now: number): { tone: 'success' | 'warning' | 'neutral'; label: string; live: boolean } {
  if (c.revoked_at !== null) return { tone: 'neutral', label: 'أُلغي', live: false };
  if (c.expires_at <= now) return { tone: 'neutral', label: 'انتهت صلاحيته', live: false };
  if (c.max_uses !== null && c.use_count >= c.max_uses) return { tone: 'warning', label: 'استُنفد', live: false };
  return { tone: 'success', label: 'فعّال', live: true };
}

export function CodesSection() {
  const v = useAdminViewer();
  const toast = useToast();
  const copy = useCopy();
  const scope = useAdminScope(['admin', 'assistant']);
  const node = scope.current?.node ?? null;
  const list = useFetched(node ? `codes.${node.id}` : null, () => channelsApi.codes(node!.id));
  const codes = list.data?.codes ?? null;
  const error = list.error;
  const load = list.reload;
  const [now] = useState(() => Date.now());
  const [kind, setKind] = useState<JoinCodeKind>('class_code');
  const [hours, setHours] = useState('168');
  const [maxUses, setMaxUses] = useState('');
  const [approval, setApproval] = useState(true);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<CreateJoinCodeResponse | null>(null);
  const [revoking, setRevoking] = useState<JoinCodeView | null>(null);
  const offline = v.cachedAt !== null;

  const policyForcesApproval = node?.join_policy === 'approval';
  const closed = node?.join_policy === 'closed';
  const uses = maxUses.trim() === '' ? null : Number(maxUses);
  const usesError = uses !== null && (!Number.isInteger(uses) || uses < 1 || uses > 10_000) ? 'عدد صحيح من 1 إلى 10000.' : null;

  const create = async () => {
    if (!node || usesError) return;
    setBusy(true);
    try {
      const r = await channelsApi.createCode(node.id, {
        kind,
        expires_in_hours: Number(hours),
        ...(uses !== null ? { max_uses: uses } : {}),
        requires_approval: policyForcesApproval ? true : approval,
      });
      setCreated(r);
      load();
    } catch (e) {
      toast.show({ title: errorMessage(e), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ml-page ml-page--narrow ad-section">
      <h1 className="ml-page__title">الرموز والدعوات</h1>
      <ScopeBar scope={scope} />
      {!node ? (
        <EmptyState icon={<Ticket size={28} />} title="لا توجد عقدة تديرها هنا" />
      ) : (
        <>
          <section className="ad-card" aria-labelledby="ad-new-code">
            <h2 id="ad-new-code" className="ad-card__title">
              رمز أو رابط جديد
            </h2>
            <SegmentedControl
              label="النوع"
              showLabel
              value={kind}
              onValueChange={setKind}
              options={[
                { value: 'class_code', label: 'رمز صف', icon: <KeyRound size={16} /> },
                { value: 'invite_link', label: 'رابط دعوة و QR', icon: <Link2 size={16} /> },
              ]}
            />
            <div className="ad-two">
              <Select label="الصلاحية" value={hours} onValueChange={setHours} options={EXPIRY} />
              <TextField label="أقصى عدد للاستخدام (اختياري)" inputMode="numeric" dir="ltr" value={maxUses} onChange={(e) => setMaxUses(e.target.value)} error={usesError ?? undefined} />
            </div>
            <Switch
              label="يحتاج موافقة المشرف"
              description={policyForcesApproval ? 'هذه القناة تشترط موافقة المشرف على كل انضمام.' : 'بدونها ينضم من يملك الرمز مباشرة.'}
              checked={policyForcesApproval ? true : approval}
              disabled={policyForcesApproval}
              onCheckedChange={setApproval}
            />
            <ReasonedButton variant="primary" loading={busy} reason={offline ? 'يحتاج اتصالًا بالإنترنت.' : closed ? 'هذه القناة بدعوة فقط: لا تُنشأ لها رموز. غيّر طريقة الانضمام من «الشجرة».' : null} onClick={() => void create()}>
              أنشئ
            </ReasonedButton>
          </section>

          {/* shown only under the node it was made for: after a scope change it would sit under another node's name and
              be handed out for the wrong subject (review R3) — it names its node too */}
          {created && created.view.node.id === node.id && (
            <section className="ad-card ad-card--new" aria-labelledby="ad-created">
              <h2 id="ad-created" className="ad-card__title">
                {created.code ? 'رمز الانضمام الجديد' : 'رابط الدعوة الجديد'} — <bdi>{created.view.node.title}</bdi>
              </h2>
              <p className="ch-reasoned__why">لن يظهر مرة أخرى — انسخه أو صوّره الآن. يحفظ الخادم بصمته فقط.</p>
              {created.code && (
                <div className="ad-actions">
                  <code dir="ltr" className="ch-code ch-code--big">
                    {created.code}
                  </code>
                  <Button size="sm" onClick={() => void copy(created.code!, 'الرمز')}>
                    انسخ الرمز
                  </Button>
                </div>
              )}
              {created.qr_payload && <QrCard payload={created.qr_payload} caption="رابط الدعوة — يفتح صفحة تعرض اسم القناة فقط" />}
              <Button size="sm" variant="plain" onClick={() => setCreated(null)}>
                أخفِ
              </Button>
            </section>
          )}

          <section aria-labelledby="ad-codes-h">
            <h2 id="ad-codes-h" className="ad-card__title">
              الرموز والروابط
            </h2>
            {error ? (
              <ErrorState message={error} onRetry={load} />
            ) : !codes ? (
              <LoadingState stage="جارٍ تحميل الرموز…" />
            ) : codes.length === 0 ? (
              <EmptyState icon={<Ticket size={28} />} title="لا توجد رموز لهذه العقدة بعد" />
            ) : (
              <ul role="list" className="ml-list">
                {codes.map((c) => {
                  const st = codeState(c, now);
                  return (
                    <li key={c.id} className="ml-list__row ad-member">
                      <div className="ad-member__text">
                        <span className="ad-member__name">
                          {c.kind === 'class_code' ? 'رمز صف' : 'رابط دعوة'} <bdi dir="ltr">…{c.hint}</bdi>
                        </span>
                        <span className="ad-member__meta">
                          {c.max_uses !== null ? `${c.use_count} من ${c.max_uses} استخدامًا` : `${c.use_count} استخدام`} · {c.requires_approval ? 'يحتاج موافقة' : 'انضمام مباشر'} ·{' '}
                          {c.expires_at > now ? `ينتهي ${formatRelative(c.expires_at)}` : `انتهى ${formatRelative(c.expires_at)}`} · أنشأه {c.created_by.display_name}
                        </span>
                      </div>
                      <StatusPill tone={st.tone}>{st.label}</StatusPill>
                      {st.live && !offline && (
                        <Button size="sm" variant="destructive" aria-label={`ألغِ الرمز …${c.hint}`} onClick={() => setRevoking(c)}>
                          ألغِ
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </>
      )}
      <ConfirmDialog
        open={revoking !== null}
        title="إلغاء الرمز"
        impact="لن يقبل الخادم هذا الرمز أو الرابط بعد الآن. من انضم به يبقى عضوًا."
        confirmLabel="ألغِ الرمز"
        destructive
        onCancel={() => setRevoking(null)}
        onConfirm={async () => {
          await channelsApi.revokeCode(revoking!.id);
          setRevoking(null);
          toast.show({ title: 'أُلغي الرمز.', tone: 'success' });
          load();
        }}
      />
    </div>
  );
}

export const Component = CodesSection;
