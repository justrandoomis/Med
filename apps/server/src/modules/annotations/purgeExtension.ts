// Purge extension of the annotations module for layers, history and attribution (Academic OS P1-T2; registered through
// P1-T1's seam `registerPurgeExtension`, BUILD_PLAN §3.2). A purge that deletes annotations and notes also deletes:
//   * their before-images in `annotation_revision` and their `attribution` rows (before the core deletes);
//   * the layers of a purged document (a purged source or notebook) once no remaining row points at them, with the
//     layers' own history and attribution (after the core deletes: layers are parents of `annotation.layer_id`).
// The preview lists these counts, and they are bound into the confirm token like every other count.
import type { AppContext } from '../../context';
import { registerPurgeExtension, type PurgeExtension, type PurgeSetView } from '../sources/purge';

/** layers whose document is purged (a purged source or notebook node) */
const purgedLayersSql = (set: PurgeSetView) => `SELECT id FROM annotation_layer
   WHERE (substr(document_key, 1, 7) = 'source:' AND substr(document_key, 8) IN ${set.in('source')})
      OR (substr(document_key, 1, 9) = 'notebook:' AND substr(document_key, 10) IN ${set.in('node')})`;

const count = (ctx: AppContext, sql: string) => ctx.db.get<{ n: number }>(sql)!.n;

export const layersPurgeExtension: PurgeExtension = {
  name: 'annotations.layers',
  count(ctx, set) {
    return {
      layers: count(ctx, `SELECT COUNT(*) AS n FROM (${purgedLayersSql(set)}) l JOIN annotation_layer al ON al.id = l.id WHERE al.deleted_at IS NULL`),
      revisions: count(
        ctx,
        `SELECT COUNT(*) AS n FROM annotation_revision
         WHERE (entity_type = 'annotation' AND entity_id IN ${set.in('annotation')})
            OR (entity_type = 'note' AND entity_id IN ${set.in('note')})
            OR (entity_type = 'annotation_layer' AND entity_id IN (${purgedLayersSql(set)}))`,
      ),
      attributions: count(
        ctx,
        `SELECT COUNT(*) AS n FROM attribution
         WHERE (entity_type = 'annotation' AND entity_id IN ${set.in('annotation')})
            OR (entity_type = 'note' AND entity_id IN ${set.in('note')})
            OR (entity_type = 'annotation_layer' AND entity_id IN (${purgedLayersSql(set)}))`,
      ),
    };
  },
  linesAr(c, mode) {
    if (mode !== 'purge') return [];
    const lines: string[] = [];
    if ((c.layers ?? 0) > 0) lines.push(`${c.layers} من طبقات الملاحظات الخاصة بهذا المحتوى`);
    if ((c.revisions ?? 0) > 0) lines.push(`${c.revisions} من نسخ سجل التعديلات للكتابات والملاحظات المحذوفة`);
    return lines;
  },
  apply(ctx, set) {
    ctx.db.run(`DELETE FROM annotation_revision WHERE (entity_type = 'annotation' AND entity_id IN ${set.in('annotation')}) OR (entity_type = 'note' AND entity_id IN ${set.in('note')})`);
    ctx.db.run(`DELETE FROM attribution WHERE (entity_type = 'annotation' AND entity_id IN ${set.in('annotation')}) OR (entity_type = 'note' AND entity_id IN ${set.in('note')})`);
  },
  afterCore(ctx, set) {
    // a layer stays while anything outside the purge still points at it (never expected; never a broken reference)
    const ids = ctx.db
      .all<{ id: string }>(
        `SELECT l.id FROM (${purgedLayersSql(set)}) l
         WHERE NOT EXISTS (SELECT 1 FROM annotation a WHERE a.layer_id = l.id) AND NOT EXISTS (SELECT 1 FROM note n WHERE n.layer_id = l.id)`,
      )
      .map((r) => r.id);
    const announced: Array<readonly [string, string]> = [];
    for (const id of ids) {
      ctx.db.run(`DELETE FROM annotation_revision WHERE entity_type = 'annotation_layer' AND entity_id = ?`, [id]);
      ctx.db.run(`DELETE FROM attribution WHERE entity_type = 'annotation_layer' AND entity_id = ?`, [id]);
      ctx.db.run('DELETE FROM annotation_layer WHERE id = ?', [id]);
      announced.push(['annotation_layer', id]);
    }
    return announced;
  },
};

export function registerLayersPurge(ctx: AppContext): () => void {
  return registerPurgeExtension(ctx, layersPurgeExtension);
}

// ─── (P1-T2 step 3) note migration records («انقل ملاحظاتي إلى الإصدار الجديد», migration 0274) ─────────────────────
// A purge of a lecture (or of one of its versions) deletes its runs and their item rows; a purged original or copy loses
// its item row and its «keep on the earlier version» decision. The copies themselves are ordinary annotations / notes and
// go with the core purge of their pages.
const purgedRunsSql = (set: PurgeSetView) => `SELECT id FROM reanchor_copy_run
   WHERE source_id IN ${set.in('source')} OR from_version_id IN ${set.in('version')} OR to_version_id IN ${set.in('version')}`;
const purgedItemsWhere = (set: PurgeSetView) => `run_id IN (${purgedRunsSql(set)})
   OR (entity_type = 'annotation' AND (copy_id IN ${set.in('annotation')} OR from_id IN ${set.in('annotation')}))
   OR (entity_type = 'note' AND (copy_id IN ${set.in('note')} OR from_id IN ${set.in('note')}))`;
const purgedDecisionsWhere = (set: PurgeSetView) => `to_version_id IN ${set.in('version')}
   OR (entity_type = 'annotation' AND entity_id IN ${set.in('annotation')})
   OR (entity_type = 'note' AND entity_id IN ${set.in('note')})`;

export const reanchorCopyPurgeExtension: PurgeExtension = {
  name: 'annotations.reanchor_copy',
  count(ctx, set) {
    return {
      runs: count(ctx, `SELECT COUNT(*) AS n FROM (${purgedRunsSql(set)})`),
      items: count(ctx, `SELECT COUNT(*) AS n FROM reanchor_copy_item WHERE ${purgedItemsWhere(set)}`),
      decisions: count(ctx, `SELECT COUNT(*) AS n FROM reanchor_copy_decision WHERE ${purgedDecisionsWhere(set)}`),
    };
  },
  linesAr(c, mode) {
    if (mode !== 'purge' || (c.runs ?? 0) === 0) return [];
    return [`${c.runs} من سجل نقل الملاحظات إلى إصدار أحدث (التقارير وإمكانية التراجع)`];
  },
  apply(ctx, set) {
    ctx.db.run(`DELETE FROM reanchor_copy_item WHERE ${purgedItemsWhere(set)}`);
    // a run of a purged lecture / version goes (exactly the counted ones). (review) A run of another lecture that is left
    // without item rows — every original and copy of it purged one by one — keeps its report row: it is not part of this
    // purge's counted impact, and its undo then finds nothing to tombstone.
    ctx.db.run(`DELETE FROM reanchor_copy_run WHERE id IN (${purgedRunsSql(set)})`);
    ctx.db.run(`DELETE FROM reanchor_copy_decision WHERE ${purgedDecisionsWhere(set)}`);
  },
};

export function registerReanchorCopyPurge(ctx: AppContext): () => void {
  return registerPurgeExtension(ctx, reanchorCopyPurgeExtension);
}
