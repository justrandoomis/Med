// P1-T4 step 1 — PRD Q4: «the owner (user #1) creates one university channel and administers it until delegating».
// On a real R1-a single-owner data directory migrated by P1-T1's journaled owner migration: the migrated owner signs in
// with the old password, is the platform admin, creates the first university with a subject (whose space file is
// created and registered), delegates it to an Admin — and the owner's own library is untouched by any of it.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChannelNodeView, ChannelTreeResponse } from '@medlevo/shared';
import { buildApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import { runOwnerMigration } from '../../src/system/ownerMigration';
import { createClock, CSRF, sessionCookie, TEST_ORIGIN } from '../helpers/app';
import { processTemplateDir } from '../helpers/template';
import { hashSecret } from '../../src/modules/auth/password';
import { buildLegacyFixture, copyLegacy, LEGACY_PASSWORD, LEGACY_USERNAME } from '../tenancy/legacy-fixture';

let work: string;
let app: FastifyInstance;
let h: { cookie: string } & typeof CSRF;

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'medlevo-owner-university-'));
  const fx = await buildLegacyFixture(work);
  const dir = copyLegacy(fx, join(work, 'migrated'));
  const config = loadConfig({ NODE_ENV: 'test', MEDLEVO_DATA_DIR: dir, MEDLEVO_ORIGIN: TEST_ORIGIN, MEDLEVO_LOG_LEVEL: 'silent', MEDLEVO_SCRYPT_LOG_N: '12' });
  await runOwnerMigration({ config, mode: 'apply', verifyBoot: false });
  app = await buildApp({ config, overrides: { aiProvider: null, templateDir: processTemplateDir(), clock: createClock() } });
  await app.ready();
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { ...CSRF, 'user-agent': 'vitest' }, payload: { username: LEGACY_USERNAME, password: LEGACY_PASSWORD } });
  expect(login.statusCode, login.body).toBe(200);
  h = { cookie: sessionCookie(login), ...CSRF };
}, 300_000);

afterAll(async () => {
  await app?.close();
  rmSync(work, { recursive: true, force: true });
});

const call = (method: 'GET' | 'POST', url: string, payload?: object, headers: object = h) => app.inject({ method, url, headers: headers as Record<string, string>, ...(payload ? { payload } : {}) });

describe('the migrated owner is the platform admin and creates the first university (PRD Q4)', () => {
  it('signs in with the old password as user #1, platform admin, legacy owner', async () => {
    const me = (await call('GET', '/api/accounts/me')).json() as { is_platform_admin: boolean; legacy_owner: boolean; username: string };
    expect(me).toMatchObject({ username: LEGACY_USERNAME, is_platform_admin: true, legacy_owner: true });
  });

  it('there is no channel yet; the owner creates the university and a subject with its own space', async () => {
    expect(((await call('GET', '/api/channels/tree')).json() as ChannelTreeResponse).nodes).toEqual([]);
    const libraryBefore = (await call('GET', '/api/library/tree')).body;
    const uni = (await call('POST', '/api/channels/nodes', { parent_id: null, kind: 'university', title: 'جامعة المالك' })).json() as ChannelNodeView;
    expect(uni).toMatchObject({ kind: 'university', title: 'جامعة المالك', parent_id: null });
    const subj = (await call('POST', '/api/channels/nodes', { parent_id: uni.id, kind: 'subject', title: 'علم الأحياء' })).json() as ChannelNodeView;
    expect(subj.has_space).toBe(true);
    expect(app.ctx.system.vaults.spaceByIdInternal(subj.space_id!)).toMatchObject({ status: 'active', title: 'علم الأحياء' });
    // the owner's private library (their vault) is untouched: channels live in the system DB and the subject's space
    expect((await call('GET', '/api/library/tree')).body).toBe(libraryBefore);
  });

  it('delegates: the owner makes a colleague Admin of the university, who then manages it', async () => {
    const { user } = app.ctx.tenancy.createAccount({ username: 'colleague', displayName: 'زميل', passwordHash: await hashSecret('colleague-pass-123', 12), recoveryHashes: [], isPlatformAdmin: false, timezone: 'Asia/Baghdad' });
    const uni = ((await call('GET', '/api/channels/tree')).json() as ChannelTreeResponse).nodes[0]!;
    expect((await call('POST', `/api/channels/nodes/${uni.id}/roles`, { user_id: user.id, role: 'admin' })).statusCode).toBe(200);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: CSRF, payload: { username: 'colleague', password: 'colleague-pass-123' } });
    const ch = { cookie: sessionCookie(login), ...CSRF };
    const college = await call('POST', '/api/channels/nodes', { parent_id: uni.id, kind: 'college', title: 'كلية الطب' }, ch);
    expect(college.statusCode, college.body).toBe(200);
    // and still cannot create a second university: only the platform admin creates roots
    expect((await call('POST', '/api/channels/nodes', { parent_id: null, kind: 'university', title: 'جامعة ثانية' }, ch)).statusCode).toBe(403);
  });
});
