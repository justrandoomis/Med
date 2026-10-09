// Regions of one source version → parser lines in reading order (page_index, reading_order). Header/footer
// bands and child regions (table cells, diagram labels) are skipped; tables keep their structure so a key table
// can be read cell by cell.
import type { NormBox, TableStructure } from '@medlevo/shared';
import type { AppContext } from '../../context';
import { fromJson } from '../../db/db';
import type { ParserLine } from './parser';

export interface RegionRowForParser {
  id: string;
  kind: string;
  text: string | null;
  status: string;
  confidence: number | null;
  text_origin: string | null;
  bbox_json: string | null;
  structure_json: string | null;
  parent_region_id: string | null;
  page_index: number;
  page_id: string;
}

export function regionsToLines(rows: RegionRowForParser[]): ParserLine[] {
  const out: ParserLine[] = [];
  for (const r of rows) {
    if (r.parent_region_id) continue;
    if (r.kind === 'header' || r.kind === 'footer') continue;
    const structure = fromJson<{ type?: string } | null>(r.structure_json, null);
    const table = structure && structure.type === 'table' ? (structure as TableStructure) : null;
    const isFigure = r.kind === 'figure' || r.kind === 'diagram' || r.kind === 'caption';
    if (!isFigure && !table && !(r.text ?? '').trim()) continue;
    out.push({
      text: r.text ?? '',
      regionId: r.id,
      regionKind: r.kind,
      pageIndex: r.page_index,
      pageId: r.page_id,
      bbox: fromJson<NormBox | null>(r.bbox_json, null),
      regionStatus: r.status,
      confidence: r.confidence,
      textOrigin: r.text_origin,
      table,
    });
  }
  return out;
}

export function loadParserLines(ctx: AppContext, versionId: string): ParserLine[] {
  const rows = ctx.db.all<RegionRowForParser>(
    `SELECT r.id, r.kind, r.text, r.status, r.confidence, r.text_origin, r.bbox_json, r.structure_json, r.parent_region_id,
            p.page_index, p.id AS page_id
       FROM source_region r JOIN source_page p ON p.id = r.page_id
      WHERE r.version_id = ? AND r.status <> 'rejected'
      ORDER BY p.page_index, r.reading_order`,
    [versionId],
  );
  return regionsToLines(rows);
}
