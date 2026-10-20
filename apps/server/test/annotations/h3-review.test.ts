// Independent review of Round 7 — H3 (server side). Each test was written to FAIL on the code as the track left it.
//  * item 2 — the re-anchoring decision accepted the same item twice in one request: both copies passed the revision
//    check (it runs before any write), so the item was written twice — rev + 2, two audit entries for one decision, the
//    item twice in the answer — and a device holding rev + 1 then saw a phantom «edited elsewhere».
//  * item 2 — a note on a Study Book paragraph that the re-anchoring report lists stayed in «تحتاج إعادة ربط» after the
//    owner moved it to another paragraph of the Study Book: the list only checked that the anchor was still a Study Book
//    anchor, not that it still pointed at the paragraph the report found gone.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId, type NeedsReanchorResponse, type ReanchorResponse, type SyncOp, type SyncOpResult } from '@medlevo/shared';
import { type AuthHeaders, createTestApp, type TestApp } from '../helpers/app';
import { createSourceFixture, op, type SourceFixture } from './helpers';

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

async function push(ops: SyncOp[]): Promise<SyncOpResult[]> {
  const res = await t.app.inject({ method: 'POST', url: '/api/sync/push', headers: h, payload: { ops } });
  expect(res.statusCode).toBe(200);
  return res.json().results as SyncOpResult[];
}
const goneAnchor = () => ({ type: 'page' as const, source_id: f.sourceId, version_id: f.versionId, page_id: 'GONEPAGE', page_index: 7, space: 'page_norm' as const });
const ink = (x: number, y: number) => ({ v: 1, points: [[x, y, 0], [x + 0.1, y + 0.05, 16]], style: { tool: 'pen', color: 'ink-blue', width: 0.0025 }, bbox: { x, y, w: 0.1, h: 0.05 }, pressure_available: false, tilt_available: false });
const reanchorReq = (payload: Record<string, unknown>) => t.app.inject({ method: 'POST', url: '/api/annotations/reanchor', headers: h, payload });

describe('H3 review — one re-anchoring decision per item', () => {
  it('the same item twice in one request is refused; nothing is written or audited', async () => {
    const id = newId();
    expect((await push([op({ entity_type: 'annotation', entity_id: id, op: 'append', payload: { kind: 'ink', tool: 'pen', anchor: goneAnchor(), data: ink(0.2, 0.3), layer: 'ink' } })]))[0]!.result).toBe('applied');
    const twice = await reanchorReq({
      items: [
        { kind: 'annotation', id, rev: 1 },
        { kind: 'annotation', id, rev: 1 },
      ],
      action: 'move',
      target: { type: 'page', version_id: f.versionId, page_id: f.pageIds[1] },
    });
    expect(twice.statusCode).toBe(400);
    expect(t.ctx.db.get<{ rev: number }>('SELECT rev FROM annotation WHERE id = ?', [id])!.rev).toBe(1);
    expect(t.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM change_log WHERE action LIKE 'reanchor%'`)!.n).toBe(0);
    // the same decision with the item once is applied once: rev + 1, one audit entry, the item once in the answer
    const once = await reanchorReq({ items: [{ kind: 'annotation', id, rev: 1 }], action: 'move', target: { type: 'page', version_id: f.versionId, page_id: f.pageIds[1] } });
    expect(once.statusCode).toBe(200);
    const body = once.json() as ReanchorResponse;
    expect(body.annotations.map((a) => [a.id, a.rev])).toEqual([[id, 2]]);
    expect(t.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM change_log WHERE action = 'reanchor' AND entity_id = ?`, [id])!.n).toBe(1);
  });
});

describe('H3 review — a Study Book note the owner moved leaves «تحتاج إعادة ربط»', () => {
  function studyBook(): { lineage: string; v2: string } {
    const now = t.clock.now();
    const lineage = newId();
    const ids = [newId(), newId()];
    ids.forEach((id, i) =>
      t.ctx.db.run(
        `INSERT INTO artifact (id, lineage_id, version_no, kind, primary_source_id, scope_json, params_json, cache_key, rules_version, generator_version, verifier_version, status, created_at, updated_at)
         VALUES (?, ?, ?, 'study_book', ?, '{}', '{}', ?, 'r', 'g', 'v', ?, ?, ?)`,
        [id, lineage, i + 1, f.sourceId, `k${i}`, i === 0 ? 'superseded' : 'published', now, now],
      ),
    );
    const para = (t2: string) => JSON.stringify({ v: 1, paragraphs: [{ dir: 'rtl', runs: [{ t: t2 }] }] });
    t.ctx.db.run(`INSERT INTO content_block (id, artifact_id, block_key, ord, kind, content_json, created_at) VALUES (?, ?, 'K_OLD', 1, 'paragraph', ?, ?)`, [newId(), ids[0], para('يبدأ الألم حول السرة'), now]);
    t.ctx.db.run(`INSERT INTO content_block (id, artifact_id, block_key, ord, kind, content_json, created_at) VALUES (?, ?, 'K_NEW', 1, 'paragraph', ?, ?)`, [newId(), ids[1], para('ينتقل الألم إلى الحفرة الحرقفية اليمنى'), now]);
    return { lineage, v2: ids[1]! };
  }

  it('moved to a paragraph of the new Study Book version: no longer listed (and the decision is audited)', async () => {
    const { lineage, v2 } = studyBook();
    const noteId = newId();
    const anchor = { type: 'block', lineage_id: lineage, artifact_version: 1, block_key: 'K_OLD', quote: { exact: 'يبدأ الألم حول السرة' } };
    const r = await push([op({ entity_type: 'note', entity_id: noteId, payload: { title: null, body: { v: 1, paragraphs: [{ dir: 'rtl', runs: [{ t: 'ملاحظتي' }] }] }, anchor, origin: 'owner' } })]);
    expect(r[0]!.result).toBe('applied');
    // the report of version 2: this note's paragraph is gone
    t.ctx.db.run(`INSERT INTO artifact_reanchor (artifact_id, target_kind, target_id, block_key, previous_version_no, status, created_at) VALUES (?, 'note', ?, 'K_OLD', 1, 'needs_reanchor', ?)`, [v2, noteId, t.clock.now()]);
    const lists = async () => (await t.app.inject({ method: 'GET', url: '/api/annotations/needs-reanchor', headers: h })).json() as NeedsReanchorResponse;
    expect((await lists()).notes!.map((n) => n.note.id)).toEqual([noteId]);
    const moved = await reanchorReq({ items: [{ kind: 'note', id: noteId, rev: 1 }], action: 'move', target: { type: 'block', lineage_id: lineage, artifact_version: 2, block_key: 'K_NEW' } });
    expect(moved.statusCode).toBe(200);
    const n = (moved.json() as ReanchorResponse).notes[0]!;
    expect(n.anchor).toMatchObject({ type: 'block', artifact_version: 2, block_key: 'K_NEW' });
    expect(n.previous_anchor).toMatchObject({ block_key: 'K_OLD' });
    const after = await lists();
    expect(after.notes).toEqual([]);
    expect(after.detached!.notes).toEqual([]);
  });
});
