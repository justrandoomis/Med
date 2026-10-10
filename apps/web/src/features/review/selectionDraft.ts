// Hand-over from the book's selection toolbar («أنشئ بطاقة مراجعة») to the card editor: the selected quote and where
// it is (source, version, page, selection rectangles). Kept in sessionStorage so a reload of the editor keeps it.
// The editor turns it into an exact evidence excerpt through the server (POST /cards/from-selection).
import type { NormBox, SourceRegionView } from '@medlevo/shared';

export interface SelectionCardDraft {
  source_id: string;
  version_id: string;
  page_id: string;
  page_index: number;
  page_label: string | null;
  source_title: string | null;
  /** the selected text, logical order */
  quote: string;
  /** selection rectangles (normalized, unrotated page) — used to find the region(s) under the selection */
  rects: NormBox[];
  created_at: number;
}

const KEY = 'medlevo.learning.selectionDraft';

export function stashSelectionDraft(d: Omit<SelectionCardDraft, 'created_at'>): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ ...d, quote: d.quote.slice(0, 6000), created_at: Date.now() }));
  } catch {
    // private mode / storage full: the editor says the selection is missing
  }
}

export function readSelectionDraft(): SelectionCardDraft | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as SelectionCardDraft;
    return d && typeof d.quote === 'string' && typeof d.source_id === 'string' && typeof d.version_id === 'string' ? d : null;
  } catch {
    return null;
  }
}

export function clearSelectionDraft(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}

/** Finds `quote` in `text`, tolerating whitespace differences (selection vs extracted text). Offsets into `text`. */
export function locateQuote(text: string, quote: string): { start: number; end: number } | null {
  const q = quote.trim();
  if (!q) return null;
  const direct = text.indexOf(q);
  if (direct >= 0) return { start: direct, end: direct + q.length };
  // collapse whitespace on both sides, keeping a map back to the original offsets
  const map: number[] = [];
  let norm = '';
  let prevSpace = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const space = /\s/.test(ch);
    if (space && prevSpace) continue;
    norm += space ? ' ' : ch;
    map.push(i);
    prevSpace = space;
  }
  const nq = q.replace(/\s+/g, ' ');
  const at = norm.indexOf(nq);
  if (at < 0) return null;
  const start = map[at]!;
  const endIdx = map[at + nq.length - 1]!;
  return { start, end: endIdx + 1 };
}

/** The region and offsets for an exact excerpt: the region under the selection that contains the whole quote. */
export function regionForQuote(regions: SourceRegionView[], candidateIds: string[], quote: string): { region_id: string; start: number | null; end: number | null; whole: boolean } | null {
  // no rectangles (paragraph-based sources, a selection without page geometry): every text region of the page
  const pool = candidateIds.length ? candidateIds.map((id) => regions.find((r) => r.id === id)) : regions.filter((r) => !r.parent_region_id && r.status !== 'rejected');
  const candidates = pool.filter((r): r is SourceRegionView => !!r && !!r.text);
  for (const r of candidates) {
    const at = locateQuote(r.text!, quote);
    if (at) return { region_id: r.id, start: at.start, end: at.end, whole: false };
  }
  // the selection spans several regions: the first region under it, cited whole (said to the owner) — only when the
  // rectangles told us which regions are under the selection (never a guessed paragraph of the page)
  const first = candidateIds.length ? candidates[0] : undefined;
  return first ? { region_id: first.id, start: null, end: null, whole: true } : null;
}
