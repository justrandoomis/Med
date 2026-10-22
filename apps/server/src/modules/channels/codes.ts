// Class codes and invite-link tokens (P1-T4 step 1; ARCHITECTURE_DELTA §4.1 `join_code`, §7.3; PRD AOS-2.11–2.13).
//   * a class code is 8 symbols of Crockford's base32 (40 bits), shown once as «ABCD-EFGH»; what a student types is
//     normalised (`normalizeJoinCode`: case, spaces, Arabic digits, O→0, I/L→1) before it is hashed;
//   * an invite link carries 32 random bytes (base64url, 43 characters); the QR encodes the same link;
//   * only an HMAC of the normalised secret is stored, keyed by a sub-key of the server secret — a copy of the system
//     database alone cannot be brute-forced offline (a plain sha256 of a 40-bit code could). Codes and links are
//     domain-separated, so a link token can never be used as a class code or the other way round.
import { randomBytes, randomInt } from 'node:crypto';
import { JOIN_CODE_ALPHABET, JOIN_CODE_LENGTH, normalizeJoinCode } from '@medlevo/shared';
import { hmacSha256 } from '../../lib/hash';

export type JoinSecretKind = 'class_code' | 'invite_link';

/** A fresh class code in its display form «ABCD-EFGH». */
export function generateClassCode(): string {
  let s = '';
  for (let i = 0; i < JOIN_CODE_LENGTH; i++) s += JOIN_CODE_ALPHABET[randomInt(JOIN_CODE_ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/** A fresh invite-link token (base64url, 43 characters). */
export function generateLinkToken(): string {
  return randomBytes(32).toString('base64url');
}

/** The stored form of a secret: HMAC(key, kind ‖ normalised secret), hex. */
export function hashJoinSecret(key: Uint8Array, kind: JoinSecretKind, secret: string): string {
  const normal = kind === 'class_code' ? normalizeJoinCode(secret) : secret;
  return hmacSha256(key, `${kind}\u0000${normal}`).toString('hex');
}

/** The last two characters of the normalised secret, for the admin list. */
export function hintOf(kind: JoinSecretKind, secret: string): string {
  const normal = kind === 'class_code' ? normalizeJoinCode(secret) : secret;
  return normal.slice(-2);
}

/** A class code can only be made of the alphabet (after normalisation) and has exactly 8 symbols. */
export function isWellFormedClassCode(input: string): boolean {
  const n = normalizeJoinCode(input);
  if (n.length !== JOIN_CODE_LENGTH) return false;
  for (const c of n) if (!JOIN_CODE_ALPHABET.includes(c)) return false;
  return true;
}
