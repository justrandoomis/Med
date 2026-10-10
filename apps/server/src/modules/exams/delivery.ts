// Delivery of exam items (AC-19): ExamItemView carries ONLY what is needed to answer — no key, explanation,
// distractor explanations, lecture-link reasons, section/topic titles, source previews, evidence ids, or media
// file names/captions. Media go through short-lived exam-media tokens served WITHOUT the original file name.
import { EXAM_ITEM_ORIGIN_LABELS_AR, type ExamItemDeliveryView, type ExamItemOrigin, type ExamItemView, type Paragraph, type QuestionValidation, type RichText, type Run } from '@medlevo/shared';
import type { AppContext } from '../../context';
import { fromJson } from '../../db/db';
import { blockingIssues } from '../questions/validate';
import { hmacSha256, safeEqual } from '../../lib/hash';
import { deriveKey, loadOrCreateServerSecret } from '../../lib/secret';
import { PURGED_ITEM_REASON_AR, examItems, existingVersions, type ExamItemRecord, type ExamRow } from './store';

export const MEDIA_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;

const LATIN_LABELS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
const ARABIC_LABELS = ['أ', 'ب', 'ج', 'د', 'هـ', 'و', 'ز', 'ح'];
const ARABIC_LETTER = /^[ء-ي]/;

/** Display labels by POSITION (never the source label — the order may be shuffled). */
export function displayLabels(sourceLabels: Array<string | null>, n: number): string[] {
  const arabic = sourceLabels.filter((l): l is string => !!l).some((l) => ARABIC_LETTER.test(l));
  const set = arabic ? ARABIC_LABELS : LATIN_LABELS;
  return Array.from({ length: n }, (_, i) => set[i] ?? String(i + 1));
}

const ORDER_PHRASES = /\b(all of the above|none of the above|neither of the above|both of the above)\b|جميع ما (?:سبق|ذكر)|كل ما سبق|لا شيء مما سبق|كلاهما/i;
// «A and B», «Both B and C», «أ و ب» — option letters referenced by another option (case-sensitive letters)
const LETTER_REFERENCES = /(?:^|[\s(])(?:[A-E]|[أبجد])\s*(?:and|&|,|و)\s*(?:[A-E]|[أبجد])(?=$|[\s).,])/;

/** Options whose text depends on the order («all of the above», «A and B») — the question is never shuffled. */
export function isOrderDependent(optionTexts: string[]): boolean {
  return optionTexts.some((t) => ORDER_PHRASES.test(t) || LETTER_REFERENCES.test(t.trim()));
}

/**
 * Delivery order of option ids: shuffled only when the policy allows it, the version allows it and nothing depends
 * on the order; options with pinned_position keep their place (§38).
 */
export function optionOrder(
  options: Array<{ id: string; ord: number; pinned: boolean; text: string }>,
  allowShuffle: boolean,
  rand: () => number,
): string[] {
  const sorted = [...options].sort((a, b) => a.ord - b.ord);
  if (!allowShuffle || sorted.length < 3 || isOrderDependent(sorted.map((o) => o.text))) return sorted.map((o) => o.id);
  const free = sorted.filter((o) => !o.pinned);
  for (let i = free.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [free[i], free[j]] = [free[j]!, free[i]!];
  }
  let k = 0;
  return sorted.map((o) => (o.pinned ? o.id : free[k++]!.id));
}

/** RichText with only presentational fields (no claim / evidence / term ids that could point at the answer). */
export function sanitizeRichText(rt: RichText | null | undefined): RichText {
  if (!rt || !Array.isArray(rt.paragraphs)) return { v: 1, paragraphs: [] };
  return {
    v: 1,
    paragraphs: rt.paragraphs.map((p): Paragraph => {
      const out: Paragraph = { dir: p.dir, runs: p.runs.map(cleanRun) };
      if (p.kind) out.kind = p.kind;
      if (p.level) out.level = p.level;
      return out;
    }),
  };
}

function cleanRun(r: Run): Run {
  const out: Run = { t: r.t };
  if (r.dir) out.dir = r.dir;
  if (r.lang) out.lang = r.lang;
  if (r.kind && r.kind !== 'term') out.kind = r.kind;
  if (r.marks?.length) out.marks = [...r.marks];
  return out;
}

// G5 / AC-19: an answer mark printed (or OCR-read) next to an option — a tick, a cross, a lone asterisk, «(correct)»,
// or an inline «Answer: B» glued to the last option — is not part of the option. The vault keeps the original text
// (and the parser records ticks as unofficial marks); the item DELIVERED for answering never shows them.
const MARK_GLYPHS = /\s*[✓✔☑✅✗✘☒❌❎]️?/gu;
const LEADING_ASTERISK = /^\s*\*+\s*/;
const TRAILING_MARKS =
  /\s*(?:\*+|\((?:correct(?: answer)?|right answer|answer|key)\)|\((?:الإجابة|الاجابة|الجواب) (?:الصحيحة|الصحيح)\)|(?:answer|ans|key|correct answer)\s*[:：]\s*\(?[A-Ha-h]\)?\.?|(?:الإجابة|الاجابة|الجواب)(?: الصحيحة| الصحيح)?\s*[:：]\s*\(?(?:أ|ب|ج|د|هـ|ه|و)\)?\.?)\s*$/iu;

/** Option text as delivered for answering: answer marks removed (the text itself unchanged otherwise). */
export function withoutAnswerMarks(rt: RichText): RichText {
  return {
    ...rt,
    paragraphs: rt.paragraphs.map((p) => {
      const runs = p.runs.map((r) => ({ ...r, t: r.t.replace(MARK_GLYPHS, '') }));
      if (runs[0]) runs[0] = { ...runs[0], t: runs[0].t.replace(LEADING_ASTERISK, '').replace(/^\s+/u, '') };
      for (let i = runs.length - 1; i >= 0; i--) {
        const t = runs[i]!.t.replace(TRAILING_MARKS, '').replace(/\s+$/u, '');
        runs[i] = { ...runs[i]!, t };
        if (t) break;
      }
      return { ...p, runs: runs.filter((r) => r.t.length > 0) };
    }),
  };
}

// ───────── media ─────────
interface FigureFile {
  file_id: string;
}

/** Image files of the figures attached to a question (via its occurrences' parsed figure regions). */
export function questionMediaFiles(ctx: AppContext, questionId: string): { fileIds: string[]; figuresWithoutFile: number } {
  const occ = ctx.db.all<{ parse_json: string | null }>(
    `SELECT o.parse_json FROM question_occurrence o JOIN source s ON s.id = o.source_id
      WHERE o.question_id = ? AND s.deleted_at IS NULL ORDER BY o.status = 'current' DESC, o.created_at, o.ord`,
    [questionId],
  );
  for (const o of occ) {
    const regions = fromJson<{ figure_region_ids?: string[] }>(o.parse_json, {})?.figure_region_ids ?? [];
    if (regions.length === 0) continue;
    const files = ctx.db.all<FigureFile>(
      `SELECT file_id FROM image_asset WHERE region_id IN (${regions.map(() => '?').join(',')}) AND file_id IS NOT NULL ORDER BY created_at`,
      regions,
    );
    const ids = [...new Set(files.map((f) => f.file_id))];
    return { fileIds: ids, figuresWithoutFile: ids.length === 0 ? regions.length : 0 };
  }
  return { fileIds: [], figuresWithoutFile: 0 };
}

let mediaKey: { dir: string; key: Buffer } | null = null;
function key(ctx: AppContext): Buffer {
  if (!mediaKey || mediaKey.dir !== ctx.config.dataDir) mediaKey = { dir: ctx.config.dataDir, key: deriveKey(loadOrCreateServerSecret(ctx.config.dataDir), 'exam-media') };
  return mediaKey.key;
}

export function createMediaToken(ctx: AppContext, attemptId: string, fileId: string, ttlMs = MEDIA_TOKEN_TTL_MS): { token: string; expiresAt: number } {
  const expiresAt = ctx.clock.now() + ttlMs;
  const payload = Buffer.from(JSON.stringify({ a: attemptId, f: fileId, e: expiresAt })).toString('base64url');
  return { token: `${payload}.${hmacSha256(key(ctx), payload).toString('base64url')}`, expiresAt };
}

export function verifyMediaToken(ctx: AppContext, token: string): { attemptId: string; fileId: string } | null {
  if (typeof token !== 'string' || token.length > 600) return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  if (!safeEqual(token.slice(dot + 1), hmacSha256(key(ctx), payload).toString('base64url'))) return null;
  try {
    const d = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { a?: unknown; f?: unknown; e?: unknown };
    if (typeof d.a !== 'string' || typeof d.f !== 'string' || typeof d.e !== 'number') return null;
    if (ctx.clock.now() >= d.e) return null;
    return { attemptId: d.a, fileId: d.f };
  } catch {
    return null;
  }
}

// ───────── items ─────────
interface VersionLite {
  id: string;
  qtype: ExamItemView['qtype'];
  stem_json: string;
  has_negation: number;
  negation_terms_json: string | null;
}

/**
 * The origin KIND of an item (pinned in items_json at creation; the question row for older records). Only the kind
 * and its generic label are delivered — never the question source's name (AC-19).
 */
function itemOrigin(ctx: AppContext, rec: ExamItemRecord): { origin_type: ExamItemOrigin; origin_label_ar: string } {
  const pinned = rec.origin_type as ExamItemOrigin | undefined;
  const t: ExamItemOrigin = pinned ?? ctx.db.get<{ origin_type: ExamItemOrigin }>('SELECT origin_type FROM question WHERE id = ?', [rec.question_id])?.origin_type ?? 'source';
  const origin_type: ExamItemOrigin = t === 'generated' || t === 'owner' ? t : 'source';
  return { origin_type, origin_label_ar: EXAM_ITEM_ORIGIN_LABELS_AR[origin_type] };
}

/** ExamItemDeliveryView[] of an exam (pinned versions, delivery order, neutral media, origin kind). */
export function deliverItems(ctx: AppContext, exam: ExamRow, attemptId: string): { items: ExamItemDeliveryView[]; mediaExpiresAt: number | null } {
  const records = examItems(exam);
  let mediaExpiresAt: number | null = null;
  const items = records.map((rec, index): ExamItemDeliveryView => {
    const origin = itemOrigin(ctx, rec);
    const v = ctx.db.get<VersionLite>('SELECT id, qtype, stem_json, has_negation, negation_terms_json FROM question_version WHERE id = ?', [rec.question_version_id]);
    if (!v) {
      // purged with its source after the exam was created: nothing to answer, never scored (reason in unscored_reasons)
      const gone: ExamItemDeliveryView = {
        ...origin,
        index,
        question_id: rec.question_id,
        question_version_id: rec.question_version_id,
        qtype: 'sba',
        stem: { v: 1, paragraphs: [{ dir: 'rtl', runs: [{ t: PURGED_ITEM_REASON_AR }] }] },
        options: [],
        has_negation: false,
        negation_terms: [],
        media: [],
        scored: false,
      };
      return gone;
    }
    const opts = new Map(
      ctx.db
        .all<{ id: string; text_json: string }>('SELECT id, text_json FROM question_option WHERE question_version_id = ?', [rec.question_version_id])
        .map((o) => [o.id, o.text_json]),
    );
    const media = questionMediaFiles(ctx, rec.question_id).fileIds.map((fileId, i) => {
      const t = createMediaToken(ctx, attemptId, fileId);
      mediaExpiresAt = mediaExpiresAt === null ? t.expiresAt : Math.min(mediaExpiresAt, t.expiresAt);
      return { token_url: `/api/exams/media/${t.token}`, alt_ar: `الصورة ${i + 1} المرفقة بالسؤال` };
    });
    const item: ExamItemDeliveryView = {
      ...origin,
      index,
      question_id: rec.question_id,
      question_version_id: rec.question_version_id,
      qtype: v?.qtype ?? 'sba',
      stem: sanitizeRichText(fromJson<RichText | null>(v?.stem_json ?? null, null)),
      options: rec.option_order.map((id, i) => ({
        id,
        display_label: rec.display_labels[i] ?? String(i + 1),
        text: withoutAnswerMarks(sanitizeRichText(fromJson<RichText | null>(opts.get(id) ?? null, null))),
      })),
      has_negation: v?.has_negation === 1,
      negation_terms: fromJson<string[]>(v?.negation_terms_json ?? null, []) ?? [],
      media,
      scored: rec.scored,
    };
    return item;
  });
  return { items, mediaExpiresAt };
}

/** G5 / AC-19: shown with the item BEFORE answering — never the key the blocking check quotes («مفتاح المصدر («B» …)»). */
export const KEY_UNDER_REVIEW_AR = 'مفتاح هذا السؤال يحتاج مراجعتك قبل اعتماده في التقييم (يظهر سبب ذلك كاملًا بعد إجابتك).';
const KEY_CHECKS = new Set(['key_bound', 'key_conflict']);

function preAnswerReason(ctx: AppContext, r: ExamItemRecord): string {
  const v = ctx.db.get<{ validation_json: string | null }>('SELECT validation_json FROM question_version WHERE id = ?', [r.question_version_id]);
  const first = blockingIssues(fromJson<QuestionValidation | null>(v?.validation_json ?? null, null))[0];
  if (first && KEY_CHECKS.has(first.check)) return KEY_UNDER_REVIEW_AR;
  return r.unscored_reason_ar ?? 'لا يُحتسب في النتيجة.';
}

/** Unscored reasons by item index (practice: shown next to the item, AC-14; purged questions in any mode). */
export function unscoredReasons(ctx: AppContext, records: ExamItemRecord[]): Record<string, string> {
  const alive = existingVersions(ctx.db, records);
  const out: Record<string, string> = {};
  records.forEach((r, i) => {
    if (!alive.has(r.question_version_id)) out[String(i)] = PURGED_ITEM_REASON_AR;
    else if (!r.scored) out[String(i)] = preAnswerReason(ctx, r);
  });
  return out;
}
