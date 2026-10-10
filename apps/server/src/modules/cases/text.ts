// Deterministic phrase matching for typed answers (OSCE utterances, viva answers, patient questions) and image captions.
//
//  * both sides are normalized with the shared search normalization (Arabic letter variants, harakat, digits, case)
//  * a phrase matches when its tokens appear CONSECUTIVELY in the text, each text token equal to the phrase token
//    or to the phrase token with a common Arabic proclitic attached (و ف ب ل ك ال وال بال لل فال كال)
//  * negation is judged INSIDE a clause (sentence punctuation and «but / however / لكن» end a clause):
//      - 'answer' (default; OSCE / viva): a negation cue up to 4 tokens before the phrase in the same clause
//        («not», «no», «لا», «ليس», «بدون», «negative for»…) — «I would not order a CT» does not cover «CT», and «it is not
//        ultrasound, I would do CT» still covers «CT» (the comma ends the clause)
//      - 'caption' (AC-09 image captions — the strict gate): any pre-negation cue earlier in the clause («no evidence
//        of», «without», «negative for», «absence of», «to rule out», «لا يوجد دليل على», «عدم وجود») or a
//        post-negation cue later in it («excluded», «ruled out», «not seen», «absent», «غير موجود», «مستبعد») — a
//        caption that denies the finding never makes the image an example of it
//      - 'off' (the simulated patient: «no nausea?» is still a question about nausea)
// These are heuristics, said so in every assessment («المطابقة بالكلمات قد تفوّت صياغة مختلفة»); the owner can
// correct any judgement (override event).
import { normalizeForSearch } from '@medlevo/shared';

const PROCLITICS = ['وال', 'بال', 'فال', 'كال', 'لل', 'ال', 'و', 'ف', 'ب', 'ل', 'ك'];
const NEGATIONS = new Set(['not', 'no', 'never', 'without', 'nor', 'non', 'لا', 'ليس', 'ليست', 'لم', 'لن', 'بدون', 'غير', 'دون', 'ولا', 'بلا', 'عدم']);
/** Extra single-token pre-negation cues for captions (strict). */
const CAPTION_PRE = new Set([
  'انعدام', 'غياب', 'خلو', 'خالي', 'خاليه', 'نفي', 'exclude', 'excluding',
  // G3 / AC-09: a finding that is gone is not shown («resolved pneumothorax», «زوال استرواح الصدر»)
  'resolved', 'healed', 'زوال', 'اختفاء',
]);
/** Two-token pre-negation cues (normalized tokens). «rule out» only for captions: in an answer it names a differential. */
const PRE_PAIRS = new Set(['negative for', 'free of', 'absence of']);
const CAPTION_PRE_PAIRS = new Set(['rule out', 'ruled out', 'rules out', 'ruling out', 'resolution of']);
/** Post-negation cues for captions: the finding named, then denied. */
const CAPTION_POST = new Set(['excluded', 'absent', 'resolved', 'healed', 'مستبعد', 'مستبعده', 'غائب', 'غايب', 'منفي', 'منفيه', 'زال', 'اختفي']);
const CAPTION_POST_PAIRS = new Set([
  'ruled out',
  'not seen',
  'not identified',
  'not present',
  'not visible',
  'not detected',
  'not demonstrated',
  'not shown',
  'غير موجود',
  'غير موجوده',
  'غير ظاهر',
  'غير ظاهره',
  'لا يظهر',
  'لا تظهر',
  'لم يظهر',
  'لم تظهر',
]);
/** Words that open a new clause (contrast). */
const CLAUSE_WORDS = new Set(['but', 'however', 'although', 'though', 'whereas', 'لكن', 'ولكن', 'بل', 'بينما']);
const ANSWER_WINDOW = 4;

export type NegationMode = 'answer' | 'caption' | 'off';

export function tokens(text: string): string[] {
  return normalizeForSearch(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);
}

/** Tokens (same order and positions as `tokens`) with the clause each belongs to. */
function clauseTokens(text: string, mode: NegationMode): { t: string[]; clause: number[] } {
  const t: string[] = [];
  const clause: number[] = [];
  let c = 0;
  for (const m of normalizeForSearch(text).matchAll(/[\p{L}\p{N}]+|[.;:!?؛\n\r()[\]{}]|[,،]/gu)) {
    const x = m[0];
    if (/^[\p{L}\p{N}]/u.test(x)) {
      if (CLAUSE_WORDS.has(x) && t.length > 0) c++;
      t.push(x);
      clause.push(c);
    } else if (mode !== 'caption' || /[.;!?؛\n\r]/.test(x)) {
      // a caption's sentence stays one clause across commas, colons and brackets: «no consolidation, pneumothorax
      // or effusion», «Pneumothorax: excluded», «Pneumothorax (ruled out)» all deny the finding
      c++;
    }
  }
  return { t, clause };
}

function tokenMatches(textToken: string, phraseToken: string): boolean {
  if (textToken === phraseToken) return true;
  for (const p of PROCLITICS) {
    if (textToken.length > p.length && textToken.startsWith(p)) {
      const rest = textToken.slice(p.length);
      if (rest === phraseToken) return true;
      // «الألم» typed, phrase «ألم»: the article belongs to the text token
      if (phraseToken.startsWith('ال') && rest === phraseToken.slice(2)) return true;
    }
  }
  // phrase written with the article, text without it
  if (phraseToken.startsWith('ال') && phraseToken.length > 3 && textToken === phraseToken.slice(2)) return true;
  return false;
}

function negatedAt(t: string[], clause: number[], i: number, len: number, mode: NegationMode): boolean {
  if (mode === 'off') return false;
  const c = clause[i]!;
  const from = mode === 'caption' ? 0 : Math.max(0, i - ANSWER_WINDOW);
  for (let k = i - 1; k >= from && clause[k] === c; k--) {
    if (NEGATIONS.has(t[k]!) || (mode === 'caption' && CAPTION_PRE.has(t[k]!))) return true;
    if (k + 1 < i) {
      const pair = `${t[k]} ${t[k + 1]}`;
      if (PRE_PAIRS.has(pair) || (mode === 'caption' && CAPTION_PRE_PAIRS.has(pair))) return true;
    }
  }
  if (mode === 'caption') {
    for (let k = i + len; k < t.length && clause[k] === c; k++) {
      if (CAPTION_POST.has(t[k]!)) return true;
      if (k + 1 < t.length && clause[k + 1] === c && CAPTION_POST_PAIRS.has(`${t[k]} ${t[k + 1]}`)) return true;
    }
  }
  return false;
}

export interface PhraseHit {
  phrase: string;
  /** token index of the first matched token */
  at: number;
  negated: boolean;
}

/** Every occurrence of `phrase` in `text` (token positions), marking negated mentions. */
export function findPhrase(text: string, phrase: string, mode: NegationMode = 'answer'): PhraseHit[] {
  return hitsIn(clauseTokens(text, mode), phrase, mode);
}

function hitsIn(ct: { t: string[]; clause: number[] }, phrase: string, mode: NegationMode): PhraseHit[] {
  const { t, clause } = ct;
  const p = tokens(phrase);
  if (p.length === 0 || t.length < p.length) return [];
  const hits: PhraseHit[] = [];
  for (let i = 0; i + p.length <= t.length; i++) {
    let ok = true;
    for (let j = 0; j < p.length; j++) {
      if (!tokenMatches(t[i + j]!, p[j]!)) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    hits.push({ phrase, at: i, negated: negatedAt(t, clause, i, p.length, mode) });
  }
  return hits;
}

export interface MatchResult {
  matched: boolean;
  /** the phrase that matched (first, non-negated) */
  phrase: string | null;
  /** first token position of the match (ordering checks) */
  at: number | null;
  /** a phrase occurred, but only negated */
  negated_only: boolean;
}

/** Does any of `phrases` occur (non-negated) in `text`? */
export function matchAny(text: string, phrases: readonly string[], mode: NegationMode = 'answer'): MatchResult {
  const ct = clauseTokens(text, mode);
  let best: { phrase: string; at: number } | null = null;
  let negatedSeen = false;
  for (const phrase of phrases) {
    for (const h of hitsIn(ct, phrase, mode)) {
      if (h.negated) {
        negatedSeen = true;
        continue;
      }
      if (!best || h.at < best.at) best = { phrase, at: h.at };
    }
  }
  if (best) return { matched: true, phrase: best.phrase, at: best.at, negated_only: false };
  return { matched: false, phrase: null, at: null, negated_only: negatedSeen };
}

export function clip(text: string, n: number): string {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
