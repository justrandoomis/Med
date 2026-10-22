// AOS-21.12 / NFR-P3 (ADR-0004 §2.5) — «a 5,000-stroke page transfer ≤ 8 MB MEASURED ON THE WIRE». Packed points
// (ink v2, `accept-ink: 2`) travel as base64 inside JSON (+33 %): the spike page (≈ 224 samples a stroke, 5.9 MB of
// packed points) is over the budget as plain JSON. JSON responses of 1 KiB or more are therefore compressed (br or gzip,
// whichever the client accepts) — and only then; a client that accepts neither gets the identical identity body.
// Sizes below are bytes ON THE WIRE (the compressed body), stated as such.
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { roundInkPoint, type InkData, type InkPoint } from '@medlevo/shared';
import { type AuthHeaders, createTestApp, type TestApp } from '../helpers/app';
import { createSourceFixture, pageAnchor, type SourceFixture } from './helpers';

let t: TestApp;
let h: AuthHeaders;
let f: SourceFixture;
const BUDGET = 8_000_000;
const SAMPLES = 224; // the spike page: 5,899,202 B of packed points over 5,000 strokes ≈ 224 samples each

/** a realistic pen stroke on the engine's rounding grid */
function realisticInk(seed: number, n = SAMPLES): InkData {
  let x = 0.1 + ((seed * 7919) % 800) / 1000;
  let y = 0.1 + ((seed * 104729) % 800) / 1000;
  const pts: InkPoint[] = [];
  for (let i = 0; i < n; i++) {
    x += Math.sin(i / 7 + seed) * 0.002;
    y += Math.cos(i / 5 + seed) * 0.0015;
    pts.push(roundInkPoint([x, y, i * 8, 0.35 + 0.3 * Math.abs(Math.sin(i / 9 + seed))]));
  }
  return { v: 1, points: pts, style: { tool: 'pen', color: 'ink-blue', width: 0.0025 }, bbox: { x: 0, y: 0, w: 1, h: 1 }, pressure_available: true, tilt_available: false };
}

beforeAll(async () => {
  t = await createTestApp();
  h = await t.login();
  f = createSourceFixture(t);
  const now = t.clock.now();
  const anchor = JSON.stringify(pageAnchor(f, 0));
  t.ctx.db.tx(() => {
    for (let i = 0; i < 5000; i++) {
      const id = `W${String(i).padStart(6, '0')}`;
      t.ctx.db.run(`INSERT INTO annotation (id, kind, tool, anchor_json, data_json, layer, rev, created_at, updated_at) VALUES (?, 'ink', 'pen', ?, ?, 'ink', 1, ?, ?)`, [id, anchor, JSON.stringify(realisticInk(i)), now, now]);
      t.ctx.db.run(`INSERT INTO annotation_target (annotation_id, target_type, target_id) VALUES (?, 'source_page', ?)`, [id, f.pageIds[0]]);
      t.ctx.sync.touch('annotation', id);
    }
  });
}, 300_000);
afterAll(async () => {
  await t?.close();
});

/** pull the whole page; `wire` = body bytes as sent, `plain` = the JSON the client reads */
async function pullAll(headers: Record<string, string>) {
  let since = 0;
  let wire = 0;
  let plain = 0;
  const encodings = new Set<string>();
  const bodies: string[] = [];
  for (;;) {
    const res = await t.app.inject({ method: 'GET', url: `/api/sync/pull?since=${since}&limit=1000`, headers: { ...h, ...headers } });
    expect(res.statusCode).toBe(200);
    const raw = res.rawPayload;
    const enc = String(res.headers['content-encoding'] ?? 'identity');
    encodings.add(enc);
    const text = (enc === 'br' ? brotliDecompressSync(raw) : enc === 'gzip' ? gunzipSync(raw) : raw).toString('utf8');
    wire += raw.length;
    plain += Buffer.byteLength(text);
    bodies.push(text);
    const j = JSON.parse(text) as { next_since: number; has_more: boolean };
    since = j.next_since;
    if (!j.has_more) break;
  }
  return { wire, plain, encodings: [...encodings], bodies };
}

describe('AOS-21.12 / NFR-P3 — the 5,000-stroke page on the wire', () => {
  it('packed points as plain JSON are over the budget (the reason compression exists)', async () => {
    const plain = await pullAll({ 'accept-ink': '2' });
    console.log(`[wire] 5000 strokes × ${SAMPLES} samples, v2 JSON identity: ${(plain.wire / 1e6).toFixed(2)} MB on the wire`);
    expect(plain.encodings).toEqual(['identity']);
    expect(plain.wire).toBeGreaterThan(BUDGET);
  });

  it('with accept-encoding the same page is ≤ 8 MB on the wire, and decodes to the identical JSON', async () => {
    const plain = await pullAll({ 'accept-ink': '2' });
    for (const enc of ['gzip', 'br'] as const) {
      const c = await pullAll({ 'accept-ink': '2', 'accept-encoding': enc });
      console.log(`[wire] 5000 strokes v2 + ${enc}: ${(c.wire / 1e6).toFixed(2)} MB on the wire (${(c.plain / 1e6).toFixed(2)} MB of JSON)`);
      expect(c.encodings).toEqual([enc]);
      expect(c.wire).toBeLessThanOrEqual(BUDGET);
      expect(c.bodies.join('\n')).toBe(plain.bodies.join('\n'));
    }
  }, 120_000);

  it('small answers are not compressed; a client that accepts nothing gets identity', async () => {
    const small = await t.app.inject({ method: 'GET', url: '/api/health', headers: { 'accept-encoding': 'gzip, br' } });
    expect(small.headers['content-encoding']).toBeUndefined();
    const none = await t.app.inject({ method: 'GET', url: '/api/sync/pull?since=0&limit=50', headers: { ...h, 'accept-encoding': 'identity' } });
    expect(none.headers['content-encoding']).toBeUndefined();
    expect(none.json().changes.length).toBe(50);
  });
});
