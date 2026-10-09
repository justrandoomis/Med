// Pure helpers for the Study Book / explanation UI (unit-tested in model.test.ts).
import {
  boxesIntersect,
  normalizeForSearch,
  type ArtifactView,
  type ExplanationRulesPatch,
  type ExplanationRulesResponse,
  type MedicalTermView,
  type NormBox,
  type ScopeMode,
  type SourceDetail,
  type SourceRegionView,
  type SourceScope,
  type StudyBookView,
  type TwinEntry,
} from '@medlevo/shared';
import type { ScopeCandidate } from '../evidence';

/** References the owner linked to this lecture («R reference_for lecture»), for the Source Lock picker. */
export function referencesOf(detail: Pick<SourceDetail, 'id' | 'links'>): ScopeCandidate[] {
  return detail.links
    .filter((l) => l.relation === 'reference_for' && l.to_source_id === detail.id && l.from_source_id !== detail.id)
    .map((l) => ({ id: l.from_source_id, title: l.other_title, source_type: l.other_type }));
}

/** The default Source Lock for a lecture (owner setting), never wider than the owner chose. */
export function defaultScopeFor(detail: Pick<SourceDetail, 'id' | 'links'>, mode: ScopeMode): SourceScope {
  const base: SourceScope = { mode: 'lecture_only', lecture_source_id: detail.id, reference_source_ids: [], version_pins: {}, include_my_notes: false };
  if (mode === 'lecture_plus_references') return { ...base, mode, reference_source_ids: referencesOf(detail).map((r) => r.id) };
  // references_only / external need an explicit owner choice in the picker → start from the lecture only
  return base;
}

/** The block a page relates to (Lecture Twin): first block on that page, else the nearest following, else the last before. */
export function nearestBlock(twin: readonly TwinEntry[], pageIndex: number): string | null {
  const on = twin.find((t) => t.page_indexes.includes(pageIndex));
  if (on) return on.block_key;
  let after: { key: string; page: number } | null = null;
  let before: { key: string; page: number } | null = null;
  for (const t of twin) {
    if (t.page_indexes.length === 0) continue;
    const min = Math.min(...t.page_indexes);
    const max = Math.max(...t.page_indexes);
    if (min > pageIndex && (!after || min < after.page)) after = { key: t.block_key, page: min };
    if (max < pageIndex && (!before || max >= before.page)) before = { key: t.block_key, page: max };
  }
  return after?.key ?? before?.key ?? null;
}

/** The original page a block explains (first one), for jumping back from the Study Book. */
export function pageOfBlock(twin: readonly TwinEntry[], blockKey: string): number | null {
  const t = twin.find((x) => x.block_key === blockKey);
  return t && t.page_indexes.length ? Math.min(...t.page_indexes) : null;
}

/** «3 من 7 أقسام» — real counts, never a percentage. */
export function sectionsProgressAr(p: StudyBookView['progress']): string {
  const done = p.sections_complete + p.sections_abstained;
  return `${done} من ${p.sections_total} ${p.sections_total >= 3 && p.sections_total <= 10 ? 'أقسام' : 'قسمًا'}`;
}

/** Arabic count of pages: «صفحة واحدة», «صفحتان», «3 صفحات», «11 صفحة». */
export function pagesAr(n: number): string {
  if (n === 1) return 'صفحة واحدة';
  if (n === 2) return 'صفحتان';
  if (n >= 3 && n <= 10) return `${n} صفحات`;
  return `${n} صفحة`;
}

/** Coverage in words; `complete` only when every counted page/section is covered and nothing is missing. */
export function coverageSummary(c: ArtifactView['coverage']): { complete: boolean; text: string | null } {
  if (!c) return { complete: false, text: null };
  const parts: string[] = [];
  if (typeof c.pages_total === 'number' && typeof c.pages_covered === 'number' && c.pages_total > 0) parts.push(`غطّى ${pagesAr(c.pages_covered)} من ${c.pages_total}`);
  if (typeof c.sections_total === 'number' && typeof c.sections_covered === 'number' && c.sections_total > 0) parts.push(`و${c.sections_covered} من ${c.sections_total} أقسام`);
  const missing = c.missing_ar?.length ?? 0;
  const complete =
    missing === 0 &&
    (c.pages_total === undefined || c.pages_covered === c.pages_total) &&
    (c.sections_total === undefined || c.sections_covered === c.sections_total);
  return { complete, text: parts.length ? parts.join(' ') : null };
}

/** Regions under the selection rectangles (normalized page space) — the precise anchor of an explanation. */
export function regionsUnder(regions: readonly SourceRegionView[], rects: readonly NormBox[]): string[] {
  const out: string[] = [];
  for (const r of regions) {
    if (!r.bbox || r.parent_region_id || r.kind === 'header' || r.kind === 'footer' || r.status === 'rejected') continue;
    if (rects.some((b) => boxesIntersect(b, r.bbox!))) out.push(r.id);
  }
  return out.slice(0, 40);
}

/** Abstention / error wording helpers for the rail. */
export function shortQuote(text: string, n = 220): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

// ───────── terminology dictionary (§21) ─────────
export interface TermForm {
  term_en: string;
  abbreviation: string;
  synonyms: string;
  explanation_ar: string;
  accepted_translation_ar: string;
  owner_preferred_ar: string;
}

export const EMPTY_TERM_FORM: TermForm = { term_en: '', abbreviation: '', synonyms: '', explanation_ar: '', accepted_translation_ar: '', owner_preferred_ar: '' };

/** Synonyms typed as «a، b, c» or one per line → trimmed, de-duplicated (case-insensitive), max 30. */
export function parseSynonyms(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/[,،؛;\n]/)) {
    const t = raw.replace(/\s+/g, ' ').trim();
    if (!t) continue;
    const k = t.toLocaleLowerCase('en');
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t.slice(0, 200));
    if (out.length >= 30) break;
  }
  return out;
}

export function termFormFrom(t: Pick<MedicalTermView, 'term_en' | 'abbreviation' | 'synonyms' | 'explanation_ar' | 'accepted_translation_ar' | 'owner_preferred_ar'>): TermForm {
  return {
    term_en: t.term_en,
    abbreviation: t.abbreviation ?? '',
    synonyms: t.synonyms.join('، '),
    explanation_ar: t.explanation_ar ?? '',
    accepted_translation_ar: t.accepted_translation_ar ?? '',
    owner_preferred_ar: t.owner_preferred_ar ?? '',
  };
}

/** Form → API body (empty optional fields become null so an edit can clear them). */
export function termInputFrom(f: TermForm): { term_en: string; abbreviation: string | null; synonyms: string[]; explanation_ar: string | null; accepted_translation_ar: string | null; owner_preferred_ar: string | null } {
  const opt = (s: string) => (s.trim() ? s.trim() : null);
  return {
    term_en: f.term_en.replace(/\s+/g, ' ').trim(),
    abbreviation: opt(f.abbreviation),
    synonyms: parseSynonyms(f.synonyms),
    explanation_ar: opt(f.explanation_ar),
    accepted_translation_ar: opt(f.accepted_translation_ar),
    owner_preferred_ar: opt(f.owner_preferred_ar),
  };
}

/** Field errors in Arabic (only what the server would also refuse; the server stays the authority). */
export function validateTermForm(f: TermForm, existing: readonly Pick<MedicalTermView, 'id' | 'term_en'>[], editingId: string | null = null): Partial<Record<keyof TermForm, string>> {
  const errors: Partial<Record<keyof TermForm, string>> = {};
  const term = f.term_en.replace(/\s+/g, ' ').trim();
  if (!term) errors.term_en = 'اكتب المصطلح بالإنجليزية كما يرد في مصادرك.';
  else if (term.length > 200) errors.term_en = 'المصطلح أطول من 200 حرف.';
  else if (existing.some((t) => t.id !== editingId && t.term_en.toLocaleLowerCase('en') === term.toLocaleLowerCase('en'))) errors.term_en = 'هذا المصطلح موجود في قاموسك؛ عدّله بدل إضافته مرة ثانية.';
  if (f.abbreviation.trim().length > 40) errors.abbreviation = 'الاختصار أطول من 40 حرفًا.';
  return errors;
}

/** Local filter over the dictionary (English term, abbreviation, synonyms, Arabic renderings). */
export function termMatches(t: Pick<MedicalTermView, 'term_en' | 'abbreviation' | 'synonyms' | 'explanation_ar' | 'accepted_translation_ar' | 'owner_preferred_ar'>, query: string): boolean {
  const q = normalizeForSearch(query).trim();
  if (!q) return true;
  const hay = normalizeForSearch([t.term_en, t.abbreviation ?? '', ...t.synonyms, t.explanation_ar ?? '', t.accepted_translation_ar ?? '', t.owner_preferred_ar ?? ''].join(' '));
  return q.split(/\s+/).every((w) => hay.includes(w));
}

export const TERM_ORIGIN_LABELS_AR: Record<MedicalTermView['origin'], string> = {
  owner: 'أضفته أنت',
  extracted: 'مستخرج من مصدر',
  generated: 'مقترح مولَّد',
};

// ───────── explanation rules (§19) ─────────
/** The patch the owner layer would store after changing one field (include toggles merge). */
export function mergeRulesPatch(base: ExplanationRulesPatch | null, change: ExplanationRulesPatch): ExplanationRulesPatch {
  const merged: ExplanationRulesPatch = { ...(base ?? {}), ...change };
  if (base?.include || change.include) merged.include = { ...(base?.include ?? {}), ...(change.include ?? {}) };
  return merged;
}

/** Which layer decides a field (for «من أين جاءت هذه القاعدة؟»). */
export function ruleSourceAr(field: keyof ExplanationRulesPatch, layers: Pick<ExplanationRulesResponse['layers'], 'owner' | 'node'>): string {
  if (layers.node?.override && layers.node.override[field] !== undefined) return `خاص بـ «${layers.node.title}»`;
  if (field === 'template' && layers.node?.template_key) return `قالب المجلد «${layers.node.title}»`;
  if (layers.owner && layers.owner[field] !== undefined) return 'قواعدك العامة';
  return field === 'level' || field === 'dialect' || field === 'socratic' ? 'من الإعدادات' : 'الافتراضي';
}
