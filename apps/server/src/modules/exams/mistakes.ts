// Mistake Genome suggestion (§44) — deterministic heuristics, a SUGGESTION the owner can edit (origin 'auto' →
// 'owner'). Never a psychological diagnosis; a late answer is never asserted to be caused by time pressure (§39).
import { MISTAKE_TYPE_LABELS_AR, type ConfidenceLevel, type MistakeType } from '@medlevo/shared';

export interface MistakeInput {
  scored: boolean;
  is_correct: boolean | null;
  confidence: ConfidenceLevel | null;
  time_ms: number | null;
  time_budget_ms: number | null;
  has_negation: boolean;
  negation_terms: string[];
  item_type: string | null;
  stem: string;
  qtype: string;
}

export interface MistakeSuggestion {
  type: MistakeType;
  reason_ar: string;
}

const FIRST_LINE = /\b(first[- ]line|first|initial|initially|screening|confirm(?:atory|s|ed)?|definitive|gold standard|diagnostic test)\b|(?:الفحص الأولي|الأولي|أولا|أولًا|المؤكد|التأكيدي|يؤكد)/i;
const STEP = /\b(next step|best next|first step|initial (?:step|management)|immediate(?:ly)?|before|after|sequence|order)\b|(?:الخطوة التالية|الخطوة الأولى|قبل|بعد|ترتيب)/i;

/** Suggest a mistake type for a WRONG scored answer, or null. */
export function suggestMistake(i: MistakeInput): MistakeSuggestion | null {
  if (!i.scored || i.is_correct !== false) return null;
  const s = (type: MistakeType, reason_ar: string): MistakeSuggestion => ({ type, reason_ar: `${reason_ar} (اقتراح آلي: «${MISTAKE_TYPE_LABELS_AR[type]}» — عدّله إن لم يكن دقيقًا)` });

  if (i.time_budget_ms && i.time_ms !== null && i.time_ms > i.time_budget_ms) {
    const over = Math.round((i.time_ms - i.time_budget_ms) / 1000);
    return s('time_pressure', `استغرقت الإجابة وقتًا أطول من المتاح لهذا السؤال (تجاوز ${over} ثانية). قد يكون ضغط الوقت عاملًا، وقد لا يكون`);
  }
  if (i.has_negation && (i.qtype === 'sba' || i.qtype === 'true_false')) {
    const term = i.negation_terms[0] ?? 'NOT';
    return s('misread', `السؤال منفي («${term}»)، والخيار الذي اخترته عبارة صحيحة في ذاتها؛ ربما فاتتك كلمة النفي`);
  }
  if (i.item_type === 'investigation' && FIRST_LINE.test(i.stem)) {
    return s('first_line_vs_confirmatory', 'السؤال يميّز بين الفحص الأولي والفحص المؤكِّد للتشخيص');
  }
  if ((i.item_type === 'next_step' || i.item_type === 'management') && STEP.test(i.stem)) {
    return s('step_order', 'السؤال يسأل عن ترتيب الخطوات (الخطوة التالية / الأولى)');
  }
  if (i.confidence === 'confident') {
    if (i.item_type === 'diagnosis' || i.item_type === 'clinical_feature') {
      return s('concept_confusion', 'أجبت بثقة واخترت كيانًا آخر؛ قد يكون هناك خلط بين مفهومين متقاربين');
    }
    return s('misunderstanding', 'أجبت بثقة لكن الإجابة خاطئة؛ قد يكون هناك فهم غير دقيق للفكرة');
  }
  return s('knowledge_gap', i.confidence === 'guess' ? 'خمّنت الإجابة؛ يبدو أن المعلومة غير متاحة لديك بعد' : 'لم تكن واثقًا من الإجابة؛ قد تكون المعلومة ناقصة');
}

// ───────── clue words for hint 2 (§39) ─────────
export interface Clue {
  start: number;
  end: number;
  text: string;
  why_ar: string;
}

interface CluePattern {
  re: RegExp;
  why: (m: string) => string;
}

const CLUE_PATTERNS: CluePattern[] = [
  { re: /\b(NOT|EXCEPT|LEAST|FALSE|INCORRECT|UNTRUE|NEVER)\b/g, why: (m) => `«${m}»: السؤال منفي — تبحث عن الخيار الذي لا ينطبق.` },
  { re: /\b(not|except|least|false|incorrect|untrue|never)\b/g, why: (m) => `«${m}»: انتبه، هذه كلمة نفي تقلب المطلوب.` },
  { re: /(?<![\p{L}])(ليس|ليست|لا يعد|لا يُعد|عدا|باستثناء|ما عدا|خطأ|غير صحيح)(?![\p{L}])/gu, why: (m) => `«${m}»: السؤال منفي — تبحث عن الخيار الذي لا ينطبق.` },
  { re: /\b(first[- ]line|first|initial(?:ly)?|next|best next|most appropriate|most likely|best|definitive|confirm(?:atory)?|gold standard|screening)\b/gi, why: (m) => `«${m}»: يحدد نوع الإجابة المطلوبة (الأولى/الأنسب/المؤكِّدة)، لا أي إجابة صحيحة.` },
  { re: /(?<![\p{L}])(الأولي|الأولى|أول|التالية|الأنسب|الأرجح|الأفضل|المؤكد|التأكيدي)(?![\p{L}])/gu, why: (m) => `«${m}»: يحدد نوع الإجابة المطلوبة، لا أي إجابة صحيحة.` },
  { re: /\b\d{1,3}[- ]year[- ]old\b/gi, why: (m) => `«${m}»: العمر يضيّق الاحتمالات.` },
  { re: /\b(woman|man|female|male|girl|boy|child|infant|pregnant|reproductive age)\b/gi, why: (m) => `«${m}»: الجنس/الفئة تغيّر ما يجب استبعاده أولًا.` },
  { re: /(?<![\p{L}\p{N}.])[<>≤≥]?\s?\d+(?:[.,]\d+)?\s?(?:×\s?10[⁰¹²³⁴⁵⁶⁷⁸⁹]+\/?L|%|°C|mmol\/L|mg\/dL|g\/dL|mmHg|bpm|IU\/L|U\/L|kg|mg|mL)/gu, why: (m) => `«${m}»: قيمة رقمية — قارنها بالحد المذكور في المحاضرة.` },
  { re: /\b(sudden|acute|chronic|progressive|recurrent|migrat\w*)\b/gi, why: (m) => `«${m}»: مسار الأعراض الزمني دليل مهم.` },
];

/** Clue words in a stem (negation, qualifiers, age/sex, values, time course), non-overlapping, in order. */
export function findClues(stem: string): Clue[] {
  const found: Clue[] = [];
  for (const p of CLUE_PATTERNS) {
    p.re.lastIndex = 0;
    for (const m of stem.matchAll(p.re)) {
      const start = m.index ?? 0;
      const text = m[0];
      const end = start + text.length;
      if (found.some((f) => start < f.end && end > f.start)) continue;
      found.push({ start, end, text, why_ar: p.why(text.trim()) });
    }
  }
  return found.sort((a, b) => a.start - b.start).slice(0, 12);
}
