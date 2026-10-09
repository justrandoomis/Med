// Delivery of exam items (AC-19): ExamItemView carries ONLY what is needed to answer — no key, explanation,
// distractor explanations, lecture-link reasons, section/topic titles, source previews, evidence ids, or media
// file names/captions. Media go through short-lived exam-media tokens served WITHOUT the original file name.
import type { ExamItemView, Paragraph, RichText, Run } from '@medlevo/shared';
import type { AppContext } from '../../context';
import { fromJson } from '../../db/db';
import { hmacSha256, safeEqual } from '../../lib/hash';
import { deriveKey, loadOrCreateServerSecret } from '../../lib/secret';
import { examItems, type ExamItemRecord, type ExamRow } from './store';

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

/** ExamItemView[] of an exam (pinned versions, delivery order, neutral media). */
export function deliverItems(ctx: AppContext, exam: ExamRow, attemptId: string): { items: ExamItemView[]; mediaExpiresAt: number | null } {
  const records = examItems(exam);
  let mediaExpiresAt: number | null = null;
  const items = records.map((rec, index) => {
    const v = ctx.db.get<VersionLite>('SELECT id, qtype, stem_json, has_negation, negation_terms_json FROM question_version WHERE id = ?', [rec.question_version_id]);
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
    const item: ExamItemView = {
      index,
      question_id: rec.question_id,
      question_version_id: rec.question_version_id,
      qtype: v?.qtype ?? 'sba',
      stem: sanitizeRichText(fromJson<RichText | null>(v?.stem_json ?? null, null)),
      options: rec.option_order.map((id, i) => ({
        id,
        display_label: rec.display_labels[i] ?? String(i + 1),
        text: sanitizeRichText(fromJson<RichText | null>(opts.get(id) ?? null, null)),
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

/** Unscored reasons by item index (practice: shown next to the item, AC-14). */
export function unscoredReasons(records: ExamItemRecord[]): Record<string, string> {
  const out: Record<string, string> = {};
  records.forEach((r, i) => {
    if (!r.scored) out[String(i)] = r.unscored_reason_ar ?? 'لا يُحتسب في النتيجة.';
  });
  return out;
}
