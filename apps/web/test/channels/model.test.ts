// P1-T4 step 3 — the pure model behind «القنوات», the join sheet and «إدارة القنوات» (IA §3.1, §4.1, §4.10; PRD
// AOS-2.11–2.13). Everything here is derived from what the server already decided: `space_id` is present only for a
// viewer who may enter the subject, `viewer.roles` carries the roles inherited down the tree, a pending membership is
// the viewer's own.
import { describe, expect, it } from 'vitest';
import type { ChannelKind, ChannelNodeView, ChannelRole, MembershipStatus } from '@medlevo/shared';
import { adminScopes, myChannels, parseJoinInput, pathOf, treeOrder } from '../../src/features/channels/model';
import { activeDestination, PRIMARY_DESTINATIONS } from '../../src/app/navigation';

function n(id: string, kind: ChannelKind, title: string, parent: string | null, over: Partial<ChannelNodeView> & { roles?: ChannelRole[]; membership?: { node: string; status: MembershipStatus } } = {}): ChannelNodeView {
  const { roles = [], membership, ...rest } = over;
  return {
    id,
    kind,
    title,
    parent_id: parent,
    title_en: null,
    ordinal: null,
    starts_on: null,
    ends_on: null,
    has_space: kind === 'subject',
    space_id: null,
    join_policy: 'approval',
    status: 'active',
    viewer: {
      membership: membership
        ? { id: `m_${membership.node}`, node: { id: membership.node, kind: 'subject', title: membership.node }, status: membership.status, join_method: 'class_code', created_at: 1, decided_at: null, reason_ar: null }
        : null,
      roles,
      inherited_from: null,
      course_follow: null,
    },
    ...rest,
  } as ChannelNodeView;
}

const TREE: ChannelNodeView[] = [
  n('u1', 'university', 'جامعة بغداد', null),
  n('c1', 'college', 'كلية الطب', 'u1'),
  n('s3', 'stage', 'المرحلة الثالثة', 'c1', { ordinal: 3 }),
  n('s2', 'stage', 'المرحلة الثانية', 'c1', { ordinal: 2 }),
  n('anat', 'subject', 'Anatomy', 's3', { space_id: 'sp_anat', membership: { node: 's3', status: 'approved' } }),
  n('phys', 'subject', 'Physiology', 's3', { space_id: 'sp_phys', membership: { node: 's3', status: 'approved' }, roles: ['subject_moderator'] }),
  n('bio', 'subject', 'Biochemistry', 's2', { membership: { node: 'bio', status: 'pending' } }),
  n('u2', 'university', 'جامعة البصرة', null),
  n('path', 'subject', 'Pathology', 'u2'),
];

describe('primary navigation (IA §3.1)', () => {
  it('has the five destinations in order; «الإعدادات» moved into «أنا»', () => {
    expect(PRIMARY_DESTINATIONS.map((d) => [d.to, d.label])).toEqual([
      ['/', 'الرئيسية'],
      ['/library', 'المكتبة'],
      ['/channels', 'القنوات'],
      ['/review', 'المراجعة'],
      ['/me', 'أنا'],
    ]);
  });

  it('marks the destination a screen belongs to', () => {
    const at = (p: string) => activeDestination(p)?.label ?? null;
    expect(at('/')).toBe('الرئيسية');
    expect(at('/library/abc')).toBe('المكتبة');
    expect(at('/channels')).toBe('القنوات');
    expect(at('/subjects/n1')).toBe('القنوات');
    expect(at('/subjects/sp1/lectures/l1')).toBe('القنوات');
    expect(at('/review/cards')).toBe('المراجعة');
    // «أنا» holds settings, the Control Center, downloads and channel administration
    for (const p of ['/me', '/me/devices', '/settings', '/control/storage', '/offline', '/admin', '/admin/members']) expect(at(p), p).toBe('أنا');
    // a prefix is a whole path segment
    expect(at('/channelsx')).toBeNull();
    expect(at('/notifications')).toBeNull();
    expect(at('/search')).toBeNull();
  });
});

describe('my channels (IA §4.1 «قنواتي»)', () => {
  it('lists the subjects the server lets the viewer enter, grouped by their place in the tree, with roles that are not Student', () => {
    const mine = myChannels(TREE);
    expect(mine.subjects.map((s) => [s.node.id, s.group, s.roles])).toEqual([
      ['anat', 'جامعة بغداد › كلية الطب › المرحلة الثالثة', []],
      ['phys', 'جامعة بغداد › كلية الطب › المرحلة الثالثة', ['subject_moderator']],
    ]);
    // a subject without space_id is not entered (Pathology of another university, Biochemistry pending)
    expect(mine.subjects.some((s) => s.node.id === 'path' || s.node.id === 'bio')).toBe(false);
  });

  it('lists the viewer’s own pending requests («طلبك قيد المراجعة»), not inherited ones', () => {
    const tree = [...TREE, n('x', 'subject', 'X', 'bio', { membership: { node: 'bio', status: 'pending' } })];
    expect(myChannels(tree).pending.map((p) => p.node.id)).toEqual(['bio']);
  });

  it('is empty for a user with no channel', () => {
    const none = TREE.map((x) => ({ ...x, space_id: null, viewer: { ...x.viewer, membership: null, roles: [] } }));
    expect(myChannels(none)).toEqual({ subjects: [], pending: [] });
  });

  it('builds breadcrumbs from the root, and a stable tree order (ordinal, then title)', () => {
    expect(pathOf(TREE, 'anat').map((p) => p.title)).toEqual(['جامعة بغداد', 'كلية الطب', 'المرحلة الثالثة']);
    expect(treeOrder(TREE).map((x) => [x.node.id, x.depth])).toEqual([
      ['u2', 0],
      ['path', 1],
      ['u1', 0],
      ['c1', 1],
      ['s2', 2],
      ['bio', 3],
      ['s3', 2],
      ['anat', 3],
      ['phys', 3],
    ]);
  });
});

describe('join input (AOS-2.11 / 2.12 / 2.13)', () => {
  it('reads a class code as typed on a phone (spaces, dashes, lower case, Arabic-Indic digits)', () => {
    expect(parseJoinInput('ab12-cd34')).toEqual({ kind: 'code', code: 'AB12CD34' });
    expect(parseJoinInput(' ٤٥٦٧ - wxyz ')).toEqual({ kind: 'code', code: '4567WXYZ' });
  });

  it('reads an invite link (any origin: only the token goes to this server) and a bare token', () => {
    const token = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456';
    expect(parseJoinInput(`https://medlevo.example/join/${token}`)).toEqual({ kind: 'link', token });
    expect(parseJoinInput(`/join/${token}?x=1`)).toEqual({ kind: 'link', token });
    expect(parseJoinInput(token)).toEqual({ kind: 'link', token });
  });

  it('refuses empty or impossible input with an Arabic reason', () => {
    for (const bad of ['', '   ', 'ab', 'https://x.example/other/path']) {
      const r = parseJoinInput(bad);
      expect(r.kind, bad).toBe('invalid');
      expect(r.kind === 'invalid' && /[؀-ۿ]/.test(r.reason_ar)).toBe(true);
    }
  });
});

describe('admin scopes (IA §4.10: every screen shows its scope)', () => {
  it('lists the nodes where the viewer holds one of the roles a section needs, in tree order, with the path as the label', () => {
    const tree = [
      n('u1', 'university', 'جامعة بغداد', null),
      n('c1', 'college', 'كلية الطب', 'u1', { roles: ['admin'] }),
      n('s3', 'stage', 'المرحلة الثالثة', 'c1', { roles: ['admin'] }),
      n('anat', 'subject', 'Anatomy', 's3', { roles: ['admin', 'subject_moderator'] }),
      n('u2', 'university', 'جامعة البصرة', null),
    ];
    expect(adminScopes(tree, ['admin', 'assistant'], false).map((s) => [s.node.id, s.label])).toEqual([
      ['c1', 'جامعة بغداد › كلية الطب'],
      ['s3', 'جامعة بغداد › كلية الطب › المرحلة الثالثة'],
      ['anat', 'جامعة بغداد › كلية الطب › المرحلة الثالثة › Anatomy'],
    ]);
    expect(adminScopes(tree, ['subject_moderator'], false).map((s) => s.node.id)).toEqual(['anat']);
    // the platform admin may act anywhere
    expect(adminScopes(tree, ['admin'], true).map((s) => s.node.id)).toEqual(['u2', 'u1', 'c1', 's3', 'anat']);
    expect(adminScopes(tree, ['contributor'], false)).toEqual([]);
  });
});
