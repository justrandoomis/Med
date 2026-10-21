// P1-T1 step 2 — «نسخة من بياناتي» and account deletion (BUILD_PLAN §3.3 «test/accounts/*»; ADR-0003 §3.6, §7 Q14;
// PRD AOS-21.43, AOS-21.44). The export contains only the user's own vault and the files it references; deleting the
// account removes the vault, its exports and its blob hints, calls the deletion participants, never touches another
// account, and leaves only an anonymous «طالب سابق» row. The last platform admin cannot delete their account.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AccountExportsResponse, BackupManifest, DeletionPreview } from '@medlevo/shared';
import { finishPendingDeletions, registerAccountDeletionParticipant } from '../../src/modules/accounts/deletion';
import { extractTarGz } from '../../src/modules/data/tar';
import { DEFAULT_RESTORE_LIMITS, verifyBackup } from '../../src/modules/data/restore';
import { createTestApp, type TestApp } from '../helpers/app';
import { addUser } from '../helpers/tenancy';

let t: TestApp | null = null;
const dirs: string[] = [];
afterEach(async () => {
  await t?.close();
  t = null;
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function twoUsers() {
  t = await createTestApp({ jobs: { backoffBaseMs: 0, backoffMaxMs: 0 } });
  const owner = await t.login();
  const b = await addUser(t, 'student-b');
  const hb = await b.login();
  return { t, owner, b, hb };
}

const note = (a: TestApp, vaultId: string, text: string) =>
  a.ctx.binding.run({ kind: 'vault', vaultId, viewer: null }, () => a.ctx.files.put(Buffer.from(text), { mime: 'text/plain', originalName: 'n.txt' }));

describe('«نسخة من بياناتي»', () => {
  it("contains the user's own vault and files only, in the per-vault format, and is downloadable by that user alone", async () => {
    const { t: a, owner, b, hb } = await twoUsers();
    const ownerVault = a.ctx.tenancy.platformVaultBinding()!.vaultId;
    await note(a, ownerVault, 'OWNER-PRIVATE-FILE');
    await note(a, b.vault.id, 'B-OWN-FILE');
    const start = await a.app.inject({ method: 'POST', url: '/api/accounts/me/export', headers: hb });
    expect(start.statusCode, start.body).toBe(200);
    expect((await a.app.inject({ method: 'POST', url: '/api/accounts/me/export', headers: hb })).statusCode).toBe(409); // one at a time
    await a.ctx.binding.run({ kind: 'vault', vaultId: b.vault.id, viewer: null }, () => a.ctx.jobs.drain());
    const list = (await a.app.inject({ method: 'GET', url: '/api/accounts/me/exports', headers: hb })).json() as AccountExportsResponse;
    expect(list.exports).toHaveLength(1);
    const ex = list.exports[0]!;
    expect(ex).toMatchObject({ status: 'completed' });
    expect(ex.download_url).toBeTruthy();
    const dl = await a.app.inject({ method: 'GET', url: ex.download_url!, headers: hb });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-type']).toBe('application/gzip');
    // the owner (platform admin) cannot fetch B's export: it is not a job of the owner's vault
    expect((await a.app.inject({ method: 'GET', url: ex.download_url!, headers: owner })).statusCode).toBe(404);

    const dir = mkdtempSync(join(tmpdir(), 'medlevo-export-'));
    dirs.push(dir);
    const archive = join(dir, 'export.tar.gz');
    const { writeFileSync, readFileSync } = await import('node:fs');
    writeFileSync(archive, dl.rawPayload);
    const ext = await extractTarGz(archive, join(dir, 'x'), DEFAULT_RESTORE_LIMITS);
    const manifest = JSON.parse(readFileSync(ext.entries.find((e) => e.path.endsWith('manifest.json'))!.absPath, 'utf8')) as BackupManifest;
    expect(manifest.layout).toBe('vault');
    expect(manifest.vaults!.map((v) => v.vault_id)).toEqual([b.vault.id]);
    expect(manifest.account).toMatchObject({ user_id: b.user.id, username: 'student-b' });
    expect(manifest.system).toBeUndefined();
    expect(ext.entries.some((e) => e.path.endsWith('system.sqlite'))).toBe(false);
    const bodies = ext.entries.filter((e) => e.path.includes('/files/')).map((e) => readFileSync(e.absPath, 'utf8'));
    expect(bodies).toContain('B-OWN-FILE');
    expect(bodies).not.toContain('OWNER-PRIVATE-FILE');
    // and it is a valid, restorable per-vault archive (verified on a sandbox)
    const v = await verifyBackup(archive, { workDir: dir });
    expect(v.report.ok, JSON.stringify(v.report.checks.filter((c) => !c.ok))).toBe(true);
  });
});

describe('account deletion (PRD Q14)', () => {
  it('preview → token + password → the vault, its exports and hints are gone; another account is untouched; the row is anonymous', async () => {
    const { t: a, owner, b, hb } = await twoUsers();
    const calls: string[] = [];
    registerAccountDeletionParticipant(a.ctx, { name: 'test-publications', run: (_ctx, who) => void calls.push(who.userId) });
    const ownerVault = a.ctx.tenancy.platformVaultBinding()!.vaultId;
    const shared = randomBytes(2000);
    await a.ctx.binding.run({ kind: 'vault', vaultId: ownerVault, viewer: null }, () => a.ctx.files.put(shared, { mime: 'application/pdf' }));
    const fb = await a.ctx.binding.run({ kind: 'vault', vaultId: b.vault.id, viewer: null }, () => a.ctx.files.put(shared, { mime: 'application/pdf' }));
    expect(a.ctx.system.blobs.hintCountInternal(fb.sha256)).toBe(2);
    // an export exists
    await a.app.inject({ method: 'POST', url: '/api/accounts/me/export', headers: hb });
    await a.ctx.binding.run({ kind: 'vault', vaultId: b.vault.id, viewer: null }, () => a.ctx.jobs.drain());

    const preview = (await a.app.inject({ method: 'POST', url: '/api/accounts/me/delete', headers: hb, payload: { preview: true } })).json() as DeletionPreview;
    expect(preview.blocked_ar).toBeNull();
    expect(preview.vault.bytes).toBeGreaterThan(0);
    expect(preview.policy_ar.join(' ')).toMatch(/طالب سابق/);
    expect(preview.publications).toEqual({ total: 0, forked_by_others: 0 });
    // a wrong password changes nothing; another user's token is refused
    expect((await a.app.inject({ method: 'POST', url: '/api/accounts/me/delete', headers: hb, payload: { confirm_token: preview.confirm_token, password: 'wrong-password-123' } })).statusCode).toBe(403);
    expect((await a.app.inject({ method: 'POST', url: '/api/accounts/me/delete', headers: owner, payload: { confirm_token: preview.confirm_token, password: 'test-password-123' } })).statusCode).toBe(409);
    expect(a.ctx.system.users.byIdInternal(b.user.id)!.status).toBe('active');

    const vaultPath = a.ctx.pool.pathOf('vault', b.vault.id);
    const del = await a.app.inject({ method: 'POST', url: '/api/accounts/me/delete', headers: hb, payload: { confirm_token: preview.confirm_token, password: b.password } });
    expect(del.statusCode, del.body).toBe(200);
    expect(del.json()).toEqual({ status: 'deletion_pending' });
    // signed out everywhere at once, and the vault cannot be bound any more
    expect((await a.app.inject({ method: 'GET', url: '/api/accounts/me', headers: hb })).statusCode).toBe(401);
    await finishPendingDeletions(a.ctx);

    expect(existsSync(vaultPath)).toBe(false);
    expect(existsSync(join(a.config.dataDir, 'exports', b.vault.id))).toBe(false);
    expect(a.ctx.system.vaults.byIdInternal(b.vault.id)!.status).toBe('deleted');
    const row = a.ctx.system.users.byIdInternal(b.user.id)!;
    expect(row).toMatchObject({ status: 'deleted', display_name: '', username: `deleted:${b.user.id}` });
    expect(a.ctx.system.users.findForAuth('student-b')).toBeNull(); // the login name is free again
    expect(a.ctx.system.blobs.hintCountInternal(fb.sha256)).toBe(1); // the owner's hint stays
    expect(calls).toEqual([b.user.id]);
    // the bytes the owner shares stay readable; signing in as B is impossible
    expect((await a.app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-medlevo-csrf': '1' }, payload: { username: 'student-b', password: b.password } })).statusCode).toBe(401);
    const ownerFiles = a.ctx.binding.run({ kind: 'vault', vaultId: ownerVault, viewer: null }, () => a.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM stored_file')!.n);
    expect(ownerFiles).toBe(1);
    expect((await a.app.inject({ method: 'GET', url: '/api/accounts/me', headers: owner })).statusCode).toBe(200);
    const audit = a.ctx.system.db.all<{ action: string }>(`SELECT action FROM security_audit WHERE target_id = ? ORDER BY created_at`, [b.user.id]).map((r) => r.action);
    expect(audit).toEqual(expect.arrayContaining(['account_delete', 'account_deleted']));
  });

  it('the last platform admin cannot delete their account', async () => {
    const { t: a, owner } = await twoUsers();
    const preview = (await a.app.inject({ method: 'POST', url: '/api/accounts/me/delete', headers: owner, payload: { preview: true } })).json() as DeletionPreview;
    expect(preview.blocked_ar).toMatch(/آخر مسؤول/);
    const del = await a.app.inject({ method: 'POST', url: '/api/accounts/me/delete', headers: owner, payload: { confirm_token: preview.confirm_token, password: 'test-password-123' } });
    expect(del.statusCode).toBe(409);
    expect(a.ctx.system.users.firstUserIdInternal()).toBeTruthy();
  });

  it('a deletion interrupted after its first step is finished at the next boot / tick (idempotent)', async () => {
    const { t: a, b } = await twoUsers();
    // step 1 happened, then the process stopped
    a.ctx.system.users.markDeletionPendingInternal(b.user.id);
    a.ctx.system.vaults.setStatusInternal(b.vault.id, 'deleting');
    expect(await finishPendingDeletions(a.ctx)).toBe(1);
    expect(await finishPendingDeletions(a.ctx)).toBe(0);
    expect(a.ctx.system.users.byIdInternal(b.user.id)!.status).toBe('deleted');
  });

  it('a vault still in use is not removed under its user: the deletion waits and completes later', async () => {
    const { t: a, b } = await twoUsers();
    a.ctx.system.users.markDeletionPendingInternal(b.user.id);
    const release = a.ctx.pool.acquire('vault', b.vault.id); // a request or job still holds it
    a.ctx.system.vaults.setStatusInternal(b.vault.id, 'deleting');
    expect(await finishPendingDeletions(a.ctx)).toBe(0);
    expect(existsSync(a.ctx.pool.pathOfFile('vault', b.vault.db_file))).toBe(true);
    release();
    expect(await finishPendingDeletions(a.ctx)).toBe(1);
  });
});
