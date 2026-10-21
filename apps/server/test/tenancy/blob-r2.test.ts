// P1-T1 step 2 — the R2 object-store adapter for blobs (PRD AOS-OC.7 / AOS-21.34; ADR-0005 §B.5), against the
// in-process S3 fake that verifies every SigV4 signature (../data/fake-s3.ts) — NOT against Cloudflare R2.
// Content-addressed keys mirror the disk layout; every object is MLVENC01-encrypted on this server first; a blob whose
// local copy is missing is fetched back and verified before it is read; the GC is the only thing that deletes a
// remote copy.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config';
import { removeStoredFileIfUnreferenced } from '../../src/modules/files/blobs';
import { DAY_MS } from '../../src/modules/files/gc';
import { DecryptStream, parseBackupKey } from '../../src/lib/objectstore/encryption';
import type { Binding } from '../../src/system/binding';
import { createTestApp, type TestApp } from '../helpers/app';
import { addUser } from '../helpers/tenancy';
import { FakeS3 } from '../data/fake-s3';

const KEY_B64 = randomBytes(32).toString('base64');
const MARKER = Buffer.from('MEDLEVO-PLAINTEXT-BLOB-MARKER-ملف');
let fake: FakeS3;
let t: TestApp | null = null;

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
});

const r2Env = () => ({
  MEDLEVO_BLOB_STORE: 'r2',
  MEDLEVO_R2_ENDPOINT: fake.endpoint,
  MEDLEVO_R2_BUCKET: fake.bucket,
  MEDLEVO_R2_ACCESS_KEY_ID: fake.accessKeyId,
  MEDLEVO_R2_SECRET_ACCESS_KEY: fake.secretAccessKey,
  MEDLEVO_BACKUP_ENCRYPTION_KEY: KEY_B64,
});

async function app() {
  t = await createTestApp({ env: r2Env(), blobStore: { client: { sleep: async () => {}, maxAttempts: 2 }, encChunkSize: 4096, partSizeBytes: 64 * 1024 } });
  return t;
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const ownerVault = (a: TestApp) => (a.ownerBinding() as Extract<Binding, { kind: 'vault' }>).vaultId;

async function decrypt(body: Buffer): Promise<Buffer> {
  const d = new DecryptStream(parseBackupKey(KEY_B64));
  const out: Buffer[] = [];
  d.on('data', (c: Buffer) => out.push(c));
  await new Promise<void>((resolve, reject) => {
    d.on('end', () => resolve());
    d.on('error', reject);
    d.end(body);
  });
  return Buffer.concat(out);
}

describe('R2 blob store', () => {
  it('refuses to start when MEDLEVO_BLOB_STORE=r2 is asked for without the R2 settings and the key', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', MEDLEVO_DATA_DIR: '/tmp/x', MEDLEVO_BLOB_STORE: 'r2' })).toThrow(/MEDLEVO_BLOB_STORE=r2/);
  });

  it('copies each blob once, encrypted, under its content-addressed key; the registry records the remote copy', async () => {
    const a = await app();
    const bytes = Buffer.concat([MARKER, randomBytes(150 * 1024)]); // several frames and parts
    const f = await a.ctx.files.put(bytes, { mime: 'application/pdf' });
    expect(a.ctx.system.blobs.getInternal(f.sha256)!.storage).toBe('local');
    expect(await a.ctx.blobs.replicatePending()).toMatchObject({ copied: 1, failed: 0 });
    const key = `medlevo/blobs/${f.sha256.slice(0, 2)}/${f.sha256.slice(2, 4)}/${f.sha256}.mlenc`;
    const obj = fake.objects.get(key);
    expect(obj).toBeTruthy();
    expect(obj!.body.includes(MARKER)).toBe(false); // nothing leaves the host in clear
    expect(obj!.body.subarray(0, 8).toString('latin1')).toBe('MLVENC01');
    expect((await decrypt(obj!.body)).equals(bytes)).toBe(true);
    expect(a.ctx.system.blobs.getInternal(f.sha256)!.storage).toBe('r2');
    // nothing left to copy; a second pass uploads nothing
    expect(await a.ctx.blobs.replicatePending()).toMatchObject({ copied: 0 });
    expect(fake.objects.size).toBe(1);
  });

  it('a blob whose local copy is lost is fetched back, verified and served (read, stream, HTTP)', async () => {
    const a = await app();
    const h = await a.login();
    const bytes = randomBytes(70 * 1024);
    const f = await a.ctx.files.put(bytes, { mime: 'application/pdf', originalName: 'x.pdf' });
    await a.ctx.blobs.replicatePending();
    rmSync(a.ctx.blobs.localPath(f.sha256)); // the disk lost it
    const res = await a.app.inject({ method: 'GET', url: `/api/files/${f.id}`, headers: h });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(bytes)).toBe(true);
    expect(existsSync(a.ctx.blobs.localPath(f.sha256))).toBe(true);
    rmSync(a.ctx.blobs.localPath(f.sha256));
    expect((await a.ctx.files.read(f.id)).equals(bytes)).toBe(true);
  });

  it('a damaged remote copy is never served: the fetch fails and nothing is written in place', async () => {
    const a = await app();
    const bytes = randomBytes(20 * 1024);
    const f = await a.ctx.files.put(bytes, { mime: 'application/pdf' });
    await a.ctx.blobs.replicatePending();
    const key = [...fake.objects.keys()][0]!;
    const obj = fake.objects.get(key)!;
    obj.body = Buffer.from(obj.body);
    obj.body[200] = obj.body[200]! ^ 0xff;
    rmSync(a.ctx.blobs.localPath(f.sha256));
    expect(await a.ctx.blobs.ensureLocal(f.sha256, f.size)).toBe(false);
    expect(existsSync(a.ctx.blobs.localPath(f.sha256))).toBe(false);
    await expect(a.ctx.files.read(f.id)).rejects.toThrow();
  });

  it('only the registry deletes a remote copy: the single-database purge and the GC after quarantine', async () => {
    const a = await app();
    const one = await a.ctx.files.put(randomBytes(5000), { mime: 'application/pdf' });
    await a.ctx.blobs.replicatePending();
    expect(fake.objects.size).toBe(1);
    removeStoredFileIfUnreferenced(a.ctx, one.id); // one database: exact, immediate
    await a.ctx.blobs.settled();
    expect(fake.objects.size).toBe(0);

    // several databases: the remote copy goes only after orphan → quarantine → 30 days → a fresh mark misses it
    const vA = ownerVault(a);
    const b = await addUser(a, 'student-b');
    const bytes = randomBytes(6000);
    const f = await a.ctx.binding.run({ kind: 'vault', vaultId: vA, viewer: null }, () => a.ctx.files.put(bytes, { mime: 'application/pdf' }));
    await a.ctx.binding.run({ kind: 'vault', vaultId: b.vault.id, viewer: null }, () => a.ctx.files.put(randomBytes(10), { mime: 'text/plain' }));
    await a.ctx.blobs.replicatePending();
    a.ctx.binding.run({ kind: 'vault', vaultId: vA, viewer: null }, () => removeStoredFileIfUnreferenced(a.ctx, f.id));
    const key = `medlevo/blobs/${f.sha256.slice(0, 2)}/${f.sha256.slice(2, 4)}/${f.sha256}.mlenc`;
    a.clock.advance(60_000);
    await a.ctx.gc.run('sweep');
    a.clock.advance(8 * DAY_MS);
    await a.ctx.gc.run('sweep');
    expect(fake.objects.has(key)).toBe(true); // quarantined, still kept remotely
    a.clock.advance(31 * DAY_MS);
    expect(await a.ctx.gc.run('sweep')).toMatchObject({ deleted: 1 });
    expect(fake.objects.has(key)).toBe(false);
    expect(sha(bytes)).toBe(f.sha256);
  });
});
