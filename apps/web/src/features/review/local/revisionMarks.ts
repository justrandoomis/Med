// «أضف إلى المراجعة» (Add to Revision, §30/§45): a passage the owner marks in the book while reading. It is a page
// bookmark annotation (local-first, synced like every annotation) labelled «للمراجعة» that also keeps the selected
// quote; the Review hub lists these marks with a link back to the exact page. Removing it is a tombstone.
import { liveQuery } from 'dexie';
import { useEffect, useState } from 'react';
import type { AnnotationAnchor } from '@medlevo/shared';
import { getDb, type AnnotationRow, type MedLevoDB } from '../../../lib/localdb';
import { createAnnotation, deleteAnnotation } from '../../workspace/data/local';

export const REVISION_MARK_LABEL = 'للمراجعة';

export interface RevisionMarkData {
  v: 1;
  label: string;
  revision: true;
  /** the selected text (logical order), at most 600 characters */
  quote: string | null;
  page_label: string | null;
  source_title: string | null;
}

export interface RevisionMark {
  row: AnnotationRow;
  sourceId: string;
  versionId: string;
  pageId: string;
  pageIndex: number;
  data: RevisionMarkData;
}

export function isRevisionMark(a: Pick<AnnotationRow, 'kind' | 'data' | 'deletedAt'>): boolean {
  const d = a.data as Partial<RevisionMarkData> | null;
  return a.kind === 'bookmark' && !a.deletedAt && !!d && d.revision === true;
}

export async function addRevisionMark(
  db: MedLevoDB,
  anchor: Extract<AnnotationAnchor, { type: 'page' }>,
  info: { quote: string | null; pageLabel: string | null; sourceTitle: string | null },
): Promise<AnnotationRow> {
  const quote = info.quote?.trim() ? info.quote.trim().slice(0, 600) : null;
  const data: RevisionMarkData = { v: 1, label: REVISION_MARK_LABEL, revision: true, quote, page_label: info.pageLabel, source_title: info.sourceTitle };
  return createAnnotation(db, { kind: 'bookmark', anchor, data, layer: 'text' });
}

export async function removeRevisionMark(db: MedLevoDB, row: AnnotationRow): Promise<void> {
  await deleteAnnotation(db, row);
}

export function toRevisionMark(a: AnnotationRow): RevisionMark | null {
  if (!isRevisionMark(a)) return null;
  const anchor = a.anchor as AnnotationAnchor | null;
  if (!anchor || anchor.type !== 'page') return null;
  return { row: a, sourceId: anchor.source_id, versionId: anchor.version_id, pageId: anchor.page_id, pageIndex: anchor.page_index, data: a.data as RevisionMarkData };
}

/** Live list of revision marks on this device, newest first. */
export function useRevisionMarks(): RevisionMark[] | null {
  const [marks, setMarks] = useState<RevisionMark[] | null>(null);
  useEffect(() => {
    const db = getDb();
    const sub = liveQuery(() => db.annotations.filter((a) => isRevisionMark(a)).toArray()).subscribe({
      next: (rows) =>
        setMarks(
          rows
            .map(toRevisionMark)
            .filter((m): m is RevisionMark => !!m)
            .sort((a, b) => (b.row.createdAt ?? b.row.updatedAt) - (a.row.createdAt ?? a.row.updatedAt)),
        ),
      error: () => setMarks([]),
    });
    return () => sub.unsubscribe();
  }, []);
  return marks;
}
