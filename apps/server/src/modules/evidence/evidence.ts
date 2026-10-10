// Evidence rows (§10, ARCHITECTURE §3.6). Evidence is created ONLY from existing regions: the quote is an
// exact substring of region.text (UTF-16 offsets), stored with explicit offsets so the same excerpt of the
// same region is always the same row (idempotent: UNIQUE(region_id, start_offset, end_offset)).
// Views carry a human locator («ص 12 (الصفحة 14 في الملف)», «شريحة 3», «فقرة 7», «الدقيقة 12:05») and the
// CURRENT availability: a citation of a trashed source or of a replaced version says so (§11) instead of
// pointing at a substitute page.
import { pageDisplayLabel, type EvidenceView, type NormBox, type SourceType } from '@medlevo/shared';
import type { AppContext } from '../../context';
import type { Db } from '../../db/db';
import { fromJson } from '../../db/db';
import { AppError } from '../../lib/errors';
import { newId } from '../../lib/ids';

export interface EvidenceRow {
  id: string;
  version_id: string;
  source_id: string;
  page_id: string | null;
  region_id: string | null;
  quote: string;
  start_offset: number | null;
  end_offset: number | null;
  bbox_json: string | null;
  created_at: number;
}

interface RegionForEvidence {
  id: string;
  version_id: string;
  page_id: string | null;
  kind: string;
  text: string | null;
  bbox_json: string | null;
  status: string;
  text_origin: string | null;
  source_id: string;
  source_deleted_at: number | null;
}

const MSG = {
  regionMissing: 'المنطقة المطلوبة غير موجودة في المصدر (ربما أُعيدت معالجة الصفحة). لا يمكن إنشاء دليل منها.',
  regionNoText: 'هذه المنطقة لا تحتوي نصًا مقروءًا؛ لا يمكن أن تكون دليلًا نصيًا.',
  regionRejected: 'رُفض استخراج هذه المنطقة؛ لا تُستخدم دليلًا حتى تُصحَّح.',
  regionGenerated: 'نص هذه المنطقة وصفٌ مولَّد آليًا (vision) وليس نص المصدر؛ المحتوى المولَّد لا يكون دليلًا.',
  badOffsets: 'حدود المقتطف غير صالحة لهذه المنطقة.',
  emptyQuote: 'المقتطف المطلوب فارغ.',
  sourceTrashed: 'المصدر في سلة المحذوفات؛ لا يُنشأ منه دليل جديد حتى تستعيده.',
  chunkMissing: 'المقطع المطلوب غير موجود.',
};

/** Region kinds that can never be cited as evidence (layout furniture). */
const NON_EVIDENCE_KINDS = new Set(['header', 'footer']);

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Evidence from a region (whole text by default, or [start, end) UTF-16 offsets). Idempotent: the same
 * region + offsets always returns the same evidence row. The quote is ALWAYS region.text.slice(start, end).
 */
export function fromRegion(ctx: AppContext, regionId: string, opts: { start?: number; end?: number } = {}): EvidenceRow {
  const { db } = ctx;
  const r = db.get<RegionForEvidence>(
    `SELECT r.id, r.version_id, r.page_id, r.kind, r.text, r.bbox_json, r.status, r.text_origin, v.source_id, s.deleted_at AS source_deleted_at
       FROM source_region r JOIN source_version v ON v.id = r.version_id JOIN source s ON s.id = v.source_id
      WHERE r.id = ?`,
    [regionId],
  );
  if (!r) throw new AppError('NOT_FOUND', MSG.regionMissing, 404, { region_id: regionId });
  if (r.source_deleted_at !== null) throw new AppError('CONFLICT', MSG.sourceTrashed, 409, { region_id: regionId });
  if (r.status === 'rejected') throw new AppError('INVALID_EVIDENCE', MSG.regionRejected, 422, { region_id: regionId });
  // generated stays generated (§03): a model-written description of a figure is never source evidence
  if (r.text_origin === 'vision') throw new AppError('INVALID_EVIDENCE', MSG.regionGenerated, 422, { region_id: regionId });
  const text = r.text ?? '';
  if (!text.trim() || NON_EVIDENCE_KINDS.has(r.kind)) throw new AppError('INVALID_EVIDENCE', MSG.regionNoText, 422, { region_id: regionId });

  const start = opts.start ?? 0;
  const end = opts.end ?? text.length;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > text.length || start >= end) {
    throw new AppError('VALIDATION_FAILED', MSG.badOffsets, 400, { region_id: regionId, length: text.length });
  }
  // never split a surrogate pair (the quote must be a well-formed excerpt)
  if ((start > 0 && isLowSurrogate(text.charCodeAt(start))) || (end < text.length && isLowSurrogate(text.charCodeAt(end)))) {
    throw new AppError('VALIDATION_FAILED', MSG.badOffsets, 400, { region_id: regionId });
  }
  const quote = text.slice(start, end);
  if (!quote.trim()) throw new AppError('VALIDATION_FAILED', MSG.emptyQuote, 400, { region_id: regionId });

  const existing = db.get<EvidenceRow>('SELECT * FROM evidence WHERE region_id = ? AND start_offset = ? AND end_offset = ?', [regionId, start, end]);
  if (existing) {
    // the region text is immutable for a region id (re-processing creates new regions); keep the stored row
    return existing;
  }
  const now = ctx.clock.now();
  const id = newId(now);
  db.run(
    `INSERT INTO evidence (id, version_id, source_id, page_id, region_id, quote, start_offset, end_offset, bbox_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(region_id, start_offset, end_offset) DO NOTHING`,
    [id, r.version_id, r.source_id, r.page_id, r.id, quote, start, end, r.bbox_json, now],
  );
  return db.get<EvidenceRow>('SELECT * FROM evidence WHERE region_id = ? AND start_offset = ? AND end_offset = ?', [regionId, start, end])!;
}

/** Text regions of a chunk that can be cited (in chunk order). */
export function chunkRegionIds(db: Db, chunkId: string): string[] {
  const c = db.get<{ region_ids_json: string }>('SELECT region_ids_json FROM document_chunk WHERE id = ?', [chunkId]);
  if (!c) throw new AppError('NOT_FOUND', MSG.chunkMissing, 404, { chunk_id: chunkId });
  return fromJson<string[]>(c.region_ids_json, []) ?? [];
}

/**
 * Evidence rows for a retrieval chunk: one whole-region excerpt per citable region (tables are one region
 * whose text is the serialized table). Regions without text (figure boxes) are skipped.
 */
export function fromChunk(ctx: AppContext, chunkId: string): EvidenceRow[] {
  const out: EvidenceRow[] = [];
  for (const rid of chunkRegionIds(ctx.db, chunkId)) {
    const r = ctx.db.get<{ text: string | null; kind: string; status: string; text_origin: string | null }>('SELECT text, kind, status, text_origin FROM source_region WHERE id = ?', [rid]);
    if (!r || !r.text?.trim() || NON_EVIDENCE_KINDS.has(r.kind) || r.status === 'rejected' || r.text_origin === 'vision') continue;
    out.push(fromRegion(ctx, rid));
  }
  return out;
}

// ───────── locators ─────────
export interface PageForLabel {
  page_index: number;
  printed_label: string | null;
  kind: 'page' | 'slide' | 'image' | 'docx_section' | 'audio_segment';
  /** other pages of the version carry printed numbers: an unnumbered page is named by its file position (AC-04) */
  numbered_version?: boolean;
}

function formatMs(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

/**
 * Human locator: printed page + file page when they differ (AC-04), slide, DOCX paragraph (never an invented
 * page number), audio timestamp.
 */
export function locatorLabelAr(page: PageForLabel | null, locator: Record<string, unknown> | null, opts: { withFileIndex?: boolean } = {}): string {
  const paragraph = typeof locator?.paragraph_index === 'number' ? (locator.paragraph_index as number) : null;
  const startMs = typeof locator?.start_ms === 'number' ? (locator.start_ms as number) : null;
  if (startMs !== null) return `الدقيقة ${formatMs(startMs)}`;
  if (page?.kind === 'docx_section' || (page === null && paragraph !== null)) {
    return paragraph !== null ? `فقرة ${paragraph + 1}` : `قسم ${(page?.page_index ?? 0) + 1}`;
  }
  if (page?.kind === 'audio_segment') return `مقطع ${page.page_index + 1}`;
  if (page) return pageDisplayLabel(page, opts);
  return 'موضع غير محدد';
}

// ───────── views ─────────
interface ViewRow {
  id: string;
  version_id: string;
  source_id: string;
  page_id: string | null;
  region_id: string | null;
  quote: string;
  bbox_json: string | null;
  source_title: string | null;
  source_type: SourceType | null;
  source_deleted_at: number | null;
  current_version_id: string | null;
  frozen_version_id: string | null;
  version_no: number | null;
  page_index: number | null;
  printed_label: string | null;
  page_kind: PageForLabel['kind'] | null;
  version_numbered: number | null;
  region_kind: string | null;
  region_status: EvidenceView['extraction_status'] | null;
  region_bbox_json: string | null;
  locator_json: string | null;
}

export interface GetViewsOptions {
  /** versions the caller keeps on purpose (a frozen artifact / Source Freeze): not reported as replaced */
  pinnedVersionIds?: Iterable<string>;
}

const VIEW_SQL = `SELECT e.id, e.version_id, e.source_id, e.page_id, e.region_id, e.quote, e.bbox_json,
    s.title AS source_title, s.source_type, s.deleted_at AS source_deleted_at, s.current_version_id, s.frozen_version_id,
    v.version_no, p.page_index, p.printed_label, p.kind AS page_kind,
    (SELECT 1 FROM source_page pn WHERE pn.version_id = e.version_id AND pn.kind = 'page' AND pn.printed_label IS NOT NULL LIMIT 1) AS version_numbered,
    r.kind AS region_kind, r.status AS region_status, r.bbox_json AS region_bbox_json, r.locator_json
  FROM evidence e
  LEFT JOIN source s ON s.id = e.source_id
  LEFT JOIN source_version v ON v.id = e.version_id
  LEFT JOIN source_page p ON p.id = e.page_id
  LEFT JOIN source_region r ON r.id = e.region_id`;

function toView(r: ViewRow, pinned: Set<string>): EvidenceView {
  const active = r.frozen_version_id ?? r.current_version_id;
  let availability: EvidenceView['availability'] = 'available';
  if (r.source_deleted_at !== null || r.source_title === null) availability = 'source_deleted';
  else if (active !== r.version_id && !pinned.has(r.version_id)) availability = 'version_replaced';
  const page: PageForLabel | null =
    r.page_index !== null && r.page_kind ? { page_index: r.page_index, printed_label: r.printed_label, kind: r.page_kind, numbered_version: r.version_numbered === 1 } : null;
  const bbox = fromJson<NormBox>(r.bbox_json) ?? fromJson<NormBox>(r.region_bbox_json) ?? null;
  return {
    id: r.id,
    source_id: r.source_id,
    source_title: (r.source_title ?? '').replace(/[\r\n\t]+/g, ' ').trim(),
    source_type: r.source_type ?? 'lecture',
    version_id: r.version_id,
    version_no: r.version_no ?? 0,
    page_id: r.page_id,
    page_index: r.page_index,
    locator_label_ar: locatorLabelAr(page, fromJson<Record<string, unknown>>(r.locator_json)),
    region_id: r.region_id,
    region_kind: r.region_kind,
    quote: r.quote,
    bbox,
    extraction_status: r.region_status ?? 'extracted',
    availability,
  };
}

/** Evidence views in the order of `ids` (missing ids are skipped; see getViewsWithMissing). */
export function getViews(ctx: AppContext, ids: string[], opts: GetViewsOptions = {}): EvidenceView[] {
  return getViewsWithMissing(ctx, ids, opts).evidence;
}

export function getViewsWithMissing(ctx: AppContext, ids: string[], opts: GetViewsOptions = {}): { evidence: EvidenceView[]; missing: string[] } {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return { evidence: [], missing: [] };
  const pinned = new Set(opts.pinnedVersionIds ?? []);
  const rows = new Map<string, ViewRow>();
  for (let i = 0; i < unique.length; i += 400) {
    const part = unique.slice(i, i + 400);
    for (const r of ctx.db.all<ViewRow>(`${VIEW_SQL} WHERE e.id IN (${part.map(() => '?').join(',')})`, part)) rows.set(r.id, r);
  }
  const evidence: EvidenceView[] = [];
  const missing: string[] = [];
  for (const id of unique) {
    const r = rows.get(id);
    if (r) evidence.push(toView(r, pinned));
    else missing.push(id);
  }
  return { evidence, missing };
}

export function getView(ctx: AppContext, id: string, opts: GetViewsOptions = {}): EvidenceView {
  const v = getViews(ctx, [id], opts)[0];
  if (!v) throw new AppError('NOT_FOUND', 'الدليل المطلوب غير موجود (ربما حُذف مصدره نهائيًا).', 404, { evidence_id: id });
  return v;
}
