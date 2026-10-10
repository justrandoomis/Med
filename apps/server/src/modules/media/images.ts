// Medical Image Explorer (§32): the images the owner's sources contain (image_asset rows written by processing),
// filtered by kind / origin / source / topic, each with its caption, page and an ORIGIN BADGE that keeps a photo from
// a source, an educational drawing from a source, a diagram the system re-organized and a generated illustration
// clearly apart (a generated image is never presented as a real radiograph or a documented case).
// The owner's classification (kind, modality, region, age group, topic) lives in image_meta and is labelled.
// No section is filled with unknown images: kinds are counted from the images that exist.
import {
  AGE_GROUP_LABELS_AR,
  IMAGE_KIND_LABELS_AR,
  IMAGE_KINDS,
  IMAGE_ORIGIN_BADGE_LABELS_AR,
  imageMetaPatchSchema,
  pageDisplayLabel,
  type AgeGroup,
  type ImageDetailView,
  type ImageKind,
  type ImageListResponse,
  type ImageOriginBadge,
  type ImageSummaryView,
} from '@medlevo/shared';
import { z } from 'zod';
import type { AppContext } from '../../context';
import { AppError } from '../../lib/errors';
import { parseWith } from '../../lib/http';
import { overlaysOf, quizEligibility } from './overlays';

export interface ImageRow {
  id: string;
  file_id: string | null;
  source_id: string | null;
  version_id: string | null;
  page_id: string | null;
  region_id: string | null;
  caption_region_id: string | null;
  origin: 'source' | 'external' | 'generated' | 'reorganized';
  image_kind: ImageKind;
  modality: string | null;
  anatomic_region: string | null;
  title: string | null;
  caption: string | null;
  original_url: string | null;
  match_status: 'unverified' | 'matches' | 'mismatch' | 'owner_confirmed';
  created_at: number;
  // image_meta (owner)
  m_kind: ImageKind | null;
  m_title: string | null;
  m_modality: string | null;
  m_region: string | null;
  m_age: AgeGroup | null;
  m_topic: string | null;
  m_note: string | null;
  // joins
  s_title: string | null;
  s_type: string | null;
  s_deleted: number | null;
  p_index: number | null;
  p_label: string | null;
  p_kind: string | null;
}

const SELECT = `SELECT i.*, m.image_kind AS m_kind, m.title AS m_title, m.modality AS m_modality, m.anatomic_region AS m_region, m.age_group AS m_age,
    m.topic_id AS m_topic, m.note AS m_note, s.title AS s_title, s.source_type AS s_type, s.deleted_at AS s_deleted,
    p.page_index AS p_index, p.printed_label AS p_label, p.kind AS p_kind
  FROM image_asset i
  LEFT JOIN image_meta m ON m.image_id = i.id
  LEFT JOIN source s ON s.id = i.source_id
  LEFT JOIN source_page p ON p.id = i.page_id`;

/** Visible = has a file and its source is not in the trash. */
const VISIBLE = `i.file_id IS NOT NULL AND (i.source_id IS NULL OR s.deleted_at IS NULL)`;
const EFFECTIVE_KIND = `COALESCE(m.image_kind, i.image_kind)`;

const PHOTO_KINDS = new Set<ImageKind>(['clinical_photo', 'radiology', 'histology', 'pathology', 'ecg', 'dermatology', 'ophthalmology']);
const DRAWING_KINDS = new Set<ImageKind>(['educational_drawing', 'diagram', 'table_image']);

export function originBadge(origin: ImageRow['origin'], kind: ImageKind): { badge: ImageOriginBadge; note_ar: string | null } {
  if (origin === 'generated' || kind === 'generated_illustration') return { badge: 'generated', note_ar: 'صورة توضيحية مولّدة: ليست صورة أشعة حقيقية ولا حالة موثقة.' };
  if (origin === 'reorganized' || kind === 'reorganized_diagram') return { badge: 'reorganized', note_ar: 'إعادة تنظيم لمحتوى المصدر، وليست الشكل الأصلي كما في المصدر.' };
  if (origin === 'external') return { badge: 'external', note_ar: 'من مصدر خارجي؛ تحقق من مطابقتها للتعليق قبل الاعتماد عليها.' };
  if (PHOTO_KINDS.has(kind)) return { badge: 'source_photo', note_ar: null };
  if (DRAWING_KINDS.has(kind)) return { badge: 'source_drawing', note_ar: null };
  return { badge: 'source_unknown', note_ar: 'لم يُحدَّد إن كانت صورة حقيقية أو رسمًا تعليميًا؛ صنّفها إن كنت تعرف نوعها.' };
}

export function summary(ctx: AppContext, r: ImageRow): ImageSummaryView {
  const kind = (r.m_kind ?? r.image_kind) as ImageKind;
  const b = originBadge(r.origin, kind);
  const overlays = overlaysOf(ctx, r.id);
  const topic = r.m_topic ? ctx.db.get<{ id: string; title: string; title_ar: string | null }>('SELECT id, title, title_ar FROM topic WHERE id = ?', [r.m_topic]) : null;
  return {
    id: r.id,
    file_url: r.file_id ? `/api/files/${r.file_id}` : null,
    origin: r.origin,
    origin_badge: b.badge,
    origin_label_ar: IMAGE_ORIGIN_BADGE_LABELS_AR[b.badge],
    origin_note_ar: b.note_ar,
    image_kind: kind,
    image_kind_label_ar: IMAGE_KIND_LABELS_AR[kind] ?? IMAGE_KIND_LABELS_AR.unknown,
    kind_origin: r.m_kind ? 'owner' : 'processing',
    title: r.m_title ?? r.title,
    caption: r.caption,
    source: r.source_id ? { id: r.source_id, title: r.s_title ?? '', source_type: r.s_type ?? '', deleted: r.s_deleted !== null } : null,
    page:
      r.page_id && r.p_index !== null
        ? { id: r.page_id, page_index: r.p_index, label_ar: pageDisplayLabel({ page_index: r.p_index, printed_label: r.p_label, kind: (r.p_kind ?? 'page') as never }) }
        : null,
    version_id: r.version_id,
    region_id: r.region_id,
    modality: r.m_modality ?? r.modality,
    anatomic_region: r.m_region ?? r.anatomic_region,
    age_group: r.m_age,
    topic: topic ? { id: topic.id, title: topic.title_ar ?? topic.title } : null,
    overlay_count: overlays.length,
    quiz_ready_masks: overlays.filter((o) => quizEligibility(o).eligible).length,
    created_at: r.created_at,
  };
}

export function getImageRow(ctx: AppContext, id: string): ImageRow {
  const r = ctx.db.get<ImageRow>(`${SELECT} WHERE i.id = ? AND ${VISIBLE}`, [id]);
  if (!r) throw new AppError('NOT_FOUND', 'الصورة غير موجودة أو مصدرها في سلة المحذوفات.', 404);
  return r;
}

export const imageListQuery = z
  .object({
    kind: z.enum(IMAGE_KINDS).optional(),
    origin: z.enum(['source', 'external', 'generated', 'reorganized']).optional(),
    source_id: z.string().trim().min(1).max(64).optional(),
    topic_id: z.string().trim().min(1).max(64).optional(),
    q: z.string().trim().max(200).optional(),
    cursor: z.coerce.number().int().min(0).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(60),
  })
  .strict();

export function listImages(ctx: AppContext, q: z.output<typeof imageListQuery>): ImageListResponse {
  const where: string[] = [VISIBLE];
  const params: unknown[] = [];
  if (q.kind) {
    where.push(`${EFFECTIVE_KIND} = ?`);
    params.push(q.kind);
  }
  if (q.origin) {
    where.push('i.origin = ?');
    params.push(q.origin);
  }
  if (q.source_id) {
    where.push('i.source_id = ?');
    params.push(q.source_id);
  }
  if (q.topic_id) {
    where.push(`(m.topic_id = ? OR EXISTS (SELECT 1 FROM topic_link tl WHERE tl.entity_type = 'image_asset' AND tl.entity_id = i.id AND tl.topic_id = ? AND tl.status <> 'rejected'))`);
    params.push(q.topic_id, q.topic_id);
  }
  if (q.q) {
    where.push(`(COALESCE(i.caption,'') LIKE ? ESCAPE '\\' OR COALESCE(m.title, i.title, '') LIKE ? ESCAPE '\\' OR COALESCE(s.title,'') LIKE ? ESCAPE '\\')`);
    const like = `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    params.push(like, like, like);
  }
  const offset = q.cursor ?? 0;
  const rows = ctx.db.all<ImageRow>(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY s.title, p.page_index, i.created_at, i.id LIMIT ? OFFSET ?`, [...params, q.limit + 1, offset]);
  const kinds = ctx.db
    .all<{ kind: ImageKind; n: number }>(
      `SELECT ${EFFECTIVE_KIND} AS kind, COUNT(*) AS n FROM image_asset i LEFT JOIN image_meta m ON m.image_id = i.id LEFT JOIN source s ON s.id = i.source_id WHERE ${VISIBLE} GROUP BY kind ORDER BY n DESC`,
    )
    .map((k) => ({ kind: k.kind, label_ar: IMAGE_KIND_LABELS_AR[k.kind] ?? k.kind, count: k.n }));
  const notes: string[] = [];
  const total = kinds.reduce((a, k) => a + k.count, 0);
  if (total === 0) notes.push('لا توجد صور مستخرجة من مصادرك بعد. تُستخرج الصور والأشكال تلقائيًا عند معالجة ملفات PDF وPPTX وDOCX والصور.');
  const unknown = kinds.find((k) => k.kind === 'unknown')?.count ?? 0;
  if (unknown) notes.push(`${unknown} من الصور غير مصنّفة: لا يُخمَّن نوعها؛ يمكنك تصنيفها من صفحة الصورة.`);
  return { images: rows.slice(0, q.limit).map((r) => summary(ctx, r)), kinds, next_cursor: rows.length > q.limit ? String(offset + q.limit) : null, notes_ar: notes };
}

export function imageDetail(ctx: AppContext, id: string): ImageDetailView {
  const r = getImageRow(ctx, id);
  const s = summary(ctx, r);
  const notes: string[] = [];
  if (s.origin_note_ar) notes.push(s.origin_note_ar);
  if (!r.caption) notes.push('لا يوجد تعليق من المصدر لهذه الصورة؛ أي تسمية عليها يجب أن تكون مؤكدة بصريًا أو من تحديدك.');
  notes.push('الطبقات (تظليل، أسهم، أقنعة) غير مدمّرة: الصورة الأصلية لا تتغير، ويمكن إزالة أي طبقة.');
  return { ...s, overlays: overlaysOf(ctx, id, { includeDeleted: false }), caption_region_id: r.caption_region_id, match_status: r.match_status, notes_ar: notes };
}

export function patchImageMeta(ctx: AppContext, id: string, body: unknown): ImageDetailView {
  const req = parseWith(imageMetaPatchSchema, body, 'body');
  const r = getImageRow(ctx, id);
  if (req.topic_id) {
    if (!ctx.db.get('SELECT 1 AS x FROM topic WHERE id = ?', [req.topic_id])) throw new AppError('NOT_FOUND', 'الموضوع غير موجود.', 404);
  }
  const now = ctx.clock.now();
  const before = { image_kind: r.m_kind, title: r.m_title, modality: r.m_modality, anatomic_region: r.m_region, age_group: r.m_age, topic_id: r.m_topic, note: r.m_note };
  const next = { ...before };
  for (const k of Object.keys(req) as Array<keyof typeof req>) {
    const v = req[k];
    if (v !== undefined) (next as Record<string, unknown>)[k] = v === '' ? null : v;
  }
  ctx.db.tx(() => {
    ctx.db.run(
      `INSERT INTO image_meta (image_id, image_kind, title, modality, anatomic_region, age_group, topic_id, note, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(image_id) DO UPDATE SET image_kind = excluded.image_kind, title = excluded.title, modality = excluded.modality,
         anatomic_region = excluded.anatomic_region, age_group = excluded.age_group, topic_id = excluded.topic_id, note = excluded.note, updated_at = excluded.updated_at`,
      [r.id, next.image_kind, next.title, next.modality, next.anatomic_region, next.age_group, next.topic_id, next.note, now],
    );
    ctx.audit.record({ entityType: 'image_asset', entityId: r.id, action: 'update', summary: 'تعديل تصنيف صورة (من المالك)', before, after: next, actor: 'owner' });
  });
  return imageDetail(ctx, id);
}

export function ageLabel(a: AgeGroup | null): string | null {
  return a ? AGE_GROUP_LABELS_AR[a] : null;
}

/** All visible images (for the AC-09 matcher). */
export function allImageRows(ctx: AppContext, limit = 2000): ImageRow[] {
  return ctx.db.all<ImageRow>(`${SELECT} WHERE ${VISIBLE} ORDER BY i.created_at, i.id LIMIT ?`, [limit]);
}
