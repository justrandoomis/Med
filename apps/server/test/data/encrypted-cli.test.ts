// P1-T1 step 2: `npm run backup -- --encrypt` keeps only the MLVENC01 archive, and `npm run restore:verify` opens it with
// MEDLEVO_BACKUP_ENCRYPTION_KEY from the environment (and refuses without it) — run as real processes.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../src/config';
import { createTestApp, type TestApp } from '../helpers/app';
import { addUser } from '../helpers/tenancy';

const BACKUP = join(REPO_ROOT, 'apps', 'server', 'src', 'cli', 'backup.ts');
const VERIFY = join(REPO_ROOT, 'apps', 'server', 'src', 'cli', 'restore-verify.ts');
const KEY = randomBytes(32).toString('base64');
let t: TestApp;
let out: string;

function run(cli: string, args: string[], env: Record<string, string>): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', cli, ...args], {
      cwd: join(REPO_ROOT, 'apps', 'server'),
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NODE_ENV: 'test', MEDLEVO_LOG_LEVEL: 'silent', MEDLEVO_SCRYPT_LOG_N: '12', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let o = '';
    child.stdout.on('data', (d: Buffer) => (o += d.toString()));
    child.stderr.on('data', (d: Buffer) => (o += d.toString()));
    child.on('close', (code) => resolve({ code: code ?? -1, out: o }));
  });
}

beforeAll(async () => {
  t = await createTestApp();
  await t.login();
  await addUser(t, 'student-b');
  await t.ctx.files.put(Buffer.from(`SECRET-OWNER-NOTE ${randomBytes(2000).toString('hex')}`), { mime: 'text/plain' });
  out = mkdtempSync(join(tmpdir(), 'medlevo-enc-cli-'));
}, 60_000);

afterAll(async () => {
  await t.close();
  rmSync(out, { recursive: true, force: true });
});

describe('encrypted archives from the command line', () => {
  it('--encrypt without a key keeps nothing; with the key only the .mlenc stays and restore:verify opens it', async () => {
    const env = { MEDLEVO_DATA_DIR: t.dataDir };
    const noKey = await run(BACKUP, ['--out', out, '--encrypt'], env);
    expect(noKey.code, noKey.out).toBe(2);
    expect(readdirSync(out)).toEqual([]);

    const ok = await run(BACKUP, ['--out', out, '--encrypt'], { ...env, MEDLEVO_BACKUP_ENCRYPTION_KEY: KEY });
    expect(ok.code, ok.out).toBe(0);
    const files = readdirSync(out).sort();
    expect(files).toHaveLength(2);
    const enc = files.find((f) => f.endsWith('.tar.gz.mlenc'))!;
    expect(files).toContain(`${enc}.sha256`);
    const bytes = readFileSync(join(out, enc));
    expect(bytes.subarray(0, 8).toString('latin1')).toBe('MLVENC01');
    expect(bytes.includes(Buffer.from('SECRET-OWNER-NOTE'))).toBe(false);

    const refused = await run(VERIFY, [join(out, enc), '--no-boot'], env);
    expect(refused.code).toBe(1);
    expect(refused.out).toMatch(/\[FAIL\] decrypt/);
    const verified = await run(VERIFY, [join(out, enc), '--no-boot'], { ...env, MEDLEVO_BACKUP_ENCRYPTION_KEY: KEY });
    expect(verified.code, verified.out).toBe(0);
    expect(verified.out).toMatch(/\[PASS\] decrypt/);
    expect(verified.out).toMatch(/RESULT: PASS/);
  }, 120_000);
});
