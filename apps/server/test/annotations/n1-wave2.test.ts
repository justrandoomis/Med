// Parity N1 wave 2 (docs/research/NOTE_APP_FEATURE_PARITY.md «B.4 Track N1», waves 2–4): the server side of the new ink.
//  * G04 / G06 — a stroke carries its dash pattern and the pencil's graphite texture in `style` (still `tool: 'pen'`
//    and points only), validated and returned byte for byte (push answer, stored row, pull, packed ink v2);
//  * G20 — shapes: fill, rounded corners, a RichText label, new kinds (triangle, polygon, curved / double arrow) and the
//    pathway heads (activation, inhibition, conversion), each validated with an Arabic reason;
//  * G21 — connectors: attachments to other shapes' edge points, a route, a medical relation and a Course Brain concept
//    on nodes; an undo (upsert of the earlier state) keeps the attachments;
//  * settings — the new `ink` parts (pencil slots and feel, dash per slot, snapping, the zoom window) have defaults and
//    are merged part by part.
// No migration: every new field lives in the annotation's JSON and the owner's settings (BUILD_PLAN §1.3: R1-b ships no
// base migration).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_INK_SETTINGS, newId, packInkData, roundInkPoint, shapeOutlineIso, shapeParts, shapeSidePoint, type AnnotationDTO, type ShapeData, type SyncOp, type SyncOpResult } from '@medlevo/shared';
import { annotationPayloadSchema } from '../../src/modules/annotations/schemas';
import { shapeOutline as exportOutline } from '../../src/modules/data/pdf-export';
import { type AuthHeaders, createTestApp, type TestApp } from '../helpers/app';
import { createSourceFixture, inkData, inkPayload, op, pageAnchor, rt, type SourceFixture } from './helpers';

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

async function push(ops: SyncOp[], extra: Record<string, string> = {}): Promise<SyncOpResult[]> {
  const res = await t.app.inject({ method: 'POST', url: '/api/sync/push', headers: { ...h, ...extra }, payload: { ops } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().results as SyncOpResult[];
}
const stored = (id: string) => t.ctx.db.get<{ data_json: string; rev: number }>('SELECT data_json, rev FROM annotation WHERE id = ?', [id]);
const parse = (data: unknown, kind: AnnotationDTO['kind'] = 'ink') => annotationPayloadSchema.safeParse({ kind, anchor: pageAnchor(f), data });
const shapePayload = (data: ShapeData) => ({ kind: 'shape' as const, tool: data.shape, anchor: pageAnchor(f), data, layer: 'ink' as const, z: 1, locked: false });
const style = { tool: 'pen' as const, color: 'ink-blue', width: 0.0025 };
const rect = (extra: Partial<ShapeData> = {}): ShapeData => ({ v: 1, shape: 'rect', from: [0.2, 0.2], to: [0.4, 0.3], style, ...extra });

describe('stroke style: dashes (G04) and the pencil (G06)', () => {
  it('keeps a dash and the graphite texture byte for byte (push, stored row, pull, ink v2) — the pencil stays a pen stroke', async () => {
    const data = inkData();
    data.points = data.points.map(roundInkPoint);
    data.style = { ...data.style, dash: 'dot', texture: 'graphite', meaning: 'بنى عميقة' };
    expect(data.style.tool).toBe('pen');
    const id = newId();
    const [r] = await push([op({ entity_type: 'annotation', entity_id: id, op: 'append', payload: { ...inkPayload(f), data } })]);
    expect(r!.result).toBe('applied');
    expect(JSON.parse(stored(id)!.data_json).style).toEqual(data.style);
    const pulled = (await t.app.inject({ method: 'GET', url: '/api/sync/pull?since=0&limit=100', headers: h })).json().changes as Array<{ entity_id: string; entity: AnnotationDTO }>;
    expect((pulled.find((c) => c.entity_id === id)!.entity.data as typeof data).style).toEqual(data.style);
    const id2 = newId();
    const [r2] = await push([op({ entity_type: 'annotation', entity_id: id2, op: 'append', payload: { ...inkPayload(f), data: packInkData({ ...data, style: { ...data.style, dash: 'dash' } })! } })], { 'accept-ink': '2' });
    expect(r2!.result, JSON.stringify(r2)).toBe('applied');
    expect(JSON.parse(stored(id2)!.data_json).style).toMatchObject({ dash: 'dash', texture: 'graphite' });
  });

  it('refuses an unknown dash or texture, and a pencil tool name (the pencil is stored as a pen)', () => {
    const bad = (s: Record<string, unknown>) => {
      const d = inkData();
      return parse({ ...d, style: { ...d.style, ...s } }).success;
    };
    expect(bad({ dash: 'dash' })).toBe(true);
    expect(bad({ dash: 'dot' })).toBe(true);
    expect(bad({ dash: 'dashdot' })).toBe(false);
    expect(bad({ dash: 'solid' })).toBe(false);
    expect(bad({ texture: 'chalk' })).toBe(false);
    expect(bad({ tool: 'pencil' })).toBe(false);
  });
});

describe('shapes (G20): fill, corners, label, new kinds and pathway heads', () => {
  it('accepts every new kind with its fields; refuses bad values with an Arabic reason', () => {
    expect(parse(rect({ fill: 'hl-yellow', corner: 0.02, label: rt('Na⁺/K⁺ ATPase مضخة'), label_scale: 0.02 }), 'shape').success).toBe(true);
    expect(parse(rect({ shape: 'triangle' }), 'shape').success).toBe(true);
    expect(parse({ ...rect({ shape: 'polygon', points: [[0.2, 0.2], [0.3, 0.25], [0.25, 0.35]] }) }, 'shape').success).toBe(true);
    expect(parse({ v: 1, shape: 'curved_arrow', from: [0.1, 0.1], to: [0.4, 0.2], control: [0.25, 0.05], style, head: 'activation' }, 'shape').success).toBe(true);
    expect(parse({ v: 1, shape: 'double_arrow', from: [0.1, 0.1], to: [0.4, 0.2], style }, 'shape').success).toBe(true);
    for (const head of ['activation', 'inhibition', 'conversion']) expect(parse({ v: 1, shape: 'arrow', from: [0.1, 0.1], to: [0.4, 0.2], style, head }, 'shape').success).toBe(true);
    const reasons = (d: unknown) => {
      const r = parse(d, 'shape');
      return r.success ? [] : r.error.issues.map((i) => i.message);
    };
    expect(reasons(rect({ shape: 'star' as ShapeData['shape'] }))).toContain('نوع الشكل غير معروف.');
    expect(reasons(rect({ fill: 'url(javascript:alert(1))' }))).toContain('لون التعبئة غير معروف.');
    expect(reasons(rect({ corner: 0.5 }))).toContain('نصف قطر الزاوية خارج المدى.');
    expect(reasons(rect({ head: 'stimulates' as ShapeData['head'] }))).toContain('رأس السهم غير معروف.');
    expect(reasons(rect({ shape: 'polygon' }))).toContain('المضلّع يحتاج زواياه.');
    expect(reasons(rect({ shape: 'polygon', points: [[0.1, 0.1], [0.2, 0.2]] }))).toContain('المضلّع يحتاج ثلاث زوايا على الأقل.');
    expect(reasons(rect({ label: rt('م'.repeat(501)) }))).toContain('النص داخل الشكل أطول من 500 حرف.');
    expect(reasons(rect({ label: rt('ATP‮معكوس') }))).toContain('النص داخل الشكل يحتوي رموز اتجاه مخفية.');
    expect(reasons(rect({ points: [[5, 0.1], [0.2, 0.2], [0.3, 0.3]], shape: 'polygon' })).length).toBeGreaterThan(0);
  });

  it('round-trips a labelled, filled, rounded shape exactly as written', async () => {
    const data = rect({ fill: 'hl-green', corner: 0.015, label: rt('الكبد Liver') });
    const id = newId();
    const [r] = await push([op({ entity_type: 'annotation', entity_id: id, op: 'append', payload: shapePayload(data) })]);
    expect(r!.result, JSON.stringify(r)).toBe('applied');
    expect(JSON.parse(stored(id)!.data_json)).toEqual(JSON.parse(JSON.stringify(data)));
  });

  it('one geometry for the web and the PDF export: old shapes are unchanged, new kinds are drawn as themselves', () => {
    const ar = 842 / 595;
    // the classic four keep exactly the outline they had (the export's own copy of the geometry is the reference)
    for (const d of [rect(), rect({ shape: 'ellipse', rotation: 0.3 }), { v: 1, shape: 'line', from: [0.1, 0.1], to: [0.5, 0.6], style }, { v: 1, shape: 'arrow', from: [0.1, 0.1], to: [0.5, 0.6], style }] as ShapeData[]) {
      expect(shapeOutlineIso(d, ar)).toEqual(exportOutline(d, ar));
    }
    // a triangle is three sides (not an ellipse of 65 points), an inhibition head is a bar across the tip
    const tri = shapeParts(rect({ shape: 'triangle' }), ar);
    expect(tri).toHaveLength(1);
    expect(tri[0]!.pts).toHaveLength(4);
    // …and the PDF export draws the same three sides
    expect(exportOutline(rect({ shape: 'triangle' }), ar)).toEqual(tri.map((p) => p.pts));
    const inh = shapeParts({ v: 1, shape: 'arrow', from: [0.1, 0.5], to: [0.5, 0.5], style, head: 'inhibition' }, ar);
    const bar = inh.find((p) => p.role === 'head')!;
    expect(bar.pts).toHaveLength(2);
    expect(bar.pts[0]![0]).toBeCloseTo(0.5, 6);
    expect(bar.pts[1]![0]).toBeCloseTo(0.5, 6);
    const conv = shapeParts({ v: 1, shape: 'arrow', from: [0.1, 0.5], to: [0.5, 0.5], style, head: 'conversion' }, ar);
    expect(conv[0]!.dashed).toBe(true);
    const act = shapeParts({ v: 1, shape: 'arrow', from: [0.1, 0.5], to: [0.5, 0.5], style, head: 'activation' }, ar);
    expect(act.find((p) => p.role === 'head')!.solid).toBe(true);
    // a double arrow has a head at each end
    expect(shapeParts({ v: 1, shape: 'double_arrow', from: [0.1, 0.5], to: [0.5, 0.5], style }, ar).filter((p) => p.role === 'head')).toHaveLength(2);
    // edge points: the middle of each side of the box
    expect(shapeSidePoint(rect(), 'e', ar)).toEqual([0.4, expect.closeTo(0.25, 9)]);
    expect(shapeSidePoint(rect(), 'n', ar)![1]).toBeCloseTo(0.2, 9);
  });
});

describe('connectors (G21): attachments, route, relation, concept', () => {
  it('stores a connector between two shapes and an undo (the earlier state, upserted) keeps its attachments', async () => {
    const a = newId();
    const b = newId();
    const c = newId();
    const nodeA = rect({ concept_id: 'cpt_insulin', concept_name: 'الإنسولين Insulin', label: rt('Insulin') });
    const nodeB: ShapeData = { ...rect(), from: [0.6, 0.2], to: [0.8, 0.3], label: rt('GLUT4') };
    const conn: ShapeData = { v: 1, shape: 'arrow', from: [0.4, 0.25], to: [0.6, 0.25], style, route: 'elbow', control: [0.5, 0.25], attach: { from: { id: a, side: 'e' }, to: { id: b, side: 'w' } }, relation: 'causes', head: 'activation' };
    const res = await push([
      op({ entity_type: 'annotation', entity_id: a, op: 'append', payload: shapePayload(nodeA) }),
      op({ entity_type: 'annotation', entity_id: b, op: 'append', payload: shapePayload(nodeB) }),
      op({ entity_type: 'annotation', entity_id: c, op: 'append', payload: shapePayload(conn) }),
    ]);
    expect(res.map((r) => r.result)).toEqual(['applied', 'applied', 'applied']);
    expect(JSON.parse(stored(c)!.data_json)).toMatchObject({ attach: { from: { id: a, side: 'e' }, to: { id: b, side: 'w' } }, relation: 'causes', route: 'elbow' });
    expect(JSON.parse(stored(a)!.data_json)).toMatchObject({ concept_id: 'cpt_insulin', concept_name: 'الإنسولين Insulin' });
    // a move of B moved the connector's end; the undo puts the earlier state back — attachments included
    const moved: ShapeData = { ...conn, to: [0.62, 0.4] };
    const [m] = await push([op({ entity_type: 'annotation', entity_id: c, op: 'upsert', base_rev: stored(c)!.rev, payload: shapePayload(moved) })]);
    expect(m!.result, JSON.stringify(m)).toBe('applied');
    const [u] = await push([op({ entity_type: 'annotation', entity_id: c, op: 'upsert', base_rev: stored(c)!.rev, payload: shapePayload(conn) })]);
    expect(u!.result).toBe('applied');
    expect(JSON.parse(stored(c)!.data_json).attach).toEqual(conn.attach);
  });

  it('refuses an unknown relation, side or route and a concept name with bidi controls', () => {
    const conn = { v: 1, shape: 'line', from: [0.1, 0.1], to: [0.3, 0.3], style };
    expect(parse({ ...conn, relation: 'inhibits', route: 'curve', control: [0.2, 0.1] }, 'shape').success).toBe(true);
    expect(parse({ ...conn, relation: 'cures' }, 'shape').success).toBe(false);
    expect(parse({ ...conn, route: 'zigzag' }, 'shape').success).toBe(false);
    expect(parse({ ...conn, attach: { from: { id: 'x', side: 'ne' } } }, 'shape').success).toBe(false);
    expect(parse({ ...conn, attach: { from: { id: 'a b', side: 'n' } } }, 'shape').success).toBe(false);
    expect(parse({ ...rect(), concept_id: 'c1', concept_name: 'اسم‮' }, 'shape').success).toBe(false);
  });
});

describe('the `ink` settings parts of wave 2', () => {
  const settings = async () => (await t.app.inject({ method: 'GET', url: '/api/settings', headers: h })).json().settings;
  const patch = (payload: unknown) => t.app.inject({ method: 'PATCH', url: '/api/settings', headers: h, payload: payload as Record<string, unknown> });

  it('defaults: snapping on, the zoom window right to left by default (auto), classic pencil feel', async () => {
    const s = await settings();
    expect(s.ink.snap).toEqual({ enabled: true, items: true, grid: true, regions: true });
    expect(s.ink.zoom).toMatchObject({ direction: 'auto', auto_advance: true, strip: 'medium' });
    expect(s.ink.feel.pencil).toEqual({ smoothing: 2, pressure_floor: 0, taper: 'none', constant: false });
    expect(s.ink).toEqual(DEFAULT_INK_SETTINGS);
  });

  it('a PATCH of the zoom window keeps the snapping choices and the pencil slots (part by part)', async () => {
    expect((await patch({ ink: { palettes: { pencil: [{ color: 'ink-black', dash: 'dot', meaning: 'بنى عميقة' }] } } })).statusCode).toBe(200);
    expect((await patch({ ink: { snap: { enabled: true, items: true, grid: false, regions: true } } })).statusCode).toBe(200);
    expect((await patch({ ink: { zoom: { direction: 'ltr', line_height: 0.03, margin_start: 0.1, margin_end: 0.05, line_gap: 0.01, auto_advance: false, strip: 'large' } } })).statusCode).toBe(200);
    const s = await settings();
    expect(s.ink.palettes.pencil).toEqual([{ color: 'ink-black', dash: 'dot', meaning: 'بنى عميقة' }]);
    expect(s.ink.snap.grid).toBe(false);
    expect(s.ink.zoom).toMatchObject({ direction: 'ltr', auto_advance: false, strip: 'large' });
    expect((await patch({ ink: { zoom: { line_height: 3 } } })).statusCode).toBe(400);
    expect((await patch({ ink: { palettes: { pen: [{ color: 'ink-red', dash: 'wave' }] } } })).statusCode).toBe(400);
  });
});
