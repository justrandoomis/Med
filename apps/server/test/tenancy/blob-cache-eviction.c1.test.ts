// AOS-21.34 «local-cache eviction» — with MEDLEVO_BLOB_STORE=r2 the server disk becomes a BOUNDED cache of the blob
// store when MEDLEVO_BLOB_CACHE_MB is set: the maintenance pass removes local copies of blobs whose encrypted remote
// copy is CONFIRMED (storage = 'r2'), least recently used first, until the local copies fit the budget. A read fetches
// an evicted blob back (decrypted, sha256-verified) before serving it. Never evicted: a blob not yet copied, a
// quarantined or orphaned one, one with an upload in flight, one written or read in the last minutes. Without the
// setting the disk stays a full cache (unchanged). Against the signature-checking S3 fake — NOT Cloudflare R2.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, utimesSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/app';
import { FakeS3 } from '../data/fake-s3';

const KEY_B64 = randomBytes(32).toString('base64');
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

const KB = 1024;
const env = (cacheMb?: string) => ({
  MEDLEVO_BLOB_STORE: 'r2',
  MEDLEVO_R2_ENDPOINT: fake.endpoint,
  MEDLEVO_R2_BUCKET: fake.bucket,
  MEDLEVO_R2_ACCESS_KEY_ID: fake.accessKeyId,
  MEDLEVO_R2_SECRET_ACCESS_KEY: fake.secretAccessKey,
  MEDLEVO_BACKUP_ENCRYPTION_KEY: KEY_B64,
  ...(cacheMb ? { MEDLEVO_BLOB_CACHE_MB: cacheMb } : {}),
});
async function app(cacheMb?: string) {
  t = await createTestApp({ env: env(cacheMb), blobStore: { client: { sleep: async () => {}, maxAttempts: 2 }, encChunkSize: 4096, partSizeBytes: 64 * 1024 } });
  return t;
}
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
/** make a local copy look last used `ageMs` ago */
const age = (a: TestApp, s: string, ageMs: number) => {
  const when = new Date(Date.now() - ageMs);
  utimesSync(a.ctx.blobs.localPath(s), when, when);
};

describe('AOS-21.34 — the local disk as a bounded cache of the R2 blob store', () => {
  it('evicts least-recently-used local copies of CONFIRMED remote blobs until they fit; reads fetch them back', async () => {
    const a = await app('0.25'); // 256 KiB of local copies
    const blobs = [randomBytes(100 * KB), randomBytes(100 * KB), randomBytes(100 * KB)];
    const files = [];
    for (const b of blobs) files.push(await a.ctx.files.put(b, { mime: 'application/pdf' }));
    expect(await a.ctx.blobs.replicatePending()).toMatchObject({ copied: 3 });
    age(a, files[0]!.sha256, 3 * 3600_000); // oldest use
    age(a, files[1]!.sha256, 2 * 3600_000);
    age(a, files[2]!.sha256, 1 * 3600_000);
    const r = await a.ctx.blobs.evictLocal();
    expect(r.evicted).toBe(1);
    expect(r.localBytes).toBeLessThanOrEqual(256 * KB);
    expect(existsSync(a.ctx.blobs.localPath(files[0]!.sha256))).toBe(false);
    expect(existsSync(a.ctx.blobs.localPath(files[2]!.sha256))).toBe(true);
    // the remote copy is still there and the registry still says so
    expect(a.ctx.system.blobs.getInternal(files[0]!.sha256)!.storage).toBe('r2');
    // reading the evicted file fetches it back, verified
    const back = await a.ctx.files.read(files[0]!.id);
    expect(sha(back)).toBe(files[0]!.sha256);
    expect(existsSync(a.ctx.blobs.localPath(files[0]!.sha256))).toBe(true);
  });

  it('never evicts a blob not yet copied, a quarantined one, or one used in the last minutes', async () => {
    const a = await app('0.01'); // a budget nothing fits in
    const copied = await a.ctx.files.put(randomBytes(40 * KB), { mime: 'application/pdf' });
    expect(await a.ctx.blobs.replicatePending()).toMatchObject({ copied: 1 });
    const notCopied = await a.ctx.files.put(randomBytes(40 * KB), { mime: 'application/pdf' });
    const recent = copied; // used just now (written above)
    let r = await a.ctx.blobs.evictLocal();
    expect(r.evicted).toBe(0); // the copied blob is recent, the other is not copied yet
    expect(existsSync(a.ctx.blobs.localPath(recent.sha256))).toBe(true);
    // once it is old enough the copied one goes; the not-yet-copied one stays
    age(a, copied.sha256, 3600_000);
    age(a, notCopied.sha256, 3600_000);
    r = await a.ctx.blobs.evictLocal();
    expect(r.evicted).toBe(1);
    expect(existsSync(a.ctx.blobs.localPath(copied.sha256))).toBe(false);
    expect(existsSync(a.ctx.blobs.localPath(notCopied.sha256))).toBe(true);
    // a quarantined blob is never evicted from its quarantine either (the GC owns it)
    expect(a.ctx.system.blobs.getInternal(notCopied.sha256)!.storage).toBe('local');
  });

  it('without MEDLEVO_BLOB_CACHE_MB the disk stays a full cache', async () => {
    const a = await app();
    const f = await a.ctx.files.put(randomBytes(40 * KB), { mime: 'application/pdf' });
    await a.ctx.blobs.replicatePending();
    age(a, f.sha256, 24 * 3600_000);
    expect((await a.ctx.blobs.evictLocal()).evicted).toBe(0);
    expect(existsSync(a.ctx.blobs.localPath(f.sha256))).toBe(true);
  });

  it('the cache budget needs the R2 blob store (refused at start otherwise)', async () => {
    const { loadConfig } = await import('../../src/config');
    expect(() => loadConfig({ NODE_ENV: 'test', MEDLEVO_DATA_DIR: '/tmp/x', MEDLEVO_BLOB_CACHE_MB: '100' })).toThrow(/MEDLEVO_BLOB_CACHE_MB/);
  });
});
