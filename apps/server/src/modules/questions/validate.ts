// Per-question validation (§34; AC-10, AC-11, AC-13, AC-14, AC-15). Deterministic checks only. A failed
// BLOCKER means the question cannot be approved automatically (extraction_status 'needs_review') and cannot be
// scored; warnings are shown but do not block. Text checks and key checks stay separate (§34: question status,
// extraction status and key status are independent).
import type { AnswerStatus, QuestionType, QuestionValidation, QuestionValidationIssue } from '@medlevo/shared';
import { stripStructurePrefix } from './parser';
import { looksTruncated, multisetMinus, negationKey, negationTerms, numberUnitTokens, refersToImage } from './text';

export interface ValidationInput {
  stem: string;
  options: Array<{ label: string | null; text: string }>;
  qtype: QuestionType;
  /** verbatim block text from the source (stem + option lines); null for owner / generated questions */
  rawText: string | null;
  /** issues found while parsing (order, merged, gaps, …) */
  structural: QuestionValidationIssue[];
  figuresAttached: number;
  /** regions of the block that processing marked uncertain (low OCR confidence etc.) */
  uncertainRegions: Array<{ where: 'stem' | 'option'; label: string | null; reason: string }>;
  answerStatus: AnswerStatus;
  conflictAr: string | null;
  unofficialMarks: Array<{ label: string; kind: string }>;
  /** who produced this version: owner corrections may intentionally differ from the raw text */
  createdBy: 'extraction' | 'generation' | 'owner' | 'translation';
  ownerReviewedFields: string[];
  /** the source key was read by OCR with low confidence (blocks scoring until the owner checked the key) */
  uncertainKeyAr?: string | null;
  /** a source question no longer found in the version in force of its source(s) (replaced question source) */
  supersededAr?: { reason_ar: string; severity: QuestionValidationIssue['severity'] } | null;
}

/** Marker in reasons of checks that failed only because the text was read with low confidence (OCR). */
export const LOW_CONFIDENCE_AR = 'بثقة منخفضة';

const TEXT_CHECKS = new Set<QuestionValidationIssue['check']>([
  'stem_complete',
  'options_complete',
  'option_order',
  'merged_questions',
  'negation_preserved',
  'numbers_units_preserved',
  'images_attached',
]);

const MCQ: ReadonlySet<QuestionType> = new Set<QuestionType>(['sba', 'multi_select', 'true_false']);

/**
 * Strip the printed numbering / option labels at the start of each raw line (they are structure, not content).
 * Uses the PARSER's own rules, so a line the parser kept as text («10 - 15 mg/kg …», «3.5 mmol/L …») keeps its
 * numbers and is compared in full.
 */
export function rawContent(raw: string): string {
  return raw
    .split('\n')
    .map((l) => stripStructurePrefix(l))
    .join('\n');
}

export function validateQuestion(input: ValidationInput): QuestionValidation {
  const issues: QuestionValidationIssue[] = [];
  const structuralChecks = new Set(input.structural.filter((i) => !i.passed && i.severity === 'blocker').map((i) => i.check));
  // a field the owner personally compared with the original (or corrected) — a difference is then a warning
  const ownerReviewed = (field: string) => input.ownerReviewedFields.includes(field) || input.ownerReviewedFields.includes('all');
  const pass = (check: QuestionValidationIssue['check'], reason_ar: string, severity: QuestionValidationIssue['severity'] = 'blocker') =>
    issues.push({ check, passed: true, severity, reason_ar });
  const fail = (check: QuestionValidationIssue['check'], reason_ar: string, severity: QuestionValidationIssue['severity'] = 'blocker') =>
    issues.push({ check, passed: false, severity, reason_ar });

  issues.push(...input.structural);

  // stem complete (AC-10)
  const stemUncertain = input.uncertainRegions.filter((u) => u.where === 'stem');
  if (!input.stem.trim()) fail('stem_complete', 'لا يوجد نص للسؤال (stem) — السؤال مبتور أو لم يُقرأ.');
  else if (looksTruncated(input.stem)) fail('stem_complete', `نص السؤال يبدو مبتورًا: ينتهي بـ «${input.stem.trim().split(/\s+/).slice(-3).join(' ')}».`);
  else if (stemUncertain.length > 0) fail('stem_complete', `نص السؤال مقروء ${LOW_CONFIDENCE_AR} (${stemUncertain[0]!.reason}) — قارنه بالصورة الأصلية قبل اعتماده.`);
  else if (!structuralChecks.has('stem_complete')) pass('stem_complete', 'نص السؤال مكتمل.');

  // options complete + order
  const isMcq = MCQ.has(input.qtype);
  const asksChoice = /which of the following|all of the following|أي مما يلي|أي من|جميع ما يلي|كل ما يلي/i.test(input.stem);
  const optUncertain = input.uncertainRegions.filter((u) => u.where === 'option');
  if ((isMcq || asksChoice) && input.options.length < 2) {
    fail('options_complete', input.options.length === 0 ? 'سؤال اختيار من متعدد بلا خيارات مستخرجة.' : 'استُخرج خيار واحد فقط؛ بقية الخيارات مفقودة.');
  } else if (optUncertain.length > 0) {
    fail(
      'options_complete',
      `نص ${optUncertain.length === 1 ? `الخيار ${optUncertain[0]!.label ?? ''}` : `الخيارات ${optUncertain.map((u) => u.label ?? '').join('، ')}`} مقروء ${LOW_CONFIDENCE_AR} (OCR) — قارنه بالصورة الأصلية.`,
    );
  } else if (input.options.some((o) => !o.text.trim())) {
    fail('options_complete', `خيار بلا نص: ${input.options.filter((o) => !o.text.trim()).map((o) => o.label ?? '?').join('، ')}.`);
  } else if (!structuralChecks.has('options_complete')) {
    pass('options_complete', isMcq ? `${input.options.length} خيارات كما في المصدر (لا يُفرض عدد ثابت).` : 'سؤال بلا خيارات (ليس اختيارًا من متعدد).');
  }
  if (!structuralChecks.has('option_order') && input.options.length > 0) pass('option_order', 'ترتيب الخيارات متسلسل كما طُبع.');
  if (!structuralChecks.has('merged_questions')) pass('merged_questions', 'لا يوجد ما يدل على دمج سؤالين.');

  const structuredBlock = [input.stem, ...input.options.map((o) => o.text)].join('\n');
  if (input.rawText !== null) {
    const raw = rawContent(input.rawText);
    // negation preserved (AC-11)
    const rawNeg = negationKey(negationTerms(raw));
    const strNeg = negationKey(negationTerms(structuredBlock));
    const missingNeg = multisetMinus(rawNeg, strNeg);
    const addedNeg = multisetMinus(strNeg, rawNeg);
    if (missingNeg.length === 0 && addedNeg.length === 0) {
      pass('negation_preserved', rawNeg.length ? `صيغة النفي محفوظة: ${negationTerms(input.stem).join('، ') || negationTerms(structuredBlock).join('، ')}.` : 'لا توجد صيغة نفي في الأصل.');
    } else {
      const sev = ownerReviewed('stem') ? 'warning' : 'blocker';
      fail(
        'negation_preserved',
        missingNeg.length
          ? `صيغة النفي (${missingNeg.join('، ')}) موجودة في الأصل ومفقودة من النسخة المنظمة.`
          : `أُضيفت صيغة نفي (${addedNeg.join('، ')}) غير موجودة في الأصل.`,
        sev,
      );
    }
    // numbers & units identical (AC-11)
    const rawNums = numberUnitTokens(raw);
    const strNums = numberUnitTokens(structuredBlock);
    const lost = multisetMinus(rawNums, strNums);
    const added = multisetMinus(strNums, rawNums);
    if (lost.length === 0 && added.length === 0) {
      pass('numbers_units_preserved', rawNums.length ? `الأرقام والوحدات مطابقة للأصل: ${rawNums.slice(0, 6).join('، ')}.` : 'لا توجد أرقام أو وحدات في السؤال.');
    } else {
      const sev = ownerReviewed('stem') || ownerReviewed('options') ? 'warning' : 'blocker';
      const parts: string[] = [];
      if (lost.length) parts.push(`في الأصل: ${lost.join('، ')}`);
      if (added.length) parts.push(`في النسخة المنظمة: ${added.join('، ')}`);
      fail('numbers_units_preserved', `الأرقام أو الوحدات لا تطابق النص الأصلي (${parts.join(' ↔ ')}).`, sev);
    }
  }

  // images attached
  if (refersToImage(input.stem) && input.figuresAttached === 0) fail('images_attached', 'السؤال يشير إلى صورة أو شكل، لكن لم تُرفق به صورة من الصفحة.');
  else pass('images_attached', input.figuresAttached > 0 ? `أُرفقت ${input.figuresAttached === 1 ? 'صورة واحدة' : `${input.figuresAttached} صور`} من مكان السؤال.` : 'لا يشير السؤال إلى صورة.');

  // key status (separate from text extraction)
  switch (input.answerStatus) {
    case 'source_key':
      if (input.uncertainKeyAr) fail('key_bound', input.uncertainKeyAr, ownerReviewed('key') ? 'warning' : 'blocker');
      else pass('key_bound', 'مفتاح المصدر مربوط بالقسم ورقم السؤال ونسخة المصدر.');
      break;
    case 'owner_key':
      pass('key_bound', 'المفتاح حددته بنفسك (ليس مفتاح المصدر).');
      break;
    case 'ai_derived':
      pass('key_bound', 'حل مولد من الأدلة (AI-derived) وليس مفتاح المصدر.', 'warning');
      break;
    case 'missing_key':
      fail('key_bound', 'لا يوجد مفتاح إجابة لهذا السؤال في المصدر — يصلح للتدريب غير المحسوب فقط.', 'warning');
      break;
    case 'unresolved':
      fail('key_bound', input.conflictAr ?? 'لا يمكن تحديد إجابة صالحة للتقييم.', 'warning');
      break;
    case 'conflicting_key':
      break;
    case 'not_applicable':
      pass('key_bound', 'لا ينطبق مفتاح على هذا النوع من الأسئلة.', 'warning');
      break;
  }
  if (input.answerStatus === 'conflicting_key') fail('key_conflict', input.conflictAr ?? 'مفاتيح المصدر متعارضة لهذا السؤال.');
  else pass('key_conflict', 'لا تعارض بين مفاتيح المصدر.');

  if (input.unofficialMarks.length > 0) {
    fail(
      'unofficial_mark',
      `علامة غير رسمية (${input.unofficialMarks.map((m) => `${m.kind === 'circled_option' ? 'دائرة حول' : 'علامة بجانب'} الخيار ${m.label}`).join('، ')}) — قد تكون إجابة طالب سابق، ولا تُعد مفتاحًا رسميًا.`,
      'warning',
    );
  }

  if (input.supersededAr) fail('scope', input.supersededAr.reason_ar, input.supersededAr.severity);

  const publishable = !issues.some((i) => !i.passed && i.severity === 'blocker');
  return { issues: dedupeIssues(issues), publishable };
}

/** Keep the failed issue when the same check has both a structural failure and a pass. */
function dedupeIssues(issues: QuestionValidationIssue[]): QuestionValidationIssue[] {
  const failed = new Set(issues.filter((i) => !i.passed).map((i) => i.check));
  return issues.filter((i) => !i.passed || !failed.has(i.check));
}

/** Text-extraction verdict only (key problems never make the TEXT "needs review"). */
export function textChecksPassed(v: QuestionValidation): boolean {
  return !v.issues.some((i) => !i.passed && i.severity === 'blocker' && TEXT_CHECKS.has(i.check));
}

export function blockingIssues(v: QuestionValidation | null): QuestionValidationIssue[] {
  return v ? v.issues.filter((i) => !i.passed && i.severity === 'blocker') : [];
}
