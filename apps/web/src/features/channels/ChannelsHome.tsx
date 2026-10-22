// «القنوات» — /channels (P1-T4 step 3; IA §4.1). The shared world, one tap from the personal one:
//  * «قنواتي» — the subjects the server lets the viewer enter, grouped by their place in the tree, each with the
//    viewer's role when it is not Student, «تتابعها», and unread updates said in text;
//  * «دعوات» — invitations addressed to the viewer (accept / decline);
//  * «طلبات معلّقة» — the viewer's own requests waiting for an approver;
//  * «تصفّح» — the universities, to browse the tree (titles are visible to every signed-in user);
//  * «انضم برمز أو QR» — the join sheet.
// Offline, the copy saved on this device is shown read-only with when it was saved; joining needs the network.
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { Building2, GraduationCap, Plus } from 'lucide-react';
import type { ChannelTreeResponse, InvitationView } from '@medlevo/shared';
import { Button, EmptyState, ErrorState, ListItem, LoadingState, StatusPill, useToast } from '../../design';
import { errorMessage } from '../../lib/api';
import { usePageTitle } from '../../lib/usePageTitle';
import { useOnline } from '../../lib/useOnline';
import { notificationsApi } from '../notifications/api';
import { channelsApi } from './api';
import { dropCache, withCache } from './cache';
import { JoinSheet } from './JoinSheet';
import { myChannels, treeOrder } from './model';
import { CachedBanner, ReasonedButton, RoleBadge } from './ui';
import './channels.css';

/** «تحديث واحد غير مقروء» / «تحديثان غير مقروءين» / «3 تحديثات غير مقروءة» / «11 تحديثًا غير مقروء». */
export function unreadUpdatesAr(n: number): string {
  if (n === 1) return 'تحديث واحد غير مقروء';
  if (n === 2) return 'تحديثان غير مقروءين';
  if (n % 100 >= 3 && n % 100 <= 10) return `${n} تحديثات غير مقروءة`;
  return `${n} تحديثًا غير مقروء`;
}

export function ChannelsHome() {
  usePageTitle('القنوات');
  const online = useOnline();
  const toast = useToast();
  const [tree, setTree] = useState<{ data: ChannelTreeResponse; cachedAt: number | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [invitations, setInvitations] = useState<InvitationView[]>([]);
  const [unreadBySubject, setUnread] = useState<Map<string, number>>(new Map());
  const [joinOpen, setJoinOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((a) => a + 1), []);

  useEffect(() => {
    let alive = true;
    withCache('tree', () => channelsApi.tree())
      .then((r) => {
        if (!alive) return;
        setTree(r);
        setError(null);
        if (r.cachedAt !== null) return;
        // online only: invitations and the unread updates of each subject (a link to /subjects/<id>)
        channelsApi
          .invitations()
          .then((i) => alive && setInvitations(i.invitations.filter((x) => x.status === 'pending')))
          .catch(() => undefined);
        notificationsApi
          .list({ unread: true, limit: 100 })
          .then((list) => {
            if (!alive) return;
            const m = new Map<string, number>();
            for (const x of list.items) {
              const id = /^\/subjects\/([A-Za-z0-9_-]+)$/.exec(x.link ?? '')?.[1];
              if (id) m.set(id, (m.get(id) ?? 0) + 1);
            }
            setUnread(m);
          })
          .catch(() => undefined);
      })
      .catch((e) => alive && setError(errorMessage(e)));
    return () => {
      alive = false;
    };
  }, [attempt]);

  const mine = useMemo(() => (tree ? myChannels(tree.data.nodes) : null), [tree]);
  const roots = useMemo(() => (tree ? treeOrder(tree.data.nodes).filter((x) => x.depth === 0 && x.node.parent_id === null) : []), [tree]);
  const cached = tree?.cachedAt ?? null;
  const joinReason = cached !== null || !online ? 'الانضمام يحتاج اتصالًا بالإنترنت.' : null;
  const invWhyId = useId();

  const decide = async (inv: InvitationView, accept: boolean) => {
    try {
      const r = await channelsApi.decideInvitation(inv.id, accept);
      toast.show({ title: r.message_ar, tone: accept ? 'success' : 'neutral' });
      dropCache('tree');
      reload();
    } catch (e) {
      toast.show({ title: errorMessage(e), tone: 'danger' });
    }
  };

  const joinButton = (
    <ReasonedButton variant="primary" icon={<Plus size={18} />} reason={joinReason} onClick={() => setJoinOpen(true)}>
      انضم برمز أو QR
    </ReasonedButton>
  );

  // group my subjects by their place in the tree
  const groups = useMemo(() => {
    const out: Array<{ group: string; items: NonNullable<typeof mine>['subjects'] }> = [];
    for (const s of mine?.subjects ?? []) {
      const last = out[out.length - 1];
      if (last && last.group === s.group) last.items.push(s);
      else out.push({ group: s.group, items: [s] });
    }
    return out;
  }, [mine]);

  return (
    <div className="ml-page ml-page--narrow ch-screen">
      <header className="ml-page__header">
        <h1 className="ml-page__title">القنوات</h1>
        <p className="ml-page__lede">المواد التي انضممت إليها: المحاضرات الرسمية وملفاتها وتحديثاتها. مكتبتك الشخصية تبقى خاصة بك.</p>
      </header>
      {cached !== null && <CachedBanner at={cached} />}
      <div className="ch-screen__actions">{joinButton}</div>

      {error && !tree ? (
        <ErrorState message={error} onRetry={reload} />
      ) : !tree || !mine ? (
        <LoadingState stage="جارٍ تحميل قنواتك…" />
      ) : (
        <>
          {invitations.length > 0 && (
            <section className="ch-section" aria-labelledby="ch-inv-h">
              <h2 id="ch-inv-h" className="ch-section__title">
                دعوات
              </h2>
              {joinReason && (
                <p id={invWhyId} className="ch-reasoned__why">
                  {joinReason}
                </p>
              )}
              <ul role="list" className="ml-list">
                {invitations.map((inv) => (
                  <li key={inv.id} className="ml-list__row ch-invite">
                    <span className="ch-invite__text">
                      دعاك {inv.invited_by.display_name} إلى <strong>{inv.node.title}</strong>
                    </span>
                    <Button size="sm" variant="primary" disabled={!!joinReason} aria-describedby={joinReason ? invWhyId : undefined} onClick={() => void decide(inv, true)}>
                      اقبل الدعوة
                    </Button>
                    <Button size="sm" disabled={!!joinReason} aria-describedby={joinReason ? invWhyId : undefined} onClick={() => void decide(inv, false)}>
                      اعتذر
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {mine.subjects.length === 0 && mine.pending.length === 0 ? (
            <EmptyState
              icon={<GraduationCap size={28} />}
              title="لم تنضم إلى أي مادة بعد"
              description="اطلب من مشرف المادة رمز الانضمام أو رابط الدعوة أو رمز QR."
              actions={<p className="ch-node__state">مكتبتك الشخصية تعمل كما هي دون قنوات.</p>}
            />
          ) : (
            <section className="ch-section" aria-labelledby="ch-mine-h">
              <h2 id="ch-mine-h" className="ch-section__title">
                قنواتي
              </h2>
              {groups.map((g) => (
                <div key={g.group} className="ch-group">
                  <h3 className="ml-group-header">{g.group}</h3>
                  <ul role="list" className="ml-list">
                    {g.items.map((s) => {
                      const unread = unreadBySubject.get(s.node.id) ?? 0;
                      return (
                        <ListItem
                          key={s.node.id}
                          to={`/subjects/${s.node.id}`}
                          leading={<GraduationCap size={20} />}
                          title={s.node.title}
                          subtitle={
                            <span className="ch-row__subtitle">
                              {s.node.viewer.course_follow && <span>تتابعها</span>}
                              {unread > 0 && <span>{unreadUpdatesAr(unread)}</span>}
                              {s.node.status === 'archived' && <span>مؤرشفة — للقراءة فقط</span>}
                            </span>
                          }
                          trailing={
                            s.roles.length > 0 ? (
                              <span className="ch-row__badges">
                                {s.roles.map((r) => (
                                  <RoleBadge key={r} role={r} />
                                ))}
                              </span>
                            ) : undefined
                          }
                        />
                      );
                    })}
                  </ul>
                </div>
              ))}
            </section>
          )}

          {mine.pending.length > 0 && (
            <section className="ch-section" aria-labelledby="ch-pending-h">
              <h2 id="ch-pending-h" className="ch-section__title">
                طلبات معلّقة
              </h2>
              <ul role="list" className="ml-list">
                {mine.pending.map((p) => (
                  <li key={p.node.id} className="ml-list__row ch-node">
                    <div className="ch-node__text">
                      <span>{p.node.title}</span>
                      <span className="ch-node__kind">{p.path.map((x) => x.title).join(' › ')}</span>
                    </div>
                    <StatusPill tone="info">طلبك قيد المراجعة</StatusPill>
                  </li>
                ))}
              </ul>
              <p className="ml-group-footer">يصلك تنبيه عند قرار المشرف.</p>
            </section>
          )}

          <section className="ch-section" aria-labelledby="ch-browse-h">
            <h2 id="ch-browse-h" className="ch-section__title">
              تصفّح
            </h2>
            {roots.length === 0 ? (
              <p className="ch-node__state">لا توجد جامعات على هذا الخادم بعد. ينشئها مسؤول المنصة من «أنا» › «إدارة القنوات».</p>
            ) : (
              <ul role="list" className="ml-list">
                {roots.map(({ node }) => (
                  <ListItem key={node.id} to={`/channels/${node.id}`} leading={<Building2 size={20} />} title={node.title} subtitle={node.status === 'archived' ? 'مؤرشفة' : undefined} />
                ))}
              </ul>
            )}
            {tree.data.truncated && <p className="ml-group-footer">الشجرة أكبر من أن تُعرض كاملة هنا؛ تصفّح من الجامعة.</p>}
          </section>
        </>
      )}
      <JoinSheet open={joinOpen} onClose={() => setJoinOpen(false)} onJoined={reload} />
    </div>
  );
}
