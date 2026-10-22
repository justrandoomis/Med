// AOS-21.18 (ARCHITECTURE_DELTA §4.1 `2100_permissions`, §5.1–§5.3) — role assignments, ACL GRANTS and one central
// policy check. Until now `acl_grant` existed unused. In Phase 1 a per-resource grant is what a member holds on a
// course-only publication once they took a fork or a followed copy of it: a durable `view` grant, read by the ONE
// policy (modules/authz) through its grant provider — so the holder still reads a hidden or withdrawn explanation's
// state, and nobody else does.
//   * the policy reads grants: an active `view` grant lets a member read a hidden publication; it gives no other power
//     (edit stays the author's); a grant on another publication, in another subject's space, revoked or expired, does
//     nothing; a grant never lets a NON-member in (membership is asked first);
//   * a higher permission implies the lower ones (comment ⊇ view);
//   * the copy services write it: following / forking a publication grants `view` to the holder; the author's account
//     deletion ends the holder's copies AND revokes their grants.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartStudyingResponse } from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import { createAuthz, type Authz } from '../../src/modules/authz/policy';
import { registerPublicationRules } from '../../src/modules/authz/rules/publications';
import type { Viewer } from '../../src/system/binding';
import { createTestApp, type TestApp } from '../helpers/app';
import { addUser, type ExtraUser } from '../helpers/tenancy';
import { call, ok } from '../channels/helpers';
import { createLayer, createPubWorld, publish, type PubWorld, startPersonal, strokes } from '../forks/pubWorld';

const SPACE = 'SPACEACL';
const OTHER_SPACE = 'SPACEOTHER';

describe('AOS-21.18 — the central policy reads ACL grants', () => {
  let t: TestApp;
  let authz: Authz;
  let author: ExtraUser;
  let grantee: ExtraUser;
  let stranger: ExtraUser;
  const v = (u: ExtraUser): Viewer => ({ userId: u.user.id, deviceId: null, isPlatformAdmin: false });
  const pub = (id: string, status: 'active' | 'hidden_by_moderator' | 'withdrawn' = 'hidden_by_moderator', spaceId = SPACE) =>
    ({ type: 'publication', id, spaceId, authorUserId: author.user.id, status }) as const;

  beforeAll(async () => {
    t = await createTestApp();
    await t.login();
    author = await addUser(t, 'acl-author');
    grantee = await addUser(t, 'acl-grantee');
    stranger = await addUser(t, 'acl-stranger');
    authz = createAuthz();
    registerPublicationRules(authz);
    // author and grantee are members of SPACE (and of OTHER_SPACE); the stranger is a member of nothing
    authz.setMembershipProvider({
      accessToSpace: (viewer, spaceId) =>
        viewer.userId !== stranger.user.id && (spaceId === SPACE || spaceId === OTHER_SPACE) ? { subjectNodeId: `N-${spaceId}`, access: 'member' } : null,
    });
    authz.setGrantProvider(t.ctx.system.acl);
  }, 120_000);
  afterAll(async () => {
    await t?.close();
  });

  it('an active view grant lets a member read a hidden publication — and nothing more', () => {
    const id = newId();
    expect(authz.can(v(grantee), 'view', pub(id)).allowed).toBe(false);
    t.ctx.system.acl.grantInternal({ resourceType: 'publication', resourceDb: SPACE, resourceId: id, granteeUserId: grantee.user.id, permission: 'view', grantedBy: grantee.user.id });
    expect(authz.can(v(grantee), 'view', pub(id)).allowed).toBe(true);
    expect(authz.can(v(grantee), 'view', pub(id, 'withdrawn')).allowed).toBe(true);
    const edit = authz.can(v(grantee), 'edit', pub(id));
    expect(edit.allowed).toBe(false);
    expect(edit.reason!.hide).toBe(false); // seen, not editable
    // granting twice is idempotent (one active row)
    t.ctx.system.acl.grantInternal({ resourceType: 'publication', resourceDb: SPACE, resourceId: id, granteeUserId: grantee.user.id, permission: 'view', grantedBy: grantee.user.id });
    expect(t.ctx.system.acl.activeForInternal(grantee.user.id).filter((g) => g.resource_id === id)).toHaveLength(1);
  });

  it('a grant on another publication, in another space, revoked or expired, does nothing', () => {
    const id = newId();
    const other = newId();
    t.ctx.system.acl.grantInternal({ resourceType: 'publication', resourceDb: SPACE, resourceId: other, granteeUserId: grantee.user.id, permission: 'view', grantedBy: grantee.user.id });
    expect(authz.can(v(grantee), 'view', pub(id)).allowed).toBe(false);
    t.ctx.system.acl.grantInternal({ resourceType: 'publication', resourceDb: OTHER_SPACE, resourceId: id, granteeUserId: grantee.user.id, permission: 'view', grantedBy: grantee.user.id });
    expect(authz.can(v(grantee), 'view', pub(id)).allowed).toBe(false);
    t.ctx.system.acl.grantInternal({ resourceType: 'publication', resourceDb: SPACE, resourceId: id, granteeUserId: grantee.user.id, permission: 'view', grantedBy: grantee.user.id });
    expect(authz.can(v(grantee), 'view', pub(id)).allowed).toBe(true);
    expect(t.ctx.system.acl.revokeInternal({ resourceType: 'publication', resourceDb: SPACE, resourceId: id, granteeUserId: grantee.user.id })).toBe(1);
    expect(authz.can(v(grantee), 'view', pub(id)).allowed).toBe(false);
    const expiring = newId();
    t.ctx.system.acl.grantInternal({ resourceType: 'publication', resourceDb: SPACE, resourceId: expiring, granteeUserId: grantee.user.id, permission: 'view', grantedBy: grantee.user.id, expiresAt: t.ctx.clock.now() - 1 });
    expect(authz.can(v(grantee), 'view', pub(expiring)).allowed).toBe(false);
  });

  it('a grant never lets a non-member in; a higher permission implies view', () => {
    const id = newId();
    t.ctx.system.acl.grantInternal({ resourceType: 'publication', resourceDb: SPACE, resourceId: id, granteeUserId: stranger.user.id, permission: 'view', grantedBy: author.user.id });
    const d = authz.can(v(stranger), 'view', pub(id, 'active'));
    expect(d.allowed).toBe(false);
    expect(d.reason!.hide).toBe(true);
    const id2 = newId();
    t.ctx.system.acl.grantInternal({ resourceType: 'publication', resourceDb: SPACE, resourceId: id2, granteeUserId: grantee.user.id, permission: 'comment', grantedBy: author.user.id });
    expect(authz.can(v(grantee), 'view', pub(id2)).allowed).toBe(true);
  });
});

describe('AOS-21.18 — the copy services write and revoke the grants', () => {
  let w: PubWorld;
  let pubId: string;
  beforeAll(async () => {
    w = await createPubWorld(3);
    await startPersonal(w, 'hasan');
    const layer = await createLayer(w, 'hasan', 'شرحي');
    await strokes(w, 'hasan', layer, 0, 3);
    pubId = (await publish(w, 'hasan', [layer], 'شرح حسن')).id;
  }, 300_000);
  afterAll(async () => {
    await w?.close();
  });
  const grantsOf = (who: 'zainab' | 'ali' | 'noor') => w.t.ctx.system.acl.activeForInternal(w.p[who].user.id).filter((g) => g.resource_type === 'publication' && g.resource_id === pubId);

  it('following and forking a publication grant view to the holder (in the subject space); a member without a copy has none', async () => {
    for (const [who, mode] of [
      ['zainab', 'followed'],
      ['ali', 'independent_fork'],
    ] as const) {
      ok<StartStudyingResponse>(await call(w.t, w.p[who].h, 'POST', '/api/copies', { id: newId(), space_id: w.space, lecture_id: w.lecture.id, mode, publication_id: pubId }));
      expect(grantsOf(who), who).toEqual([expect.objectContaining({ resource_db: w.space, permission: 'view', grantee_user_id: w.p[who].user.id })]);
    }
    expect(grantsOf('noor')).toEqual([]);
  });

  it("the holder's grants are revoked when their copies end (account deletion path)", async () => {
    // the copy index ends every copy of a deleted account; the grants go with them
    const { publicationIndex } = await import('../../src/modules/forks/system');
    publicationIndex(w.t.ctx).authorDeleted(w.p.zainab.user.id);
    expect(grantsOf('zainab')).toEqual([]);
    expect(grantsOf('ali')).toHaveLength(1);
  });
});
