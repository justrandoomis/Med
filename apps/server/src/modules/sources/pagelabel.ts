// The ONE page label of the server (AC-04, §07). Every module that names a page of a source in a response, a summary,
// an export or an alert goes through `pageLabelAr` — never through `pageDisplayLabel` directly
// (test/sources/page-labels.h1.test.ts scans the server for direct calls).
//
// Why: a page without a printed number in a version whose other pages are numbered must be named by its file position
// («الصفحة 1 في الملف»), never «ص 1» — that may be the printed number of ANOTHER page. Whether the version is
// «numbered» is a fact about the whole version, which a single page row does not carry; this helper derives it
// (`numbered_version`) from the page's version, so no producer can forget it.
import { pageDisplayLabel, type SourcePageView } from '@medlevo/shared';
import type { Db } from '../../db/db';

type PageKind = SourcePageView['kind'];

interface LabelPageBase {
  page_index: number;
  printed_label: string | null;
  /** page kind (page / slide / image / docx_section / audio_segment); null → 'page' */
  kind: PageKind | string | null | undefined;
}

/**
 * A page to label: its version, its id, or an already known `numbered_version` is REQUIRED — the type makes it
 * impossible to ask for a label without what decides AC-04.
 */
export type LabelPage = LabelPageBase &
  ({ version_id: string } | { id: string } | { page_id: string } | { numbered_version: boolean });

/** Some page of the version carries a printed number (pages of kind 'page' only, like the sources pages endpoint). */
export function versionIsNumbered(db: Db, versionId: string): boolean {
  return !!db.get(`SELECT 1 AS x FROM source_page WHERE version_id = ? AND kind = 'page' AND printed_label IS NOT NULL LIMIT 1`, [versionId]);
}

/** SQL expression (1 / NULL): «the version of the page aliased `alias` is numbered» — for list queries. */
export function versionNumberedSql(alias: string): string {
  return `(SELECT 1 FROM source_page pn_ WHERE pn_.version_id = ${alias}.version_id AND pn_.kind = 'page' AND pn_.printed_label IS NOT NULL LIMIT 1)`;
}

function numberedOf(db: Db, p: LabelPage): boolean {
  const known = (p as { numbered_version?: boolean }).numbered_version;
  if (typeof known === 'boolean') return known;
  const versionId = (p as { version_id?: string }).version_id;
  if (versionId) return versionIsNumbered(db, versionId);
  const pageId = (p as { id?: string }).id ?? (p as { page_id?: string }).page_id;
  if (!pageId) return false;
  const row = db.get<{ version_id: string }>('SELECT version_id FROM source_page WHERE id = ?', [pageId]);
  return row ? versionIsNumbered(db, row.version_id) : false;
}

/**
 * «ص 12» / «ص 12 (الصفحة 14 في الملف)» / «الصفحة 1 في الملف» (unnumbered page among numbered ones) / «شريحة 3» …
 * `withFileIndex: false` drops the «(الصفحة N في الملف)» part of a printed page (compact lists).
 */
export function pageLabelAr(db: Db, p: LabelPage, opts: { withFileIndex?: boolean } = {}): string {
  return pageLabelKnown({ ...p, numbered_version: numberedOf(db, p) }, opts);
}

/** The same label for a row whose query already computed `numbered_version` (e.g. with `versionNumberedSql`). */
export function pageLabelKnown(p: LabelPageBase & { numbered_version: boolean }, opts: { withFileIndex?: boolean } = {}): string {
  return pageDisplayLabel({ page_index: p.page_index, printed_label: p.printed_label, kind: (p.kind ?? 'page') as PageKind, numbered_version: p.numbered_version }, opts);
}
