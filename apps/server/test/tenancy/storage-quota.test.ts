// P1-T1 step 2 — per-user storage quotas (ARCHITECTURE_DELTA §14, PRD Q22). A vault's usage = its database file + the
// blobs it references (each once). Default 2 GB per student vault; user #1 keeps today's behaviour (no limit) until the
// platform admin sets one. Enforced when a signed-in user adds bytes; background work is counted but never refused.
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { Binding } from '../../src/system/binding';
import { createTestApp, type TestApp } from '../helpers/app';
import { addUser } from '../helpers/tenancy';
import { makePdf, text } from '../helpers/pdfgen';
import { multipart } from '../sources/helpers';

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

const viewerBinding = (vaultId: string, userId: string): Binding => ({ kind: 'vault', vaultId, viewer: { userId, deviceId: null, isPlatformAdmin: false } });

describe('storage quota', () => {
  it('defaults: user #1 has no limit; another account gets MEDLEVO_USER_STORAGE_QUOTA_MB; /me and /me/quota report real usage', async () => {
    t = await createTestApp({ env: { MEDLEVO_USER_STORAGE_QUOTA_MB: '2048' } });
    const owner = await t.login();
    const b = await addUser(t, 'student-b');
    const q1 = (await t.app.inject({ method: 'GET', url: '/api/accounts/me/quota', headers: owner })).json();
    expect(q1.storage.limit_bytes).toBeNull();
    expect(q1.storage.used_bytes).toBeGreaterThan(0); // the vault database itself
    const hb = await b.login();
    const qb = (await t.app.inject({ method: 'GET', url: '/api/accounts/me/quota', headers: hb })).json();
    expect(qb.storage.limit_bytes).toBe(2048 * 1024 * 1024);
    const me = (await t.app.inject({ method: 'GET', url: '/api/accounts/me', headers: hb })).json();
    expect(me.quota.storage).toEqual(qb.storage);
    // uploading adds the blob's size once
    await t.ctx.binding.run(viewerBinding(b.vault.id, b.user.id), () => t!.ctx.files.put(randomBytes(50_000), { mime: 'application/pdf' }));
    const after = (await t.app.inject({ method: 'GET', url: '/api/accounts/me/quota', headers: hb })).json();
    expect(after.storage.used_bytes - qb.storage.used_bytes).toBeGreaterThanOrEqual(50_000);
  });

  it("a signed-in user's new file over the limit is refused with QUOTA_EXCEEDED {kind, used, limit}; background work and the same bytes again pass", async () => {
    t = await createTestApp();
    t.ownerBinding();
    const b = await addUser(t, 'student-b');
    const base = t.ctx.quota.storageUsed(b.vault.id);
    const limit = base.bytes_db + base.bytes_files + 60_000;
    t.ctx.system.quotas.setUserInternal(b.user.id, { storage_bytes_limit: limit }, b.user.id);
    const first = randomBytes(40_000);
    await t.ctx.binding.run(viewerBinding(b.vault.id, b.user.id), () => t!.ctx.files.put(first, { mime: 'application/pdf' }));
    const err = await t.ctx.binding
      .run(viewerBinding(b.vault.id, b.user.id), () => t!.ctx.files.put(randomBytes(40_000), { mime: 'application/pdf' }))
      .then(
        () => null,
        (e: { code?: string; status?: number; details?: { kind: string; used: number; limit: number } }) => e,
      );
    expect(err).toMatchObject({ code: 'QUOTA_EXCEEDED', status: 409, details: { kind: 'storage', limit } });
    expect(err!.details!.used).toBeGreaterThanOrEqual(40_000);
    // nothing of the refused file stayed in the vault
    expect(t.ctx.binding.run(viewerBinding(b.vault.id, b.user.id), () => t!.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM stored_file')!.n)).toBe(1);
    // the same bytes again: no new row, nothing charged
    await expect(t.ctx.binding.run(viewerBinding(b.vault.id, b.user.id), () => t!.ctx.files.put(first, { mime: 'application/pdf' }))).resolves.toMatchObject({ deduplicated: true });
    // background work (a processing render: no viewer) is counted but never refused mid-way
    await expect(t.ctx.binding.run({ kind: 'vault', vaultId: b.vault.id, viewer: null }, () => t!.ctx.files.put(randomBytes(40_000), { mime: 'image/png' }))).resolves.toBeTruthy();
  });

  it('the upload route answers QUOTA_EXCEEDED with the Arabic reason (end to end)', async () => {
    t = await createTestApp();
    t.ownerBinding();
    const b = await addUser(t, 'student-b');
    const base = t.ctx.quota.storageUsed(b.vault.id);
    t.ctx.system.quotas.setUserInternal(b.user.id, { storage_bytes_limit: base.bytes_db + base.bytes_files + 100 }, b.user.id);
    const hb = await b.login();
    const node = await t.app.inject({ method: 'POST', url: '/api/library/nodes', headers: hb, payload: { parent_id: null, kind: 'folder', title: 'مادتي' } });
    expect(node.statusCode, node.body).toBe(200);
    const pdf = makePdf([{ content: text(72, 700, 14, 'Lecture one') }]);
    const body = multipart({ node_id: node.json().node.id }, [{ name: 'lecture.pdf', data: pdf, contentType: 'application/pdf' }]);
    const res = await t.app.inject({ method: 'POST', url: '/api/sources/upload', headers: { ...hb, 'content-type': body.contentType }, payload: body.payload });
    // the upload route reports each file: this one is refused with the quota's Arabic reason, nothing stored
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().results[0]).toMatchObject({ file_name: 'lecture.pdf', status: 'rejected' });
    expect(res.json().results[0].reason_ar).toMatch(/لا توجد مساحة كافية في حسابك/);
    expect(t.ctx.binding.run(viewerBinding(b.vault.id, b.user.id), () => t!.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM source')!.n)).toBe(0);
  });

  it('the platform admin sets and resets a limit; a non-admin cannot', async () => {
    t = await createTestApp();
    const admin = await t.login();
    const b = await addUser(t, 'student-b');
    const set = await t.app.inject({ method: 'PUT', url: `/api/platform/quotas/users/${b.user.id}`, headers: admin, payload: { storage_mb: 10 } });
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json().storage).toMatchObject({ limit_bytes: 10 * 1024 * 1024, explicit: true });
    expect(set.json().storage.used_bytes).toBeGreaterThan(0);
    const hb = await b.login();
    expect((await t.app.inject({ method: 'GET', url: '/api/accounts/me/quota', headers: hb })).json().storage.limit_bytes).toBe(10 * 1024 * 1024);
    expect((await t.app.inject({ method: 'GET', url: `/api/platform/quotas/users/${b.user.id}`, headers: hb })).statusCode).toBe(404);
    const reset = await t.app.inject({ method: 'PUT', url: `/api/platform/quotas/users/${b.user.id}`, headers: admin, payload: { storage_mb: null } });
    expect(reset.json().storage).toMatchObject({ limit_bytes: 2048 * 1024 * 1024, explicit: false });
    const audit = t.ctx.system.db.all<{ action: string }>(`SELECT action FROM security_audit WHERE action = 'quota_set'`);
    expect(audit).toHaveLength(2);
  });
});
