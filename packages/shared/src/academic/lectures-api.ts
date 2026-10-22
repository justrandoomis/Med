// Academic OS — official lectures in a subject's space: drafts, approval, versions, corrections, withdrawal and rights
// takedown, «انشر كمحاضرة رسمية», the subject's attachments, exam dates and updates feed, the official offline package
// (ARCHITECTURE_DELTA §7.4, §4.4 `3000_official_lectures` / `3010_subject_content`, §6.7, §6.9; PRD AOS-2.2, 2.3, 2.5,
// 2.9, 3.1, 4.5, 18.3, 18.4, 18.9, 18.10, 19H.1, 19H.4, 21.7, 21.8). Track P1-T5, wave-2 step 0: types and zod only.
//
// Every route is `/api/spaces/:spaceId/…` and binds the subject's space only for a viewer with the route's minimum
// access in THAT subject (gate 2, apps/server/src/modules/authz/spaceRoutes.ts); a non-member gets the body of a
// missing route. Published official versions are IMMUTABLE: a correction of one creates a new official version that
// goes through the page map and the one-tap note copy of Scenario 4 (copy, never move). Reused, not redefined:
//  * the version compare screen returns P1-T3's `VersionCompareResponse` (academic/versions.ts) for two versions of
//    the lecture; page-map decisions use P1-T3's `PageMapDecisionRequest` items;
//  * the official offline package is today's `OfflineManifestResponse` (data-api.ts) plus the space and lecture ids.
//
// STABLE CONTRACT: fields and enum members are only ever ADDED (P1-T5 owns this file).
import { z } from 'zod';
import type { OfflineManifestResponse } from '../data-api';
import type { CursorPage, GroupCount, NodeRef } from './channels-api';
import { cursorPageQuerySchema, entityIdSchema, isoDateSchema, plainTextSchema } from './channels-api';
import type { PageChangeKind } from './versions';
import type { UserRef } from './visibility';

/** The badge of official content (always text + icon, never colour alone). */
export const OFFICIAL_BADGE_AR = 'رسمي';

export const OFFICIAL_LECTURE_STATUSES = ['draft', 'in_review', 'published', 'withdrawn'] as const;
export type OfficialLectureStatus = (typeof OFFICIAL_LECTURE_STATUSES)[number];
export const OFFICIAL_LECTURE_STATUS_LABELS_AR: Record<OfficialLectureStatus, string> = {
  draft: 'مسودة',
  in_review: 'بانتظار موافقة المشرف',
  published: 'منشورة',
  withdrawn: 'مسحوبة',
};

export const LECTURE_WITHDRAW_REASONS = ['replaced', 'error', 'rights_takedown', 'other'] as const;
export type LectureWithdrawReason = (typeof LECTURE_WITHDRAW_REASONS)[number];
export const LECTURE_WITHDRAW_REASON_LABELS_AR: Record<LectureWithdrawReason, string> = {
  replaced: 'استُبدلت بمحاضرة أخرى',
  error: 'نُشرت بالخطأ',
  rights_takedown: 'سُحبت بطلب صاحب الحقوق',
  other: 'سبب آخر',
};

export interface OfficialLectureView {
  id: string;
  space_id: string;
  subject: NodeRef;
  title: string;
  lecture_no: number | null;
  /** 'detected' = read from the file and confirmed; 'moderator' = typed by a moderator */
  lecture_no_origin: 'detected' | 'moderator' | null;
  /** YYYY-MM-DD */
  held_on: string | null;
  /** drafts and lectures in review are listed to the subject's moderators and to their uploader only */
  status: OfficialLectureStatus;
  /** the published official version students see (null before the first publish) */
  head_version: { id: string; version_no: number; page_count: number | null; processing_status: string } | null;
  uploaded_by: UserRef;
  /**
   * the moderator who approved a contributor's draft and when (AOS-18.4 «draft → approved → published»; review W2-step0
   * R9); null before approval and for a moderator's own upload
   */
  approved: { by: UserRef; at: number } | null;
  /** publications of this lecture the VIEWER may see (never a count that reveals hidden ones) */
  counts: { explanations: number };
  updated_at: number;
}

export interface OfficialVersionView {
  id: string;
  version_no: number;
  /** 'upload' = a new file; 'correction' = a moderator's correction of a published version (§6.7) */
  kind: 'upload' | 'correction';
  status: 'draft' | 'published' | 'superseded';
  file_name: string | null;
  page_count: number | null;
  processing_status: string;
  published_at: number | null;
  published_by: UserRef | null;
  change_note: string | null;
  previous_version_id: string | null;
  /** the page map from the previous published version (Scenario 4); null for the first version */
  page_map_status: 'pending' | 'ready' | 'failed' | null;
}

/**
 * GET /api/spaces/:s/lectures/:id. The viewer's own copy lives in their vault and is read from `/api/copies` (a space
 * route never reads a vault).
 */
export interface OfficialLectureDetail extends OfficialLectureView {
  versions: OfficialVersionView[];
  withdrawn: { reason: LectureWithdrawReason; note_ar: string; at: number } | null;
}

/** GET /api/spaces/:s/lectures — ordered by lecture number, then `held_on`, then title (AOS-2.2). */
export const officialLecturesQuerySchema = cursorPageQuerySchema.extend({ status: z.enum(OFFICIAL_LECTURE_STATUSES).optional() });
export type OfficialLecturesResponse = CursorPage<OfficialLectureView>;

const lectureTitle = plainTextSchema({ max: 200, field_ar: 'عنوان المحاضرة' });
const lectureNo = z.number().int().min(1).max(999);

/** POST /api/spaces/:s/lectures — a draft (contributor or moderator); an optional client id makes it idempotent. */
export const createOfficialLectureSchema = z
  .object({
    id: entityIdSchema.optional(),
    title: lectureTitle,
    lecture_no: lectureNo.nullable().optional(),
    held_on: isoDateSchema.nullable().optional(),
  })
  .strict();
export type CreateOfficialLectureRequest = z.infer<typeof createOfficialLectureSchema>;

/**
 * PATCH /api/spaces/:s/lectures/:id — corrects the title, the number or the date (review W2-step0 R9: a number P1-T3
 * detected wrongly or left uncertain is fixed here and becomes `lecture_no_origin: 'moderator'`, AOS-2.2 / 3.4 / 3.18).
 * A moderator of the subject; a contributor on their own draft. Versions and their pages are never touched.
 */
export const patchOfficialLectureSchema = z
  .object({
    title: lectureTitle.optional(),
    lecture_no: lectureNo.nullable().optional(),
    held_on: isoDateSchema.nullable().optional(),
  })
  .strict()
  .refine((p) => Object.keys(p).length > 0, 'لا يوجد ما يُغيَّر.');
export type PatchOfficialLectureRequest = z.infer<typeof patchOfficialLectureSchema>;

/** POST /api/spaces/:s/lectures/:id/upload — after a chunked upload into the space (`/api/files/uploads`, target space). */
export const uploadOfficialVersionSchema = z.object({ upload_id: entityIdSchema }).strict();
export interface UploadOfficialVersionResponse {
  version_id: string;
  job_id: string;
}

/** POST /api/spaces/:s/lectures/:id/approve — a moderator approves a contributor's draft. */
export const approveOfficialLectureSchema = z.object({}).strict();

/**
 * POST /api/spaces/:s/lectures/:id/versions/:versionId/publish. `preview: true` answers `PublishOfficialVersionPreview`
 * and changes nothing (the moderator sees how many students hold a copy before confirming — Scenario 4 step 3).
 */
export const publishOfficialVersionSchema = z
  .object({
    change_note: plainTextSchema({ min: 0, max: 1000, field_ar: 'ملاحظة التغيير', multiline: true }).nullable().optional(),
    preview: z.boolean().optional(),
  })
  .strict();
export type PublishOfficialVersionRequest = z.infer<typeof publishOfficialVersionSchema>;

export interface PublishOfficialVersionPreview {
  lecture_id: string;
  version: { id: string; version_no: number; page_count: number | null };
  previous: { id: string; version_no: number } | null;
  /** page changes against the previous published version, when its page map is ready */
  changes: Record<PageChangeKind, number> | null;
  /** students holding a copy of the lecture (system `lecture_copy`), suppressed under 5 */
  holders: GroupCount;
}
export interface PublishOfficialVersionResponse {
  head_version_id: string;
  /** the page-map job from the previous published version (null for the first version) */
  page_map_job_id: string | null;
  holders: GroupCount;
}

/** POST /api/spaces/:s/lectures/:id/page-map/decisions — a moderator confirms or rejects page pairs (P1-T3 actions). */
export const officialPageMapDecisionsSchema = z
  .object({
    from_version_id: entityIdSchema,
    to_version_id: entityIdSchema,
    decisions: z
      .array(z.object({ from_page_id: entityIdSchema, action: z.enum(['confirm', 'reject', 'reset']), to_page_id: entityIdSchema.optional() }).strict())
      .min(1)
      .max(500),
  })
  .strict()
  .refine((b) => b.from_version_id !== b.to_version_id, { message: 'اختر إصدارين مختلفين.', path: ['to_version_id'] });
export type OfficialPageMapDecisionsRequest = z.infer<typeof officialPageMapDecisionsSchema>;

/**
 * POST /api/spaces/:s/lectures/:id/withdraw. Withdrawal never deletes anyone's ink: copies keep their items and say
 * why; a rights takedown nulls the stubs' file references before the space's file rows are deleted.
 */
export const withdrawOfficialLectureSchema = z
  .object({
    reason: z.enum(LECTURE_WITHDRAW_REASONS),
    note_ar: plainTextSchema({ min: 2, max: 500, field_ar: 'السبب', multiline: true }),
  })
  .strict();
export type WithdrawOfficialLectureRequest = z.infer<typeof withdrawOfficialLectureSchema>;

/**
 * POST /api/spaces/:s/lectures/:id/corrections — corrected text of regions of one version. On a PUBLISHED version it
 * creates a new official version (its regions are immutable, §6.7); on a draft it corrects in place. A contributor's
 * correction goes to the moderators' review queue instead.
 */
export const officialCorrectionSchema = z
  .object({
    version_id: entityIdSchema,
    items: z
      .array(z.object({ region_id: entityIdSchema, text: plainTextSchema({ min: 0, max: 25_000, field_ar: 'النص المصحح', multiline: true }) }).strict())
      .min(1)
      .max(200),
    note: plainTextSchema({ max: 1000, field_ar: 'ملاحظة التصحيح', multiline: true }).optional(),
  })
  .strict();
export type OfficialCorrectionRequest = z.infer<typeof officialCorrectionSchema>;
export interface OfficialCorrectionResponse {
  /** the version that now holds the correction (a new one for a published version; null while it waits for review) */
  version_id: string | null;
  created_new_version: boolean;
  /** a contributor's proposal waiting for a moderator */
  review_item_id: string | null;
}

/**
 * POST /api/spaces/:s/lectures/from-vault — «انشر كمحاضرة رسمية» (AOS-19H.4; §6.9 step 3): a Subject Moderator promotes
 * a private source they uploaded. The blob is registered in the space by sha256 (no byte copy). The uploader's own ink
 * stays private in their vault; their client links it afterwards with POST /api/copies/link (copy, never move).
 */
export const lectureFromVaultSchema = z
  .object({
    source_id: entityIdSchema,
    title: lectureTitle,
    lecture_no: lectureNo.nullable().optional(),
  })
  .strict();
export type LectureFromVaultRequest = z.infer<typeof lectureFromVaultSchema>;
export interface LectureFromVaultResponse {
  lecture: OfficialLectureView;
  version_id: string;
  job_id: string;
}

/** GET /api/spaces/:s/lectures/:id/offline-package — today's offline manifest for the official head version. */
export interface OfficialOfflinePackageResponse extends OfflineManifestResponse {
  space_id: string;
  lecture_id: string;
}

// ───────────────────────────── subject content (3010) ─────────────────────────────

export const SUBJECT_ATTACHMENT_KINDS = ['summary', 'previous_exam', 'reference', 'other'] as const;
export type SubjectAttachmentKind = (typeof SUBJECT_ATTACHMENT_KINDS)[number];
export const subjectAttachmentKindSchema = z.enum(SUBJECT_ATTACHMENT_KINDS);
export const SUBJECT_ATTACHMENT_KIND_LABELS_AR: Record<SubjectAttachmentKind, string> = {
  summary: 'ملخص',
  previous_exam: 'أسئلة سنوات سابقة',
  reference: 'مرجع',
  other: 'ملف آخر',
};
export const SUBJECT_ATTACHMENT_STATUSES = ['draft', 'published', 'withdrawn'] as const;
export type SubjectAttachmentStatus = (typeof SUBJECT_ATTACHMENT_STATUSES)[number];

export interface SubjectAttachmentView {
  id: string;
  kind: SubjectAttachmentKind;
  title: string;
  lecture: { id: string; title: string } | null;
  /** a contributor's upload starts as a draft that a moderator publishes */
  status: SubjectAttachmentStatus;
  visibility: 'course' | 'moderators';
  uploaded_by: UserRef;
  /** the attachment is processed like any source of the space */
  source_id: string;
  file: { file_id: string; name: string | null; mime: string; size: number } | null;
  created_at: number;
  updated_at: number;
}
export interface SubjectAttachmentsResponse {
  attachments: SubjectAttachmentView[];
}

/** POST /api/spaces/:s/subject/attachments */
export const createSubjectAttachmentSchema = z
  .object({
    kind: subjectAttachmentKindSchema,
    title: plainTextSchema({ max: 200, field_ar: 'عنوان الملف' }),
    lecture_id: entityIdSchema.nullable().optional(),
    upload_id: entityIdSchema,
  })
  .strict();
export type CreateSubjectAttachmentRequest = z.infer<typeof createSubjectAttachmentSchema>;
/** PATCH /api/spaces/:s/subject/attachments/:id — a moderator publishes a draft or withdraws an attachment. */
export const patchSubjectAttachmentSchema = z.object({ status: z.enum(['published', 'withdrawn']) }).strict();

export const SUBJECT_EXAM_DATE_STATUSES = ['published', 'changed', 'cancelled'] as const;
export type SubjectExamDateStatus = (typeof SUBJECT_EXAM_DATE_STATUSES)[number];
export interface SubjectExamDateView {
  id: string;
  title: string;
  /** YYYY-MM-DD */
  exam_on: string;
  /** HH:MM, local */
  starts_at: string | null;
  /** lectures the moderator says are included (may be empty) */
  lecture_ids: string[];
  status: SubjectExamDateStatus;
  published_by: UserRef;
  updated_at: number;
}
export interface SubjectExamDatesResponse {
  exam_dates: SubjectExamDateView[];
}
/** PUT /api/spaces/:s/subject/exam-dates/:id (client id: create or replace); DELETE cancels it. */
export const putSubjectExamDateSchema = z
  .object({
    title: plainTextSchema({ max: 200, field_ar: 'اسم الامتحان' }),
    exam_on: isoDateSchema,
    starts_at: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'اكتب الوقت بالشكل 09:30.')
      .nullable()
      .optional(),
    lecture_ids: z.array(entityIdSchema).max(200).optional(),
  })
  .strict();
export type PutSubjectExamDateRequest = z.infer<typeof putSubjectExamDateSchema>;

/** The subject updates feed (AOS-2.9), appended in the same transaction as the change it reports. */
export const SUBJECT_EVENT_KINDS = [
  'lecture_published',
  'version_published',
  'lecture_withdrawn',
  'attachment_published',
  'exam_date_published',
  'exam_date_changed',
] as const;
export type SubjectEventKind = (typeof SUBJECT_EVENT_KINDS)[number];
export const SUBJECT_EVENT_KIND_LABELS_AR: Record<SubjectEventKind, string> = {
  lecture_published: 'محاضرة جديدة',
  version_published: 'إصدار جديد من محاضرة',
  lecture_withdrawn: 'سُحبت محاضرة',
  attachment_published: 'ملف جديد',
  exam_date_published: 'موعد امتحان',
  exam_date_changed: 'تغيّر موعد امتحان',
};
export interface SubjectEventView {
  seq: number;
  kind: SubjectEventKind;
  ref: { type: string; id: string };
  /** an Arabic display line; never private content */
  title: string;
  created_at: number;
}
/** GET /api/spaces/:s/subject/events — filtered by the viewer's access (moderator-only events for moderators). */
export const subjectEventsQuerySchema = cursorPageQuerySchema;
export type SubjectEventsResponse = CursorPage<SubjectEventView>;

// ───────────────────────────── step 1 additions (P1-T5; additive) ─────────────────────────────

/** Who uploaded a version (a contributor's version waits for a moderator to publish it); additive to OfficialVersionView. */
export interface OfficialVersionUploader {
  uploaded_by?: UserRef | null;
}

/**
 * Corrections of official lectures (AOS-18.9; review W2-step0 N1): a moderator's correction of a PUBLISHED version is
 * `queued` until the job has created and published the new version (`applied`); a contributor's proposal is `open`
 * until a moderator accepts it (then `queued` → `applied`) or rejects it.
 */
export const OFFICIAL_CORRECTION_STATUSES = ['open', 'queued', 'applied', 'rejected', 'failed'] as const;
export type OfficialCorrectionStatus = (typeof OFFICIAL_CORRECTION_STATUSES)[number];
export const OFFICIAL_CORRECTION_STATUS_LABELS_AR: Record<OfficialCorrectionStatus, string> = {
  open: 'بانتظار مراجعة المشرف',
  queued: 'يُنشأ الإصدار المصحح',
  applied: 'نُشر في إصدار جديد',
  rejected: 'رُفض',
  failed: 'تعذّر تطبيقه',
};

export interface OfficialCorrectionView {
  id: string;
  lecture: { id: string; title: string };
  version: { id: string; version_no: number };
  items: Array<{ region_id: string; page_index: number | null; before: string | null; after: string }>;
  note: string | null;
  proposed_by: UserRef;
  status: OfficialCorrectionStatus;
  /** the new official version that holds the correction, once applied */
  result_version_id: string | null;
  decided_by: UserRef | null;
  decided_at: number | null;
  decision_note: string | null;
  failure_reason_ar: string | null;
  created_at: number;
}
export interface OfficialCorrectionsResponse {
  corrections: OfficialCorrectionView[];
}
/** GET /api/spaces/:s/subject/corrections — the moderators' queue (official moderators of the subject). */
export const officialCorrectionsQuerySchema = z
  .object({ status: z.enum(OFFICIAL_CORRECTION_STATUSES).optional(), lecture_id: entityIdSchema.optional() })
  .strict();
/** POST /api/spaces/:s/lectures/:id/corrections/:correctionId/decide — accept (a new version) or reject a proposal. */
export const decideOfficialCorrectionSchema = z
  .object({
    decision: z.enum(['accept', 'reject']),
    note_ar: plainTextSchema({ min: 0, max: 500, field_ar: 'ملاحظة القرار', multiline: true }).optional(),
  })
  .strict();
export type DecideOfficialCorrectionRequest = z.infer<typeof decideOfficialCorrectionSchema>;

/**
 * «الملفات المكررة» (AOS-18.11): byte-identical files (same sha256) and near-duplicates (≥ 60 % of the pages share their
 * text fingerprint, P1-T3 §6.2) among THIS subject's official lectures and attachments only — never across subjects.
 */
export const DUPLICATE_NEAR_THRESHOLD = 0.6;
export interface SubjectDuplicateItem {
  type: 'lecture' | 'attachment';
  id: string;
  title: string;
  status: string;
  version: { id: string; version_no: number; file_name: string | null; page_count: number | null };
}
export interface SubjectDuplicateGroup {
  kind: 'identical' | 'near';
  /** 1 for identical bytes; the share of matching pages for near-duplicates */
  similarity: number;
  basis_ar: string;
  items: SubjectDuplicateItem[];
}
export interface SubjectDuplicatesResponse {
  groups: SubjectDuplicateGroup[];
  /** honest coverage: versions compared and how many of them carry page fingerprints yet */
  checked: { versions: number; fingerprinted: number };
}

/** Multipart fields of POST /api/spaces/:s/subject/attachments (the file travels in the same request). */
export const createSubjectAttachmentFieldsSchema = z
  .object({
    kind: subjectAttachmentKindSchema,
    title: plainTextSchema({ max: 200, field_ar: 'عنوان الملف' }),
    lecture_id: entityIdSchema.optional(),
  })
  .strict();
