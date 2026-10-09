// Query building for chunk/owner-content FTS (§46, §52): normalized, operator-safe FTS5 expressions with
// synonym / abbreviation expansion taken ONLY from the owner's own medical_term dictionary (nothing is
// seeded — an empty dictionary means no expansion). Every token is quoted, so user input can never inject
// FTS operators. The same normalization as the index (normalizeForSearch ↔ ml_norm) is applied.
import { normalizeForSearch, searchTokens, type MedicalTermView } from '@medlevo/shared';
import type { Db } from '../../db/db';
import { fromJson } from '../../db/db';

export interface Expansion {
  from: string;
  to: string[];
}

/** A query group: alternatives (each a token sequence = FTS phrase); the group matches if any matches. */
interface Group {
  alternatives: string[][];
  label: string;
}

export interface BuiltQuery {
  /** all groups AND-ed (null when nothing searchable) */
  and: string | null;
  /** all groups OR-ed */
  or: string | null;
  /** single phrase (exact mode prefilter) */
  phrase: string | null;
  /** normalized tokens used for highlighting (query tokens + expansion tokens) */
  highlightTokens: string[];
  expansions: Expansion[];
  /** normalized query tokens (no expansion) */
  tokens: string[];
  /** the groups: each group = alternatives (token sequences); used for match-coverage checks */
  groups: string[][][];
}

const QUESTION_STOP = new Set([
  'what', 'which', 'when', 'where', 'why', 'how', 'who', 'is', 'are', 'the', 'a', 'an', 'of', 'in', 'on', 'for', 'to', 'and', 'or', 'does', 'do', 'with',
  'ما', 'ماذا', 'متي', 'اين', 'لماذا', 'كيف', 'من', 'هل', 'هو', 'هي', 'في', 'علي', 'الي', 'عن', 'و', 'او',
]);

function quoteToken(t: string): string {
  return '"' + t.replace(/"/g, '""') + '"';
}

function phraseOf(tokens: string[]): string {
  // FTS5: a quoted string with several tokens is a phrase
  return '"' + tokens.map((t) => t.replace(/"/g, '""')).join(' ') + '"';
}

function groupExpr(g: Group): string {
  const alts = g.alternatives.map((a) => (a.length === 1 ? quoteToken(a[0]!) : phraseOf(a)));
  return alts.length === 1 ? alts[0]! : '(' + alts.join(' OR ') + ')';
}

interface TermRow {
  id: string;
  term_en: string;
  abbreviation: string | null;
  synonyms_json: string;
  accepted_translation_ar: string | null;
  owner_preferred_ar: string | null;
}

/** Variants of one dictionary entry as normalized token sequences (deduplicated). */
function variantsOf(row: TermRow): string[][] {
  const raw = [row.term_en, row.abbreviation, ...(fromJson<string[]>(row.synonyms_json, []) ?? []), row.accepted_translation_ar, row.owner_preferred_ar];
  const seen = new Set<string>();
  const out: string[][] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'string') continue;
    const toks = searchTokens(r);
    if (toks.length === 0 || toks.length > 8) continue;
    const key = toks.join(' ');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(toks);
  }
  return out;
}

export function loadDictionary(db: Db): string[][][] {
  const rows = db.all<TermRow>('SELECT id, term_en, abbreviation, synonyms_json, accepted_translation_ar, owner_preferred_ar FROM medical_term LIMIT 5000');
  return rows.map(variantsOf).filter((v) => v.length > 1);
}

/** Build FTS expressions for `input`, expanding phrases found in the owner's dictionary. */
export function buildQuery(db: Db | null, input: string, opts: { dropStopwords?: boolean } = {}): BuiltQuery {
  let tokens = searchTokens(input);
  if (opts.dropStopwords) {
    const kept = tokens.filter((t) => !QUESTION_STOP.has(t) && (t.length > 1 || /\d/.test(t)));
    if (kept.length > 0) tokens = kept;
  }
  if (tokens.length === 0) return { and: null, or: null, phrase: null, highlightTokens: [], expansions: [], tokens: [], groups: [] };
  const dict = db ? loadDictionary(db) : [];
  const groups: Group[] = [];
  const expansions: Expansion[] = [];
  let i = 0;
  while (i < tokens.length) {
    // longest dictionary variant starting at i
    let best: { len: number; variants: string[][] } | null = null;
    for (const variants of dict) {
      for (const v of variants) {
        if (v.length === 0 || i + v.length > tokens.length) continue;
        let ok = true;
        for (let k = 0; k < v.length; k++) if (tokens[i + k] !== v[k]) ok = false;
        if (ok && (!best || v.length > best.len)) best = { len: v.length, variants };
      }
    }
    if (best) {
      const matched = tokens.slice(i, i + best.len);
      const others = best.variants.filter((v) => v.join(' ') !== matched.join(' '));
      groups.push({ alternatives: [matched, ...others], label: matched.join(' ') });
      expansions.push({ from: matched.join(' '), to: others.map((o) => o.join(' ')) });
      i += best.len;
    } else {
      groups.push({ alternatives: [[tokens[i]!]], label: tokens[i]! });
      i++;
    }
  }
  const exprs = groups.map(groupExpr);
  const highlight = new Set<string>();
  for (const g of groups) for (const a of g.alternatives) for (const t of a) highlight.add(t);
  return {
    and: exprs.join(' AND '),
    or: exprs.join(' OR '),
    phrase: phraseOf(tokens),
    highlightTokens: [...highlight],
    expansions,
    tokens,
    groups: groups.map((g) => g.alternatives),
  };
}

/** Fraction of query groups present (as whole words / phrases) in `text` (normalized like the index). */
export function groupCoverage(built: Pick<BuiltQuery, 'groups'>, text: string): number {
  if (built.groups.length === 0) return 0;
  const words = searchTokens(text);
  const joined = ' ' + words.join(' ') + ' ';
  let hit = 0;
  for (const g of built.groups) if (g.some((alt) => joined.includes(' ' + alt.join(' ') + ' '))) hit++;
  return hit / built.groups.length;
}

/** Normalized key used when comparing a dictionary entry with text (exported for tests). */
export function termKey(text: string): string {
  return normalizeForSearch(text).replace(/\s+/g, ' ').trim();
}

// ───────── owner dictionary CRUD (medical_term is owned by the evidence module) ─────────
export function termView(r: TermRow & { explanation_ar: string | null; origin: MedicalTermView['origin']; updated_at: number }): MedicalTermView {
  return {
    id: r.id,
    term_en: r.term_en,
    abbreviation: r.abbreviation,
    synonyms: fromJson<string[]>(r.synonyms_json, []) ?? [],
    explanation_ar: r.explanation_ar,
    accepted_translation_ar: r.accepted_translation_ar,
    owner_preferred_ar: r.owner_preferred_ar,
    origin: r.origin,
    updated_at: r.updated_at,
  };
}
