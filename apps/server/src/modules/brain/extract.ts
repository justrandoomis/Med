// Deterministic knowledge-structure extraction (§16) — NO AI. From the regions of one processed source version:
//  * headings → the concept they name (role 'heading') + the SECTION they open (signs, investigations, management,
//    complications, drugs, values, differential diagnosis, classification, causes, mechanism, objectives…)
//  * definition sentences («X is defined as …», «X is a …», «X refers to …», «X is classified as …»,
//    «يُعرَّف X بأنه …», «تُصنَّف X إلى …», «X هو …») → role 'definition' / 'classification'
//  * subjects of statements inside a section («Ultrasound is the first-line …» under «Investigations») → the
//    section's role; enumerations («includes A, B and C», «يشمل …») → one mention per item
//  * short list items inside a section; the first column of tables (role 'value' when the row carries a number with
//    a unit or a threshold); table / figure captions → the concept they are about
//  * learning objectives are kept as objectives (they are not concepts)
// Every mention keeps the region it came from and the EXACT text (`quote`, a substring of the region text / cell) —
// a mention is «stated» because its name literally appears there. Nothing is paraphrased or inferred here.
import { stripBidiControls, type ConceptRole, type TableStructure } from '@medlevo/shared';
import { fromJson } from '../../db/db';
import { contentTokens, numberUnitTokens } from '../questions/text';

export const EXTRACTOR_VERSION = 'kb-1';

export type SectionRole = ConceptRole | 'objective';

export interface RegionIn {
  id: string;
  page_id: string | null;
  page_index: number;
  kind: string;
  text: string | null;
  structure_json: string | null;
  parent_region_id: string | null;
}

export interface Mention {
  /** name as printed (English part for bilingual headings) */
  name: string;
  /** the other-language name printed with it («Acute Appendicitis — التهاب الزائدة الدودية الحاد») */
  nameAlt: string | null;
  lang: 'en' | 'ar';
  role: ConceptRole;
  regionId: string;
  pageId: string | null;
  /** exact text of the region the name was read from (sentence / cell / heading) */
  quote: string;
  /** heading the region sits under */
  section: string | null;
}

export interface Objective {
  text: string;
  regionId: string;
  pageId: string | null;
}

export interface Extraction {
  mentions: Mention[];
  objectives: Objective[];
  sections: Array<{ title: string; role: SectionRole | null; regionId: string }>;
}

// ───────── section headings ─────────
// Tested against normalizeForSearch(heading) (lowercase, Arabic alef / yaa / taa marbuta unified, no harakat).
const SECTION_RULES: Array<{ role: SectionRole; re: RegExp }> = [
  { role: 'differential', re: /\bdifferentials?\b|\bdifferential diagnos[ie]s\b|\bddx\b|التشخيص التفريقي|تشخيص تفريقي/ },
  { role: 'objective', re: /\bobjectives?\b|\blearning outcomes?\b|\baims\b|الاهداف|اهداف/ },
  { role: 'definition', re: /\bdefinitions?\b|التعريف|تعريف/ },
  { role: 'classification', re: /\bclassifications?\b|\btypes?\b|\bcategories\b|\bsubtypes?\b|التصنيف|تصنيف|الانواع|انواع/ },
  { role: 'cause', re: /\ba?etiology\b|\bcauses?\b|\brisk factors?\b|الاسباب|اسباب|المسببات|عوامل الخطوره/ },
  { role: 'mechanism', re: /\bpathophysiology\b|\bpathogenesis\b|\bmechanisms?\b|الاليه|الفيزيولوجيا المرضيه|الامراضيه/ },
  { role: 'complication', re: /\bcomplications?\b|المضاعفات|مضاعفات/ },
  { role: 'drug', re: /\bdrugs?\b|\bmedications?\b|\bpharmacolog\w*|الادويه|ادويه|العقاقير/ },
  { role: 'value', re: /\bnormal values?\b|\breference (?:values?|ranges?)\b|\blab(?:oratory)? values?\b|\bvalues\b|القيم الطبيعيه|القيم/ },
  { role: 'investigation', re: /\binvestigations?\b|\bdiagnosis\b|\bdiagnostic\b|\bwork-?up\b|\bimaging\b|\blaboratory\b|\btests\b|الفحوصات|فحوصات|التشخيص|الاستقصاءات/ },
  { role: 'management', re: /\bmanagement\b|\btreatment\b|\btherapy\b|\bpathway\b|\balgorithm\b|العلاج|علاج|التدبير|تدبير/ },
  { role: 'sign', re: /\bclinical (?:presentation|features|picture)\b|\bpresentation\b|\bsigns?\b|\bsymptoms?\b|\bclinical examination\b|الاعراض|اعراض|العلامات|علامات|الصوره السريريه/ },
];

/** Words that organise a document but name no concept (in normalized form). */
const STRUCTURAL = new Set(
  (
    'overview introduction intro summary conclusion conclusions objectives objective outcomes aims notes note revision section part chapter ' +
    'lecture appendix pathway algorithm approach components component table figure fig diagram flowchart chart synthetic key points ' +
    'types type classification categories management treatment therapy investigations investigation diagnosis differential ' +
    'clinical presentation features signs symptoms complications drugs medications values definition definitions causes aetiology etiology ' +
    'pathophysiology mechanism mechanisms initial general basic principles principle further reading questions answers case cases ' +
    'learning assessment approach steps step ' +
    'مقدمه اهداف الاهداف خلاصه ملخص مكونات مقياس المقياس جدول شكل مخطط الفحوصات فحوصات العلاج علاج التشخيص التدبير المضاعفات الاعراض العلامات ' +
    'تعريف التعريف تصنيف التصنيف انواع الانواع اسباب الاسباب القيم'
  ).split(/\s+/),
);

const PRONOUN_START = /^(?:it|its|this|that|these|those|there|they|he|she|we|you|which|what|who|each|every|both|all|most|some|such|as|if|when|while|although|however|in|on|at|for|after|before|during|with|without|a\s+normal|the\s+score|the\s+diagnosis|the\s+patient|patients?)\b/i;

const NOT_DEFINITION_ADJ =
  /^(?:common|rare|frequent|major|minor|useful|important|recogni[sz]ed|good|poor|late|early|typical|classic(?:al)?|well|very|more|less|key|possible|known|serious|potential|sensitive|specific|reliable|non-specific|leading|frequently|recognised)\b/i;

const VALUE_CUT = /\s+(?:above|below|over|under|greater than|less than|more than|of at least|exceeding|>|<|≥|≤|>=|<=)\s*[0-9٠-٩]/i;

// ───────── small text helpers ─────────
function cleanName(s: string): string {
  return stripBidiControls(s)
    .replace(/^[\s•▪◦●○■□\-–—*·]+/u, '')
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/[.:;،,؛]+$/u, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function scriptOf(s: string): 'en' | 'ar' {
  return /[؀-ۿ]/.test(s) ? 'ar' : 'en';
}

function normLite(s: string): string {
  return stripBidiControls(s)
    .normalize('NFKC')
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[آأإٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .toLowerCase();
}

/** A concept name: 1–6 words, at least one token that is neither generic nor structural, not a number. */
export function meaningfulName(name: string): boolean {
  if (name.length < 2 || name.length > 80) return false;
  const words = name.split(/\s+/);
  if (words.length > 6) return false;
  if (/^[0-9\s.,%/×<>≥≤—–\-+]+$/.test(name)) return false;
  // a value with its unit («12 mg», «> 10 ×10⁹/L») is not a concept name
  if (/^[<>≤≥~±]?\s*[0-9٠-٩][0-9٠-٩.,]*\s*(?:[×x]\s*10\S*)?\s*(?:[%°‰]|[a-zA-Zµμ]{1,5}(?:\/[a-zA-Zµμ0-9]{1,5})?)?\s*$/u.test(name)) return false;
  if (PRONOUN_START.test(name)) return false;
  const toks = contentTokens(name);
  if (toks.length === 0) return false;
  return toks.some((t) => !t.generic && !STRUCTURAL.has(t.norm) && !STRUCTURAL.has(t.stem) && t.norm.length >= 2);
}

/** Strip structural / connective words at both ends («Alvarado score components» → «Alvarado score»). */
function trimStructural(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  const edge = (w: string) => {
    const n = normLite(w).replace(/[^\p{L}\p{N}]/gu, '');
    return STRUCTURAL.has(n) || /^(?:of|in|for|by|and|or|the|a|an|to|with|on|from|في|من|الى|على|و|او|عن)$/.test(n);
  };
  while (words.length && edge(words[0]!)) words.shift();
  while (words.length && edge(words[words.length - 1]!)) words.pop();
  return words.join(' ');
}

/** Section role of a heading (first matching rule), from the whole heading text. */
export function sectionRoleOf(heading: string): SectionRole | null {
  const n = normLite(heading);
  for (const r of SECTION_RULES) if (r.re.test(n)) return r.role;
  return null;
}

/** Heading part without its section keywords: «Types of shock» → «shock», «Management of X» → «X». */
function headingConceptPart(part: string): string {
  let s = cleanName(part);
  const n = normLite(s);
  for (const r of SECTION_RULES) {
    if (!r.re.test(n)) continue;
    // remove the keyword phrase from the printed text (English only — Arabic keywords make the part structural)
    s = s.replace(new RegExp(r.re.source.replace(/\\b/g, '\\b'), 'gi'), ' ');
  }
  return trimStructural(s.replace(/\s+/g, ' ').trim());
}

/** Sentences of a text with their exact substrings (decimal points and abbreviations survive). */
export function sentencesOf(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\n+/)) {
    const parts = line.split(/(?<=[.!?؟])\s+(?=[\p{Lu}؀-ۿ(«"“])|;\s+|؛\s*/u);
    for (const p of parts) {
      const t = p.trim();
      if (t) out.push(t);
    }
  }
  return out;
}

function splitList(list: string): string[] {
  return list
    .replace(/[.。]+$/u, '')
    .split(/\s*[,،]\s*|\s+(?:and|or|and\/or)\s+|\s+(?:او|أو|و)\s+/u)
    .map((x) => cleanName(x.replace(/^(?:the|a|an)\s+/i, '').replace(/^(?:و|او|أو)\s*/u, '')))
    .filter(Boolean);
}

/** Arabic text without harakat / tatweel + map from each kept char to its index in the original. */
function arabicMatchable(text: string): { s: string; map: number[] } {
  let s = '';
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (/[ً-ٰٟـ]/.test(ch)) continue;
    s += ch === 'أ' || ch === 'إ' || ch === 'آ' || ch === 'ٱ' ? 'ا' : ch === 'ى' ? 'ي' : ch;
    map.push(i);
  }
  return { s, map };
}

function originalSlice(text: string, map: number[], start: number, end: number): string {
  if (start >= end) return '';
  return text.slice(map[start]!, map[end - 1]! + 1);
}

// ───────── sentence patterns ─────────
const NP = String.raw`([\p{L}\p{N}'’\-–/ β]{2,70}?)`;
const ART = String.raw`(?:(?:an?|the)\s+)?`;
const EN_DEFINED = new RegExp(String.raw`^${ART}${NP}\s+(?:is|are)\s+(?:defined|described)\s+as\b`, 'iu');
const EN_REFERS = new RegExp(String.raw`^${ART}${NP}\s+(?:refers?\s+to|means|is\s+termed|is\s+called|denotes)\b`, 'iu');
const EN_CLASSIFIED = new RegExp(String.raw`^${ART}${NP}\s+(?:is|are|can\s+be|may\s+be)\s+(?:classified|divided|categori[sz]ed|grouped|subdivided)\s+(?:as|into)\s+(.+)$`, 'iu');
const EN_IS_A = new RegExp(String.raw`^${ART}${NP}\s+(?:is|are)\s+(?:an?)\s+(\S+)`, 'iu');
const EN_SUBJECT = new RegExp(
  String.raw`^${ART}([\p{L}\p{N}'’\-–/ β()×⁰¹²³⁴⁵⁶⁷⁸⁹.,%<>≥≤]{2,90}?)\s+(?:is|are|remains?|may|can|should|must|usually|typically|often|supports?|suggests?|confirms?|indicates?|requires?|shows?|causes?|occurs?|follows?|includes?|presents?)\b`,
  'iu',
);
const EN_ENUM = /\b(?:includes?|including|comprises?|consists?\s+of|such\s+as)\s+(.+)$/iu;

// Arabic (on harakat-free text, alef unified)
const AR_DEFINED = /^(?:و?[يت]عرف)\s+(.{2,50}?)\s+(?:بانه|بانها|عل[يى] انه|عل[يى] انها|بانهم)/u;
const AR_CLASSIFIED = /^(?:و?[يت]صنف|و?[يت]قسم)\s+(.{2,50}?)\s+ال[يى]\s+(.+)$/u;
const AR_COPULA = /^(.{2,40}?)\s+(?:هو|هي)\s+\S/u;
const AR_ENUM = /(?:يشمل|تشمل|يتضمن|تتضمن|تضم|يضم|مثل)\s+(.+)$/u;

function wordsCount(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

function nameRole(name: string): ConceptRole | null {
  const n = normLite(name);
  if (/\b(?:sign|signs|symptom|symptoms|syndrome|reflex|triad)$/.test(n)) return 'sign';
  if (/\b(?:test|tests|scan|imaging|ultrasound|ultrasonography|ct|mri|x-ray|xray|biopsy|endoscopy|culture|count|level|levels|ecg|echo)$/.test(n)) return 'investigation';
  return null;
}

// ───────── the extractor ─────────
type SectionState = { title: string; role: SectionRole | null } | null;

export function extractKnowledge(regions: RegionIn[]): Extraction {
  const mentions: Mention[] = [];
  const objectives: Objective[] = [];
  const sections: Extraction['sections'] = [];
  let section: SectionState = null;

  const add = (raw: string, role: ConceptRole, r: RegionIn, quote: string, alt: string | null = null) => {
    let name = cleanName(raw);
    if (role !== 'heading' && role !== 'figure') name = name.replace(/^(?:the|a|an)\s+/i, '');
    if (!meaningfulName(name)) return;
    const altName = alt ? cleanName(alt) : null;
    mentions.push({
      name,
      nameAlt: altName && meaningfulName(altName) ? altName : null,
      lang: scriptOf(name),
      role,
      regionId: r.id,
      pageId: r.page_id,
      quote: quote.trim().slice(0, 600),
      section: section?.title ?? null,
    });
  };
  const sectionRole = (): ConceptRole | null => (section?.role && section.role !== 'objective' ? section.role : null);

  const fromSentenceEn = (sent: string, r: RegionIn): boolean => {
    let m = EN_DEFINED.exec(sent) ?? EN_REFERS.exec(sent);
    if (m) {
      add(m[1]!, 'definition', r, sent);
      return true;
    }
    m = EN_CLASSIFIED.exec(sent);
    if (m) {
      add(m[1]!, 'classification', r, sent);
      for (const item of splitList(m[2]!)) if (wordsCount(item) <= 5) add(item, 'classification', r, sent);
      return true;
    }
    m = EN_IS_A.exec(sent);
    if (m && !NOT_DEFINITION_ADJ.test(m[2]!)) {
      add(m[1]!, 'definition', r, sent);
      return true;
    }
    let found = false;
    const en = EN_ENUM.exec(sent);
    if (en) {
      const subject = sent.slice(0, en.index);
      const role: ConceptRole = /differential/i.test(subject) ? 'differential' : /complication/i.test(subject) ? 'complication' : (sectionRole() ?? 'feature');
      for (const item of splitList(en[1]!)) if (wordsCount(item) <= 5) add(item, role, r, sent);
      found = true;
    }
    m = EN_SUBJECT.exec(sent);
    if (m) {
      let np = m[1]!.trim();
      if (/[,;:]/.test(np.replace(/\([^)]*\)/g, ''))) return found;
      let role: ConceptRole = sectionRole() ?? 'feature';
      const cut = VALUE_CUT.exec(np);
      if (cut) {
        np = np.slice(0, cut.index);
        role = 'value';
      } else if (numberUnitTokens(np).length > 0) return found;
      np = np.replace(/\s+(?:with|without|in|of the|during|after|before|at)\s+.*$/i, '');
      if (role === 'feature') role = nameRole(cleanName(np)) ?? 'feature';
      const parts = np.split(/\s+and\s+/i);
      // the subject of «X is defined / differential diagnosis includes …» is structure, not a concept
      if (!/^(?:the\s+)?(?:differential diagnosis|diagnosis|treatment|management)$/i.test(np.trim())) {
        for (const p of parts) if (wordsCount(p) <= 5) add(p, role, r, sent);
      }
      found = true;
    }
    return found;
  };

  const fromSentenceAr = (sent: string, r: RegionIn): boolean => {
    const { s, map } = arabicMatchable(sent);
    const orig = (m: RegExpExecArray, g: number) => {
      const start = m.index + m[0].indexOf(m[g]!);
      return originalSlice(sent, map, start, start + m[g]!.length);
    };
    let m = AR_DEFINED.exec(s);
    if (m) {
      add(orig(m, 1), 'definition', r, sent);
      return true;
    }
    m = AR_CLASSIFIED.exec(s);
    if (m) {
      add(orig(m, 1), 'classification', r, sent);
      for (const item of splitList(orig(m, 2))) if (wordsCount(item) <= 4) add(item, 'classification', r, sent);
      return true;
    }
    m = AR_ENUM.exec(s);
    if (m) {
      const role = sectionRole() ?? 'feature';
      for (const item of splitList(orig(m, 1))) if (wordsCount(item) <= 4) add(item, role, r, sent);
      return true;
    }
    m = AR_COPULA.exec(s);
    if (m && wordsCount(m[1]!) <= 4) {
      add(orig(m, 1), 'definition', r, sent);
      return true;
    }
    return false;
  };

  for (const r of regions) {
    if (r.parent_region_id) continue; // table cells / diagram children are read through their parent
    if (r.kind === 'header' || r.kind === 'footer' || r.kind === 'question' || r.kind === 'option' || r.kind === 'answer_key') continue;
    const text = stripBidiControls(r.text ?? '').trim();

    if (r.kind === 'heading') {
      const role = sectionRoleOf(text);
      const parts = text.split(/\s+[—–]\s+|\s+-\s+|:\s+/).map((p) => p.trim()).filter(Boolean);
      const conceptParts = parts.map((p) => headingConceptPart(p)).filter((p) => meaningfulName(p));
      section = { title: text, role };
      sections.push({ title: text, role, regionId: r.id });
      if (conceptParts.length === 2 && scriptOf(conceptParts[0]!) !== scriptOf(conceptParts[1]!)) {
        const en = conceptParts.find((p) => scriptOf(p) === 'en')!;
        const ar = conceptParts.find((p) => scriptOf(p) === 'ar')!;
        add(en, 'heading', r, text, ar);
      } else {
        for (const p of conceptParts) add(p, 'heading', r, text);
      }
      continue;
    }

    if (r.kind === 'table') {
      const st = fromJson<TableStructure | null>(r.structure_json, null);
      if (!st || st.type !== 'table') continue;
      const rows = new Map<number, typeof st.cells>();
      for (const c of st.cells) {
        const list = rows.get(c.r) ?? [];
        list.push(c);
        rows.set(c.r, list);
      }
      let tableTitle: string | null = null;
      for (const c of st.cells) {
        if (c.header && (c.colspan ?? 1) > 1 && c.text) {
          tableTitle = c.text;
          const parts = c.text.split(/\s+[—–]\s+/).map((p) => trimStructural(cleanName(p))).filter((p) => meaningfulName(p));
          if (parts.length === 2 && scriptOf(parts[0]!) !== scriptOf(parts[1]!)) add(parts.find((p) => scriptOf(p) === 'en')!, 'heading', r, c.text, parts.find((p) => scriptOf(p) === 'ar')!);
          else for (const p of parts) add(p, 'heading', r, c.text);
        }
      }
      const prev: SectionState = section;
      section = { title: tableTitle ?? prev?.title ?? '', role: prev?.role ?? null };
      for (const [, cells] of [...rows.entries()].sort((a, b) => a[0] - b[0])) {
        const first = cells.find((c) => c.c === 0 && !c.header);
        if (!first || !first.text) continue;
        const others = cells.filter((c) => c !== first).map((c) => c.text ?? '');
        const hasValue = others.some((t) => /[<>≤≥]/.test(t) || (numberUnitTokens(t).length > 0 && /[a-zA-Z%°×µμ]/.test(t.replace(/^[^0-9]*/, ''))));
        // a table does not inherit the role of the section before it: only its own title can give one
        const own = tableTitle ? sectionRoleOf(tableTitle) : null;
        add(first.text, hasValue ? 'value' : own && own !== 'objective' ? own : 'table_entry', r, first.text);
      }
      section = prev;
      continue;
    }

    if (r.kind === 'caption') {
      const body = cleanName(text.replace(/^(?:table|figure|fig\.?|جدول|شكل)\s*[0-9٠-٩]*\s*[:.\-–]\s*/i, ''));
      for (const part of body.split(/\s+(?:by|of|for|in|according to|حسب|ل)\s+/i)) {
        const p = trimStructural(part);
        if (meaningfulName(p) && wordsCount(p) <= 4) add(p, 'figure', r, text);
      }
      continue;
    }

    if (!['paragraph', 'list_item', 'text_block', 'note', 'transcript'].includes(r.kind) || !text) continue;

    // objectives are kept as objectives, never turned into concepts
    if (section?.role === 'objective') {
      for (const line of text.split(/\n+/)) {
        const t = cleanName(line);
        if (t.length >= 3) objectives.push({ text: line.replace(/^[\s•▪◦●○■□\-–—*·]+/u, '').trim(), regionId: r.id, pageId: r.page_id });
      }
      continue;
    }

    for (const line of text.split(/\n+/)) {
      const t = line.trim();
      if (!t) continue;
      const bare = cleanName(t);
      const isShortItem = wordsCount(bare) <= 6 && !/[.!?؟]$/.test(t.replace(/\s+$/, '')) && !/\b(?:is|are|was|were)\b/i.test(bare);
      if ((r.kind === 'list_item' || /^[•▪◦●○■□\-–*]/u.test(t)) && isShortItem) {
        add(bare, sectionRole() ?? 'feature', r, t);
        continue;
      }
      for (const sent of sentencesOf(t)) {
        if (scriptOf(sent) === 'ar' && /^[؀-ۿ]/.test(sent.trim())) fromSentenceAr(sent, r);
        else fromSentenceEn(sent, r);
      }
    }
  }

  // one mention per (name key, region, role)
  const seen = new Set<string>();
  const unique = mentions.filter((m) => {
    const k = `${normLite(m.name)}|${m.regionId}|${m.role}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { mentions: unique, objectives, sections };
}
