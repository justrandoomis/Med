// Manual re-anchoring (Round 7 — H3 item 2, spec §25: «إذا فشلت إعادة ربط ملاحظة بثقة، اعرضها في قائمة «تحتاج إعادة ربط»
// مع مكانها السابق؛ لا تحذفها ولا تضعها فوق فقرة عشوائية»).
//
// The list: annotations flagged needs_reanchor by the sync handler (their page is not in that version), notes whose page
// anchor no longer resolves, and notes / annotations on Study Book paragraphs that the re-anchoring report lists as
// needs_reanchor (AC-22). Items the owner chose to keep detached are listed apart («محفوظة دون ربط»).
//
// The decision is the OWNER's, made explicitly in the reader, one note / highlight / ink group at a time:
//  * move — to a page of the same source; with a paragraph / block region of that page the group is placed AT the
//    region (its bounding box's corner on the region's, sizes and relative positions kept, kept inside the page);
//    without one it keeps its place on the page. Notes may also go to a paragraph of the Study Book.
//  * keep_detached — nothing moves; the item leaves «تحتاج إعادة ربط» and stays listed under «محفوظة دون ربط».
// The previous anchor is kept (annotation.previous_anchor_json / note.previous_anchor_json), the revision the device saw
// is checked (an edit elsewhere since → 409, nothing changes), every write touches the sync feed (other devices follow),
// open review-queue items for the item are closed with the decision, and each decision is in the audit log.
import {
  annotationTargetKey,
  richTextToPlain,
  type AnnotationAnchor,
  type AnnotationDTO,
  type NeedsReanchorItem,
  type NeedsReanchorNoteItem,
  type NormBox,
  type NoteDTO,
  type ReanchorResponse,
  type ReanchorTarget,
} from '@medlevo/shared';
import { z } from 'zod';
import type { AppContext } from '../../context';
import { fromJson, toJson } from '../../db/db';
import { AppError } from '../../lib/errors';
import { parseBody } from '../../lib/http';
import type { FastifyRequest } from 'fastify';
import { describeAnchorAr, getAnnotation, getNote, pageAnchorResolves, toAnnotationDTO, toNoteDTO, writeAnnotationTarget, type AnnotationRow, type NoteRow } from './repo';

const ID = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);
export const reanchorBody = z
  .object({
    items: z
      .array(z.object({ kind: z.enum(['annotation', 'note']), id: ID, rev: z.number().int().min(0) }))
      .min(1)
      .max(500),
    action: z.enum(['move', 'keep_detached']),
    target: z
      .discriminatedUnion('type', [
        z.object({ type: z.literal('page'), version_id: ID, page_id: ID, region_id: ID.nullish() }),
        z.object({ type: z.literal('block'), lineage_id: ID, artifact_version: z.number().int().min(1), block_key: z.string().min(1).max(300) }),
      ])
      .optional(),
  })
  .refine((b) => b.action !== 'move' || !!b.target, { message: 'اختر المكان الجديد (target).' });

const NOTE_PAGE_GONE_AR = 'صفحتها لم تعد موجودة في إصدار المصدر الذي كُتبت عليه؛ لم تُنقل إلى صفحة أخرى.';

// ───────── the lists ─────────
export interface ReanchorLists {
  items: NeedsReanchorItem[];
  notes: NeedsReanchorNoteItem[];
  detached: { annotations: NeedsReanchorItem[]; notes: NeedsReanchorNoteItem[] };
}

function annotationItem(ctx: AppContext, r: AnnotationRow): NeedsReanchorItem {
  const dto = toAnnotationDTO(r);
  const where = describeAnchorAr(ctx.db, dto.previous_anchor ?? dto.anchor);
  const srcId = where.sourceId ?? (dto.anchor.type === 'page' ? dto.anchor.source_id : null);
  return { annotation: dto, source_id: srcId, source_title: where.sourceTitle, previous_location_ar: where.text };
}

function noteItem(ctx: AppContext, r: NoteRow, reason: string): NeedsReanchorNoteItem {
  const dto = toNoteDTO(r);
  const where = describeAnchorAr(ctx.db, dto.anchor);
  return { note: dto, source_id: r.source_id ?? where.sourceId, source_title: where.sourceTitle, previous_location_ar: where.text, reason_ar: reason };
}

/** Study Book paragraphs listed `needs_reanchor` in the LATEST report of each lineage (studybook's artifact_reanchor). */
function blockReanchorReasons(ctx: AppContext, kind: 'note' | 'annotation'): Map<string, string> {
  const rows = ctx.db.all<{ target_id: string; status: string; version_no: number; lineage_id: string; artifact_id: string }>(
    `SELECT r.target_id, r.status, a.version_no, a.lineage_id, a.id AS artifact_id
       FROM artifact_reanchor r JOIN artifact a ON a.id = r.artifact_id
      WHERE r.target_kind = ?
      ORDER BY a.version_no`,
    [kind],
  );
  const latest = new Map<string, { status: string; version_no: number; lineage_id: string }>();
  for (const r of rows) latest.set(r.target_id, r); // ordered by version: the last one wins
  const out = new Map<string, string>();
  for (const [id, r] of latest) {
    if (r.status !== 'needs_reanchor') continue;
    out.set(id, `فقرتها في كتاب الدراسة لم تعد هي نفسها في النسخة ${r.version_no}؛ لم تُنقل إلى فقرة أخرى.`);
  }
  return out;
}

/** Does a note's (or a block annotation's) block anchor still point at the paragraph the report checked? */
function blockAnchorStillListed(anchor: AnnotationAnchor | null): boolean {
  return anchor?.type === 'block';
}

export function reanchorLists(ctx: AppContext, sourceId: string | undefined, limit: number): ReanchorLists {
  const out: ReanchorLists = { items: [], notes: [], detached: { annotations: [], notes: [] } };
  const inSource = (id: string | null) => !sourceId || id === sourceId;

  // annotations: flagged by sync (page anchors) + Study Book paragraphs the report lists
  const flagged = ctx.db.all<AnnotationRow>(`SELECT * FROM annotation WHERE anchor_status = 'needs_reanchor' AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 5000`);
  const blockAnn = blockReanchorReasons(ctx, 'annotation');
  const blockRows = blockAnn.size
    ? ctx.db.all<AnnotationRow>(`SELECT * FROM annotation WHERE deleted_at IS NULL AND id IN (${[...blockAnn.keys()].map(() => '?').join(',')})`, [...blockAnn.keys()])
    : [];
  const seen = new Set<string>();
  for (const r of [...flagged, ...blockRows.filter((r) => blockAnchorStillListed(fromJson<AnnotationAnchor>(r.anchor_json)))]) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const item = annotationItem(ctx, r);
    if (!inSource(item.source_id)) continue;
    if (r.detached_at) out.detached.annotations.push(item);
    else if (out.items.length < limit) out.items.push(item);
  }

  // notes: a page anchor whose page is gone from its version, or a Study Book paragraph the report lists
  const pageNotes = ctx.db.all<NoteRow>(`SELECT * FROM note WHERE deleted_at IS NULL AND anchor_target_key LIKE 'source_page:%' ORDER BY updated_at DESC LIMIT 5000`);
  const blockNote = blockReanchorReasons(ctx, 'note');
  const blockNoteRows = blockNote.size
    ? ctx.db.all<NoteRow>(`SELECT * FROM note WHERE deleted_at IS NULL AND id IN (${[...blockNote.keys()].map(() => '?').join(',')})`, [...blockNote.keys()])
    : [];
  const pushNote = (r: NoteRow, reason: string) => {
    const item = noteItem(ctx, r, reason);
    if (!inSource(item.source_id)) return;
    if (r.detached_at) out.detached.notes.push(item);
    else if (out.notes.length < limit) out.notes.push(item);
  };
  for (const r of pageNotes) {
    const anchor = fromJson<AnnotationAnchor | null>(r.anchor_json);
    if (anchor?.type === 'page' && !pageAnchorResolves(ctx.db, anchor)) pushNote(r, NOTE_PAGE_GONE_AR);
  }
  for (const r of blockNoteRows) {
    const anchor = fromJson<AnnotationAnchor | null>(r.anchor_json);
    if (blockAnchorStillListed(anchor)) pushNote(r, blockNote.get(r.id)!);
  }
  return out;
}

// ───────── geometry of an annotation group (page-normalized, unrotated) ─────────
type Pt = [number, number];
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
function boxOf(v: unknown): NormBox | null {
  const b = v as Partial<NormBox> | null;
  const x = num(b?.x);
  const y = num(b?.y);
  const w = num(b?.w);
  const h = num(b?.h);
  return x === null || y === null || w === null || h === null ? null : { x, y, w, h };
}
const ptOf = (v: unknown): Pt | null => (Array.isArray(v) && num(v[0]) !== null && num(v[1]) !== null ? [v[0] as number, v[1] as number] : null);

/** The bounding box of one annotation's drawing (null when it has no page geometry, e.g. a bookmark). */
function bboxOf(kind: string, data: Record<string, unknown>): NormBox | null {
  if (kind === 'ink' || kind === 'highlight' || kind === 'underline') return boxOf(data.bbox);
  if (kind === 'text' || kind === 'image' || kind === 'link') return boxOf(data.box);
  if (kind === 'sticky') {
    const at = ptOf(data.at);
    return at ? { x: at[0], y: at[1], w: 0, h: 0 } : null;
  }
  if (kind === 'shape') {
    const a = ptOf(data.from);
    const b = ptOf(data.to);
    return a && b ? { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(a[0] - b[0]), h: Math.abs(a[1] - b[1]) } : null;
  }
  if (kind === 'text_highlight') {
    const rects = (Array.isArray(data.rects) ? data.rects : []).map(boxOf).filter((r): r is NormBox => !!r);
    if (!rects.length) return null;
    const x0 = Math.min(...rects.map((r) => r.x));
    const y0 = Math.min(...rects.map((r) => r.y));
    return { x: x0, y: y0, w: Math.max(...rects.map((r) => r.x + r.w)) - x0, h: Math.max(...rects.map((r) => r.y + r.h)) - y0 };
  }
  return null;
}

/** coordinates are stored rounded to 1e-5 of the page (as the ink engine writes them) */
const r5 = (v: number) => Math.round(v * 1e5) / 1e5;
const shiftBox = (b: unknown, dx: number, dy: number) => {
  const box = boxOf(b);
  return box ? { ...box, x: r5(box.x + dx), y: r5(box.y + dy) } : b;
};
const shiftPt = (p: unknown, dx: number, dy: number) => {
  const q = ptOf(p);
  return q ? [r5(q[0] + dx), r5(q[1] + dy), ...(p as unknown[]).slice(2)] : p;
};
function shiftInk(d: Record<string, unknown>, dx: number, dy: number): Record<string, unknown> {
  return { ...d, points: Array.isArray(d.points) ? (d.points as unknown[]).map((p) => shiftPt(p, dx, dy)) : d.points, bbox: shiftBox(d.bbox, dx, dy) };
}

/** The same drawing moved by (dx, dy) of the page — every stored coordinate, nothing else. */
function translateData(kind: string, data: Record<string, unknown>, dx: number, dy: number): Record<string, unknown> {
  if (dx === 0 && dy === 0) return data;
  if (kind === 'ink' || kind === 'highlight' || kind === 'underline') return shiftInk(data, dx, dy);
  if (kind === 'text' || kind === 'image' || kind === 'link') return { ...data, box: shiftBox(data.box, dx, dy) };
  if (kind === 'sticky') return { ...data, at: shiftPt(data.at, dx, dy) };
  if (kind === 'shape') {
    const rec = data.recognized_from as Record<string, unknown> | undefined;
    return { ...data, from: shiftPt(data.from, dx, dy), to: shiftPt(data.to, dx, dy), ...(rec ? { recognized_from: shiftInk(rec, dx, dy) } : {}) };
  }
  if (kind === 'text_highlight') return { ...data, rects: Array.isArray(data.rects) ? (data.rects as unknown[]).map((r) => shiftBox(r, dx, dy)) : data.rects };
  return data;
}

// ───────── the decision ─────────
interface Loaded {
  annotations: AnnotationRow[];
  notes: NoteRow[];
}

function load(ctx: AppContext, items: Array<{ kind: 'annotation' | 'note'; id: string; rev: number }>): Loaded {
  const out: Loaded = { annotations: [], notes: [] };
  for (const it of items) {
    const row = it.kind === 'annotation' ? getAnnotation(ctx.db, it.id) : getNote(ctx.db, it.id);
    if (!row || row.deleted_at !== null) throw new AppError('NOT_FOUND', 'أحد العناصر غير موجود على الخادم أو حُذف؛ لم يتغير شيء.', 404, { id: it.id });
    if (row.rev !== it.rev) {
      throw new AppError('CONFLICT', 'تغيّر أحد العناصر على جهاز آخر بعد أن فتحت هذه القائمة؛ لم يتغير شيء. حدّث القائمة ثم أعد الاختيار.', 409, { id: it.id, rev: row.rev });
    }
    if (it.kind === 'annotation') out.annotations.push(row as AnnotationRow);
    else out.notes.push(row as NoteRow);
  }
  return out;
}

/** The source an item belongs to (its anchor, else its previous anchor). */
function sourceOf(anchor: AnnotationAnchor | null, previous: AnnotationAnchor | null): string | null {
  for (const a of [anchor, previous]) if (a?.type === 'page') return a.source_id;
  return null;
}

interface ResolvedTarget {
  anchor: AnnotationAnchor;
  /** where the group goes on the page (a region), null = keep its place */
  region: NormBox | null;
  label_ar: string;
}

function resolveTarget(ctx: AppContext, t: ReanchorTarget, sources: Set<string>): ResolvedTarget {
  if (t.type === 'page') {
    const page = ctx.db.get<{ id: string; version_id: string; page_index: number; source_id: string }>(
      'SELECT p.id, p.version_id, p.page_index, v.source_id FROM source_page p JOIN source_version v ON v.id = p.version_id WHERE p.id = ? AND p.version_id = ?',
      [t.page_id, t.version_id],
    );
    if (!page) throw new AppError('VALIDATION_FAILED', 'الصفحة المختارة غير موجودة في هذا الإصدار.', 400);
    if (sources.size && !sources.has(page.source_id)) {
      throw new AppError('VALIDATION_FAILED', 'تُعاد الملاحظات والكتابة إلى صفحة من مصدرها نفسه فقط؛ الصفحة المختارة من مصدر آخر.', 400);
    }
    let region: NormBox | null = null;
    if (t.region_id) {
      const r = ctx.db.get<{ bbox_json: string | null; page_id: string | null; status: string }>('SELECT bbox_json, page_id, status FROM source_region WHERE id = ?', [t.region_id]);
      if (!r || r.page_id !== page.id || r.status === 'rejected') throw new AppError('VALIDATION_FAILED', 'الفقرة المختارة ليست على الصفحة المختارة.', 400);
      region = boxOf(fromJson(r.bbox_json));
    }
    const anchor: AnnotationAnchor = { type: 'page', source_id: page.source_id, version_id: page.version_id, page_id: page.id, page_index: page.page_index, space: 'page_norm' };
    return { anchor, region, label_ar: describeAnchorAr(ctx.db, anchor).text ?? 'الصفحة المختارة' };
  }
  const block = ctx.db.get<{ content_json: string; primary_source_id: string | null }>(
    `SELECT cb.content_json, a.primary_source_id FROM content_block cb JOIN artifact a ON a.id = cb.artifact_id
      WHERE a.lineage_id = ? AND a.version_no = ? AND cb.block_key = ? LIMIT 1`,
    [t.lineage_id, t.artifact_version, t.block_key],
  );
  if (!block) throw new AppError('VALIDATION_FAILED', 'الفقرة المختارة غير موجودة في هذه النسخة من كتاب الدراسة.', 400);
  if (sources.size && block.primary_source_id && !sources.has(block.primary_source_id)) {
    throw new AppError('VALIDATION_FAILED', 'الفقرة المختارة من كتاب دراسة لمصدر آخر.', 400);
  }
  let text = '';
  try {
    text = richTextToPlain(fromJson(block.content_json) as Parameters<typeof richTextToPlain>[0]).replace(/\s+/g, ' ').trim();
  } catch {
    text = '';
  }
  const anchor: AnnotationAnchor = { type: 'block', lineage_id: t.lineage_id, artifact_version: t.artifact_version, block_key: t.block_key, ...(text ? { quote: { exact: text.slice(0, 300) } } : {}) };
  return { anchor, region: null, label_ar: text ? `فقرة في كتاب الدراسة: «${text.slice(0, 60)}»` : 'فقرة في كتاب الدراسة' };
}

export function reanchor(ctx: AppContext, req: FastifyRequest): ReanchorResponse {
  const body = parseBody(reanchorBody, req);
  return ctx.db.tx(() => {
    const items = load(ctx, body.items);
    const now = ctx.clock.now();
    const annOut: AnnotationDTO[] = [];
    const noteOut: NoteDTO[] = [];
    const count = items.annotations.length + items.notes.length;
    const what = items.notes.length && !items.annotations.length ? (count === 1 ? 'الملاحظة' : 'الملاحظات') : count === 1 ? 'العنصر' : `${count} عناصر`;

    if (body.action === 'keep_detached') {
      for (const r of items.annotations) {
        ctx.db.run('UPDATE annotation SET detached_at = ?, rev = rev + 1, updated_at = ? WHERE id = ?', [now, now, r.id]);
        ctx.sync.touch('annotation', r.id);
        const after = toAnnotationDTO(getAnnotation(ctx.db, r.id)!);
        ctx.audit.record({ entityType: 'annotation', entityId: r.id, action: 'reanchor_keep_detached', summary: 'أبقى المالك هذه الكتابة دون ربط بموضع جديد (لم يُحذف شيء ولم يُنقل).', before: { anchor: fromJson(r.anchor_json), anchor_status: r.anchor_status }, after: { anchor: after.anchor, detached_at: now } });
        annOut.push(after);
      }
      for (const r of items.notes) {
        ctx.db.run('UPDATE note SET detached_at = ?, rev = rev + 1, updated_at = ? WHERE id = ?', [now, now, r.id]);
        ctx.sync.touch('note', r.id);
        const after = toNoteDTO(getNote(ctx.db, r.id)!);
        ctx.audit.record({ entityType: 'note', entityId: r.id, action: 'reanchor_keep_detached', summary: 'أبقى المالك هذه الملاحظة دون ربط بموضع جديد (لم يُحذف شيء ولم يُنقل).', before: { anchor: fromJson(r.anchor_json) }, after: { anchor: after.anchor, detached_at: now } });
        noteOut.push(after);
      }
      closeQueueItems(ctx, body.items, now, 'أُبقيت دون ربط بقرار المالك من مساحة الدراسة.', 'dismissed');
      return { annotations: annOut, notes: noteOut, summary_ar: `أُبقي ${what} دون ربط. ${count === 1 ? 'يبقى' : 'تبقى'} محفوظًا في «محفوظة دون ربط»، ويمكن ربطه لاحقًا.` };
    }

    // move
    const sources = new Set<string>();
    for (const r of items.annotations) {
      const s = sourceOf(fromJson<AnnotationAnchor>(r.anchor_json), fromJson<AnnotationAnchor | null>(r.previous_anchor_json));
      if (s) sources.add(s);
    }
    for (const r of items.notes) {
      const s = r.source_id ?? sourceOf(fromJson<AnnotationAnchor | null>(r.anchor_json), fromJson<AnnotationAnchor | null>(r.previous_anchor_json ?? null));
      if (s) sources.add(s);
    }
    const target = resolveTarget(ctx, body.target!, sources);
    if (target.anchor.type === 'block' && items.annotations.some((r) => r.kind !== 'text_highlight' && r.kind !== 'bookmark')) {
      throw new AppError('VALIDATION_FAILED', 'الكتابة بالقلم تُعاد إلى صفحة (أو فقرة على صفحة)، لا إلى فقرة في كتاب الدراسة.', 400);
    }

    // the group keeps its shape: its bounding box's corner goes to the region's corner, kept inside the page
    let dx = 0;
    let dy = 0;
    if (target.region) {
      const boxes = items.annotations.map((r) => bboxOf(r.kind, fromJson<Record<string, unknown>>(r.data_json) ?? {})).filter((b): b is NormBox => !!b);
      if (boxes.length) {
        const gx = Math.min(...boxes.map((b) => b.x));
        const gy = Math.min(...boxes.map((b) => b.y));
        const gw = Math.max(...boxes.map((b) => b.x + b.w)) - gx;
        const gh = Math.max(...boxes.map((b) => b.y + b.h)) - gy;
        const nx = Math.min(Math.max(0, target.region.x), Math.max(0, 1 - gw));
        const ny = Math.min(Math.max(0, target.region.y), Math.max(0, 1 - gh));
        dx = Math.round((nx - gx) * 1e5) / 1e5;
        dy = Math.round((ny - gy) * 1e5) / 1e5;
      }
    }
    for (const r of items.annotations) {
      const before = fromJson<AnnotationAnchor>(r.anchor_json)!;
      const data = translateData(r.kind, fromJson<Record<string, unknown>>(r.data_json) ?? {}, dx, dy);
      const resolved = pageAnchorResolves(ctx.db, target.anchor);
      ctx.db.run(
        `UPDATE annotation SET anchor_json = ?, data_json = ?, anchor_status = ?, previous_anchor_json = ?, detached_at = NULL, rev = rev + 1, updated_at = ? WHERE id = ?`,
        [toJson(target.anchor), toJson(data), resolved ? 'reanchored' : 'needs_reanchor', toJson(before), now, r.id],
      );
      writeAnnotationTarget(ctx.db, r.id, target.anchor);
      ctx.sync.touch('annotation', r.id);
      const after = toAnnotationDTO(getAnnotation(ctx.db, r.id)!);
      ctx.audit.record({
        entityType: 'annotation',
        entityId: r.id,
        action: 'reanchor',
        summary: `أعاد المالك ربط هذه الكتابة: من «${describeAnchorAr(ctx.db, before).text ?? 'مكان سابق'}» إلى «${target.label_ar}»${target.region ? ' (عند الفقرة المختارة)' : ''}.`,
        before: { anchor: before, anchor_status: r.anchor_status },
        after: { anchor: after.anchor, anchor_status: after.anchor_status, moved_by: { dx, dy } },
      });
      annOut.push(after);
    }
    for (const r of items.notes) {
      const before = fromJson<AnnotationAnchor | null>(r.anchor_json);
      const sourceId = target.anchor.type === 'page' ? target.anchor.source_id : (r.source_id ?? null);
      ctx.db.run(
        `UPDATE note SET anchor_json = ?, anchor_target_key = ?, source_id = ?, previous_anchor_json = ?, detached_at = NULL, rev = rev + 1, updated_at = ? WHERE id = ?`,
        [toJson(target.anchor), annotationTargetKey(target.anchor), sourceId, before ? toJson(before) : (r.previous_anchor_json ?? null), now, r.id],
      );
      ctx.sync.touch('note', r.id);
      const after = toNoteDTO(getNote(ctx.db, r.id)!);
      ctx.audit.record({
        entityType: 'note',
        entityId: r.id,
        action: 'reanchor',
        summary: `أعاد المالك ربط هذه الملاحظة: من «${describeAnchorAr(ctx.db, before).text ?? 'مكان سابق'}» إلى «${target.label_ar}».`,
        before: { anchor: before },
        after: { anchor: after.anchor },
      });
      noteOut.push(after);
    }
    closeQueueItems(ctx, body.items, now, `أعاد المالك ربطها إلى «${target.label_ar}» من مساحة الدراسة.`, 'corrected');
    return { annotations: annOut, notes: noteOut, summary_ar: `أُعيد ربط ${what} إلى «${target.label_ar}»${target.region ? ' عند الفقرة المختارة' : ''}. المكان السابق محفوظ في سجل التغييرات.` };
  });
}

/** Open «تحتاج إعادة ربط» items of the control center for these entities are closed with the owner's decision. */
function closeQueueItems(ctx: AppContext, items: Array<{ kind: 'annotation' | 'note'; id: string }>, now: number, reason: string, status: 'corrected' | 'dismissed'): void {
  for (const it of items) {
    ctx.db.run(
      `UPDATE review_queue_item SET status = ?, resolved_at = ?, resolution_json = ?
        WHERE kind = 'needs_reanchor' AND entity_type = ? AND entity_id = ? AND status = 'open'`,
      [status, now, toJson({ by: 'owner', reason_ar: reason }), it.kind, it.id],
    );
  }
}
