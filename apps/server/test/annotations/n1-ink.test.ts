// Parity N1 wave 1 (docs/research/NOTE_APP_FEATURE_PARITY.md «B.4 Track N1»): the server side of the writing engine.
//  * G03 / G01 — a stroke carries its colour meaning and pen feel in `style` (validated: no bidi controls, ranges), and
//    they come back exactly as written (push answer, pull, packed ink v2);
//  * G19 — text boxes and pictures carry a rotation in page space;
//  * G03 / G14 / G02 / G66 — the `ink` settings object: a PATCH that names one part keeps the others (nested merge),
//    invalid slots are refused with a reason, defaults reproduce the engine before N1;
//  * G15 — «امسح الصفحة» / «احذف كل … في الدفتر» are tombstones: the rows stay, a replayed delete changes nothing, and
//    restoring them (the undo) brings back exactly the same writing.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_INK_SETTINGS, DEFAULT_OWNER_SETTINGS, newId, packInkData, roundInkPoint, type AnnotationDTO, type SyncOp, type SyncOpResult } from '@medlevo/shared';
import { annotationPayloadSchema } from '../../src/modules/annotations/schemas';
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
const stored = (id: string) => t.ctx.db.get<{ data_json: string; deleted_at: number | null; rev: number }>('SELECT data_json, deleted_at, rev FROM annotation WHERE id = ?', [id]);
const settings = async () => (await t.app.inject({ method: 'GET', url: '/api/settings', headers: h })).json().settings;
const patch = (payload: unknown) => t.app.inject({ method: 'PATCH', url: '/api/settings', headers: h, payload: payload as Record<string, unknown> });

const parse = (data: unknown, kind: AnnotationDTO['kind'] = 'ink') => annotationPayloadSchema.safeParse({ kind, anchor: pageAnchor(f), data });

describe('stroke style: colour meaning (G03) and pen feel (G01)', () => {
  it('accepts a meaning and pen-feel fields and keeps them byte for byte (push answer, stored row, pull, ink v2)', async () => {
    const data = inkData();
    data.points = data.points.map(roundInkPoint); // the engine's rounding grid (packing needs it)
    data.style = { ...data.style, color: 'ink-red', meaning: 'موانع استعمال', smoothing: 5, pressure_floor: 0.2, taper: 'sharp', constant: true };
    const id = newId();
    const [r] = await push([op({ entity_type: 'annotation', entity_id: id, op: 'append', payload: { ...inkPayload(f), data } })]);
    expect(r!.result).toBe('applied');
    expect(JSON.parse(stored(id)!.data_json).style).toEqual(data.style);
    const pulled = (await t.app.inject({ method: 'GET', url: '/api/sync/pull?since=0&limit=100', headers: h })).json().changes as Array<{ entity_id: string; entity: AnnotationDTO }>;
    expect((pulled.find((c) => c.entity_id === id)!.entity.data as typeof data).style).toEqual(data.style);
    // the packed format carries the same style
    const id2 = newId();
    const [r2] = await push([op({ entity_type: 'annotation', entity_id: id2, op: 'append', payload: { ...inkPayload(f), data: packInkData(data)! } })], { 'accept-ink': '2' });
    expect(r2!.result, JSON.stringify(r2)).toBe('applied');
    expect(JSON.parse(stored(id2)!.data_json).style.meaning).toBe('موانع استعمال');
  });

  it('a stroke without the new fields is unchanged (older devices keep working)', () => {
    expect(parse(inkData()).success).toBe(true);
  });

  it('refuses a meaning with bidi controls, a line break, padding or over 60 characters, and out-of-range feel values', () => {
    const bad = (style: Record<string, unknown>) => {
      const d = inkData();
      return parse({ ...d, style: { ...d.style, ...style } }).success;
    };
    expect(bad({ meaning: 'دواء‮معكوس' })).toBe(false);
    expect(bad({ meaning: 'سطر\nآخر' })).toBe(false);
    expect(bad({ meaning: ' آلية ' })).toBe(false);
    expect(bad({ meaning: '' })).toBe(false);
    expect(bad({ meaning: 'م'.repeat(61) })).toBe(false);
    expect(bad({ meaning: 'م'.repeat(60) })).toBe(true);
    expect(bad({ smoothing: 7 })).toBe(false);
    expect(bad({ smoothing: 2.5 })).toBe(false);
    expect(bad({ pressure_floor: 1.2 })).toBe(false);
    expect(bad({ taper: 'brush' })).toBe(false);
    expect(bad({ constant: 'yes' })).toBe(false);
    // the same rules hold for the style of a shape
    const shape = { v: 1, shape: 'rect', from: [0.1, 0.1], to: [0.3, 0.2], style: { tool: 'pen', color: 'ink-blue', width: 0.002, meaning: 'آلية' } };
    expect(parse(shape, 'shape').success).toBe(true);
    expect(parse({ ...shape, style: { ...shape.style, meaning: 'x⁦' } }, 'shape').success).toBe(false);
  });
});

describe('rotation of text boxes and pictures (G19)', () => {
  it('stores a rotation in page space and refuses a non-number or more than one turn', async () => {
    const text = { v: 1, box: { x: 0.2, y: 0.2, w: 0.3, h: 0.05 }, text: rt('عنوان مائل'), color: 'ink-black', font_scale: 0.022, rotation: 0.5236 };
    expect(parse(text, 'text').success).toBe(true);
    expect(parse({ ...text, rotation: 7 }, 'text').success).toBe(false);
    expect(parse({ ...text, rotation: '30deg' }, 'text').success).toBe(false);
    const img = { v: 1, image_key: newId(), box: { x: 0.1, y: 0.1, w: 0.4, h: 0.3 }, mime: 'image/png', natural_w: 400, natural_h: 300, bytes: 2000, rotation: -1.5708 };
    expect(parse(img, 'image').success).toBe(true);
    expect(parse({ ...img, rotation: Number.NaN }, 'image').success).toBe(false);
    const id = newId();
    const [r] = await push([op({ entity_type: 'annotation', entity_id: id, op: 'append', payload: { kind: 'text', tool: 'text', anchor: pageAnchor(f), data: text, layer: 'text', z: 1, locked: false } })]);
    expect(r!.result).toBe('applied');
    expect(JSON.parse(stored(id)!.data_json).rotation).toBe(0.5236);
  });
});

describe('the `ink` settings object', () => {
  it('defaults reproduce the engine before N1 (built-in palettes, gestures on, medium palm, classic feel, top toolbar)', async () => {
    const s = await settings();
    expect(s.ink).toEqual(DEFAULT_INK_SETTINGS);
    expect(DEFAULT_OWNER_SETTINGS.ink).toEqual(DEFAULT_INK_SETTINGS);
    expect(s.ink.palettes).toEqual({});
    expect(s.ink.gestures).toEqual({ scribble_erase: true, circle_lasso: true, finger_undo: true });
    expect(s.ink.palm).toEqual({ sensitivity: 'medium', hand: 'right' });
    expect(s.ink.feel.pen).toEqual({ smoothing: 2, pressure_floor: 0, taper: 'none', constant: false });
    expect(s.ink.toolbar).toMatchObject({ order: [], hidden: [], dock: 'top', recent: true, insert_returns_to_lasso: false, modes: {} });
  });

  it('a PATCH naming one part keeps the others (two devices changing different parts never undo each other)', async () => {
    const slots = [{ color: 'ink-red', meaning: 'موانع استعمال' }, { color: 'ink-blue', meaning: 'آلية' }, { color: '#1e7a46', meaning: 'دواء' }];
    const a = await patch({ ink: { palettes: { pen: slots } } });
    expect(a.statusCode, a.body).toBe(200);
    const b = await patch({ ink: { gestures: { scribble_erase: false, circle_lasso: true, finger_undo: true } } });
    expect(b.statusCode, b.body).toBe(200);
    const c = await patch({ ink: { toolbar: { dock: 'start', hidden: ['laser'], modes: { exam: { hidden: ['pen', 'highlighter'] } } } } });
    expect(c.statusCode, c.body).toBe(200);
    const s = await settings();
    expect(s.ink.palettes.pen).toEqual(slots);
    expect(s.ink.gestures.scribble_erase).toBe(false);
    expect(s.ink.toolbar).toMatchObject({ dock: 'start', hidden: ['laser'], modes: { exam: { hidden: ['pen', 'highlighter'] } }, recent: true });
    expect(s.ink.palm).toEqual(DEFAULT_INK_SETTINGS.palm);
    // the other settings are untouched
    expect(s.theme).toBe(DEFAULT_OWNER_SETTINGS.theme);
  });

  it('refuses invalid slots with a reason and keeps the stored value', async () => {
    await patch({ ink: { palettes: { highlighter: [{ color: 'hl-yellow', meaning: 'تعريف' }] } } });
    const tooMany = await patch({ ink: { palettes: { pen: Array.from({ length: 13 }, () => ({ color: 'ink-black' })) } } });
    expect(tooMany.statusCode).toBe(400);
    const script = await patch({ ink: { palettes: { pen: [{ color: 'javascript:alert(1)' }] } } });
    expect(script.statusCode).toBe(400);
    const bidi = await patch({ ink: { palettes: { pen: [{ color: 'ink-red', meaning: 'abc‏' }] } } });
    expect(bidi.statusCode).toBe(400);
    const empty = await patch({ ink: { palettes: { pen: [] } } });
    expect(empty.statusCode).toBe(400);
    const badTool = await patch({ ink: { toolbar: { order: ['<img>'] } } });
    expect(badTool.statusCode).toBe(400);
    const s = await settings();
    expect(s.ink.palettes).toEqual({ highlighter: [{ color: 'hl-yellow', meaning: 'تعريف' }] });
  });
});

describe('clear page / delete by type are tombstones (G15)', () => {
  it('deleting several strokes keeps the rows; a replayed delete changes nothing; restoring brings the same writing back', async () => {
    const ids = [newId(), newId(), newId()];
    const appended = await push(ids.map((id, i) => op({ entity_type: 'annotation', entity_id: id, op: 'append', payload: { ...inkPayload(f, { x: 0.1 + i * 0.2 }) } })));
    expect(appended.every((r) => r.result === 'applied')).toBe(true);
    const before = ids.map((id) => stored(id)!.data_json);
    const deletes = ids.map((id) => op({ entity_type: 'annotation', entity_id: id, op: 'delete', base_rev: 1, payload: { id } }));
    const del = await push(deletes);
    expect(del.map((r) => r.result)).toEqual(['applied', 'applied', 'applied']);
    for (const id of ids) {
      const row = stored(id)!;
      expect(row.deleted_at).not.toBeNull(); // a tombstone: the row and its writing stay
      expect(row.data_json).toBe(before[ids.indexOf(id)]);
    }
    const revs = ids.map((id) => stored(id)!.rev);
    // the same ops again (a device that did not hear the answer): nothing changes
    const again = await push(deletes);
    expect(again.every((r) => r.result === 'applied' || r.result === 'duplicate')).toBe(true);
    expect(ids.map((id) => stored(id)!.rev)).toEqual(revs);
    // restoring (the undo of the clear) = an upsert of the same item: the same writing is back, alive (the server says
    // «merged»: the item was a tombstone and the owner's newer state brought it back)
    const restore = await push(ids.map((id, i) => op({ entity_type: 'annotation', entity_id: id, op: 'upsert', base_rev: revs[i]!, payload: { id, ...inkPayload(f, { x: 0.1 + i * 0.2 }) } })));
    expect(restore.every((r) => r.result === 'applied' || r.result === 'merged'), JSON.stringify(restore[0])).toBe(true);
    expect(restore.every((r) => (r.entity as AnnotationDTO | undefined)?.deleted_at === null)).toBe(true);
    for (const [i, id] of ids.entries()) {
      const row = stored(id)!;
      expect(row.deleted_at).toBeNull();
      expect(row.data_json).toBe(before[i]);
    }
  });
});
