// Progressive hints (§39, practice only): hint 1 points to the lecture section WITHOUT revealing the answer,
// hint 2 emphasises the clue words / negation in the stem; then the solution. Every hint served is recorded
// (exam_item_event), so the attempt's hints_used can never be lower than what was actually seen (AC-27).
import { normalizeForSearch, pageDisplayLabel, richTextToPlain, segmentRuns, detectDir, type HintView, type Paragraph, type RichText, type Run } from '@medlevo/shared';
import type { AppContext } from '../../context';
import { fromJson } from '../../db/db';
import { AppError } from '../../lib/errors';
import { newId } from '../../lib/ids';
import { getQuestion } from '../questions/service';
import { findClues } from './mistakes';
import { examItems, examPolicy, type ExamAttemptRow, type ExamRow } from './store';

export const ITEM_TYPE_LABELS_AR: Record<string, string> = {
  investigation: 'الفحوصات المناسبة',
  diagnosis: 'التشخيص',
  management: 'العلاج والتدبير',
  complications: 'المضاعفات',
  mechanism: 'الآلية',
  next_step: 'الخطوة التالية',
  clinical_feature: 'العلامات والأعراض',
  risk_factors: 'عوامل الخطر',
  recall: 'استرجاع معلومة من المحاضرة',
  vignette: 'تحليل حالة سريرية',
  interpretation: 'تفسير نتيجة',
};

const STOP = new Set(['the', 'and', 'with', 'from', 'that', 'this', 'which', 'what', 'following', 'most', 'likely', 'more', 'than', 'into', 'about']);

function tokens(text: string): Set<string> {
  return new Set(
    normalizeForSearch(text)
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length >= 4 && !STOP.has(t)),
  );
}

export function recordItemEvent(ctx: AppContext, attemptId: string, index: number, versionId: string, kind: 'hint_1' | 'hint_2' | 'solution_viewed'): void {
  ctx.db.run(
    `INSERT INTO exam_item_event (id, exam_attempt_id, item_index, question_version_id, kind, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (exam_attempt_id, item_index, kind) DO NOTHING`,
    [newId(ctx.clock.now()), attemptId, index, versionId, kind, ctx.clock.now()],
  );
}

export function itemEvents(ctx: AppContext, attemptId: string, index: number): Set<string> {
  return new Set(ctx.db.all<{ kind: string }>('SELECT kind FROM exam_item_event WHERE exam_attempt_id = ? AND item_index = ?', [attemptId, index]).map((r) => r.kind));
}

/** Stem RichText with clue words bold (logical order preserved). */
export function emphasizeClues(stem: string): { rt: RichText; clues: HintView['clues'] } {
  const paragraphs: Paragraph[] = [];
  const allClues: HintView['clues'] = [];
  for (const line of stem.split(/\n+/).map((l) => l.trim()).filter(Boolean)) {
    const dir = detectDir(line);
    const clues = findClues(line);
    const runs: Run[] = [];
    let last = 0;
    for (const c of clues) {
      if (c.start > last) runs.push(...segmentRuns(line.slice(last, c.start), dir));
      runs.push(...segmentRuns(line.slice(c.start, c.end), dir).map((r) => ({ ...r, marks: ['b' as const] })));
      last = c.end;
      allClues.push({ text: c.text, why_ar: c.why_ar });
    }
    if (last < line.length) runs.push(...segmentRuns(line.slice(last), dir));
    paragraphs.push({ dir, runs });
  }
  return { rt: { v: 1, paragraphs }, clues: allClues };
}

export function serveHint(ctx: AppContext, exam: ExamRow, attempt: ExamAttemptRow, index: number, level: 1 | 2): HintView {
  const policy = examPolicy(exam);
  if (policy.hints === 'off') throw new AppError('FEATURE_DISABLED', 'التلميحات غير مفعّلة في هذا الاختبار؛ سياسته ثابتة منذ إنشائه.', 409);
  if (attempt.status === 'completed' || attempt.status === 'abandoned') throw new AppError('CONFLICT', 'انتهت هذه المحاولة؛ افتح الحل والأدلة بدل التلميح.', 409);
  const item = examItems(exam)[index];
  if (!item) throw new AppError('NOT_FOUND', 'السؤال غير موجود في هذه المحاولة.', 404);
  const events = itemEvents(ctx, attempt.id, index);
  if (level === 2 && !events.has('hint_1')) throw new AppError('CONFLICT', 'التلميحات متدرجة: اطلب التلميح الأول أولًا.', 409);

  const v = ctx.db.get<{ stem_json: string; item_type: string | null }>('SELECT stem_json, item_type FROM question_version WHERE id = ?', [item.question_version_id]);
  const stem = richTextToPlain(fromJson<RichText | null>(v?.stem_json ?? null, null));
  ctx.db.tx(() => recordItemEvent(ctx, attempt.id, index, item.question_version_id, level === 1 ? 'hint_1' : 'hint_2'));

  if (level === 2) {
    const { rt, clues } = emphasizeClues(stem);
    return {
      level: 2,
      title_ar: 'التلميح الثاني: الكلمات المفتاحية في السؤال',
      text_ar:
        clues.length > 0
          ? 'الكلمات المميزة أدناه تحدد المطلوب بالضبط. اقرأ السؤال مرة أخرى وانتبه لها قبل الاختيار.'
          : 'لا توجد كلمات مفتاحية واضحة في نص السؤال؛ اقرأه مرة أخرى بتمهل وحدد المطلوب بالضبط قبل الاختيار.',
      pages: [],
      stem: rt,
      clues,
    };
  }

  // hint 1: where to look — never a link reason, a narrow topic that names an option, or the key
  const optionTokens = new Set<string>();
  for (const o of ctx.db.all<{ text_json: string }>('SELECT text_json FROM question_option WHERE question_version_id = ?', [item.question_version_id])) {
    for (const t of tokens(richTextToPlain(fromJson<RichText | null>(o.text_json, null)))) optionTokens.add(t);
  }
  const q = getQuestion(ctx, item.question_id);
  const links = q.lecture_links.filter((l) => l.status !== 'rejected');
  const pages: HintView['pages'] = [];
  let heading: string | null = null;
  for (const l of links.slice(0, 2)) {
    let lp = l.lecture_pages.slice(0, 3);
    if (lp.length === 0 && q.origin_type === 'generated') {
      const c = ctx.db.get<{ evidence_json: string }>('SELECT evidence_json FROM generated_question_candidate WHERE question_id = ? ORDER BY created_at DESC LIMIT 1', [q.id]);
      const ids = fromJson<{ lecture_page_ids?: string[] }>(c?.evidence_json ?? null, {})?.lecture_page_ids ?? [];
      if (ids.length) {
        lp = ctx.db
          .all<{ id: string; page_index: number; printed_label: string | null; kind: string }>(
            `SELECT id, page_index, printed_label, kind FROM source_page WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY page_index LIMIT 3`,
            ids,
          )
          .map((p) => ({ page_id: p.id, page_index: p.page_index, label_ar: pageDisplayLabel({ page_index: p.page_index, printed_label: p.printed_label, kind: p.kind as never }, { withFileIndex: false }) }));
      }
    }
    for (const p of lp) pages.push({ source_id: l.lecture_source_id, lecture_title: l.lecture_title, page_id: p.page_id, label_ar: p.label_ar });
    if (!heading && lp[0]) {
      const h = ctx.db.get<{ text: string | null }>(`SELECT text FROM source_region WHERE page_id = ? AND kind = 'heading' ORDER BY reading_order LIMIT 1`, [lp[0].page_id]);
      const text = h?.text?.replace(/\s+/g, ' ').trim() ?? '';
      if (text && text.length <= 120 && ![...tokens(text)].some((t) => optionTokens.has(t))) heading = text;
    }
  }
  const kind = v?.item_type ? ITEM_TYPE_LABELS_AR[v.item_type] : null;
  let text: string;
  if (pages.length > 0) {
    const first = pages[0]!;
    const samePages = pages.filter((p) => p.source_id === first.source_id).map((p) => p.label_ar);
    text = `ارجع إلى محاضرة «${first.lecture_title}» — ${samePages.join('، ')}${heading ? `، تحت عنوان «${heading}»` : ''}.`;
  } else {
    text = 'لم يُربط هذا السؤال بمحاضرة بعد، لذلك لا يمكن الإشارة إلى قسم محدد دون كشف الإجابة.';
  }
  if (kind) text += ` السؤال يسأل عن: ${kind}.`;
  return { level: 1, title_ar: 'التلميح الأول: أين تبحث', text_ar: text, pages, stem: null, clues: [] };
}
