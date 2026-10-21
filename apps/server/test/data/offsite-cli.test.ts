// PL-0: the ONE Render-Shell command (cli/restore-offsite.ts) run as a real process against the signature-checking
// S3 fake: --list, --latest --verify-only, --latest (restore beside the data), and the refusals. Not Cloudflare R2.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../src/config';
import { offsiteService } from '../../src/modules/data/offsite';
import { createTestApp, type TestApp } from '../helpers/app';
import { dataDirDatabases } from '../helpers/tenancy';
import { FakeS3 } from './fake-s3';

const CLI = join(REPO_ROOT, 'apps', 'server', 'src', 'cli', 'restore-offsite.ts');
const KEY = randomBytes(32).toString('base64');
let fake: FakeS3;
let t: TestApp;
const restored: string[] = [];

function run(args: string[], env: Record<string, string>): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', CLI, ...args], {
      cwd: join(REPO_ROOT, 'apps', 'server'),
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NODE_ENV: 'test', MEDLEVO_LOG_LEVEL: 'silent', MEDLEVO_SCRYPT_LOG_N: '12', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('close', (code) => resolve({ code: code ?? -1, out }));
  });
}

const r2 = () => ({
  MEDLEVO_R2_ENDPOINT: fake.endpoint,
  MEDLEVO_R2_BUCKET: fake.bucket,
  MEDLEVO_R2_ACCESS_KEY_ID: fake.accessKeyId,
  MEDLEVO_R2_SECRET_ACCESS_KEY: fake.secretAccessKey,
  MEDLEVO_BACKUP_ENCRYPTION_KEY: KEY,
});
const env = () => ({ MEDLEVO_DATA_DIR: t.dataDir, ...r2() });

beforeAll(async () => {
  fake = new FakeS3({ minPartBytes: 64 * 1024 });
  await fake.start();
  t = await createTestApp({ env: r2(), jobs: { backoffBaseMs: 0, backoffMaxMs: 0 } });
  offsiteService(t.ctx).configure({ client: { sleep: async () => {} }, encChunkSize: 4096, partSizeBytes: 64 * 1024, verifyBoot: false });
  const h = await t.login();
  await t.ctx.files.put(randomBytes(100 * 1024), { mime: 'application/pdf', originalName: 'lecture.pdf' });
  expect((await t.app.inject({ method: 'POST', url: '/api/data/offsite/run', headers: h })).statusCode).toBe(200);
  await t.ctx.jobs.drain();
}, 60_000);

afterAll(async () => {
  await t.close();
  await fake.stop();
  for (const d of restored) rmSync(d, { recursive: true, force: true });
});

describe('medlevo-restore-offsite', () => {
  it('--list shows the backup; --latest --verify-only passes every check and restores nothing', async () => {
    const list = await run(['--list'], env());
    expect(list.code, list.out).toBe(0);
    expect(list.out).toMatch(/medlevo-backup-\d{8}-\d{6}Z-[0-9a-z]{8}\.tar\.gz/);
    const v = await run(['--latest', '--verify-only', '--no-boot'], env());
    expect(v.code, v.out).toBe(0);
    expect(v.out).toContain('RESULT: PASS');
    expect(v.out).not.toContain('Restored into');
    expect(v.out).not.toContain(fake.secretAccessKey);
    expect(v.out).not.toContain(KEY);
  }, 60_000);

  it('--latest restores beside the live data and prints the one setting to change', async () => {
    const r = await run(['--latest'], env());
    expect(r.code, r.out).toBe(0);
    const m = /Restored into: (.+)/.exec(r.out);
    expect(m).not.toBeNull();
    restored.push(m![1]!.trim());
    // P1-T1: the restored directory is a multi-user data dir (system DB + vault files)
    expect(existsSync(join(m![1]!.trim(), 'system.sqlite'))).toBe(true);
    expect(existsSync(dataDirDatabases(m![1]!.trim()).primaryVault)).toBe(true);
    expect(r.out).toContain(`MEDLEVO_DATA_DIR=${m![1]!.trim()}`);
  }, 90_000);

  it('refuses without a choice, without configuration, and with the wrong key (exit 2 / 1, nothing restored)', async () => {
    expect((await run(['--target', '/tmp/x'], env())).code).toBe(2);
    const none = await run(['--latest'], { MEDLEVO_DATA_DIR: t.dataDir });
    expect(none.code).toBe(2);
    expect(none.out).toContain('Refused');
    const wrong = await run(['--latest', '--verify-only'], { ...env(), MEDLEVO_BACKUP_ENCRYPTION_KEY: randomBytes(32).toString('base64') });
    expect(wrong.code).toBe(1);
    expect(wrong.out).toContain('MEDLEVO_BACKUP_ENCRYPTION_KEY');
  }, 60_000);
});
