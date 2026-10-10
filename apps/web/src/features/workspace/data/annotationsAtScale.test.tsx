// Regression (I2 performance pass, docs/PERFORMANCE.md): a page with 5 000 ink strokes opened in Chromium showed only
// 377 of them after two minutes. Causes fixed here:
//   1. the highlight / bookmark / re-anchor live queries scanned EVERY annotation of the page (all strokes) and were
//      re-run by Dexie on every ink write → O(strokes²) during a pull; now indexed (local schema v2);
//   2. the reader's download of the document's annotations did not tell the open ink layer, so strokes appeared only
//      as the sync pull re-delivered them one by one; now one reload per page;
//   3. the pull applier rewrote strokes the device already held at the same server revision (a repaint each).
import Dexie from 'dexie';
import { Profiler } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, renderHook, waitFor } from '@testing-library/react';
import { annotationTargetKey, newId, type AnnotationAnchor, type AnnotationDTO } from '@medlevo/shared';
import { getDb, LOCAL_DB_NAME, MedLevoDB, type AnnotationRow } from '../../../lib/localdb';
import { onAnnotationRowsChanged } from '../ink/events';
import { createAnnotationApplier } from '../ink/persistence';
import { TextHighlightsLayer } from '../reader/overlays';
import { useAnnotationsOfKind, useLocalNeedsReanchor } from './hooks';
import { mergeServerAnnotations } from './local';

const anchor = (page: number): AnnotationAnchor => ({ type: 'page', source_id: 'S1', version_id: 'V1', page_id: `P${page}`, page_index: page, space: 'page_norm' });
const KEY0 = annotationTargetKey(anchor(0));

function inkRow(id = newId(), page = 0): AnnotationRow {
  return {
    id,
    targetKey: annotationTargetKey(anchor(page)),
    kind: 'ink',
    tool: 'pen',
    anchor: anchor(page),
    data: { v: 1, points: Array.from({ length: 40 }, (_, k) => [0.1 + k * 0.002, 0.2, k * 8]), style: { tool: 'pen', color: 'ink-blue', width: 0.002 }, bbox: { x: 0.1, y: 0.2, w: 0.08, h: 0.01 } },
    layer: 'ink',
    z: 0,
    locked: false,
    anchorStatus: 'ok',
    rev: 1,
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
    syncState: 'synced',
  } as AnnotationRow;
}

function dto(row: AnnotationRow, rev = row.rev ?? 1): AnnotationDTO {
  return { id: row.id, kind: row.kind, tool: row.tool, anchor: row.anchor, data: row.data, layer: row.layer, z: row.z, locked: row.locked, anchor_status: row.anchorStatus ?? 'ok', input: null, rev, created_at: 1, updated_at: 2, deleted_at: null } as unknown as AnnotationDTO;
}

afterEach(async () => {
  const db = getDb();
  await db.open();
  await db.annotations.clear();
  await db.outbox.clear();
});

describe('annotations at scale', () => {
  it('local schema v2 adds the indexes and keeps every v1 row (unsynced ones included)', async () => {
    const name = `upgrade-${newId()}`;
    const v1 = new Dexie(name);
    v1.version(1).stores({ annotations: 'id, targetKey, updatedAt, syncState', outbox: '++seq, &op_id, entity_type, entity_id, status, [entity_type+entity_id]' });
    await v1.open();
    await v1.table('annotations').bulkPut([{ ...inkRow('A') }, { ...inkRow('B'), kind: 'bookmark', syncState: 'pending_sync' }, { ...inkRow('C'), anchorStatus: 'needs_reanchor' }]);
    await v1.table('outbox').add({ op_id: 'op1', entity_type: 'annotation', entity_id: 'B', op: 'append', status: 'pending' });
    v1.close();
    const v2 = new MedLevoDB(name);
    await v2.open();
    expect(v2.verno).toBe(2);
    expect(await v2.annotations.count()).toBe(3);
    expect((await v2.annotations.where('[targetKey+kind]').equals([KEY0, 'bookmark']).toArray()).map((r) => r.id)).toEqual(['B']);
    expect((await v2.annotations.where('anchorStatus').equals('needs_reanchor').toArray()).map((r) => r.id)).toEqual(['C']);
    expect(await v2.outbox.where('status').equals('pending').count()).toBe(1);
    v2.close();
    await Dexie.delete(name);
    expect(LOCAL_DB_NAME).toBe('medlevo');
  });

  it('ink writes do not re-run the highlight / bookmark / re-anchor views of the page', async () => {
    const db = getDb();
    await db.open();
    await db.annotations.bulkPut([inkRow(), { ...inkRow(), kind: 'bookmark' }, { ...inkRow(), kind: 'text_highlight', data: { v: 1, style: 'highlight', color: 'yellow', rects: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.02 }] } }]);
    let layerCommits = 0;
    render(
      <Profiler id="hl" onRender={() => layerCommits++}>
        <TextHighlightsLayer targetKey={KEY0} />
      </Profiler>,
    );
    const marks = renderHook(() => useAnnotationsOfKind([KEY0], 'bookmark'));
    const reanchor = renderHook(() => useLocalNeedsReanchor([KEY0]));
    await waitFor(() => expect(marks.result.current).toHaveLength(1));
    await waitFor(() => expect(document.querySelectorAll('.wk-mark')).toHaveLength(1));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const before = { layerCommits, marks: marks.result.current, reanchor: reanchor.result.current };
    // 30 strokes written one by one (as the sync pull does)
    for (let i = 0; i < 30; i++) {
      await act(async () => {
        await db.annotations.put(inkRow());
      });
    }
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(layerCommits).toBe(before.layerCommits);
    expect(marks.result.current).toBe(before.marks); // same array: the query was not re-run
    expect(reanchor.result.current).toBe(before.reanchor);
    // …while a bookmark write does update the bookmark view
    await act(async () => {
      await db.annotations.put({ ...inkRow(), kind: 'bookmark' });
    });
    await waitFor(() => expect(marks.result.current).toHaveLength(2));
  });

  it('the reader download of a document tells open pages once per page (not once per stroke)', async () => {
    const db = getDb();
    await db.open();
    const events: Array<{ targetKeys: string[]; ids: string[] | null }> = [];
    const off = onAnnotationRowsChanged((e) => events.push({ targetKeys: e.targetKeys, ids: e.ids }));
    try {
      const rows = [...Array.from({ length: 200 }, () => inkRow(newId(), 0)), ...Array.from({ length: 50 }, () => inkRow(newId(), 1))];
      expect(await mergeServerAnnotations(db, rows.map((r) => dto(r)))).toBe(250);
      expect(events).toHaveLength(1);
      expect(events[0]!.ids).toBeNull();
      expect([...events[0]!.targetKeys].sort()).toEqual([KEY0, annotationTargetKey(anchor(1))].sort());
      // nothing new → no notification
      expect(await mergeServerAnnotations(db, rows.map((r) => dto(r)))).toBe(0);
      expect(events).toHaveLength(1);
    } finally {
      off();
    }
  });

  it('the pull applier does not rewrite a stroke already held at the same server revision', async () => {
    const db = getDb();
    await db.open();
    const row = inkRow();
    await db.annotations.put(row);
    const applier = createAnnotationApplier(() => 99);
    const seen = vi.fn();
    const off = onAnnotationRowsChanged(seen);
    try {
      await applier({ seq: 1, entity_type: 'annotation', entity_id: row.id, entity: dto(row, 1) }, { db, source: 'pull', localOps: [] });
      expect(seen).not.toHaveBeenCalled();
      expect((await db.annotations.get(row.id))!.updatedAt).toBe(1);
      // a newer revision is still applied
      await applier({ seq: 2, entity_type: 'annotation', entity_id: row.id, entity: dto(row, 2) }, { db, source: 'pull', localOps: [] });
      expect(seen).toHaveBeenCalledTimes(1);
      expect((await db.annotations.get(row.id))!.rev).toBe(2);
    } finally {
      off();
    }
  });
});
