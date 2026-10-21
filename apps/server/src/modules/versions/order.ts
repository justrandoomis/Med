// Lecture ordering «حسب الرقم» / «حسب التاريخ» (PRD AOS-3.5). The order is computed by the shared pure
// `orderLectures` (natural-title fallback, stable ties). A folder's manual order is never replaced silently: applying an
// order is an explicit owner action that writes it AS the folder's manual order (audited); later detections or uploads
// never reorder anything.
import { orderLectures, type LectureOrderItem, type LectureOrderMode, type LectureOrderResponse } from '@medlevo/shared';
import type { AppContext } from '../../context';
import { AppError } from '../../lib/errors';

function node(ctx: AppContext, nodeId: string): { sort_mode: string; title: string } {
  const n = ctx.db.get<{ sort_mode: string; title: string; deleted_at: number | null }>('SELECT sort_mode, title, deleted_at FROM library_node WHERE id = ?', [nodeId]);
  if (!n || n.deleted_at !== null) throw new AppError('NOT_FOUND', 'المجلد غير موجود.', 404);
  return n;
}

function items(ctx: AppContext, nodeId: string): LectureOrderItem[] {
  return ctx.db.all<LectureOrderItem>(
    `SELECT id AS source_id, title, lecture_no, held_on, sort_order, created_at FROM source WHERE node_id = ? AND deleted_at IS NULL ORDER BY sort_order, created_at, id`,
    [nodeId],
  );
}

export function lectureOrder(ctx: AppContext, nodeId: string, mode: LectureOrderMode): LectureOrderResponse {
  const n = node(ctx, nodeId);
  const ordered = orderLectures(items(ctx, nodeId), mode);
  return {
    node_id: nodeId,
    mode,
    items: ordered.map((it, i) => ({ ...it, position: i + 1 })),
    missing_key: ordered.filter((it) => (mode === 'number' ? it.lecture_no === null : it.held_on === null)).length,
    node_sort_mode: n.sort_mode,
  };
}

/** Write the computed order as the folder's manual order (the owner chose it). */
export function applyLectureOrder(ctx: AppContext, nodeId: string, mode: LectureOrderMode): LectureOrderResponse {
  const n = node(ctx, nodeId);
  const ordered = orderLectures(items(ctx, nodeId), mode);
  const now = ctx.clock.now();
  ctx.db.tx(() => {
    ordered.forEach((it, i) => ctx.db.run('UPDATE source SET sort_order = ?, updated_at = ? WHERE id = ?', [(i + 1) * 1024, now, it.source_id]));
    ctx.db.run(`UPDATE library_node SET sort_mode = 'manual', updated_at = ? WHERE id = ?`, [now, nodeId]);
    ctx.audit.record({
      entityType: 'library_node',
      entityId: nodeId,
      action: 'reorder',
      summary: `رتّبت محاضرات «${n.title}» ${mode === 'number' ? 'حسب الرقم' : 'حسب التاريخ'}`,
      before: { sort_mode: n.sort_mode },
      after: { sort_mode: 'manual', order: ordered.map((it) => it.source_id) },
    });
  });
  return lectureOrder(ctx, nodeId, mode);
}
