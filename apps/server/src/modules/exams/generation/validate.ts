// Deterministic validation of a generated SBA question (§38). These checks never call a model; they catch the
// structural problems (one best answer, distinct options, wording clues, incomplete vignette, missing or generic
// distractor explanations) before the evidence and independent-validator checks run.
import { normalizeForSearch } from '@medlevo/shared';
import type { GeneratedQuestion, ModelSentence } from './schema';

export interface Issue {
  check:
    | 'single_best_answer'
    | 'options_complete'
    | 'no_answer_leak'
    | 'negation_preserved'
    | 'stem_complete'
    | 'distractors_explained'
    | 'evidence_supported'
    | 'validator';
  reason_ar: string;
  by: 'deterministic' | 'evidence' | 'validator';
}

const ABSOLUTE = /\b(always|never|all|none|only|must|completely|cannot|invariably)\b|(?:دائمًا|دائما|أبدًا|ابدا|مطلقًا|فقط|إطلاقًا)/i;
const ABOVE = /\b(all|none|both|neither) of the above\b|جميع ما سبق|كل ما سبق|لا شيء مما سبق/i;
const NEGATION_LOWER = /\b(not|except|least)\b/g;
const CLINICAL_TYPES = new Set(['vignette', 'diagnosis', 'next_step', 'management', 'investigation', 'interpretation', 'complications']);
const PATIENT = /\b(\d{1,3}[- ]year[- ]old|years? old|patient|woman|man|girl|boy|child|infant|presents?|admitted)\b|(?:مريض|مريضة|عمره|عمرها|سنة|يراجع|تراجع)/i;
const GENERIC = /^(?:this|it|that)(?: option| answer)? is (?:incorrect|wrong|not correct|false)\.?$|^(?:خطأ|غير صحيح|إجابة خاطئة)\.?$/i;

function norm(s: string): string {
  return normalizeForSearch(s).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function contentWords(s: string): string[] {
  return norm(s)
    .split(' ')
    .filter((w) => w.length >= 4);
}

/** Uppercase a negation in the question sentence («Which is not …» → «Which is NOT …»). */
export function emphasizeNegation(stem: string): string {
  const sentences = stem.split(/(?<=[.!?])\s+/);
  const last = sentences.length - 1;
  sentences[last] = sentences[last]!.replace(NEGATION_LOWER, (m) => m.toUpperCase());
  return sentences.join(' ');
}

function hasClaimWithEvidence(sentences: ModelSentence[]): boolean {
  return sentences.some((s) => !!s.claim && s.claim.evidence.length > 0 && s.claim.support_type !== 'unsupported');
}

export function deterministicIssues(q: GeneratedQuestion): Issue[] {
  const issues: Issue[] = [];
  const fail = (check: Issue['check'], reason_ar: string) => issues.push({ check, reason_ar, by: 'deterministic' });
  const keys = q.options.map((o) => o.key.toUpperCase());

  // one best answer, 4–5 distinct options
  if (new Set(keys).size !== keys.length) fail('single_best_answer', 'مفاتيح الخيارات مكررة.');
  const bestIdx = keys.indexOf(q.best_answer.toUpperCase());
  if (bestIdx < 0) fail('single_best_answer', 'الإجابة الأفضل لا تشير إلى أحد الخيارات.');
  if (q.options.length < 4 || q.options.length > 5) fail('options_complete', `عدد الخيارات ${q.options.length}؛ المطلوب 4 أو 5.`);
  const normalized = q.options.map((o) => norm(o.text));
  if (new Set(normalized).size !== normalized.length) fail('options_complete', 'خياران أو أكثر متطابقان في المعنى/النص.');
  if (q.options.some((o) => ABOVE.test(o.text))) fail('single_best_answer', 'خيار «جميع ما سبق/لا شيء مما سبق» غير مسموح في سؤال الإجابة الأفضل المولد.');

  if (bestIdx >= 0) {
    const best = q.options[bestIdx]!.text;
    const others = q.options.filter((_, i) => i !== bestIdx).map((o) => o.text);
    // length clue
    const lens = others.map((t) => t.length);
    const longestOther = Math.max(...lens);
    const avgOther = lens.reduce((a, b) => a + b, 0) / Math.max(1, lens.length);
    if (best.length > longestOther && best.length >= 1.5 * avgOther && best.length - longestOther >= 15) {
      fail('no_answer_leak', 'الخيار الصحيح أطول بوضوح من بقية الخيارات؛ الطول يكشفه.');
    }
    // absolute words only in distractors
    const absOthers = others.filter((t) => ABSOLUTE.test(t)).length;
    if (absOthers > 0 && !ABSOLUTE.test(best)) fail('no_answer_leak', 'كلمات مطلقة (always/never/only…) في المشتتات وحدها تكشف أنها خاطئة.');
    // grammar clue: «… an» before the options
    if (/\ban\s*[:?]?\s*$/i.test(q.stem.trim())) {
      const vowel = (t: string) => /^[aeiou]/i.test(t.trim());
      if (vowel(best) && others.every((t) => !vowel(t))) fail('no_answer_leak', 'أداة «an» في نهاية السؤال لا تتفق نحويًا إلا مع الخيار الصحيح.');
    }
    // the stem repeats the answer
    const bestWords = contentWords(best);
    const stemNorm = ` ${norm(q.stem)} `;
    if (bestWords.length > 0 && stemNorm.includes(` ${norm(best)} `)) fail('no_answer_leak', 'نص الإجابة الصحيحة مكرر حرفيًا في نص السؤال.');
  }

  // vignette completeness
  const stem = q.stem.trim();
  if (!/[?:؟]\s*$/.test(stem)) fail('stem_complete', 'نص السؤال لا ينتهي بسؤال واضح («؟» أو «:»).');
  if (CLINICAL_TYPES.has(q.item_type) && (stem.length < 120 || !PATIENT.test(stem))) {
    fail('stem_complete', 'الحالة السريرية ناقصة المعطيات (لا مريض/عمر/عرض كافٍ لحل السؤال).');
  }

  // explanations: best answer + EVERY distractor, evidence-backed, not generic
  if (!hasClaimWithEvidence(q.explanation)) fail('distractors_explained', 'تفسير الإجابة الصحيحة بلا دليل مرفق.');
  const byOption = new Map(q.distractors.map((d) => [d.option.toUpperCase(), d.explanation]));
  q.options.forEach((o, i) => {
    if (i === bestIdx) return;
    const ex = byOption.get(o.key.toUpperCase());
    if (!ex || ex.length === 0) {
      fail('distractors_explained', `لا يوجد تفسير للمشتت ${o.key}.`);
      return;
    }
    const text = ex.map((s) => s.text).join(' ').trim();
    if (GENERIC.test(text) || text.length < 25) fail('distractors_explained', `تفسير المشتت ${o.key} عام («غير صحيح») ولا يذكر السبب الفاصل.`);
    else if (!hasClaimWithEvidence(ex)) fail('distractors_explained', `تفسير المشتت ${o.key} بلا دليل من المصادر.`);
  });
  return issues;
}
