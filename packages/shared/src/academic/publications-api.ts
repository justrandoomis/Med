// Academic OS — course-only explanations published in a subject's space: publish, republish, withdraw, read a version,
// the diff between versions, and the per-lecture list (ARCHITECTURE_DELTA §7.6, §6.4, §4.1 `2150_publications`, §4.4
// `3050_publications`; ADR-0004 §2.4; PRD AOS-2.8 and 5.27 Phase 1 parts, 5.12 course-only, 5.18 Phase 1 part, 5.24,
// 4.14, 19I.3, 21.16, 21.44). Track P1-T5, wave-2 step 0: types and zod schemas only.
//
// * A publication is an immutable snapshot of the author's layer(s) with a version number; version n is the set of
//   items valid at n, stored as deltas with STABLE item ids, so a follower's references to unchanged items survive.
// * Phase 1: visibility `course` only, kind `explanation` only. Public / followers / specific users, voice
//   explanations, series, ratings, likes and suggestions are Phase 2+ and are refused by these schemas.
// * Student content is never evidence: it is labelled «شرح طالب — ليس مصدرًا» everywhere.
// * Reads by anyone without access to the lecture are redacted (§5.2): no page quotes, no crops of the official page.
//   In Phase 1 a reader is always a member of the subject (course-only), so gate 2 asks for membership.
//
// STABLE CONTRACT: fields and enum members are only ever ADDED (P1-T5 owns this file).
import { z } from 'zod';
import type { AnnotationDTO, NoteDTO, NotePageDTO } from '../annotations';
import type { CursorPage, NodeRef } from './channels-api';
import { cursorPageQuerySchema, entityIdSchema, plainTextSchema } from './channels-api';
import type { CopyMode } from './copies-api';
import type { ReanchorPageRef } from './layers';
import { itemsCountAr, pagesCountAr } from './layers';
import type { PublicationVisibility, UserRef } from './visibility';

export const STUDENT_EXPLANATION_LABEL_AR = 'شرح طالب — ليس مصدرًا';
/** What followers and the author read while a moderator hides a publication (they keep what they had). */
export function hiddenByModeratorAr(reasonAr: string): string {
  return `أخفى المشرف هذا الشرح: ${reasonAr}`;
}
/** P1-T5 step 3 (additive): a sentence that ends once — «…الصفحة 1.» stays, «…اسم مريض» gets its full stop. */
export function endSentenceAr(text: string): string {
  const t = text.trimEnd();
  return /[.!?؟…]$/.test(t) ? t : `${t}.`;
}

export const PUBLICATION_KINDS = ['explanation', 'voice_explanation', 'crowd_notes'] as const;
export type PublicationKind = (typeof PUBLICATION_KINDS)[number];
/** Phase 1 publishes written explanations only. */
export const PUBLISH_KINDS_PHASE1 = ['explanation'] as const satisfies readonly PublicationKind[];
/** Phase 1 publishes course-only (PRD AOS-5.12; public ones need moderator approval in Phase 2 — PRD Q6). */
export const PUBLISH_VISIBILITIES_PHASE1 = ['course'] as const satisfies readonly PublicationVisibility[];

export const PUBLICATION_STATUSES = ['active', 'hidden_by_moderator', 'withdrawn', 'author_deleted'] as const;
export type PublicationStatus = (typeof PUBLICATION_STATUSES)[number];
export const publicationStatusSchema = z.enum(PUBLICATION_STATUSES);
export const PUBLICATION_STATUS_LABELS_AR: Record<PublicationStatus, string> = {
  active: 'منشور',
  hidden_by_moderator: 'أخفاه المشرف',
  withdrawn: 'سحبه صاحبه',
  author_deleted: 'حذف صاحبه حسابه',
};

/** at most this many layers in one publication (Phase 1: the author's explanation layer, maybe split in a few) */
export const PUBLICATION_MAX_LAYERS = 5;

const layerIds = z
  .array(entityIdSchema)
  .min(1, 'اختر طبقة واحدة على الأقل لنشرها.')
  .max(PUBLICATION_MAX_LAYERS)
  .refine((ids) => new Set(ids).size === ids.length, 'تكررت طبقة في الطلب نفسه.');
const notePageIds = z.array(entityIdSchema).max(500);
const publicationTitle = plainTextSchema({ max: 120, field_ar: 'عنوان الشرح' });
const publicationSummary = plainTextSchema({ min: 0, max: 1000, field_ar: 'الملخص', multiline: true });
const changeNote = plainTextSchema({ min: 0, max: 1000, field_ar: 'ملاحظة التغيير', multiline: true });

/**
 * POST /api/spaces/:s/publications (`Idempotency-Key`; a job copies the author's vault items; preset `publish`). Every
 * item must sit on an official version page of the lecture (or on the author's note pages inserted into it).
 */
export const publishRequestSchema = z
  .object({
    lecture_id: entityIdSchema,
    layer_ids: layerIds,
    note_page_ids: notePageIds.optional(),
    title: publicationTitle,
    summary: publicationSummary.nullable().optional(),
    kind: z.enum(PUBLISH_KINDS_PHASE1),
    visibility: z.enum(PUBLISH_VISIBILITIES_PHASE1),
  })
  .strict();
export type PublishRequest = z.infer<typeof publishRequestSchema>;

/** POST /api/spaces/:s/publications/:id/versions — the author republishes; the same content as the head is a no-op. */
export const republishSchema = z
  .object({
    layer_ids: layerIds,
    note_page_ids: notePageIds.optional(),
    change_note: changeNote.nullable(),
  })
  .strict();
export type RepublishRequest = z.infer<typeof republishSchema>;

/** PATCH /api/spaces/:s/publications/:id — the author; a published VERSION never changes (PUBLICATION_FROZEN). */
export const patchPublicationSchema = z
  .object({ title: publicationTitle.optional(), summary: publicationSummary.nullable().optional() })
  .strict()
  .refine((p) => Object.keys(p).length > 0, 'لا يوجد ما يُغيَّر.');
export type PatchPublicationRequest = z.infer<typeof patchPublicationSchema>;

/** POST /api/spaces/:s/publications/:id/withdraw — forks keep their copies; followed copies stop updating and say why. */
export const withdrawPublicationSchema = z.object({}).strict();

export interface PublicationVersionView {
  no: number;
  created_at: number;
  change_note: string | null;
  /** the official version the explanation was written on («الشرح مبني على الإصدار 1») */
  lecture_version_id: string;
  lecture_version_no: number;
  item_count: number;
}

/** GET /api/spaces/:s/publications/:id */
export interface PublicationView {
  id: string;
  space_id: string;
  lecture: { id: string; title: string };
  subject: NodeRef;
  /** rendered now from the system account («طالب سابق» after deletion) */
  author: UserRef;
  kind: PublicationKind;
  title: string;
  summary: string | null;
  visibility: PublicationVisibility;
  status: PublicationStatus;
  /** shown to the author and to holders of a copy while hidden: the moderator's Arabic reason */
  hidden: { reason_ar: string; at: number } | null;
  head_version_no: number;
  versions: PublicationVersionView[];
  /** pages with explanation content out of the lecture version's pages — numbers, never a bare percentage */
  completeness: { pages_covered: number; pages_total: number };
  origin_label_ar: typeof STUDENT_EXPLANATION_LABEL_AR;
  viewer: {
    /** the viewer's own fork / follow of it (system `publication_copy`), null when none */
    copy: CopyMode | null;
    /** the viewer is the author */
    can_edit: boolean;
    /**
     * P1-T5 step 3 (additive): the author's own vault layers the head was taken from — sent to the author only, so
     * «انشر إصدارًا جديدًا» republishes the same layers; null for everybody else.
     */
    source_layer_ids?: string[] | null;
    /** P1-T5 step 3 (additive): the viewer may report it (a member who is not the author, while it is visible) */
    can_report?: boolean;
  };
  /**
   * P1-T5 step 3 (additive): what the head snapshot left out and why (pictures, bookmarks, links, items on inserted
   * note pages …) — counts only, shown to the author; null for everybody else.
   */
  snapshot?: { items: number; skipped: Array<{ reason_ar: string; items: number }> } | null;
  published_at: number;
  updated_at: number;
}

/** «ص 3 من 40» — completeness as numbers, never a bare percentage. */
export function completenessAr(c: { pages_covered: number; pages_total: number }): string {
  return `ص ${c.pages_covered} من ${c.pages_total}`;
}

/** «أضاف 6 عناصر في صفحة واحدة، حذف 1، عدّل 1» (PRD Scenario 2; «لا تغييرات» when nothing changed). */
export function upstreamSummaryAr(counts: { added: number; removed: number; changed: number }, pagesWithAdditions: number): string {
  const parts: string[] = [];
  // the object of «أضاف» is accusative: «عنصرًا واحدًا», «عنصرين», «6 عناصر», «41 عنصرًا»
  const added = counts.added === 1 ? 'عنصرًا واحدًا' : counts.added === 2 ? 'عنصرين' : itemsCountAr(counts.added);
  if (counts.added > 0) parts.push(`أضاف ${added} في ${pagesCountAr(Math.max(1, pagesWithAdditions))}`);
  if (counts.removed > 0) parts.push(`حذف ${counts.removed}`);
  if (counts.changed > 0) parts.push(`عدّل ${counts.changed}`);
  return parts.length ? parts.join('، ') : 'لا تغييرات';
}

/** Kinds of the author's items a Phase 1 snapshot carries (pictures, bookmarks and links stay in the author's vault). */
export const PUBLISHABLE_ANNOTATION_KINDS = ['ink', 'highlight', 'underline', 'shape', 'text', 'sticky', 'text_highlight'] as const;

/** One row of the per-lecture list «الشروحات» (Phase 1: newest first; Phase 2 adds the marketplace sorts). */
export interface PublicationCard {
  id: string;
  title: string;
  author: UserRef;
  kind: PublicationKind;
  head_version_no: number;
  completeness: { pages_covered: number; pages_total: number };
  label_ar: typeof STUDENT_EXPLANATION_LABEL_AR;
  updated_at: number;
}
/** GET /api/spaces/:s/lectures/:id/publications — only publications the viewer may see, filtered before paginating. */
export const lecturePublicationsQuerySchema = cursorPageQuerySchema.strict();
export type LecturePublicationsResponse = CursorPage<PublicationCard>;

/** GET /api/spaces/:s/publications/:id/versions/:n/items?page_id= (ink v2 for clients sending `accept-ink: 2`) */
export const publicationItemsQuerySchema = z.object({ page_id: entityIdSchema.optional() });
export interface PublicationItemsResponse {
  publication_id: string;
  version_no: number;
  items: AnnotationDTO[];
  notes: NoteDTO[];
  note_pages: NotePageDTO[];
  /** true when quotes and crops of the official page were withheld (a viewer without access to the lecture) */
  redacted: boolean;
}

/** GET /api/spaces/:s/publications/:id/diff?from=&to= (also GET /api/copies/:id/upstream) */
export const publicationDiffQuerySchema = z
  .object({ from: z.coerce.number().int().min(1), to: z.coerce.number().int().min(1) })
  .refine((q) => q.from !== q.to, { message: 'اختر إصدارين مختلفين.', path: ['to'] });

/**
 * What an update of a followed explanation would change — «أضاف 6 عناصر في صفحة واحدة، حذف 1، عدّل 1» — with the
 * changed pages. It concerns the FOLLOWED layer only: `personal_items_affected` is 0 by construction and is shown so
 * the user sees the guarantee.
 */
export interface UpstreamPreview {
  publication_id: string;
  from_version_no: number;
  to_version_no: number;
  change_note: string | null;
  counts: { added: number; removed: number; changed: number };
  pages: Array<{ page: ReanchorPageRef; added: number; removed: number; changed: number }>;
  personal_items_affected: 0;
  summary_ar: string;
}
