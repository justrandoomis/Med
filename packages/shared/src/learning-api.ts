// Personal learning HTTP + sync contract (/api/learning, track L1) — shapes not covered by learning.ts.
// Implemented by apps/server/src/modules/learning, consumed by the web (features/review, weakness, planner, home).
// learning.ts types (FlashcardDTO, ReviewEventDTO, ReviewStateView, WeaknessView, MASTERY_WEIGHTS, LearningProfile,
// StudyPlanConfig, PlanTaskView, PlanRebalanceReport, SourceProgressView, HomeView, RevisionSessionRequest/View,
// ExamDnaView) are used EXACTLY; the types below only extend them.
//
// Honesty rules carried by this contract (§43–§45, §40, AC-27):
//  * every schedule, recall probability, mastery value and exam-relevance level is an ESTIMATE and says so;
//  * Exam Relevance is NOT a probability that a question appears;
//  * opening / scrolling a file is never mastery (reading progress, explanation coverage, practice and mastery
//    estimate are separate numbers);
//  * the owner's reviews and attempts are never deleted by a reset, a merge or a source change.
import type { ConfidenceLevel, MistakeType } from './enums';
import type { ClaimView, EvidenceView } from './evidence';
import type { NormBox } from './geometry';
import type {
  ExamDnaView,
  FlashcardDTO,
  FlashcardKind,
  HomeView,
  LearningProfile,
  PlanRebalanceReport,
  PlanTaskView,
  ReviewEventDTO,
  ReviewRating,
  ReviewStateView,
  RevisionSessionView,
  SourceProgressView,
  StudyPlanConfig,
  WeaknessView,
} from './learning';
import type { RichText } from './richtext';

// ───────── SRS configuration (§43, AC-24) ─────────
/** ts-fsrs `FSRSParameters`, serialized (fuzz is always off: the same events must give the same schedule). */
export interface SrsParams {
  request_retention: number;
  maximum_interval: number;
  w: number[];
  enable_fuzz: false;
  enable_short_term: boolean;
  learning_steps: string[];
  relearning_steps: string[];
}

export const REVIEW_RATING_FSRS: Record<ReviewRating, 'Again' | 'Hard' | 'Good' | 'Easy'> = { 1: 'Again', 2: 'Hard', 3: 'Good', 4: 'Easy' };

/** GET /api/learning/srs-config — everything a client needs to compute the SAME schedule offline. */
export interface SrsConfigView {
  /** recorded on every review_state row, e.g. 'FSRS-6 · ts-fsrs v5.4.2 using FSRS-6.0 · desired_retention=0.90 · …' */
  algorithm: string;
  library: { name: 'ts-fsrs'; version: string };
  params: SrsParams;
  /** sha256 of the params and the ts-fsrs version; a cached review_state computed with another key is rebuilt */
  params_key: string;
  /** owner setting daily_new_cards — limits how many NEW cards the queue introduces per owner day */
  daily_new_limit: number;
  /** owner timezone used for «today» (due today, new-card limit, buried until tomorrow) */
  timezone: string;
  replay: {
    /** events of a card sorted by this key, then folded through `fsrs(params).next(card, reviewed_at, rating)` */
    order: 'reviewed_at, id';
    /** the fold starts from `createEmptyCard(created_at)` of the card */
    initial: 'createEmptyCard(card.created_at)';
    /** relearn markers (schedule_resets) are folded at their time as `forget(card, at, false)` */
    resets: 'forget(card, at, false)';
    /** an event id is applied once; re-sent events never count twice */
    duplicates: 'one event per id';
    rating_map: Record<ReviewRating, 'Again' | 'Hard' | 'Good' | 'Easy'>;
    /** Arabic explanation of the day boundary rules */
    note_ar: string;
  };
  /** live parity sample computed by the server with these params: a client fold of `events` must give `expected` */
  parity_check: {
    created_at: number;
    events: Array<Pick<ReviewEventDTO, 'id' | 'rating' | 'reviewed_at'>>;
    resets: number[];
    at: number;
    expected: Pick<ReviewStateView, 'state' | 'due_at' | 'stability' | 'difficulty' | 'reps' | 'lapses' | 'last_review_at' | 'retrievability'>;
  };
}

export interface SrsRebuildResponse {
  cards: number;
  changed: number;
  algorithm: string;
}

// ───────── cards (§43) ─────────
export const FLASHCARD_KIND_LABELS_AR: Record<FlashcardKind, string> = {
  basic: 'سؤال وجواب',
  cloze: 'إكمال فراغ (Cloze)',
  image_occlusion: 'إخفاء جزء من صورة (Image Occlusion)',
  mistake: 'بطاقة من خطأ',
};

export const FLASHCARD_ORIGIN_LABELS_AR: Record<FlashcardDTO['origin'], string> = {
  owner: 'بطاقة كتبتها بنفسك',
  generated: 'بطاقة مولدة بواسطة MedLevo من المصادر المحددة',
  from_mistake: 'بطاقة من سؤال أخطأت فيه',
  from_selection: 'بطاقة من نص حددته في المصدر',
};

export const CARD_IMPACT_KINDS = ['source_changed', 'evidence_unavailable', 'source_trashed', 'question_changed', 'newer_version'] as const;
export type CardImpactKind = (typeof CARD_IMPACT_KINDS)[number];
export const CARD_IMPACT_RESOLUTIONS = ['keep', 'relearn', 'move_to_current_version', 'edited', 'alert_resolved'] as const;
export type CardImpactResolution = (typeof CARD_IMPACT_RESOLUTIONS)[number];

/** Why a card needs the owner's review after a source / key change (AC-26). History is never erased. */
export interface CardImpactView {
  kind: CardImpactKind;
  ref: string;
  alert_id: string | null;
  reason_ar: string;
  detected_at: number;
  /** false when the cause disappeared (e.g. the comparison later found the cited text unchanged) */
  active: boolean;
  resolved_at: number | null;
  resolution: CardImpactResolution | null;
}

/** A citation of a card as it was when the card was made (kept even if the evidence later disappears). */
export interface CardEvidenceSnapshot {
  evidence_id: string;
  source_id: string;
  source_title: string;
  version_id: string;
  locator_label_ar: string;
  quote: string;
  /** whether the evidence row still exists and its source is not in the trash */
  available: boolean;
}

/** Server copy of a card (sync DTO for 'flashcard' pull/push and every card endpoint). */
export interface FlashcardView extends FlashcardDTO {
  /** cards made together (one cloze text → one card per index; one image → one card per mask) share it */
  note_id: string | null;
  /** cloze: the {{cN::…}} index this card asks */
  cloze_index: number | null;
  /** this card preserves a concurrent edit of another card (keep both, §47) */
  conflict_of_id: string | null;
  /** tombstoned by an owner-confirmed merge into this card (its review history stays under its own id) */
  merged_into_id: string | null;
  /** relearn markers set by the owner (folded as `forget`); the review events before them are kept */
  schedule_resets: number[];
  review_state: ReviewStateView;
  /** «تقديري»: review state with stability ≥ 21 days — it still comes back for review */
  estimated_mastered: boolean;
  needs_review: boolean;
  impacts: CardImpactView[];
  evidence: CardEvidenceSnapshot[];
  origin_label_ar: string;
  kind_label_ar: string;
}

export interface CardListResponse {
  items: FlashcardView[];
  next_cursor: string | null;
  counts: { total: number; suspended: number; needs_review: number; deleted: number };
}

export interface CardDetailResponse {
  card: FlashcardView;
  /** the owner's review log (append-only), oldest first */
  events: ReviewEventDTO[];
  /** other cards of the same note (cloze siblings / occlusion masks) */
  siblings: Array<Pick<FlashcardView, 'id' | 'cloze_index' | 'kind' | 'deleted_at'>>;
}

/** Text fields accept RichText or plain text (converted with richTextFromPlain). */
export type RichTextInput = RichText | string;

export interface CardCreateRequest {
  /** client ULID of the (first) card — a retried create returns the same cards (idempotent) */
  id?: string;
  kind: 'basic' | 'cloze';
  /** basic: the question; cloze: the text with {{c1::answer}} / {{c1::answer::hint}} markers */
  front: RichTextInput;
  /** basic: the answer; cloze: «Back Extra» (optional) */
  back?: RichTextInput | null;
  concept_id?: string | null;
  topic_id?: string | null;
  source_id?: string | null;
  source_version_id?: string | null;
  evidence_ids?: string[];
}

export interface CardFromSelectionRequest {
  id?: string;
  source_id: string;
  version_id: string;
  /** the selected text as shown (logical order) */
  quote: string;
  /** existing evidence ids for the selection … */
  evidence_ids?: string[];
  /** … or the region the selection is in (an exact evidence excerpt is created from it) */
  region_id?: string | null;
  start?: number | null;
  end?: number | null;
  kind?: 'basic' | 'cloze';
  front: RichTextInput;
  back?: RichTextInput | null;
  concept_id?: string | null;
  topic_id?: string | null;
}

export interface CardFromMistakeRequest {
  /** the question_attempt the card is made from (one card per attempt; a retry returns it) */
  attempt_id: string;
  id?: string;
}

export interface OcclusionMaskInput {
  id?: string;
  /** normalized box on the ORIGINAL image */
  box: NormBox;
  label: string;
}

export interface OcclusionCreateRequest {
  note_id?: string;
  image_asset_id: string;
  masks: OcclusionMaskInput[];
  /** optional question shown with the picture («سمِّ البنية المخفية») */
  prompt?: string | null;
  concept_id?: string | null;
  topic_id?: string | null;
}

export interface CardCreateResponse {
  cards: FlashcardView[];
  /** false when a retried request returned cards that already existed */
  created: boolean;
  /** possible duplicates of the new cards — suggestions only, never merged automatically */
  duplicates: CardDuplicateSuggestion[];
  /** what the server changed or refused while saving (e.g. unknown evidence ids were not attached) */
  notes_ar: string[];
}

export interface CardUpdateRequest {
  /** the rev the edit is based on; a stale rev → 409 with the server copy (never a silent overwrite) */
  base_rev: number;
  front?: RichTextInput;
  back?: RichTextInput | null;
  concept_id?: string | null;
  topic_id?: string | null;
  /** occlusion: corrected label / box of this card's mask */
  mask?: OcclusionMaskInput | null;
}

export interface CardMutationResponse {
  card: FlashcardView;
}

export interface CardSuspendRequest {
  suspended: boolean;
}
export interface CardBuryRequest {
  /** epoch ms; default: the start of the next day in the owner's timezone */
  until?: number | null;
}

export interface CardImpactResolveRequest {
  /**
   * keep                     — the card stays as it is (schedule unchanged)
   * relearn                  — the schedule restarts (a relearn marker); every earlier review event is kept
   * move_to_current_version  — the card now points at the source's current version
   */
  resolution: 'keep' | 'relearn' | 'move_to_current_version';
}

export interface CardDuplicateSuggestion {
  card_a_id: string;
  card_b_id: string;
  kind: 'same_front' | 'similar';
  /** token overlap (0–1) of question + answer text; a heuristic, not a judgement */
  similarity: number;
  reason_ar: string;
}
export interface CardDuplicatesResponse {
  items: CardDuplicateSuggestion[];
}
export interface CardDuplicateDecisionRequest {
  card_a_id: string;
  card_b_id: string;
  decision: 'not_duplicate' | 'merge';
  /** merge: the card that stays; the other is tombstoned with merged_into_id (its review history is kept) */
  keep_id?: string | null;
}

// ───────── review (§43) ─────────
export interface CardQueueItem {
  card: FlashcardView;
  reason: 'due' | 'learning' | 'new';
  reason_ar: string;
}

export interface CardQueueResponse {
  /** owner day (YYYY-MM-DD) in `timezone` */
  day: string;
  timezone: string;
  counts: {
    due_now: number;
    /** due before the end of the owner's day */
    due_today: number;
    new_available: number;
    new_limit: number;
    new_introduced_today: number;
    suspended: number;
    buried: number;
    needs_review: number;
  };
  items: CardQueueItem[];
  next_due_at: number | null;
  algorithm: string;
}

/** What the review screen shows for one card (occlusion: masks without labels, neutral image URL — no answer leak). */
export interface CardReviewPayload {
  card_id: string;
  kind: FlashcardKind;
  rev: number;
  front: RichText;
  back: RichText;
  image: null | {
    /** short-lived URL; served without a file name */
    url: string;
    expires_at: number;
    alt_ar: string;
    /** ids are positional ('m1', 'm2', …) — never the stored mask ids, which a client may have named after the answer */
    masks: Array<{ id: string; box: NormBox; active: boolean }>;
  };
  /** next due time for each rating if chosen now (from the same algorithm) */
  intervals: Record<ReviewRating, { due_at: number; label_ar: string }>;
  state: ReviewStateView;
  needs_review: boolean;
  impacts: CardImpactView[];
  evidence: CardEvidenceSnapshot[];
  origin_label_ar: string;
}

/** POST /api/learning/reviews — the same append-only event the sync entity 'review_event' carries. */
export interface ReviewSubmitRequest {
  /** client ULID — applied once */
  id: string;
  card_id: string;
  rating: ReviewRating;
  reviewed_at: number;
  duration_ms?: number | null;
}
export interface ReviewSubmitResponse {
  result: 'applied' | 'duplicate';
  event: ReviewEventDTO;
  card: FlashcardView;
}

/** Sync payloads (Dexie rows are camelCase; both spellings are accepted). */
export interface FlashcardSyncPayload {
  kind: FlashcardKind;
  front: RichText;
  back: RichText;
  image?: FlashcardDTO['image'];
  note_id?: string | null;
  cloze_index?: number | null;
  concept_id?: string | null;
  topic_id?: string | null;
  source_id?: string | null;
  source_version_id?: string | null;
  evidence_ids?: string[];
  origin?: Exclude<FlashcardDTO['origin'], 'generated'>;
  origin_ref?: Record<string, unknown> | null;
  suspended?: boolean;
  buried_until?: number | null;
  created_at?: number;
}
export interface ReviewEventSyncPayload {
  card_id: string;
  rating: ReviewRating;
  reviewed_at: number;
  duration_ms?: number | null;
}

// ───────── forgetting forecast (§44) ─────────
export interface ForgettingForecastView {
  generated_at: number;
  algorithm: string;
  /** «تقدير مبني على سجل مراجعاتك، وليس قياسًا يقينيًا للذاكرة» */
  estimate_note_ar: string;
  horizons_days: number[];
  overall: Array<{ days: number; cards: number; avg_recall: number | null; below_desired: number }>;
  by_source: Array<{
    source_id: string | null;
    label: string;
    cards: number;
    now_avg: number | null;
    at: Array<{ days: number; avg_recall: number | null; below_desired: number }>;
  }>;
  /** cards with no review yet have no estimate (never a guess) */
  not_estimated: { cards: number; reason_ar: string };
  desired_retention: number;
}

// ───────── weakness center & mistake genome (§44, AC-27) ─────────
export type WeaknessKind = 'concept' | 'lecture' | 'topic' | 'question';

export interface WeaknessSignalView {
  /** stable reference used to exclude a signal ('mcq:<attempt id>', 'card:<event id>', 'written:<id>') */
  ref: string;
  type: 'mcq' | 'card' | 'written' | 'case' | 'osce';
  at: number;
  correct: boolean | null;
  /** AC-27 category and its weight (MASTERY_WEIGHTS) */
  category: string | null;
  category_label_ar: string;
  weight: number | null;
  confidence: ConfidenceLevel | null;
  hints_used: number;
  mistake_type: MistakeType | null;
  mistake_origin: 'auto' | 'owner' | null;
  question_id: string | null;
  card_id: string | null;
  label: string;
  excluded: boolean;
}

export interface WeaknessDetailView extends WeaknessView {
  key: string;
  kind: WeaknessKind;
  label_origin: 'auto' | 'owner';
  owner_note: string | null;
  status_origin: 'auto' | 'owner';
  status_reason_ar: string;
  /** how the score was computed (shown next to it) */
  score_formula_ar: string;
  counts: { signals: number; wrong: number; correct_independent: number; correct_assisted: number; not_scored: number; lapses: number; excluded: number };
  signal_views: WeaknessSignalView[];
  /** repeated mistakes → a dedicated revision (§44), not just a counter */
  repeated: { question_ids: string[]; card_ids: string[]; summary_ar: string | null };
  dedicated_revision_available: boolean;
  last_signal_at: number | null;
  created_at: number;
}

export interface WeaknessListResponse {
  items: WeaknessDetailView[];
  /** what feeds the center and what is not collected yet */
  sources_note_ar: string[];
  generated_at: number;
}

export interface WeaknessPatchRequest {
  label?: string | null;
  note?: string | null;
  /** owner lifecycle: dismiss / bring back / mark resolved */
  status?: 'active' | 'dismissed' | 'resolved' | null;
  /** signal refs the owner says do not belong to this weakness (the attempts themselves are untouched) */
  excluded_refs?: string[];
}

export interface MistakeGenomeView {
  /** «تصنيف تقديري قابل للتعديل، وليس تشخيصًا نفسيًا» */
  estimate_note_ar: string;
  /** wrong scored answers considered (after profile resets) */
  denominator: number;
  unclassified: number;
  distribution: Array<{ type: MistakeType; label_ar: string; count: number; by_owner: number; by_auto: number }>;
  recent: Array<{
    attempt_id: string;
    question_id: string;
    stem_preview: string;
    answered_at: number;
    mistake_type: MistakeType | null;
    mistake_origin: 'auto' | 'owner' | null;
    auto_mistake_type: MistakeType | null;
    auto_reason_ar: string | null;
  }>;
}

export interface MistakeTypeUpdateRequest {
  mistake_type: MistakeType | null;
}

export interface ReasoningReplayOption {
  option_id: string;
  label: string;
  text: RichText;
  /** best answer: why it wins; others: why they lose — null when the source/question gives no reason */
  why: RichText | null;
  evidence_ids: string[];
  is_best: boolean;
  chosen_by_you: boolean;
}

/** Structured teaching explanation — never presented as the model's hidden reasoning (§44). */
export interface ReasoningReplayView {
  question_id: string;
  question_version_id: string;
  stem: RichText;
  /** where the content comes from */
  content_source: 'question_explanation' | 'evidence_only' | 'none';
  label_ar: string;
  key_known: boolean;
  answer_status: string;
  options: ReasoningReplayOption[];
  /** the general explanation of the question (when present) */
  explanation: RichText | null;
  claims: Record<string, ClaimView>;
  evidence: EvidenceView[];
  /** what is missing, said explicitly («لا يوجد شرح لسبب استبعاد الخيار C») */
  missing_ar: string[];
  /** completing a missing replay needs AI through the evidence services */
  ai: { needed: boolean; available: boolean; reason_ar: string | null };
  attempt: null | { id: string; selected_option_ids: string[]; is_correct: boolean | null; confidence: ConfidenceLevel | null; hints_used: number };
}

// ───────── learning profile (§44) ─────────
export const PROFILE_SIGNAL_PARTS = ['mcq_attempts', 'card_reviews', 'written_attempts', 'mistake_types', 'confidence', 'pace'] as const;
export type ProfileSignalPart = (typeof PROFILE_SIGNAL_PARTS)[number];

export interface LearningProfileView extends LearningProfile {
  signals: Array<{ part: ProfileSignalPart; label_ar: string; used_for_ar: string; count: number; reset_at: number | null }>;
  /** «تفضيلاتك تغيّر طريقة الشرح فقط، ولا تغيّر الحقائق الطبية ولا مصادرها» */
  facts_note_ar: string;
  /** measured from attempts (estimate) — null with too little data */
  measured_pace: { median_seconds_per_question: number | null; median_seconds_per_card: number | null; sample: number };
  updated_at: number | null;
}

export interface LearningProfilePatch {
  self_level?: string;
  subjects_studied?: string[];
  preferences?: Partial<LearningProfile['preferences']>;
  pace_minutes_per_day?: number | null;
}

export interface ProfileResetRequest {
  part: ProfileSignalPart;
}

// ───────── planner (§45) ─────────
export interface PlanFeasibility {
  feasible: boolean;
  required_minutes: number;
  available_minutes: number;
  study_days: number;
  summary_ar: string;
  /** what could not be placed — said explicitly, never squeezed into the last day */
  unfit_ar: string[];
  /** basis of the minute estimates (e.g. «4 دقائق تقديرًا لكل صفحة») */
  estimates_ar: string[];
}

export interface StudyPlanView {
  id: string;
  title: string;
  status: 'active' | 'archived';
  config: StudyPlanConfig;
  timezone: string;
  version: number;
  today: string;
  /** days from today to the exam date (owner timezone) */
  days_left: number | null;
  tasks: PlanTaskView[];
  feasibility: PlanFeasibility;
  last_report: PlanRebalanceReport | null;
  last_rebalanced_at: number | null;
  /** unfinished tasks of past days (the plan is behind) */
  behind: number;
  created_at: number;
  updated_at: number;
}

export interface PlanPreviewResponse {
  tasks: PlanTaskView[];
  feasibility: PlanFeasibility;
  today: string;
}

export interface PlanListResponse {
  items: Array<Pick<StudyPlanView, 'id' | 'title' | 'status' | 'today' | 'days_left' | 'behind' | 'created_at' | 'updated_at'> & { exam_date: string }>;
}

export interface PlanTaskUpdateRequest {
  status: 'todo' | 'done' | 'skipped';
}

export interface PlanRebalanceResponse {
  plan: StudyPlanView;
  report: PlanRebalanceReport & { moved_items_ar: string[] };
}

// ───────── one-tap revision (§45) ─────────
export interface RevisionSessionDetail extends RevisionSessionView {
  total_est_minutes: number;
  /** basis of the time estimates («نصف دقيقة لكل بطاقة — من متوسط مراجعاتك») */
  estimate_basis_ar: string[];
  created_at: number;
  /** set when the session was built for one weakness */
  weakness_id: string | null;
}

// ───────── home (§45) ─────────
export interface HomeDetail extends HomeView {
  day: string;
  timezone: string;
  due_today: number;
  plan_id: string | null;
  generated_at: number;
}

// ───────── Exam DNA (§40) ─────────
export interface ExamDnaDetail extends ExamDnaView {
  sources: Array<{ source_id: string; title: string; source_type: string; publication_date: string | null; unique_questions: number; occurrences: number }>;
  by_lecture: Array<{ lecture_source_id: string; title: string; unique: number; denominator_unique: number }>;
  unclassified: { concept: number; item_type: number; lecture: number };
  /** how repeats are counted */
  counting_note_ar: string;
  generated_at: number;
}

export interface ExamRelevanceView {
  question_id: string | null;
  concept_id: string | null;
  /** an importance indicator inside the owner's archive — NOT a probability */
  level: 'high' | 'medium' | 'low' | 'not_in_sample';
  level_label_ar: string;
  reasons_ar: string[];
  counts: { concept_unique: number; concept_occurrences: number; question_occurrences: number; files_with_question: number; lecture_mentions: number; sample_unique: number };
  note_ar: string;
}

// ───────── progress separation (§45) ─────────
export interface SourceProgressDetail extends SourceProgressView {
  title: string;
  reading: { version_id: string | null; pages_viewed: number; pages_total: number | null };
  explanation: { artifact_id: string | null; sections_covered: number; sections_total: number; status: string | null };
  practice: { question_attempts: number; scored_attempts: number; card_reviews: number };
  mastery: { sample: number; basis_ar: string };
  /** «فتح الملف أو التمرير لا يُعد إتمامًا ولا إتقانًا» */
  notes_ar: string[];
}

export interface SourceProgressListResponse {
  items: SourceProgressDetail[];
}

// ───────── cloze helpers (pure; the web renders offline with the same rules) ─────────
/** `{{c1::answer}}` or `{{c1::answer::hint}}` — Anki's cloze syntax. */
export const CLOZE_PATTERN = /\{\{c(\d{1,3})::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g;

export interface ClozeSegment {
  t: string;
  /** text — plain; blank — the hidden part of the asked index; answer — the revealed answer of the asked index */
  role: 'text' | 'blank' | 'answer';
}

/** Distinct cloze indexes in ascending order. */
export function clozeIndexes(text: string): number[] {
  const out = new Set<number>();
  for (const m of text.matchAll(CLOZE_PATTERN)) {
    const n = Number(m[1]);
    if (n >= 1) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

/** Segments of a cloze text for one index: front hides it («[…]» or «[hint]»), back reveals it. Other indexes are shown. */
export function clozeSegments(text: string, index: number, side: 'front' | 'back'): ClozeSegment[] {
  const out: ClozeSegment[] = [];
  let last = 0;
  const push = (seg: ClozeSegment) => {
    if (!seg.t) return;
    const prev = out[out.length - 1];
    if (prev && prev.role === 'text' && seg.role === 'text') prev.t += seg.t;
    else out.push(seg);
  };
  for (const m of text.matchAll(CLOZE_PATTERN)) {
    const at = m.index ?? 0;
    push({ t: text.slice(last, at), role: 'text' });
    const n = Number(m[1]);
    const answer = m[2] ?? '';
    const hint = m[3];
    if (n === index) push(side === 'front' ? { t: hint ? `[${hint}]` : '[…]', role: 'blank' } : { t: answer, role: 'answer' });
    else push({ t: answer, role: 'text' });
    last = at + m[0].length;
  }
  push({ t: text.slice(last), role: 'text' });
  return out;
}
