// Lecture identity, suggestions and version comparison (Academic OS P1-T3) — presentation helpers (pure; unit-tested)
// and the typed calls of /api/versions. Words come from the shared contract; every status carries text, never colour
// alone.
import {
  IMPORT_SUGGESTION_FIELD_LABELS_AR,
  IMPORT_SUGGESTION_STATUS_LABELS_AR,
  PAGE_CHANGE_LABELS_AR,
  type CompareRow,
  type ImportSuggestionView,
  type LectureNoOrigin,
  type PageChangeKind,
} from '@medlevo/shared';
import type { StatusTone } from '../../design';

export const CHANGE_TONE: Record<PageChangeKind, StatusTone> = {
  unchanged: 'neutral',
  edited: 'info',
  changed: 'warning',
  moved: 'warning',
  inserted: 'accent',
  removed: 'danger',
};

export function changeLabel(kind: PageChangeKind): string {
  return PAGE_CHANGE_LABELS_AR[kind];
}

/** «39 لم تتغير · صفحتان جديدتان · 1 تغيّرت» — only the non-zero kinds, in a fixed order. */
export function countsSummary(counts: Record<PageChangeKind, number>): string {
  const order: PageChangeKind[] = ['unchanged', 'edited', 'changed', 'moved', 'inserted', 'removed'];
  return order
    .filter((k) => counts[k] > 0)
    .map((k) => `${PAGE_CHANGE_LABELS_AR[k]}: ${counts[k]}`)
    .join(' · ');
}

/** Rows that need a human look: uncertain pairs (changed, moved, ambiguous) — never decided by automation. */
export function needsReview(row: CompareRow): boolean {
  return row.status === 'uncertain';
}

export const ORIGIN_LABEL_AR: Record<LectureNoOrigin, string> = {
  detected: 'اكتُشف تلقائيًا',
  owner: 'حددته أنت',
  moderator: 'حدده المشرف',
};

/** The proposed value in one line, Arabic. */
export function suggestionValueAr(s: ImportSuggestionView): string {
  const v = s.value;
  switch (v.field) {
    case 'lecture_no':
      return `المحاضرة ${v.lecture_no}`;
    case 'held_on':
      return v.held_on;
    case 'title':
      return `«${v.title}»`;
    case 'subject':
      return v.path.join(' / ');
    case 'new_version_of': {
      const parts = [`${v.matched_pages} من ${v.total_pages} صفحة متطابقة`];
      if (v.inserted) parts.push(`جديدة: ${v.inserted}`);
      if (v.changed) parts.push(`تغيّرت: ${v.changed}`);
      if (v.removed) parts.push(`حُذفت: ${v.removed}`);
      return parts.join(' · ');
    }
  }
}

export function suggestionTitleAr(s: ImportSuggestionView): string {
  if (s.field === 'new_version_of' && s.value.field === 'new_version_of') return `إصدار جديد من «${s.value.title}»؟`;
  return IMPORT_SUGGESTION_FIELD_LABELS_AR[s.field];
}

export function suggestionStatusTone(s: ImportSuggestionView): StatusTone {
  switch (s.status) {
    case 'open':
      return 'warning';
    case 'applied':
      return 'info';
    case 'accepted':
      return 'success';
    case 'rejected':
      return 'neutral';
    case 'superseded':
      return 'neutral';
  }
}

export function suggestionStatusAr(s: ImportSuggestionView): string {
  if (s.status === 'open' && s.certainty === 'uncertain' && (s.field === 'lecture_no' || s.field === 'held_on')) return 'غير مؤكد — بانتظار تأكيدك';
  return IMPORT_SUGGESTION_STATUS_LABELS_AR[s.status];
}

/** The compare screen of a «new version» proposal: from the existing lecture's version to the upload's version. */
export function compareHref(sourceId: string, fromVersionId: string, toVersionId: string): string {
  return `/sources/${encodeURIComponent(sourceId)}/compare?from=${encodeURIComponent(fromVersionId)}&to=${encodeURIComponent(toVersionId)}`;
}

export const thumbnailUrl = (pageId: string) => `/api/versions/pages/${encodeURIComponent(pageId)}/thumbnail`;
export const studyHref = (sourceId: string, versionId: string, pageIndex: number) =>
  `/study/${encodeURIComponent(sourceId)}?v=${encodeURIComponent(versionId)}&page=${pageIndex}`;
