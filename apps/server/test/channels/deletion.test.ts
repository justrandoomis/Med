// P1-T4 step 1 — account deletion and channels (PRD Q14, AOS-21.44; P1-T1's deletion participants): when an account is
// deleted its memberships stop (kept as «left» for the audit trail), its roles and pending invitations are revoked,
// and wherever it still appears (a member list, a role's «granted by») it shows as «طالب سابق», never the old name.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChannelRolesResponse, DeletionPreview, MembersResponse } from '@medlevo/shared';
import { finishPendingDeletions } from '../../src/modules/accounts/deletion';
import { channelsOf } from '../../src/modules/channels/service';
import { assignRole, call, type ChannelWorld, channelWorld, createCode, createNode, ok, person } from './helpers';

let w: ChannelWorld;
beforeAll(async () => {
  w = await channelWorld();
}, 120_000);
afterAll(async () => {
  await w?.close();
});

describe('a deleted account leaves the channels', () => {
  it('memberships end, roles and invitations are revoked, the name becomes «طالب سابق»', async () => {
    const uni = await createNode(w.t, w.pa, null, 'university', 'جامعة الحذف');
    const subj = await createNode(w.t, w.pa, uni.id, 'subject', 'مادة الحذف', { join_policy: 'open_with_code' });
    const other = await createNode(w.t, w.pa, uni.id, 'subject', 'مادة أخرى', { join_policy: 'closed' });
    const p = await person(w.t, 'leaving_student');
    ok(await call(w.t, p.h, 'POST', '/api/channels/join', { code: (await createCode(w.t, w.pa, subj.id, { requires_approval: false })).code }));
    await assignRole(w.t, w.pa, subj.id, p.user.id, 'contributor');
    ok(await call(w.t, w.pa, 'POST', `/api/channels/nodes/${other.id}/invitations`, { user_ids: [p.user.id] }));
    const viewer = w.t.ctx.tenancy.viewerOf(p.user, null);
    expect(channelsOf(w.t.ctx).access.accessToSpace(viewer, subj.space_id!)).toMatchObject({ access: 'member' });

    const preview = ok<DeletionPreview>(await call(w.t, p.h, 'POST', '/api/accounts/me/delete', { preview: true }));
    ok(await call(w.t, p.h, 'POST', '/api/accounts/me/delete', { confirm_token: preview.confirm_token, password: p.password }));
    await finishPendingDeletions(w.t.ctx);

    expect(channelsOf(w.t.ctx).access.accessToSpace(viewer, subj.space_id!)).toBeNull();
    const members = ok<MembersResponse>(await call(w.t, w.pa, 'GET', `/api/channels/nodes/${subj.id}/members`));
    const row = members.items.find((m) => m.user.id === p.user.id)!;
    expect(row).toMatchObject({ status: 'left', user: { display_name: 'طالب سابق', former: true } });
    expect(JSON.stringify(members)).not.toContain('leaving_student');
    const roles = ok<ChannelRolesResponse>(await call(w.t, w.pa, 'GET', `/api/channels/nodes/${subj.id}/roles`));
    expect(roles.roles.some((r) => r.user.id === p.user.id)).toBe(false);
    expect(w.t.ctx.system.db.get<{ status: string }>('SELECT status FROM channel_invitation WHERE invitee_user_id = ?', [p.user.id])!.status).toBe('revoked');
  });
});
