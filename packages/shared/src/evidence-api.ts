// Evidence module HTTP contract (/api/evidence) — Source Lock preview, evidence views, claims, ribbon,
// content change alerts (§08, §10, §11, §12, §18). Added by track C1 (docs/modules/evidence-search.md).
// The model-facing generation contract lives in ./evidence.ts and is unchanged.
import type { ProcessingStatus, SourceType } from './enums';
import type { EvidenceRibbonItem, EvidenceView } from './evidence';
import type { ResolvedScope } from './scope';

// ───────── Source Lock preview ─────────
export type ScopeOrigin = 'lecture' | 'reference' | 'my_notes';

export const SCOPE_ORIGIN_LABELS_AR: Record<ScopeOrigin, string> = {
  lecture: 'المحاضرة',
  reference: 'مرجع مختار',
  my_notes: 'ملاحظاتي (موثوقية منخفضة)',
};

export interface ScopeSourceView {
  source_id: string;
  title: string;
  source_type: SourceType;
  version_id: string;
  version_no: number;
  origin: ScopeOrigin;
  /** the version came from an explicit pin in the request */
  pinned: boolean;
  /** the version is the source's frozen version (Source Freeze) */
  frozen: boolean;
  /** the version is NOT the source's latest upload (a newer version exists) */
  newer_version_exists: boolean;
  processing_status: ProcessingStatus;
  /** My Notes are a low-assurance personal source (§09) */
  low_assurance: boolean;
}

export interface ScopeExclusion {
  source_id: string;
  title: string | null;
  reason_ar: string;
}

export interface ScopeResolveResponse {
  scope: ResolvedScope;
  sources: ScopeSourceView[];
  excluded: ScopeExclusion[];
}

// ───────── evidence ─────────
export interface FromRegionRequest {
  region_id: string;
  /** UTF-16 code-unit offsets into region.text; default = the whole region */
  start?: number;
  end?: number;
}

export interface EvidenceBatchRequest {
  ids: string[];
  /** versions the caller keeps on purpose (a frozen artifact's versions): not reported as replaced */
  pinned_version_ids?: string[];
}

export interface EvidenceBatchResponse {
  evidence: EvidenceView[];
  /** ids that do not exist (never shown as citations) */
  missing: string[];
}

export interface EvidenceRibbonResponse {
  items: EvidenceRibbonItem[];
  /** «عدد الجمل المرتبطة بدليل من كل مصدر — تغطية وليست صحة طبية» */
  note_ar: string;
}

// ───────── retrieval report (callers abstain precisely with it) ─────────
export interface SearchedVersionReport {
  version_id: string;
  source_id: string;
  source_title: string;
  source_type: SourceType;
  pages_total: number;
  pages_ready: number;
  /** failed / no text found / needs OCR */
  pages_unreadable: number;
  /** pending / processing (not searched yet) */
  pages_unprocessed: number;
}

export interface SearchedReport {
  versions: SearchedVersionReport[];
  pages_ready: number;
  pages_unreadable: number;
  pages_unprocessed: number;
  /** «بُحث في 4 صفحات معالَجة؛ صفحة واحدة غير مقروءة» */
  summary_ar: string;
  /** semantic retrieval is reported honestly when it was not used */
  semantic: { used: boolean; reason_ar?: string };
  /** owner-dictionary expansions that were applied (never seeded) */
  expansions: Array<{ from: string; to: string[] }>;
}

// ───────── content change alerts (§18) ─────────
export const CONTENT_ALERT_KINDS = ['source_updated', 'ocr_corrected', 'key_corrected', 'source_deleted', 'source_replaced', 'conflict_found', 'layout_changed'] as const;
export type ContentAlertKind = (typeof CONTENT_ALERT_KINDS)[number];

export const CONTENT_ALERT_KIND_LABELS_AR: Record<ContentAlertKind, string> = {
  source_updated: 'تحديث في المصدر',
  ocr_corrected: 'تصحيح نص مقروء آليًا (OCR)',
  key_corrected: 'تصحيح مفتاح إجابة',
  source_deleted: 'حذف مصدر',
  source_replaced: 'نسخة جديدة من المصدر',
  conflict_found: 'تعارض مكتشف',
  layout_changed: 'تغيّر في الترتيب البصري فقط',
};

export const ALERT_SEVERITY_LABELS_AR: Record<'info' | 'fact_change' | 'answer_change', string> = {
  info: 'للعلم',
  fact_change: 'قد تتغير معلومة',
  answer_change: 'قد تتغير إجابة',
};

export const ALERT_IMPACTS = ['still_valid', 'needs_regeneration', 'needs_review'] as const;
export type AlertImpact = (typeof ALERT_IMPACTS)[number];

export const ALERT_IMPACT_LABELS_AR: Record<AlertImpact, string> = {
  still_valid: 'ما زال صالحًا',
  needs_regeneration: 'يحتاج إعادة توليد',
  needs_review: 'يحتاج مراجعة',
};

export const DEPENDENT_TYPE_LABELS_AR: Record<string, string> = {
  artifact: 'محتوى مولَّد',
  question_version: 'سؤال',
  flashcard: 'بطاقة',
  exam: 'اختبار',
  message: 'رسالة محادثة',
  content_block: 'فقرة من كتاب الدراسة',
};

export interface ContentAlertItemView {
  type: string;
  id: string;
  impact: AlertImpact;
  impact_label_ar: string;
  /** kept on its version on purpose (artifact frozen or Source Freeze): shown with a warning, never changed */
  frozen: boolean;
  reason_ar: string | null;
  /** human title when known (artifact title / kind) */
  title: string | null;
}

export interface ContentAlertView {
  id: string;
  kind: ContentAlertKind;
  kind_label_ar: string;
  severity: 'info' | 'fact_change' | 'answer_change';
  severity_label_ar: string;
  source_id: string | null;
  source_title: string | null;
  source_version_id: string | null;
  from_version_id: string | null;
  summary: string;
  status: 'open' | 'acknowledged' | 'resolved';
  created_at: number;
  acknowledged_at: number | null;
  resolved_at: number | null;
  items: ContentAlertItemView[];
  counts: Record<AlertImpact, number>;
  /** deterministic comparison of the two versions when both are processed (null otherwise) */
  change: VersionChangeSummary | null;
}

export interface VersionChangeSummary {
  state: 'compared' | 'pending_processing';
  pages_compared: number;
  pages_changed: number[];
  /** numbers / units / negations present in one version only (normalized display strings) */
  critical_added: string[];
  critical_removed: string[];
  /** true when only whitespace / order differs (layout change, not a fact change) */
  text_identical: boolean;
  note_ar: string;
}

export interface ContentAlertsResponse {
  alerts: ContentAlertView[];
}
