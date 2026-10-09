// Structured, direction-aware rich text.
//
// Bidi strategy (spec §21): content is STRUCTURED into runs that know their language and
// direction. The renderer isolates LTR runs (terms, units, formulas, numbers) with <bdi dir="ltr">
// inside RTL paragraphs. We never inject invisible bidi control characters into stored content,
// and never store visually-reversed text. Logical order is preserved for copy / search / export.
import { z } from 'zod';

export type Dir = 'rtl' | 'ltr';

export const RUN_KINDS = [
  'text', // ordinary prose
  'latin', // auto-detected LTR span (English words, numbers with units, formulas)
  'term', // explicit medical term (may link to MedicalTerm)
  'unit',
  'formula',
  'code',
  'original_quote', // verbatim source text — must match the source exactly
  'number',
] as const;
export type RunKind = (typeof RUN_KINDS)[number];

export const runSchema = z.object({
  t: z.string(),
  dir: z.enum(['rtl', 'ltr']).optional(),
  lang: z.string().max(12).optional(),
  kind: z.enum(RUN_KINDS).optional(),
  marks: z.array(z.enum(['b', 'i', 'u', 'sup', 'sub', 'em'])).optional(),
  /** claim this run belongs to (citations render as Source Chips after the claim) */
  claim: z.string().optional(),
  /** evidence ids directly attached (e.g. original_quote) */
  ev: z.array(z.string()).optional(),
  /** medical term id */
  term: z.string().optional(),
});
export type Run = z.infer<typeof runSchema>;

export const paragraphSchema = z.object({
  dir: z.enum(['rtl', 'ltr']),
  kind: z.enum(['p', 'li', 'h', 'quote', 'caption']).optional(),
  level: z.number().int().min(1).max(4).optional(),
  runs: z.array(runSchema),
});
export type Paragraph = z.infer<typeof paragraphSchema>;

export const richTextSchema = z.object({
  v: z.literal(1),
  paragraphs: z.array(paragraphSchema),
});
export type RichText = z.infer<typeof richTextSchema>;

// ───────── character classes ─────────
// Arabic script blocks (letters, marks, presentation forms). Arabic-Indic digits are NOT strong RTL.
const ARABIC_STRONG = /[؀-؈؋؍؛-ي٭-ٯٱ-ەۥۦۮۯۺ-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;
const HEBREW_STRONG = /[֐-׿]/;
const LATIN_STRONG = /[A-Za-zÀ-ɏͰ-Ͽµ]/; // Latin, Greek (α, β, µ)
const ASCII_DIGIT = /[0-9]/;

function cls(ch: string): 'R' | 'L' | 'D' | 'N' {
  if (ARABIC_STRONG.test(ch) || HEBREW_STRONG.test(ch)) return 'R';
  if (LATIN_STRONG.test(ch)) return 'L';
  if (ASCII_DIGIT.test(ch)) return 'D';
  return 'N';
}

/** Bidi control characters that must never be persisted in content (OCR engines often emit them). */
const BIDI_CONTROLS = /[‎‏‪-‮⁦-⁩؜]/g;

export function stripBidiControls(text: string): string {
  return text.replace(BIDI_CONTROLS, '');
}

export function hasBidiControls(text: string): boolean {
  BIDI_CONTROLS.lastIndex = 0;
  const found = BIDI_CONTROLS.test(text);
  BIDI_CONTROLS.lastIndex = 0;
  return found;
}

/** Paragraph direction from strong characters (not dir="auto" first-strong only). */
export function detectDir(text: string): Dir {
  let r = 0;
  let l = 0;
  for (const ch of text) {
    const c = cls(ch);
    if (c === 'R') r++;
    else if (c === 'L') l++;
  }
  if (r === 0 && l === 0) return 'rtl'; // neutral-only content follows the Arabic-first UI
  return r / (r + l) >= 0.4 ? 'rtl' : 'ltr';
}

const OPENERS = '([{';
const CLOSERS = ')]}';
// neutral characters that commonly attach to LTR expressions without a space
const LEADING_ATTACH = new Set(['+', '-', '−', '±', '~', '≈', '<', '>', '≤', '≥', '#', '$', '@', '↑', '↓']);
const TRAILING_ATTACH = new Set(['+', '-', '−', '%', '°', "'", '′', '″', '²', '³', '⁺', '⁻', '↑', '↓']);

/**
 * Split mixed text into runs. LTR islands (Latin words, digits, units, formulas, arrows between
 * Latin tokens) become {dir:'ltr', kind:'latin'} runs; everything else stays in the paragraph
 * direction. Run texts concatenate back to the exact input (logical order is preserved).
 */
export function segmentRuns(text: string, paragraphDir: Dir = detectDir(text)): Run[] {
  const chars = Array.from(text);
  const classes = chars.map(cls);
  const n = chars.length;
  if (n === 0) return [];
  if (paragraphDir === 'ltr') {
    // In LTR paragraphs isolate RTL islands instead.
    return splitIslands(chars, classes, 'R', 'rtl');
  }
  return splitIslands(chars, classes, 'LD', 'ltr');
}

function splitIslands(chars: string[], classes: string[], strong: 'LD' | 'R', islandDir: Dir): Run[] {
  const n = chars.length;
  const isIslandStrong = (i: number) =>
    strong === 'LD' ? classes[i] === 'L' || classes[i] === 'D' : classes[i] === 'R';
  const isOpposite = (i: number) => (strong === 'LD' ? classes[i] === 'R' : classes[i] === 'L');

  const spans: Array<[number, number]> = [];
  let i = 0;
  while (i < n) {
    if (!isIslandStrong(i)) {
      i++;
      continue;
    }
    let start = i;
    let end = i; // inclusive, last island-strong char
    let j = i + 1;
    while (j < n && !isOpposite(j)) {
      if (isIslandStrong(j)) end = j;
      j++;
    }
    if (strong === 'LD') {
      // attach adjacent symbols (no whitespace) on both sides
      while (start > 0 && LEADING_ATTACH.has(chars[start - 1]!) && start - 1 >= 0 && !isSpace(chars[start - 1]!)) start--;
      while (end + 1 < n && TRAILING_ATTACH.has(chars[end + 1]!)) end++;
      // include balanced brackets that wrap or sit inside the island
      [start, end] = balanceBrackets(chars, start, end);
    }
    spans.push([start, end]);
    i = Math.max(j, end + 1);
  }

  // A pure-digit island in an RTL paragraph that is a plain integer between Arabic words renders
  // correctly without isolation, but isolating is never wrong — keep it uniform (kind 'number').
  const runs: Run[] = [];
  let cursor = 0;
  const baseDir: Dir = islandDir === 'ltr' ? 'rtl' : 'ltr';
  for (const [s, e] of spans) {
    if (s < cursor) continue;
    if (s > cursor) runs.push({ t: chars.slice(cursor, s).join(''), dir: baseDir });
    const t = chars.slice(s, e + 1).join('');
    const onlyDigits = strong === 'LD' && /^[0-9.,:/\s+\-−±%]+$/.test(t);
    runs.push({ t, dir: islandDir, kind: strong === 'LD' ? (onlyDigits ? 'number' : 'latin') : 'text' });
    cursor = e + 1;
  }
  if (cursor < n) runs.push({ t: chars.slice(cursor).join(''), dir: baseDir });
  return mergeAdjacent(runs);
}

function isSpace(ch: string) {
  return /\s/.test(ch);
}

function balanceBrackets(chars: string[], start: number, end: number): [number, number] {
  let s = start;
  let e = end;
  for (let pass = 0; pass < 3; pass++) {
    // count unmatched openers/closers inside [s,e]
    let depth = 0;
    let unmatchedClosers = 0;
    for (let k = s; k <= e; k++) {
      const ch = chars[k]!;
      if (OPENERS.includes(ch)) depth++;
      else if (CLOSERS.includes(ch)) {
        if (depth > 0) depth--;
        else unmatchedClosers++;
      }
    }
    let changed = false;
    if (depth > 0 && e + 1 < chars.length && CLOSERS.includes(chars[e + 1]!)) {
      e++;
      changed = true;
    }
    if (unmatchedClosers > 0 && s > 0 && OPENERS.includes(chars[s - 1]!)) {
      s--;
      changed = true;
    }
    // wrapping pair "(CT abdomen)": opener immediately before and closer immediately after
    if (!changed && s > 0 && e + 1 < chars.length) {
      const o = OPENERS.indexOf(chars[s - 1]!);
      if (o >= 0 && chars[e + 1] === CLOSERS[o]) {
        s--;
        e++;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return [s, e];
}

function mergeAdjacent(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const r of runs) {
    if (r.t === '') continue;
    const prev = out[out.length - 1];
    if (prev && prev.dir === r.dir && prev.kind === r.kind && !prev.marks && !r.marks && !prev.claim && !r.claim) {
      prev.t += r.t;
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

/** Build RichText from plain text (paragraphs split on blank lines / newlines). */
export function richTextFromPlain(text: string, opts: { forceDir?: Dir; kind?: Paragraph['kind'] } = {}): RichText {
  const clean = stripBidiControls(text);
  const paragraphs: Paragraph[] = clean
    .split(/\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => {
      const dir = opts.forceDir ?? detectDir(p);
      const para: Paragraph = { dir, runs: segmentRuns(p, dir) };
      if (opts.kind) para.kind = opts.kind;
      return para;
    });
  return { v: 1, paragraphs };
}

/** Logical plain text (for search, copy, export). Never contains bidi controls. */
export function richTextToPlain(rt: RichText | null | undefined): string {
  if (!rt) return '';
  return rt.paragraphs.map((p) => p.runs.map((r) => r.t).join('')).join('\n');
}

export function emptyRichText(): RichText {
  return { v: 1, paragraphs: [] };
}

/** Validate & normalize unknown JSON into RichText (strips bidi controls from every run). */
export function parseRichText(value: unknown): RichText {
  const rt = richTextSchema.parse(value);
  return {
    v: 1,
    paragraphs: rt.paragraphs.map((p) => ({ ...p, runs: p.runs.map((r) => ({ ...r, t: stripBidiControls(r.t) })) })),
  };
}
