// PL-0: off-site backups end to end, against the in-process S3 fake that verifies every SigV4 signature (./fake-s3.ts)
// — NOT against Cloudflare R2. Covers: honest «not configured» states, a manual run (local backup → restore
// verification → client-side encryption → multipart upload → HEAD confirmation → retention), resume after a failed
// part, refusal reasons, local and remote retention, the daily schedule, restore from the off-site copy (verify,
// restore into a new directory, wrong key, damaged object), and that no secret ever reaches the API, the database or
// the bucket in clear.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, type AppConfig } from '../../src/config';
import { openDb } from '../../src/db/db';
import { DecryptStream, parseBackupKey } from '../../src/lib/objectstore/encryption';
import { offsiteService, type OffsiteRunView, type OffsiteStatusResponse } from '../../src/modules/data/offsite';
import { restoreFromOffsite } from '../../src/modules/data/offsite-restore';
import { createTestApp, type AuthHeaders, type TestApp } from '../helpers/app';
import { FakeS3 } from './fake-s3';

const PART = 64 * 1024;
const KEY_B64 = randomBytes(32).toString('base64'); // the shape Render's generateValue produces
const MARKER = 'MEDLEVO-PLAINTEXT-MARKER-ملاحظة-سرية';
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

async function app(env: Record<string, string>, opts: { verifyBoot?: boolean } = {}): Promise<{ t: TestApp; h: AuthHeaders }> {
  const t = await createTestApp({ env, jobs: { backoffBaseMs: 0, backoffMaxMs: 0 } });
  apps.push(t);
  offsiteService(t.ctx).configure({ client: { sleep: noSleep, maxAttempts: 3 }, encChunkSize: 4096, partSizeBytes: PART, verifyBoot: opts.verifyBoot ?? false });
  const h = await t.login();
  // something worth protecting: two incompressible files (so the archive needs several parts) and a recognisable text
  await t.ctx.files.put(randomBytes(150 * 1024), { mime: 'application/pdf', originalName: 'lecture-1.pdf' });
  await t.ctx.files.put(Buffer.concat([Buffer.from(MARKER), randomBytes(120 * 1024)]), { mime: 'application/pdf', originalName: 'lecture-2.pdf' });
  return { t, h };
}

const status = async (t: TestApp, h: AuthHeaders) => {
  const r = await t.app.inject({ method: 'GET', url: '/api/data/offsite', headers: h });
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as OffsiteStatusResponse;
};
const runNow = (t: TestApp, h: AuthHeaders) => t.app.inject({ method: 'POST', url: '/api/data/offsite/run', headers: h });

async function decryptObject(key: string, master = parseBackupKey(KEY_B64)): Promise<Buffer> {
  const out: Buffer[] = [];
  for await (const c of Readable.from([fake.objects.get(key)!.body]).pipe(new DecryptStream(master))) out.push(c as Buffer);
  return Buffer.concat(out);
}

describe('not configured: honest states, never a decorative action', () => {
  it('nothing set: the status says so, «نسخ احتياطي الآن» answers 409 with the reason, the scheduler does nothing', async () => {
    const { t, h } = await app({});
    const s = await status(t, h);
    expect(s.configured).toBe(false);
    expect(s.problems_ar.join(' ')).toContain('غير مُعدّ');
    expect(s.target).toBeNull();
    expect(s.last).toBeNull();
    const res = await runNow(t, h);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('FEATURE_DISABLED');
    expect(offsiteService(t.ctx).tick()).toBeNull();
    expect((await t.app.inject({ method: 'GET', url: '/api/data/offsite/remote', headers: h })).statusCode).toBe(409);
  });

  it('partly set: names exactly what is missing (names only — never a value)', async () => {
    const secret = 'partial-secret-value-should-never-show';
    const { t, h } = await app({ MEDLEVO_R2_BUCKET: 'medlevo-backups', MEDLEVO_R2_SECRET_ACCESS_KEY: secret });
    const s = await status(t, h);
    expect(s.configured).toBe(false);
    const text = s.problems_ar.join(' ');
    for (const name of ['MEDLEVO_R2_ACCOUNT_ID', 'MEDLEVO_R2_ACCESS_KEY_ID', 'MEDLEVO_BACKUP_ENCRYPTION_KEY']) expect(text).toContain(name);
    expect(text).not.toContain('MEDLEVO_R2_BUCKET');
    expect(JSON.stringify(s)).not.toContain(secret);
  });

  it('an invalid encryption key is a named problem, not a crash', async () => {
    const { t, h } = await app(r2Env({ MEDLEVO_BACKUP_ENCRYPTION_KEY: 'short-password' }));
    const s = await status(t, h);
    expect(s.configured).toBe(false);
    expect(s.problems_ar.join(' ')).toContain('MEDLEVO_BACKUP_ENCRYPTION_KEY غير صالح');
  });

  it('the routes need the owner session (and CSRF for the action)', async () => {
    const { t, h } = await app(r2Env());
    expect((await t.app.inject({ method: 'GET', url: '/api/data/offsite' })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'POST', url: '/api/data/offsite/run', headers: { cookie: h.cookie } })).statusCode).toBe(403);
  });
});

describe('a manual off-site run', () => {
  it('backs up, verifies (with the app boot), encrypts, uploads in parts, confirms, and reports it in the status row', async () => {
    const { t, h } = await app(r2Env(), { verifyBoot: true });
    const started = await runNow(t, h);
    expect(started.statusCode, started.body).toBe(200);
    const run = started.json().run as OffsiteRunView;
    expect(run).toMatchObject({ trigger: 'manual', status: 'running', stage: 'backup' });
    expect((await runNow(t, h)).statusCode).toBe(409); // one at a time
    await t.ctx.jobs.drain();

    const s = await status(t, h);
    expect(s.configured).toBe(true);
    expect(s.running).toBeNull();
    expect(s.last_success?.id).toBe(run.id);
    const done = s.last_success!;
    expect(done).toMatchObject({ status: 'uploaded', stage: 'done', verify_status: 'passed', error_ar: null });
    expect(done.size).toBeGreaterThan(done.archive_size!);
    expect(done.parts).toBeGreaterThan(2);
    expect(done.object_key).toMatch(/^medlevo\/backups\/medlevo-backup-\d{8}-\d{6}Z-[0-9a-z]{8}\.tar\.gz\.mlenc$/);
    expect(s.target).toEqual({ bucket: fake.bucket, endpoint_host: new URL(fake.endpoint).host, prefix: 'medlevo/' });
    expect(s.encryption?.key_id).toMatch(/^[0-9a-f]{32}$/);
    expect(s.schedule).toMatchObject({ time: '03:15', timezone: 'Asia/Baghdad' });
    expect(s.restore_command).toBe('medlevo-restore-offsite --latest');

    // the stored object is ciphertext of exactly the verified local archive
    const stored = fake.objects.get(done.object_key!)!;
    expect(stored.body.includes(Buffer.from(MARKER))).toBe(false);
    expect(stored.body.subarray(0, 8).toString('latin1')).toBe('MLVENC01');
    expect(stored.metadata['medlevo-key-id']).toBe(s.encryption!.key_id);
    const local = t.ctx.db.get<{ id: string; sha256: string; file_name: string; verify_status: string }>(
      'SELECT b.id, b.sha256, b.file_name, b.verify_status FROM data_backup b JOIN data_offsite_backup o ON o.backup_id = b.id WHERE o.id = ?',
      [run.id],
    )!;
    expect(local.verify_status).toBe('passed');
    const plain = await decryptObject(done.object_key!);
    expect(createHash('sha256').update(plain).digest('hex')).toBe(local.sha256);
    expect(fake.rejected).toEqual([]);
    expect(fake.count('UploadPart')).toBe(done.parts);
  });

  it('a part that keeps failing: the retry resumes the same multipart upload and skips the parts R2 already holds', async () => {
    const { t, h } = await app(r2Env());
    fake.fail('UploadPart', 3, { status: 500, partNumber: 3 }); // the client's 3 attempts all fail → job attempt 1 fails
    const run = (await runNow(t, h)).json().run as OffsiteRunView;
    await t.ctx.jobs.drain();
    const s = await status(t, h);
    const done = s.recent.find((r) => r.id === run.id)!;
    expect(done.status).toBe('uploaded');
    expect(done.parts_resumed).toBe(2);
    expect(fake.log.filter((r) => r.op === 'UploadPart' && r.partNumber === 1)).toHaveLength(1);
    expect(fake.count('CreateMultipartUpload')).toBe(1);
    expect(fake.uploads.size).toBe(0);
    // only one local archive was made for the whole run
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM data_backup')!.n).toBe(1);
  });

  it('a refusal (wrong secret) fails at once with a reason that names the setting; a later run with good settings works', async () => {
    const { t, h } = await app(r2Env({ MEDLEVO_R2_SECRET_ACCESS_KEY: 'not-the-right-secret' }));
    const run = (await runNow(t, h)).json().run as OffsiteRunView;
    await t.ctx.jobs.drain();
    const failed = (await status(t, h)).recent.find((r) => r.id === run.id)!;
    expect(failed.status).toBe('failed');
    expect(failed.error_ar).toContain('MEDLEVO_R2_SECRET_ACCESS_KEY');
    expect(fake.objects.size).toBe(0);
    expect(JSON.stringify(failed)).not.toContain('not-the-right-secret');
  });
});

describe('retention', () => {
  it('keeps the newest per day (7 days) and per week (4 weeks), deletes the rest, never touches foreign objects or manual archives', async () => {
    const { t, h } = await app(r2Env());
    const day = 86_400_000;
    const now = t.clock.now();
    const name = (ms: number, id: string) => {
      const d = new Date(ms).toISOString();
      return `medlevo/backups/medlevo-backup-${d.slice(0, 10).replace(/-/g, '')}-${d.slice(11, 19).replace(/:/g, '')}Z-${id}.tar.gz.mlenc`;
    };
    const old: string[] = [];
    for (let i = 1; i <= 40; i++) old.push(name(now - i * day, `old${String(i).padStart(5, '0')}`));
    old.push(name(now - 2 * day + 3600_000, 'dup00002')); // a second backup on the same day
    for (const k of old) fake.objects.set(k, { body: Buffer.from('x'), etag: 'e', contentType: '', metadata: {}, lastModified: now });
    fake.objects.set('medlevo/backups/notes.txt', { body: Buffer.from('mine'), etag: 'e', contentType: '', metadata: {}, lastModified: now });
    fake.objects.set('other-app/backup.tar.gz.mlenc', { body: Buffer.from('theirs'), etag: 'e', contentType: '', metadata: {}, lastModified: now });

    // a manual local backup that the off-site retention must never delete
    const manual = await t.app.inject({ method: 'POST', url: '/api/data/backups', headers: h });
    expect(manual.statusCode).toBe(200);
    await t.ctx.jobs.drain();

    await runNow(t, h);
    await t.ctx.jobs.drain();
    t.clock.advance(day);
    await runNow(t, h);
    await t.ctx.jobs.drain();

    const s = await status(t, h);
    expect(s.recent.filter((r) => r.status === 'uploaded')).toHaveLength(2);
    const remaining = [...fake.objects.keys()].filter((k) => k.startsWith('medlevo/backups/medlevo-backup-'));
    // 7 distinct days (today, yesterday-run day, and 5 older days) + weekly picks from older weeks
    const days = new Set(remaining.map((k) => k.match(/backup-(\d{8})/)![1]));
    expect(days.size).toBe(remaining.length); // one per day
    expect(remaining.length).toBeGreaterThanOrEqual(7);
    expect(remaining.length).toBeLessThanOrEqual(7 + 4);
    expect(remaining).not.toContain(name(now - 40 * day, 'old00040'));
    // two backups on one day: only the newer of them stays
    expect(remaining).toContain(name(now - 2 * day + 3600_000, 'dup00002'));
    expect(remaining).not.toContain(name(now - 2 * day, 'old00002'));
    expect(fake.objects.has('medlevo/backups/notes.txt')).toBe(true);
    expect(fake.objects.has('other-app/backup.tar.gz.mlenc')).toBe(true);
    const runs = s.recent.filter((r) => r.status === 'uploaded');
    expect(runs.reduce((n, r) => n + r.retention!.deleted, 0)).toBeGreaterThan(20);
    for (const r of runs) expect(r.retention!.errors_ar).toEqual([]);

    // disk: only the newest off-site archive stays (MEDLEVO_BACKUP_KEEP_LOCAL=1); the manual one is untouched
    const live = t.ctx.db.all<{ id: string; origin: string; offsite: number }>(
      `SELECT b.id, b.origin, (SELECT COUNT(*) FROM data_offsite_backup o WHERE o.backup_id = b.id) AS offsite FROM data_backup b WHERE b.deleted_at IS NULL`,
    );
    expect(live.filter((b) => b.offsite > 0)).toHaveLength(1);
    expect(live.filter((b) => b.offsite === 0)).toHaveLength(1);
  });
});

describe('the daily schedule', () => {
  it('starts one run per slot (03:15 Asia/Baghdad), catches up a missed slot, and waits for the owner account', async () => {
    const { t } = await app(r2Env());
    const svc = offsiteService(t.ctx);
    // 2026-10-09 23:00 UTC = 02:00 in Baghdad: the slot of the 9th (00:15 UTC on the 9th) was missed → catch up once
    t.clock.set(Date.UTC(2026, 9, 9, 23, 0, 0));
    const first = svc.tick();
    expect(first?.trigger).toBe('schedule');
    expect(svc.tick()).toBeNull(); // running
    await t.ctx.jobs.drain();
    expect(svc.tick()).toBeNull(); // this slot is done
    t.clock.set(Date.UTC(2026, 9, 10, 0, 14, 0)); // 03:14 local: not yet
    expect(svc.tick()).toBeNull();
    t.clock.set(Date.UTC(2026, 9, 10, 0, 16, 0)); // 03:16 local: the new slot
    expect(svc.tick()?.trigger).toBe('schedule');
    await t.ctx.jobs.drain();
    const s = svc.status();
    expect(s.schedule!.next_run_at).toBe(Date.UTC(2026, 9, 11, 0, 15, 0));
    expect(s.recent.filter((r) => r.trigger === 'schedule' && r.status === 'uploaded')).toHaveLength(2);
  });

  it('MEDLEVO_BACKUP_SCHEDULE=off: manual only', async () => {
    const { t, h } = await app(r2Env({ MEDLEVO_BACKUP_SCHEDULE: 'off' }));
    expect(offsiteService(t.ctx).tick()).toBeNull();
    expect((await status(t, h)).schedule).toBeNull();
    expect((await runNow(t, h)).statusCode).toBe(200);
  });

  it('a malformed schedule stops the server with a precise message (a typo must not silently disable backups)', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', MEDLEVO_DATA_DIR: '/tmp/x', ...r2Env({ MEDLEVO_BACKUP_SCHEDULE: '3am' }) })).toThrow(/MEDLEVO_BACKUP_SCHEDULE/);
  });

  it('a closed run is never resurrected by its re-queued job', async () => {
    const { t, h } = await app(r2Env());
    const run = (await runNow(t, h)).json().run as OffsiteRunView;
    t.ctx.db.run(`UPDATE data_offsite_backup SET status = 'failed', error_detail = 'x' WHERE id = ?`, [run.id]);
    await t.ctx.jobs.drain();
    const r = t.ctx.db.get<{ status: string; backup_id: string | null }>('SELECT status, backup_id FROM data_offsite_backup WHERE id = ?', [run.id])!;
    expect(r).toEqual({ status: 'failed', backup_id: null });
    expect(fake.objects.size).toBe(0);
  });

  it('a run left «running» by a crash is marked interrupted at boot', async () => {
    const { t } = await app(r2Env());
    t.ctx.db.run(`INSERT INTO data_offsite_backup (id, trigger, status, stage, created_at) VALUES ('ghost', 'schedule', 'running', 'upload', 1)`);
    offsiteService(t.ctx).markInterrupted();
    const r = t.ctx.db.get<{ status: string; error_detail: string }>(`SELECT status, error_detail FROM data_offsite_backup WHERE id = 'ghost'`)!;
    expect(r.status).toBe('failed');
    expect(r.error_detail).toContain('انقطع');
  });
});

describe('restore from the off-site copy (the Render-Shell command)', () => {
  async function uploaded(): Promise<{ t: TestApp; h: AuthHeaders; config: AppConfig }> {
    const { t, h } = await app(r2Env());
    await runNow(t, h);
    await t.ctx.jobs.drain();
    expect((await status(t, h)).last_success).not.toBeNull();
    return { t, h, config: t.config };
  }

  it('lists, downloads, decrypts, verifies and restores into a NEW directory beside the data; the restored server has the same data', async () => {
    const { t, h, config } = await uploaded();
    const remote = await t.app.inject({ method: 'GET', url: '/api/data/offsite/remote', headers: h });
    expect(remote.statusCode).toBe(200);
    const objects = remote.json().objects as Array<{ file_name: string; restore_command: string }>;
    expect(objects).toHaveLength(1);
    expect(objects[0]!.restore_command).toBe(`medlevo-restore-offsite --key ${objects[0]!.file_name}`);

    const lines: string[] = [];
    const verified = await restoreFromOffsite(config, { verifyOnly: true, clientOptions: { sleep: noSleep }, bootCheck: false, log: (l) => lines.push(l) });
    expect(verified.report.ok, JSON.stringify(verified.report.checks.filter((c) => !c.ok))).toBe(true);
    expect(verified.restoredTo).toBeNull();

    const res = await restoreFromOffsite(config, { key: objects[0]!.file_name, clientOptions: { sleep: noSleep }, bootCheck: true });
    expect(res.report.ok, JSON.stringify(res.report.checks.filter((c) => !c.ok))).toBe(true);
    dirs.push(res.restoredTo!);
    expect(res.restoredTo!.startsWith(join(t.dataDir, '..'))).toBe(true);
    expect(res.restoredTo).toMatch(/medlevo-restored-\d{8}-\d{6}$/);
    const db = openDb(join(res.restoredTo!, 'medlevo.sqlite'));
    try {
      const files = db.all<{ original_name: string }>('SELECT original_name FROM stored_file ORDER BY original_name').map((r) => r.original_name);
      expect(files).toEqual(['lecture-1.pdf', 'lecture-2.pdf']);
      expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM data_server_epoch WHERE reason = 'restore' AND is_current = 1")!.n).toBe(1);
    } finally {
      db.close();
    }
    // the live data directory was never touched; no working files are left beside it
    expect(existsSync(t.config.dbPath)).toBe(true);
    expect(readdirSync(join(t.dataDir, '..')).filter((n) => n.startsWith('.medlevo-offsite-restore-'))).toEqual([]);
  });

  it('a different key is refused with the reason; a damaged object is refused; nothing is restored', async () => {
    const { config } = await uploaded();
    const otherKey = loadConfig({ NODE_ENV: 'test', MEDLEVO_DATA_DIR: config.dataDir, MEDLEVO_ORIGIN: 'http://localhost:5173', ...r2Env({ MEDLEVO_BACKUP_ENCRYPTION_KEY: randomBytes(32).toString('base64') }) });
    await expect(restoreFromOffsite(otherKey, { verifyOnly: true, clientOptions: { sleep: noSleep } })).rejects.toMatchObject({ reason: 'wrong_key' });
    const [key] = [...fake.objects.keys()];
    const obj = fake.objects.get(key!)!;
    obj.body = Buffer.from(obj.body);
    obj.body[obj.body.length - 100]! ^= 0xff;
    await expect(restoreFromOffsite(config, { clientOptions: { sleep: noSleep } })).rejects.toMatchObject({ name: 'DecryptError' });
    expect(readdirSync(join(config.dataDir, '..')).filter((n) => n.startsWith('medlevo-restored-') || n.startsWith('.medlevo-offsite-restore-'))).toEqual([]);
  });
});

describe('secrets', () => {
  it('neither the R2 secret nor the encryption key appears in the API, the database or the bucket', async () => {
    const { t, h } = await app(r2Env());
    await runNow(t, h);
    await t.ctx.jobs.drain();
    const bodies = [
      (await t.app.inject({ method: 'GET', url: '/api/data/offsite', headers: h })).body,
      (await t.app.inject({ method: 'GET', url: '/api/data/offsite/remote', headers: h })).body,
      (await t.app.inject({ method: 'GET', url: '/api/control/history', headers: h })).body,
      JSON.stringify(t.config),
    ].join('\n');
    const keyHex = parseBackupKey(KEY_B64).toString('hex');
    for (const s of [fake.secretAccessKey, KEY_B64, keyHex]) expect(bodies).not.toContain(s);
    t.ctx.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const dbBytes = readFileSync(t.config.dbPath);
    for (const s of [fake.secretAccessKey, KEY_B64]) expect(dbBytes.includes(Buffer.from(s))).toBe(false);
    expect(dbBytes.includes(parseBackupKey(KEY_B64))).toBe(false);
    for (const o of fake.objects.values()) {
      expect(o.body.includes(Buffer.from(fake.secretAccessKey))).toBe(false);
      expect(o.body.includes(parseBackupKey(KEY_B64))).toBe(false);
    }
  });
});
