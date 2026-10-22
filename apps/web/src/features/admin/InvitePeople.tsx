// (Phase 1 completion C2, AOS-18.5) «ادعُ أشخاصًا بالاسم» and «الدعوات المرسلة» inside «الرموز والدعوات»: an Admin or
// Assistant finds a NAMED person — a member of a channel they already manage by the start of the name, anyone else only
// by their exact username (the server never lists every account) — invites them (they read it in their notices and
// accept or decline), sees every invitation sent into the node with its state, and revokes a pending one. Every
// decision is the server's; its reasons are shown as given.
import { useEffect, useState } from 'react';
import { Send, UserPlus } from 'lucide-react';
import type { InvitationStatus, InvitationView, InviteeCandidate } from '@medlevo/shared';
import { EmptyState, ErrorState, LoadingState, StatusPill, TextField, useToast } from '../../design';
import { errorMessage } from '../../lib/api';
import { formatRelative } from '../../lib/time';
import { channelsApi } from '../channels/api';
import { ReasonedButton } from '../channels/ui';
import { useFetched } from '../channels/useFetched';

export const INVITATION_STATUS_AR: Record<InvitationStatus, string> = {
  pending: 'بانتظار الرد',
  accepted: 'قُبلت',
  declined: 'رُفضت',
  revoked: 'أُلغيت',
  expired: 'انتهت صلاحيتها',
};
const STATE_AR: Record<InviteeCandidate['state'], string | null> = { can_invite: null, member: 'عضو بالفعل', invited: 'مدعو وينتظر الرد' };
const OFFLINE_AR = 'يحتاج اتصالًا بالإنترنت.';

export function InvitePeople({ node, offline }: { node: { id: string; title: string }; offline: boolean }) {
  const toast = useToast();
  const [q, setQ] = useState('');
  const [found, setFound] = useState<{ q: string; candidates: InviteeCandidate[] } | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const sent = useFetched(`invitations.${node.id}`, () => channelsApi.nodeInvitations(node.id));
  const term = q.trim();

  useEffect(() => {
    if (term.length < 2 || offline) return;
    let alive = true;
    const t = setTimeout(() => {
      channelsApi
        .searchInvitees(node.id, term)
        .then((r) => {
          if (!alive) return;
          setFound({ q: term, candidates: r.candidates });
          setSearchError(null);
        })
        .catch((e) => alive && setSearchError(errorMessage(e)));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [node.id, term, offline, nonce]);

  const invite = async (c: InviteeCandidate) => {
    setBusy(c.user.id);
    try {
      await channelsApi.invite(node.id, [c.user.id]);
      toast.show({ title: `أُرسلت الدعوة إلى ${c.user.display_name}.`, description: 'تصله في تنبيهاته ويقبلها أو يرفضها.', tone: 'success' });
      sent.reload();
      setNonce((n) => n + 1);
    } catch (e) {
      toast.show({ title: errorMessage(e), tone: 'danger' });
    } finally {
      setBusy(null);
    }
  };
  const revoke = async (inv: InvitationView) => {
    setBusy(inv.id);
    try {
      await channelsApi.revokeInvitation(inv.id);
      toast.show({ title: `أُلغيت دعوة ${inv.invitee.display_name}.`, tone: 'success' });
      sent.reload();
      setNonce((n) => n + 1);
    } catch (e) {
      toast.show({ title: errorMessage(e), tone: 'danger' });
    } finally {
      setBusy(null);
    }
  };

  const shown = found && found.q === term ? found.candidates : null;
  const invitations = sent.data?.invitations ?? null;
  return (
    <>
      <section className="ad-card" aria-labelledby="ad-invite-title">
        <h2 id="ad-invite-title" className="ad-card__title">
          <UserPlus size={18} aria-hidden="true" /> ادعُ أشخاصًا بالاسم
        </h2>
        <TextField
          label="ابحث عن شخص"
          hint="حرفان على الأقل من اسم عضو في قناة تديرها، أو اسم المستخدم كاملًا لغيرهم."
          value={q}
          maxLength={64}
          onChange={(e) => setQ(e.target.value)}
          disabled={offline}
        />
        {offline ? (
          <p className="ml-group-footer">{`البحث والدعوة ${OFFLINE_AR}`}</p>
        ) : searchError ? (
          <ErrorState inline message={searchError} onRetry={() => setNonce((n) => n + 1)} />
        ) : term.length >= 2 && !shown ? (
          <LoadingState inline stage="جارٍ البحث…" />
        ) : shown && shown.length === 0 ? (
          <p className="ml-group-footer">لا أحد بهذا الاسم في القنوات التي تديرها. اكتب اسم المستخدم كاملًا لدعوة غيرهم.</p>
        ) : shown ? (
          <ul role="list" className="ml-list" aria-label="نتائج البحث">
            {shown.map((c) => (
              <li key={c.user.id} className="ml-list__row ad-member">
                <div className="ad-member__text">
                  <span className="ad-member__name">
                    <bdi>{c.user.display_name}</bdi>
                  </span>
                  <span className="ad-member__meta">{c.match === 'username' ? 'اسم المستخدم مطابق تمامًا' : (c.where_ar ?? 'عضو في قناة تديرها')}</span>
                </div>
                <div className="ad-member__actions">
                  {STATE_AR[c.state] ? (
                    <StatusPill tone={c.state === 'member' ? 'success' : 'info'}>{STATE_AR[c.state]}</StatusPill>
                  ) : (
                    <ReasonedButton size="sm" variant="primary" icon={<Send size={16} />} loading={busy === c.user.id} reason={busy && busy !== c.user.id ? 'انتظر انتهاء الطلب السابق.' : null} aria-label={`ادعُ ${c.user.display_name}`} onClick={() => void invite(c)}>
                      ادعُ
                    </ReasonedButton>
                  )}
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="ad-card" aria-labelledby="ad-sent-title">
        <h2 id="ad-sent-title" className="ad-card__title">
          الدعوات المرسلة
        </h2>
        {sent.error ? (
          <ErrorState inline message={sent.error} onRetry={sent.reload} />
        ) : !invitations ? (
          <LoadingState inline stage="جارٍ تحميل الدعوات…" />
        ) : invitations.length === 0 ? (
          <EmptyState headingLevel={3} title="لم تُرسل دعوات إلى هذه العقدة بعد" />
        ) : (
          <ul role="list" className="ml-list" aria-label="الدعوات المرسلة">
            {invitations.map((inv) => (
              <li key={inv.id} className="ml-list__row ad-member">
                <div className="ad-member__text">
                  <span className="ad-member__name">
                    <bdi>{inv.invitee.display_name}</bdi>
                  </span>
                  <span className="ad-member__meta">{`أرسلها ${inv.invited_by.display_name} · ${formatRelative(inv.created_at)}`}</span>
                </div>
                <div className="ad-member__actions">
                  <StatusPill tone={inv.status === 'accepted' ? 'success' : inv.status === 'pending' ? 'info' : 'neutral'}>{INVITATION_STATUS_AR[inv.status]}</StatusPill>
                  {inv.status === 'pending' && (
                    <ReasonedButton size="sm" variant="destructive" loading={busy === inv.id} reason={offline ? OFFLINE_AR : null} aria-label={`ألغِ دعوة ${inv.invitee.display_name}`} onClick={() => void revoke(inv)}>
                      ألغِ الدعوة
                    </ReasonedButton>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="ml-group-footer">{`تُعرض هنا الدعوات إلى «${node.title}» نفسها. الدعوة تبقى أسبوعين، ويلغيها النظام إن فقد مُرسلها صلاحيته.`}</p>
      </section>
    </>
  );
}
