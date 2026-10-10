// Handwriting recognition (§28, §41 handwritten answers, §46 search in handwriting) and in-app audio recording with
// pen ↔ time links (§29) — track F4 (docs/modules/ink.md «Track F4», docs/modules/cases-media.md «Track F4»).
//
// THE RULES (enforced server-side):
//  * The original ink is NEVER replaced. A recognition is a DERIVED reading of strokes the owner selected (or wrote in
//    a written-answer pad): stored apart from the strokes, labelled «مقروء آليًا», correctable. A correction keeps the
//    machine reading (`recognized_text`) and adds the owner's text (`corrected_text`); search and «اسأل» use the
//    owner's text when there is one (origin «owner_corrected»).
//  * Words the reader was not sure about are marked `uncertain` and shown as such — never silently «fixed».
//  * Recognition needs a vision-capable AI provider (task `ink_recognize`); without one the capability is
//    `requires_configuration` with the reason and nothing pretends to read.
//  * A handwritten written answer is graded only after the owner CONFIRMED (and possibly edited) the read text; OCR
//    uncertainty never costs points.
//  * Recording starts only on an explicit owner action, shows a visible indicator with a stop control, and is stored
//    as a «ملاحظة صوتية» (my_audio_note) source. Pen strokes written while recording carry a time link labelled
//    automatic; the owner can change it (→ manual) or remove it.
import type { NormBox } from './geometry';

// ───────── recognition ─────────
export const RECOGNITION_LANGS = ['ar', 'en', 'mixed'] as const;
export type RecognitionLang = (typeof RECOGNITION_LANGS)[number];
export const RECOGNITION_LANG_LABELS_AR: Record<RecognitionLang, string> = {
  ar: 'العربية',
  en: 'الإنجليزية',
  mixed: 'مختلط (عربي وإنجليزي)',
};

export const RECOGNITION_PURPOSES = ['page_ink', 'written_answer'] as const;
export type RecognitionPurpose = (typeof RECOGNITION_PURPOSES)[number];

export const RECOGNITION_STATUSES = ['queued', 'running', 'recognized', 'unreadable', 'failed'] as const;
export type RecognitionStatus = (typeof RECOGNITION_STATUSES)[number];
export const RECOGNITION_STATUS_LABELS_AR: Record<RecognitionStatus, string> = {
  queued: 'في انتظار القراءة',
  running: 'تُقرأ الكتابة الآن',
  recognized: 'قُرئت الكتابة',
  unreadable: 'تعذّرت قراءة الكتابة',
  failed: 'فشلت القراءة',
};

/** Label shown with every machine reading (it is derived, may contain errors, and the ink stays as written). */
export const RECOGNIZED_LABEL_AR = 'نص مقروء آليًا من خط يدك — نتيجة مشتقة قد تحتوي أخطاء، والحبر الأصلي محفوظ كما كتبته';
export const CORRECTED_LABEL_AR = 'صحّحتَ هذه القراءة بنفسك';
export const UNCERTAIN_WORD_LABEL_AR = 'كلمة غير مؤكدة';

/** Limits shared by the web (renderer) and the server (validation). */
export const RECOGNITION_IMAGE_MAX_SIDE = 2048;
export const RECOGNITION_IMAGE_MIN_SIDE = 16;
export const RECOGNITION_IMAGE_MAX_BYTES = 3 * 1024 * 1024;
/** long edge the web renders selections at (the vision model's sweet spot; larger is downscaled by the provider) */
export const RECOGNITION_RENDER_LONG_EDGE = 1568;
export const RECOGNITION_MAX_TEXT = 20_000;

export interface RecognizedWord {
  text: string;
  /** the reader was not sure about this word */
  uncertain: boolean;
  /** other readings the model considered (shown to help the correction) */
  alternatives?: string[];
}

export interface RecognizedLine {
  words: RecognizedWord[];
}

export interface RecognitionAnchorView {
  source_id: string | null;
  version_id: string | null;
  page_id: string | null;
  page_index: number | null;
  /** «ص 12 (الصفحة 14 في الملف)» */
  page_label_ar: string | null;
  note_page_id: string | null;
}

export interface InkRecognitionView {
  id: string;
  purpose: RecognitionPurpose;
  status: RecognitionStatus;
  status_label_ar: string;
  lang_requested: RecognitionLang;
  lang_detected: RecognitionLang | null;
  /** the machine reading as returned (never overwritten) */
  recognized_text: string;
  lines: RecognizedLine[];
  uncertain_count: number;
  /** the owner's correction (null = not corrected) */
  corrected_text: string | null;
  corrected_at: number | null;
  /** what search and «اسأل عن المحدد» use: the correction when present, else the machine reading */
  effective_text: string;
  origin: 'recognized' | 'owner_corrected';
  origin_label_ar: string;
  annotation_ids: string[];
  anchor: RecognitionAnchorView | null;
  bbox: NormBox | null;
  question_id: string | null;
  /** model that read it (never «verified») */
  engine: string | null;
  job_id: string | null;
  error_ar: string | null;
  /** the exact picture that was sent to the reader (owner session only) */
  image_url: string | null;
  created_at: number;
  updated_at: number;
}

export interface RecognitionCreateRequest {
  /** client ULID (a retried request returns the same recognition) */
  id: string;
  purpose: RecognitionPurpose;
  lang: RecognitionLang;
  /** strokes read (page_ink): the ink stays where it is */
  annotation_ids?: string[];
  /** page or note-page anchor of the strokes (page_ink) */
  anchor?: { type: 'page'; source_id: string; version_id: string; page_id: string; page_index: number } | { type: 'note_page'; note_page_id: string } | null;
  /** selection box (normalized, unrotated page) */
  bbox?: NormBox | null;
  /** written_answer: the question */
  question_id?: string | null;
  /** written_answer: the pad strokes (kept with the reading: the owner's handwriting is never lost) */
  strokes?: number[][][] | null;
  /** PNG of the strokes (black on white, cropped), base64 without a data: prefix */
  image_png_base64: string;
}

export interface RecognitionResponse {
  recognition: InkRecognitionView;
}
export interface RecognitionListResponse {
  recognitions: InkRecognitionView[];
}

export interface RecognitionCorrectRequest {
  /** null → back to the machine reading */
  corrected_text: string | null;
}

/** «اسأل عن المحدد»: the handwriting + the paragraph next to it → a clear contextual request for the chat. */
export interface AskContextRequest {
  anchor: { type: 'page'; source_id: string; version_id: string; page_id: string; page_index: number };
  bbox: NormBox;
  /** recognition of the selected strokes (when read) */
  recognition_id?: string | null;
  /** what the owner typed instead (no recognition available / they preferred to type it) */
  typed_text?: string | null;
}

export interface AskContextResponse {
  handwriting: { text: string; origin: 'recognized' | 'owner_corrected' | 'owner_typed'; uncertain_count: number } | null;
  /** the paragraph next to the writing (null: no text region near it on this page) */
  paragraph: { region_id: string; text: string; relation: 'overlaps' | 'beside' | 'above' | 'below' } | null;
  /** anchor for the chat thread (the paragraph, or the page when none was found) */
  anchor: { source_id: string; version_id: string; page_id: string; region_ids: string[]; quote: { exact: string } | null };
  /** the composed question the owner can edit before sending (nothing is sent automatically) */
  question_ar: string;
  notes_ar: string[];
}

// ───────── pen ↔ recording time links (stored in the stroke's data: InkData.audio_link) ─────────
export const AUDIO_LINK_ORIGIN_LABELS_AR: Record<'auto' | 'manual', string> = {
  auto: 'رابط زمني تلقائي (كُتب أثناء التسجيل)',
  manual: 'رابط زمني عدّلته بنفسك',
};

// ───────── recordings (/api/media/recordings) ─────────
export interface RecordingView {
  /** client recording id (ULID) */
  id: string;
  source_id: string;
  version_id: string | null;
  audio_id: string | null;
  title: string;
  mime: string;
  duration_ms: number | null;
  started_at: number;
  linked_source_id: string | null;
  stream_url: string | null;
  /** strokes written while recording (time links), newest first */
  linked_strokes: Array<{ annotation_id: string; source_id: string | null; page_id: string | null; page_index: number | null; page_label_ar: string | null; offset_ms: number; origin: 'auto' | 'manual' }>;
  created_at: number;
}

export interface RecordingResponse {
  recording: RecordingView;
  /** false when a retried upload returned the recording stored before */
  created: boolean;
}

/** Audio the browser's MediaRecorder produces that the server stores (content-sniffed, never trusted by name). */
export const RECORDING_MIMES = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/wav', 'audio/mpeg'] as const;
