// The versions module's step in the sources purge (P1-T1 step-0 seam `registerPurgeExtension`, BUILD_PLAN §3.2).
//  * page_fingerprint (→ source_page), import_suggestion (→ source) and version_rendition (→ source_version) die with
//    their parents through ON DELETE CASCADE; nothing to do for them here except remembering the rendition files.
//  * version_page_map and page_map_run have no foreign keys (a map names two versions): their rows for purged
//    versions — as either side — are deleted here, inside the purge transaction.
//  * open «إصدار جديد من …» proposals of other uploads that name a purged lecture / version become `superseded`.
//  * The display PDFs of purged DOCX versions are released AFTER the purge commits, through the files module
//    (`removeStoredFileIfUnreferenced`, which keeps a file still referenced elsewhere), by a small job queued inside
//    the same transaction — so a rolled-back purge releases nothing.
import type { AppContext } from '../../context';
import { removeStoredFileIfUnreferenced } from '../files/blobs';
import { registerPurgeExtension } from '../sources/purge';

export const RELEASE_FILES_JOB = 'versions_release_files';

export function registerVersionsPurgeExtension(ctx: AppContext): () => void {
  return registerPurgeExtension(ctx, {
    name: 'versions',
    count(c, set) {
      const n = (sql: string) => c.db.get<{ n: number }>(sql)?.n ?? 0;
      return {
        page_maps: n(`SELECT COUNT(*) AS n FROM page_map_run WHERE from_version_id IN ${set.in('version')} OR to_version_id IN ${set.in('version')}`),
        display_pdfs: n(`SELECT COUNT(*) AS n FROM version_rendition WHERE version_id IN ${set.in('version')} AND file_id IS NOT NULL`),
      };
    },
    linesAr(counts, mode) {
      if (mode !== 'purge') return [];
      const lines: string[] = [];
      if (counts.page_maps) lines.push(`مقارنات صفحات بين النسخ (${counts.page_maps}) تُحذف معها؛ لا تُحذف أي ملاحظة على نسخة أخرى.`);
      if (counts.display_pdfs) lines.push(`نسخ عرض PDF المحوّلة من مستندات Word (${counts.display_pdfs}) تُحذف معها.`);
      return lines;
    },
    apply(c, set) {
      const files = c.db
        .all<{ file_id: string }>(`SELECT file_id FROM version_rendition WHERE version_id IN ${set.in('version')} AND file_id IS NOT NULL`)
        .map((r) => r.file_id);
      c.db.run(`DELETE FROM version_page_map WHERE from_version_id IN ${set.in('version')} OR to_version_id IN ${set.in('version')}`);
      c.db.run(`DELETE FROM page_map_run WHERE from_version_id IN ${set.in('version')} OR to_version_id IN ${set.in('version')}`);
      c.db.run(`DELETE FROM version_rendition WHERE version_id IN ${set.in('version')}`);
      // (review) «إصدار جديد من …» proposals of OTHER uploads that point at a purged lecture or version are answered
      // by the purge (they could never be accepted any more)
      c.db.run(
        `UPDATE import_suggestion SET status = 'superseded', updated_at = ? WHERE field = 'new_version_of' AND status IN ('open','applied')
           AND (json_extract(value_json, '$.source_id') IN ${set.in('source')} OR json_extract(value_json, '$.version_id') IN ${set.in('version')})`,
        [c.clock.now()],
      );
      if (files.length && c.jobs.isRegistered(RELEASE_FILES_JOB)) c.jobs.enqueue(RELEASE_FILES_JOB, { file_ids: [...new Set(files)] });
    },
  });
}

export function releaseFiles(ctx: AppContext, fileIds: readonly string[]): { removed: number } {
  let removed = 0;
  for (const id of fileIds) if (removeStoredFileIfUnreferenced(ctx, id)) removed++;
  return { removed };
}
