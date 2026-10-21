// PL-0: the off-site object store pieces — streaming authenticated encryption, the S3 client (signed requests,
// retries, resumable download) and the resumable multipart uploader — against the in-process S3 fake (./fake-s3.ts),
// which checks every SigV4 signature as received. This is not a test against Cloudflare R2 itself.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  backupKeyId,
  BackupKeyError,
  DecryptError,
  DecryptStream,
  encryptedSize,
  EncryptStream,
  ENC_HEADER_BYTES,
  parseBackupKey,
} from '../../src/lib/objectstore/encryption';
import { S3Client, S3Error } from '../../src/lib/objectstore/s3';
import { uploadObject } from '../../src/lib/objectstore/upload';
import { FakeS3 } from './fake-s3';

const KEY = randomBytes(32);

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const out: Buffer[] = [];
  for await (const c of stream) out.push(c as Buffer);
  return Buffer.concat(out);
}

async function encrypt(plain: Buffer, opts: { salt?: Buffer; chunkSize?: number } = {}, key = KEY): Promise<Buffer> {
  // feed in odd-sized pieces so frame boundaries never line up with writes
  const pieces: Buffer[] = [];
  for (let i = 0; i < plain.length; i += 777) pieces.push(plain.subarray(i, i + 777));
  return collect(Readable.from(pieces).pipe(new EncryptStream(key, opts)));
}

async function decrypt(cipher: Buffer, key = KEY): Promise<Buffer> {
  const pieces: Buffer[] = [];
  for (let i = 0; i < cipher.length; i += 1000) pieces.push(cipher.subarray(i, i + 1000));
  const out: Buffer[] = [];
  await pipeline(Readable.from(pieces), new DecryptStream(key), async (src: AsyncIterable<Buffer>) => {
    for await (const c of src) out.push(c);
  });
  return Buffer.concat(out);
}

const reason = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'no error';
  } catch (e) {
    return e instanceof DecryptError ? e.reason : String(e);
  }
};

describe('backup encryption (MLVENC01, AES-256-GCM STREAM)', () => {
  const C = 1024;

  it('round-trips every size around frame boundaries, including empty', async () => {
    for (const n of [0, 1, C - 1, C, C + 1, 3 * C + 512, 4 * C]) {
      const plain = randomBytes(n);
      const cipher = await encrypt(plain, { chunkSize: C });
      expect(cipher.length, `size ${n}`).toBe(encryptedSize(n, C));
      expect((await decrypt(cipher)).equals(plain), `size ${n}`).toBe(true);
    }
  });

  it('the same salt re-creates byte-identical ciphertext (resume); a fresh salt never does', async () => {
    const plain = randomBytes(5 * C);
    const salt = randomBytes(32);
    const a = await encrypt(plain, { salt, chunkSize: C });
    const b = await encrypt(plain, { salt, chunkSize: C });
    const c = await encrypt(plain, { chunkSize: C });
    expect(a.equals(b)).toBe(true);
    expect(a.equals(c)).toBe(false);
    expect(a.includes(plain.subarray(0, 64))).toBe(false);
  });

  it('refuses tampering, reordering, truncation (also at a frame boundary), appended bytes and a changed header', async () => {
    const plain = randomBytes(4 * C + 100);
    const cipher = await encrypt(plain, { chunkSize: C });
    const frame = C + 16;
    const flip = Buffer.from(cipher);
    flip[ENC_HEADER_BYTES + frame + 10]! ^= 1;
    expect(await reason(decrypt(flip))).toBe('tampered');
    const swapped = Buffer.concat([cipher.subarray(0, ENC_HEADER_BYTES), cipher.subarray(ENC_HEADER_BYTES + frame, ENC_HEADER_BYTES + 2 * frame), cipher.subarray(ENC_HEADER_BYTES, ENC_HEADER_BYTES + frame), cipher.subarray(ENC_HEADER_BYTES + 2 * frame)]);
    expect(await reason(decrypt(swapped))).toBe('tampered');
    expect(await reason(decrypt(cipher.subarray(0, ENC_HEADER_BYTES + 2 * frame)))).toBe('truncated');
    expect(await reason(decrypt(cipher.subarray(0, cipher.length - 5)))).toBe('truncated');
    expect(await reason(decrypt(cipher.subarray(0, 40)))).toBe('truncated');
    expect(['tampered', 'truncated']).toContain(await reason(decrypt(Buffer.concat([cipher, Buffer.alloc(10)]))));
    expect(await reason(decrypt(Buffer.concat([cipher, Buffer.alloc(C + 16)])))).toBe('tampered'); // a whole extra frame
    const header = Buffer.from(cipher);
    header.writeUInt32BE(C * 2, 10);
    expect(['tampered', 'truncated']).toContain(await reason(decrypt(header)));
  });

  it('says which key is needed when the key is wrong, and refuses a plain archive', async () => {
    const cipher = await encrypt(randomBytes(100), { chunkSize: C });
    const other = randomBytes(32);
    try {
      await decrypt(cipher, other);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(DecryptError);
      expect((e as DecryptError).reason).toBe('wrong_key');
      expect((e as DecryptError).details).toEqual({ expectedKeyId: backupKeyId(KEY), foundKeyId: backupKeyId(other) });
      expect((e as DecryptError).reasonAr).toContain('MEDLEVO_BACKUP_ENCRYPTION_KEY');
    }
    expect(await reason(decrypt(Buffer.from('medlevo-backup/manifest.json'.padEnd(600, '\0'))))).toBe('not_encrypted');
  });

  it('parses the key as Render generates it (base64 of 32 bytes), base64url or hex — nothing weaker', () => {
    const raw = randomBytes(32);
    expect(parseBackupKey(raw.toString('base64')).equals(raw)).toBe(true);
    expect(parseBackupKey(` ${raw.toString('base64url')} `).equals(raw)).toBe(true);
    expect(parseBackupKey(raw.toString('hex')).equals(raw)).toBe(true);
    for (const bad of ['', 'password123', randomBytes(16).toString('base64'), randomBytes(31).toString('hex')]) {
      expect(() => parseBackupKey(bad), bad).toThrow(BackupKeyError);
    }
    expect(backupKeyId(raw)).toMatch(/^[0-9a-f]{32}$/);
    expect(backupKeyId(raw)).toBe(backupKeyId(Buffer.from(raw)));
    expect(backupKeyId(raw)).not.toContain(raw.toString('hex').slice(0, 16));
  });
});

describe('S3 client against the signature-checking fake', () => {
  let fake: FakeS3;
  let dir: string;
  const noSleep = async () => {};
  const client = (o: { secret?: string; now?: () => number } = {}) =>
    new S3Client(
      { endpoint: fake.endpoint, bucket: fake.bucket, region: 'auto', credentials: { accessKeyId: fake.accessKeyId, secretAccessKey: () => o.secret ?? fake.secretAccessKey } },
      { sleep: noSleep, now: o.now, maxAttempts: 4 },
    );

  beforeEach(async () => {
    fake = new FakeS3({ minPartBytes: 64 * 1024, listPageSize: 2 });
    await fake.start();
    dir = mkdtempSync(join(tmpdir(), 'medlevo-s3-'));
  });
  afterEach(async () => {
    await fake.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('put / head / get / list (paginated) / delete with metadata and awkward key characters', async () => {
    const s3 = client();
    const keys = ['medlevo/backups/a b+c.mlenc', 'medlevo/backups/ملف.mlenc', 'medlevo/backups/x~y*z.mlenc', 'other/k'];
    for (const [i, k] of keys.entries()) await s3.putObject(k, Buffer.from(`body-${i}`), { metadata: { 'medlevo-key-id': 'abc', n: String(i) } });
    const head = await s3.headObject(keys[1]!);
    expect(head).toMatchObject({ size: 6, metadata: { 'medlevo-key-id': 'abc', n: '1' } });
    expect(await s3.headObject('medlevo/backups/missing')).toBeNull();
    const listed = await s3.listObjects('medlevo/backups/');
    expect(listed.map((o) => o.key).sort()).toEqual(keys.slice(0, 3).sort());
    const dest = join(dir, 'x');
    expect(await s3.getObjectToFile(keys[0]!, dest, { expectedSize: 6 })).toBe(6);
    expect(readFileSync(dest, 'utf8')).toBe('body-0');
    await s3.deleteObject(keys[0]!);
    expect(await s3.headObject(keys[0]!)).toBeNull();
    expect(fake.rejected).toEqual([]);
  });

  it('retries 5xx and dropped connections, never a refusal; a wrong secret or a skewed clock is reported, not retried', async () => {
    const s3 = client();
    fake.fail('PutObject', 2, { status: 503, code: 'SlowDown' });
    await s3.putObject('k1', Buffer.from('x'));
    expect(fake.count('PutObject')).toBe(3);
    fake.fail('PutObject', 1, { drop: true });
    await s3.putObject('k2', Buffer.from('y'));
    expect(fake.objects.get('k2')?.body.toString()).toBe('y');
    fake.fail('PutObject', 1, { status: 403, code: 'AccessDenied' });
    await expect(s3.putObject('k3', Buffer.from('z'))).rejects.toMatchObject({ status: 403, code: 'AccessDenied' });
    const before = fake.count('PutObject');
    await expect(client({ secret: 'wrong-secret' }).putObject('k4', Buffer.from('z'))).rejects.toMatchObject({ code: 'SignatureDoesNotMatch' });
    expect(fake.count('PutObject')).toBe(before); // refused before it became an operation, and not retried
    expect(fake.rejected).toEqual(['SignatureDoesNotMatch']);
    await expect(client({ now: () => Date.now() + 20 * 60_000 }).headObject('k1')).rejects.toBeInstanceOf(S3Error);
    expect(fake.rejected).toContain('RequestTimeTooSkewed');
  });

  it('download resumes with a Range request after the connection is cut', async () => {
    const s3 = client();
    const body = randomBytes(300 * 1024);
    await s3.putObject('big', body);
    fake.fail('GetObject', 1, { drop: true, afterBytes: 100 * 1024 });
    const dest = join(dir, 'big');
    expect(await s3.getObjectToFile('big', dest, { expectedSize: body.length })).toBe(body.length);
    expect(readFileSync(dest).equals(body)).toBe(true);
    expect(fake.count('GetObject')).toBe(2);
  });

  it('multipart upload: equal parts, the object is exactly the source; a failed upload resumes and skips stored parts', async () => {
    const s3 = client();
    const part = 64 * 1024;
    const src = randomBytes(5 * part + 1234);
    const file = join(dir, 'src');
    writeFileSync(file, src);
    const open = () => Readable.from([src.subarray(0, 100_000), src.subarray(100_000)]);

    // first attempt: part 4 keeps failing (retries exhausted) → the upload stays open, its id is kept
    fake.fail('UploadPart', 4, { status: 500, partNumber: 4 });
    let saved: string | null = null;
    await expect(uploadObject(s3, 'medlevo/backups/m.mlenc', open, src.length, { partSize: part, onUploadId: (id) => (saved = id), metadata: { 'medlevo-format': 'x' } })).rejects.toBeInstanceOf(S3Error);
    expect(saved).not.toBeNull();
    expect(fake.objects.has('medlevo/backups/m.mlenc')).toBe(false);
    const firstRound = fake.log.filter((r) => r.op === 'UploadPart').map((r) => r.partNumber);
    expect(firstRound.filter((n) => n === 1)).toHaveLength(1);

    // resume: parts 1–3 are already stored with matching MD5 → skipped; 4–6 uploaded; object complete and exact
    const res = await uploadObject(s3, 'medlevo/backups/m.mlenc', open, src.length, { partSize: part, resumeUploadId: saved, metadata: { 'medlevo-format': 'x' } });
    expect(res).toMatchObject({ parts: 6, partsSkipped: 3, uploadId: saved });
    const uploads = fake.log.filter((r) => r.op === 'UploadPart').map((r) => r.partNumber);
    expect(uploads.filter((n) => n === 1)).toHaveLength(1);
    expect(fake.objects.get('medlevo/backups/m.mlenc')!.body.equals(src)).toBe(true);
    expect(fake.objects.get('medlevo/backups/m.mlenc')!.etag).toMatch(/-6$/);
    expect(fake.objects.get('medlevo/backups/m.mlenc')!.metadata).toEqual({ 'medlevo-format': 'x' });
    expect(fake.uploads.size).toBe(0);
    expect(fake.rejected).toEqual([]);
  });

  it('an expired / unknown upload id starts a fresh upload instead of failing', async () => {
    const s3 = client();
    const part = 64 * 1024;
    const src = randomBytes(2 * part + 10);
    const res = await uploadObject(s3, 'k', () => Readable.from([src]), src.length, { partSize: part, resumeUploadId: 'gone' });
    expect(res.partsSkipped).toBe(0);
    expect(fake.objects.get('k')!.body.equals(src)).toBe(true);
  });

  it('a source that changed size is refused (never a silently different object)', async () => {
    const s3 = client();
    const part = 64 * 1024;
    const src = randomBytes(2 * part + 10);
    await expect(uploadObject(s3, 'k', () => Readable.from([src]), src.length + 1, { partSize: part })).rejects.toMatchObject({ code: 'SourceChanged' });
    await expect(uploadObject(s3, 'small', () => Readable.from([Buffer.from('abc')]), 4, { partSize: part })).rejects.toMatchObject({ code: 'SourceChanged' });
    expect(fake.objects.has('k')).toBe(false);
  });
});
