// «تصفّح» — /channels/:nodeId (P1-T4 step 3; IA §3.2, §4.1). One node of the university tree with its breadcrumbs, the
// viewer's standing there, and its children: a subject the viewer may enter opens its page; one they may not shows its
// name only and «يتطلب رمز انضمام» (titles are visible to every signed-in user; nothing else is). A subject node opens
// at its own page (/subjects/:id). Join decisions in the inbox link here.
import { useCallback, useEffect, useState } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { Building2, GraduationCap, Plus } from 'lucide-react';
import { CHANNEL_KIND_LABELS_AR, JOIN_POLICY_LABELS_AR, MEMBERSHIP_STATUS_LABELS_AR, type ChannelNodeDetail, type ChannelNodeView } from '@medlevo/shared';
import { Breadcrumbs, EmptyState, ErrorState, ListItem, LoadingState, StatusPill } from '../../design';
import { errorMessage, isApiError } from '../../lib/api';
import { usePageTitle } from '../../lib/usePageTitle';
import { useOnline } from '../../lib/useOnline';
import { channelsApi } from './api';
import { withCache } from './cache';
import { JoinSheet } from './JoinSheet';
import { CachedBanner, ReasonedButton, RoleBadge } from './ui';
import './channels.css';

interface Loaded {
  node: ChannelNodeDetail;
  children: ChannelNodeView[];
  cachedAt: number | null;
}

export function standingAr(v: ChannelNodeView['viewer']): string | null {
  const m = v.membership;
  if (!m) return null;
  if (m.status === 'pending') return 'طلبك قيد المراجعة';
  if (m.status === 'approved') return v.inherited_from ? `عضو (من ${v.inherited_from.title})` : 'عضو';
  return MEMBERSHIP_STATUS_LABELS_AR[m.status];
}

export function BrowseScreen() {
  const { nodeId = '' } = useParams();
  const online = useOnline();
  const [state, setState] = useState<{ data: Loaded | null; error: string | null; missing: boolean }>({ data: null, error: null, missing: false });
  const [joinOpen, setJoinOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  usePageTitle(state.data?.node.title ?? 'تصفّح القنوات');

  const request = `${nodeId}|${attempt}`;
  const [requested, setRequested] = useState(request);
  if (requested !== request) {
    setRequested(request);
    setState({ data: null, error: null, missing: false });
  }

  useEffect(() => {
    let alive = true;
    Promise.all([withCache(`node.${nodeId}`, () => channelsApi.node(nodeId)), withCache(`children.${nodeId}`, () => channelsApi.tree(nodeId, 1))])
      .then(([node, tree]) => {
        if (!alive) return;
        const children = tree.data.nodes.filter((x) => x.parent_id === nodeId);
        setState({ data: { node: node.data, children, cachedAt: node.cachedAt ?? tree.cachedAt }, error: null, missing: false });
      })
      .catch((e) => alive && setState({ data: null, error: errorMessage(e), missing: isApiError(e) && e.status === 404 }));
    return () => {
      alive = false;
    };
  }, [nodeId, attempt]);
  const reload = useCallback(() => setAttempt((a) => a + 1), []);

  const d = state.data;
  if (d?.node.kind === 'subject') return <Navigate to={`/subjects/${d.node.id}`} replace />;

  return (
    <div className="ml-page ml-page--narrow ch-screen">
      {state.missing ? (
        <EmptyState headingLevel={1} icon={<Building2 size={28} />} title="هذه القناة غير موجودة" description="ربما تغيّر الرابط. ابدأ من «القنوات»." />
      ) : state.error ? (
        <ErrorState message={state.error} onRetry={reload} />
      ) : !d ? (
        <LoadingState stage="جارٍ فتح القناة…" />
      ) : (
        <>
          <Breadcrumbs items={[{ label: 'القنوات', to: '/channels' }, ...d.node.path.map((p) => ({ label: p.title, to: `/channels/${p.id}` })), { label: d.node.title }]} />
          <header className="ml-page__header">
            <h1 className="ml-page__title">{d.node.title}</h1>
            <p className="ch-subject__meta">
              <span>{CHANNEL_KIND_LABELS_AR[d.node.kind]}</span>
              {standingAr(d.node.viewer) && <span>{standingAr(d.node.viewer)}</span>}
              {d.node.viewer.roles.map((r) => (
                <RoleBadge key={r} role={r} />
              ))}
              {d.node.status === 'archived' && <StatusPill tone="warning">مؤرشفة</StatusPill>}
            </p>
          </header>
          {d.cachedAt !== null && <CachedBanner at={d.cachedAt} />}
          {!d.node.viewer.membership && d.node.viewer.roles.length === 0 && d.node.status === 'active' && (
            <div className="ch-screen__actions">
              <p className="ch-node__state">{d.node.join_policy === 'closed' ? 'الانضمام بدعوة فقط.' : `الانضمام برمز من المشرف: ${JOIN_POLICY_LABELS_AR[d.node.join_policy]}.`}</p>
              {/* a node that takes members by invitation only accepts no code (review R8) */}
              {d.node.join_policy !== 'closed' && (
                <ReasonedButton icon={<Plus size={18} />} reason={!online || d.cachedAt !== null ? 'الانضمام يحتاج اتصالًا بالإنترنت.' : null} onClick={() => setJoinOpen(true)}>
                  انضم برمز أو QR
                </ReasonedButton>
              )}
            </div>
          )}
          <section className="ch-section" aria-labelledby="ch-children-h">
            <h2 id="ch-children-h" className="ch-section__title">
              داخل {d.node.title}
            </h2>
            {d.children.length === 0 ? (
              <p className="ch-node__state">لا توجد عقد تحت هذه القناة بعد.</p>
            ) : (
              <ul role="list" className="ml-list">
                {d.children.map((c) =>
                  c.kind !== 'subject' ? (
                    <ListItem key={c.id} to={`/channels/${c.id}`} leading={<Building2 size={20} />} title={c.title} subtitle={CHANNEL_KIND_LABELS_AR[c.kind]} />
                  ) : c.space_id ? (
                    <ListItem key={c.id} to={`/subjects/${c.id}`} leading={<GraduationCap size={20} />} title={c.title} subtitle={standingAr(c.viewer) ?? 'مادة'} />
                  ) : (
                    <li key={c.id} className="ml-list__row ch-node">
                      <GraduationCap size={20} aria-hidden="true" className="ch-banner__icon" />
                      <div className="ch-node__text">
                        <span>{c.title}</span>
                        <span className="ch-node__kind">{CHANNEL_KIND_LABELS_AR[c.kind]}</span>
                      </div>
                      <span className="ch-node__state">{c.viewer.membership?.status === 'pending' ? 'طلبك قيد المراجعة' : c.join_policy === 'closed' ? 'الانضمام بدعوة فقط' : 'يتطلب رمز انضمام'}</span>
                    </li>
                  ),
                )}
              </ul>
            )}
          </section>
        </>
      )}
      <JoinSheet open={joinOpen} onClose={() => setJoinOpen(false)} onJoined={reload} />
    </div>
  );
}
