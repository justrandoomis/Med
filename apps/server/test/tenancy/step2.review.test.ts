// P1-T1 step 2 — adversarial review (BUILD_PLAN §1.2). Each test reproduced a defect before its fix:
//   1. a call stopped after it reached the provider (the student closed the stream, a job was cancelled, the call timed
//      out) gave its whole reservation back, so the allowance could be exceeded without limit;
//   2. account deletion left the account's sessions (IP, browser), its sign-in attempts (the OLD login name) and its
//      upload sessions (file names) in the system DB, and the policy text promised the files were deleted at once;
//   3. «نسخة من بياناتي» with MEDLEVO_BLOB_STORE=r2 left out every file whose local copy was missing (it did not fetch
//      them back from the object store) and still reported a complete export;
//   4. the blob replicator always retried the same oldest blobs: blobs it skips (orphaned, local copy missing) at the
//      head of the queue starved every newer blob of its off-site copy;
//   5. a damaged local copy was uploaded and recorded as the confirmed remote copy (it can never be restored);
//   6. a blob quarantined while its copy was being uploaded kept its remote object forever (nothing deletes it);
//   7. two «complete» calls of one upload session at once: the second failed half-way (its chunks were removed);
//   8. a vault restored while a sweep runs: the sweep, which read the OLD file, quarantined bytes the restored vault uses;
//   9. two restores of one vault at once both swapped the file (the second kept the first's result as its «rollback»);
//  10. a whole-instance archive made while several accounts existed was downloadable in clear again once the other
//      accounts were deleted — with their deleted vaults inside.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AccountExportsResponse, AiTask, BackupManifest, DeletionPreview, ResolvedScope, UploadSessionView } from '@medlevo/shared';
import { finishPendingDeletions } from '../../src/modules/accounts/deletion';
import type { AiProvider, ProviderRequest, ProviderResponse, ProviderUsage } from '../../src/modules/ai/types';
import { backupVault, restoreVault } from '../../src/modules/data/vault-backup';
import { DEFAULT_RESTORE_LIMITS } from '../../src/modules/data/restore';
import { extractTarGz } from '../../src/modules/data/tar';
import { removeStoredFileIfUnreferenced } from '../../src/modules/files/blobs';
import { DAY_MS } from '../../src/modules/files/gc';
import type { Binding } from '../../src/system/binding';
import { createTestApp, type AuthHeaders, type TestApp } from '../helpers/app';
import { addUser } from '../helpers/tenancy';
import { FakeS3 } from '../data/fake-s3';

let t: TestApp | null = null;
const dirs: string[] = [];
let fake: FakeS3;
beforeAll(async () => {
  fake = new FakeS3({ minPartBytes: 64 * 1024 });
  await fake.start();
});
afterAll(async () => {
  await fake.stop();
});
afterEach(async () => {
  await t?.close();
  t = null;
  fake.objects.clear();
  fake.uploads.clear();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const ownerVault = (a: TestApp) => (a.ownerBinding() as Extract<Binding, { kind: 'vault' }>).vaultId;
const inVault = <T>(a: TestApp, vaultId: string, fn: () => T): T => a.ctx.binding.run({ kind: 'vault', vaultId, viewer: null }, fn);
const KEY_B64 = randomBytes(32).toString('base64');
const r2Env = () => ({
  MEDLEVO_BLOB_STORE: 'r2',
  MEDLEVO_R2_ENDPOINT: fake.endpoint,
  MEDLEVO_R2_BUCKET: fake.bucket,
  MEDLEVO_R2_ACCESS_KEY_ID: fake.accessKeyId,
  MEDLEVO_R2_SECRET_ACCESS_KEY: fake.secretAccessKey,
  MEDLEVO_BACKUP_ENCRYPTION_KEY: KEY_B64,
});
const r2App = async (o: Parameters<typeof createTestApp>[0] = {}) =>
  (t = await createTestApp({
    ...o,
    env: { ...r2Env(), ...(o.env ?? {}) },
    blobStore: { client: { sleep: async () => {}, maxAttempts: 2 }, encChunkSize: 4096, partSizeBytes: 64 * 1024 },
  }));
const objectKey = (s: string) => `medlevo/blobs/${s.slice(0, 2)}/${s.slice(2, 4)}/${s}.mlenc`;

// ───────── 1. AI: a stopped call keeps its reservation ─────────

const scope: ResolvedScope = {
  mode: 'lecture_only',
  sourceIds: ['S1'],
  versionIds: ['V1'],
  versionBySource: { S1: 'V1' },
  allowExternal: false,
  includeMyNotes: false,
  hash: 'scopehash',
  describeAr: 'المحاضرة فقط',
};
const aiReq = (signal?: AbortSignal) => ({
  task: 'summarize' as const,
  schema: z.object({ summary: z.string().min(1) }),
  system: 'Summarize.',
  input: [{ label: 'p1', text: 'text' }],
  scope,
  sourceVersionIds: ['V1'],
  ...(signal ? { signal } : {}),
});

/** Streams part of an answer, then waits until the caller aborts (the student closed the stream). */
class StreamingUntilAbort implements AiProvider {
  readonly name = 'streaming';
  calls = 0;
  waiting = 0;
  supports(_t: AiTask): boolean {
    return true;
  }
  modelFor(): string {
    return 'stream-1';
  }
  estimateCostUsd(_m: string, u: ProviderUsage): number {
    return (u.inputTokens * 3 + u.outputTokens * 15) / 1_000_000;
  }
  async generateStructured(r: ProviderRequest): Promise<ProviderResponse> {
    this.calls++;
    if (r.signal.aborted) throw r.signal.reason ?? new DOMException('aborted', 'AbortError'); // like the SDK: never sent
    r.onTextDelta?.('{"summary": "a long answer that the student read before closing');
    this.waiting++;
    await new Promise<void>((_resolve, reject) => {
      r.signal.addEventListener('abort', () => reject(r.signal.reason ?? new DOMException('aborted', 'AbortError')), { once: true });
    });
    throw new Error('unreachable');
  }
}

describe('review 1 — AI allowance: a stopped call is not free', () => {
  it('closing the stream after the call reached the provider keeps the reservation; the allowance cannot be exceeded that way', async () => {
    const p = new StreamingUntilAbort();
    t = await createTestApp({ ai: p, env: { MEDLEVO_AI_MONTHLY_BUDGET_USD: '50' } });
    const b = await addUser(t, 'student-b');
    t.ctx.system.quotas.setUserInternal(b.user.id, { ai_monthly_usd_limit: 1 }, b.user.id);
    const asB = <T>(fn: () => T) => t!.ctx.binding.run({ kind: 'vault', vaultId: b.vault.id, viewer: { userId: b.user.id, deviceId: null, isPlatformAdmin: false } }, fn);

    const ac = new AbortController();
    const first = asB(() => t!.ctx.ai.generateStructured({ ...aiReq(ac.signal), onText: () => undefined }));
    for (let i = 0; i < 20 && p.waiting < 1; i++) await new Promise((r) => setImmediate(r));
    expect(p.waiting).toBe(1);
    const wc = t.ctx.system.db.get<{ r: number }>('SELECT reserved_usd AS r FROM ai_budget_ledger')!.r;
    expect(wc).toBeGreaterThan(0);
    // the cap now fits ONE worst case and a half
    t.ctx.system.quotas.setUserInternal(b.user.id, { ai_monthly_usd_limit: 1.5 * wc }, b.user.id);
    ac.abort(new DOMException('the client closed the stream', 'AbortError'));
    await expect(first).rejects.toBeTruthy();

    const row = t.ctx.system.db.get<{ status: string; actual_usd: number }>('SELECT status, actual_usd FROM ai_budget_ledger')!;
    expect(row.status).toBe('settled');
    expect(row.actual_usd).toBeCloseTo(wc, 6); // the provider may have billed it: counted at its worst case (an estimate)
    expect(asB(() => t!.ctx.ai.budget().spent_usd)).toBeCloseTo(wc, 6);
    // a second call no longer fits: refused before it reaches the provider
    await expect(asB(() => t!.ctx.ai.generateStructured(aiReq()))).rejects.toMatchObject({ code: 'AI_BUDGET_EXCEEDED' });
    expect(p.calls).toBe(1);
  });

  it('a call stopped before it was sent gives its reservation back (nothing can have been billed)', async () => {
    const p = new StreamingUntilAbort();
    t = await createTestApp({ ai: p, env: { MEDLEVO_AI_MONTHLY_BUDGET_USD: '50' } });
    const ac = new AbortController();
    ac.abort(new DOMException('cancelled', 'AbortError'));
    await expect(t.ctx.ai.generateStructured(aiReq(ac.signal))).rejects.toBeTruthy();
    expect(t.ctx.system.db.get<{ status: string }>('SELECT status FROM ai_budget_ledger')!.status).toBe('released');
  });
});

// ───────── 2. account deletion leaves no private data ─────────

describe('review 2 — account deletion leaves no private data behind', () => {
  it('sessions, sign-in attempts under the old login name and upload sessions (file names) are removed; the policy says when file bytes go', async () => {
    t = await createTestApp({ jobs: { backoffBaseMs: 0, backoffMaxMs: 0 } });
    await t.login();
    const b = await addUser(t, 'student-b');
    const hb = await b.login('Mozilla/5.0 (iPad; private browser)');
    await b.login('Mozilla/5.0 (Android; second device)');
    // a failed sign-in under the login name too
    await t.app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-medlevo-csrf': '1' }, payload: { username: 'student-b', password: 'wrong-password-xyz' } });
    const body = randomBytes(1000);
    const up = await t.app.inject({ method: 'POST', url: '/api/files/uploads', headers: hb, payload: { size: body.length, sha256: sha(body), mime: 'application/pdf', name: 'تقريري الطبي الخاص.pdf' } });
    expect(up.statusCode, up.body).toBe(200);
    const sys = t.ctx.system.db;
    expect(sys.get<{ n: number }>('SELECT COUNT(*) AS n FROM auth_session WHERE user_id = ?', [b.user.id])!.n).toBeGreaterThan(0);
    expect(sys.get<{ n: number }>(`SELECT COUNT(*) AS n FROM login_attempt WHERE username_norm = 'student-b'`)!.n).toBeGreaterThan(0);

    const preview = (await t.app.inject({ method: 'POST', url: '/api/accounts/me/delete', headers: hb, payload: { preview: true } })).json() as DeletionPreview;
    // honest about the file bytes: they leave the store only after the GC's safety periods (and so does the R2 copy)
    expect(preview.policy_ar.join(' ')).toMatch(/أسابيع/);
    const del = await t.app.inject({ method: 'POST', url: '/api/accounts/me/delete', headers: hb, payload: { confirm_token: preview.confirm_token, password: b.password } });
    expect(del.statusCode, del.body).toBe(200);
    await finishPendingDeletions(t.ctx);
    expect(t.ctx.system.users.byIdInternal(b.user.id)!.status).toBe('deleted');

    expect(sys.get<{ n: number }>('SELECT COUNT(*) AS n FROM auth_session WHERE user_id = ?', [b.user.id])!.n).toBe(0);
    expect(sys.get<{ n: number }>(`SELECT COUNT(*) AS n FROM login_attempt WHERE username_norm = 'student-b'`)!.n).toBe(0);
    expect(sys.get<{ n: number }>('SELECT COUNT(*) AS n FROM upload_session WHERE user_id = ?', [b.user.id])!.n).toBe(0);
    // nothing anywhere in the system DB still carries the file name or the browser strings
    const dump = JSON.stringify([
      sys.all('SELECT * FROM auth_session'),
      sys.all('SELECT * FROM upload_session'),
      sys.all('SELECT * FROM login_attempt'),
      sys.all('SELECT * FROM user_account'),
    ]);
    expect(dump).not.toContain('تقريري الطبي الخاص');
    expect(dump).not.toContain('private browser');
    expect(dump).not.toContain('student-b');
    // the owner's own session still works
    expect(sys.get<{ n: number }>('SELECT COUNT(*) AS n FROM auth_session WHERE revoked_at IS NULL')!.n).toBeGreaterThan(0);
  });
});

// ───────── 3. «نسخة من بياناتي» is complete, or says what is missing ─────────

async function exportOf(a: TestApp, h: AuthHeaders, vaultId: string) {
  const start = await a.app.inject({ method: 'POST', url: '/api/accounts/me/export', headers: h });
  expect(start.statusCode, start.body).toBe(200);
  await inVault(a, vaultId, () => a.ctx.jobs.drain());
  const list = (await a.app.inject({ method: 'GET', url: '/api/accounts/me/exports', headers: h })).json() as AccountExportsResponse;
  const ex = list.exports[0]!;
  expect(ex.status).toBe('completed');
  const dl = await a.app.inject({ method: 'GET', url: ex.download_url!, headers: h });
  const dir = mkdtempSync(join(tmpdir(), 'medlevo-review-export-'));
  dirs.push(dir);
  const archive = join(dir, 'export.tar.gz');
  writeFileSync(archive, dl.rawPayload);
  const ext = await extractTarGz(archive, join(dir, 'x'), DEFAULT_RESTORE_LIMITS);
  const manifest = JSON.parse(readFileSync(ext.entries.find((e) => e.path.endsWith('manifest.json'))!.absPath, 'utf8')) as BackupManifest;
  return { ex, manifest };
}

describe('review 3 — «نسخة من بياناتي» completeness', () => {
  it('MEDLEVO_BLOB_STORE=r2: a file whose local copy is missing is fetched back from the object store into the export', async () => {
    const a = await r2App({ jobs: { backoffBaseMs: 0, backoffMaxMs: 0 } });
    const h = await a.login();
    const v = ownerVault(a);
    const bytes = randomBytes(30 * 1024);
    const f = await inVault(a, v, () => a.ctx.files.put(bytes, { mime: 'application/pdf', originalName: 'lecture.pdf' }));
    expect(await a.ctx.blobs.replicatePending()).toMatchObject({ copied: 1 });
    rmSync(a.ctx.blobs.localPath(f.sha256)); // a new disk: only the object store has it
    const { ex, manifest } = await exportOf(a, h, v);
    expect(manifest.files_missing).toEqual([]);
    expect(manifest.files.map((x) => x.sha256)).toContain(f.sha256);
    expect(ex.missing_files).toBe(0);
  });

  it('a file that cannot be had anywhere is named in the export view instead of a silent «complete»', async () => {
    t = await createTestApp({ jobs: { backoffBaseMs: 0, backoffMaxMs: 0 } });
    const h = await t.login();
    const v = ownerVault(t);
    const f = await inVault(t, v, () => t!.ctx.files.put(randomBytes(4000), { mime: 'application/pdf' }));
    rmSync(t.ctx.blobs.localPath(f.sha256));
    const { ex, manifest } = await exportOf(t, h, v);
    expect(manifest.files_missing.map((m) => m.sha256)).toEqual([f.sha256]);
    expect(ex.missing_files).toBe(1);
    expect(ex.warning_ar ?? '').toMatch(/ينقصها 1 ملف/);
  });
});

// ───────── 4–6. the R2 replicator ─────────

describe('review 4–6 — the blob replicator', () => {
  it('blobs it must skip (local copy gone, orphaned) never starve newer blobs of their off-site copy', async () => {
    const a = await r2App();
    const v = ownerVault(a);
    const bad: string[] = [];
    for (let i = 0; i < 3; i++) {
      const f = await inVault(a, v, () => a.ctx.files.put(randomBytes(2000 + i), { mime: 'application/pdf' }));
      rmSync(a.ctx.blobs.localPath(f.sha256)); // lost before it was ever copied
      bad.push(f.sha256);
      a.clock.advance(1000);
    }
    const good = await inVault(a, v, () => a.ctx.files.put(randomBytes(3000), { mime: 'application/pdf' }));
    for (let i = 0; i < 4; i++) await a.ctx.blobs.replicatePending(2);
    expect(a.ctx.system.blobs.getInternal(good.sha256)!.storage).toBe('r2');
    expect(fake.objects.has(objectKey(good.sha256))).toBe(true);
  });

  it('a damaged local copy is never recorded as the confirmed remote copy', async () => {
    const a = await r2App();
    const v = ownerVault(a);
    const bytes = randomBytes(20 * 1024);
    const f = await inVault(a, v, () => a.ctx.files.put(bytes, { mime: 'application/pdf' }));
    const path = a.ctx.blobs.localPath(f.sha256);
    const damaged = Buffer.from(bytes);
    damaged[100] = damaged[100]! ^ 0xff;
    writeFileSync(path, damaged); // bit rot: same size, other bytes
    const r = await a.ctx.blobs.replicatePending();
    expect(r.copied).toBe(0);
    expect(a.ctx.system.blobs.getInternal(f.sha256)!.storage).toBe('local');
    expect(fake.objects.has(objectKey(f.sha256))).toBe(false);
  });

  it('a blob quarantined while its copy uploads does not leave a remote object nobody will delete', async () => {
    const a = await r2App();
    const vA = ownerVault(a);
    const f = await inVault(a, vA, () => a.ctx.files.put(randomBytes(8000), { mime: 'application/pdf' }));
    const running = a.ctx.blobs.replicatePending();
    // the GC decides to quarantine it while the upload is in flight (the bytes move out a moment later)
    a.ctx.system.blobs.setQuarantinedInternal(f.sha256, a.clock.now());
    expect(await running).toMatchObject({ failed: 0 });
    expect(a.ctx.system.blobs.getInternal(f.sha256)!.storage).toBe('local');
    expect(fake.objects.has(objectKey(f.sha256))).toBe(false);
  });
});

// ───────── 7. two «complete» calls at once ─────────

describe('review 7 — chunked uploads', () => {
  it('two «complete» calls of one session at once both answer the same stored file', async () => {
    const CHUNK = 64 * 1024;
    t = await createTestApp({ env: { MEDLEVO_UPLOAD_CHUNK_MB: String(CHUNK / (1024 * 1024)) } });
    const h = await t.login();
    const body = randomBytes(5 * CHUNK + 77);
    const s = (await t.app.inject({ method: 'POST', url: '/api/files/uploads', headers: h, payload: { size: body.length, sha256: sha(body), mime: 'audio/webm', name: 'l.webm' } })).json() as UploadSessionView;
    for (let n = 0; n < s.chunks; n++) {
      const part = body.subarray(n * CHUNK, (n + 1) * CHUNK);
      const r = await t.app.inject({ method: 'PUT', url: `/api/files/uploads/${s.upload_id}/chunks/${n}`, headers: { ...h, 'content-type': 'application/octet-stream', 'x-content-sha256': sha(part) }, payload: part });
      expect(r.statusCode, r.body).toBe(200);
    }
    let puts = 0;
    const put = t.ctx.files.put.bind(t.ctx.files);
    t.ctx.files.put = (async (...args: Parameters<typeof put>) => {
      puts++;
      await new Promise((r) => setTimeout(r, 30)); // a large file takes a while to store
      return put(...args);
    }) as typeof put;
    const [c1, c2] = await Promise.all([
      t.app.inject({ method: 'POST', url: `/api/files/uploads/${s.upload_id}/complete`, headers: h }),
      t.app.inject({ method: 'POST', url: `/api/files/uploads/${s.upload_id}/complete`, headers: h }),
    ]);
    expect(c1.statusCode, c1.body).toBe(200);
    expect(c2.statusCode, c2.body).toBe(200);
    expect(c1.json().file.id).toBe(c2.json().file.id);
    expect(puts).toBe(1); // assembled and stored once, not twice
    expect((await t.ctx.files.read(c1.json().file.id)).equals(body)).toBe(true);
  });
});

// ───────── 8. a vault restore while a sweep runs ─────────

describe('review 8 — vault restore during a sweep', () => {
  it('the restored vault keeps reading a blob the running sweep had found unreferenced in its OLD file', async () => {
    let gate: Promise<void> | null = null;
    t = await createTestApp({ gc: { orphanGraceMs: 7 * DAY_MS, quarantineMs: 30 * DAY_MS, beforeDecide: async () => void (await gate) } });
    const a = t;
    ownerVault(a);
    const b = await addUser(a, 'student-b');
    const bytes = randomBytes(9000);
    const f = await inVault(a, b.vault.id, () => a.ctx.files.put(bytes, { mime: 'application/pdf', originalName: 'b.pdf' }));
    const backup = await backupVault(a.ctx, b.vault.id);
    // B removes the file; a sweep finds the blob orphaned; a week later another sweep starts
    inVault(a, b.vault.id, () => removeStoredFileIfUnreferenced(a.ctx, f.id));
    a.clock.advance(60_000);
    expect(await a.ctx.gc.run('sweep')).toMatchObject({ status: 'completed', orphaned: 1 });
    a.clock.advance(8 * DAY_MS);
    let open!: () => void;
    gate = new Promise<void>((r) => (open = r));
    const sweep = a.ctx.gc.run('sweep'); // marks the OLD vault file, then waits before deciding
    for (let i = 0; i < 50 && !a.ctx.gc.isRunning; i++) await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 20));
    // the platform admin restores B's vault from the backup that still has the file
    const restoring = restoreVault(a.ctx, b.vault.id, backup.file_name, { idleTimeoutMs: 5000 });
    await new Promise((r) => setTimeout(r, 200));
    open();
    await sweep;
    const res = await restoring;
    expect(res.ok, JSON.stringify(res.checks)).toBe(true);
    await a.ctx.gc.run('mark');
    const back = await inVault(a, b.vault.id, () => a.ctx.files.read(f.id));
    expect(back.equals(bytes)).toBe(true);
    // and the next sweep keeps it
    a.clock.advance(DAY_MS);
    await a.ctx.gc.run('sweep');
    expect(existsSync(a.ctx.blobs.localPath(f.sha256))).toBe(true);
  });
});

describe('review 9 — one restore of a vault at a time', () => {
  it('a second restore of the same vault while one runs is refused; nothing is swapped twice', async () => {
    t = await createTestApp();
    const a = t;
    ownerVault(a);
    const b = await addUser(a, 'student-b');
    await inVault(a, b.vault.id, () => a.ctx.files.put(randomBytes(500), { mime: 'application/pdf' }));
    const backup = await backupVault(a.ctx, b.vault.id);
    const both = await Promise.allSettled([restoreVault(a.ctx, b.vault.id, backup.file_name), restoreVault(a.ctx, b.vault.id, backup.file_name)]);
    const ok = both.filter((r) => r.status === 'fulfilled' && r.value.ok);
    const refused = both.filter((r) => r.status === 'rejected' && (r.reason as { code?: string }).code === 'CONFLICT');
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(a.ctx.system.vaults.byIdInternal(b.vault.id)!.status).toBe('active');
  });
});

describe('review 10 — whole-instance archives of a multi-user past', () => {
  it('an archive made while a second account existed never leaves in clear, even after that account is deleted', async () => {
    t = await createTestApp({ jobs: { backoffBaseMs: 0, backoffMaxMs: 0 } });
    const owner = await t.login();
    const b = await addUser(t, 'student-b');
    await inVault(t, b.vault.id, () => t!.ctx.files.put(Buffer.from('B-PRIVATE-NOTES'), { mime: 'text/plain' }));
    await t.app.inject({ method: 'POST', url: '/api/data/backups', headers: owner, payload: {} });
    await t.ctx.jobs.drain();
    const id = (await t.app.inject({ method: 'GET', url: '/api/data/backups', headers: owner })).json().backups[0].id as string;
    // B deletes their account: one account is left on the server
    t.ctx.system.users.markDeletionPendingInternal(b.user.id);
    t.ctx.system.vaults.setStatusInternal(b.vault.id, 'deleting');
    expect(await finishPendingDeletions(t.ctx)).toBe(1);
    expect(t.ctx.tenancy.sharesFileStore()).toBe(false);
    const res = await t.app.inject({ method: 'GET', url: `/api/data/backups/${id}/download`, headers: owner });
    expect(res.statusCode).toBe(409); // no key configured: refused, never the plain archive with B's vault inside
    expect(res.json().error.message).toMatch(/MEDLEVO_BACKUP_ENCRYPTION_KEY/);
  });
});
