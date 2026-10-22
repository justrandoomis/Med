// Who is administering (P1-T4 step 3): the signed-in account (platform admin or not) and the channel tree with the
// viewer's roles inherited down it — read once by the area and shared with every section through a context. It only
// decides what the MENU shows; the server decides every action (404 for what the viewer may not see, 403 for what they
// may not do).
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { ChannelNodeView, ChannelRole } from '@medlevo/shared';
import { Select } from '../../design';
import { errorMessage } from '../../lib/api';
import { accountApi, channelsApi } from '../channels/api';
import { dropCache, withCache } from '../channels/cache';
import { adminScopes, holdsAnyRole, type AdminScope } from '../channels/model';

export interface AdminViewer {
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  isPlatformAdmin: boolean;
  /** (AOS-20.19) the signed-in account — a decision someone took first is said to be by «مستخدم آخر» or by this account */
  userId: string | null;
  /** every role the viewer holds somewhere (the platform admin counts as an Admin everywhere) */
  roles: ChannelRole[];
  nodes: ChannelNodeView[];
  /** when the shown tree is the copy saved on this device (offline) */
  cachedAt: number | null;
  /** ask the server again (after a change) */
  reload: () => void;
}

export function useLoadAdminViewer(): AdminViewer {
  const [s, setS] = useState<Omit<AdminViewer, 'reload'>>({ status: 'loading', error: null, isPlatformAdmin: false, userId: null, roles: [], nodes: [], cachedAt: null });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    Promise.all([withCache('me', () => accountApi.me()), withCache('tree', () => channelsApi.tree())])
      .then(([me, tree]) => {
        if (!alive) return;
        const isPlatformAdmin = me.data.is_platform_admin;
        setS({ status: 'ready', error: null, isPlatformAdmin, userId: me.data.id ?? null, roles: holdsAnyRole(tree.data.nodes, isPlatformAdmin), nodes: tree.data.nodes, cachedAt: tree.cachedAt });
      })
      .catch((e) => alive && setS((p) => ({ ...p, status: 'error', error: errorMessage(e) })));
    return () => {
      alive = false;
    };
  }, [attempt]);
  const reload = useCallback(() => {
    dropCache('tree');
    setAttempt((a) => a + 1);
  }, []);
  return { ...s, reload };
}

const Ctx = createContext<AdminViewer | null>(null);

export function AdminViewerProvider({ value, children }: { value: AdminViewer; children: ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAdminViewer(): AdminViewer {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAdminViewer outside «إدارة القنوات»');
  return v;
}

/** The node a section works on: `?node=` when the viewer may act there, else the first such node (tree order). */
export function useAdminScope(roles: readonly ChannelRole[]): { scopes: AdminScope[]; current: AdminScope | null; choose: (id: string) => void } {
  const v = useAdminViewer();
  const [params, setParams] = useSearchParams();
  const rolesKey = roles.join(',');
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the roles' content, not the array's identity
  const scopes = useMemo(() => adminScopes(v.nodes, roles, v.isPlatformAdmin), [v.nodes, v.isPlatformAdmin, rolesKey]);
  const wanted = params.get('node');
  const current = scopes.find((s) => s.node.id === wanted) ?? scopes[0] ?? null;
  const choose = useCallback(
    (id: string) => {
      const next = new URLSearchParams(params);
      next.set('node', id);
      setParams(next, { replace: true });
    },
    [params, setParams],
  );
  return { scopes, current, choose };
}

/** «نطاقك: …» — every screen of the area shows its scope (IA §4.10), with a chooser when there is more than one. */
export function ScopeBar({ scope }: { scope: ReturnType<typeof useAdminScope> }) {
  const { scopes, current, choose } = scope;
  if (!current) return null;
  return (
    <div className="ad-scope">
      <p className="ad-scope__line">
        نطاقك: <strong>{current.label}</strong>
      </p>
      {scopes.length > 1 && (
        <Select
          label="غيّر النطاق"
          value={current.node.id}
          onValueChange={choose}
          options={scopes.map((s) => ({ value: s.node.id, label: `${'— '.repeat(s.depth)}${s.node.title}` }))}
        />
      )}
    </div>
  );
}
