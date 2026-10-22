// AOS-21.14 — DocumentForks: the fork graph of AOS-4.1–4.3, as data, end to end:
//   official lecture version (space) ← publication version (lecture_version_id) ← each user's copy (vault
//   document_copy: mode, publication_id, applied version, the stub of the lecture, the copied layer) and the system's
//   holder index (publication_copy: who holds which mode) — and every copied item carries its hop
//   (attribution.derived_from: space, publication, version, item). N copies add stubs and overlay rows only: no blob,
//   chunk or FTS duplication (AOS-4.1). A fork stays pinned at its version; a followed copy moves with the feed.
// (A fork cannot be re-published in Phase 1 — a fork or a followed layer is «someone else's» writing — so the graph has
// one publication hop; collaborative copies are Phase 4.)
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DocumentCopyView, PublicationView, StartStudyingResponse } from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import { call, ok } from '../channels/helpers';
import { createLayer, createPubWorld, inVault, publish, type PubWorld, settle, startPersonal, strokes, type Who } from './pubWorld';

let w: PubWorld;
let pub: PublicationView;
let layer: string;
const copies: Partial<Record<Who, DocumentCopyView>> = {};

beforeAll(async () => {
  w = await createPubWorld(3);
  await startPersonal(w, 'hasan');
  layer = await createLayer(w, 'hasan', 'شرح حسن');
  await strokes(w, 'hasan', layer, 0, 4);
  pub = await publish(w, 'hasan', [layer], 'شرح حسن');
  for (const [who, mode] of [
    ['zainab', 'followed'],
    ['ali', 'independent_fork'],
  ] as const) {
    copies[who] = ok<StartStudyingResponse>(await call(w.t, w.p[who].h, 'POST', '/api/copies', { id: newId(), space_id: w.space, lecture_id: w.lecture.id, mode, publication_id: pub.id })).copy;
  }
  await settle(w);
}, 300_000);
afterAll(async () => {
  await w?.close();
});

const copyRow = (who: Who) =>
  inVault(w, who, () =>
    w.t.ctx.db.get<{ mode: string; publication_id: string | null; applied_version_no: number | null; origin_space_id: string; origin_lecture_id: string; source_id: string; copied_layer_id: string | null }>(
      'SELECT mode, publication_id, applied_version_no, origin_space_id, origin_lecture_id, source_id, copied_layer_id FROM document_copy WHERE id = ?',
      [copies[who]!.id],
    ),
  )!;

describe('AOS-21.14 — the fork graph', () => {
  it('each copy links to its publication version and, through it, to the official lecture version', () => {
    const pv = w.t.ctx.dbs.space(w.space).get<{ lecture_version_id: string; version_no: number }>('SELECT lecture_version_id, version_no FROM publication_version WHERE publication_id = ? ORDER BY version_no LIMIT 1', [pub.id])!;
    expect(pv).toEqual({ lecture_version_id: w.lecture.versionId, version_no: 1 });
    for (const [who, mode] of [
      ['zainab', 'followed'],
      ['ali', 'independent_fork'],
    ] as const) {
      const c = copyRow(who);
      expect(c, who).toMatchObject({ mode, publication_id: pub.id, applied_version_no: 1, origin_space_id: w.space, origin_lecture_id: w.lecture.id, source_id: w.lecture.sourceId });
      expect(c.copied_layer_id, who).toBeTruthy();
    }
    // the system's holder index: who holds which mode (no content)
    const holders = w.t.ctx.system.db.all<{ user_id: string; mode: string }>('SELECT user_id, mode FROM publication_copy WHERE publication_id = ? AND ended_at IS NULL ORDER BY user_id', [pub.id]);
    expect(new Map(holders.map((h) => [h.user_id, h.mode]))).toEqual(
      new Map([
        [w.p.zainab.user.id, 'followed'],
        [w.p.ali.user.id, 'independent'],
      ]),
    );
  });

  it('every copied item carries its hop: space, publication, version, item', () => {
    for (const who of ['zainab', 'ali'] as const) {
      const lid = copyRow(who).copied_layer_id!;
      const rows = inVault(w, who, () =>
        w.t.ctx.db.all<{ derived_from_json: string; author_user_id: string }>(
          `SELECT a.derived_from_json, a.author_user_id FROM annotation n JOIN attribution a ON a.entity_type = 'annotation' AND a.entity_id = n.id WHERE n.layer_id = ? AND n.deleted_at IS NULL`,
          [lid],
        ),
      );
      expect(rows.length, who).toBe(4);
      for (const r of rows) {
        expect(r.author_user_id).toBe(w.p.hasan.user.id);
        const hop = JSON.parse(r.derived_from_json) as Array<Record<string, unknown>>;
        expect(hop[0]).toMatchObject({ space_id: w.space, publication_id: pub.id, version_no: 1 });
        expect(typeof hop[0]!.item_id).toBe('string');
      }
    }
  });

  it('N copies add stubs and overlay rows only — no blob, chunk or FTS row is duplicated into a vault', () => {
    for (const who of ['zainab', 'ali', 'hasan'] as const) {
      const counts = inVault(w, who, () => ({
        chunks: w.t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM document_chunk WHERE source_id = ?', [w.lecture.sourceId])!.n,
        stub: w.t.ctx.db.get<{ is_stub: number }>('SELECT is_stub FROM source WHERE id = ?', [w.lecture.sourceId])!.is_stub,
      }));
      expect(counts, who).toEqual({ chunks: 0, stub: 1 });
    }
    // one blob for the lecture file in the registry, however many copies point at it
    const fileId = w.t.ctx.dbs.space(w.space).get<{ file_id: string }>('SELECT file_id FROM source_version WHERE id = ?', [w.lecture.versionId])!.file_id;
    const sha = w.t.ctx.dbs.space(w.space).get<{ sha256: string }>('SELECT sha256 FROM stored_file WHERE id = ?', [fileId])!.sha256;
    expect(w.t.ctx.system.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM blob WHERE sha256 = ?', [sha])!.n).toBe(1);
  });

  it('a new publication version moves the followed copy; the fork stays pinned at version 1', async () => {
    await strokes(w, 'hasan', layer, 1, 2);
    ok(await call(w.t, w.p.hasan.h, 'POST', w.S(`/publications/${pub.id}/versions`), { layer_ids: [layer], change_note: 'أضفت الصفحة الثانية' }));
    await settle(w);
    expect(copyRow('ali').applied_version_no).toBe(1);
    const z = copyRow('zainab');
    expect(z.publication_id).toBe(pub.id);
    const zainab = w.t.ctx.system.db.get<{ applied_version_no: number; pending_version_no: number | null }>('SELECT applied_version_no, pending_version_no FROM publication_copy WHERE user_id = ? AND publication_id = ?', [w.p.zainab.user.id, pub.id])!;
    expect(Math.max(zainab.applied_version_no, zainab.pending_version_no ?? 0)).toBe(2);
  });
});
