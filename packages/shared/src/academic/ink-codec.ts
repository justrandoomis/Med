// Ink data v2 — packed points (ADR-0004 §2.5, ARCHITECTURE_DELTA §8.2; P1-T2 step 2).
//
// `InkData.points` (v1) is a JSON array of `[x, y, t, pressure?, tiltX?, tiltY?]`. v2 carries the same points as
// `points_packed`: base64 of zigzag-delta LEB128 varints, quantised with EXACTLY the ink engine's rounding
// (`roundInkPoint`: x, y to 1e-5 of the page, t to whole ms, pressure to 1e-3, tilt to whole degrees). The round trip is
// lossless for every point the engine writes; a point that does not sit on that grid (an older client, a hand-made
// payload) is refused (`null`) and the stroke stays v1 — the codec never changes the owner's writing.
//
// Negotiation: a client that understands v2 sends `accept-ink: 2`. Without it (every client before this release) the
// server answers v1 only, so old clients keep working unchanged. Only `kind: 'ink'` data is packed.
//
// Binary layout (all integers LEB128 varints, signed values zigzag-encoded):
//   byte  FORMAT (= 1)
//   uint  n (number of points, ≥ 1)
//   byte  arity: 3…6 when every point has that many channels, 0 when they differ (then each point starts with its arity)
//   per point: [arity byte when mixed] then one zigzag delta per channel from the previous value of that channel
import type { InkData, InkDataV2, InkPoint } from '../annotations';

/** Request header a v2-aware client sends (HTTP header names are case-insensitive; Node lower-cases them). */
export const ACCEPT_INK_HEADER = 'accept-ink';
export type InkFormat = 1 | 2;

const FORMAT = 1;
/** per-channel scale: x, y, t, pressure, tiltX, tiltY */
const SCALE = [1e5, 1e5, 1, 1e3, 1, 1] as const;
/** ±2^31: far beyond any real value (coordinates are within [-1, 2], times a few hours of ms) */
const LIMIT = 2 ** 31;
/** the server limit of points per stroke */
export const MAX_PACKED_POINTS = 20_000;

/** The ink engine's stored-coordinate range (strokes may run past the page edge, not anywhere). */
export const INK_COORD_MIN = -1;
export const INK_COORD_MAX = 2;

/** rounds to a multiple of 1/f; -0 becomes 0 (JSON cannot carry -0, so the stored value is 0 anyway) */
function roundTo(v: number, f: number): number {
  const r = Math.round(v * f) / f;
  return r === 0 ? 0 : r;
}
const roundInt = (v: number): number => {
  const r = Math.round(v);
  return r === 0 ? 0 : r;
};
function coord(v: number): number {
  const r = roundTo(v, 1e5);
  return r < INK_COORD_MIN ? INK_COORD_MIN : r > INK_COORD_MAX ? INK_COORD_MAX : r;
}

/**
 * The rounding every stored ink point goes through (the web engine's `roundPoint` delegates here): x, y to 1e-5 of the
 * page, clamped to [-1, 2]; t to whole ms; pressure to 1e-3; tilt (both or neither) to whole degrees.
 */
export function roundInkPoint(p: InkPoint): InkPoint {
  const out: number[] = [coord(p[0]), coord(p[1]), roundInt(p[2])];
  if (p.length > 3 && p[3] != null) out.push(roundTo(p[3], 1e3));
  if (p.length > 4 && p[4] != null && p[5] != null) out.push(roundInt(p[4]), roundInt(p[5]));
  return out as unknown as InkPoint;
}

/** the integer a value is stored as on channel `c`, or null when the value is not exactly on that channel's grid */
function quantize(v: unknown, c: number): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const s = SCALE[c]!;
  const k = Math.round(v * s);
  if (!Number.isSafeInteger(k) || Math.abs(k) >= LIMIT) return null;
  // lossless: decoding gives back the identical float (k / s is the same expression roundTo uses)
  return k / s === v ? k : null;
}

// ─── varints ───────────────────────────────────────────────────────────────────────────────
class ByteWriter {
  private buf = new Uint8Array(256);
  private len = 0;
  byte(b: number): void {
    if (this.len === this.buf.length) {
      const next = new Uint8Array(this.buf.length * 2);
      next.set(this.buf);
      this.buf = next;
    }
    this.buf[this.len++] = b;
  }
  uint(v: number): void {
    let n = v;
    while (n >= 0x80) {
      this.byte((n % 0x80) | 0x80);
      n = Math.floor(n / 0x80);
    }
    this.byte(n);
  }
  int(v: number): void {
    this.uint(v >= 0 ? v * 2 : -v * 2 - 1);
  }
  bytes(): Uint8Array {
    return this.buf.subarray(0, this.len);
  }
}

class ByteReader {
  private pos = 0;
  constructor(private readonly buf: Uint8Array) {}
  get done(): boolean {
    return this.pos >= this.buf.length;
  }
  byte(): number {
    if (this.pos >= this.buf.length) throw new Error('packed ink: unexpected end of data');
    return this.buf[this.pos++]!;
  }
  uint(): number {
    let result = 0;
    let mul = 1;
    for (let i = 0; i < 8; i++) {
      const b = this.byte();
      result += (b & 0x7f) * mul;
      if ((b & 0x80) === 0) return result;
      mul *= 0x80;
    }
    throw new Error('packed ink: varint too long');
  }
  int(): number {
    const z = this.uint();
    return z % 2 === 0 ? z / 2 : -(z + 1) / 2;
  }
}

// ─── base64 (no Buffer / btoa dependency: the same code runs in the browser, workers and Node) ────────────────────
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + '==';
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + '=';
  }
  return out;
}

export function base64ToBytes(s: string): Uint8Array {
  if (typeof s !== 'string' || s.length % 4 !== 0) throw new Error('packed ink: not base64');
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((s.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    const v = [0, 1, 2, 3].map((k) => {
      const ch = s.charCodeAt(i + k);
      if (ch === 61 /* = */ && i + k >= s.length - pad) return 0;
      const d = ch < 128 ? B64_INDEX[ch]! : -1;
      if (d < 0) throw new Error('packed ink: not base64');
      return d;
    });
    const n = (v[0]! << 18) | (v[1]! << 12) | (v[2]! << 6) | v[3]!;
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

// ─── points ────────────────────────────────────────────────────────────────────────────────
/** Packs points into the v2 base64 form, or returns null when the round trip would not be exact (stay v1). */
export function encodeInkPoints(points: readonly InkPoint[]): string | null {
  if (!Array.isArray(points) || points.length === 0 || points.length > MAX_PACKED_POINTS) return null;
  const arity0 = points[0]?.length ?? 0;
  let uniform = true;
  const q: number[][] = [];
  for (const p of points) {
    if (!Array.isArray(p) || p.length < 3 || p.length > 6) return null;
    if (p.length !== arity0) uniform = false;
    const row: number[] = [];
    for (let c = 0; c < p.length; c++) {
      const k = quantize(p[c], c);
      if (k === null) return null;
      row.push(k);
    }
    q.push(row);
  }
  const w = new ByteWriter();
  w.byte(FORMAT);
  w.uint(points.length);
  w.byte(uniform ? arity0 : 0);
  const last = [0, 0, 0, 0, 0, 0];
  for (const row of q) {
    if (!uniform) w.byte(row.length);
    for (let c = 0; c < row.length; c++) {
      w.int(row[c]! - last[c]!);
      last[c] = row[c]!;
    }
  }
  return bytesToBase64(w.bytes());
}

/** Unpacks v2 base64 points. Throws on anything malformed (never guesses). */
export function decodeInkPoints(packed: string): InkPoint[] {
  const r = new ByteReader(base64ToBytes(packed));
  if (r.byte() !== FORMAT) throw new Error('packed ink: unknown format');
  const n = r.uint();
  if (n < 1 || n > MAX_PACKED_POINTS) throw new Error('packed ink: bad point count');
  const uniformArity = r.byte();
  if (uniformArity !== 0 && (uniformArity < 3 || uniformArity > 6)) throw new Error('packed ink: bad arity');
  const last = [0, 0, 0, 0, 0, 0];
  const out: InkPoint[] = [];
  for (let i = 0; i < n; i++) {
    const arity = uniformArity || r.byte();
    if (arity < 3 || arity > 6) throw new Error('packed ink: bad arity');
    const p: number[] = [];
    for (let c = 0; c < arity; c++) {
      last[c] = last[c]! + r.int();
      if (Math.abs(last[c]!) >= LIMIT) throw new Error('packed ink: value out of range');
      const v = last[c]! / SCALE[c]!;
      p.push(v === 0 ? 0 : v);
    }
    out.push(p as unknown as InkPoint);
  }
  if (!r.done) throw new Error('packed ink: trailing data');
  return out;
}

// ─── InkData ⇄ InkDataV2 ────────────────────────────────────────────────────────────────────
export function isInkDataV2(d: unknown): d is InkDataV2 {
  return !!d && typeof d === 'object' && (d as { v?: unknown }).v === 2 && typeof (d as { points_packed?: unknown }).points_packed === 'string';
}

/** v1 → v2, or null when the points cannot be packed losslessly (the caller keeps v1). */
export function packInkData(d: InkData): InkDataV2 | null {
  const packed = encodeInkPoints(d.points);
  if (packed === null) return null;
  const { points: _points, v: _v, ...rest } = d;
  void _points;
  void _v;
  return { ...rest, v: 2, points_packed: packed };
}

/** v2 → v1 (throws on corrupt data). */
export function unpackInkData(d: InkDataV2): InkData {
  const { points_packed, v: _v, ...rest } = d;
  void _v;
  return { ...rest, v: 1, points: decodeInkPoints(points_packed) } as InkData;
}

/** Either version → v1 (a v1 object is returned as is). */
export function toInkV1(d: InkData | InkDataV2): InkData {
  return isInkDataV2(d) ? unpackInkData(d) : d;
}

/** The `accept-ink` request header → the ink format the client understands (anything but «2» = v1). */
export function parseAcceptInk(header: string | readonly string[] | undefined | null): InkFormat {
  const v = Array.isArray(header) ? header[0] : header;
  return typeof v === 'string' && v.trim() === '2' ? 2 : 1;
}

/**
 * The annotation `data` as a client of `format` should receive it: v1 clients always get v1; v2 clients get packed
 * points for ink strokes when the points pack losslessly (otherwise v1, which every v2 client also reads).
 */
export function inkDataForClient<D>(kind: string, data: D, format: InkFormat): D {
  if (kind !== 'ink' || !data || typeof data !== 'object') return data;
  if (format === 1) return (isInkDataV2(data) ? unpackInkData(data) : data) as D;
  if (isInkDataV2(data)) return data;
  if ((data as { v?: unknown }).v !== 1 || !Array.isArray((data as { points?: unknown }).points)) return data;
  return (packInkData(data as unknown as InkData) ?? data) as D;
}
