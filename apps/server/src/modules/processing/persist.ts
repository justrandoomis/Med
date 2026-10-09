// Idempotent persistence of one page's processing result. Re-running a page REPLACES its regions,
// image assets and open processing review items in one transaction (AC-25: a retry after a crash never
// duplicates rows). Regions that other modules already reference (evidence, overlays) are never
// silently dropped: the replace fails and the page is reported with a specific reason.
import type { DiagramStructure, FigureStructure, NormBox, ReviewQueueKind, TableStructure } from '@medlevo/shared';
import { clampBox } from '@medlevo/shared';
import type { AppContext } from '../../context';
import { toJson } from '../../db/db';
import { newId } from '../../lib/ids';
import type { Box, LayoutRegion, PageGeom } from './layout/types';

export interface PageRef {
  versionId: string;
  sourceId: string;
  pageId: string;
  pageIndex: number;
  printedLabel: string | null;
  /** null for unpaginated sources (DOCX sections) → no bbox */
  geom: PageGeom | null;
}

export interface FigureAsset {
  /** stored image file (crop / embedded picture / the image page itself); null when no raster could be made */
  fileId: string | null;
  imageKind?: 'diagram' | 'unknown';
}

export interface ReviewItemInput {
  kind: Extract<ReviewQueueKind, 'ocr_error' | 'unreadable_page'>;
  /** region key, or null for a page-level item */
  regionKey: string | null;
  reasonAr: string;
  details?: Record<string, unknown>;
}

export interface PageUpdate {
  text_status: 'digital' | 'ocr' | 'mixed' | 'no_text_found' | 'needs_ocr' | 'failed';
  processing_status: 'ready' | 'needs_review' | 'failed';
  ocr_confidence: number | null;
  has_images: boolean;
  render_file_id?: string | null;
  error_code: string | null;
  error_detail: string | null;
  section_key?: string | null;
}

export interface PersistResult {
  regionIds: Map<string, string>;
  regions: number;
  reviewItems: number;
  imageAssets: number;
}

export class RegionsInUseError extends Error {
  constructor(
    /** 'referenced': other records point at the regions; 'owner_reviewed': the owner reviewed/corrected some */
    readonly reason: 'referenced' | 'owner_reviewed' = 'referenced',
  ) {
    super(reason === 'owner_reviewed' ? 'regions of this page were reviewed or corrected by the owner' : 'regions of this page are referenced by other records');
    this.name = 'RegionsInUseError';
  }
}

export function normBox(b: Box | null, geom: PageGeom | null): NormBox | null {
  if (!b || !geom || geom.width <= 0 || geom.height <= 0) return null;
  if (b.x1 - b.x0 <= 0 && b.bottom - b.top <= 0) return null;
  const r = (n: number) => Math.round(n * 1e6) / 1e6;
  const c = clampBox({ x: b.x0 / geom.width, y: b.top / geom.height, w: (b.x1 - b.x0) / geom.width, h: (b.bottom - b.top) / geom.height });
  return { x: r(c.x), y: r(c.y), w: r(c.w), h: r(c.h) };
}

const IMAGE_KIND_FROM_CAPTION = /\b(?:flow ?chart|algorithm|pathway|diagram|schematic)\b|مخطط|خوارزمية|رسم توضيحي/i;

export function imageKindFromCaption(caption: string | null | undefined): 'diagram' | 'unknown' {
  return caption && IMAGE_KIND_FROM_CAPTION.test(caption) ? 'diagram' : 'unknown';
}

/** Delete everything a previous run derived for this page (children first). */
function clearPage(ctx: AppContext, versionId: string, pageId: string): void {
  ctx.db.run(
    `DELETE FROM review_queue_item WHERE status = 'open' AND kind IN ('ocr_error','unreadable_page')
       AND json_valid(details_json) AND json_extract(details_json, '$.origin') = 'processing' AND json_extract(details_json, '$.page_id') = ?`,
    [pageId],
  );
  // chunks built from this page's regions would point at deleted region ids: drop them now (the index
  // stage rebuilds them; until then the page is simply not searchable instead of citing missing regions)
  ctx.db.run(
    `DELETE FROM document_chunk WHERE version_id = ? AND EXISTS (SELECT 1 FROM json_each(document_chunk.page_ids_json) WHERE value = ?)`,
    [versionId, pageId],
  );
  // a figure on ANOTHER page may use a caption printed on this page (cross-page link): release the link
  // (it is re-established by the version pass) instead of letting the foreign key block the replace
  ctx.db.run(
    `UPDATE image_asset SET caption_region_id = NULL, caption = NULL
      WHERE caption_region_id IN (SELECT id FROM source_region WHERE page_id = ?) AND (page_id IS NULL OR page_id <> ?) AND origin = 'source'`,
    [pageId, pageId],
  );
  ctx.db.run(`DELETE FROM image_asset WHERE page_id = ? AND origin = 'source'`, [pageId]);
  ctx.db.run('DELETE FROM source_region WHERE page_id = ? AND parent_region_id IS NOT NULL', [pageId]);
  ctx.db.run('DELETE FROM source_region WHERE page_id = ?', [pageId]);
}

function isForeignKeyError(e: unknown): boolean {
  return e instanceof Error && /FOREIGN KEY constraint failed/i.test(e.message);
}

export function persistPage(
  ctx: AppContext,
  ref: PageRef,
  regions: LayoutRegion[],
  assets: Map<string, FigureAsset>,
  reviews: ReviewItemInput[],
  page: PageUpdate,
): PersistResult {
  const now = ctx.clock.now();
  const ids = new Map<string, string>();
  for (const r of regions) ids.set(r.key, newId(now));
  const assetIds = new Map<string, string>();
  for (const [key, a] of assets) if (a.fileId && ids.has(key)) assetIds.set(key, newId(now));
  const byKey = new Map(regions.map((r) => [r.key, r]));

  const structureOf = (r: LayoutRegion): unknown => {
    if (r.table) {
      const s: TableStructure = {
        type: 'table',
        rows: r.table.rows,
        cols: r.table.cols,
        cells: r.table.cells.map((c) => {
          const cell: TableStructure['cells'][number] = { r: c.r, c: c.c, text: c.text };
          if (c.rowspan > 1) cell.rowspan = c.rowspan;
          if (c.colspan > 1) cell.colspan = c.colspan;
          if (c.header) cell.header = true;
          const bb = r.box ? normBox(c.box, ref.geom) : null;
          if (bb) cell.bbox = bb;
          return cell;
        }),
        caption_region_id: r.tableCaptionKey ? (ids.get(r.tableCaptionKey) ?? null) : null,
      };
      return s;
    }
    if (r.kind === 'figure') {
      const s: FigureStructure = {
        type: 'figure',
        caption_region_id: r.figure?.captionKey ? (ids.get(r.figure.captionKey) ?? null) : null,
        image_asset_id: assetIds.get(r.key) ?? null,
        referenced_by_region_ids: [],
      };
      return s;
    }
    if (r.kind === 'diagram' && r.diagram) {
      const s: DiagramStructure = {
        type: 'diagram',
        nodes: r.diagram.labels.map((l, i) => {
          const node: DiagramStructure['nodes'][number] = { id: `n${i + 1}`, label: l.text, certainty: l.certainty };
          const bb = normBox(l.box, ref.geom);
          if (bb) node.bbox = bb;
          return node;
        }),
        edges: [], // relations are never inferred without a vision model (AC-08)
        understanding: r.diagram.understanding,
      };
      return s;
    }
    return null;
  };

  let reviewCount = 0;
  let assetCount = 0;
  try {
    ctx.db.tx(() => {
      // the owner's review marks / corrections are never replaced silently by a new extraction (§13, §43)
      const owned = ctx.db.get(
        `SELECT 1 AS x FROM source_region WHERE page_id = ? AND (status = 'owner_reviewed' OR text_origin = 'owner') LIMIT 1`,
        [ref.pageId],
      );
      if (owned) throw new RegionsInUseError('owner_reviewed');
      clearPage(ctx, ref.versionId, ref.pageId);
      regions.forEach((r, order) => {
        const locator: Record<string, unknown> = { ...(r.locator ?? {}) };
        if (r.kind === 'heading') {
          if (r.headingLevel) locator.heading_level = r.headingLevel;
          else if (r.fontSize) locator.font_size = r.fontSize;
        }
        ctx.db.run(
          `INSERT INTO source_region (id, version_id, page_id, parent_region_id, kind, reading_order, bbox_json, locator_json, text, text_origin, lang,
             confidence, structure_json, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            ids.get(r.key)!,
            ref.versionId,
            ref.pageId,
            r.parentKey ? (ids.get(r.parentKey) ?? null) : null,
            r.kind,
            order,
            toJson(normBox(r.box, ref.geom) ?? undefined),
            Object.keys(locator).length ? toJson(locator) : null,
            r.text,
            r.textOrigin,
            r.lang ?? null,
            typeof r.confidence === 'number' ? Math.round(r.confidence * 1000) / 1000 : null,
            toJson(structureOf(r) ?? undefined),
            r.status ?? 'extracted',
            now,
            now,
          ],
        );
      });
      for (const [key, assetId] of assetIds) {
        const r = byKey.get(key)!;
        const a = assets.get(key)!;
        const captionKey = r.figure?.captionKey ?? null;
        const caption = captionKey ? (byKey.get(captionKey)?.text ?? null) : null;
        ctx.db.run(
          `INSERT INTO image_asset (id, file_id, source_id, version_id, page_id, region_id, caption_region_id, origin, image_kind, caption, match_status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'source', ?, ?, 'unverified', ?)`,
          [assetId, a.fileId, ref.sourceId, ref.versionId, ref.pageId, ids.get(key)!, captionKey ? (ids.get(captionKey) ?? null) : null, a.imageKind ?? imageKindFromCaption(caption), caption, now],
        );
        assetCount++;
      }
      for (const rv of reviews) {
        const regionId = rv.regionKey ? ids.get(rv.regionKey) : null;
        ctx.db.run(
          `INSERT INTO review_queue_item (id, kind, entity_type, entity_id, source_id, reason, details_json, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
          [
            newId(now),
            rv.kind,
            regionId ? 'source_region' : 'source_page',
            regionId ?? ref.pageId,
            ref.sourceId,
            rv.reasonAr,
            toJson({ origin: 'processing', version_id: ref.versionId, page_id: ref.pageId, page_index: ref.pageIndex, printed_label: ref.printedLabel, ...(rv.details ?? {}) }),
            now,
          ],
        );
        reviewCount++;
      }
      ctx.db.run(
        `UPDATE source_page SET text_status = ?, processing_status = ?, ocr_confidence = ?, has_images = ?, render_file_id = COALESCE(?, render_file_id),
           error_code = ?, error_detail = ?, section_key = COALESCE(?, section_key), updated_at = ? WHERE id = ?`,
        [
          page.text_status,
          page.processing_status,
          page.ocr_confidence,
          page.has_images ? 1 : 0,
          page.render_file_id ?? null,
          page.error_code,
          page.error_detail,
          page.section_key ?? null,
          now,
          ref.pageId,
        ],
      );
    });
  } catch (e) {
    if (isForeignKeyError(e)) throw new RegionsInUseError();
    throw e;
  }
  return { regionIds: ids, regions: regions.length, reviewItems: reviewCount, imageAssets: assetCount };
}

/** Mark one page failed (its previous regions, if any, are kept — a failed retry never deletes readable content). */
export function markPageFailed(ctx: AppContext, pageId: string, code: string, reasonAr: string): void {
  ctx.db.run(
    `UPDATE source_page SET processing_status = 'failed', text_status = CASE WHEN text_status IN ('pending','failed') THEN 'failed' ELSE text_status END,
       error_code = ?, error_detail = ?, updated_at = ? WHERE id = ?`,
    [code, reasonAr, ctx.clock.now(), pageId],
  );
}
