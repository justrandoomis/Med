// Wave-2 step 0 — the space routes P1-T5 needs are DECLARED in authz/spaceRoutes.ts with their minimum access in the
// subject (ARCHITECTURE_DELTA §5.5 gate 2, §7.4, §7.6), but none is registered: the allow-list in force
// (SPACE_ROUTES) holds only declarations whose handler is mounted, and in step 0 that is none. P1-T5 flips `mounted`
// in the same change that mounts a handler; this test then requires the handler to exist, and the boot hook already
// refuses any mounted space route that is not on the allow-list.
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSpaceRouteAllowList, SPACE_ROUTE_PREFIX } from '../../src/modules/authz/routes';
import { SPACE_ROUTE_DECLARATIONS, SPACE_ROUTES, type SpaceRouteDeclaration } from '../../src/modules/authz/spaceRoutes';
import type { SpaceAccess } from '../../src/system/binding';
import { createTestApp, type TestApp } from '../helpers/app';

const ACCESS: readonly SpaceAccess[] = ['guest_publication', 'member', 'moderator'];
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const ACTIONS = [
  'view', 'list', 'create', 'edit', 'delete', 'publish', 'approve', 'withdraw', 'moderate', 'fork', 'follow', 'comment', 'suggest',
  'vote', 'rate', 'write_layer', 'manage_members', 'manage_codes', 'assign_role', 'record', 'share_recording', 'view_audit',
  'view_stats', 'set_quota', 'operate',
];
const RESOURCES = ['channel_node', 'space', 'official_lecture', 'publication', 'layer', 'discussion', 'collab_doc', 'room', 'recording', 'file'];
const key = (d: Pick<SpaceRouteDeclaration, 'method' | 'path'>) => `${d.method} ${d.path}`;
const find = (method: string, rest: string) => SPACE_ROUTE_DECLARATIONS.find((d) => d.method === method && d.path === `${SPACE_ROUTE_PREFIX}${rest}`);

describe('P1-T5 space-route declarations (wave-2 step 0)', () => {
  it('every declaration names its module, step, minimum access in the subject and the authz check its handler makes', () => {
    expect(SPACE_ROUTE_DECLARATIONS.length).toBeGreaterThan(30);
    for (const d of SPACE_ROUTE_DECLARATIONS) {
      const k = key(d);
      expect(d.path.startsWith(`${SPACE_ROUTE_PREFIX}/`), k).toBe(true);
      expect(METHODS, k).toContain(d.method);
      expect(ACCESS, k).toContain(d.minAccess);
      expect(d.module, k).toMatch(/^[a-z]+$/);
      expect(d.owner, k).toBe('P1-T5');
      expect([1, 2, 3], k).toContain(d.step);
      expect(ACTIONS, k).toContain(d.check.action);
      expect(RESOURCES, k).toContain(d.check.resource);
      expect(d.ref, k).toMatch(/^ARCHITECTURE_DELTA §\d/);
      expect(typeof d.mounted, k).toBe('boolean');
    }
  });

  it('declares each method + path once, and the allow-list accepts all of them', () => {
    const keys = SPACE_ROUTE_DECLARATIONS.map(key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(() => createSpaceRouteAllowList(SPACE_ROUTE_DECLARATIONS)).not.toThrow();
  });

  it('the allow-list in force holds only mounted declarations: step 1 mounts its routes, step 2 «from-vault», step 3 the publications', () => {
    expect(SPACE_ROUTES).toEqual(SPACE_ROUTE_DECLARATIONS.filter((d) => d.mounted));
    // P1-T5 step 1: every step-1 route is mounted except the file token — a signed link to a SPACE file cannot be
    // redeemed yet (P1-T1's token redemption binds vaults only; reported in the step-1 report)
    const unmountedStep1 = SPACE_ROUTE_DECLARATIONS.filter((d) => d.step === 1 && !d.mounted).map(key);
    expect(unmountedStep1).toEqual([`POST ${SPACE_ROUTE_PREFIX}/files/:id/token`]);
    // P1-T5 step 2: promoting a private lecture to the subject (19H.4); the copy routes live in the vault (/api/copies)
    expect(SPACE_ROUTE_DECLARATIONS.filter((d) => d.step === 2 && d.mounted).map(key)).toEqual([`POST ${SPACE_ROUTE_PREFIX}/lectures/from-vault`]);
    // P1-T5 step 3: every course-only publication route (§7.6, Phase 1 part) — suggestions stay Phase 2, undeclared
    expect(SPACE_ROUTE_DECLARATIONS.filter((d) => d.step === 3 && !d.mounted).map(key)).toEqual([]);
    expect(SPACE_ROUTE_DECLARATIONS.filter((d) => d.step === 3 && d.mounted).map(key).sort()).toEqual(
      [
        `POST ${SPACE_ROUTE_PREFIX}/publications`,
        `POST ${SPACE_ROUTE_PREFIX}/publications/:publicationId/versions`,
        `PATCH ${SPACE_ROUTE_PREFIX}/publications/:publicationId`,
        `POST ${SPACE_ROUTE_PREFIX}/publications/:publicationId/withdraw`,
        `GET ${SPACE_ROUTE_PREFIX}/publications/:publicationId`,
        `GET ${SPACE_ROUTE_PREFIX}/publications/:publicationId/versions/:versionNo/items`,
        `GET ${SPACE_ROUTE_PREFIX}/publications/:publicationId/diff`,
        `GET ${SPACE_ROUTE_PREFIX}/lectures/:lectureId/publications`,
      ].sort(),
    );
  });

  it('all declarations can be mounted together (no clashing patterns) and each URL resolves to its own declaration', async () => {
    const app = Fastify();
    for (const d of SPACE_ROUTE_DECLARATIONS) app.route({ method: d.method as 'GET', url: d.path, handler: async () => ({ path: d.path }) });
    await app.ready();
    try {
      for (const d of SPACE_ROUTE_DECLARATIONS) {
        const url = d.path.replace(/:([A-Za-z]+)/g, (_m, p: string) => (p === 'versionNo' || p === 'n' ? '2' : `x_${p}`));
        const r = await app.inject({ method: d.method as 'GET', url, ...(d.method === 'GET' || d.method === 'DELETE' ? {} : { payload: {} }) });
        expect(r.json().path, key(d)).toBe(d.path);
      }
    } finally {
      await app.close();
    }
  });

  it('never lists the modules §5.5 keeps out of spaces, nor any write route of sources', () => {
    for (const d of SPACE_ROUTE_DECLARATIONS) {
      expect(d.path, key(d)).not.toMatch(/\/api\/spaces\/:spaceId\/(data|settings|control|auth|library|learning|exams|cases|accounts|platform|sync)(\/|$)/);
      if (d.module === 'sources' || d.module === 'files' || d.module === 'versions') {
        const readOnly = d.method === 'GET' || key(d).endsWith('/files/:id/token') || key(d).endsWith('/versions/:id/reprocess');
        expect(readOnly, key(d)).toBe(true);
      }
    }
    expect(SPACE_ROUTE_DECLARATIONS.some((d) => /\/sources\/upload|\/trash|\/purge|\/move/.test(d.path))).toBe(false);
  });

  it('Phase 1 has no guest access: course-only publications need membership (public ones arrive with Phase 2)', () => {
    expect(SPACE_ROUTE_DECLARATIONS.filter((d) => d.minAccess === 'guest_publication').map(key)).toEqual([]);
    expect(find('GET', '/publications/:publicationId')?.minAccess).toBe('member');
    expect(find('GET', '/publications/:publicationId/versions/:versionNo/items')?.minAccess).toBe('member');
  });

  it('moderator-only actions need moderator access in THIS subject (ARCHITECTURE_DELTA §5.3, §7.4)', () => {
    for (const [m, p] of [
      ['POST', '/lectures/:lectureId/approve'],
      ['POST', '/lectures/:lectureId/versions/:versionId/publish'],
      ['POST', '/lectures/:lectureId/page-map/decisions'],
      ['POST', '/lectures/:lectureId/withdraw'],
      ['POST', '/lectures/from-vault'],
      ['PATCH', '/subject/attachments/:attachmentId'],
      ['PUT', '/subject/exam-dates/:examDateId'],
      ['DELETE', '/subject/exam-dates/:examDateId'],
      ['GET', '/sources/versions/:id/processing'],
      ['POST', '/sources/versions/:id/reprocess'],
    ] as const) {
      expect(find(m, p)?.minAccess, `${m} ${p}`).toBe('moderator');
    }
  });

  it('routes a contributor may use are open to members at gate 2 and narrowed by a named authz check', () => {
    // a contributor is a member with a role: drafts, uploads, attachments and correction proposals (§5.3 «d», «M»)
    for (const [m, p, action] of [
      ['POST', '/lectures', 'create'],
      ['POST', '/lectures/:lectureId/upload', 'create'],
      ['POST', '/lectures/:lectureId/corrections', 'edit'],
      ['POST', '/subject/attachments', 'publish'],
    ] as const) {
      const d = find(m, p);
      expect(d?.minAccess, `${m} ${p}`).toBe('member');
      expect(d?.check.action, `${m} ${p}`).toBe(action);
    }
  });

  it('covers the §7.4 lecture routes and the Phase 1 §7.6 publication routes, and no Phase 2 suggestion route', () => {
    for (const [m, p] of [
      ['GET', '/lectures'],
      ['GET', '/lectures/:lectureId'],
      ['GET', '/lectures/:lectureId/versions/:versionId/compare/:toVersionId'],
      ['GET', '/lectures/:lectureId/offline-package'],
      ['GET', '/subject/attachments'],
      ['GET', '/subject/exam-dates'],
      ['GET', '/subject/events'],
      ['POST', '/publications'],
      ['POST', '/publications/:publicationId/versions'],
      ['PATCH', '/publications/:publicationId'],
      ['POST', '/publications/:publicationId/withdraw'],
      ['GET', '/publications/:publicationId/diff'],
      ['GET', '/lectures/:lectureId/publications'],
      ['GET', '/files/:id'],
      ['POST', '/files/:id/token'],
    ] as const) {
      expect(find(m, p), `${m} ${p}`).toBeDefined();
    }
    expect(SPACE_ROUTE_DECLARATIONS.some((d) => d.path.includes('suggestion'))).toBe(false);
  });

  it('declares the route that corrects a lecture’s title, number or date (review W2-step0 R9; AOS-2.2, 3.4, 3.18)', () => {
    const d = find('PATCH', '/lectures/:lectureId');
    expect(d?.minAccess).toBe('member'); // a contributor on their own draft; the check narrows it
    expect(d?.check).toEqual({ action: 'edit', resource: 'official_lecture' });
    expect(d?.mounted).toBe(true); // P1-T5 step 1
  });
});

describe('P1-T5 step 1 additions (review W2-step0 N1; AOS-18.9, 18.11)', () => {
  it('declares the corrections queue, its decision and the duplicates list for official moderators of THIS subject', () => {
    expect(find('GET', '/subject/corrections')).toMatchObject({ minAccess: 'moderator', step: 1, mounted: true });
    expect(find('POST', '/lectures/:lectureId/corrections/:correctionId/decide')).toMatchObject({ minAccess: 'moderator', step: 1, mounted: true, check: { action: 'edit', resource: 'official_lecture' } });
    expect(find('GET', '/subject/duplicates')).toMatchObject({ minAccess: 'moderator', step: 1, mounted: true });
  });
});

describe('the running server', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  }, 120_000);
  afterAll(async () => {
    await t?.close();
  });

  it('mounts a handler for every allow-listed space route, and no declared route that is not marked mounted', () => {
    for (const d of SPACE_ROUTE_DECLARATIONS) {
      const mounted = t.app.hasRoute({ method: d.method as 'GET', url: d.path });
      expect(mounted, `${key(d)} mounted=${String(d.mounted)}`).toBe(d.mounted);
    }
  });
});
