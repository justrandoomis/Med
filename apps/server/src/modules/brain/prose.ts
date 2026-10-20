// Relations written in free prose (§16, Round 7 H4 item 3) — deterministic, NO AI. A sentence of a lecture that STATES a
// relation with a recognizable pattern becomes a statement: «X causes Y», «X is caused by Y», «X is treated with Y»,
// «Y is the treatment of choice for X», «X is a complication of Y», «Complications of Y include A, B and C» and the
// Arabic equivalents («يسبب / يؤدي إلى / ينتج عن / يُعالَج … بـ / علاج … هو / من مضاعفات»).
//
// Low false positives first: the subject must open the sentence (no leading clause), names are 1–6 words with a
// meaningful token, a sentence with a negation or a «rarely» is skipped (a negated relation must never become a
// relation), list items longer than a name are dropped (never shortened into something the text did not say), and
// every name is an EXACT substring of the sentence (the quote). What is not matched is simply not extracted.
import { stripBidiControls } from '@medlevo/shared';
import { arabicMatchable, cleanName, meaningfulName, originalSlice, sentencesOf, wordsCount, type RegionIn } from './extract';

export const PROSE_EXTRACTOR_VERSION = 'prose-1';

export type ProseRelation = 'causes' | 'treats' | 'complication_of';

export interface ProseStatement {
  /** exact substring of `quote` */
  from: string;
  /** exact substring of `quote` */
  to: string;
  relation: ProseRelation;
  /** the rule that matched (stored for audit / tests) */
  pattern: string;
  regionId: string;
  pageId: string | null;
  /** the sentence, exactly as in the region */
  quote: string;
  lang: 'en' | 'ar';
  /** the region's text came from OCR (the sentence may be misread) */
  ocr: boolean;
}

// ───────── English ─────────
const EN_NEG = /\b(?:not|no|never|rarely|seldom|cannot|can't|doesn't|don't|isn't|aren't|without|unlikely|neither|nor|excludes?|exclude)\b/i;
const X = String.raw`([\p{L}\p{N}'’\-/ β]{2,70}?)`;
const ADV = String.raw`(?:(?:can|may|might|will|often|commonly|frequently|usually|typically|classically|most\s+commonly|mainly|also)\s+)*`;
const ART = String.raw`(?:(?:the|an?)\s+)?`;
const EN_RULES: Array<{ id: string; re: RegExp; relation: ProseRelation; /** which group is the relation's FROM side */ fromGroup: 1 | 2; list?: boolean }> = [
  { id: 'en.x_causes_y', re: new RegExp(String.raw`^${ART}${X}\s+${ADV}(?:causes?|leads?\s+to|results?\s+in|gives?\s+rise\s+to)\s+(.+)$`, 'iu'), relation: 'causes', fromGroup: 1, list: true },
  { id: 'en.x_caused_by_y', re: new RegExp(String.raw`^${ART}${X}\s+(?:is|are)\s+${ADV}(?:caused\s+by|the\s+result\s+of)\s+(.+)$`, 'iu'), relation: 'causes', fromGroup: 2, list: true },
  { id: 'en.x_results_from_y', re: new RegExp(String.raw`^${ART}${X}\s+${ADV}results?\s+from\s+(.+)$`, 'iu'), relation: 'causes', fromGroup: 2, list: true },
  {
    id: 'en.x_treated_with_y',
    re: new RegExp(String.raw`^${ART}${X}\s+(?:is|are)\s+${ADV}(?:(?:best|initially|primarily|definitively)\s+)?(?:treated|managed)\s+(?:with|by|using)\s+(.+)$`, 'iu'),
    relation: 'treats',
    fromGroup: 2,
    list: true,
  },
  {
    id: 'en.y_treatment_of_x',
    re: new RegExp(String.raw`^${ART}${X}\s+(?:is|are)\s+(?:the\s+)?(?:(?:first-line|first\s+line|definitive|standard|main|initial|preferred)\s+)?(?:treatment|therapy)\s+(?:of\s+choice\s+)?(?:for|of)\s+(.+)$`, 'iu'),
    relation: 'treats',
    fromGroup: 1,
  },
  { id: 'en.y_used_to_treat_x', re: new RegExp(String.raw`^${ART}${X}\s+(?:is|are)\s+${ADV}used\s+to\s+treat\s+(.+)$`, 'iu'), relation: 'treats', fromGroup: 1, list: true },
  {
    id: 'en.x_complication_of_y',
    re: new RegExp(
      String.raw`^${ART}${X}\s+(?:is|are)\s+(?:an?\s+|the\s+)?(?:(?:recogni[sz]ed|common|serious|rare|known|major|late|early|frequent|important|well-known|life-threatening|feared|dreaded|recognised|possible)\s+)*complications?\s+of\s+(.+)$`,
      'iu',
    ),
    relation: 'complication_of',
    fromGroup: 1,
  },
];
const EN_COMPLICATIONS_LIST = new RegExp(String.raw`^(?:the\s+)?(?:(?:main|common|major|recogni[sz]ed|important|serious)\s+)?complications\s+of\s+${X}\s+(?:include|includes|are|comprise)\s*:?\s+(.+)$`, 'iu');

/** The object part of a sentence: up to a clause boundary (never beyond it). */
function objectSpan(rest: string): string {
  const cut = /\s+(?:which|that|because|due\s+to|when|whenever|if|unless|but|whereas|while|although|as\s+well\s+as|especially|particularly)\b|[;:(]|\s+[—–]\s+/iu.exec(rest);
  return (cut ? rest.slice(0, cut.index) : rest).replace(/[.!?]+\s*$/u, '').trim();
}

const GENERIC_NAME = /^(?:patients?|the\s+patient|people|children|adults|women|men|it|this|these|those|they|symptoms?|signs?|disease|condition|treatment|therapy|management|surgery|problems?|cases?|المريض|المرضى|الطبيب|الاطفال|الأطفال|الطفل|المرض|العلاج|الحاله|الحالة)$/iu;

// (review H4) a sentence that reports a belief, a claim, a debate or a refutation does not STATE the relation
// («Smoking is thought to cause cancer», «Vaccines were wrongly claimed to cause autism», «يُعتقد خطأً أن …»)
const EN_HEDGE =
  /\b(?:thought|believed?|claim(?:s|ed)?|alleged(?:ly)?|suggest(?:s|ed)?|propos(?:e|es|ed)|hypothes[ie]s|hypothesi[sz]ed|postulated?|controversial|controversy|unclear|uncertain|debated?|disputed|myths?|misconceptions?|falsely|wrongly|mistakenly|erroneously|whether|formerly|historically|disproven|refuted|speculative|speculated|rumou?red)\b/i;
const AR_HEDGE =
  /(?:^|[\s،,])(?:و?يعتقد|يعتقدون|اعتقد|و?يقال|قيل|يزعم|زعم|يزعمون|يظن|يرجح|يحتمل|المحتمل|محتمل|ربما|لعل|خطا|الخطا|جدل|الجدل|خرافه|اسطوره|سابقا|قديما)(?=$|[\s،,.])/u;
// (review H4) a NAME is never a clause: verbs, modals, «that / whether / than», frequency adverbs or a leading preposition
// mean the pattern cut the sentence in the wrong place («Smoking is thought to», «hypercapnia causes acidosis»,
// «perforation less often than cholecystitis») — such a pair is not what the sentence states, and would become a concept
// (a hyphen or apostrophe joins a word: «May-Thurner syndrome» is a name, not the modal «may»)
const EN_CLAUSE_IN_NAME =
  /(?<![\p{L}\p{N}'’-])(?:is|are|was|were|be|been|being|has|have|had|does|did|should|must|would|could|will|shall|may|might|can|that|whether|which|who|whom|whose|what|when|where|why|how|if|than|causes|caused|causing|treats|treated|remains?|know|knows|said|says|thought|believed|claimed|considered|reported|occasionally|sometimes|often|rarely|usually|frequently|typically|also|falsely|wrongly|less|more|some|many|several)(?![\p{L}\p{N}'’-])|\b(?:leads?\s+to|results?\s+(?:in|from)|gives?\s+rise\s+to)\b|^(?:of|to|for|with|by|in|on|at|from|and|or|but|as)\b/iu;
const AR_CLAUSE_WORDS = new Set(
  ['ان', 'انه', 'انها', 'التي', 'الذي', 'الذين', 'قد', 'كان', 'كانت', 'يكون', 'تكون', 'يعتقد', 'يقال', 'يزعم', 'خطا', 'الخطا', 'المحتمل', 'ربما', 'احيانا', 'غالبا', 'نادرا', 'هل', 'اذا', 'حول', 'لم', 'لن', 'ليس',
    'يسبب', 'تسبب', 'يسببان', 'تسببان', 'يؤدي', 'تؤدي', 'ينتج', 'تنتج', 'يعالج', 'تعالج', 'ناتج', 'ناتجه', 'ناجم', 'ناجمه'],
);
const AR_LEADING_PREPOSITION = /^(?:من|في|على|عن|الي|الى|مع|حتي|حتى)$/u;

function clauseInName(name: string): boolean {
  if (/[؀-ۿ]/.test(name)) {
    const words = arabicMatchable(name).s.split(/\s+/).filter(Boolean).map((w) => w.replace(/[^\p{L}]/gu, ''));
    return words.some((w) => AR_CLAUSE_WORDS.has(w) || (w.startsWith('و') && AR_CLAUSE_WORDS.has(w.slice(1)))) || AR_LEADING_PREPOSITION.test(words[0] ?? '');
  }
  return EN_CLAUSE_IN_NAME.test(name);
}

/** A usable name: meaningful, 1–6 words, no clause punctuation or clause words, an EXACT substring of the sentence. */
function nameIn(sentence: string, raw: string): string | null {
  const name = cleanName(raw.replace(/^(?:the|an?)\s+/i, ''));
  if (!name || /[,;:]/.test(name)) return null;
  if (!meaningfulName(name) || wordsCount(name) > 6) return null;
  if (GENERIC_NAME.test(name)) return null;
  if (clauseInName(name)) return null;
  if (!sentence.includes(name)) return null;
  return name;
}

function listItems(span: string, list: boolean): string[] {
  if (!list) return [span];
  return span
    .split(/\s*,\s*(?:and\s+|or\s+)?|\s+(?:and|or|and\/or)\s+/iu)
    .map((x) => x.trim())
    .filter(Boolean);
}

function fromSentenceEn(sent: string, r: RegionIn, ocr: boolean, out: ProseStatement[]): void {
  if (EN_NEG.test(sent) || EN_HEDGE.test(sent) || /\?\s*$/.test(sent)) return;
  const push = (fromRaw: string, toRaw: string, relation: ProseRelation, pattern: string) => {
    const from = nameIn(sent, fromRaw);
    const to = nameIn(sent, toRaw);
    if (!from || !to || from.toLowerCase() === to.toLowerCase()) return;
    out.push({ from, to, relation, pattern, regionId: r.id, pageId: r.page_id, quote: sent, lang: 'en', ocr });
  };
  const cl = EN_COMPLICATIONS_LIST.exec(sent);
  if (cl) {
    for (const item of listItems(objectSpan(cl[2]!), true)) push(item, cl[1]!, 'complication_of', 'en.complications_of_y_include');
    return;
  }
  for (const rule of EN_RULES) {
    const m = rule.re.exec(sent);
    if (!m) continue;
    const subject = m[1]!;
    // a subject with a clause inside («In children, X …») is not a sentence-initial name
    if (/[,;:]/.test(subject)) return;
    for (const item of listItems(objectSpan(m[2]!), !!rule.list)) {
      if (rule.fromGroup === 1) push(subject, item, rule.relation, rule.id);
      else push(item, subject, rule.relation, rule.id);
    }
    return;
  }
}

// ───────── Arabic (matched on harakat-free text with unified alef / yaa; names mapped back to the original) ─────────
const AR_NEG = /(?:^|\s)(?:لا|لم|لن|ليس|ليست|غير|نادرا|قلما|دون)(?:\s|$)/u;
const AX = String.raw`(.{2,60}?)`;
const AR_RULES: Array<{ id: string; re: RegExp; relation: ProseRelation; fromGroup: 1 | 2; list?: boolean }> = [
  { id: 'ar.x_yusabbib_y', re: new RegExp(String.raw`^${AX}\s+(?:قد\s+)?(?:يسبب|تسبب|يؤدي\s+ال[يى]|تؤدي\s+ال[يى])\s+(.+)$`, 'du'), relation: 'causes', fromGroup: 1, list: true },
  { id: 'ar.yuaddi_x_ila_y', re: new RegExp(String.raw`^(?:و)?(?:قد\s+)?(?:يؤدي|تؤدي)\s+${AX}\s+ال[يى]\s+(.+)$`, 'du'), relation: 'causes', fromGroup: 1, list: true },
  { id: 'ar.x_yantuj_an_y', re: new RegExp(String.raw`^${AX}\s+(?:ينتج|تنتج|ناتج|ناتجه|ناتجة|ناجم|ناجمه|ناجمة)\s+عن\s+(.+)$`, 'du'), relation: 'causes', fromGroup: 2, list: true },
  { id: 'ar.yantuj_x_an_y', re: new RegExp(String.raw`^(?:و)?(?:ينتج|تنتج)\s+${AX}\s+عن\s+(.+)$`, 'du'), relation: 'causes', fromGroup: 2, list: true },
  { id: 'ar.yuaalaj_x_bi_y', re: new RegExp(String.raw`^(?:و)?(?:يعالج|تعالج)\s+${AX}\s+ب(?=\S)(.+)$`, 'du'), relation: 'treats', fromGroup: 2, list: true },
  { id: 'ar.x_yuaalaj_bi_y', re: new RegExp(String.raw`^${AX}\s+(?:يعالج|تعالج)\s+ب(?=\S)(.+)$`, 'du'), relation: 'treats', fromGroup: 2, list: true },
  { id: 'ar.ilaj_x_huwa_y', re: new RegExp(String.raw`^(?:و)?(?:يكون\s+)?علاج\s+${AX}\s+(?:هو|هي)\s+(.+)$`, 'du'), relation: 'treats', fromGroup: 2 },
  { id: 'ar.x_min_mudaafat_y', re: new RegExp(String.raw`^${AX}\s+(?:(?:هو|هي)\s+)?(?:من|احد|احدى)\s+مضاعفات\s+(.+)$`, 'du'), relation: 'complication_of', fromGroup: 1 },
];
const AR_COMPLICATIONS_LIST = new RegExp(String.raw`^(?:(?:من|تشمل|تتضمن)\s+مضاعفات\s+${AX}\s*[:،]\s*|مضاعفات\s+${AX}\s+(?:تشمل|تتضمن|هي)\s+)(.+)$`, 'du');

function arObjectSpan(rest: string): string {
  const cut = /\s+(?:الذي|التي|الذين|لان|لأن|بسبب|عند|عندما|اذا|إذا|حيث|لكن|ولكن|خاصة|خاصه|وخاصة|وخاصه)(?:\s|$)|[؛;:(]/u.exec(rest);
  return (cut ? rest.slice(0, cut.index) : rest).replace(/[.!؟]+\s*$/u, '').trim();
}

/** Arabic list items: split on «،» and on a «و» attached before «ال» (as in «الانثقاب والخراج»). */
function arListItems(span: string, list: boolean): string[] {
  if (!list) return [span];
  return span
    .split(/\s*[،,]\s*(?:و(?=\S))?|\s+(?:او|أو)\s+|\s+و(?=[اأإآ]ل)/u)
    .map((x) => x.trim())
    .filter(Boolean);
}

function fromSentenceAr(sent: string, r: RegionIn, ocr: boolean, out: ProseStatement[]): void {
  const { s, map } = arabicMatchable(sent);
  if (AR_NEG.test(s) || AR_HEDGE.test(s) || /[?؟]\s*$/.test(s)) return;
  // a group of the normalized text → the exact original slice
  const orig = (start: number, len: number) => originalSlice(sent, map, start, start + len);
  const push = (fromRaw: string, toRaw: string, relation: ProseRelation, pattern: string) => {
    const from = nameIn(sent, fromRaw);
    const to = nameIn(sent, toRaw);
    if (!from || !to || from === to) return;
    out.push({ from, to, relation, pattern, regionId: r.id, pageId: r.page_id, quote: sent, lang: 'ar', ocr });
  };
  // exact group positions (the `d` flag) — never a search that could land on an earlier repeat of the same words
  const groupStart = (m: RegExpExecArray, g: number) => m.indices![g]![0];
  const cl = AR_COMPLICATIONS_LIST.exec(s);
  if (cl) {
    const yG = cl[1] !== undefined ? 1 : 2;
    const y = orig(groupStart(cl, yG), cl[yG]!.length);
    const listStart = groupStart(cl, 3);
    const listOrig = orig(listStart, arObjectSpan(cl[3]!).length);
    for (const item of arListItems(listOrig, true)) push(item, y, 'complication_of', 'ar.mudaafat_y_tashmal');
    return;
  }
  for (const rule of AR_RULES) {
    const m = rule.re.exec(s);
    if (!m) continue;
    const subj = orig(groupStart(m, 1), m[1]!.length);
    if (/[،,؛;:]/.test(subj)) return;
    const objNorm = arObjectSpan(m[2]!);
    const objOrig = orig(groupStart(m, 2), objNorm.length);
    for (const item of arListItems(objOrig, !!rule.list)) {
      if (rule.fromGroup === 1) push(subj, item, rule.relation, rule.id);
      else push(item, subj, rule.relation, rule.id);
    }
    return;
  }
}

/** Every relation stated in prose in the regions of one source version (headers / questions / cells never read). */
export function extractProseRelations(regions: Array<RegionIn & { text_origin?: string | null }>): ProseStatement[] {
  const out: ProseStatement[] = [];
  let inObjectives = false;
  for (const r of regions) {
    if (r.parent_region_id) continue;
    if (r.kind === 'heading') {
      inObjectives = /\bobjectives?\b|\blearning outcomes?\b|الاهداف|الأهداف|اهداف|أهداف/i.test(r.text ?? '');
      continue;
    }
    if (inObjectives) continue; // «Describe how X causes Y» is a learning objective, not a statement
    if (!['paragraph', 'list_item', 'text_block', 'note', 'transcript'].includes(r.kind)) continue;
    const text = stripBidiControls(r.text ?? '').trim();
    if (!text) continue;
    const ocr = r.text_origin === 'ocr';
    for (const line of text.split(/\n+/)) {
      for (const raw of sentencesOf(line.replace(/^[\s•▪◦●○■□\-–*·]+/u, ''))) {
        const sent = raw.trim();
        if (!sent || sent.length > 400) continue;
        if (/^[؀-ۿ]/.test(sent)) fromSentenceAr(sent, r, ocr, out);
        else fromSentenceEn(sent, r, ocr, out);
      }
    }
  }
  // one statement per (from, to, relation, region)
  const seen = new Set<string>();
  return out.filter((x) => {
    const k = `${x.from.toLowerCase()}|${x.to.toLowerCase()}|${x.relation}|${x.regionId}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
