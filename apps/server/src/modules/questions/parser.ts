// Deterministic question extraction (§33, §34; AC-10, AC-12, AC-13, AC-14). Input: the regions of ONE source
// version in reading order (digital text or OCR), already split into lines. Output: questions with their
// section identity, printed number, stem, options (labels as printed), spanned pages/regions, attached figures,
// plus answer-key entries and unofficial marks. No guessing:
//   * a key is bound by (version, section_key, printed_number) — never by the number alone (AC-12);
//   * a key without a section in a multi-section file stays unbound (→ review);
//   * a circled / hand-marked option is recorded as an UNOFFICIAL mark, never as a key (AC-13).
import type { NormBox, QuestionValidationIssue, TableStructure } from '@medlevo/shared';
import { normalizeForSearch, stripBidiControls } from '@medlevo/shared';
import { circledLetter, endsMidPhrase, labelAt, labelInfo, type LabelScript } from './text';

export const PARSER_VERSION = 'qparse-v1';

export interface ParserLine {
  text: string;
  regionId: string | null;
  regionKind: string;
  pageIndex: number;
  pageId: string | null;
  bbox: NormBox | null;
  /** region status from processing ('needs_review' = uncertain OCR / extraction) */
  regionStatus: string;
  confidence: number | null;
  textOrigin: string | null;
  table?: TableStructure | null;
}

export interface ParsedOption {
  label: string;
  text: string;
  lines: ParserLine[];
  /** a circle / tick was detected around or next to the label */
  mark: 'circled_option' | 'handwritten' | null;
  markReason: string | null;
}

export interface ParsedQuestion {
  sectionKey: string;
  sectionTitle: string | null;
  /** printed number ('3') or null for an unnumbered question */
  printedNumber: string | null;
  /** stable identity inside the section: printed number or 'u<n>' */
  itemKey: string;
  ord: number;
  stem: string;
  /** stem lines exactly as printed (including the number prefix) */
  stemRaw: string;
  options: ParsedOption[];
  /** all lines of the block (stem + options + attached tables) — the raw reference for AC-11 */
  lines: ParserLine[];
  figures: ParserLine[];
  explanation: string | null;
  issues: QuestionValidationIssue[];
  numberingStyle: string;
}

export interface ParsedKey {
  /** null = no section printed with the key (binding decided later) */
  sectionLabel: string | null;
  sectionTitle: string | null;
  printedNumber: string;
  keyLabel: string;
  markKind: 'printed_key' | 'key_table' | 'circled_option' | 'handwritten';
  originKnown: boolean;
  keyBlock: number;
  /** key block context: the question section that was current when the block started */
  afterSectionKey: string | null;
  /** inline key («Answer: B») right after its question → bound to that question */
  inlineFor: { sectionKey: string; itemKey: string } | null;
  line: ParserLine;
  rawText: string;
}

export interface ParsedSection {
  key: string;
  title: string | null;
  ordinal: number;
  implicit: boolean;
}

export interface KeyBlockInfo {
  ordinal: number;
  afterSectionKey: string | null;
  /** a question section starts after this block (per-section keys printed between sections) */
  followedBySection: boolean;
  pageIndex: number;
  title: string | null;
}

export interface ParseResult {
  questions: ParsedQuestion[];
  keys: ParsedKey[];
  sections: ParsedSection[];
  keyBlocks: KeyBlockInfo[];
  /** lines under an answer-key heading that look like keys in a layout the parser cannot read (reported, never guessed) */
  unreadKeyLines?: UnreadKeyLine[];
}

export interface UnreadKeyLine {
  text: string;
  line: ParserLine;
  /** the key heading as printed */
  heading: string | null;
}

/** Numbers and option letters only, in an unknown key layout («1 ➜ B», «Q1 is B», «1: B Q2: C») — not a question. */
function looksLikeUnreadKey(text: string): boolean {
  if (text.length > 160) return false;
  const pairs = [...text.matchAll(/[0-9٠-٩]{1,3}\s*\S{0,3}\s*\(?(?:[A-Ha-h]|أ|ب|ج|د|هـ|ه|و)\)?(?![\p{L}\p{N}])/gu)].length;
  if (pairs === 0) return false;
  // a real question start carries a stem («1. Which …»), not one letter
  const words = text.replace(/[0-9٠-٩]+/g, ' ').split(/[^\p{L}]+/u).filter((w) => w.length > 2);
  return words.length <= pairs;
}

// ───────── line patterns ─────────
const KEY_HEADING =
  /^(?:answer\s*keys?|answers?|key\s*answers?|correct\s+answers?|answer\s+sheet|model\s+answers?|key)\b\s*(?:\(([^)]*)\))?\s*[:\-–—]?\s*(.*)$/i;
const KEY_HEADING_AR = /^(?:مفتاح\s*(?:ال)?[إا]جاب(?:ة|ات)|مفتاح\s*(?:ال)?[أا]جوبة|(?:ال)?[إا]جابات(?:\s+الصحيحة)?|(?:ال)?[أا]جوبة(?:\s+الصحيحة)?|الحلول|مفتاح)\s*[:\-–—]?\s*(.*)$/u;
const SECTION_EN = /^(?:section|part|unit|paper|block)\s*[-–:.]?\s*([A-Z]|[IVX]{1,4}|\d{1,2})(?![A-Za-z0-9])\s*(.*)$/i;
const SECTION_AR = /^(?:القسم|الجزء|المجموعة|قسم|جزء)\s*[-–:.]?\s*([^\s:—–\-]+)\s*(.*)$/u;
const AR_ORDINALS: Record<string, string> = {
  الاول: '1', اول: '1', الثاني: '2', ثاني: '2', الثالث: '3', ثالث: '3', الرابع: '4', رابع: '4', الخامس: '5', خامس: '5', السادس: '6', سادس: '6',
};
const INLINE_KEY = /^(?:answer|ans\.?|correct\s+answer|key)\s*[:：\-–]\s*\(?([A-Ha-h]|[0-9]{1,2})\)?\s*\.?\s*$/i;
const INLINE_KEY_AR = /^(?:ال)?[إا]جاب(?:ة)?(?:\s+الصحيحة)?\s*[:：\-–]\s*\(?(أ|ا|ب|ج|د|هـ|ه|و|[A-Ha-h])\)?\s*\.?\s*$/u;
const EXPLANATION = /^(?:explanation|rationale|comment|الشرح|التعليل|التفسير)\s*[:：\-–]\s*(.*)$/iu;
// «1. B», «1-B», «1(B)», and (G4 / AC-12) «Q1: B», «Question 1 = B», «1 → B», «س1: ب» — such keys were not read, and
// «Q1: B Q2: C» even became a bogus question «B Q2: C» while every real question showed «no key»
const KEY_PAIR = /(?:(?:[Qq](?:uestion)?|(?:ال)?سؤال|س)\s*\.?\s*)?([0-9٠-٩]{1,3})\s*(?:[.)\-:–=]|→|⇒|->)?\s*\(?([A-Ha-h]|أ|ب|ج|د|هـ|ه|و)\)?(?![\p{L}\p{N}])/gu;

interface QStart {
  n: number;
  printed: string;
  rest: string;
  style: string;
}

function toAsciiDigits(s: string): string {
  return s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
}

function parseQuestionStart(text: string): QStart | null {
  let m = /^\s*Q(?:uestion)?\s*\.?\s*([0-9٠-٩]{1,3})\s*[.):\-–]?\s+(\S.*)$/i.exec(text);
  if (m) return { n: Number(toAsciiDigits(m[1]!)), printed: toAsciiDigits(m[1]!), rest: m[2]!, style: 'q' };
  m = /^\s*(?:ال)?سؤال\s*(?:رقم\s*)?([0-9٠-٩]{1,3})\s*[.):\-–]?\s*(\S.*)$/u.exec(text);
  if (m) return { n: Number(toAsciiDigits(m[1]!)), printed: toAsciiDigits(m[1]!), rest: m[2]!, style: 'ar_q' };
  m = /^\s*\(([0-9٠-٩]{1,3})\)\s*(\S.*)$/u.exec(text);
  if (m) return { n: Number(toAsciiDigits(m[1]!)), printed: toAsciiDigits(m[1]!), rest: m[2]!, style: 'wrapped' };
  m = /^\s*([0-9٠-٩]{1,3})(\s*)([.)\-–])(\s*)(\S.*)$/u.exec(text);
  if (m) {
    const delim = m[3]!;
    const rest = m[5]!;
    // a number right after the delimiter is usually a value, not numbering: «3.5 mmol», «10 - 15 mg/kg», «10-15»
    // — except a stem that opens with the patient's age («3. 60-year-old woman …», «12- 45 years old …») and a
    // dash numbering written «1- 25 mg» (no space before the dash, one after: numeric options)
    if (delim !== ')' && /^[0-9٠-٩]/.test(rest)) {
      const age = !!m[4] && AGE_OPENING.test(rest);
      const dashNumbering = delim !== '.' && !m[2] && !!m[4];
      if (!age && !dashNumbering) return null;
    }
    return { n: Number(toAsciiDigits(m[1]!)), printed: toAsciiDigits(m[1]!), rest, style: delim === ')' ? 'paren' : delim === '.' ? 'dot' : 'dash' };
  }
  return null;
}

/** Text that introduces a group of questions (a shared case / vignette). */
const CASE_REF =
  /\b(?:questions?|items?|Qs?)\s*\d+\s*(?:-|–|to|and|&)\s*\d+\b|\b(?:refers?|relates?|based)\s+(?:to|on)\s+the\s+following\b|\bthe\s+following\s+(?:case|scenario|vignette|information|history)\b|(?:الأسئلة|الاسئلة)\s+(?:من\s+)?[0-9٠-٩]+\s*(?:-|–|إلى|الى|و)\s*[0-9٠-٩]+|(?:الحالة|الحاله)\s+(?:التالية|التاليه|الآتية)/iu;

const clip = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** «60-year-old», «45 years old», «3 yr», «6-month-old», «25 سنة» … at the start of a stem. */
const AGE_OPENING = /^[0-9٠-٩]{1,3}\s*-?\s*(?:years?|yrs?|y\.?\s*o\b|year-old|months?|month-old|weeks?|week-old|days?|day-old|سنة|سنوات|عامًا|عاما|عام|شهرًا|شهرا|شهر|أشهر|اسابيع|أسابيع|يومًا|يوما|أيام)/iu;

interface OptStart {
  label: string;
  script: LabelScript;
  index: number;
  rest: string;
  mark: ParsedOption['mark'];
  markReason: string | null;
}

function parseOptionStart(text: string): OptStart | null {
  const t = text.replace(/^\s+/, '');
  const first = Array.from(t)[0] ?? '';
  const circ = circledLetter(first);
  if (circ) {
    const rest = t.slice(first.length).replace(/^[\s.)]+/, '');
    if (rest) return { label: circ, script: 'latin', index: 'ABCDEFGH'.indexOf(circ), rest, mark: 'circled_option', markReason: 'circle_glyph' };
  }
  let m = /^\(\s*([A-Ha-h])\s*\)\s*(\S.*)$/.exec(t);
  if (m) return mk(m[1]!, m[2]!, null, null);
  // "(A Dttrasound": an opening bracket with no closing one — typically a hand-drawn circle read by OCR
  m = /^\(\s*([A-Ha-h])\s+(\S.*)$/.exec(t);
  if (m && !m[2]!.includes(')')) return mk(m[1]!, m[2]!, 'circled_option', 'open_bracket');
  m = /^([A-H])\s*[.)\]:]\s*(\S.*)$/.exec(t) ?? /^([a-h])\s*[.)\]:]\s+(\S.*)$/.exec(t);
  if (m) return mk(m[1]!, m[2]!, null, null);
  m = /^(\(?)\s*(أ|ا|ب|ج|د|هـ|ه|و)\s*([.)\-:])\s*(\S.*)$/u.exec(t);
  if (m) {
    // «(ب. …»: an opening bracket closed by something else — the OCR reading of a hand-drawn circle (G3 / AC-13)
    const circled = m[1] === '(' && m[3] !== ')' && !m[4]!.includes(')');
    return mk(m[2]!, m[4]!, circled ? 'circled_option' : null, circled ? 'open_bracket' : null);
  }
  return null;

  function mk(label: string, rest: string, mark: OptStart['mark'], markReason: string | null): OptStart | null {
    const info = labelInfo(label);
    if (!info) return null;
    let mk2 = mark;
    let reason = markReason;
    if (!mk2 && /[✓✔☑✗✘]/u.test(rest)) {
      mk2 = 'handwritten';
      reason = 'tick_glyph';
    }
    return { label, script: info.script, index: info.index, rest, mark: mk2, markReason: reason };
  }
}

/** A raw line without its leading question number / option label, by the parser's own rules (for AC-11 checks). */
export function stripStructurePrefix(line: string): string {
  const t = stripBidiControls(line);
  const qs = parseQuestionStart(t);
  if (qs) return qs.rest;
  const o = parseOptionStart(t);
  if (o) return o.rest;
  return t.trim();
}

/** "A. x  B. y  C. z" on one line → separate option lines (labels must be consecutive). */
function splitInlineOptions(text: string): string[] {
  const re = /(^|\s)\(?([A-H]|أ|ب|ج|د|هـ|و)[.)]\s+/gu;
  const hits: Array<{ at: number; label: string }> = [];
  for (const m of text.matchAll(re)) hits.push({ at: (m.index ?? 0) + m[1]!.length, label: m[2]! });
  if (hits.length < 2) return [text];
  // keep the longest consecutive run starting at its first label
  let best: typeof hits = [];
  for (let s = 0; s < hits.length; s++) {
    const first = labelInfo(hits[s]!.label);
    if (!first) continue;
    const run = [hits[s]!];
    for (let k = s + 1; k < hits.length; k++) {
      const info = labelInfo(hits[k]!.label);
      const prev = labelInfo(run[run.length - 1]!.label);
      if (info && prev && info.script === prev.script && info.index === prev.index + 1) run.push(hits[k]!);
    }
    if (run.length > best.length) best = run;
  }
  if (best.length < 2) return [text];
  const startInfo = labelInfo(best[0]!.label);
  // a run starting mid-line must start at the first label (A / أ); at line start any label works
  if (best[0]!.at > 0 && startInfo?.index !== 0) return [text];
  const parts: string[] = [];
  if (best[0]!.at > 0) parts.push(text.slice(0, best[0]!.at).trim());
  for (let i = 0; i < best.length; i++) parts.push(text.slice(best[i]!.at, i + 1 < best.length ? best[i + 1]!.at : undefined).trim());
  return parts.filter((p) => p.length > 0);
}

/** "1. B 2. C 3. B" → pairs; null when the text is not ENTIRELY key pairs. */
export function parseKeyPairs(text: string): Array<{ n: string; label: string }> | null {
  const clean = stripBidiControls(text).trim();
  if (!clean) return null;
  const pairs: Array<{ n: string; label: string }> = [];
  let consumed = '';
  for (const m of clean.matchAll(KEY_PAIR)) {
    pairs.push({ n: toAsciiDigits(m[1]!), label: m[2]! });
    consumed += m[0];
  }
  if (pairs.length === 0) return null;
  // everything else must be separators
  const leftover = clean.replace(KEY_PAIR, ' ').replace(/[\s,;،؛|/.\-–]+/g, '');
  if (leftover.length > 0) return null;
  return pairs;
}

function sectionKeyFrom(label: string): string {
  const n = normalizeForSearch(label).replace(/[^\p{L}\p{N}]/gu, '');
  if (AR_ORDINALS[n]) return AR_ORDINALS[n]!;
  const info = labelInfo(label);
  if (info && info.script === 'arabic') return info.canonical;
  return label.toUpperCase();
}

function parseSectionHeader(text: string): { key: string; title: string; rest: string } | null {
  const t = stripBidiControls(text).trim();
  const m = SECTION_EN.exec(t) ?? SECTION_AR.exec(t);
  if (!m) return null;
  const rest = m[2]!.replace(/^[\s:—–\-]+/, '');
  // a long line is a section header only when it is a section's key run («Section 3: 1. B 2. C … 40. D», G4 / AC-12)
  if (t.length > 90 && !parseKeyPairs(rest)) return null;
  return { key: sectionKeyFrom(m[1]!), title: t, rest };
}

/** Where a section label followed by «:» / «—» starts inside a line (EN «Section B:», AR «القسم الثاني:»). */
const SECTION_LABEL_AT =
  /(?:^|\s)(?=(?:section|part|unit|paper|block)\s*[-–:.]?\s*(?:[A-Z]|[IVX]{1,4}|\d{1,2})(?![A-Za-z0-9])\s*[:\-–—]|(?:القسم|الجزء|المجموعة)\s*[-–:.]?\s*[^\s:—–\-]+\s*[:\-–—])/giu;

/**
 * Several section-labelled key runs printed on ONE line, or merged into one region by the layout
 * («Section B: 1. C 2. B 3. A Section A: 1. B 2. D», «Answer Key: القسم الأول: 1. ب … القسم الثاني: 1. ج …») → one line
 * per section, so each run keeps its own section (G4 / AC-12: such a line was dropped whole and every question stayed
 * «missing key»). The line is left unchanged unless EVERY run is «<section label>: <key pairs>» (and the text before
 * the first run, if any, is an answer-key heading).
 */
export function splitSectionKeyRuns(line: string): string[] {
  const text = stripBidiControls(line).trim();
  const starts: number[] = [];
  for (const m of text.matchAll(SECTION_LABEL_AT)) starts.push((m.index ?? 0) + m[0].length);
  if (starts.length < 2) return [line];
  const runs = starts.map((at, i) => text.slice(at, starts[i + 1]).trim());
  const allKeyRuns = runs.every((r) => {
    const m = SECTION_EN.exec(r) ?? SECTION_AR.exec(r);
    return !!m && !!parseKeyPairs(m[2]!.replace(/^[\s:—–\-]+/, ''));
  });
  if (!allKeyRuns) return [line];
  const prefix = text.slice(0, starts[0]).trim();
  if (!prefix) return runs;
  const kh = parseKeyHeading(prefix);
  return kh && !kh.rest ? [prefix, ...runs] : [line];
}

function parseKeyHeading(text: string): { sectionLabel: string | null; rest: string } | null {
  const t = stripBidiControls(text).trim();
  if (t.length > 70 || /[?؟]/.test(t)) return null;
  let m = KEY_HEADING.exec(t);
  if (m) {
    const inner = (m[1] ?? '').trim();
    let rest = (m[2] ?? '').trim();
    let sectionLabel: string | null = null;
    const sec = parseSectionHeader(inner) ?? parseSectionHeader(rest);
    if (sec) {
      sectionLabel = sec.key;
      if (parseSectionHeader(rest)) rest = sec.rest;
    }
    // "Answers" followed by prose is not a key heading ("Answer the following …")
    if (rest && !parseKeyPairs(rest) && !sec) return null;
    return { sectionLabel, rest };
  }
  m = KEY_HEADING_AR.exec(t);
  if (m) {
    let rest = (m[1] ?? '').trim();
    let sectionLabel: string | null = null;
    const sec = parseSectionHeader(rest);
    if (sec) {
      sectionLabel = sec.key;
      rest = sec.rest;
    }
    if (rest && !parseKeyPairs(rest) && !sec) return null;
    return { sectionLabel, rest };
  }
  return null;
}

/** Key table: header row with a question-number column and an answer column (optional section column). */
function parseKeyTable(table: TableStructure): Array<{ section: string | null; n: string; label: string; text: string }> | null {
  const grid = new Map<string, string>();
  for (const c of table.cells) grid.set(`${c.r}:${c.c}`, stripBidiControls(c.text ?? '').trim());
  const cell = (r: number, c: number) => grid.get(`${r}:${c}`) ?? '';
  const isQ = (s: string) => /^(q|q\.|no\.?|#|n|question|qn|السؤال|سؤال|رقم|الرقم)$/iu.test(s);
  const isA = (s: string) => /^(answer|answers|key|ans\.?|correct|correct answer|الإجابة|الاجابة|المفتاح|الجواب)$/iu.test(s);
  const isS = (s: string) => /^(section|part|القسم|الجزء)$/iu.test(s);
  for (let hr = 0; hr < Math.min(table.rows, 3); hr++) {
    let qc = -1;
    let ac = -1;
    let sc = -1;
    for (let c = 0; c < table.cols; c++) {
      const h = cell(hr, c);
      if (qc < 0 && isQ(h)) qc = c;
      else if (ac < 0 && isA(h)) ac = c;
      else if (sc < 0 && isS(h)) sc = c;
    }
    if (qc < 0 || ac < 0) continue;
    const out: Array<{ section: string | null; n: string; label: string; text: string }> = [];
    for (let r = hr + 1; r < table.rows; r++) {
      const n = toAsciiDigits(cell(r, qc)).replace(/[.)]$/, '');
      const label = cell(r, ac).replace(/[.)]$/, '');
      if (!/^[0-9]{1,3}$/.test(n) || !labelInfo(label)) continue;
      const sec = sc >= 0 ? cell(r, sc) : '';
      out.push({ section: sec ? sectionKeyFrom(parseSectionHeader(sec)?.key ?? sec) : null, n, label, text: `${sec ? `${sec} ` : ''}${n} ${label}` });
    }
    return out.length > 0 ? out : null;
  }
  // header-less 2-column table: numbers | labels
  if (table.cols === 2 && table.rows >= 2) {
    const out: Array<{ section: string | null; n: string; label: string; text: string }> = [];
    for (let r = 0; r < table.rows; r++) {
      const n = toAsciiDigits(cell(r, 0)).replace(/[.)]$/, '');
      const label = cell(r, 1).replace(/[.)]$/, '');
      if (!/^[0-9]{1,3}$/.test(n) || !labelInfo(label)) return null;
      out.push({ section: null, n, label, text: `${n} ${label}` });
    }
    return out;
  }
  return null;
}

// ───────── parser ─────────
interface Draft {
  section: ParsedSection;
  start: QStart | null;
  itemKey: string;
  stemLines: Array<{ text: string; line: ParserLine }>;
  stemRaw: string[];
  options: ParsedOption[];
  lines: ParserLine[];
  figures: ParserLine[];
  explanation: string[];
  issues: QuestionValidationIssue[];
  numericOptions: boolean;
  optionStyle: string | null;
  inExplanation: boolean;
}

const issue = (check: QuestionValidationIssue['check'], reason_ar: string, severity: QuestionValidationIssue['severity'] = 'blocker'): QuestionValidationIssue => ({
  check,
  passed: false,
  severity,
  reason_ar,
});

export function parseQuestions(input: ParserLine[]): ParseResult {
  const sections: ParsedSection[] = [];
  const questions: ParsedQuestion[] = [];
  const keys: ParsedKey[] = [];
  const keyBlocks: KeyBlockInfo[] = [];
  const unreadKeyLines: UnreadKeyLine[] = [];

  let section: ParsedSection = { key: '', title: null, ordinal: 1, implicit: true };
  sections.push(section);
  const lastNumberIn = new Map<string, number>(); // section key → last printed number
  const styleIn = new Map<string, string>(); // section key → question numbering style
  const unnumberedIn = new Map<string, number>();
  let draft: Draft | null = null;
  let buffer: ParserLine[] = [];
  /** lines between two questions of a section that no question took (reported by the next question) */
  let dropped: ParserLine[] = [];
  let mode: 'questions' | 'key' = 'questions';
  let keySection: string | null = null;
  let keySectionTitle: string | null = null;
  let currentBlock: KeyBlockInfo | null = null;
  /** a bare section header inside a key block: key sub-heading OR the next question section (decided by the next line) */
  let pendingSection: { key: string; title: string } | null = null;
  let ord = 0;

  const usedSectionKeys = new Set<string>(['']);
  const newSection = (key: string, title: string | null, implicit: boolean) => {
    let k = key;
    // a repeated header label later in the file is a different section (e.g. two "Part A" papers)
    if (usedSectionKeys.has(k) && k !== '') k = `${k}-${sections.length + 1}`;
    usedSectionKeys.add(k);
    // an implicit section that never received a question (title page / preamble) is replaced, not counted
    if (section.implicit && !draft && !questions.some((q) => q.sectionKey === section.key)) sections.pop();
    section = { key: k, title, ordinal: sections.length + 1, implicit };
    sections.push(section);
    for (const b of keyBlocks) b.followedBySection = true;
    pendingSection = null;
    dropped = [];
  };

  const finalize = () => {
    if (!draft) return;
    const d = draft;
    draft = null;
    const stem = d.stemLines.map((s) => s.text).join('\n').trim();
    const stemRaw = d.stemRaw.join('\n');
    const q: ParsedQuestion = {
      sectionKey: d.section.key,
      sectionTitle: d.section.title,
      printedNumber: d.start ? d.start.printed : null,
      itemKey: d.itemKey,
      ord: ord++,
      stem,
      stemRaw,
      options: d.options.map((o) => ({ ...o, text: o.text.trim() })),
      lines: d.lines,
      figures: d.figures,
      explanation: d.explanation.length ? d.explanation.join('\n').trim() : null,
      issues: d.issues,
      numberingStyle: d.start?.style ?? 'none',
    };
    questions.push(q);
  };

  const startQuestion = (start: QStart | null, line: ParserLine, stemText: string, rawText: string) => {
    finalize();
    let itemKey: string;
    if (start) {
      itemKey = start.printed;
      lastNumberIn.set(section.key, start.n);
      if (!styleIn.has(section.key)) styleIn.set(section.key, start.style);
    } else {
      const u = (unnumberedIn.get(section.key) ?? 0) + 1;
      unnumberedIn.set(section.key, u);
      itemKey = `u${u}`;
    }
    const before = dropped;
    dropped = [];
    draft = {
      section,
      start,
      itemKey,
      stemLines: stemText ? [{ text: stemText, line }] : [],
      stemRaw: [rawText],
      options: [],
      lines: [line],
      figures: [],
      explanation: [],
      issues: [],
      numericOptions: false,
      optionStyle: null,
      inExplanation: false,
    };
    buffer = [];
    if (start && before.length > 0) {
      const txt = before.map((l) => l.text).join(' ');
      const shared = CASE_REF.test(txt);
      draft.issues.push(
        issue(
          'stem_complete',
          shared
            ? `قبل هذا السؤال نص يبدو حالة أو مقدمة مشتركة لم تُربط به: «${clip(txt)}». إن كان جزءًا من السؤال فأضفه إلى نصه في المراجعة.`
            : `قبل هذا السؤال نص لم يُربط بأي سؤال: «${clip(txt)}». تحقق أنه ليس جزءًا من نص السؤال.`,
          shared ? 'blocker' : 'warning',
        ),
      );
    }
  };

  const addKey = (k: Omit<ParsedKey, 'keyBlock' | 'afterSectionKey'>) => {
    if (!currentBlock) {
      currentBlock = { ordinal: keyBlocks.length + 1, afterSectionKey: lastQuestionSectionKey(), followedBySection: false, pageIndex: k.line.pageIndex, title: null };
      keyBlocks.push(currentBlock);
    } else {
      // the same number printed again inside one block = a second key list / table (e.g. two adjacent key
      // tables read as one region): a new block, so BOTH printed keys are kept and compared (AC-15)
      const block = currentBlock;
      const repeated = keys.some(
        (e) => e.keyBlock === block.ordinal && e.sectionLabel === k.sectionLabel && e.printedNumber === k.printedNumber && e.markKind === k.markKind,
      );
      if (repeated) {
        currentBlock = { ordinal: keyBlocks.length + 1, afterSectionKey: block.afterSectionKey, followedBySection: false, pageIndex: k.line.pageIndex, title: block.title };
        keyBlocks.push(currentBlock);
      }
    }
    keys.push({ ...k, keyBlock: currentBlock.ordinal, afterSectionKey: currentBlock.afterSectionKey });
  };

  const lastQuestionSectionKey = (): string | null => {
    const d = draft as Draft | null;
    if (d) return d.section.key;
    return questions.length ? questions[questions.length - 1]!.sectionKey : null;
  };

  const openKeyBlock = (line: ParserLine, title: string | null, sectionLabel: string | null) => {
    finalize();
    dropped = [];
    mode = 'key';
    keySection = sectionLabel;
    keySectionTitle = sectionLabel ? title : null;
    currentBlock = { ordinal: keyBlocks.length + 1, afterSectionKey: lastQuestionSectionKey(), followedBySection: false, pageIndex: line.pageIndex, title };
    keyBlocks.push(currentBlock);
  };

  const closeKeyMode = () => {
    pendingSection = null;
    mode = 'questions';
    keySection = null;
    keySectionTitle = null;
    currentBlock = null;
  };

  const handleKeyPairs = (pairs: Array<{ n: string; label: string }>, line: ParserLine, sectionLabel: string | null, sectionTitle: string | null, raw: string) => {
    for (const p of pairs) {
      addKey({ sectionLabel, sectionTitle, printedNumber: p.n, keyLabel: p.label, markKind: 'printed_key', originKnown: true, inlineFor: null, line, rawText: raw });
    }
  };

  const appendOption = (d: Draft, o: OptStart, line: ParserLine) => {
    const prev = d.options[d.options.length - 1];
    if (prev) {
      const pi = labelInfo(prev.label);
      if (pi && o.index === 0 && pi.index >= 1 && o.script === pi.script) {
        d.issues.push(issue('merged_questions', `بدأت الخيارات من جديد (${o.label}) بعد الخيار ${prev.label}؛ يبدو أن سؤالين دُمجا لغياب رقم السؤال الثاني.`));
      } else if (pi && (o.script !== pi.script || o.index !== pi.index + 1)) {
        const expected = pi ? labelAt(pi.script, pi.index + 1) : '?';
        d.issues.push(issue('option_order', `ترتيب الخيارات غير متسلسل: بعد ${prev.label} جاء ${o.label} (المتوقع ${expected})؛ قد يكون خيار مفقودًا.`));
      }
    } else if (o.index !== 0) {
      d.issues.push(issue('option_order', `أول خيار مستخرج هو ${o.label} وليس ${labelAt(o.script, 0)}؛ قد تكون خيارات مفقودة.`));
    }
    d.options.push({ label: o.label, text: o.rest, lines: [line], mark: o.mark, markReason: o.markReason });
    if (!d.lines.includes(line)) d.lines.push(line);
  };

  for (const line0 of input) {
    const isFigure = line0.regionKind === 'figure' || line0.regionKind === 'diagram' || line0.regionKind === 'caption';
    if (isFigure) {
      if (draft && mode === 'questions') (draft as Draft).figures.push(line0);
      continue;
    }
    if (line0.regionKind === 'table' && line0.table) {
      const rows = parseKeyTable(line0.table);
      if (rows) {
        finalize();
        if (mode !== 'key' || !currentBlock) {
          mode = 'key';
          currentBlock = { ordinal: keyBlocks.length + 1, afterSectionKey: lastQuestionSectionKey(), followedBySection: false, pageIndex: line0.pageIndex, title: null };
          keyBlocks.push(currentBlock);
        }
        for (const r of rows) {
          addKey({
            sectionLabel: r.section ?? keySection,
            sectionTitle: r.section ? r.section : keySectionTitle,
            printedNumber: r.n,
            keyLabel: r.label,
            markKind: 'key_table',
            originKnown: true,
            inlineFor: null,
            line: line0,
            rawText: r.text,
          });
        }
        // a table closes its block: a second table is a second (possibly conflicting) key
        currentBlock = null;
        continue;
      }
      if (draft && mode === 'questions') {
        const d = draft as Draft;
        // a data table inside a question (lab values) belongs to the stem
        if (d.options.length === 0) d.stemLines.push({ text: line0.text, line: line0 });
        d.lines.push(line0);
        d.stemRaw.push(line0.text);
      }
      continue;
    }

    for (const rawLine of line0.text.split('\n').flatMap(splitSectionKeyRuns)) {
      const text = stripBidiControls(rawLine).trim();
      if (!text) continue;
      const line: ParserLine = { ...line0, text };

      // 1) answer-key heading
      const kh = parseKeyHeading(text);
      if (kh) {
        openKeyBlock(line, text, kh.sectionLabel);
        if (kh.rest) {
          const pairs = parseKeyPairs(kh.rest);
          if (pairs) handleKeyPairs(pairs, line, keySection, keySectionTitle, text);
        }
        continue;
      }

      // 2) section header (possibly "Section A: 1. B 2. C" inside / starting a key)
      const sh = parseSectionHeader(text);
      if (sh) {
        const pairs = sh.rest ? parseKeyPairs(sh.rest) : null;
        if (pairs && pairs.length >= 1 && (mode === 'key' || pairs.length >= 2)) {
          if (mode !== 'key') openKeyBlock(line, null, null);
          pendingSection = null;
          handleKeyPairs(pairs, line, sh.key, sh.title, text);
          continue;
        }
        if (mode === 'key') {
          keySection = sh.key;
          keySectionTitle = sh.title;
          pendingSection = { key: sh.key, title: sh.title };
          continue;
        }
        if (!sh.rest || !parseQuestionStart(sh.rest)) {
          finalize();
          // the same header repeated at the top of the next page continues the section
          const base = section.key.replace(/-\d+$/, '');
          if (section.implicit || sh.key !== base) newSection(sh.key, sh.title, false);
          buffer = [];
          continue;
        }
      }

      // 3) inside a key block
      if (mode === 'key') {
        const pairs = parseKeyPairs(text);
        if (pairs) {
          handleKeyPairs(pairs, line, keySection, keySectionTitle, text);
          continue;
        }
        // a line right under an answer-key heading that still holds nothing but numbers and option letters in an
        // unknown layout («1 ➜ B», «Q1 is B»): reported as an unread key (G4 / AC-12, AC-14 — the questions must not
        // silently read «no key» while a key is printed), never turned into a question
        const block = currentBlock as KeyBlockInfo | null;
        if (!pendingSection && block && block.title !== null && !keys.some((k) => k.keyBlock === block.ordinal) && looksLikeUnreadKey(text)) {
          unreadKeyLines.push({ text, line, heading: block.title });
          continue;
        }
        // anything else ends the key block (a new question, or prose); a bare section header just before
        // it was the start of the next question section, not a key sub-heading
        const pending = pendingSection;
        closeKeyMode();
        if (pending) newSection(pending.key, pending.title, false);
      }

      // 4) a stand-alone run of ≥ 3 key pairs outside a key heading is still a key
      if (!draft || (draft as Draft).options.length > 0) {
        const pairs = parseKeyPairs(text);
        if (pairs && pairs.length >= 3) {
          openKeyBlock(line, null, null);
          handleKeyPairs(pairs, line, null, null, text);
          closeKeyMode();
          continue;
        }
      }

      // 5) inline key / explanation for the current question
      if (draft) {
        const d = draft as Draft;
        const ik = INLINE_KEY.exec(text) ?? INLINE_KEY_AR.exec(text);
        if (ik && d.options.length > 0) {
          addKey({
            sectionLabel: d.section.key,
            sectionTitle: d.section.title,
            printedNumber: d.start?.printed ?? d.itemKey,
            keyLabel: ik[1]!,
            markKind: 'printed_key',
            originKnown: true,
            inlineFor: { sectionKey: d.section.key, itemKey: d.itemKey },
            line,
            rawText: text,
          });
          currentBlock = null;
          d.lines.push(line);
          continue;
        }
        const ex = EXPLANATION.exec(text);
        if (ex) {
          d.inExplanation = true;
          if (ex[1]) d.explanation.push(ex[1]);
          d.lines.push(line);
          continue;
        }
        if (d.inExplanation) {
          const qs0 = parseQuestionStart(text);
          if (!qs0) {
            d.explanation.push(text);
            d.lines.push(line);
            continue;
          }
        }
      }

      // 6) question start / numeric options
      const qs = parseQuestionStart(text);
      if (qs) {
        const d = draft as Draft | null;
        const last = lastNumberIn.get(section.key);
        const style = styleIn.get(section.key);
        // numeric options inside a question («1) …» under «5. …»): different numbering style, start at 1
        if (d && d.stemLines.length > 0 && !d.inExplanation) {
          const optStyleOk = d.numericOptions ? qs.style === d.optionStyle : style !== undefined && qs.style !== style;
          const lastOpt = d.numericOptions ? Number(d.options[d.options.length - 1]?.label ?? '0') : 0;
          if (optStyleOk && ((d.options.length === 0 && qs.n === 1) || (d.numericOptions && qs.n === lastOpt + 1))) {
            d.numericOptions = true;
            d.optionStyle = qs.style;
            d.options.push({ label: String(qs.n), text: qs.rest, lines: [line], mark: null, markReason: null });
            d.lines.push(line);
            continue;
          }
        }
        let accept = false;
        let reset = false;
        if (last === undefined) accept = true;
        else if (qs.n === last + 1) accept = true;
        else if (qs.n > last + 1 && qs.n <= last + 4) {
          accept = true;
        } else if (qs.n === 1 && last >= 1) {
          accept = true;
          reset = true;
        }
        if (!accept && d) {
          d.issues.push(
            issue('merged_questions', `سطر يبدأ بالرقم ${qs.printed} لا يتبع ترتيب الأسئلة (آخر رقم ${last ?? '—'})؛ أُلحق بالسؤال الحالي — راجع إن كان سؤالًا مستقلًا.`, 'warning'),
          );
        }
        if (accept) {
          finalize();
          if (reset) newSection(`sec-${sections.length + 1}`, null, true);
          const gap = last !== undefined && !reset && qs.n > last + 1;
          startQuestion(qs, line, splitStemAndInlineOptions(qs.rest).stem, text);
          const dd = draft as unknown as Draft;
          if (gap) {
            dd.issues.push(
              issue(
                'stem_complete',
                `قبل هذا السؤال (رقم ${qs.printed}) لم يُعثر على ${qs.n - last! - 1 === 1 ? `السؤال ${last! + 1}` : `الأسئلة ${last! + 1}–${qs.n - 1}`}؛ قد يكون نص مفقود أو غير مقروء.`,
                'warning',
              ),
            );
          }
          for (const optText of splitStemAndInlineOptions(qs.rest).options) {
            const o = parseOptionStart(optText);
            if (o) appendOption(dd, o, line);
          }
          continue;
        }
      }

      // 7) option line (possibly several options on one line)
      const parts = splitInlineOptions(text);
      const firstOpt = parseOptionStart(parts[0]!);
      if (firstOpt || parts.length > 1) {
        let d = draft as Draft | null;
        if (!d && firstOpt) {
          // options with no numbered question: the trailing buffered lines are the stem of an unnumbered question
          const stemLines = trailingStem(buffer);
          if (stemLines.length > 0) {
            startQuestion(null, stemLines[0]!, '', stemLines[0]!.text);
            d = draft as unknown as Draft;
            d.stemLines = stemLines.map((l) => ({ text: l.text, line: l }));
            d.stemRaw = stemLines.map((l) => l.text);
            d.lines = [...stemLines];
          }
        }
        if (d) {
          for (const p of parts) {
            const o = parseOptionStart(p);
            if (o) appendOption(d, o, line);
            else if (d.options.length === 0) {
              d.stemLines.push({ text: p, line });
              d.stemRaw.push(p);
              if (!d.lines.includes(line)) d.lines.push(line);
            } else {
              d.options[d.options.length - 1]!.text += ` ${p}`;
            }
          }
          continue;
        }
      }

      // 8) continuation text
      if (draft) {
        const d = draft as Draft;
        if (d.options.length === 0) {
          d.stemLines.push({ text, line });
          d.stemRaw.push(text);
          d.lines.push(line);
          continue;
        }
        const lastOpt = d.options[d.options.length - 1]!;
        const lastLine = lastOpt.lines[lastOpt.lines.length - 1]!;
        // a wrapped option line: a line that cannot stand alone (starts lower-case / with a bracket or comma, or
        // the option stops mid-phrase «… 3.5 to») — also across a page break — or a short line of the SAME
        // region (the layout wrapped the option's paragraph). Any other line is NOT glued into the option: it may
        // introduce the next questions («The following case relates to questions 2–3»).
        const continues = /^[a-z(,;/]/.test(text) || endsMidPhrase(lastOpt.text);
        const sameRegion = line.regionId !== null && lastOpt.lines.some((l) => l.regionId === line.regionId);
        if (text.length <= 80 && (continues || (sameRegion && !/[.?!؟:]$/.test(lastOpt.text))) && (continues || line.pageIndex === lastLine.pageIndex)) {
          lastOpt.text += ` ${text}`;
          lastOpt.lines.push(line);
          d.lines.push(line);
          continue;
        }
        d.issues.push(
          issue('options_complete', `بعد الخيار ${lastOpt.label} سطر لم يُلحق بالسؤال: «${clip(text)}». إن كان تتمة للخيار فصحح الخيار في المراجعة.`, 'warning'),
        );
        finalize();
      }
      // text between two questions of the same section (not a title / instruction before the first one) is
      // remembered: the next question reports it instead of silently losing it
      if (questions.some((q) => q.sectionKey === section.key)) dropped.push(line);
      buffer.push(line);
      if (buffer.length > 12) buffer.shift();
    }
  }
  finalize();

  // structural checks that need the whole question
  for (const q of questions) {
    if (q.options.length === 1) q.issues.push(issue('options_complete', `استُخرج خيار واحد فقط (${q.options[0]!.label})؛ الخيارات الأخرى مفقودة أو غير مقروءة.`));
    // the layout may join the next questions' introduction to the last option's paragraph
    for (const o of q.options) {
      if (CASE_REF.test(o.text)) {
        q.issues.push(issue('options_complete', `نص الخيار ${o.label} يتضمن ما يبدو مقدمة لأسئلة تالية: «${clip(o.text)}» — افصل نص الخيار عنها في المراجعة.`));
      }
    }
  }
  // number the key blocks that really hold keys 1…n (a heading directly followed by another heading is empty)
  const renumber = new Map<number, number>();
  for (const k of keys) if (!renumber.has(k.keyBlock)) renumber.set(k.keyBlock, renumber.size + 1);
  for (const k of keys) k.keyBlock = renumber.get(k.keyBlock)!;
  const blocks = keyBlocks.filter((b) => renumber.has(b.ordinal)).map((b) => ({ ...b, ordinal: renumber.get(b.ordinal)! }));
  return { questions, keys, sections: sections.filter((sec) => questions.some((q) => q.sectionKey === sec.key)), keyBlocks: blocks, unreadKeyLines };
}

/** "Which …? A. x B. y" written on one line → stem + options. */
function splitStemAndInlineOptions(rest: string): { stem: string; options: string[] } {
  const parts = splitInlineOptions(rest);
  if (parts.length < 2) return { stem: rest, options: [] };
  const firstIsOption = parseOptionStart(parts[0]!) !== null;
  if (firstIsOption) return { stem: '', options: parts };
  return { stem: parts[0]!, options: parts.slice(1) };
}

/** The last contiguous lines (same page) of the buffer that end with a question mark / colon. */
function trailingStem(buffer: ParserLine[]): ParserLine[] {
  if (buffer.length === 0) return [];
  const last = buffer[buffer.length - 1]!;
  if (!/[?؟:]\s*$/.test(last.text)) return [];
  const out = [last];
  for (let i = buffer.length - 2; i >= 0 && out.length < 4; i--) {
    const l = buffer[i]!;
    if (l.pageIndex !== last.pageIndex || /[.?؟!:]\s*$/.test(l.text)) break;
    out.unshift(l);
  }
  return out;
}
