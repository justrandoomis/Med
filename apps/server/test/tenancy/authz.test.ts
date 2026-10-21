// P1-T1 step 1 — the authz policy core and the space-route allow-list (ARCHITECTURE_DELTA §5.5):
//   * deny by default; rules self-register; any deny wins; a failing rule never allows; hidden → 404, else 403;
//   * core rules: platform operations for platform admins only; a vault for its owner only (the admin included);
//   * gate 2: a route under /api/spaces/:spaceId is mounted only if it is on the allow-list (else the server refuses
//     to boot), and binds the space only for a viewer with the route's minimum access in THAT subject; 404 otherwise.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import { type ModuleEntry, MODULES } from '../../src/modules';
import { ALLOW, type AuthzRule, createAuthz, forbidden, HIDDEN, type MembershipProvider, type SpaceMembership } from '../../src/modules/authz/policy';
import { createSpaceRouteAllowList, isSpaceRouteUrl, SPACE_ROUTE_PREFIX } from '../../src/modules/authz/routes';
import { SPACE_ROUTES } from '../../src/modules/authz/spaceRoutes';
import type { SpaceRouteGrant, Viewer } from '../../src/system/binding';
import { type AuthHeaders, createTestApp, TEST_ORIGIN, type TestApp } from '../helpers/app';
import { processTemplateDir } from '../helpers/template';
import { addUser, type ExtraUser } from '../helpers/tenancy';

const admin: Viewer = { userId: 'U-ADMIN', deviceId: null, isPlatformAdmin: true };
const student: Viewer = { userId: 'U-STUDENT', deviceId: null, isPlatformAdmin: false };

describe('policy core', () => {
  it('deny by default: a resource with no rule is hidden (404), for everyone', () => {
    const authz = createAuthz();
    for (const v of [admin, student]) {
      expect(authz.can(v, 'view', { type: 'space', id: 'S1' })).toEqual(HIDDEN);
      expect(authz.can(v, 'edit', { type: 'layer', db: 'v:x', id: 'L1', kind: 'personal', ownerUserId: v.userId })).toEqual(HIDDEN);
      expect(() => authz.assert(v, 'view', { type: 'space', id: 'S1' })).toThrow(expect.objectContaining({ status: 404, code: 'NOT_FOUND' }));
    }
  });

  it('rules self-register; an allow allows; any deny wins over every allow; 403 when the viewer may see it', () => {
    const authz = createAuthz();
    authz.registerRule({ name: 't.space-view', resource: 'space', decide: (_v, a) => (a === 'view' ? ALLOW : null) });
    expect(authz.can(student, 'view', { type: 'space', id: 'S1' }).allowed).toBe(true);
    expect(authz.can(student, 'edit', { type: 'space', id: 'S1' })).toEqual(HIDDEN); // abstained → deny by default
    authz.registerRule({ name: 't.space-frozen', resource: 'space', decide: (_v, _a, r) => (r.type === 'space' && r.id === 'FROZEN' ? forbidden('المادة مجمدة.') : null) });
    expect(authz.can(student, 'view', { type: 'space', id: 'FROZEN' }).allowed).toBe(false);
    expect(() => authz.assert(student, 'view', { type: 'space', id: 'FROZEN' })).toThrow(expect.objectContaining({ status: 403, code: 'FORBIDDEN' }));
    expect(() => authz.registerRule({ name: 't.space-view', resource: 'space', decide: () => ALLOW })).toThrow(/already registered/);
    expect(authz.rules().map((r) => r.name)).toEqual(expect.arrayContaining(['core.platform-admin-only', 'core.own-vault-only', 't.space-view', 't.space-frozen']));
  });

  it('a rule that throws never allows (it hides), even next to an allow', () => {
    const authz = createAuthz();
    const boom: AuthzRule = {
      name: 't.boom',
      resource: 'publication',
      decide: () => {
        throw new Error('rule bug');
      },
    };
    authz.registerRule({ name: 't.allow-all', resource: 'publication', decide: () => ALLOW });
    authz.registerRule(boom);
    expect(authz.can(student, 'view', { type: 'publication', id: 'P' })).toEqual(HIDDEN);
  });

  it('core: platform operations are for platform admins only (404 for everyone else)', () => {
    const authz = createAuthz();
    expect(authz.can(admin, 'operate', { type: 'platform', operation: 'GET /api/data/backups' }).allowed).toBe(true);
    expect(authz.can(student, 'operate', { type: 'platform', operation: 'GET /api/data/backups' })).toEqual(HIDDEN);
  });

  it('core: a vault is its owner’s only — the platform admin included (no route reads another user’s vault)', () => {
    const authz = createAuthz();
    expect(authz.can(student, 'view', { type: 'vault', vaultId: 'V1', ownerUserId: student.userId }).allowed).toBe(true);
    expect(authz.can(admin, 'view', { type: 'vault', vaultId: 'V1', ownerUserId: student.userId })).toEqual(HIDDEN);
  });

  it('visibility keys: providers are merged, de-duplicated and sorted; none = only rows every member sees', () => {
    const authz = createAuthz();
    expect(authz.visibilityKeys(student, 'S1')).toEqual([]);
    authz.registerVisibilityKeys((v) => [`user:${v.userId}`, 'pub:1']);
    authz.registerVisibilityKeys(() => ['pub:1', 'group:a']);
    expect(authz.visibilityKeys(student, 'S1')).toEqual(['group:a', 'pub:1', 'user:U-STUDENT']);
  });
});

describe('space-route allow-list (gate 2)', () => {
  it('ships EMPTY in R1-b step 1 and only accepts entries under /api/spaces/:spaceId/', () => {
    expect(SPACE_ROUTES).toEqual([]);
    expect(isSpaceRouteUrl('/api/spaces/:spaceId/lectures')).toBe(true);
    expect(isSpaceRouteUrl('/api/spaces')).toBe(false);
    expect(isSpaceRouteUrl('/api/spacesx')).toBe(false);
    expect(() => createSpaceRouteAllowList([{ module: 'x', method: 'GET', path: '/api/library/tree', minAccess: 'member' }])).toThrow(/outside/);
    const list = createSpaceRouteAllowList([{ module: 'x', method: 'GET', path: `${SPACE_ROUTE_PREFIX}/a`, minAccess: 'member' }]);
    expect(list.find('HEAD', `${SPACE_ROUTE_PREFIX}/a`)).not.toBeNull(); // HEAD follows its GET
    expect(list.find('POST', `${SPACE_ROUTE_PREFIX}/a`)).toBeNull();
  });

  it('the server refuses to boot when a module mounts a space route that is not on the allow-list', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'medlevo-allowlist-'));
    const rogue: ModuleEntry = {
      name: 'rogue',
      prefix: '/api/spaces',
      plugin: async (app) => {
        app.get('/:spaceId/secret', async () => ({ leaked: true }));
      },
    };
    try {
      const config = loadConfig({ NODE_ENV: 'test', MEDLEVO_DATA_DIR: dataDir, MEDLEVO_ORIGIN: TEST_ORIGIN, MEDLEVO_LOG_LEVEL: 'silent' });
      let app: Awaited<ReturnType<typeof buildApp>> | null = null;
      const boot = (async () => {
        app = await buildApp({ config, overrides: { aiProvider: null, templateDir: processTemplateDir() }, modules: [...MODULES, rogue] });
        await app.ready();
      })();
      await expect(boot).rejects.toThrow(/space route not on the allow-list.*GET \/api\/spaces\/:spaceId\/secret/);
      await (app as Awaited<ReturnType<typeof buildApp>> | null)?.close().catch(() => undefined);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  describe('an allow-listed route binds the space only with access in that subject', () => {
    const grants: SpaceRouteGrant[] = [
      { module: 'tspace', method: 'GET', path: `${SPACE_ROUTE_PREFIX}/probe`, minAccess: 'member' },
      { module: 'tspace', method: 'POST', path: `${SPACE_ROUTE_PREFIX}/moderate`, minAccess: 'moderator' },
      { module: 'tspace', method: 'GET', path: `${SPACE_ROUTE_PREFIX}/publication`, minAccess: 'guest_publication' },
    ];
    const spaceModule: ModuleEntry = {
      name: 'tspace',
      prefix: '/api/spaces',
      plugin: async (app, { ctx }) => {
        const where = async () => {
          const b = ctx.binding.current();
          return { kind: b?.kind, space_id: b?.kind === 'space' ? b.spaceId : null, subject: b?.kind === 'space' ? b.subjectNodeId : null, access: b?.kind === 'space' ? b.access : null, path: ctx.db.path };
        };
        app.get('/:spaceId/probe', where);
        app.post('/:spaceId/moderate', where);
        app.get('/:spaceId/publication', where);
      },
    };
    let t: TestApp;
    let hA: AuthHeaders;
    let b: ExtraUser;
    let hB: AuthHeaders;
    const access = new Map<string, SpaceMembership>();
    const provider: MembershipProvider = { accessToSpace: (v, spaceId) => access.get(`${v.userId}/${spaceId}`) ?? null };
    let spacePath: string;

    beforeAll(async () => {
      t = await createTestApp({ modules: [...MODULES, spaceModule], spaceRoutes: grants });
      hA = await t.login();
      b = await addUser(t, 'student-b');
      hB = await b.login();
      for (const [id, status] of [
        ['SPACE1', 'active'],
        ['SPACE2', 'active'],
        ['ARCHIVED', 'archived'],
      ] as const) {
        const dbFile = t.ctx.pool.createFile('space', id);
        t.ctx.system.vaults.registerSpaceInternal({ id, title: id, dbFile });
        if (status !== 'active') t.ctx.system.db.run('UPDATE space SET status = ? WHERE id = ?', [status, id]);
      }
      spacePath = t.ctx.pool.pathOf('space', 'SPACE1');
      t.ctx.authz.setMembershipProvider(provider);
    }, 120_000);
    afterAll(async () => {
      await t?.close();
    });

    const get = (h: AuthHeaders | null, space: string, route = 'probe') =>
      t.app.inject({ method: route === 'moderate' ? 'POST' : 'GET', url: `/api/spaces/${space}/${route}`, headers: h ?? {}, ...(route === 'moderate' ? { payload: {} } : {}) });

    it('nobody is a member of anything by default (R1-b: memberships arrive with P1-T4) → 404', async () => {
      t.ctx.authz.setMembershipProvider({ accessToSpace: () => null });
      expect((await get(hA, 'SPACE1')).statusCode).toBe(404);
      t.ctx.authz.setMembershipProvider(provider);
    });

    it('member of SPACE1: bound to SPACE1’s database (never the vault), with the subject the membership names', async () => {
      access.set(`${b.user.id}/SPACE1`, { subjectNodeId: 'SUBJ-1', access: 'member' });
      const r = await get(hB, 'SPACE1');
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toEqual({ kind: 'space', space_id: 'SPACE1', subject: 'SUBJ-1', access: 'member', path: spacePath });
      // the same member has no access to SPACE2 (another subject): 404, existence never leaks
      expect((await get(hB, 'SPACE2')).statusCode).toBe(404);
      // and A, a platform admin with no membership, gets nothing either (admin is not a subject role)
      expect((await get(hA, 'SPACE1')).statusCode).toBe(404);
    });

    it('below the route’s level: a member on a moderator route → 403; a guest on a member route → 404', async () => {
      access.set(`${b.user.id}/SPACE1`, { subjectNodeId: 'SUBJ-1', access: 'member' });
      const mod = await get(hB, 'SPACE1', 'moderate');
      expect(mod.statusCode).toBe(403);
      expect(mod.json().error.code).toBe('FORBIDDEN');
      access.set(`${b.user.id}/SPACE1`, { subjectNodeId: 'SUBJ-1', access: 'guest_publication' });
      expect((await get(hB, 'SPACE1')).statusCode).toBe(404);
      expect((await get(hB, 'SPACE1', 'publication')).statusCode).toBe(200); // a guest route a guest may see
      access.set(`${b.user.id}/SPACE1`, { subjectNodeId: 'SUBJ-1', access: 'moderator' });
      expect((await get(hB, 'SPACE1', 'moderate')).statusCode).toBe(200);
    });

    it('a pending membership → 403 MEMBERSHIP_PENDING; unknown or archived spaces and unauthenticated calls are refused', async () => {
      access.set(`${b.user.id}/SPACE1`, { subjectNodeId: 'SUBJ-1', access: 'member', pending: true });
      const p = await get(hB, 'SPACE1');
      expect(p.statusCode).toBe(403);
      expect(p.json().error.code).toBe('MEMBERSHIP_PENDING');
      access.set(`${b.user.id}/ARCHIVED`, { subjectNodeId: 'SUBJ-9', access: 'moderator' });
      expect((await get(hB, 'ARCHIVED')).statusCode).toBe(404);
      access.set(`${b.user.id}/NOPE`, { subjectNodeId: 'SUBJ-9', access: 'moderator' });
      expect((await get(hB, 'NOPE')).statusCode).toBe(404);
      expect((await get(null, 'SPACE1')).statusCode).toBe(401);
    });
  });
});
