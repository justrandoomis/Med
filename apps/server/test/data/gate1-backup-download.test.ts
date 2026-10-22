// GATE-1 (AOS-23.3 «no decorative controls», AC-30): on a server that has had several accounts a whole-instance archive
// leaves only encrypted. Without MEDLEVO_BACKUP_ENCRYPTION_KEY the download route answers 409 — but the backup list
// still offered a working-looking «نزّل النسخة» link, so the owner clicked and got nothing (e2e g7-ac30-restore failed
// with «download canceled»). The list now says why the download is unavailable, from the same rule the route applies.
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { BACKUP_DOWNLOAD_NEEDS_KEY_AR } from '../../src/modules/data/backups';
import { createTestApp, type TestApp } from '../helpers/app';
import { addUser } from '../helpers/tenancy';

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

const KEY_B64 = randomBytes(32).toString('base64');

async function oneBackup(a: TestApp) {
  const owner = await a.login();
  await a.app.inject({ method: 'POST', url: '/api/data/backups', headers: owner, payload: {} });
  await a.ctx.jobs.drain();
  const list = (await a.app.inject({ method: 'GET', url: '/api/data/backups', headers: owner })).json();
  return { owner, b: list.backups[0] as { id: string; status: string; download_url: string | null; download_blocked_ar?: string | null } };
}

describe('GATE-1: the backup list never offers a download the server will refuse', () => {
  it('one account only: the plain archive downloads and nothing is blocked', async () => {
    t = await createTestApp({ jobs: { backoffBaseMs: 0, backoffMaxMs: 0 } });
    const { owner, b } = await oneBackup(t);
    expect(b.status).toMatch(/^completed/);
    expect(b.download_url).toBeTruthy();
    expect(b.download_blocked_ar ?? null).toBeNull();
    const res = await t.app.inject({ method: 'GET', url: b.download_url!, headers: owner });
    expect(res.statusCode).toBe(200);
  });

  it('several accounts and no encryption key: the list carries the reason the route gives, and the route still refuses', async () => {
    t = await createTestApp({ jobs: { backoffBaseMs: 0, backoffMaxMs: 0 } });
    await t.login();
    await addUser(t, 'student-b');
    const { owner, b } = await oneBackup(t);
    expect(b.download_blocked_ar).toBe(BACKUP_DOWNLOAD_NEEDS_KEY_AR);
    const res = await t.app.inject({ method: 'GET', url: b.download_url!, headers: owner });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe(BACKUP_DOWNLOAD_NEEDS_KEY_AR);
  });

  it('several accounts with the key (as render.yaml generates it): the encrypted archive downloads and nothing is blocked', async () => {
    t = await createTestApp({ jobs: { backoffBaseMs: 0, backoffMaxMs: 0 }, env: { MEDLEVO_BACKUP_ENCRYPTION_KEY: KEY_B64 } });
    await t.login();
    await addUser(t, 'student-b');
    const { owner, b } = await oneBackup(t);
    expect(b.download_blocked_ar ?? null).toBeNull();
    const res = await t.app.inject({ method: 'GET', url: b.download_url!, headers: owner });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['content-disposition'])).toContain('.mlenc');
  });
});
