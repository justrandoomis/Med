// The reader's page sequence (§26 «إضافة صفحات ملاحظات»): the pages of a source version with the owner's note pages
// inserted after the source page they follow. Source pages keep their own indexes (page_index — citations, search,
// progress and sessions still speak about source pages); the sequence only decides what the Book Canvas shows next.
// Placement (§25): after the page with `after_page_id` when that page is in this version; otherwise after
// `after_page_index` (clamped to the version — a page is never dropped because its source page is gone).
import { NOTE_PAGE_TEMPLATE_LABELS_AR, type SourcePageView } from '@medlevo/shared';
import type { WorkspaceNotePageRow } from '../data/local';
import { byOrder } from '../data/notePages';
import { fullPageLabel } from './pages';

export type ReaderSheet =
  | { kind: 'source'; key: string; page: SourcePageView }
  | { kind: 'note'; key: string; note: WorkspaceNotePageRow; /** the source page index it follows (-1 = before the first) */ after: number; /** placed by index because its source page is not in this version */ placedByIndex: boolean };

export function isNoteSheet(s: ReaderSheet | undefined): s is Extract<ReaderSheet, { kind: 'note' }> {
  return s?.kind === 'note';
}

/** Where a note page sits among `pages` (index of the source page it follows; -1 = before the first page). */
export function placementOf(note: Pick<WorkspaceNotePageRow, 'afterPageId' | 'afterPageIndex'>, pages: readonly SourcePageView[]): { after: number; byIndex: boolean } {
  if (note.afterPageId) {
    const at = pages.findIndex((p) => p.id === note.afterPageId);
    if (at >= 0) return { after: at, byIndex: false };
  }
  const idx = note.afterPageIndex ?? pages.length - 1;
  const after = Math.min(Math.max(-1, Math.trunc(idx)), pages.length - 1);
  return { after, byIndex: !!note.afterPageId };
}

/** Source pages + the live (not trashed, kind 'page') note pages of this source, in reading order. */
export function buildSequence(pages: readonly SourcePageView[], notes: readonly WorkspaceNotePageRow[]): ReaderSheet[] {
  const placed = new Map<number, Array<{ note: WorkspaceNotePageRow; byIndex: boolean }>>();
  for (const n of [...notes].sort(byOrder)) {
    if (n.deletedAt || (n.kind ?? 'page') !== 'page') continue;
    const { after, byIndex } = placementOf(n, pages);
    const list = placed.get(after) ?? [];
    list.push({ note: n, byIndex });
    placed.set(after, list);
  }
  const out: ReaderSheet[] = [];
  const pushNotes = (after: number) => {
    for (const { note, byIndex } of placed.get(after) ?? []) out.push({ kind: 'note', key: `note_page:${note.id}`, note, after, placedByIndex: byIndex });
  };
  pushNotes(-1);
  pages.forEach((p, i) => {
    out.push({ kind: 'source', key: `source_page:${p.id}`, page: p });
    pushNotes(i);
  });
  return out;
}

/** Index lookups between the sequence and source pages / note pages. */
export interface SequenceIndex {
  sheets: readonly ReaderSheet[];
  /** sequence index of source page i */
  ofSource(i: number): number;
  /** sequence index of a note page (-1 when it is not in the sequence) */
  ofNote(id: string): number;
  /** the source page index at or before a sequence index (0 when only note pages precede it) */
  sourceAtOrBefore(seq: number): number;
}

export function indexSequence(sheets: readonly ReaderSheet[]): SequenceIndex {
  const srcSeq: number[] = [];
  const noteSeq = new Map<string, number>();
  const srcBefore: number[] = [];
  let last = 0;
  sheets.forEach((s, i) => {
    if (s.kind === 'source') {
      srcSeq[s.page.page_index] = i;
      last = s.page.page_index;
    } else noteSeq.set(s.note.id, i);
    srcBefore[i] = last;
  });
  return {
    sheets,
    ofSource: (i) => srcSeq[i] ?? Math.min(Math.max(0, i), Math.max(0, sheets.length - 1)),
    ofNote: (id) => noteSeq.get(id) ?? -1,
    sourceAtOrBefore: (seq) => srcBefore[Math.min(Math.max(0, seq), srcBefore.length - 1)] ?? 0,
  };
}

/** Accessible name / folio of a sheet: «ص 12 (الصفحة 14 في الملف)» or «صفحة ملاحظات (مسطّرة) بعد ص 12». */
export function sheetLabel(s: ReaderSheet, pages: readonly SourcePageView[]): string {
  if (s.kind === 'source') return fullPageLabel(s.page);
  const paper = NOTE_PAGE_TEMPLATE_LABELS_AR[s.note.template] ?? '';
  const title = s.note.title ? `«${s.note.title}» — ` : '';
  const prev = s.after >= 0 ? pages[s.after] : undefined;
  const where = prev ? `بعد ${fullPageLabel(prev)}` : 'قبل الصفحة الأولى';
  return `${title}صفحة ملاحظات (${paper}) ${where}`;
}

/** Placement fields for a note page inserted right after `sheetIndex` of the sequence. */
export function insertionAfter(sheets: readonly ReaderSheet[], sheetIndex: number): { afterPageIndex: number; afterPageId: string | null; prevOrder: number | null; nextOrder: number | null } {
  const at = sheets[Math.min(Math.max(0, sheetIndex), sheets.length - 1)];
  let afterPageIndex = -1;
  let afterPageId: string | null = null;
  if (at?.kind === 'source') {
    afterPageIndex = at.page.page_index;
    afterPageId = at.page.id;
  } else if (at?.kind === 'note') {
    afterPageIndex = at.after;
    afterPageId = at.note.afterPageId ?? null;
  }
  // order among the note pages already after the same source page: after the current one (or first)
  const group = sheets.filter((s): s is Extract<ReaderSheet, { kind: 'note' }> => s.kind === 'note' && s.after === afterPageIndex);
  const pos = at?.kind === 'note' ? group.findIndex((g) => g.note.id === at.note.id) : -1;
  const prevOrder = pos >= 0 ? group[pos]!.note.sortOrder : null;
  const nextOrder = group[pos + 1]?.note.sortOrder ?? null;
  return { afterPageIndex, afterPageId, prevOrder, nextOrder };
}
