// Review queue items raised by the Question Vault (§48): truncated_question, missing_option, conflicting_key,
// unofficial_mark, question_validation_failed, uncertain_lecture_link, duplicate_suggestion. Every item has a
// specific Arabic reason and `details_json.origin = 'questions'` + a stable `code`, so re-extraction updates the
// open item instead of duplicating it, and never re-opens what the owner already resolved.
import { type QuestionReviewItemView, type ReviewQueueKind } from '@medlevo/shared';
import type { AppContext } from '../../context';
import { fromJson, toJson } from '../../db/db';
import { sha256 } from '../../lib/hash';
import { newId } from '../../lib/ids';

export const REVIEW_KIND_LABELS_AR: Partial<Record<ReviewQueueKind, string>> = {
  truncated_question: 'سؤال مبتور',
  missing_option: 'خيار مفقود',
  conflicting_key: 'مفتاح متعارض',
  unofficial_mark: 'علامة غير رسمية',
  question_validation_failed: 'فحص استخراج لم يُجتز',
  uncertain_lecture_link: 'ربط بمحاضرة غير مؤكد',
  duplicate_suggestion: 'سؤال مكرر محتمل',
  ocr_error: 'خطأ قراءة',
  unreadable_page: 'صفحة غير مقروءة',
};

export const QUESTION_REVIEW_KINDS: ReviewQueueKind[] = [
  'truncated_question',
  'missing_option',
  'conflicting_key',
  'unofficial_mark',
  'question_validation_failed',
  'uncertain_lecture_link',
  'duplicate_suggestion',
];

export interface DesiredItem {
  kind: ReviewQueueKind;
  code: string;
  reason: string;
  details?: Record<string, unknown>;
}

interface ItemRow {
  id: string;
  kind: ReviewQueueKind;
  entity_type: string;
  entity_id: string;
  source_id: string | null;
  reason: string;
  details_json: string | null;
  status: QuestionReviewItemView['status'];
  created_at: number;
  resolved_at: number | null;
}

/**
 * Make the open review items of (entityType, entityId) under `scope` equal to `desired`:
 *  * same code still applies → reason/details refreshed (one open item, never duplicated);
 *  * new code → inserted, unless the owner already resolved an item with the same code AND the same reason;
 *  * code no longer applies → the OPEN item is removed (the owner never acted on it).
 */
export function syncReviewItems(
  ctx: AppContext,
  entityType: string,
  entityId: string,
  scope: string,
  desired: DesiredItem[],
  sourceId: string | null,
  questionId: string | null,
): void {
  const now = ctx.clock.now();
  const existing = ctx.db.all<ItemRow>(
    `SELECT * FROM review_queue_item WHERE entity_type = ? AND entity_id = ?
       AND json_valid(details_json) AND json_extract(details_json, '$.origin') = 'questions' AND json_extract(details_json, '$.scope') = ?`,
    [entityType, entityId, scope],
  );
  const codeOf = (r: ItemRow) => fromJson<{ code?: string }>(r.details_json, {})?.code ?? '';
  const sigOf = (r: ItemRow) => fromJson<{ sig?: string }>(r.details_json, {})?.sig ?? '';
  const wanted = new Map(desired.map((d) => [d.code, d]));
  for (const r of existing) {
    if (r.status !== 'open') continue;
    const d = wanted.get(codeOf(r));
    if (!d) ctx.db.run('DELETE FROM review_queue_item WHERE id = ?', [r.id]);
  }
  for (const d of desired) {
    const sig = sha256(`${d.kind}|${d.reason}`).slice(0, 16);
    const details = toJson({ origin: 'questions', scope, code: d.code, sig, question_id: questionId, ...(d.details ?? {}) });
    const open = existing.find((r) => r.status === 'open' && codeOf(r) === d.code);
    if (open) {
      ctx.db.run('UPDATE review_queue_item SET kind = ?, reason = ?, details_json = ?, source_id = ? WHERE id = ?', [d.kind, d.reason, details, sourceId, open.id]);
      continue;
    }
    const resolved = existing.find((r) => r.status !== 'open' && codeOf(r) === d.code && sigOf(r) === sig);
    if (resolved) continue;
    ctx.db.run(
      `INSERT INTO review_queue_item (id, kind, entity_type, entity_id, source_id, reason, details_json, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
      [newId(now), d.kind, entityType, entityId, sourceId, d.reason, details, now],
    );
  }
}

/** Close the open items of an entity (e.g. after the owner reviewed / corrected the question). */
export function resolveOpenItems(ctx: AppContext, entityType: string, entityId: string, status: 'accepted' | 'corrected' | 'rejected' | 'dismissed', note: string | null, kinds?: ReviewQueueKind[]): number {
  const now = ctx.clock.now();
  const res = ctx.db.run(
    `UPDATE review_queue_item SET status = ?, resolved_at = ?, resolution_json = ?
      WHERE entity_type = ? AND entity_id = ? AND status = 'open'
        AND json_valid(details_json) AND json_extract(details_json, '$.origin') = 'questions'
        ${kinds ? `AND kind IN (${kinds.map(() => '?').join(',')})` : ''}`,
    [status, now, toJson({ by: 'owner', note }), entityType, entityId, ...(kinds ?? [])],
  );
  return res.changes;
}

export function reviewItemView(r: ItemRow): QuestionReviewItemView {
  const details = fromJson<Record<string, unknown> | null>(r.details_json, null);
  return {
    id: r.id,
    kind: r.kind,
    kind_label_ar: REVIEW_KIND_LABELS_AR[r.kind] ?? r.kind,
    entity_type: r.entity_type,
    entity_id: r.entity_id,
    question_id: typeof details?.question_id === 'string' ? details.question_id : r.entity_type === 'question' ? r.entity_id : null,
    source_id: r.source_id,
    reason: r.reason,
    status: r.status,
    details,
    created_at: r.created_at,
    resolved_at: r.resolved_at,
  };
}

export function reviewItemsForQuestion(ctx: AppContext, questionId: string, onlyOpen = false): QuestionReviewItemView[] {
  const rows = ctx.db.all<ItemRow>(
    `SELECT * FROM review_queue_item
      WHERE json_valid(details_json) AND json_extract(details_json, '$.origin') = 'questions'
        AND (json_extract(details_json, '$.question_id') = ? OR (entity_type = 'question' AND entity_id = ?))
        ${onlyOpen ? "AND status = 'open'" : ''}
      ORDER BY status = 'open' DESC, created_at DESC`,
    [questionId, questionId],
  );
  return rows.map(reviewItemView);
}

export type { ItemRow as ReviewItemRow };
