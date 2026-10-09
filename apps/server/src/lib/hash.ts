import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { Readable } from 'node:stream';

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export async function sha256Stream(stream: Readable): Promise<{ sha256: string; size: number }> {
  const h = createHash('sha256');
  let size = 0;
  for await (const chunk of stream) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    size += buf.length;
    h.update(buf);
  }
  return { sha256: h.digest('hex'), size };
}

export function sha256File(path: string): Promise<{ sha256: string; size: number }> {
  return sha256Stream(createReadStream(path));
}

export function hmacSha256(key: Uint8Array, data: string | Uint8Array): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

/**
 * Constant-time comparison of two strings/buffers. Inputs are hashed first so differing lengths
 * do not leak through timing and timingSafeEqual never throws.
 */
export function safeEqual(a: string | Uint8Array, b: string | Uint8Array): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** Opaque random token (base64url). 32 bytes = 256 bits by default. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
