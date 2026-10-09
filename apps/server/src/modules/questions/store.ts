// Persistence and read models of the Question Vault. Versions are append-only for content (stem, options, key):
// a version that was attempted (or placed in an exam) is never modified — corrections create a new version and
// attempts keep pointing at the version they answered (§36, AC-26). Only derived quality metadata
// (validation / extraction_status) may be refreshed in place.
import {
  ANSWER_STATUS_LABELS_AR,
  SCORABLE_ANSWER_STATUSES,
  normalizeForSearch,
  pageDisplayLabel,
  parseRichText,
  richTextFromPlain,
  richTextToPlain,
  type AnswerStatus,
  type DuplicateView,
  type LectureLinkView,
  type NormBox,
  type QuestionOccurrenceView,
  type QuestionOptionView,
  type QuestionType,
  type QuestionValidation,
  type QuestionVersionView,
  type QuestionView,
  type RichText,
} from '@medlevo/shared';
import type { AppContext } from '../../context';
import { fromJson, toJson } from '../../db/db';
import { AppError } from '../../lib/errors';
import { newId } from '../../lib/ids';
import { fingerprint, itemTypeOf, negationTerms, richTextWithNegation } from './text';
import { blockingIssues } from './validate';

// ───────── rows ─────────
export interface QuestionRow {
  id: string;
  origin_type: 'source' | 'generated' | 'owner';
  current_version_id: string | null;
  status: QuestionView['status'];
  course_node_id: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  retired_reason: string | null;
}

export interface VersionRow {
  id: string;
  question_id: string;
  version_no: number;
  kind: QuestionVersionView['kind'];
  derived_from_version_id: string | null;
  lang: string | null;
  qtype: QuestionType;
  item_type: string | null;
  stem_json: string;
  stem_raw: string | null;
  has_negation: number;
  negation_terms_json: string | null;
  shuffle_allowed: number;
  extraction_status: QuestionVersionView['extraction_status'];
  answer_status: AnswerStatus;
  correct_option_ids_json: string | null;
  key_details_json: string | null;
  explanation_json: string | null;
  distractor_explanations_json: string | null;
  learning_objective: string | null;
  difficulty_est: string | null;
  owner_reviewed_fields_json: string | null;
  validation_json: string | null;
  created_by: QuestionVersionView['created_by'];
  model: string | null;
  job_id: string | null;
  created_at: number;
  fingerprint: string | null;
  note: string | null;
}

export interface OptionRow {
  id: string;
  question_version_id: string;
  option_key: string;
  source_label: string | null;
  ord: number;
  text_json: string;
  raw_text: string | null;
  region_id: string | null;
  pinned_position: number;
}

export interface OccurrenceRow {
  id: string;
  question_id: string;
  question_version_id: string;
  source_id: string;
  source_version_id: string;
  section_key: string;
  printed_number: string | null;
  page_ids_json: string;
  region_ids_json: string;
  created_at: number;
  item_key: string | null;
  section_title: string | null;
  option_labels_json: string | null;
  raw_text: string | null;
  boxes_json: string | null;
  content_hash: string | null;
  ord: number | null;
  status: 'current' | 'not_found';
  parse_json: string | null;
}

/** What the parser saw for one occurrence (re-validation needs it without re-parsing). */
export interface OccurrenceParse {
  issues: import('@medlevo/shared').QuestionValidationIssue[];
  figure_region_ids: string[];
  uncertain: Array<{ where: 'stem' | 'option'; label: string | null; reason: string }>;
}

export interface OccurrenceBox {
  page_id: string;
  page_index: number;
  region_id: string | null;
  bbox: NormBox | null;
}

export const ORIGIN_GENERATED_AR = 'سؤال مولد بواسطة MedLevo من المصادر المحددة';
export const ORIGIN_OWNER_AR = 'سؤال أضفته بنفسك';

// ───────── reads ─────────
export function getQuestionRow(ctx: AppContext, id: string): QuestionRow {
  const q = ctx.db.get<QuestionRow>('SELECT * FROM question WHERE id = ? AND deleted_at IS NULL', [id]);
  if (!q) throw new AppError('NOT_FOUND', 'السؤال غير موجود (ربما حُذف مصدره نهائيًا).', 404);
  return q;
}

export function getVersionRow(ctx: AppContext, id: string): VersionRow {
  const v = ctx.db.get<VersionRow>('SELECT * FROM question_version WHERE id = ?', [id]);
  if (!v) throw new AppError('NOT_FOUND', 'نسخة السؤال غير موجودة.', 404);
  return v;
}

export function currentVersion(ctx: AppContext, q: QuestionRow): VersionRow {
  if (!q.current_version_id) throw new AppError('CONFLICT', 'لا توجد نسخة حالية لهذا السؤال.', 409);
  return getVersionRow(ctx, q.current_version_id);
}

export function optionRows(ctx: AppContext, versionId: string): OptionRow[] {
  return ctx.db.all<OptionRow>('SELECT * FROM question_option WHERE question_version_id = ? ORDER BY ord', [versionId]);
}

/** Attempted, or placed in an exam → immutable. */
export function isVersionLocked(ctx: AppContext, versionId: string): boolean {
  return !!ctx.db.get(
    `SELECT 1 AS x WHERE EXISTS (SELECT 1 FROM question_attempt WHERE question_version_id = ?)
        OR EXISTS (SELECT 1 FROM written_attempt WHERE question_version_id = ?)
        OR EXISTS (SELECT 1 FROM exam e, json_each(e.items_json) j WHERE json_valid(e.items_json) AND json_extract(j.value, '$.question_version_id') = ?)`,
    [versionId, versionId, versionId],
  );
}

export interface OccurrenceVersionState {
  /** occurrences in live sources */
  total: number;
  /** occurrences in the version of their source that is in force (Source Freeze, else the current version) */
  inForce: Set<string>;
  /** sources whose version in force (already extracted) no longer contains this question */
  supersededIn: Array<{ source_id: string; source_title: string; version_no: number | null }>;
}

/**
 * Which occurrences belong to the source version in force. A replaced question source (new version, §18) keeps
 * the old version's occurrences for history and attempts, but once the version in force was extracted only ITS
 * occurrences (and keys) count. Before that, nothing is considered superseded.
 */
export function occurrenceVersionState(ctx: AppContext, questionId: string): OccurrenceVersionState {
  const rows = ctx.db.all<{ id: string; source_id: string; source_title: string; source_version_id: string; active_version_id: string | null; active_extracted: number; active_no: number | null }>(
    `SELECT o.id, o.source_id, s.title AS source_title, o.source_version_id,
            COALESCE(s.frozen_version_id, s.current_version_id) AS active_version_id,
            EXISTS (SELECT 1 FROM question_extraction x WHERE x.version_id = COALESCE(s.frozen_version_id, s.current_version_id)
                      AND x.status <> 'nothing_found') AS active_extracted,
            (SELECT v.version_no FROM source_version v WHERE v.id = COALESCE(s.frozen_version_id, s.current_version_id)) AS active_no
       FROM question_occurrence o JOIN source s ON s.id = o.source_id
      WHERE o.question_id = ? AND s.deleted_at IS NULL`,
    [questionId],
  );
  const inForce = new Set<string>();
  const superseded = new Map<string, { source_id: string; source_title: string; version_no: number | null }>();
  for (const r of rows) {
    if (r.active_extracted !== 1 || r.source_version_id === r.active_version_id) inForce.add(r.id);
    else superseded.set(r.source_id, { source_id: r.source_id, source_title: r.source_title, version_no: r.active_no });
  }
  for (const r of rows) if (inForce.has(r.id)) superseded.delete(r.source_id);
  return { total: rows.length, inForce, supersededIn: [...superseded.values()] };
}

export function attemptsByVersion(ctx: AppContext, questionId: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of ctx.db.all<{ v: string; n: number }>(
    `SELECT question_version_id AS v, COUNT(*) AS n FROM question_attempt WHERE question_id = ? GROUP BY question_version_id`,
    [questionId],
  ))
    out[r.v] = r.n;
  return out;
}

// ───────── writes ─────────
export interface NewOption {
  option_key: string;
  source_label: string | null;
  text: string;
  raw_text: string | null;
  region_id: string | null;
  pinned_position?: boolean;
}

export interface NewVersionInput {
  questionId: string;
  kind: QuestionVersionView['kind'];
  derivedFrom: string | null;
  qtype: QuestionType;
  stemText: string;
  stemRaw: string | null;
  options: NewOption[];
  answerStatus: AnswerStatus;
  /** option KEYS (stable) of the correct option(s) */
  correctOptionKeys: string[] | null;
  keyDetails: QuestionVersionView['key_details'];
  explanation?: string | RichText | null;
  learningObjective?: string | null;
  ownerReviewedFields?: string[];
  validation: QuestionValidation | null;
  extractionStatus: QuestionVersionView['extraction_status'];
  createdBy: QuestionVersionView['created_by'];
  model?: string | null;
  jobId?: string | null;
  note?: string | null;
  lang?: string | null;
  itemType?: string | null;
  distractorExplanations?: Record<string, RichText> | null;
}

export function detectLang(text: string): string {
  const ar = (text.match(/[؀-ۿ]/g) ?? []).length;
  const la = (text.match(/[A-Za-z]/g) ?? []).length;
  if (ar && la) return ar > la ? 'ar' : la > ar * 3 ? 'en' : 'mixed';
  return ar ? 'ar' : 'en';
}

/** Insert a version + its options. Returns the version id and option ids by option_key. */
export function insertVersion(ctx: AppContext, input: NewVersionInput): { versionId: string; optionIds: Map<string, string> } {
  const now = ctx.clock.now();
  const versionId = newId(now);
  const no = (ctx.db.get<{ m: number | null }>('SELECT MAX(version_no) AS m FROM question_version WHERE question_id = ?', [input.questionId])?.m ?? 0) + 1;
  const optionIds = new Map<string, string>();
  for (const o of input.options) optionIds.set(o.option_key, newId(now));
  const terms = negationTerms(input.stemText);
  const correctIds = input.correctOptionKeys ? input.correctOptionKeys.map((k) => optionIds.get(k)).filter((x): x is string => !!x) : null;
  const explanation =
    input.explanation == null ? null : typeof input.explanation === 'string' ? richTextFromPlain(input.explanation) : parseRichText(input.explanation);
  ctx.db.run(
    `INSERT INTO question_version (id, question_id, version_no, kind, derived_from_version_id, lang, qtype, item_type, stem_json, stem_raw, has_negation,
       negation_terms_json, shuffle_allowed, extraction_status, answer_status, correct_option_ids_json, key_details_json, explanation_json,
       distractor_explanations_json, learning_objective, difficulty_est, rubric_json, owner_reviewed_fields_json, validation_json, created_by, model, job_id,
       created_at, fingerprint, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      versionId,
      input.questionId,
      no,
      input.kind,
      input.derivedFrom,
      input.lang ?? detectLang(input.stemText),
      input.qtype,
      input.itemType ?? itemTypeOf(input.stemText),
      toJson(richTextWithNegation(input.stemText)),
      input.stemRaw,
      terms.length > 0 ? 1 : 0,
      toJson(terms),
      input.options.some((o) => o.pinned_position) ? 0 : 1,
      input.extractionStatus,
      input.answerStatus,
      correctIds ? toJson(correctIds) : null,
      input.keyDetails ? toJson(input.keyDetails) : null,
      explanation ? toJson(explanation) : null,
      input.distractorExplanations ? toJson(input.distractorExplanations) : null,
      input.learningObjective ?? null,
      toJson(input.ownerReviewedFields ?? []),
      input.validation ? toJson(input.validation) : null,
      input.createdBy,
      input.model ?? null,
      input.jobId ?? null,
      now,
      fingerprint(input.stemText, input.options.map((o) => o.text)),
      input.note ?? null,
    ],
  );
  input.options.forEach((o, i) => {
    ctx.db.run(
      `INSERT INTO question_option (id, question_version_id, option_key, source_label, ord, text_json, raw_text, region_id, pinned_position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [optionIds.get(o.option_key)!, versionId, o.option_key, o.source_label, i, toJson(richTextFromPlain(o.text)), o.raw_text, o.region_id, o.pinned_position ? 1 : 0],
    );
  });
  return { versionId, optionIds };
}

/** Options of a version as NewOption (to derive a new version that keeps option identities). */
export function optionsAsInput(ctx: AppContext, versionId: string): NewOption[] {
  return optionRows(ctx, versionId).map((o) => ({
    option_key: o.option_key,
    source_label: o.source_label,
    text: richTextToPlain(fromJson<RichText | null>(o.text_json, null)),
    raw_text: o.raw_text,
    region_id: o.region_id,
    pinned_position: o.pinned_position === 1,
  }));
}

export function stemText(v: Pick<VersionRow, 'stem_json'>): string {
  return richTextToPlain(fromJson<RichText | null>(v.stem_json, null));
}

/** A new version that copies `from` and overrides some fields (content of `from` is never touched). */
export function deriveVersion(
  ctx: AppContext,
  from: VersionRow,
  over: Partial<Omit<NewVersionInput, 'questionId' | 'derivedFrom'>> & { kind: QuestionVersionView['kind']; createdBy: QuestionVersionView['created_by'] },
): { versionId: string; optionIds: Map<string, string> } {
  const prevOptions = optionsAsInput(ctx, from.id);
  const prevCorrectKeys = correctOptionKeys(ctx, from);
  return insertVersion(ctx, {
    questionId: from.question_id,
    derivedFrom: from.id,
    qtype: over.qtype ?? from.qtype,
    stemText: over.stemText ?? stemText(from),
    stemRaw: over.stemRaw !== undefined ? over.stemRaw : from.stem_raw,
    options: over.options ?? prevOptions,
    answerStatus: over.answerStatus ?? from.answer_status,
    correctOptionKeys: over.correctOptionKeys !== undefined ? over.correctOptionKeys : prevCorrectKeys,
    keyDetails: over.keyDetails !== undefined ? over.keyDetails : fromJson(from.key_details_json, null),
    explanation: over.explanation !== undefined ? over.explanation : fromJson<RichText | null>(from.explanation_json, null),
    learningObjective: over.learningObjective !== undefined ? over.learningObjective : from.learning_objective,
    ownerReviewedFields: over.ownerReviewedFields ?? fromJson<string[]>(from.owner_reviewed_fields_json, []) ?? [],
    validation: over.validation !== undefined ? over.validation : fromJson<QuestionValidation | null>(from.validation_json, null),
    extractionStatus: over.extractionStatus ?? from.extraction_status,
    kind: over.kind,
    createdBy: over.createdBy,
    model: over.model ?? null,
    jobId: over.jobId ?? null,
    note: over.note ?? null,
    lang: over.lang ?? from.lang,
    itemType: over.itemType ?? from.item_type,
    distractorExplanations: over.distractorExplanations !== undefined ? over.distractorExplanations : fromJson(from.distractor_explanations_json, null),
  });
}

/** Stable option keys of the version's correct option(s). */
export function correctOptionKeys(ctx: AppContext, v: Pick<VersionRow, 'id' | 'correct_option_ids_json'>): string[] | null {
  const ids = fromJson<string[] | null>(v.correct_option_ids_json, null);
  if (!ids) return null;
  const byId = new Map(optionRows(ctx, v.id).map((o) => [o.id, o.option_key]));
  return ids.map((id) => byId.get(id)).filter((k): k is string => !!k);
}

export function setCurrentVersion(ctx: AppContext, questionId: string, versionId: string): void {
  ctx.db.run('UPDATE question SET current_version_id = ?, updated_at = ? WHERE id = ?', [versionId, ctx.clock.now(), questionId]);
  refreshFts(ctx, questionId);
}

/** question_fts holds ONE normalized row per question (current version): stem + options. */
export function refreshFts(ctx: AppContext, questionId: string): void {
  ctx.db.run('DELETE FROM question_fts WHERE question_id = ?', [questionId]);
  const q = ctx.db.get<{ current_version_id: string | null; deleted_at: number | null }>('SELECT current_version_id, deleted_at FROM question WHERE id = ?', [questionId]);
  if (!q?.current_version_id || q.deleted_at !== null) return;
  const v = getVersionRow(ctx, q.current_version_id);
  const opts = optionRows(ctx, v.id).map((o) => richTextToPlain(fromJson<RichText | null>(o.text_json, null)));
  ctx.db.run('INSERT INTO question_fts (question_id, version_id, text) VALUES (?, ?, ?)', [
    questionId,
    v.id,
    normalizeForSearch([stemText(v), ...opts].join('\n')),
  ]);
}

// ───────── views ─────────
interface PageLite {
  id: string;
  page_index: number;
  printed_label: string | null;
  kind: string;
}

function pagesById(ctx: AppContext, ids: string[]): Map<string, PageLite> {
  if (ids.length === 0) return new Map();
  const rows = ctx.db.all<PageLite>(`SELECT id, page_index, printed_label, kind FROM source_page WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
  return new Map(rows.map((r) => [r.id, r]));
}

export function pageLabel(p: PageLite): string {
  return pageDisplayLabel({ page_index: p.page_index, printed_label: p.printed_label, kind: p.kind as never }, { withFileIndex: false });
}

/** «ص 1» / «ص 1–2» / «صورة 1» for the origin label. */
function pagesLabel(pages: PageLite[]): string {
  if (pages.length === 0) return 'الصفحة غير معروفة';
  const sorted = [...pages].sort((a, b) => a.page_index - b.page_index);
  const first = pageLabel(sorted[0]!);
  if (sorted.length === 1) return first;
  const last = pageLabel(sorted[sorted.length - 1]!);
  const prefix = first.split(' ')[0]!;
  if (last.startsWith(`${prefix} `)) return `${first}–${last.slice(prefix.length + 1)}`;
  return `${first}–${last}`;
}

export function sourceOriginLabel(sourceTitle: string, pages: PageLite[], printedNumber: string | null, sectionKey: string, sectionTitle: string | null): string {
  const parts = ['سؤال من مصدر الأسئلة', sourceTitle, pagesLabel(pages), printedNumber ? `رقم السؤال ${printedNumber}` : 'سؤال بلا رقم مطبوع'];
  let label = parts.join(' — ');
  if (sectionKey && !sectionKey.startsWith('?')) label += ` (${sectionTitle ? sectionTitle.split(/\s+[—–-]\s+/)[0] : sectionKey.startsWith('sec-') ? `القسم ${sectionKey.slice(4)}` : `القسم ${sectionKey}`})`;
  return label;
}

export function occurrenceViews(ctx: AppContext, questionId: string, onlyCurrent = false): QuestionOccurrenceView[] {
  const rows = ctx.db.all<OccurrenceRow & { source_title: string; source_type: string }>(
    `SELECT o.*, s.title AS source_title, s.source_type FROM question_occurrence o JOIN source s ON s.id = o.source_id
      WHERE o.question_id = ? AND s.deleted_at IS NULL ${onlyCurrent ? "AND o.status = 'current'" : ''}
      ORDER BY o.created_at, o.ord`,
    [questionId],
  );
  return rows.map((o) => occurrenceView(ctx, o));
}

export function occurrenceView(ctx: AppContext, o: OccurrenceRow & { source_title: string; source_type: string }): QuestionOccurrenceView {
  const pageIds = fromJson<string[]>(o.page_ids_json, []) ?? [];
  const pages = pagesById(ctx, pageIds);
  const ordered = pageIds.map((id) => pages.get(id)).filter((p): p is PageLite => !!p);
  return {
    id: o.id,
    source_id: o.source_id,
    source_title: o.source_title,
    source_type: o.source_type,
    source_version_id: o.source_version_id,
    section_key: o.section_key,
    section_title: o.section_title,
    printed_number: o.printed_number,
    pages: ordered.map((p) => ({ page_id: p.id, page_index: p.page_index, label_ar: pageLabel(p) })),
    region_ids: fromJson<string[]>(o.region_ids_json, []) ?? [],
    origin_label_ar: sourceOriginLabel(o.source_title, ordered, o.printed_number, o.section_key, o.section_title),
  };
}

export function optionViews(ctx: AppContext, versionId: string): QuestionOptionView[] {
  return optionRows(ctx, versionId).map((o) => ({
    id: o.id,
    option_key: o.option_key,
    source_label: o.source_label,
    ord: o.ord,
    text: fromJson<RichText>(o.text_json, { v: 1, paragraphs: [] })!,
    raw_text: o.raw_text,
    region_id: o.region_id,
    pinned_position: o.pinned_position === 1,
  }));
}

export function versionView(ctx: AppContext, v: VersionRow): QuestionVersionView {
  return {
    id: v.id,
    question_id: v.question_id,
    version_no: v.version_no,
    kind: v.kind,
    derived_from_version_id: v.derived_from_version_id,
    lang: v.lang,
    qtype: v.qtype,
    item_type: v.item_type,
    stem: fromJson<RichText>(v.stem_json, { v: 1, paragraphs: [] })!,
    stem_raw: v.stem_raw,
    has_negation: v.has_negation === 1,
    negation_terms: fromJson<string[]>(v.negation_terms_json, []) ?? [],
    shuffle_allowed: v.shuffle_allowed === 1,
    extraction_status: v.extraction_status,
    answer_status: v.answer_status,
    correct_option_ids: fromJson<string[] | null>(v.correct_option_ids_json, null),
    key_details: fromJson(v.key_details_json, null),
    explanation: fromJson<RichText | null>(v.explanation_json, null),
    distractor_explanations: fromJson(v.distractor_explanations_json, null),
    learning_objective: v.learning_objective,
    difficulty_est: v.difficulty_est,
    owner_reviewed_fields: fromJson<string[]>(v.owner_reviewed_fields_json, []) ?? [],
    validation: fromJson<QuestionValidation | null>(v.validation_json, null),
    created_by: v.created_by,
    model: v.model,
    created_at: v.created_at,
    options: optionViews(ctx, v.id),
  };
}

export function lectureLinkViews(ctx: AppContext, questionId: string): LectureLinkView[] {
  const rows = ctx.db.all<{
    id: string;
    question_id: string;
    lecture_source_id: string;
    lecture_title: string;
    relation: LectureLinkView['relation'];
    score: number | null;
    reason: string;
    reason_json: string | null;
    answerable_from_lecture: number;
    origin: 'auto' | 'owner';
    status: LectureLinkView['status'];
    decision_reason: string | null;
  }>(
    `SELECT l.*, s.title AS lecture_title FROM question_lecture_link l JOIN source s ON s.id = l.lecture_source_id
      WHERE l.question_id = ? AND s.deleted_at IS NULL
      ORDER BY CASE l.status WHEN 'accepted' THEN 0 WHEN 'suggested' THEN 1 ELSE 2 END,
               CASE l.relation WHEN 'directly_covered' THEN 0 WHEN 'strongly_related' THEN 1 WHEN 'partially_covered' THEN 2 ELSE 3 END`,
    [questionId],
  );
  return rows.map((r) => linkView(ctx, r));
}

export function linkView(
  ctx: AppContext,
  r: {
    id: string;
    question_id: string;
    lecture_source_id: string;
    lecture_title: string;
    relation: LectureLinkView['relation'];
    score: number | null;
    reason: string;
    reason_json: string | null;
    answerable_from_lecture: number;
    origin: 'auto' | 'owner';
    status: LectureLinkView['status'];
    decision_reason: string | null;
  },
): LectureLinkView {
  const rj = fromJson<{ matched_terms?: string[]; lecture_page_ids?: string[] } | null>(r.reason_json, null) ?? {};
  const pageIds = rj.lecture_page_ids ?? [];
  const pages = pagesById(ctx, pageIds);
  return {
    id: r.id,
    question_id: r.question_id,
    lecture_source_id: r.lecture_source_id,
    lecture_title: r.lecture_title,
    relation: r.relation,
    score: r.score,
    reason: r.reason,
    matched_terms: rj.matched_terms ?? [],
    lecture_pages: pageIds
      .map((id) => pages.get(id))
      .filter((p): p is PageLite => !!p)
      .map((p) => ({ page_id: p.id, page_index: p.page_index, label_ar: pageLabel(p) })),
    answerable_from_lecture: r.answerable_from_lecture === 1,
    origin: r.origin,
    status: r.status,
    decision_reason: r.decision_reason,
  };
}

export function duplicateViews(ctx: AppContext, questionId: string): DuplicateView[] {
  const rows = ctx.db.all<{ id: string; question_a_id: string; question_b_id: string; kind: DuplicateView['kind']; similarity: number | null; blockers_json: string | null; status: DuplicateView['status'] }>(
    `SELECT d.* FROM question_duplicate d
       JOIN question qa ON qa.id = d.question_a_id AND qa.deleted_at IS NULL
       JOIN question qb ON qb.id = d.question_b_id AND qb.deleted_at IS NULL
      WHERE d.question_a_id = ? OR d.question_b_id = ? ORDER BY d.created_at`,
    [questionId, questionId],
  );
  return rows.map((r) => ({
    id: r.id,
    other_question_id: r.question_a_id === questionId ? r.question_b_id : r.question_a_id,
    kind: r.kind,
    similarity: r.similarity,
    blockers: fromJson<string[]>(r.blockers_json, []) ?? [],
    status: r.status,
  }));
}

export function originLabel(ctx: AppContext, q: QuestionRow, occ?: QuestionOccurrenceView[]): string {
  if (q.origin_type === 'generated') return ORIGIN_GENERATED_AR;
  if (q.origin_type === 'owner') return ORIGIN_OWNER_AR;
  const first = (occ ?? occurrenceViews(ctx, q.id))[0];
  return first ? first.origin_label_ar : 'سؤال من مصدر الأسئلة — المصدر غير متاح';
}

export function questionView(ctx: AppContext, id: string): QuestionView {
  const q = getQuestionRow(ctx, id);
  const v = currentVersion(ctx, q);
  const occ = occurrenceViews(ctx, q.id);
  const att = ctx.db.get<{ total: number; correct: number | null; last_at: number | null }>(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) AS correct, MAX(answered_at) AS last_at FROM question_attempt WHERE question_id = ?`,
    [q.id],
  );
  return {
    id: q.id,
    origin_type: q.origin_type,
    origin_label_ar: originLabel(ctx, q, occ),
    status: q.status,
    course_node_id: q.course_node_id,
    current: versionView(ctx, v),
    occurrences: occ,
    lecture_links: lectureLinkViews(ctx, q.id),
    duplicates: duplicateViews(ctx, q.id),
    attempts_summary: { total: att?.total ?? 0, correct: att?.correct ?? 0, last_at: att?.last_at ?? null },
    created_at: q.created_at,
    updated_at: q.updated_at,
  };
}

/** Whether an exam may SCORE this version, and why not. */
export function scorability(v: Pick<VersionRow, 'answer_status' | 'validation_json' | 'correct_option_ids_json'>): { scorable: boolean; reason_ar: string | null } {
  if (!SCORABLE_ANSWER_STATUSES.includes(v.answer_status)) {
    return { scorable: false, reason_ar: `${ANSWER_STATUS_LABELS_AR[v.answer_status]} — يُستخدم للتدريب غير المحسوب فقط.` };
  }
  const ids = fromJson<string[] | null>(v.correct_option_ids_json, null);
  if (!ids || ids.length === 0) return { scorable: false, reason_ar: 'لا توجد إجابة صحيحة محددة لهذه النسخة.' };
  const blockers = blockingIssues(fromJson<QuestionValidation | null>(v.validation_json, null));
  if (blockers.length > 0) return { scorable: false, reason_ar: `فحص مانع لم يُجتز: ${blockers[0]!.reason_ar}` };
  return { scorable: true, reason_ar: null };
}
