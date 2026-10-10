// Media: lecture audio layer (§29), Medical Image Explorer + Image Quiz (§32), AC-08 / AC-09 — track D3.
//
// THE RULES (enforced server-side, apps/server/src/modules/media):
//  * The original audio, the original transcript text and every correction are kept (corrections never overwrite the
//    original; each change appends a revision). Links segment ↔ page/region say whether they are MANUAL or AUTO;
//    no automatic timing match is invented (none is produced in this version).
//  * The microphone never starts without an explicit owner action; nothing is sent to a transcription provider
//    without one (none is configured in this version → `requires_configuration`).
//  * Images: the origin is always visible — photo from a source, educational drawing from a source, a diagram the
//    system re-organized, or a generated illustration (never shown as a real radiograph or a documented case).
//  * Overlays are non-destructive (the original image is never modified) and carry a certainty label. An UNCERTAIN
//    label never becomes a fixed quiz answer (AC-08).
//  * Image Quiz payloads never reveal the answer: neutral image URL, no file name, caption, title or alt text.
//  * External image candidates pass validateImageCandidate (modality, region, caption, age group) — mismatches are
//    excluded with reasons (AC-09). External image search itself is not available in this version.
import { z } from 'zod';
import type { FeatureState } from './features';

// ───────── capability summary ─────────
export interface MediaCapability {
  state: FeatureState;
  reason_ar?: string;
}
export interface MediaStatusResponse {
  audio_playback: MediaCapability;
  manual_transcript: MediaCapability;
  subtitle_import: MediaCapability;
  transcription: MediaCapability;
  recording: MediaCapability;
  auto_linking: MediaCapability;
  image_explorer: MediaCapability;
  image_quiz: MediaCapability;
  external_image_search: MediaCapability;
}

// ───────── audio ─────────
export const TRANSCRIPT_ORIGINS = ['manual', 'imported_vtt', 'imported_srt', 'transcription'] as const;
export type TranscriptOrigin = (typeof TRANSCRIPT_ORIGINS)[number];
export const TRANSCRIPT_ORIGIN_LABELS_AR: Record<TranscriptOrigin, string> = {
  manual: 'كتبته بنفسك',
  imported_vtt: 'مستورد من ملف ترجمة VTT',
  imported_srt: 'مستورد من ملف ترجمة SRT',
  transcription: 'تفريغ آلي',
};

export interface AudioAssetView {
  id: string;
  source_id: string;
  source_title: string;
  source_type: 'lecture_audio' | 'my_audio_note' | string;
  version_id: string;
  mime: string;
  size: number | null;
  duration_ms: number | null;
  /** where the duration comes from — the server does not decode audio */
  duration_origin: 'player' | null;
  /** authenticated, Range-capable stream (owner session) */
  stream_url: string;
  segments: number;
  corrected_segments: number;
  links: number;
  created_at: number;
}

export interface AudioListResponse {
  audio: AudioAssetView[];
  notes_ar: string[];
}

export interface MediaLinkView {
  id: string;
  from_type: 'transcript_segment' | 'annotation';
  from_id: string;
  source_id: string | null;
  source_title: string | null;
  version_id: string | null;
  page_id: string | null;
  page_index: number | null;
  page_label_ar: string | null;
  region_id: string | null;
  region_preview: string | null;
  origin: 'manual' | 'auto';
  origin_label_ar: string;
  /** an AUTO link the owner confirmed (it stays labelled as auto + confirmed) */
  confirmed: boolean;
  created_at: number;
}

export interface TranscriptSegmentView {
  id: string;
  audio_id: string;
  start_ms: number;
  end_ms: number;
  /** the original text (as typed / imported / recognized) — never overwritten */
  text: string;
  corrected_text: string | null;
  /** what is shown and searched: corrected_text ?? text */
  display_text: string;
  origin: TranscriptOrigin;
  origin_label_ar: string;
  /** only when the imported file names the speaker (never guessed) */
  speaker: string | null;
  confidence: number | null;
  rev: number;
  revisions: number;
  links: MediaLinkView[];
  deleted: boolean;
  created_at: number;
  updated_at: number;
}

export interface TranscriptResponse {
  audio: AudioAssetView;
  segments: TranscriptSegmentView[];
  imports: Array<{ id: string; format: 'vtt' | 'srt'; file_name: string | null; created: number; skipped: number; created_at: number }>;
  notes_ar: string[];
}

export const segmentCreateSchema = z
  .object({
    start_ms: z.number().int().min(0).max(24 * 3600 * 1000),
    end_ms: z.number().int().min(1).max(24 * 3600 * 1000),
    text: z.string().trim().min(1).max(4000),
  })
  .strict()
  .refine((s) => s.end_ms > s.start_ms, { message: 'نهاية المقطع يجب أن تكون بعد بدايته.', path: ['end_ms'] });

export const segmentPatchSchema = z
  .object({
    base_rev: z.number().int().min(1),
    /** a correction of the text (the original stays); null clears the correction */
    corrected_text: z.string().trim().min(1).max(4000).nullable().optional(),
    start_ms: z.number().int().min(0).max(24 * 3600 * 1000).optional(),
    end_ms: z.number().int().min(1).max(24 * 3600 * 1000).optional(),
  })
  .strict();

export const transcriptImportSchema = z
  .object({
    format: z.enum(['vtt', 'srt', 'auto']).default('auto'),
    file_name: z.string().trim().max(200).nullable().optional(),
    text: z.string().min(1).max(2_000_000),
    /** remove (tombstone) the uncorrected segments of earlier imports first; corrected / manual ones are kept */
    replace_previous_import: z.boolean().default(false),
  })
  .strict();

export interface TranscriptImportResponse {
  import_id: string;
  format: 'vtt' | 'srt';
  created: number;
  skipped: Array<{ cue: number; reason_ar: string }>;
  replaced: number;
  kept_corrected: number;
  transcript: TranscriptResponse;
}

export interface SegmentRevisionView {
  rev: number;
  action: 'create' | 'correct' | 'clear_correction' | 'retime' | 'delete' | 'restore' | 'replaced_by_import';
  action_label_ar: string;
  text: string;
  corrected_text: string | null;
  start_ms: number;
  end_ms: number;
  at: number;
}

export const mediaLinkCreateSchema = z
  .object({
    page_id: z.string().trim().min(1).max(64).nullable().optional(),
    region_id: z.string().trim().min(1).max(64).nullable().optional(),
  })
  .strict()
  .refine((b) => !!b.page_id || !!b.region_id, { message: 'اختر صفحة أو منطقة للربط.', path: ['page_id'] });

// ───────── images ─────────
export const IMAGE_KINDS = [
  'clinical_photo', 'educational_drawing', 'diagram', 'radiology', 'histology', 'pathology', 'ecg', 'dermatology',
  'ophthalmology', 'table_image', 'generated_illustration', 'reorganized_diagram', 'unknown',
] as const;
export type ImageKind = (typeof IMAGE_KINDS)[number];
export const IMAGE_KIND_LABELS_AR: Record<ImageKind, string> = {
  clinical_photo: 'صورة سريرية',
  educational_drawing: 'رسم تعليمي',
  diagram: 'مخطط',
  radiology: 'أشعة (Radiology)',
  histology: 'أنسجة (Histology)',
  pathology: 'تشريح مرضي (Pathology)',
  ecg: 'تخطيط قلب (ECG)',
  dermatology: 'جلدية (Dermatology)',
  ophthalmology: 'عيون (Ophthalmology)',
  table_image: 'جدول مصوَّر',
  generated_illustration: 'صورة توضيحية مولّدة',
  reorganized_diagram: 'مخطط أعيد تنظيمه',
  unknown: 'غير مصنّفة',
};

export type ImageOriginBadge = 'source_photo' | 'source_drawing' | 'source_unknown' | 'reorganized' | 'generated' | 'external';
export const IMAGE_ORIGIN_BADGE_LABELS_AR: Record<ImageOriginBadge, string> = {
  source_photo: 'صورة من المصدر',
  source_drawing: 'رسم تعليمي من المصدر',
  source_unknown: 'صورة من المصدر — نوعها غير محدد',
  reorganized: 'مخطط أعاد النظام تنظيمه',
  generated: 'صورة توضيحية مولّدة — ليست صورة حقيقية',
  external: 'صورة من مصدر خارجي',
};

export const AGE_GROUPS = ['neonate', 'infant', 'child', 'adolescent', 'adult', 'elderly', 'pregnant'] as const;
export type AgeGroup = (typeof AGE_GROUPS)[number];
export const AGE_GROUP_LABELS_AR: Record<AgeGroup, string> = {
  neonate: 'حديث الولادة',
  infant: 'رضيع',
  child: 'طفل',
  adolescent: 'يافع',
  adult: 'بالغ',
  elderly: 'مسن',
  pregnant: 'حامل',
};

export interface ImageSummaryView {
  id: string;
  /** authenticated image URL for the explorer (NOT used by the quiz) */
  file_url: string | null;
  origin: 'source' | 'external' | 'generated' | 'reorganized';
  origin_badge: ImageOriginBadge;
  origin_label_ar: string;
  origin_note_ar: string | null;
  image_kind: ImageKind;
  image_kind_label_ar: string;
  /** 'processing' (from the caption / extraction) or 'owner' (you classified it) */
  kind_origin: 'processing' | 'owner';
  title: string | null;
  caption: string | null;
  source: { id: string; title: string; source_type: string; deleted: boolean } | null;
  page: { id: string; page_index: number; label_ar: string } | null;
  version_id: string | null;
  region_id: string | null;
  modality: string | null;
  anatomic_region: string | null;
  age_group: AgeGroup | null;
  topic: { id: string; title: string } | null;
  overlay_count: number;
  quiz_ready_masks: number;
  created_at: number;
}

export interface ImageListResponse {
  images: ImageSummaryView[];
  /** counts per kind of the images that EXIST (no section is filled with unknown images) */
  kinds: Array<{ kind: ImageKind; label_ar: string; count: number }>;
  next_cursor: string | null;
  notes_ar: string[];
}

export const OVERLAY_KINDS = ['highlight', 'occlusion_mask', 'arrow', 'label'] as const;
export type OverlayKind = (typeof OVERLAY_KINDS)[number];
export const OVERLAY_KIND_LABELS_AR: Record<OverlayKind, string> = {
  highlight: 'تظليل',
  occlusion_mask: 'قناع إخفاء',
  arrow: 'سهم',
  label: 'تسمية',
};
export const OVERLAY_CERTAINTIES = ['from_caption', 'visually_confirmed', 'uncertain', 'owner'] as const;
export type OverlayCertainty = (typeof OVERLAY_CERTAINTIES)[number];
export const OVERLAY_CERTAINTY_LABELS_AR: Record<OverlayCertainty, string> = {
  from_caption: 'من تعليق المصدر',
  visually_confirmed: 'مؤكدة بصريًا',
  uncertain: 'غير مؤكدة',
  owner: 'حددتها بنفسك',
};

const unit = z.number().min(0).max(1);
export const overlayShapeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('rect'), x: unit, y: unit, w: z.number().gt(0).max(1), h: z.number().gt(0).max(1) }).strict(),
  z.object({ type: z.literal('arrow'), x1: unit, y1: unit, x2: unit, y2: unit }).strict(),
  z.object({ type: z.literal('point'), x: unit, y: unit }).strict(),
]);
export type OverlayShape = z.infer<typeof overlayShapeSchema>;

export const overlayCreateSchema = z
  .object({
    kind: z.enum(OVERLAY_KINDS),
    shape: overlayShapeSchema,
    label: z.string().trim().max(200).nullable().optional(),
    /** accepted alternative answers for a quiz mask (e.g. Arabic + English) */
    aliases: z.array(z.string().trim().min(1).max(200)).max(10).optional(),
    certainty: z.enum(OVERLAY_CERTAINTIES).default('owner'),
    note: z.string().trim().max(500).nullable().optional(),
  })
  .strict();
export const overlayPatchSchema = z
  .object({
    base_rev: z.number().int().min(1),
    shape: overlayShapeSchema.optional(),
    label: z.string().trim().max(200).nullable().optional(),
    aliases: z.array(z.string().trim().min(1).max(200)).max(10).optional(),
    certainty: z.enum(OVERLAY_CERTAINTIES).optional(),
    note: z.string().trim().max(500).nullable().optional(),
  })
  .strict();

export interface OverlayView {
  id: string;
  image_id: string;
  kind: OverlayKind;
  kind_label_ar: string;
  shape: OverlayShape;
  label: string | null;
  aliases: string[];
  certainty: OverlayCertainty;
  certainty_label_ar: string;
  note: string | null;
  quiz_eligible: boolean;
  quiz_ineligible_reason_ar: string | null;
  rev: number;
  created_at: number;
  updated_at: number;
}

export interface ImageDetailView extends ImageSummaryView {
  overlays: OverlayView[];
  caption_region_id: string | null;
  match_status: 'unverified' | 'matches' | 'mismatch' | 'owner_confirmed';
  notes_ar: string[];
}

export const imageMetaPatchSchema = z
  .object({
    image_kind: z.enum(IMAGE_KINDS).nullable().optional(),
    title: z.string().trim().max(200).nullable().optional(),
    modality: z.string().trim().max(60).nullable().optional(),
    anatomic_region: z.string().trim().max(80).nullable().optional(),
    age_group: z.enum(AGE_GROUPS).nullable().optional(),
    topic_id: z.string().trim().min(1).max(64).nullable().optional(),
    note: z.string().trim().max(1000).nullable().optional(),
  })
  .strict();

// ───────── image quiz ─────────
export const imageQuizCreateSchema = z
  .object({
    image_id: z.string().trim().min(1).max(64),
    overlay_ids: z.array(z.string().trim().min(1).max(64)).max(30).optional(),
  })
  .strict();

/** The quiz payload: NOTHING here may reveal an answer (no file name, caption, title, alt, source, label). */
export interface ImageQuizView {
  id: string;
  status: 'in_progress' | 'finished';
  /** neutral URL bound to this quiz (owner session); serves the image with masks drawn when possible */
  image_url: string;
  /** 'server' → masks are burned into the served image; 'client' → drawn over it in the browser (non-PNG images) */
  masks_rendered: 'server' | 'client';
  masks: Array<{ key: string; shape: Extract<OverlayShape, { type: 'rect' }>; answered: boolean }>;
  prompt_ar: string;
  answers: Array<{ key: string; result: 'correct' | 'incorrect' | 'self_marked_correct'; answer: string; expected: string }>;
  /** masks left out of the quiz and why (e.g. uncertain labels never become fixed answers) */
  excluded: Array<{ reason_ar: string }>;
  created_at: number;
}

export const imageQuizAnswerSchema = z
  .object({
    key: z.string().trim().min(1).max(16),
    answer: z.string().trim().min(1).max(300),
    /** the owner states their (non-matching) answer was right; recorded as such, never as an automatic match */
    self_mark_correct: z.boolean().optional(),
  })
  .strict();

export interface ImageQuizAnswerResponse {
  key: string;
  result: 'correct' | 'incorrect' | 'self_marked_correct';
  expected: string;
  quiz: ImageQuizView;
}

export interface ImageQuizFinishResponse {
  quiz: ImageQuizView;
  /** revealed only after finishing */
  reveal: {
    image: ImageSummaryView;
    labels: Array<{ key: string; label: string; certainty_label_ar: string }>;
  };
}

// ───────── AC-09: candidate validation (gate for any future external image provider) ─────────
export const imageRequestSchema = z
  .object({
    modality: z.string().trim().min(1).max(60),
    anatomic_region: z.string().trim().min(1).max(80),
    /** terms the image must actually show according to its caption (e.g. «pneumothorax») */
    finding_terms: z.array(z.string().trim().min(1).max(120)).min(1).max(8),
    age_group: z.enum(AGE_GROUPS).nullable().optional(),
    /** a real example is required (generated illustrations / re-drawn diagrams are excluded) */
    require_real_example: z.boolean().default(true),
  })
  .strict();
export type ImageRequest = z.input<typeof imageRequestSchema>;

export interface ImageCandidate {
  modality?: string | null;
  anatomic_region?: string | null;
  caption?: string | null;
  age_group?: string | null;
  image_kind?: string | null;
  origin?: 'source' | 'external' | 'generated' | 'reorganized' | null;
}

export type ImageCheckName = 'modality' | 'anatomic_region' | 'caption_match' | 'age_group' | 'origin';
export interface ImageCheck {
  check: ImageCheckName;
  passed: boolean;
  reason_ar: string;
}
export interface ImageValidation {
  accepted: boolean;
  checks: ImageCheck[];
  /** why it was excluded (Arabic), empty when accepted */
  reasons_ar: string[];
}

export interface ImageMatchResponse {
  /** library images that passed every check */
  accepted: Array<{ image: ImageSummaryView; validation: ImageValidation }>;
  /** excluded with reasons — never presented as the requested example */
  excluded: Array<{ image: ImageSummaryView; validation: ImageValidation }>;
  external: MediaCapability;
  note_ar: string;
}
