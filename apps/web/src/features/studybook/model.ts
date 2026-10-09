// Pure helpers for the Study Book / explanation UI (unit-tested in model.test.ts).
import {
  boxesIntersect,
  type ArtifactView,
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
