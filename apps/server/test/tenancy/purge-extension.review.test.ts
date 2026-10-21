// P1-T1 step 0 review — a registered purge extension can never make the core purge skip one of its own steps or
// delete more than the owner confirmed.
//
// The extension API hands `fill()` and `apply()` the TEMP purge-set tables. Without a guard, a module could remove ids
// from a core set (in `fill`, so the preview and the purge both lose the core step, leaving e.g. a note anchored on a
// deleted source behind; or in `apply`, AFTER the confirm token was checked) or add ids in `apply` (deleting rows the
// owner never saw in the preview). The core now checks the sets around every extension step: `fill` may only add,
// `apply` may not change them. A violation aborts the whole purge before anything is deleted.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ImpactReport } from '@medlevo/shared';
import { type PurgeExtension, registerPurgeExtension } from '../../src/modules/sources/purge';
import { api, createNode, golden, type Harness, makeHarness, uploadOk } from '../sources/helpers';

let t: Harness;
beforeEach(async () => {
  t = await makeHarness();
});
afterEach(async () => {
  await t.close();
});

/** A source with one note anchored on it (in the core `note` purge set) and one unrelated note. */
async function seed() {
  const course = await createNode(t, { kind: 'course', title: 'Course' });
  const r = (await uploadOk(t, course.id, [{ name: 'scanned_page.png', data: golden('scanned_page.png') }])).results[0]!;
  const now = t.clock.now();
  t.ctx.db.run(`INSERT INTO note (id, body_json, anchor_json, created_at, updated_at) VALUES ('N-ON', '{"v":1,"paragraphs":[]}', ?, ?, ?)`, [
    JSON.stringify({ source_id: r.source_id }),
    now,
    now,
  ]);
  t.ctx.db.run(`INSERT INTO note (id, body_json, created_at, updated_at) VALUES ('N-OTHER', '{"v":1,"paragraphs":[]}', ?, ?)`, [now, now]);
  return { id: r.source_id! };
}

const impactOf = async (sourceId: string) => {
  await api(t).post(`/api/sources/${sourceId}/trash`);
  return api(t).get(`/api/sources/${sourceId}/impact?mode=purge`);
};
const purge = (sourceId: string, token: string) => api(t).del(`/api/sources/${sourceId}?confirm_token=${encodeURIComponent(token)}`);
const noteIds = () => t.ctx.db.all<{ id: string }>('SELECT id FROM note ORDER BY id').map((r) => r.id);
const ext = (over: Partial<PurgeExtension>): PurgeExtension => ({ name: 'test-bad', apply: () => undefined, ...over });

describe('purge extensions cannot skip or widen the core purge (review)', () => {
  it('control: with a well-behaved extension the anchored note is purged and the other note stays', async () => {
    registerPurgeExtension(t.ctx, ext({ name: 'test-good' }));
    const s = await seed();
    const impact = (await impactOf(s.id)).json() as ImpactReport;
    expect(impact.notes).toBe(1);
    expect((await purge(s.id, impact.confirm_token!)).statusCode).toBe(200);
    expect(noteIds()).toEqual(['N-OTHER']);
  });

  it('fill() that removes ids from a core set is refused (preview and purge); nothing is deleted', async () => {
    const s = await seed();
    // the preview of today, before the faulty module is loaded
    const before = (await impactOf(s.id)).json() as ImpactReport;
    expect(before.notes).toBe(1);
    registerPurgeExtension(t.ctx, ext({ fill: (ctx, set) => void ctx.db.run(`DELETE FROM ${set.table('note')}`) }));

    const preview = await api(t).get(`/api/sources/${s.id}/impact?mode=purge`);
    expect(preview.statusCode).toBe(500);
    const res = await purge(s.id, before.confirm_token!);
    expect(res.statusCode).toBe(500);
    expect(noteIds()).toEqual(['N-ON', 'N-OTHER']);
    expect(t.ctx.db.get('SELECT 1 AS x FROM source WHERE id = ?', [s.id])).toBeTruthy();
  });

  it('apply() that removes ids from a core set after the token check rolls the whole purge back', async () => {
    registerPurgeExtension(t.ctx, ext({ apply: (ctx, set) => void ctx.db.run(`DELETE FROM ${set.table('note')}`) }));
    const s = await seed();
    const impact = (await impactOf(s.id)).json() as ImpactReport;
    const res = await purge(s.id, impact.confirm_token!);
    expect(res.statusCode).toBe(500);
    expect(noteIds()).toEqual(['N-ON', 'N-OTHER']);
    expect(t.ctx.db.get('SELECT 1 AS x FROM source WHERE id = ?', [s.id])).toBeTruthy();
  });

  it('afterCore() deletes rows that core rows reference (P1-T2: a layer referenced by note.layer_id) after the core deletes, in the same transaction', async () => {
    // the shape of 0271: annotation_layer is a PARENT of core rows (note.layer_id / annotation.layer_id, no cascade)
    t.ctx.db.exec(`CREATE TABLE ext_layer (id TEXT PRIMARY KEY, document_key TEXT NOT NULL) STRICT`);
    t.ctx.db.exec(`ALTER TABLE note ADD COLUMN ext_layer_id TEXT REFERENCES ext_layer(id)`);
    const s = await seed();
    t.ctx.db.run(`INSERT INTO ext_layer (id, document_key) VALUES ('L-PURGED', ?), ('L-KEPT', 'source:other')`, [`source:${s.id}`]);
    t.ctx.db.run(`UPDATE note SET ext_layer_id = 'L-PURGED' WHERE id = 'N-ON'`);
    const layersOf = (ctx: typeof t.ctx, set: { table(s: 'source'): string }) =>
      ctx.db.all<{ id: string }>(`SELECT id FROM ext_layer WHERE document_key IN (SELECT 'source:' || id FROM ${set.table('source')})`);
    // the layer is really there and really referenced: while its note exists it cannot be deleted
    expect(layersOf(t.ctx, { table: () => `(SELECT '${s.id}' AS id)` }).map((l) => l.id)).toEqual(['L-PURGED']);
    expect(() => t.ctx.db.run(`DELETE FROM ext_layer WHERE id = 'L-PURGED'`)).toThrow(/FOREIGN KEY/i);

    // deleting the layer BEFORE the core deletes its notes is refused by the foreign key: nothing is deleted
    const before = registerPurgeExtension(
      t.ctx,
      ext({
        name: 'test-layers',
        apply: (ctx, set) => {
          for (const l of layersOf(ctx, set)) ctx.db.run('DELETE FROM ext_layer WHERE id = ?', [l.id]);
        },
      }),
    );
    const impact = (await impactOf(s.id)).json() as ImpactReport;
    const refused = await purge(s.id, impact.confirm_token!);
    expect(refused.statusCode).toBe(500);
    expect(noteIds()).toEqual(['N-ON', 'N-OTHER']);
    expect(t.ctx.db.all<{ id: string }>('SELECT id FROM ext_layer ORDER BY id').map((r) => r.id)).toEqual(['L-KEPT', 'L-PURGED']);
    before();

    // the after-core step runs once the core deleted the notes and annotations of the purge set
    registerPurgeExtension(
      t.ctx,
      ext({
        name: 'test-layers',
        apply: () => undefined,
        afterCore: (ctx, set) => {
          const ids = layersOf(ctx, set).map((l) => l.id);
          for (const id of ids) ctx.db.run('DELETE FROM ext_layer WHERE id = ?', [id]);
          return ids.map((id) => ['ext_layer', id] as const);
        },
      }),
    );
    const fresh = (await api(t).get(`/api/sources/${s.id}/impact?mode=purge`)).json() as ImpactReport;
    const seqBefore = t.ctx.sync.headSeq();
    const res = await purge(s.id, fresh.confirm_token!);
    expect(res.statusCode, res.body).toBe(200);
    expect(noteIds()).toEqual(['N-OTHER']);
    expect(t.ctx.db.all<{ id: string }>('SELECT id FROM ext_layer ORDER BY id').map((r) => r.id)).toEqual(['L-KEPT']);
    const announced = t.ctx.db.all<{ entity_id: string }>(`SELECT entity_id FROM sync_change WHERE entity_type = 'ext_layer' AND seq > ?`, [seqBefore]);
    expect(announced.map((r) => r.entity_id)).toEqual(['L-PURGED']);
  });

  it('apply() that adds ids to a core set (rows the owner never saw in the preview) rolls the whole purge back', async () => {
    registerPurgeExtension(
      t.ctx,
      ext({ apply: (ctx, set) => void ctx.db.run(`INSERT OR IGNORE INTO ${set.table('note')} (id) VALUES ('N-OTHER')`) }),
    );
    const s = await seed();
    const impact = (await impactOf(s.id)).json() as ImpactReport;
    expect(impact.notes).toBe(1);
    const res = await purge(s.id, impact.confirm_token!);
    expect(res.statusCode).toBe(500);
    expect(noteIds()).toEqual(['N-ON', 'N-OTHER']);
  });
});
