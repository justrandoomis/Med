// Automatic figure descriptions (image-heavy lectures: histology, gross specimens, radiology, graphs, clinical photos).
//
// After a lecture version is processed — only when an AI provider is configured AND the owner has an active
// `ai_processing` consent — every cropped figure (and every image-only page / slide) is sent once to the vision model
// and a STRUCTURED, DERIVED description is stored beside it (never in the source, never replacing the original image):
// image type, stain / magnification when visible, key findings, labels / arrows read, a graph's axes and trend, a
// likely diagnosis / topic ONLY when the slide's own text or caption says it (otherwise «اقتراح — غير مؤكد»), and a
// short Arabic + English caption. The owner can confirm, correct or reject it; the owner's version always wins and is
// kept on every re-run. Descriptions are searchable, and become image flashcards and image MCQs (docs/modules/processing.md).
import type { JobView } from './api';

export const FIGURE_DESCRIPTION_LABEL_AR = 'وصف آلي — راجعه';
export const FIGURE_DESCRIPTION_OWNER_LABEL_AR = 'وصف راجعته بنفسك';
export const FIGURE_DESCRIPTION_NOTICE_AR =
  'وصف مشتق قرأه نموذج رؤية من صورة المحاضرة؛ ليس نص المصدر وقد يخطئ. الصورة الأصلية لم تتغير. صحّحه أو أكّده قبل الاعتماد عليه.';
/** a diagnosis / topic the slide's own text does not state */
export const FIGURE_SUGGESTION_LABEL_AR = 'اقتراح — غير مؤكد';

export const FIGURE_IMAGE_TYPES = ['histology', 'gross', 'radiology', 'graph', 'diagram', 'clinical_photo', 'other'] as const;
export type FigureImageType = (typeof FIGURE_IMAGE_TYPES)[number];
export const FIGURE_IMAGE_TYPE_LABELS_AR: Record<FigureImageType, string> = {
  histology: 'شريحة نسيجية (هستولوجي)',
  gross: 'عينة عيانية (Gross)',
  radiology: 'صورة شعاعية',
  graph: 'رسم بياني',
  diagram: 'مخطط أو رسم توضيحي',
  clinical_photo: 'صورة سريرية',
  other: 'صورة أخرى',
};

/**
 * Where a diagnosis / topic comes from: the slide's printed text or the figure caption (the server checked that the
 * quoted words are really there), a model suggestion the text does not state, or the owner.
 */
export type FigureDiagnosisBasis = 'slide_text' | 'caption' | 'suggestion' | 'owner';
export const FIGURE_DIAGNOSIS_BASIS_LABELS_AR: Record<FigureDiagnosisBasis, string> = {
  slide_text: 'مذكور في نص الشريحة',
  caption: 'مذكور في تعليق الصورة',
  suggestion: FIGURE_SUGGESTION_LABEL_AR,
  owner: 'حدّدته بنفسك',
};

export interface FigureLabelRead {
  /** the label / arrow text exactly as printed */
  text: string;
  /** what it points to, as seen (may be null) */
  points_to: string | null;
}

export interface FigureDescriptionContent {
  image_type: FigureImageType;
  stain: string | null;
  magnification: string | null;
  findings: string[];
  labels: FigureLabelRead[];
  graph: { x_axis: string | null; y_axis: string | null; trend: string | null } | null;
  diagnosis: { text: string; basis: FigureDiagnosisBasis; quote: string | null } | null;
  caption_ar: string;
  caption_en: string;
}

export type FigureDescriptionStatus = 'pending' | 'described' | 'failed' | 'skipped';
export const FIGURE_DESCRIPTION_STATUS_LABELS_AR: Record<FigureDescriptionStatus, string> = {
  pending: 'في انتظار الوصف',
  described: 'وُصفت آليًا',
  failed: 'تعذّر الوصف',
  skipped: 'لم تُرسل',
};
export type FigureOwnerStatus = 'confirmed' | 'edited' | 'rejected';
export const FIGURE_OWNER_STATUS_LABELS_AR: Record<FigureOwnerStatus, string> = {
  confirmed: 'أكدتَ الوصف',
  edited: 'صحّحتَ الوصف',
  rejected: 'رفضتَ الوصف',
};

export interface FigureDescriptionView {
  id: string;
  version_id: string;
  source_id: string;
  page_id: string | null;
  page_label_ar: string | null;
  /** the figure region (null: an image-only page / slide, or the page was re-processed since) */
  region_id: string | null;
  image_asset_id: string | null;
  target: 'figure' | 'page';
  /** the ORIGINAL picture (never modified) */
  image_url: string;
  status: FigureDescriptionStatus;
  status_label_ar: string;
  /** why it is failed / skipped (budget, consent, cap…) */
  reason_ar: string | null;
  /** what is shown: the owner's version when there is one, else the model's */
  content: FigureDescriptionContent | null;
  /** the model's description as it was (kept beside the owner's) */
  machine: FigureDescriptionContent | null;
  owner_status: FigureOwnerStatus | null;
  /** «وصف آلي — راجعه» until the owner confirmed / corrected it */
  label_ar: string;
  /** true only for an owner-confirmed / corrected description (image questions may rest on it) */
  owner_reviewed: boolean;
  model: string | null;
  described_at: number | null;
  reviewed_at: number | null;
  cards: number;
}

export type FigureRunStatus = 'queued' | 'running' | 'completed' | 'partial' | 'skipped' | 'failed';
export const FIGURE_RUN_STATUS_LABELS_AR: Record<FigureRunStatus, string> = {
  queued: 'في الانتظار',
  running: 'تُوصف الصور',
  completed: 'اكتمل الوصف',
  partial: 'اكتمل جزئيًا',
  skipped: 'لم يُرسل شيء',
  failed: 'فشل',
};

export interface FigureDescriptionRunView {
  id: string;
  status: FigureRunStatus;
  status_label_ar: string;
  trigger: 'auto' | 'owner';
  reason_ar: string | null;
  done: number;
  total: number;
  job: JobView | null;
  created_at: number;
}

export interface FigureDescriptionsResponse {
  version_id: string;
  source_id: string;
  items: FigureDescriptionView[];
  /** pictures of this version that could be described (cropped figures + image-only pages), capped */
  candidates: number;
  run: FigureDescriptionRunView | null;
  can_describe: { available: boolean; reason_ar: string | null; consent_required: boolean };
  max_images: number;
  counts: { described: number; pending: number; failed: number; skipped: number; reviewed: number; draft_cards: number };
  notice_ar: string;
}

export interface FigureDescriptionResponse {
  description: FigureDescriptionView;
}

export interface FigureDescribeRequest {
  /** re-describe pictures already described (the owner's corrections are kept either way) */
  force?: boolean;
  /** only these descriptions (e.g. «أعد وصف هذه الصورة») */
  description_ids?: string[];
  /** use the stronger vision model instead of the routine one */
  precise?: boolean;
}

export interface FigureDescriptionReviewRequest {
  decision: 'confirm' | 'edit' | 'reject' | 'reset';
  /** edit: the owner's corrected fields (others keep the model's value) */
  content?: Partial<Omit<FigureDescriptionContent, 'diagnosis'>> & { diagnosis?: { text: string } | null };
}

export interface CardFromFigureRequest {
  description_id: string;
  /** cover the labels / arrows the processing found inside the figure (an occlusion-style front) */
  hide_labels?: boolean;
}

export interface CardsFromFiguresRequest {
  version_id: string;
  hide_labels?: boolean;
}

export interface CardDraftDecisionRequest {
  decision: 'accept' | 'discard';
}
