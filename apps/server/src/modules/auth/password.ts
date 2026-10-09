// Password & recovery-code hashing with scrypt (node:crypto). Format: scrypt$N$r$p$salt_b64$hash_b64.
// Parameters are stored with each hash, so raising the cost later keeps old hashes verifiable.
import { randomBytes, randomInt, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

const KEY_LEN = 32;
const SALT_LEN = 16;

function scrypt(password: string | Buffer, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

function maxmemFor(N: number, r: number): number {
  return 128 * N * r * 2 + 16 * 1024 * 1024;
}

export async function hashSecret(secret: string, logN: number): Promise<string> {
  const N = 2 ** logN;
  const r = 8;
  const p = 1;
  const salt = randomBytes(SALT_LEN);
  const key = await scrypt(secret.normalize('NFC'), salt, KEY_LEN, { N, r, p, maxmem: maxmemFor(N, r) });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifySecret(secret: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p) || N < 2 ** 10 || N > 2 ** 20 || r < 1 || r > 32 || p < 1 || p > 4) return false;
  const salt = Buffer.from(parts[4]!, 'base64');
  const expected = Buffer.from(parts[5]!, 'base64');
  if (expected.length !== KEY_LEN) return false;
  const key = await scrypt(secret.normalize('NFC'), salt, KEY_LEN, { N, r, p, maxmem: maxmemFor(N, r) });
  return timingSafeEqual(key, expected);
}

/** A fixed hash used to equalize timing when the username is wrong or no owner exists. */
const dummyHashes = new Map<number, Promise<string>>();
export function dummyHashFor(logN: number): Promise<string> {
  let h = dummyHashes.get(logN);
  if (!h) {
    h = hashSecret('medlevo-timing-equalizer', logN);
    dummyHashes.set(logN, h);
  }
  return h;
}

const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32 (no I, L, O, U)

/** Human-friendly one-time recovery code: XXXX-XXXX-XXXX (60 bits). */
export function generateRecoveryCode(): string {
  let s = '';
  for (let i = 0; i < 12; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}

/** Normalize what the owner typed: case-insensitive, ignore spaces/dashes, map confusable letters. */
export function normalizeRecoveryCode(input: string): string {
  const s = input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
  if (s.length !== 12) return s;
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}
