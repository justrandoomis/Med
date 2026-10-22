// AOS-21.43 — «نسخة من بياناتي» archives kept on the server count in the account's storage quota (they are bytes the
// account occupies on the server's disk, up to three of them). Without this an account could fill the disk with
// exports while its quota said «room left».
//   * the kept archives are part of storage.used_bytes (and of every quota check: an upload is refused when exports
//     filled the room);
//   * an export that cannot fit even alone is refused BEFORE a job starts (QUOTA_EXCEEDED kind 'storage', Arabic reason
//     that says exports count);
//   * a new export makes room by removing that account's OLDER archives first (it never leaves the account over quota
//     when dropping old archives is enough);
//   * user #1 (no limit) is unchanged.
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { QuotaView } from '@medlevo/shared';
import { exportsDir } from '../../src/modules/accounts/export';
import { createTestApp, CSRF, type TestApp } from '../helpers/app';
import { addUser, type ExtraUser } from '../helpers/tenancy';

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

const KB = 1024;

async function setup() {
  t = await createTestApp();
  await t.login();
  const sara = await addUser(t, 'sara');
  const h = await sara.login();
  return { t, sara, h };
}

/** a kept export archive of `size` bytes in the user's export folder (as the export job leaves it) */
function fakeArchive(app: TestApp, u: ExtraUser, name: string, size: number): void {
  const dir = exportsDir(app.ctx, u.vault.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), Buffer.alloc(size, 7));
}

const quota = async (app: TestApp, h: Record<string, string>) => (await app.app.inject({ method: 'GET', url: '/api/accounts/me/quota', headers: h })).json() as QuotaView;

describe('AOS-21.43 — export archives count in the storage quota', () => {
  it('the kept archives are part of the storage used', async () => {
    const { t: app, sara, h } = await setup();
    const before = (await quota(app, h)).storage.used_bytes;
    fakeArchive(app, sara, 'medlevo-export-20261022T080000Z-abcdefgh.tar.gz', 300 * KB);
    const after = (await quota(app, h)).storage.used_bytes;
    expect(after - before).toBe(300 * KB);
  });

  it('an upload is refused when exports took the room', async () => {
    const { t: app, sara, h } = await setup();
    const used = (await quota(app, h)).storage.used_bytes;
    app.ctx.system.quotas.setUserInternal(sara.user.id, { storage_bytes_limit: used + 200 * KB }, sara.user.id);
    fakeArchive(app, sara, 'medlevo-export-20261022T080000Z-abcdefgh.tar.gz', 190 * KB);
    // a 50 KB file would have fitted without the archive
    const err = await app.ctx.binding
      .run({ kind: 'vault', vaultId: sara.vault.id, viewer: { userId: sara.user.id, deviceId: null, isPlatformAdmin: false } }, () =>
        app.ctx.files.put(Buffer.alloc(50 * KB, 3), { mime: 'application/octet-stream' }),
      )
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'QUOTA_EXCEEDED', details: { kind: 'storage' } });
  });

  it('an export with no room at all is refused before any job starts', async () => {
    const { t: app, sara, h } = await setup();
    const used = (await quota(app, h)).storage.used_bytes;
    // the account is exactly full: no archive can fit
    app.ctx.system.quotas.setUserInternal(sara.user.id, { storage_bytes_limit: used }, sara.user.id);
    const res = await app.app.inject({ method: 'POST', url: '/api/accounts/me/export', headers: { ...h, ...CSRF } });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('QUOTA_EXCEEDED');
    expect(res.json().error.message).toMatch(/نسخة من بياناتك/);
    const jobs = (await app.app.inject({ method: 'GET', url: '/api/accounts/me/exports', headers: h })).json().exports;
    expect(jobs).toEqual([]);
  });

  it('an archive bigger than the room left fails with the reason; it is not kept and the earlier archive stays', async () => {
    const { t: app, sara, h } = await setup();
    const dir = exportsDir(app.ctx, sara.vault.id);
    fakeArchive(app, sara, 'medlevo-export-20261020T080000Z-aaaaaaaa.tar.gz', 10 * KB);
    const used = (await quota(app, h)).storage.used_bytes;
    // 10 bytes of room besides the earlier archive: even without it a new archive would not fit
    app.ctx.system.quotas.setUserInternal(sara.user.id, { storage_bytes_limit: used + 10 }, sara.user.id);
    const res = await app.app.inject({ method: 'POST', url: '/api/accounts/me/export', headers: { ...h, ...CSRF } });
    expect(res.statusCode, res.body).toBe(200);
    await app.ctx.binding.run({ kind: 'vault', vaultId: sara.vault.id, viewer: null }, () => app.ctx.jobs.drain());
    const list = (await app.app.inject({ method: 'GET', url: '/api/accounts/me/exports', headers: h })).json().exports as Array<{ status: string; error_ar: string | null }>;
    expect(list[0]!.status).toBe('failed');
    expect(list[0]!.error_ar).toMatch(/نسخة من بياناتك/);
    expect(readdirSync(dir).filter((n) => n.endsWith('.tar.gz'))).toEqual(['medlevo-export-20261020T080000Z-aaaaaaaa.tar.gz']);
  });

  it('a new export removes older archives first to stay within the quota', async () => {
    const { t: app, sara, h } = await setup();
    const dir = exportsDir(app.ctx, sara.vault.id);
    fakeArchive(app, sara, 'medlevo-export-20261020T080000Z-aaaaaaaa.tar.gz', 400 * KB);
    fakeArchive(app, sara, 'medlevo-export-20261021T080000Z-bbbbbbbb.tar.gz', 400 * KB);
    const used = (await quota(app, h)).storage.used_bytes; // includes the two old archives
    // room for the vault, its files and ONE more archive of about the vault's size — not for the two old ones as well
    app.ctx.system.quotas.setUserInternal(sara.user.id, { storage_bytes_limit: used - 400 * KB }, sara.user.id);
    const res = await app.app.inject({ method: 'POST', url: '/api/accounts/me/export', headers: { ...h, ...CSRF } });
    expect(res.statusCode, res.body).toBe(200);
    await app.ctx.binding.run({ kind: 'vault', vaultId: sara.vault.id, viewer: null }, () => app.ctx.jobs.drain());
    const left = readdirSync(dir).filter((n) => n.endsWith('.tar.gz'));
    expect(left).not.toContain('medlevo-export-20261020T080000Z-aaaaaaaa.tar.gz');
    const q = await quota(app, h);
    expect(q.storage.used_bytes).toBeLessThanOrEqual(q.storage.limit_bytes!);
    // the new archive is there and downloadable
    const list = (await app.app.inject({ method: 'GET', url: '/api/accounts/me/exports', headers: h })).json().exports as Array<{ status: string; download_url: string | null }>;
    expect(list[0]).toMatchObject({ status: 'completed' });
    expect(list[0]!.download_url).toBeTruthy();
  });

  it('user #1 (no limit) exports as before', async () => {
    t = await createTestApp();
    const owner = await t.login();
    const res = await t.app.inject({ method: 'POST', url: '/api/accounts/me/export', headers: { ...owner, ...CSRF } });
    expect(res.statusCode, res.body).toBe(200);
  });
});
