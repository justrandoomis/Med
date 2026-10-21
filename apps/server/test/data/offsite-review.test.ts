// PL-0 adversarial review (2026-10-21): regressions for the defects the review confirmed in the off-site backup path,
// against the in-process S3 fake (./fake-s3.ts) and a deliberately slow local HTTP server — NOT Cloudflare R2.
//   1. failed off-site runs left a full local archive each on the persistent disk (no retention ran) → a misconfigured
//      R2 token filled the disk the live database lives on, one archive per day;
//   2. a run that finally failed left its multipart upload open in the bucket (stored, billed parts until R2's
//      lifecycle rule removes them);
//   3. a download was cut off by the per-request timeout even while bytes were arriving: every timeout used up one of
//      the few attempts, so a large archive on a slow link could never be restored;
//   4. the scheduler must not back up a fresh deploy before the owner account exists (claimed, not tested).
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { S3Client } from '../../src/lib/objectstore/s3';
import { backupsDir } from '../../src/modules/data/backups';
import { offsiteService } from '../../src/modules/data/offsite';
import { createTestApp, type TestApp } from '../helpers/app';
import { FakeS3 } from './fake-s3';

const PART = 64 * 1024;
const KEY_B64 = randomBytes(32).toString('base64');
const noSleep = async () => {};

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
  fake.rejected.length = 0;
  fake.clearFaults();
});

function r2Env(extra: Record<string, string> = {}): Record<string, string> {
  return {
    MEDLEVO_R2_ENDPOINT: fake.endpoint,
    MEDLEVO_R2_BUCKET: fake.bucket,
    MEDLEVO_R2_ACCESS_KEY_ID: fake.accessKeyId,
    MEDLEVO_R2_SECRET_ACCESS_KEY: fake.secretAccessKey,
    MEDLEVO_BACKUP_ENCRYPTION_KEY: KEY_B64,
    ...extra,
  };
}

async function app(env: Record<string, string>, o: { login?: boolean } = {}): Promise<TestApp> {
  const t = await createTestApp({ env, jobs: { backoffBaseMs: 0, backoffMaxMs: 0 } });
  apps.push(t);
  offsiteService(t.ctx).configure({ client: { sleep: noSleep, maxAttempts: 3 }, encChunkSize: 4096, partSizeBytes: PART, verifyBoot: false });
  if (o.login === false) return t; // P1-T1: no account yet → no vault to store files in
  await t.login();
  await t.ctx.files.put(randomBytes(150 * 1024), { mime: 'application/pdf', originalName: 'lecture-1.pdf' });
  await t.ctx.files.put(randomBytes(120 * 1024), { mime: 'application/pdf', originalName: 'lecture-2.pdf' });
  return t;
}

/** archives of off-site runs still on the server disk (rows not deleted, files present) */
function liveOffsiteArchives(t: TestApp): Array<{ id: string; file_name: string; run_status: string }> {
  const rows = t.ctx.db.all<{ id: string; file_name: string; run_status: string }>(
    `SELECT b.id, b.file_name, o.status AS run_status FROM data_backup b JOIN data_offsite_backup o ON o.backup_id = b.id
      WHERE b.deleted_at IS NULL ORDER BY b.created_at`,
  );
  return rows.filter((r) => r.file_name && existsSync(join(backupsDir(t.ctx), r.file_name)));
}

describe('a failing off-site setup never fills the server disk', () => {
  it('each failed run made a full local archive and none was ever removed; now only the newest stays', async () => {
    const t = await app(r2Env({ MEDLEVO_R2_SECRET_ACCESS_KEY: 'a-wrong-secret-pasted-into-render' }));
    const svc = offsiteService(t.ctx);
    // one failed run a day (the scheduler does not retry a slot): three days of a wrong secret
    for (let day = 0; day < 3; day++) {
      svc.start('manual');
      await t.ctx.jobs.drain();
      t.clock.advance(86_400_000);
    }
    const runs = t.ctx.db.all<{ status: string; error_detail: string }>('SELECT status, error_detail FROM data_offsite_backup ORDER BY created_at');
    expect(runs.map((r) => r.status)).toEqual(['failed', 'failed', 'failed']);
    expect(runs[2]!.error_detail).toContain('MEDLEVO_R2_SECRET_ACCESS_KEY');
    // the newest verified local archive stays as the fallback copy; older ones of failed runs are gone (rows + files)
    const live = liveOffsiteArchives(t);
    expect(live).toHaveLength(1);
    const newestRun = t.ctx.db.get<{ backup_id: string }>('SELECT backup_id FROM data_offsite_backup ORDER BY created_at DESC LIMIT 1')!;
    expect(live[0]!.id).toBe(newestRun.backup_id);
    expect(readdirSync(backupsDir(t.ctx)).filter((n) => n.endsWith('.tar.gz'))).toHaveLength(1);
  });

  it('a run whose verification failed never displaces the newest VERIFIED local archive (not in R2 yet)', async () => {
    const t = await app(r2Env({ MEDLEVO_R2_SECRET_ACCESS_KEY: 'wrong' }));
    const svc = offsiteService(t.ctx);
    const first = svc.start('manual'); // verified, then refused by R2: its archive is the only copy of that day
    await t.ctx.jobs.drain();
    t.clock.advance(86_400_000);
    // the next day the data has a problem the restore verification catches (a review event of a missing card)
    t.ctx.db.exec('PRAGMA foreign_keys = OFF');
    t.ctx.db.run(`INSERT INTO review_event (id, card_id, rating, reviewed_at, created_at) VALUES ('orphan-event', 'no-such-card', 3, 1, 1)`);
    t.ctx.db.exec('PRAGMA foreign_keys = ON');
    const second = svc.start('manual');
    await t.ctx.jobs.drain();
    const rows = t.ctx.db.all<{ id: string; status: string; verify_status: string | null; backup_id: string }>(
      'SELECT id, status, verify_status, backup_id FROM data_offsite_backup ORDER BY created_at',
    );
    expect(rows.map((r) => [r.status, r.verify_status])).toEqual([
      ['failed', 'passed'],
      ['failed', 'failed'],
    ]);
    const live = liveOffsiteArchives(t).map((a) => a.id);
    expect(live).toContain(rows[0]!.backup_id); // the verified fallback stays
    expect(live).toContain(rows[1]!.backup_id); // the failed one stays for diagnosis (bounded: one extra)
    expect([first.id, second.id]).toEqual(rows.map((r) => r.id));
  });

  it('a manual «أنشئ نسخة احتياطية الآن» archive is never removed by an off-site failure', async () => {
    const t = await app(r2Env({ MEDLEVO_R2_SECRET_ACCESS_KEY: 'wrong' }));
    const h = await t.login();
    expect((await t.app.inject({ method: 'POST', url: '/api/data/backups', headers: h })).statusCode).toBe(200);
    await t.ctx.jobs.drain();
    const svc = offsiteService(t.ctx);
    for (let i = 0; i < 2; i++) {
      svc.start('manual');
      await t.ctx.jobs.drain();
      t.clock.advance(3_600_000);
    }
    const manual = t.ctx.db.all<{ id: string }>(
      `SELECT b.id FROM data_backup b WHERE b.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM data_offsite_backup o WHERE o.backup_id = b.id)`,
    );
    expect(manual).toHaveLength(1);
    expect(liveOffsiteArchives(t)).toHaveLength(1);
  });
});

describe('a run that finally fails leaves nothing behind in the bucket', () => {
  it('its unfinished multipart upload is aborted', async () => {
    const t = await app(r2Env());
    fake.fail('UploadPart', 1000, { status: 500, partNumber: 2 }); // every attempt of every job attempt fails on part 2
    const run = offsiteService(t.ctx).start('manual');
    await t.ctx.jobs.drain();
    const r = t.ctx.db.get<{ status: string; upload_id: string | null }>('SELECT status, upload_id FROM data_offsite_backup WHERE id = ?', [run.id])!;
    expect(r.status).toBe('failed');
    expect(fake.count('CreateMultipartUpload')).toBe(1); // the job's retries resumed one upload
    expect(fake.uploads.size).toBe(0);
    expect(r.upload_id).toBeNull();
    expect(fake.objects.size).toBe(0);
  });
});

describe('a completed upload whose answer was lost', () => {
  it('is recognised by its stored size instead of failing the run (and is not uploaded twice)', async () => {
    const t = await app(r2Env());
    fake.fail('CompleteMultipartUpload', 1, { lostAnswer: true }); // R2 assembled the object; the reply never came
    const run = offsiteService(t.ctx).start('manual');
    await t.ctx.jobs.drain();
    const r = t.ctx.db.get<{ status: string; size: number; error_detail: string | null }>('SELECT status, size, error_detail FROM data_offsite_backup WHERE id = ?', [run.id])!;
    expect(r.status, r.error_detail ?? '').toBe('uploaded');
    expect(fake.objects.size).toBe(1);
    expect([...fake.objects.values()][0]!.body.length).toBe(r.size);
    expect(fake.count('CreateMultipartUpload')).toBe(1);
  });
});

describe('restore download on a slow link', () => {
  let server: http.Server;
  let endpoint = '';
  const BODY = randomBytes(20 * 8 * 1024);
  let gets = 0;
  beforeAll(async () => {
    // a store that answers at once but trickles the body: 8 KiB every 30 ms (≈ 600 ms for the whole object)
    server = http.createServer((req, res) => {
      gets++;
      const m = /^bytes=(\d+)-$/.exec(String(req.headers.range ?? ''));
      const start = m ? Number(m[1]) : 0;
      res.writeHead(m ? 206 : 200, { 'content-length': String(BODY.length - start) });
      let off = start;
      const tick = () => {
        if (res.destroyed) return;
        if (off >= BODY.length) return void res.end();
        res.write(BODY.subarray(off, off + 8 * 1024));
        off += 8 * 1024;
        setTimeout(tick, 30);
      };
      tick();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('a download that keeps making progress is resumed until complete, however many timeouts it takes', async () => {
    const s3 = new S3Client(
      { endpoint, bucket: 'b', region: 'auto', credentials: { accessKeyId: 'k', secretAccessKey: () => 's' } },
      // 150 ms per request × 3 attempts = 450 ms: less than the ≈ 600 ms the object needs at this speed
      { sleep: noSleep, maxAttempts: 3, timeoutMs: 150 },
    );
    const dir = mkdtempSync(join(tmpdir(), 'medlevo-slow-'));
    dirs.push(dir);
    const dest = join(dir, 'obj');
    expect(await s3.getObjectToFile('obj', dest, { expectedSize: BODY.length })).toBe(BODY.length);
    expect(readFileSync(dest).equals(BODY)).toBe(true);
    expect(gets).toBeGreaterThan(3); // it took more rounds than attempts — each of them made progress
  });
});

describe('a run whose job died for good', () => {
  it('never blocks off-site backups forever (crash on the last attempt → the queue fails the job after boot)', async () => {
    const t = await app(r2Env());
    const svc = offsiteService(t.ctx);
    const run = svc.start('manual');
    const jobId = t.ctx.db.get<{ job_id: string }>('SELECT job_id FROM data_offsite_backup WHERE id = ?', [run.id])!.job_id;
    // the process was killed (e.g. out of memory) during the last attempt. At the next boot the data module's
    // markInterrupted() ran first and saw the job still «running»; then jobs.start() → requeueStale() failed the job
    // (attempts exhausted). Nothing else ever looks at the off-site row again.
    t.ctx.db.run(`UPDATE processing_job SET status = 'failed', attempts = max_attempts, error_code = 'JOB_INTERRUPTED' WHERE id = ?`, [jobId]);
    expect(svc.status().running).toBeNull(); // not «جارٍ الآن» forever
    const closed = t.ctx.db.get<{ status: string; error_detail: string }>('SELECT status, error_detail FROM data_offsite_backup WHERE id = ?', [run.id])!;
    expect(closed.status).toBe('failed');
    expect(closed.error_detail).toContain('انقطع');
    // «نسخ احتياطي الآن» and the schedule work again
    const next = svc.start('manual');
    await t.ctx.jobs.drain();
    expect(t.ctx.db.get<{ status: string }>('SELECT status FROM data_offsite_backup WHERE id = ?', [next.id])!.status).toBe('uploaded');
  });

  it('the scheduler heals it too, without anyone opening the Control Center', async () => {
    const t = await app(r2Env());
    const svc = offsiteService(t.ctx);
    t.clock.set(Date.UTC(2026, 9, 10, 1, 0, 0));
    const run = svc.start('manual');
    t.ctx.db.run(`UPDATE data_offsite_backup SET created_at = ? WHERE id = ?`, [Date.UTC(2026, 9, 9, 1, 0, 0), run.id]); // yesterday's slot
    const jobId = t.ctx.db.get<{ job_id: string }>('SELECT job_id FROM data_offsite_backup WHERE id = ?', [run.id])!.job_id;
    t.ctx.db.run(`UPDATE processing_job SET status = 'failed', attempts = max_attempts WHERE id = ?`, [jobId]);
    expect(svc.tick()?.trigger).toBe('schedule');
  });
});

describe('Arabic notes of the status row', () => {
  it('never put two English words around an arrow (an LTR run there reverses the Render navigation path in RTL)', async () => {
    const t = await app(r2Env());
    for (const n of offsiteService(t.ctx).status().notes_ar) expect(n).not.toMatch(/[A-Za-z]\s*←\s*[A-Za-z]/);
  });
});

describe('the scheduler on a fresh deploy', () => {
  it('does nothing before the owner account exists, then runs the missed slot once it does', async () => {
    const t = await app(r2Env(), { login: false });
    const svc = offsiteService(t.ctx);
    t.clock.set(Date.UTC(2026, 9, 10, 1, 0, 0)); // 04:00 in Baghdad: the 03:15 slot has passed
    // P1-T1: the real scheduler — its timers run in the root context and each tick binds the platform vault, which
    // does not exist before the first account: the ticks skip without creating or touching anything
    svc.configure({ firstTickMs: 1, tickMs: 5 });
    svc.startScheduler();
    try {
      await new Promise((r) => setTimeout(r, 80));
      expect(t.ctx.system.users.countInternal()).toBe(0);
      expect(readdirSync(t.config.vaultsDir)).toEqual([]);
      await t.login();
      await vi.waitFor(() => expect(t.ctx.db.get<{ trigger: string }>('SELECT trigger FROM data_offsite_backup')?.trigger).toBe('schedule'), { timeout: 5_000 });
      expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM data_offsite_backup')!.n).toBe(1);
    } finally {
      svc.stopScheduler();
    }
  });
});
