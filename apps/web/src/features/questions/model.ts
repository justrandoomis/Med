// Pure helpers of the Question Vault UI (tested in model.test.ts).
import {
  ANSWER_STATUS_LABELS_AR,
  EXTRACTION_STATUS_LABELS_AR,
  LECTURE_LINK_LABELS_AR,
  QUESTION_STATUS_LABELS_AR,
  type AnswerStatus,
  type ExtractionStatus,
  type LectureLinkRelation,
  type LectureQuestionItem,
  type QuestionOptionView,
  type QuestionStatus,
  type QuestionValidationIssue,
  type QuestionVersionView,
  type RichText,
} from '@medlevo/shared';
import type { StatusTone } from '../../design';

export interface PillSpec {
  tone: StatusTone;
  label: string;
}

/** Key status — separate from extraction and from the question's status (§34). */
export function answerPill(s: AnswerStatus): PillSpec {
  const tone: StatusTone =
    s === 'source_key' || s === 'owner_key' ? 'success' : s === 'conflicting_key' ? 'danger' : s === 'ai_derived' ? 'info' : s === 'not_applicable' ? 'neutral' : 'warning';
  return { tone, label: ANSWER_STATUS_LABELS_AR[s] };
}

export function extractionPill(s: ExtractionStatus): PillSpec {
  const tone: StatusTone = s === 'checks_passed' ? 'success' : s === 'owner_reviewed' ? 'accent' : s === 'needs_review' ? 'warning' : 'neutral';
  return { tone, label: EXTRACTION_STATUS_LABELS_AR[s] };
}

export function statusPill(s: QuestionStatus): PillSpec {
  const tone: StatusTone = s === 'ready' ? 'success' : s === 'needs_review' ? 'warning' : 'neutral';
  return { tone, label: QUESTION_STATUS_LABELS_AR[s] };
}

export function relationPill(r: LectureLinkRelation): PillSpec {
  const tone: StatusTone = r === 'directly_covered' ? 'success' : r === 'strongly_related' ? 'info' : r === 'partially_covered' ? 'warning' : 'neutral';
  return { tone, label: LECTURE_LINK_LABELS_AR[r] };
}

export function plainOf(rt: RichText | null | undefined): string {
  if (!rt) return '';
  return rt.paragraphs.map((p) => p.runs.map((r) => r.t).join('')).join('\n');
}

/** Options marked correct by the current version (stable ids, never labels). */
export function isCorrect(v: Pick<QuestionVersionView, 'correct_option_ids'>, o: Pick<QuestionOptionView, 'id'>): boolean {
  return !!v.correct_option_ids?.includes(o.id);
}

/** Who stands behind the marked answer — never presented as more than it is. */
export function keyOriginLabel(s: AnswerStatus): string | null {
  switch (s) {
    case 'source_key':
      return 'حسب مفتاح المصدر';
    case 'owner_key':
      return 'حسب المفتاح الذي حددته';
    case 'ai_derived':
      return 'حل مولد من الأدلة (AI-derived)';
    default:
      return null;
  }
}

export function failedIssues(issues: QuestionValidationIssue[] | undefined | null): QuestionValidationIssue[] {
  return (issues ?? []).filter((i) => !i.passed).sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'blocker' ? -1 : 1));
}

export const CHECK_LABELS_AR: Record<QuestionValidationIssue['check'], string> = {
  stem_complete: 'اكتمال نص السؤال',
  options_complete: 'اكتمال الخيارات',
  option_order: 'ترتيب الخيارات',
  merged_questions: 'عدم دمج سؤالين',
  negation_preserved: 'حفظ صيغة النفي',
  numbers_units_preserved: 'الأرقام والوحدات',
  images_attached: 'الصور التابعة',
  key_bound: 'ربط المفتاح',
  key_conflict: 'تعارض المفاتيح',
  unofficial_mark: 'علامات غير رسمية',
  single_best_answer: 'إجابة واحدة أفضل',
  distractors_explained: 'شرح المشتتات',
  no_answer_leak: 'عدم تسريب الإجابة',
  evidence_supported: 'الاستناد إلى الأدلة',
  scope: 'نطاق المصادر',
};

/** Rail grouping: this page first, then the lecture, then weak course-only links (collapsed). */
export function groupLectureItems(items: LectureQuestionItem[]): { onPage: LectureQuestionItem[]; inLecture: LectureQuestionItem[]; courseOnly: LectureQuestionItem[] } {
  const onPage = items.filter((i) => i.on_this_page && i.link.relation !== 'course_related_only');
  const inLecture = items.filter((i) => !i.on_this_page && i.link.relation !== 'course_related_only');
  const courseOnly = items.filter((i) => i.link.relation === 'course_related_only');
  return { onPage, inLecture, courseOnly };
}

/** Next option label in the same script as the existing ones (A→B, أ→ب, 1→2). */
const LATIN = 'ABCDEFGH';
const ARABIC = ['أ', 'ب', 'ج', 'د', 'هـ', 'و', 'ز', 'ح'];
export function nextLabel(labels: Array<string | null>): string {
  const last = [...labels].reverse().find((l): l is string => !!l);
  if (!last) return 'A';
  if (/^[0-9]+$/.test(last)) return String(Number(last) + 1);
  const li = LATIN.indexOf(last.toUpperCase());
  if (li >= 0) return LATIN[li + 1] ?? `${last}+`;
  const ai = ARABIC.indexOf(last === 'ه' ? 'هـ' : last);
  if (ai >= 0) return ARABIC[ai + 1] ?? `${last}+`;
  return `${labels.length + 1}`;
}

export interface EditableOption {
  option_key?: string;
  source_label: string | null;
  text: string;
}

/** Fields that differ between the original and the edited form (for the save button and the audit note). */
export function changedFields(orig: { stem: string; options: EditableOption[] }, edit: { stem: string; options: EditableOption[] }): string[] {
  const out: string[] = [];
  if (orig.stem.trim() !== edit.stem.trim()) out.push('stem');
  const sig = (xs: EditableOption[]) => JSON.stringify(xs.map((o) => [o.option_key ?? null, o.source_label ?? null, o.text.trim()]));
  if (sig(orig.options) !== sig(edit.options)) out.push('options');
  return out;
}

/** «سؤال واحد» / «سؤالان» / «3 أسئلة» / «11 سؤالًا» (Arabic number agreement). */
export function questionCountAr(n: number): string {
  if (n === 1) return 'سؤال واحد';
  if (n === 2) return 'سؤالان';
  const r = n % 100;
  if (r >= 3 && r <= 10) return `${n} أسئلة`;
  return `${n} سؤالًا`;
}
