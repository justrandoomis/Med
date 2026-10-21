// Encrypted backup archives at rest (P1-T1 step 2; PRD NFR-S3, AOS-21.36): PL-0's «MLVENC01» format (lib/objectstore/
// encryption.ts — AES-256-GCM frames, a fresh salt per archive, MEDLEVO_BACKUP_ENCRYPTION_KEY) applied to a local archive
// file. Used for per-vault backups, for the whole-instance archive a platform admin downloads while several accounts
// exist, and by restore / verification, which accept an encrypted archive (decrypted into their own work directory).
import { createHash } from 'node:crypto';
import { closeSync, createReadStream, createWriteStream, openSync, readSync, renameSync, rmSync } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DecryptStream, ENC_MAGIC, EncryptStream } from '../../lib/objectstore/encryption';

export { ENC_SUFFIX } from '../../lib/objectstore/encryption';

/** Does the file start with the «MLVENC01» magic? */
export function isEncryptedArchive(path: string): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const head = Buffer.alloc(ENC_MAGIC.length);
    const n = readSync(fd, head, 0, head.length, 0);
    return n === head.length && head.equals(ENC_MAGIC);
  } catch {
    return false;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function hashing(): { t: Transform; digest: () => { sha256: string; size: number } } {
  const h = createHash('sha256');
  let size = 0;
  const t = new Transform({
    transform(chunk: Buffer, _e, cb) {
      h.update(chunk);
      size += chunk.length;
      cb(null, chunk);
    },
  });
  return { t, digest: () => ({ sha256: h.digest('hex'), size }) };
}

/** plain archive → «MLVENC01» file (written to `<out>.partial`, renamed when complete). Returns the encrypted file's hash. */
export async function encryptArchive(plainPath: string, outPath: string, master: Buffer, chunkSize?: number): Promise<{ sha256: string; size: number }> {
  const partial = `${outPath}.partial`;
  const meter = hashing();
  try {
    await pipeline(createReadStream(plainPath), new EncryptStream(master, chunkSize ? { chunkSize } : {}), meter.t, createWriteStream(partial, { mode: 0o600 }));
    renameSync(partial, outPath);
    return meter.digest();
  } catch (e) {
    rmSync(partial, { force: true });
    throw e;
  }
}

/** «MLVENC01» file → plain archive (every frame authenticated; DecryptError names wrong key / damage / truncation). */
export async function decryptArchive(encPath: string, outPath: string, master: Buffer): Promise<void> {
  try {
    await pipeline(createReadStream(encPath), new DecryptStream(master), createWriteStream(outPath, { mode: 0o600 }));
  } catch (e) {
    rmSync(outPath, { force: true });
    throw e;
  }
}
