// Academic OS — «ابدأ الدراسة»: a user's study copies of official lectures, in their OWN vault (ARCHITECTURE_DELTA §7.5,
// §6.5, §6.9, §4.2 `0860_document_copy`, §4.1 `2060_lecture_copy`; ADR-0004 §2.4; PRD AOS-2.17–2.19, 4.1–4.3, 4.14
// Phase 1 part, 4.18, 4.20, 19H.3, Q25, Q35). Track P1-T5, wave-2 step 0: types and zod schemas only.
//
// * A copy is a vault STUB of the official version (source + version + page skeleton, no blob, chunk or FTS row
//   duplicated) + the user's personal layer + optionally a forked (writable, frozen at version k) or followed
//   (read-only, updated from the author's publication) layer. «ابدأ الدراسة» twice reopens the same copy.
// * Nothing an update brings ever touches a personal layer: a followed copy previews the change and applies it only on
//   «طبّق التحديث» (policy `preview`, the default) or at once (`auto`); a version can be skipped.
// * A new OFFICIAL version reaches the copy as a new stub version; the user's notes are COPIED to it with P1-T2's
//   one-tap flow (`/api/annotations/reanchor-copy` with the copy's `source_id`, academic/layers.ts), never moved.
//   `reanchor_policy: 'auto'` = «انقل ملاحظاتي تلقائيًا» (Scenario 4 variant): the same copy, without the tap, with the
//   same report in the inbox.
// * «انقل ملاحظاتي من نسختي إليها» (Scenario 2 variant d) is P1-T2's layer copy (`/api/annotations/layers/copy`) into
//   the new copy's personal layer — previewed first, the old copy unchanged.
//
// STABLE CONTRACT: fields and enum members are only ever ADDED (P1-T5 owns this file).
import { z } from 'zod';
import type { NodeRef } from './channels-api';
import type { LectureWithdrawReason } from './lectures-api';
import { entityIdSchema } from './channels-api';
import type { PublicationStatus } from './publications-api';
import type { UserRef } from './visibility';

export const COPY_MODES = ['personal', 'independent_fork', 'followed', 'collaborative'] as const;
export type CopyMode = (typeof COPY_MODES)[number];
export const copyModeSchema = z.enum(COPY_MODES);
export const COPY_MODE_LABELS_AR: Record<CopyMode, string> = {
  personal: 'نسختي',
  independent_fork: 'نسخة مستقلة',
  followed: 'نسخة متابَعة',
  collaborative: 'نسخة تعاونية',
};
/** What «ابدأ الدراسة» can create in Phase 1 (a collaborative copy is Phase 4). */
export const START_STUDYING_MODES = ['personal', 'independent_fork', 'followed'] as const satisfies readonly CopyMode[];

export const COPY_UPDATE_POLICIES = ['preview', 'auto'] as const;
export type CopyUpdatePolicy = (typeof COPY_UPDATE_POLICIES)[number];
export const copyUpdatePolicySchema = z.enum(COPY_UPDATE_POLICIES);
/** For updates of a followed explanation (PRD Q25). */
export const COPY_UPDATE_POLICY_LABELS_AR: Record<CopyUpdatePolicy, string> = {
  preview: 'اعرض التغييرات قبل التطبيق',
  auto: 'طبّق التحديثات تلقائيًا',
};
/** For a new official version of the lecture (Scenario 4, PRD Q35). */
export const REANCHOR_POLICY_LABELS_AR: Record<CopyUpdatePolicy, string> = {
  preview: 'اعرض النقل قبل تطبيقه',
  auto: 'انقل ملاحظاتي تلقائيًا',
};

/**
 * POST /api/copies — «ابدأ الدراسة». Idempotent by the client id `id` (same id + same body → the existing copy, 200;
 * same id + another body → 409). A personal copy works offline for a downloaded lecture; a fork or a follow needs the
 * server once to copy the snapshot.
 */
export const startStudyingSchema = z
  .object({
    id: entityIdSchema,
    space_id: entityIdSchema,
    lecture_id: entityIdSchema,
    mode: z.enum(START_STUDYING_MODES),
    /** fork / followed: the publication */
    publication_id: entityIdSchema.optional(),
    /** fork only: the pinned publication version (default: the head) */
    version_no: z.number().int().min(1).optional(),
    /** where the stub appears in «مكتبتي» (default: «موادي من القنوات») */
    library_folder_id: entityIdSchema.nullable().optional(),
    /**
     * «انقل ملاحظاتي من نسختي إليها»: copy the personal layer of this existing copy (of the same lecture) into the new
     * copy's personal layer, with attribution; the old copy is not changed. The client shows the layer-copy preview first.
     */
    carry_personal_from_copy_id: entityIdSchema.optional(),
  })
  .strict()
  .refine((b) => (b.mode === 'personal') === !b.publication_id, {
    message: 'النسخة المستقلة والمتابَعة تحتاجان شرحًا منشورًا، والنسخة الشخصية لا تحتاجه.',
    path: ['publication_id'],
  })
  .refine((b) => b.version_no === undefined || b.mode === 'independent_fork', {
    message: 'رقم الإصدار يُحدَّد للنسخة المستقلة فقط؛ النسخة المتابَعة تبدأ من آخر إصدار.',
    path: ['version_no'],
  });
export type StartStudyingRequest = z.infer<typeof startStudyingSchema>;

/** A study copy, as its owner sees it (vault data: nobody else can read it). */
export interface DocumentCopyView {
  id: string;
  mode: CopyMode;
  /** the vault stub (or the private upload) the workspace opens: /study/:source_id */
  source_id: string;
  /** `source:<source_id>` — the document the copy's layers belong to */
  document_key: string;
  lecture: { space_id: string; lecture_id: string; subject: NodeRef; title: string; version_id: string; version_no: number } | null;
  publication: {
    id: string;
    space_id: string;
    title: string;
    author: UserRef;
    /** fork: pinned forever; followed: the last applied version */
    applied_version_no: number;
    head_version_no: number;
    /** a hidden or withdrawn publication stops updating; the copy keeps what it had and says why */
    status: PublicationStatus;
    status_note_ar: string | null;
    /**
     * P1-T5 step 3 (additive): the official version the applied publication version was written on («الشرح مبني على
     * الإصدار 1»), and the pending one's (null when nothing is pending)
     */
    built_on_version_no?: number | null;
    pending_built_on_version_no?: number | null;
  } | null;
  personal_layer_id: string;
  /** the forked (writable) or followed (read-only) layer */
  copied_layer_id: string | null;
  /** Phase 4 (collaborative copies); always null in Phase 1 */
  collab_doc_id: string | null;
  update_policy: CopyUpdatePolicy;
  reanchor_policy: CopyUpdatePolicy;
  /** followed: a publication version waiting for «طبّق التحديث» */
  pending_version_no: number | null;
  /** a newer official version than the one this copy reads («يوجد إصدار أحدث من المحاضرة») */
  newer_official_version: { id: string; version_no: number } | null;
  /**
   * P1-T5 step 2 (additive): the official lecture as the copy sees it now — withdrawn lectures keep the copy and its
   * notes and say why; after a rights takedown the file is gone (pages stay as placeholders with the reason). Null for a
   * private upload.
   */
  official?: CopyOfficialState | null;
  created_at: number;
  updated_at: number;
}

/** P1-T5 step 2 (additive): the state of the official lecture behind a copy. */
export interface CopyOfficialState {
  status: 'published' | 'withdrawn' | 'unavailable';
  withdrawn: { reason: LectureWithdrawReason; note_ar: string; at: number } | null;
  /** a rights takedown removed the file from every copy (the notes stay over placeholder pages) */
  file_removed: boolean;
  /** the Arabic line the copy chip shows (null while the lecture is published) */
  note_ar: string | null;
}

export interface StartStudyingResponse {
  copy: DocumentCopyView;
  /** false = «ابدأ الدراسة» reopened the copy that already existed */
  created: boolean;
  /** fork / follow: the job that copies the snapshot (null when nothing remains to copy) */
  job_id: string | null;
}

/** GET /api/copies?source_id= · ?space_id=&lecture_id= — the viewer's own copies only. */
export const documentCopiesQuerySchema = z
  .object({
    source_id: entityIdSchema.optional(),
    space_id: entityIdSchema.optional(),
    lecture_id: entityIdSchema.optional(),
  })
  .refine((q) => !q.lecture_id || !!q.space_id, { message: 'حدّد المادة مع المحاضرة.', path: ['space_id'] });
export interface DocumentCopiesResponse {
  copies: DocumentCopyView[];
}

/** PATCH /api/copies/:id */
export const patchDocumentCopySchema = z
  .object({
    update_policy: copyUpdatePolicySchema.optional(),
    reanchor_policy: copyUpdatePolicySchema.optional(),
  })
  .strict()
  .refine((p) => Object.keys(p).length > 0, 'لا يوجد ما يُغيَّر.');
export type PatchDocumentCopyRequest = z.infer<typeof patchDocumentCopySchema>;

/**
 * POST /api/copies/:id/upstream/apply — «طبّق التحديث» (or skip that version). GET /api/copies/:id/upstream answers
 * publications-api.ts `UpstreamPreview`. Applying upserts changed items under their stable ids, inserts added ones and
 * tombstones removed ones in the FOLLOWED layer only; a stale `version_no` (the head moved) → 409 and nothing changes.
 * A replay (the same `version_no` already applied or skipped — a lost response, a second device) changes nothing and
 * answers 200 with the copy as it is (`applied: { upserted: 0, tombstoned: 0 }` or `skipped: true`).
 */
export const applyUpstreamSchema = z.object({ version_no: z.number().int().min(1), skip: z.boolean().optional() }).strict();
export type ApplyUpstreamRequest = z.infer<typeof applyUpstreamSchema>;
export interface ApplyUpstreamResponse {
  copy: DocumentCopyView;
  skipped: boolean;
  /** rows written in the followed layer (null when skipped) */
  applied: { upserted: number; tombstoned: number } | null;
}

// ───────────────────────────── «اربط بالمحاضرة الرسمية» (AOS-19H.3, §6.9) ─────────────────────────────

/** GET /api/copies/link-candidates?source_id= — official lectures THE VIEWER may see that match a private source. */
export const linkCandidatesQuerySchema = z.object({ source_id: entityIdSchema });
export interface OfficialLinkCandidate {
  space_id: string;
  subject: NodeRef;
  lecture_id: string;
  title: string;
  version_id: string;
  version_no: number;
  basis: 'sha256' | 'fingerprints';
  matched_pages: number;
  total_pages: number;
  /** e.g. «الملف نفسه بالبصمة», «تطابق 38 صفحة من 40» */
  basis_ar: string[];
}
export interface OfficialLinkCandidatesResponse {
  source_id: string;
  candidates: OfficialLinkCandidate[];
}

/**
 * POST /api/copies/link — creates (or reuses) the stub and a personal copy, then COPIES the private source's items onto
 * the official version (deterministic ids, previous anchors kept, uncertain items listed for review). The private
 * source and its rows stay byte-identical.
 */
export const linkToOfficialSchema = z
  .object({
    /** client id of the copy */
    id: entityIdSchema,
    source_id: entityIdSchema,
    space_id: entityIdSchema,
    lecture_id: entityIdSchema,
    to_version_id: entityIdSchema,
  })
  .strict();
export type LinkToOfficialRequest = z.infer<typeof linkToOfficialSchema>;
export interface LinkToOfficialResponse {
  copy: DocumentCopyView;
  /** the copy job (null when it already ran: a repeated link changes nothing) */
  job_id: string | null;
  /** total = copied + needs_review + kept (the job's report; null while the job runs) */
  summary: { total: number; copied: number; needs_review: number; kept: number; summary_ar: string } | null;
}
