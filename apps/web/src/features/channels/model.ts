// The pure model behind «القنوات», the join sheet and «إدارة القنوات» (P1-T4 step 3; IA §4.1, §4.10). It only reads
// what the server already decided — it never decides access:
//  * `space_id` is present only for a viewer who may enter the subject (approved member or a role here or above);
//  * `viewer.roles` are the viewer's roles on the node, inherited down the tree;
//  * `viewer.membership` is the viewer's membership on the node or the nearest ancestor that carries one.
import { normalizeJoinCode, type ChannelNodeView, type ChannelRole, type NodeRef } from '@medlevo/shared';

const SEP = ' › ';

/** Breadcrumbs of a node from the root down to its parent (the node itself is not included). */
export function pathOf(nodes: readonly ChannelNodeView[], id: string): NodeRef[] {
  const byId = new Map(nodes.map((x) => [x.id, x]));
  const out: NodeRef[] = [];
  let cur = byId.get(id)?.parent_id ?? null;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const p = byId.get(cur);
    if (!p) break;
    out.unshift({ id: p.id, kind: p.kind, title: p.title });
    cur = p.parent_id;
  }
  return out;
}

export const pathLabel = (path: readonly NodeRef[]): string => path.map((p) => p.title).join(SEP);

const byOrdinalThenTitle = (a: ChannelNodeView, b: ChannelNodeView) =>
  (a.ordinal ?? Number.MAX_SAFE_INTEGER) - (b.ordinal ?? Number.MAX_SAFE_INTEGER) || a.title.localeCompare(b.title, 'ar');

/** Depth-first order of the tree (children by ordinal, then title) with each node's depth below its root. */
export function treeOrder(nodes: readonly ChannelNodeView[]): Array<{ node: ChannelNodeView; depth: number }> {
  const ids = new Set(nodes.map((x) => x.id));
  const children = new Map<string | null, ChannelNodeView[]>();
  for (const x of nodes) {
    // a node whose parent is not in this list (a subtree fetched with `root`) is listed as a root
    const key = x.parent_id && ids.has(x.parent_id) ? x.parent_id : null;
    const list = children.get(key) ?? [];
    list.push(x);
    children.set(key, list);
  }
  const out: Array<{ node: ChannelNodeView; depth: number }> = [];
  const walk = (parent: string | null, depth: number) => {
    for (const c of [...(children.get(parent) ?? [])].sort(byOrdinalThenTitle)) {
      out.push({ node: c, depth });
      walk(c.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

export interface MySubject {
  node: ChannelNodeView;
  path: NodeRef[];
  /** «جامعة بغداد › كلية الطب › المرحلة الثالثة» — the heading the subject is listed under */
  group: string;
  /** the viewer's roles there (none = a student, which is not shown) */
  roles: ChannelRole[];
}
export interface MyChannels {
  subjects: MySubject[];
  /** the viewer's own requests waiting for an approver */
  pending: Array<{ node: ChannelNodeView; path: NodeRef[] }>;
}

/** «قنواتي»: the subjects the viewer may enter, grouped by their place; the viewer's own pending requests. */
export function myChannels(nodes: readonly ChannelNodeView[]): MyChannels {
  const ordered = treeOrder(nodes).map((x) => x.node);
  const subjects: MySubject[] = [];
  const pending: MyChannels['pending'] = [];
  for (const node of ordered) {
    if (node.kind === 'subject' && node.space_id) {
      const path = pathOf(nodes, node.id);
      subjects.push({ node, path, group: pathLabel(path), roles: [...node.viewer.roles] });
    }
    const m = node.viewer.membership;
    if (m && m.status === 'pending' && m.node.id === node.id) pending.push({ node, path: pathOf(nodes, node.id) });
  }
  return { subjects, pending };
}

/** Does the viewer hold any channel role anywhere (or is the platform admin)? Decides whether «إدارة القنوات» shows. */
export function holdsAnyRole(nodes: readonly ChannelNodeView[], isPlatformAdmin: boolean): ChannelRole[] {
  const roles = new Set<ChannelRole>();
  for (const x of nodes) for (const r of x.viewer.roles) roles.add(r);
  if (isPlatformAdmin) roles.add('admin');
  return [...roles];
}

export interface AdminScope {
  node: ChannelNodeView;
  depth: number;
  /** the full path including the node: «نطاقك: …» */
  label: string;
}

/** The nodes a section of «إدارة القنوات» can work on: where the viewer holds one of `roles` (the platform admin: all). */
export function adminScopes(nodes: readonly ChannelNodeView[], roles: readonly ChannelRole[], isPlatformAdmin: boolean): AdminScope[] {
  return treeOrder(nodes)
    .filter(({ node }) => isPlatformAdmin || node.viewer.roles.some((r) => roles.includes(r)))
    .map(({ node, depth }) => ({ node, depth, label: pathLabel([...pathOf(nodes, node.id), { id: node.id, kind: node.kind, title: node.title }]) }));
}

// ───────────────────────────── join input ─────────────────────────────

export type JoinInput = { kind: 'code'; code: string } | { kind: 'link'; token: string } | { kind: 'invalid'; reason_ar: string };

const TOKEN = /^[A-Za-z0-9_-]{16,128}$/;
const JOIN_PATH = /(?:^|\/)join\/([A-Za-z0-9_-]{16,128})(?:[/?#]|$)/;
const CODE_CHARS = /^[0-9A-Z]+$/;

/**
 * What a person typed or pasted into «انضم برمز أو QR»: a class code («ABCD-EFGH», any case, spaces, dashes,
 * Arabic-Indic digits), an invite link (`…/join/<token>` of any origin — only the token is sent to this server) or a
 * bare token. The server decides whether it is valid.
 */
export function parseJoinInput(raw: string): JoinInput {
  const s = raw.trim();
  if (!s) return { kind: 'invalid', reason_ar: 'اكتب رمز الانضمام أو الصق رابط الدعوة.' };
  const looksLikeLink = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) || s.startsWith('/') || s.includes('/join/');
  if (looksLikeLink) {
    const m = JOIN_PATH.exec(s);
    if (m?.[1]) return { kind: 'link', token: m[1] };
    return { kind: 'invalid', reason_ar: 'هذا الرابط ليس رابط دعوة إلى قناة. اطلب من مشرف المادة رابط الدعوة أو رمز الانضمام.' };
  }
  const code = normalizeJoinCode(s);
  if (code.length === 8 && CODE_CHARS.test(code)) return { kind: 'code', code };
  if (TOKEN.test(s) && s.length > 12) return { kind: 'link', token: s };
  if (code.length < 4) return { kind: 'invalid', reason_ar: 'رمز الانضمام أقصر من المعتاد: 8 رموز مثل ABCD-EFGH.' };
  return { kind: 'code', code };
}
