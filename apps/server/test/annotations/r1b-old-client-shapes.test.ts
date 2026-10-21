// Release R1-b final verification — review finding R10 of parity N1 wave 2 (docs/modules/ink.md).
//
// An R1-a app (the owner's own un-updated tab or PWA: the client gate lets user #1's old client keep writing) does not
// know the wave-2 shape kinds. It draws them as an ellipse in their frame and, when the owner MOVES one there, its box
// branch keeps only that frame: a curved or double arrow comes back with its ends normalised to the frame's top-left →
// bottom-right corners (the direction, and with it a pathway head ⊣ / →, can flip; the control point stays behind) and
// a polygon's corners do not move at all. The server therefore refuses, from a client without a supported
// `x-medlevo-client` version, an edit that changes the geometry of a curved arrow, a double arrow or a polygon: the
// answer is `rejected` WITH the server's copy, so the old app shows its conflict and puts the shape back as stored
// (R1-a: `rejected` + entity → status `conflict`, the entity is applied). Everything else an old app does — deleting
// such a shape, restoring it unchanged, recolouring it, moving any shape it knows — is applied as before, and a current
// client edits these shapes freely.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId, type AnnotationDTO, type ShapeData, type SyncOp, type SyncOpResult } from '@medlevo/shared';
import { type AuthHeaders, createTestApp, type TestApp } from '../helpers/app';
import { createSourceFixture, op, pageAnchor, type SourceFixture } from './helpers';

let t: TestApp;
let current: AuthHeaders;
let old: Record<string, string>;
let f: SourceFixture;

beforeEach(async () => {
  t = await createTestApp();
  current = await t.login();
  // the R1-a web client: same session cookie and CSRF header, no `x-medlevo-client`
  old = Object.fromEntries(Object.entries(current).filter(([k]) => k !== 'x-medlevo-client'));
  f = createSourceFixture(t);
});
afterEach(async () => {
  await t.close();
});

async function push(headers: Record<string, string>, ops: SyncOp[]): Promise<SyncOpResult[]> {
  const res = await t.app.inject({ method: 'POST', url: '/api/sync/push', headers, payload: { ops } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().results as SyncOpResult[];
}
const row = (id: string) => t.ctx.db.get<{ data_json: string; rev: number; deleted_at: number | null }>('SELECT data_json, rev, deleted_at FROM annotation WHERE id = ?', [id])!;
const style = { tool: 'pen' as const, color: 'ink-black', width: 0.003 };
const payload = (data: ShapeData) => ({ kind: 'shape' as const, tool: data.shape, anchor: pageAnchor(f), data, layer: 'ink' as const, z: 1, locked: false });

/** The R1-a client's `transformItem` shape branch (git show d0c8ab4:apps/web/src/features/workspace/ink/model.ts), a pure move. */
function r1aMove(d: ShapeData, dx: number, dy = 0, ar = 800 / 600): ShapeData {
  if (d.shape === 'line' || d.shape === 'arrow') return { ...d, from: [d.from[0] + dx, d.from[1] + dy], to: [d.to[0] + dx, d.to[1] + dy] };
  const cx = (d.from[0] + d.to[0]) / 2 + dx;
  const cy = (d.from[1] + d.to[1]) / 2 + dy;
  const hx = Math.abs(d.to[0] - d.from[0]) / 2;
  const hy = (Math.abs(d.to[1] - d.from[1]) * ar) / 2;
  return { ...d, from: [cx - hx, (cy * ar - hy) / ar], to: [cx + hx, (cy * ar + hy) / ar] };
}

const curved = (): ShapeData => ({ v: 1, shape: 'curved_arrow', from: [0.6, 0.2], to: [0.2, 0.3], control: [0.4, 0.1], head: 'inhibition', style });
const double = (): ShapeData => ({ v: 1, shape: 'double_arrow', from: [0.7, 0.4], to: [0.3, 0.45], style });
const polygon = (): ShapeData => ({ v: 1, shape: 'polygon', from: [0.1, 0.5], to: [0.3, 0.7], points: [[0.1, 0.5], [0.3, 0.55], [0.2, 0.7]], style });

async function draw(data: ShapeData): Promise<{ id: string; rev: number }> {
  const id = newId();
  const [r] = await push(current, [op({ entity_type: 'annotation', entity_id: id, op: 'upsert', payload: payload(data) })]);
  expect(r!.result, JSON.stringify(r)).toBe('applied');
  return { id, rev: row(id).rev };
}

describe('R1-b (review R10): an R1-a app never damages a wave-2 shape it does not know', () => {
  for (const [name, make] of [
    ['curved arrow drawn right to left with an inhibition head', curved],
    ['double arrow', double],
    ['polygon', polygon],
  ] as const) {
    it(`an R1-a move of a ${name} is refused WITH the server copy; the stored row is unchanged`, async () => {
      const { id, rev } = await draw(make());
      const before = row(id);
      const moved = r1aMove(make(), 0.05);
      const [r] = await push(old, [op({ entity_type: 'annotation', entity_id: id, op: 'upsert', base_rev: rev, payload: payload(moved) })]);
      expect(r!.result, JSON.stringify(r)).toBe('rejected');
      expect(r!.retryable).toBeFalsy();
      // with the server's copy: the R1-a app marks the op «conflict» and puts the shape back as stored
      const entity = r!.entity as AnnotationDTO;
      expect(entity.id).toBe(id);
      expect(entity.data).toEqual(make());
      expect(r!.detail).toMatch(/حدّث التطبيق/);
      expect(row(id)).toEqual(before);
      // the same op again (a retry of the lost answer) gets the same verdict and copy
      const [again] = await push(old, [{ ...op({ entity_type: 'annotation', entity_id: id }), op_id: r!.op_id, op: 'upsert', base_rev: rev, payload: payload(moved) }]);
      expect(again!.result).toBe('duplicate');
      expect(again!.original_result).toBe('rejected');
      expect((again!.entity as AnnotationDTO).data).toEqual(make());
    });
  }

  it('a stale R1-a move (base_rev behind) does not become a damaged conflict copy either', async () => {
    const { id, rev } = await draw(curved());
    const edited = { ...curved(), head: 'activation' as const };
    const [r1] = await push(current, [op({ entity_type: 'annotation', entity_id: id, op: 'upsert', base_rev: rev, payload: payload(edited) })]);
    expect(r1!.result).toBe('applied');
    const [r] = await push(old, [op({ entity_type: 'annotation', entity_id: id, op: 'upsert', base_rev: rev, payload: payload(r1aMove(curved(), 0.05)) })]);
    expect(r!.result).toBe('rejected');
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM annotation WHERE conflict_of_id = ?', [id])!.n).toBe(0);
    expect(JSON.parse(row(id).data_json)).toEqual(edited);
  });

  it('what an R1-a app does safely is applied as before: recolour, delete, restore unchanged, moving a shape it knows', async () => {
    const a = await draw(curved());
    const recoloured = { ...curved(), style: { ...style, color: 'ink-red' } };
    const [r1] = await push(old, [op({ entity_type: 'annotation', entity_id: a.id, op: 'upsert', base_rev: a.rev, payload: payload(recoloured) })]);
    expect(r1!.result, JSON.stringify(r1)).toBe('applied');
    expect(JSON.parse(row(a.id).data_json)).toEqual(recoloured);

    const b = await draw(polygon());
    const [r2] = await push(old, [op({ entity_type: 'annotation', entity_id: b.id, op: 'delete', base_rev: b.rev })]);
    expect(r2!.result).toBe('applied');
    expect(row(b.id).deleted_at).not.toBeNull();
    // the R1-a undo of that erase: an upsert of the shape exactly as it was
    const [r3] = await push(old, [op({ entity_type: 'annotation', entity_id: b.id, op: 'upsert', base_rev: row(b.id).rev, payload: payload(polygon()) })]);
    expect(['applied', 'merged']).toContain(r3!.result);
    expect(row(b.id).deleted_at).toBeNull();
    expect(JSON.parse(row(b.id).data_json)).toEqual(polygon());

    for (const known of [
      { v: 1, shape: 'arrow', from: [0.6, 0.2], to: [0.2, 0.3], style } as ShapeData,
      { v: 1, shape: 'rect', from: [0.2, 0.2], to: [0.4, 0.3], style } as ShapeData,
      { v: 1, shape: 'triangle', from: [0.2, 0.2], to: [0.4, 0.3], style } as ShapeData,
    ]) {
      const k = await draw(known);
      const [r] = await push(old, [op({ entity_type: 'annotation', entity_id: k.id, op: 'upsert', base_rev: k.rev, payload: payload(r1aMove(known, 0.05)) })]);
      expect(r!.result, `${known.shape}: ${JSON.stringify(r)}`).toBe('applied');
    }
  });

  it('a current client moves and reshapes these shapes freely', async () => {
    const { id, rev } = await draw(curved());
    const moved: ShapeData = { ...curved(), from: [0.65, 0.2], to: [0.25, 0.3], control: [0.45, 0.1] };
    const [r] = await push(current, [op({ entity_type: 'annotation', entity_id: id, op: 'upsert', base_rev: rev, payload: payload(moved) })]);
    expect(r!.result).toBe('applied');
    expect(JSON.parse(row(id).data_json)).toEqual(moved);
  });
});
