// Download a source for offline study: lib/offline.ts stores the files and the GET answers; this wrapper also seeds
// the owner's own writing on that source into the local tables the reader uses offline (ink and highlights in
// `annotations`, notes in `notes`) with the workspace's merge functions — rows with unsent local edits, or a newer
// local revision, are never overwritten. Then asks the sync engine to pull (everything else the owner wrote).
import type { NoteDTO, OfflineBundleResponse, SourceAnnotationsResponse } from '@medlevo/shared';
import { downloadSource, type DownloadOptions, type OfflineDownload } from '../../lib/offline';
import { getDb } from '../../lib/localdb';
import { getSyncEngine } from '../../lib/sync';
import { mergeServerAnnotations, mergeServerNotes } from '../workspace/data/local';

export async function seedOwnerWriting(bundle: OfflineBundleResponse, db = getDb()): Promise<{ annotations: number; notes: number }> {
  let annotations = 0;
  let notes = 0;
  for (const e of bundle.entries) {
    if (e.role === 'annotations') {
      const body = e.body as SourceAnnotationsResponse;
      annotations += await mergeServerAnnotations(db, body.annotations ?? []);
      notes += await mergeServerNotes(db, body.notes ?? []);
    } else if (e.role === 'notes') {
      notes += await mergeServerNotes(db, (e.body as { notes?: NoteDTO[] }).notes ?? []);
    }
  }
  return { annotations, notes };
}

export async function downloadForStudy(sourceId: string, opts: Omit<DownloadOptions, 'seed'> = {}): Promise<OfflineDownload> {
  const db = opts.db ?? getDb();
  const rec = await downloadSource(sourceId, { ...opts, db, seed: (b) => seedOwnerWriting(b, db).then(() => undefined) });
  void getSyncEngine().syncNow().catch(() => undefined);
  return rec;
}
