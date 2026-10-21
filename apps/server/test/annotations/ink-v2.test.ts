// P1-T2 step 2 — ink data v2 on the wire (ADR-0004 §2.5, ARCHITECTURE_DELTA §8.2; PRD AOS-1.10, 21.12, NFR-P3): the server
// accepts v1 and v2; pull, push answers and the read APIs carry v2 only to clients that send `accept-ink: 2`, so old
// clients keep receiving v1. The server stores one format (v1) so every server reader keeps working.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeInkPoints, newId, packInkData, roundInkPoint, toInkV1, type AnnotationDTO, type InkData, type InkDataV2, type InkPoint, type SyncOp, type SyncOpResult } from '@medlevo/shared';
import { type AuthHeaders, createTestApp, type TestApp } from '../helpers/app';
import { createSourceFixture, inkData, inkPayload, op, pageAnchor, type SourceFixture } from './helpers';

let t: TestApp;
let h: AuthHeaders;
let f: SourceFixture;

beforeEach(async () => {
  t = await createTestApp();
  h = await t.login();
  f = createSourceFixture(t);
});
afterEach(async () => {
  await t.close();
});

const V2 = { 'accept-ink': '2' };
async function push(ops: SyncOp[], extra: Record<string, string> = {}): Promise<SyncOpResult[]> {
  const res = await t.app.inject({ method: 'POST', url: '/api/sync/push', headers: { ...h, ...extra }, payload: { ops } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().results as SyncOpResult[];
}
const pull = async (extra: Record<string, string> = {}) => (await t.app.inject({ method: 'GET', url: '/api/sync/pull?since=0&limit=1000', headers: { ...h, ...extra } })).json() as { changes: Array<{ entity_id: string; entity: AnnotationDTO | null }> };

/** a realistic pen stroke: ~120 samples with pressure, on the engine's rounding grid */
function realisticInk(seed: number, n = 120): InkData {
  let x = 0.1 + ((seed * 7919) % 800) / 1000;
  let y = 0.1 + ((seed * 104729) % 800) / 1000;
  const pts: InkPoint[] = [];
  for (let i = 0; i < n; i++) {
    x += Math.sin(i / 7 + seed) * 0.002;
    y += Math.cos(i / 5 + seed) * 0.0015;
    pts.push(roundInkPoint([x, y, i * 8, 0.35 + 0.3 * Math.abs(Math.sin(i / 9))]));
  }
  return { v: 1, points: pts, style: { tool: 'pen', color: 'ink-blue', width: 0.0025 }, bbox: { x: 0, y: 0, w: 1, h: 1 }, pressure_available: true, tilt_available: false };
}

describe('accept-ink negotiation', () => {
  it('a v2 client pushes packed points: stored as v1, answered in v2; an old client reads the same stroke as v1', async () => {
    const v1 = realisticInk(1);
    const v2 = packInkData(v1)!;
    const id = newId();
    const [r] = await push([op({ entity_type: 'annotation', entity_id: id, op: 'append', payload: { ...inkPayload(f), data: v2 } })], V2);
    expect(r!.result).toBe('applied');
    expect((r!.entity as AnnotationDTO).data).toEqual(v2);
    const stored = JSON.parse(t.ctx.db.get<{ d: string }>('SELECT data_json AS d FROM annotation WHERE id = ?', [id])!.d) as InkData;
    expect(stored).toEqual(v1);

    const oldPull = await pull();
    expect(oldPull.changes.find((c) => c.entity_id === id)!.entity!.data).toEqual(v1);
    const newPull = await pull(V2);
    const got = newPull.changes.find((c) => c.entity_id === id)!.entity!.data as unknown as InkDataV2;
    expect(got.v).toBe(2);
    expect(toInkV1(got)).toEqual(v1);
    // the REST read paths negotiate the same way
    const key = `source_page:${f.pageIds[0]}`;
    const oldGet = (await t.app.inject({ method: 'GET', url: `/api/annotations/by-targets?keys=${key}`, headers: h })).json();
    expect(oldGet.annotations[0].data).toEqual(v1);
    const newGet = (await t.app.inject({ method: 'GET', url: `/api/annotations/by-targets?keys=${key}`, headers: { ...h, ...V2 } })).json();
    expect(newGet.annotations[0].data.v).toBe(2);
    const src = (await t.app.inject({ method: 'GET', url: `/api/annotations/source/${f.sourceId}`, headers: h })).json();
    expect(src.annotations[0].data).toEqual(v1);
  });

  it('an old client (v1, no header) behaves exactly as before; a duplicate answer to a v2 client is v2', async () => {
    const id = newId();
    const v1 = realisticInk(3);
    const o = op({ entity_type: 'annotation', entity_id: id, op: 'append', payload: { ...inkPayload(f), data: v1 } });
    const [r] = await push([o]);
    expect((r!.entity as AnnotationDTO).data).toEqual(v1);
    const [again] = await push([o], V2);
    expect(again!.result).toBe('duplicate');
    expect(((again!.entity as AnnotationDTO).data as unknown as InkDataV2).v).toBe(2);
  });

  it('a stroke whose points are off the engine grid stays v1 even for a v2 client (nothing is rounded silently)', async () => {
    const id = newId();
    const fine: InkData = { ...inkData(), points: [[0.1234567, 0.2, 0], [0.2, 0.3, 10]] };
    await push([op({ entity_type: 'annotation', entity_id: id, op: 'append', payload: { ...inkPayload(f), data: fine } })]);
    const got = (await pull(V2)).changes.find((c) => c.entity_id === id)!.entity!.data;
    expect(got).toEqual(fine);
  });

  it('corrupt or out-of-range packed points are refused with a reason; nothing is stored', async () => {
    const good = packInkData(realisticInk(2))!;
    const bad = await push([op({ entity_type: 'annotation', entity_id: newId(), op: 'append', payload: { ...inkPayload(f), data: { ...good, points_packed: good.points_packed.slice(0, 40) } } })], V2);
    expect(bad[0]).toMatchObject({ result: 'rejected' });
    expect(bad[0]!.detail).toMatch(/تالفة|غير صالحة/);
    const far = encodeInkPoints([roundInkPoint([0.1, 0.1, 0]), [1.9, 1.99999, 5] as InkPoint])!;
    expect(far).not.toBeNull();
    const outside = encodeInkPoints([[0.1, 0.1, 0], [5, 0.1, 5]])!; // x = 5 is beyond the page range
    const r2 = await push([op({ entity_type: 'annotation', entity_id: newId(), op: 'append', payload: { ...inkPayload(f), data: { ...good, points_packed: outside } } })], V2);
    expect(r2[0]!.result).toBe('rejected');
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM annotation')!.n).toBe(0);
  });

  it('wire size of the realistic 5,000-stroke page: v1 JSON vs v2 (base64 inside JSON) — numbers for docs/PERFORMANCE.md', async () => {
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
    const size = async (headers: Record<string, string>) => {
      let since = 0;
      let bytes = 0;
      let ms = 0;
      for (;;) {
        const t0 = performance.now();
        const res = await t.app.inject({ method: 'GET', url: `/api/sync/pull?since=${since}&limit=1000`, headers: { ...h, ...headers } });
        ms += performance.now() - t0;
        bytes += res.body.length;
        const j = res.json();
        since = j.next_since;
        if (!j.has_more) break;
      }
      return { bytes, ms };
    };
    const a = await size({});
    const b = await size(V2);
    console.log(`[perf] 5000-stroke page pull — v1 JSON: ${(a.bytes / 1e6).toFixed(2)} MB in ${a.ms.toFixed(0)} ms; v2 (base64 in JSON): ${(b.bytes / 1e6).toFixed(2)} MB in ${b.ms.toFixed(0)} ms`);
    expect(b.bytes).toBeLessThan(a.bytes * 0.5);
  });
});
