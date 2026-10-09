// ULID ids: 26 chars, Crockford base32, lexicographically sortable by creation time.
// Generated on server AND client (ink strokes, review events, attempts, sync ops) so that
// retries and multi-device sync are idempotent: the same logical write always carries the same id.

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LEN = 10;
const RANDOM_LEN = 16;

let lastTime = -1;
let lastRandom: number[] = [];

function randomDigits(): number[] {
  const bytes = new Uint8Array(RANDOM_LEN);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b % 32);
}

function incrementDigits(digits: number[]): number[] {
  const next = digits.slice();
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i]! < 31) {
      next[i] = next[i]! + 1;
      return next;
    }
    next[i] = 0;
  }
  // overflow within the same millisecond is practically impossible (2^80); fall back to fresh randomness
  return randomDigits();
}

function encodeTime(time: number): string {
  let out = '';
  let t = time;
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    const mod = t % 32;
    out = ENCODING[mod] + out;
    t = (t - mod) / 32;
  }
  return out;
}

/** Monotonic ULID. `now` is injectable for deterministic tests. */
export function newId(now: number = Date.now()): string {
  if (now === lastTime) {
    lastRandom = incrementDigits(lastRandom);
  } else {
    lastTime = now;
    lastRandom = randomDigits();
  }
  return encodeTime(now) + lastRandom.map((d) => ENCODING[d]).join('');
}

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function isId(value: unknown): value is string {
  return typeof value === 'string' && ULID_RE.test(value);
}

/** Extract creation time (ms) from a ULID. */
export function idTime(id: string): number {
  let t = 0;
  for (let i = 0; i < TIME_LEN; i++) {
    t = t * 32 + ENCODING.indexOf(id[i]!);
  }
  return t;
}
