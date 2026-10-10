// Non-destructive overlays on images (§32): highlight (rect), arrow, occlusion mask (rect), label (point). Geometry is
// normalized to the ORIGINAL image (0..1); the image file is never modified. Each overlay carries a certainty label
// (from the source caption / visually confirmed / UNCERTAIN / set by the owner). AC-08: an uncertain label never
// becomes a fixed quiz answer. Edits carry base_rev; removal is a tombstone; changes are audited.
import {
  OVERLAY_CERTAINTY_LABELS_AR,
  OVERLAY_KIND_LABELS_AR,
  overlayCreateSchema,
  overlayPatchSchema,
  type OverlayCertainty,
  type OverlayKind,
  type OverlayShape,
  type OverlayView,
} from '@medlevo/shared';
import type { AppContext } from '../../context';
import { fromJson, toJson } from '../../db/db';
import { AppError } from '../../lib/errors';
import { parseWith } from '../../lib/http';
import { newId } from '../../lib/ids';

interface OverlayRow {
  id: string;
  image_id: string;
  kind: OverlayKind;
  shape_json: string;
  label: string | null;
  certainty: OverlayCertainty;
  created_at: number;
  aliases_json: string;
  note: string | null;
  rev: number;
  updated_at: number | null;
  deleted_at: number | null;
}

const SHAPE_FOR: Record<OverlayKind, OverlayShape['type']> = { highlight: 'rect', occlusion_mask: 'rect', arrow: 'arrow', label: 'point' };

export function quizEligibility(o: Pick<OverlayView, 'kind' | 'label' | 'certainty'>): { eligible: boolean; reason_ar: string | null } {
  if (o.kind !== 'occlusion_mask') return { eligible: false, reason_ar: 'ليست قناع إخفاء.' };
  if (!o.label?.trim()) return { eligible: false, reason_ar: 'قناع بلا تسمية: لا يوجد جواب يُسأل عنه.' };
  if (o.certainty === 'uncertain') return { eligible: false, reason_ar: 'التسمية غير مؤكدة، ولا تصبح جوابًا ثابتًا في الاختبار (AC-08). أكّدها أو صحّحها أولًا.' };
  return { eligible: true, reason_ar: null };
}

function view(o: OverlayRow): OverlayView {
  const base = { kind: o.kind, label: o.label, certainty: o.certainty };
  const q = quizEligibility(base);
  return {
    id: o.id,
    image_id: o.image_id,
    kind: o.kind,
    kind_label_ar: OVERLAY_KIND_LABELS_AR[o.kind],
    shape: fromJson<OverlayShape>(o.shape_json)!,
    label: o.label,
    aliases: fromJson<string[]>(o.aliases_json, []) ?? [],
    certainty: o.certainty,
    certainty_label_ar: OVERLAY_CERTAINTY_LABELS_AR[o.certainty],
    note: o.note,
    quiz_eligible: q.eligible,
    quiz_ineligible_reason_ar: q.reason_ar,
    rev: o.rev,
    created_at: o.created_at,
    updated_at: o.updated_at ?? o.created_at,
  };
}

export function overlaysOf(ctx: AppContext, imageId: string, opts: { includeDeleted?: boolean } = {}): OverlayView[] {
  return ctx.db
    .all<OverlayRow>(`SELECT * FROM media_overlay WHERE image_id = ? ${opts.includeDeleted ? '' : 'AND deleted_at IS NULL'} ORDER BY created_at, id`, [imageId])
    .map(view);
}

export function getOverlayRow(ctx: AppContext, id: string): OverlayRow {
  const o = ctx.db.get<OverlayRow>('SELECT * FROM media_overlay WHERE id = ?', [id]);
  if (!o || o.deleted_at !== null) throw new AppError('NOT_FOUND', 'الطبقة غير موجودة.', 404);
  return o;
}

function checkShape(kind: OverlayKind, shape: OverlayShape): void {
  if (shape.type !== SHAPE_FOR[kind]) {
    throw new AppError('VALIDATION_FAILED', `شكل الطبقة لا يناسب نوعها (${OVERLAY_KIND_LABELS_AR[kind]}).`, 400, {
      where: 'body',
      issues: [{ path: 'shape.type', code: 'custom', message: 'شكل لا يناسب نوع الطبقة.' }],
    });
  }
  if (shape.type === 'rect' && (shape.x + shape.w > 1.0001 || shape.y + shape.h > 1.0001)) {
    throw new AppError('VALIDATION_FAILED', 'المستطيل يتجاوز حدود الصورة.', 400, { where: 'body', issues: [{ path: 'shape', code: 'custom', message: 'المستطيل يتجاوز حدود الصورة.' }] });
  }
}

export function createOverlay(ctx: AppContext, imageId: string, body: unknown): OverlayView {
  const req = parseWith(overlayCreateSchema, body, 'body');
  checkShape(req.kind, req.shape);
  const now = ctx.clock.now();
  const id = newId(now);
  ctx.db.tx(() => {
    ctx.db.run(
      `INSERT INTO media_overlay (id, image_id, kind, shape_json, label, certainty, created_at, aliases_json, note, rev, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, NULL)`,
      [id, imageId, req.kind, toJson(req.shape), req.label?.trim() || null, req.certainty, now, toJson(req.aliases ?? []), req.note ?? null, now],
    );
    ctx.audit.record({ entityType: 'media_overlay', entityId: id, action: 'create', summary: `إضافة ${OVERLAY_KIND_LABELS_AR[req.kind]} على صورة`, after: { kind: req.kind, certainty: req.certainty }, actor: 'owner' });
  });
  return view(getOverlayRow(ctx, id));
}

export function patchOverlay(ctx: AppContext, id: string, body: unknown): OverlayView {
  const req = parseWith(overlayPatchSchema, body, 'body');
  const o = getOverlayRow(ctx, id);
  if (req.base_rev !== o.rev) throw new AppError('CONFLICT', 'عُدّلت هذه الطبقة في مكان آخر؛ حدّث الصفحة. لم يُحفظ شيء.', 409, { current_rev: o.rev });
  const shape = req.shape ?? fromJson<OverlayShape>(o.shape_json)!;
  checkShape(o.kind, shape);
  const next = {
    shape,
    label: req.label === undefined ? o.label : req.label?.trim() || null,
    aliases: req.aliases ?? fromJson<string[]>(o.aliases_json, []) ?? [],
    certainty: req.certainty ?? o.certainty,
    note: req.note === undefined ? o.note : req.note,
  };
  const now = ctx.clock.now();
  ctx.db.tx(() => {
    const changed = ctx.db.run(
      `UPDATE media_overlay SET shape_json = ?, label = ?, aliases_json = ?, certainty = ?, note = ?, rev = rev + 1, updated_at = ? WHERE id = ? AND rev = ?`,
      [toJson(next.shape), next.label, toJson(next.aliases), next.certainty, next.note, now, id, req.base_rev],
    );
    if (changed.changes !== 1) throw new AppError('CONFLICT', 'عُدّلت هذه الطبقة في مكان آخر؛ حدّث الصفحة. لم يُحفظ شيء.', 409);
    ctx.audit.record({
      entityType: 'media_overlay',
      entityId: id,
      action: 'update',
      summary: 'تعديل طبقة على صورة',
      before: { shape: fromJson(o.shape_json), label: o.label, certainty: o.certainty, aliases: fromJson(o.aliases_json, []) },
      after: next,
      actor: 'owner',
    });
  });
  return view(getOverlayRow(ctx, id));
}

export function deleteOverlay(ctx: AppContext, id: string): void {
  const o = getOverlayRow(ctx, id);
  const now = ctx.clock.now();
  ctx.db.tx(() => {
    ctx.db.run('UPDATE media_overlay SET deleted_at = ?, rev = rev + 1, updated_at = ? WHERE id = ?', [now, now, id]);
    ctx.audit.record({ entityType: 'media_overlay', entityId: id, action: 'trash', summary: 'إزالة طبقة عن صورة (الصورة الأصلية لم تتغير)', before: { label: o.label, kind: o.kind }, actor: 'owner' });
  });
}
