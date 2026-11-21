// Robustness pass: on a host without a permanent disk (Cloudflare Containers, MEDLEVO_BACKUP_INTERVAL_MINUTES) the
// next boot restores the newest R2 copy, so a restart used to go back up to one interval in time. On SIGTERM the server
// now stops claiming jobs (running ones back in the queue), takes one final off-site backup and waits for it, bounded
// (src/index.ts). This covers the service part — OffsiteService.backupNowAndWait — against the in-process S3 fake.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { OFFSITE_JOB_KIND, offsiteService } from '../../src/modules/data/offsite';
import { createTestApp, type TestApp } from '../helpers/app';
import { FakeS3 } from './fake-s3';

const PART = 64 * 1024;
const KEY_B64 = randomBytes(32).toString('base64');

let fake: FakeS3;
const apps: TestApp[] = [];
const dirs: string[] = [];

beforeAll(async () => {
  fake = new FakeS3({ minPartBytes: PART });
  await fake.start();
});
afterAll(async () => {
  await fake.stop();
});
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  fake.objects.clear();
  fake.uploads.clear();
  fake.log.length = 0;
  fake.clearFaults();
});

function r2Env(): Record<string, string> {
  return {
    MEDLEVO_R2_ENDPOINT: fake.endpoint,
    MEDLEVO_R2_BUCKET: fake.bucket,
    MEDLEVO_R2_ACCESS_KEY_ID: fake.accessKeyId,
    MEDLEVO_R2_SECRET_ACCESS_KEY: fake.secretAccessKey,
    MEDLEVO_BACKUP_ENCRYPTION_KEY: KEY_B64,
    MEDLEVO_BACKUP_INTERVAL_MINUTES: '10',
  };
}

async function app(env: Record<string, string>): Promise<TestApp> {
  const parent = mkdtempSync(join(tmpdir(), 'medlevo-offsite-final-'));
  dirs.push(parent);
  const t = await createTestApp({ env: { MEDLEVO_DATA_DIR: join(parent, 'data'), ...env }, jobs: { backoffBaseMs: 0, backoffMaxMs: 0 } });
  apps.push(t);
  offsiteService(t.ctx).configure({ client: { sleep: async () => {}, maxAttempts: 3 }, encChunkSize: 4096, partSizeBytes: PART, verifyBoot: false });
  await t.login();
  await t.ctx.files.put(randomBytes(100 * 1024), { mime: 'application/pdf', originalName: 'lecture-1.pdf' });
  return t;
}

describe('final off-site backup at shutdown (backupNowAndWait)', () => {
  it('after the worker stopped: backs up, uploads to R2 and waits for it; other queued jobs stay queued in the copy', async () => {
    const t = await app(r2Env());
    t.ctx.jobs.register('pending_work', { version: '1', handler: async () => ({ ran: true }) });
    const pending = t.ctx.jobs.enqueue('pending_work', {});
    await t.ctx.jobs.stop();

    const out = await offsiteService(t.ctx).backupNowAndWait({ timeoutMs: 60_000 });
    expect(out.status, JSON.stringify(out)).toBe('uploaded');
    expect(out.run).toMatchObject({ trigger: 'schedule', status: 'uploaded', stage: 'done' });
    expect(fake.objects.has(out.run!.object_key!)).toBe(true);
    expect(t.ctx.jobs.get(out.run!.job!.id)!.status).toBe('completed');
    expect(t.ctx.jobs.get(pending.id)!.status).toBe('queued'); // only the backup ran
  });

  it('a backup left «running» by the stop (its job back in the queue) is replaced by a fresh one', async () => {
    const t = await app(r2Env());
    const old = offsiteService(t.ctx).start('schedule'); // queued, never run: what stop() leaves behind
    const out = await offsiteService(t.ctx).backupNowAndWait({ timeoutMs: 60_000 });
    expect(out.status).toBe('uploaded');
    expect(out.run!.id).not.toBe(old.id);
    const closed = t.ctx.db.get<{ status: string; error_detail: string }>('SELECT status, error_detail FROM data_offsite_backup WHERE id = ?', [old.id])!;
    expect(closed.status).toBe('failed');
    expect(closed.error_detail).toContain('إيقاف الخادم');
    expect(t.ctx.jobs.get(old.job!.id)!.status).toBe('cancelled');
    expect(t.ctx.jobs.list({ kind: OFFSITE_JOB_KIND, status: 'queued' }).jobs).toHaveLength(0);
  });

  it('not configured: skipped at once, nothing started', async () => {
    const t = await app({});
    const out = await offsiteService(t.ctx).backupNowAndWait({ timeoutMs: 60_000 });
    expect(out).toEqual({ status: 'skipped', reason: 'not_configured' });
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM data_offsite_backup')!.n).toBe(0);
  });

  it('R2 unreachable: reports failed (never throws), the server can exit', async () => {
    const t = await app(r2Env());
    fake.fail('UploadPart', 100, { status: 500 });
    fake.fail('PutObject', 100, { status: 500 });
    const out = await offsiteService(t.ctx).backupNowAndWait({ timeoutMs: 60_000 });
    expect(out.status).toBe('failed');
    expect(out.run?.status).not.toBe('uploaded');
  });
});
