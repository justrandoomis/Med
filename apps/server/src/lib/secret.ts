// Server secret (HMAC keys for short-lived file tokens, etc.).
// Generated on first boot in DATA_DIR/secret.key with 0600 permissions. It is never logged,
// returned by any API, or included in exports. Backups must treat it as a secret.
import { createHmac, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, existsSync, openSync, readFileSync, statSync, writeSync, fsyncSync } from 'node:fs';
import { join } from 'node:path';

const SECRET_FILE = 'secret.key';
const SECRET_BYTES = 32;

export function loadOrCreateServerSecret(dataDir: string): Buffer {
  const path = join(dataDir, SECRET_FILE);
  if (!existsSync(path)) {
    try {
      // 'wx' → fails if another process created it concurrently; mode applies on creation.
      const fd = openSync(path, 'wx', 0o600);
      try {
        writeSync(fd, randomBytes(SECRET_BYTES).toString('base64'));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
  if (process.platform !== 'win32') {
    const mode = statSync(path).mode & 0o777;
    if (mode !== 0o600) chmodSync(path, 0o600);
  }
  const value = Buffer.from(readFileSync(path, 'utf8').trim(), 'base64');
  if (value.length < SECRET_BYTES) {
    throw new Error('server secret file is invalid (too short); refusing to start');
  }
  return value;
}

/** Derive an independent sub-key for one purpose (so one leaked key never unlocks another use). */
export function deriveKey(secret: Uint8Array, purpose: string): Buffer {
  return createHmac('sha256', secret).update(`medlevo:${purpose}`).digest();
}
