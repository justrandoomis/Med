// P1-T1 step 2 — encrypted per-vault backups, the in-place vault restore, and the whole-instance archive that leaves
// the server only encrypted once several accounts exist (ADR-0003 §3.6; PRD NFR-S3, AOS-21.36; reuses PL-0's MLVENC01).
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { VaultBackupView } from '@medlevo/shared';
import { currentEpoch } from '../../src/modules/data/epoch';
import { verifyBackup } from '../../src/modules/data/restore';
import { listVaultBackups, restoreVault, vaultBackupsDir } from '../../src/modules/data/vault-backup';
import { DecryptStream, parseBackupKey } from '../../src/lib/objectstore/encryption';
import { createTestApp, type TestApp } from '../helpers/app';
import { addUser } from '../helpers/tenancy';

const KEY_B64 = randomBytes(32).toString('base64');
const MARKER = 'VAULT-B-PRIVATE-MARKER-ملاحظة';
let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

async function setup(env: Record<string, string> = {}) {
  t = await createTestApp({ env, jobs: { backoffBaseMs: 0, backoffMaxMs: 0 } });
  const owner = await t.login();
  const b = await addUser(t, 'student-b');
  const hb = await b.login();
  await t.ctx.binding.run({ kind: 'vault', vaultId: b.vault.id, viewer: null }, () => t!.ctx.files.put(Buffer.from(`${MARKER} ${randomBytes(4000).toString('hex')}`), { mime: 'text/plain' }));
  return { t, owner, b, hb };
}

const inB = <T>(a: TestApp, vaultId: string, fn: () => T) => a.ctx.binding.run({ kind: 'vault', vaultId, viewer: null }, fn);

describe('per-vault backups', () => {
  it('without a key: a plain vault-layout archive that verifies on a sandbox', async () => {
    const { t: a, owner, b } = await setup();
    const res = await a.app.inject({ method: 'POST', url: `/api/platform/vaults/${b.vault.id}/backups`, headers: owner });
    expect(res.statusCode, res.body).toBe(201);
    const view = res.json() as VaultBackupView;
    expect(view).toMatchObject({ encrypted: false });
    expect(view.file_name).toMatch(/^medlevo-vault-.*\.tar\.gz$/);
    const v = await verifyBackup(join(vaultBackupsDir(a.ctx, b.vault.id), view.file_name), { workDir: a.config.tmpDir });
    expect(v.report.ok, JSON.stringify(v.report.checks.filter((c) => !c.ok))).toBe(true);
    expect(v.manifest!.layout).toBe('vault');
  });

  it('with MEDLEVO_BACKUP_ENCRYPTION_KEY: MLVENC01 on disk only (the plain archive never stays), verified only with the key', async () => {
    const { t: a, owner, b } = await setup({ MEDLEVO_BACKUP_ENCRYPTION_KEY: KEY_B64 });
    const view = (await a.app.inject({ method: 'POST', url: `/api/platform/vaults/${b.vault.id}/backups`, headers: owner })).json() as VaultBackupView;
    expect(view.encrypted).toBe(true);
    const dir = vaultBackupsDir(a.ctx, b.vault.id);
    expect(readdirSync(dir).sort()).toEqual([view.file_name, `${view.file_name}.sha256`].sort());
    const bytes = readFileSync(join(dir, view.file_name));
    expect(bytes.subarray(0, 8).toString('latin1')).toBe('MLVENC01');
    expect(bytes.includes(Buffer.from(MARKER))).toBe(false);
    const noKey = await verifyBackup(join(dir, view.file_name), { workDir: a.config.tmpDir });
    expect(noKey.report.ok).toBe(false);
    expect(noKey.report.checks[0]).toMatchObject({ name: 'decrypt', ok: false });
    const withKey = await verifyBackup(join(dir, view.file_name), { workDir: a.config.tmpDir, decryptionKey: parseBackupKey(KEY_B64) });
    expect(withKey.report.ok, JSON.stringify(withKey.report.checks.filter((c) => !c.ok))).toBe(true);
    // a non-admin cannot list, make or restore vault backups (the route does not exist for them)
    const hb = await b.login();
    expect((await a.app.inject({ method: 'GET', url: `/api/platform/vaults/${b.vault.id}/backups`, headers: hb })).statusCode).toBe(404);
  });
});

describe('restoring one vault in place', () => {
  it("puts back ONE account's data, keeps a rollback copy, resets only that vault's epoch and that user's sessions", async () => {
    const { t: a, owner, b, hb } = await setup({ MEDLEVO_BACKUP_ENCRYPTION_KEY: KEY_B64 });
    const ownerVault = a.ctx.tenancy.platformVaultBinding()!.vaultId;
    const view = (await a.app.inject({ method: 'POST', url: `/api/platform/vaults/${b.vault.id}/backups`, headers: owner })).json() as VaultBackupView;
    const filesBefore = inB(a, b.vault.id, () => a.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM stored_file')!.n);
    // after the backup B adds a file (the restore takes it away again)
    await inB(a, b.vault.id, () => a.ctx.files.put(randomBytes(3000), { mime: 'application/pdf' }));
    const epochB = inB(a, b.vault.id, () => currentEpoch(a.ctx.db)!.id);
    const epochOwner = inB(a, ownerVault, () => currentEpoch(a.ctx.db)!.id);

    const r = await restoreVault(a.ctx, b.vault.id, view.file_name);
    expect(r.ok, JSON.stringify(r.checks.filter((c) => !c.ok))).toBe(true);
    expect(r.sessions_revoked).toBeGreaterThan(0);
    expect(r.rollback_copy).toMatch(/^pre-restore-\d+\.sqlite$/);
    expect(existsSync(join(vaultBackupsDir(a.ctx, b.vault.id), r.rollback_copy!))).toBe(true);
    expect(a.ctx.system.vaults.byIdInternal(b.vault.id)!.status).toBe('active');
    expect(inB(a, b.vault.id, () => a.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM stored_file')!.n)).toBe(filesBefore);
    expect(inB(a, b.vault.id, () => currentEpoch(a.ctx.db)!.id)).not.toBe(epochB);
    expect(inB(a, ownerVault, () => currentEpoch(a.ctx.db)!.id)).toBe(epochOwner);
    // B must sign in again; the platform admin's own session is untouched
    expect((await a.app.inject({ method: 'GET', url: '/api/accounts/me', headers: hb })).statusCode).toBe(401);
    expect((await a.app.inject({ method: 'GET', url: '/api/accounts/me', headers: owner })).statusCode).toBe(200);
    const again = await b.login();
    expect((await a.app.inject({ method: 'GET', url: '/api/accounts/me', headers: again })).statusCode).toBe(200);
  });

  it("refuses another vault's archive and a damaged archive — nothing changes", async () => {
    const { t: a, owner, b } = await setup();
    const c = await addUser(a, 'student-c');
    const cView = (await a.app.inject({ method: 'POST', url: `/api/platform/vaults/${c.vault.id}/backups`, headers: owner })).json() as VaultBackupView;
    const bView = (await a.app.inject({ method: 'POST', url: `/api/platform/vaults/${b.vault.id}/backups`, headers: owner })).json() as VaultBackupView;
    // C's archive copied into B's folder: still C's — refused
    const { copyFileSync } = await import('node:fs');
    copyFileSync(join(vaultBackupsDir(a.ctx, c.vault.id), cView.file_name), join(vaultBackupsDir(a.ctx, b.vault.id), cView.file_name));
    const before = readFileSync(a.ctx.pool.pathOf('vault', b.vault.id)).length;
    const wrong = await restoreVault(a.ctx, b.vault.id, cView.file_name);
    expect(wrong.ok).toBe(false);
    expect(wrong.checks.some((x) => x.name === 'vault' && !x.ok)).toBe(true);
    // damage B's own archive
    const p = join(vaultBackupsDir(a.ctx, b.vault.id), bView.file_name);
    const bytes = readFileSync(p);
    bytes[Math.floor(bytes.length / 2)] = bytes[Math.floor(bytes.length / 2)]! ^ 0xff;
    writeFileSync(p, bytes);
    expect((await restoreVault(a.ctx, b.vault.id, bView.file_name)).ok).toBe(false);
    expect(a.ctx.system.vaults.byIdInternal(b.vault.id)!.status).toBe('active');
    expect(readFileSync(a.ctx.pool.pathOf('vault', b.vault.id)).length).toBe(before);
    expect(listVaultBackups(a.ctx, b.vault.id).some((x) => x.file_name.startsWith('pre-restore'))).toBe(false);
  });

  it('a vault in use is not swapped under a running request: the restore gives up and unlocks', async () => {
    const { t: a, owner, b } = await setup();
    const view = (await a.app.inject({ method: 'POST', url: `/api/platform/vaults/${b.vault.id}/backups`, headers: owner })).json() as VaultBackupView;
    const release = a.ctx.pool.acquire('vault', b.vault.id);
    const r = await restoreVault(a.ctx, b.vault.id, view.file_name, { idleTimeoutMs: 300 });
    release();
    expect(r.ok).toBe(false);
    expect(r.checks.at(-1)!.detail_ar).toMatch(/مستخدمة الآن/);
    expect(a.ctx.system.vaults.byIdInternal(b.vault.id)!.status).toBe('active');
  });
});

describe('whole-instance archive download', () => {
  it('one account: the plain archive as before (AC-30); several accounts: encrypted only, and refused without a key', async () => {
    t = await createTestApp({ jobs: { backoffBaseMs: 0, backoffMaxMs: 0 } });
    const owner = await t.login();
    await t.app.inject({ method: 'POST', url: '/api/data/backups', headers: owner, payload: {} });
    await t.ctx.jobs.drain();
    const id = (await t.app.inject({ method: 'GET', url: '/api/data/backups', headers: owner })).json().backups[0].id as string;
    const plain = await t.app.inject({ method: 'GET', url: `/api/data/backups/${id}/download`, headers: owner });
    expect(plain.statusCode).toBe(200);
    expect(plain.headers['content-type']).toBe('application/gzip');
    await addUser(t, 'student-b');
    const refused = await t.app.inject({ method: 'GET', url: `/api/data/backups/${id}/download`, headers: owner });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.message).toMatch(/MEDLEVO_BACKUP_ENCRYPTION_KEY/);
  });

  it('several accounts with the key: the download is MLVENC01 and decrypts to the very archive', async () => {
    t = await createTestApp({ env: { MEDLEVO_BACKUP_ENCRYPTION_KEY: KEY_B64 }, jobs: { backoffBaseMs: 0, backoffMaxMs: 0 } });
    const owner = await t.login();
    await addUser(t, 'student-b');
    await t.app.inject({ method: 'POST', url: '/api/data/backups', headers: owner, payload: {} });
    await t.ctx.jobs.drain();
    const backups = (await t.app.inject({ method: 'GET', url: '/api/data/backups', headers: owner })).json().backups;
    const res = await t.app.inject({ method: 'GET', url: `/api/data/backups/${backups[0].id}/download`, headers: owner });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/\.tar\.gz\.mlenc"/);
    expect(res.rawPayload.subarray(0, 8).toString('latin1')).toBe('MLVENC01');
    expect(Number(res.headers['content-length'])).toBe(res.rawPayload.length);
    const d = new DecryptStream(parseBackupKey(KEY_B64));
    const parts: Buffer[] = [];
    d.on('data', (c: Buffer) => parts.push(c));
    await new Promise<void>((resolve, reject) => {
      d.on('end', () => resolve());
      d.on('error', reject);
      d.end(res.rawPayload);
    });
    const archive = readFileSync(join(t.config.dataDir, 'backups', backups[0].file_name));
    expect(Buffer.concat(parts).equals(archive)).toBe(true);
  });
});

describe('whole-instance backup and missing or departing vaults (step-1 review, latent until step 2)', () => {
  it('a registered vault whose file is missing stops the backup with a reason and is never created empty', async () => {
    t = await createTestApp({ jobs: { backoffBaseMs: 0, backoffMaxMs: 0 } });
    const owner = await t.login();
    const b = await addUser(t, 'student-b');
    const path = t.ctx.pool.pathOf('vault', b.vault.id);
    expect(t.ctx.pool.close('vault', b.vault.id)).toBe(true);
    const { rmSync } = await import('node:fs');
    for (const s of ['', '-wal', '-shm']) rmSync(`${path}${s}`, { force: true });
    await t.app.inject({ method: 'POST', url: '/api/data/backups', headers: owner, payload: {} });
    await t.ctx.jobs.drain();
    const list = (await t.app.inject({ method: 'GET', url: '/api/data/backups', headers: owner })).json().backups;
    expect(list[0]).toMatchObject({ status: 'failed' });
    expect(list[0].error_ar).toMatch(/غير موجود/);
    expect(existsSync(path)).toBe(false);
  });

  it('a vault being deleted is left out of the archive (and the archive still verifies)', async () => {
    t = await createTestApp({ jobs: { backoffBaseMs: 0, backoffMaxMs: 0 } });
    const owner = await t.login();
    const b = await addUser(t, 'student-b');
    t.ctx.system.users.markDeletionPendingInternal(b.user.id);
    t.ctx.system.vaults.setStatusInternal(b.vault.id, 'deleting');
    await t.app.inject({ method: 'POST', url: '/api/data/backups', headers: owner, payload: {} });
    await t.ctx.jobs.drain();
    const row = (await t.app.inject({ method: 'GET', url: '/api/data/backups', headers: owner })).json().backups[0];
    expect(row.status).toMatch(/^completed/);
    const v = await verifyBackup(join(t.config.dataDir, 'backups', row.file_name), { workDir: t.config.tmpDir, bootCheck: false });
    expect(v.report.ok, JSON.stringify(v.report.checks.filter((c) => !c.ok))).toBe(true);
    expect(v.manifest!.vaults!.map((x) => x.vault_id)).not.toContain(b.vault.id);
  });
});
