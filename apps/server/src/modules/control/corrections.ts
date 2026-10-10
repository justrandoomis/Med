// Owner decisions on extracted text, made from the Review Queue (§48, AC-26):
//   correct     — the owner's text replaces the extracted text IN PLACE (text_origin 'owner', status
//                 'owner_reviewed'); the previous text / origin / status / confidence are kept verbatim in
//                 control_region_correction and summarized in the audit log. Processing never overwrites such a
//                 region again (it refuses with OWNER_REVIEWED_REGIONS).
//   accept      — the extracted text is confirmed as is (status 'owner_reviewed').
//   reject      — the extracted text is excluded from search and evidence (status 'rejected'); it is kept.
//   owner_text  — the owner types the text of a page nothing could read (a new 'text_block' region without a box).
// A change of text (correct / reject / owner_text) rebuilds the search chunks of that version (processing service)
// and calls the evidence dependency service, so every artifact / question / card built on that page gets a content
// change alert (stale for generated content, needs review for the rest). Nothing is regenerated automatically.
//
// CITED regions (review fix): evidence rows quote a region verbatim and the evidence service REUSES a row by
// (region, offsets) — the text of a region id is immutable for it (evidence/evidence.ts). Changing a cited region's
// text in place would make a later request reuse the OLD quote (e.g. «10» after the owner corrected it to «16») and
// show it as «راجعته شخصيًا». So when a region (or a corrected cell's table) is already cited, its row keeps its text
// verbatim and is excluded (status 'rejected'), and the corrected text becomes a NEW region in the same place (same
// page, box, order, parent; locator `supersedes_region_id`). Old citations keep showing exactly what they quoted,
// marked excluded; new evidence can only be made from the corrected text. Uncited regions are corrected in place.
import { PROCESS_JOB_KIND, pageDisplayLabel, stripBidiControls, type TableStructure } from '@medlevo/shared';
import type { AppContext } from '../../context';
import { fromJson, toJson } from '../../db/db';
import { AppError } from '../../lib/errors';
import { newId } from '../../lib/ids';
import { onSourceVersionChanged } from '../evidence/services';
import { buildChunks, writeChunks } from '../processing/chunks';
import { serializeTable } from '../processing/layout/tables';
import type { TableCellOut } from '../processing/layout/types';
import { writeSummary } from '../processing/summary';
import { REGION_KIND_LABELS_AR, oneLine } from './labels';

export const MAX_OWNER_TEXT = 20_000;
/** serializeTable ignores cell boxes; the stored structure keeps its own normalized boxes */
const NO_BOX = { x0: 0, top: 0, x1: 0, bottom: 0 };

export interface RegionRow {
  id: string;
  version_id: string;
  page_id: string | null;
  parent_region_id: string | null;
  kind: string;
  reading_order: number;
  text: string | null;
  text_origin: 'digital' | 'ocr' | 'owner' | 'vision' | null;
  confidence: number | null;
  status: string;
  structure_json: string | null;
  locator_json: string | null;
}

export interface PageRow {
  id: string;
  version_id: string;
  page_index: number;
  printed_label: string | null;
  kind: 'page' | 'slide' | 'image' | 'docx_section' | 'audio_segment';
  text_status: string;
  processing_status: string;
  ocr_confidence: number | null;
  error_code: string | null;
  error_detail: string | null;
  render_file_id: string | null;
}

interface Owning {
  sourceId: string;
  sourceTitle: string;
  versionId: string;
  deleted: boolean;
}

export interface CorrectionOutcome {
  effects_ar: string[];
  alertId: string | null;
  alertCounts: { still_valid: number; needs_regeneration: number; needs_review: number } | null;
  correctionId: string;
}

export function getRegion(ctx: AppContext, id: string): RegionRow | undefined {
  return ctx.db.get<RegionRow>(
    'SELECT id, version_id, page_id, parent_region_id, kind, reading_order, text, text_origin, confidence, status, structure_json, locator_json FROM source_region WHERE id = ?',
    [id],
  );
}

export function getPage(ctx: AppContext, id: string): PageRow | undefined {
  return ctx.db.get<PageRow>(
    'SELECT id, version_id, page_index, printed_label, kind, text_status, processing_status, ocr_confidence, error_code, error_detail, render_file_id FROM source_page WHERE id = ?',
    [id],
  );
}

function owningOf(ctx: AppContext, versionId: string): Owning {
  const r = ctx.db.get<{ source_id: string; title: string; deleted_at: number | null }>(
    'SELECT v.source_id, s.title, s.deleted_at FROM source_version v JOIN source s ON s.id = v.source_id WHERE v.id = ?',
    [versionId],
  );
  if (!r) throw new AppError('NOT_FOUND', 'نسخة المصدر غير موجودة.', 404);
  return { sourceId: r.source_id, sourceTitle: oneLine(r.title, 120) ?? '', versionId, deleted: r.deleted_at !== null };
}

function assertWritable(o: Owning): void {
  if (o.deleted) throw new AppError('CONFLICT', 'هذا المصدر في سلة المحذوفات. استعده أولًا ثم راجع نصه.', 409);
}

/** A region whose cited text was replaced by a correction is history: decisions go to its successor. */
function assertNotReplaced(ctx: AppContext, regionId: string): void {
  if (currentRegionId(ctx, regionId) !== regionId) {
    throw new AppError('CONFLICT', 'صُحّح نص هذه المنطقة من قبل وحلّ محله نصك؛ حدّث الصفحة لترى النص الحالي.', 409);
  }
}

/** Owner text: logical order, no bidi controls, no control characters (newlines kept), trimmed, bounded. */
export function cleanOwnerText(raw: string | undefined | null): string {
  const t = stripBidiControls(String(raw ?? ''))
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .normalize('NFC')
    .trim();
  if (!t) throw new AppError('VALIDATION_FAILED', 'اكتب النص الصحيح قبل الحفظ.', 400, { where: 'body', issues: [{ path: 'text', code: 'too_small', message: 'هذا الحقل مطلوب.' }] });
  if (t.length > MAX_OWNER_TEXT) {
    throw new AppError('VALIDATION_FAILED', `النص أطول من الحد المسموح (${MAX_OWNER_TEXT} حرف).`, 400, {
      where: 'body',
      issues: [{ path: 'text', code: 'too_big', message: `النص أطول من الحد الأقصى (${MAX_OWNER_TEXT} حرفًا).` }],
    });
  }
  return t;
}

export function pageLabelAr(p: Pick<PageRow, 'page_index' | 'printed_label' | 'kind'>): string {
  return pageDisplayLabel(p);
}

function processingRunning(ctx: AppContext, versionId: string): boolean {
  return !!ctx.db.get(
    `SELECT 1 AS x FROM processing_job WHERE kind = ? AND status IN ('queued','running') AND json_extract(input_json, '$.version_id') = ? LIMIT 1`,
    [PROCESS_JOB_KIND, versionId],
  );
}

/** Rebuild the version's search chunks from its current regions (a diff: unchanged chunks keep their ids). */
function reindex(ctx: AppContext, o: Owning): { inserted: number; deleted: number } {
  const res = writeChunks(ctx, o.versionId, o.sourceId, buildChunks(ctx, o.versionId));
  return { inserted: res.inserted, deleted: res.deleted };
}

/**
 * After an owner decision, a page that needed review only because of what the owner just settled becomes ready
 * (the same rule processing uses: no region still needs review and no page-level problem left open). The
 * version summary / status is then recomputed by the processing module — unless processing is running for it.
 */
export function refreshPageState(ctx: AppContext, pageId: string | null): boolean {
  if (!pageId) return false;
  const page = getPage(ctx, pageId);
  if (!page || page.processing_status !== 'needs_review') return false;
  const regionsLeft = ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM source_region WHERE page_id = ? AND status = 'needs_review'`, [pageId])!.n;
  if (regionsLeft > 0) return false;
  const openPageItems = ctx.db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM review_queue_item WHERE status = 'open' AND entity_type = 'source_page' AND entity_id = ?`,
    [pageId],
  )!.n;
  if (openPageItems > 0) return false;
  if (page.error_code) {
    // a page-level problem (unreadable page, low-quality scan) is settled only by an owner decision on it
    const decided = ctx.db.get(
      `SELECT 1 AS x FROM review_queue_item WHERE entity_type = 'source_page' AND entity_id = ? AND status IN ('accepted','corrected') LIMIT 1`,
      [pageId],
    );
    if (!decided) return false;
  }
  ctx.db.run(`UPDATE source_page SET processing_status = 'ready', updated_at = ? WHERE id = ?`, [ctx.clock.now(), pageId]);
  if (!processingRunning(ctx, page.version_id)) {
    const prevJob = ctx.db.get<{ s: string | null }>('SELECT processing_summary_json AS s FROM source_version WHERE id = ?', [page.version_id]);
    const jobId = fromJson<{ job_id?: string | null }>(prevJob?.s ?? null)?.job_id ?? null;
    writeSummary(ctx, page.version_id, 'done', jobId, { final: true });
  }
  return true;
}

interface HistoryInput {
  region: Pick<RegionRow, 'id' | 'text' | 'text_origin' | 'status' | 'confidence'> | null;
  regionId: string;
  pageId: string | null;
  o: Owning;
  itemId: string | null;
  action: 'correct' | 'accept' | 'reject' | 'owner_text';
  afterText: string | null;
  afterOrigin: string | null;
  afterStatus: string | null;
  note: string | null;
}

function recordHistory(ctx: AppContext, h: HistoryInput): string {
  const id = newId(ctx.clock.now());
  ctx.db.run(
    `INSERT INTO control_region_correction (id, region_id, version_id, source_id, page_id, review_item_id, action, before_text, after_text, before_origin, after_origin,
       before_status, after_status, before_confidence, alert_id, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    [
      id,
      h.regionId,
      h.o.versionId,
      h.o.sourceId,
      h.pageId,
      h.itemId,
      h.action,
      h.region?.text ?? null,
      h.afterText,
      h.region?.text_origin ?? null,
      h.afterOrigin,
      h.region?.status ?? null,
      h.afterStatus,
      h.region?.confidence ?? null,
      h.note,
      ctx.clock.now(),
    ],
  );
  return id;
}

function alertFor(ctx: AppContext, o: Owning, page: PageRow | undefined, kind: 'ocr_corrected' | 'source_updated', noteAr: string): CorrectionOutcome['alertCounts'] & { id: string | null } {
  if (!page) return { id: null, still_valid: 0, needs_regeneration: 0, needs_review: 0 };
  const res = onSourceVersionChanged(ctx, {
    sourceId: o.sourceId,
    fromVersionId: o.versionId,
    toVersionId: o.versionId,
    kind,
    pageIndexes: [page.page_index],
    noteAr,
  });
  const counts = { still_valid: 0, needs_regeneration: 0, needs_review: 0 };
  for (const i of res.items) counts[i.impact]++;
  return { id: res.alertId, ...counts };
}

function alertEffect(a: { id: string | null; still_valid: number; needs_regeneration: number; needs_review: number }): string {
  if (!a.id) return 'لا يوجد محتوى مشتق (شرح أو سؤال أو بطاقة) يعتمد على هذه الصفحة، فلم يُنشأ تنبيه.';
  const parts: string[] = [];
  if (a.needs_regeneration) parts.push(`${a.needs_regeneration} يحتاج إعادة توليد`);
  if (a.needs_review) parts.push(`${a.needs_review} يحتاج مراجعة`);
  if (a.still_valid) parts.push(`${a.still_valid} ما زال صالحًا`);
  return `أُنشئ تنبيه تغيّر محتوى للعناصر التي تعتمد على هذه الصفحة (${parts.join('، ')}). لم يُعَد توليد أي شيء تلقائيًا، ولم تتغير محاولاتك السابقة.`;
}

/** True when evidence quotes this region (its text must then never change in place — see the header). */
export function isCited(ctx: AppContext, regionId: string): boolean {
  return !!ctx.db.get('SELECT 1 AS x FROM evidence WHERE region_id = ? LIMIT 1', [regionId]);
}

/** The region that replaced `regionId` after a correction of cited text (itself when it was never replaced). */
export function currentRegionId(ctx: AppContext, regionId: string): string {
  let id = regionId;
  for (let i = 0; i < 20; i++) {
    const next = ctx.db.get<{ id: string }>(
      `SELECT id FROM source_region WHERE version_id = (SELECT version_id FROM source_region WHERE id = ?)
          AND json_valid(locator_json) AND json_extract(locator_json, '$.supersedes_region_id') = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
      [id, id],
    );
    if (!next) return id;
    id = next.id;
  }
  return id;
}

/** Every region id of a correction chain that ends at `regionId` (oldest first), for the correction history. */
export function regionChain(ctx: AppContext, regionId: string): string[] {
  const out = [regionId];
  let id: string | null = regionId;
  for (let i = 0; i < 20 && id; i++) {
    const loc: { s: string | null } | undefined = ctx.db.get<{ s: string | null }>(
      `SELECT json_extract(locator_json, '$.supersedes_region_id') AS s FROM source_region WHERE id = ? AND json_valid(locator_json)`,
      [id],
    );
    id = typeof loc?.s === 'string' && loc.s && !out.includes(loc.s) ? loc.s : null;
    if (id) out.unshift(id);
  }
  return out;
}

/**
 * Replace a CITED region by a new one carrying the new text (same version, page, parent, kind, order, box, lang):
 * the cited row keeps its text verbatim and leaves search / new evidence (status 'rejected'); its children (table
 * cells) and the open review items about it move to the successor; a caption's table / figure points at the
 * successor. Returns the successor's id.
 */
function supersedeRegion(
  ctx: AppContext,
  region: RegionRow,
  next: { text: string; textOrigin: RegionRow['text_origin']; status: string; confidence: number | null; structureJson?: string | null },
): string {
  const now = ctx.clock.now();
  const id = newId(now);
  const loc = fromJson<Record<string, unknown>>(region.locator_json, {}) ?? {};
  ctx.db.run(
    `INSERT INTO source_region (id, version_id, page_id, parent_region_id, kind, reading_order, bbox_json, locator_json, text, text_origin, lang, confidence, structure_json, status, created_at, updated_at)
     SELECT ?, version_id, page_id, parent_region_id, kind, reading_order, bbox_json, ?, ?, ?, lang, ?, ?, ?, ?, ? FROM source_region WHERE id = ?`,
    [
      id,
      toJson({ ...loc, supersedes_region_id: region.id }),
      next.text,
      next.textOrigin,
      next.confidence,
      next.structureJson === undefined ? region.structure_json : next.structureJson,
      next.status,
      now,
      now,
      region.id,
    ],
  );
  ctx.db.run(`UPDATE source_region SET status = 'rejected', updated_at = ? WHERE id = ?`, [now, region.id]);
  ctx.db.run(`UPDATE source_region SET parent_region_id = ?, updated_at = ? WHERE parent_region_id = ? AND id <> ?`, [id, now, region.id, id]);
  ctx.db.run(`UPDATE review_queue_item SET entity_id = ? WHERE status = 'open' AND entity_type = 'source_region' AND entity_id = ?`, [id, region.id]);
  if (region.kind === 'caption') {
    for (const r of ctx.db.all<{ id: string; structure_json: string }>(
      `SELECT id, structure_json FROM source_region WHERE version_id = ? AND kind IN ('table','figure') AND status <> 'rejected' AND json_valid(structure_json)
          AND json_extract(structure_json, '$.caption_region_id') = ?`,
      [region.version_id, region.id],
    )) {
      const st = fromJson<Record<string, unknown>>(r.structure_json, {}) ?? {};
      ctx.db.run(`UPDATE source_region SET structure_json = ?, updated_at = ? WHERE id = ?`, [toJson({ ...st, caption_region_id: id }), now, r.id]);
    }
  }
  return id;
}

const SUPERSEDED_EFFECT_AR =
  'النص السابق مستشهد به في محتوى مولّد، فبقي محفوظًا كما هو ومستبعدًا من البحث والأدلة الجديدة (حتى تعرض الاستشهادات القديمة ما اقتبسته فعلًا، معلَّمًا بأنه مستبعد)، وحُفظ نصك كنص جديد في الموضع نفسه.';

/** Close other open items about the same region (the owner settled the region as a whole). */
function closeSiblingItems(ctx: AppContext, regionId: string, exceptItemId: string | null, status: string, note: string): number {
  const now = ctx.clock.now();
  const siblings = ctx.db.all<{ id: string; kind: string; reason: string }>(
    `SELECT id, kind, reason FROM review_queue_item WHERE status = 'open' AND entity_type = 'source_region' AND entity_id = ? AND (? IS NULL OR id <> ?)`,
    [regionId, exceptItemId, exceptItemId],
  );
  for (const it of siblings) {
    ctx.db.run(`UPDATE review_queue_item SET status = ?, resolved_at = ?, resolution_json = ? WHERE id = ? AND status = 'open'`, [
      status,
      now,
      toJson({ by: 'owner', via: 'control', note, effects_ar: [note], decided_with: exceptItemId }),
      it.id,
    ]);
    // every closed review item is in the owner's history, not only the one decided directly
    ctx.audit.record({
      entityType: 'review_queue_item',
      entityId: it.id,
      action: `review_${status}`,
      summary: `${oneLine(it.reason, 160)} — ${note}`,
      before: { status: 'open' },
      after: { status, note },
    });
  }
  return siblings.length;
}

/**
 * A corrected table cell is written into its table's structure and serialized text too (search / evidence read the
 * table). A CITED table keeps its text: its successor carries the new structure and text (see supersedeRegion).
 * Returns the id of the table that now holds the corrected text.
 */
function syncParentTable(ctx: AppContext, cell: RegionRow, newText: string): string | null {
  if (cell.kind !== 'table_cell' || !cell.parent_region_id) return null;
  const parent = getRegion(ctx, cell.parent_region_id);
  if (!parent || parent.kind !== 'table') return null;
  const loc = fromJson<{ r?: number; c?: number }>(cell.locator_json, {}) ?? {};
  const st = fromJson<TableStructure | null>(parent.structure_json, null);
  if (!st || st.type !== 'table' || typeof loc.r !== 'number' || typeof loc.c !== 'number') return null;
  const target = st.cells.find((c) => c.r === loc.r && c.c === loc.c);
  if (!target) return null;
  target.text = newText;
  const caption = st.caption_region_id ? (ctx.db.get<{ text: string | null }>('SELECT text FROM source_region WHERE id = ?', [st.caption_region_id])?.text ?? null) : null;
  const cells: TableCellOut[] = st.cells.map((c) => ({ r: c.r, c: c.c, rowspan: c.rowspan ?? 1, colspan: c.colspan ?? 1, header: c.header ?? false, text: c.text, box: NO_BOX }));
  const text = serializeTable({ rows: st.rows, cols: st.cols, cells }, caption);
  const cellsLeft = ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM source_region WHERE parent_region_id = ? AND id <> ? AND status = 'needs_review'`, [parent.id, cell.id])!.n;
  const ownOpen = ctx.db.get(`SELECT 1 AS x FROM review_queue_item WHERE status = 'open' AND entity_type = 'source_region' AND entity_id = ?`, [parent.id]);
  const status = parent.status === 'needs_review' && cellsLeft === 0 && !ownOpen ? 'owner_reviewed' : parent.status;
  if (isCited(ctx, parent.id) && (parent.text ?? '') !== text) {
    return supersedeRegion(ctx, parent, { text, textOrigin: parent.text_origin, status, confidence: parent.confidence, structureJson: toJson(st) });
  }
  ctx.db.run(`UPDATE source_region SET structure_json = ?, text = ?, status = ?, updated_at = ? WHERE id = ?`, [toJson(st), text, status, ctx.clock.now(), parent.id]);
  return parent.id;
}

/** A reviewed (accepted / rejected) cell can settle its table's review state. */
function settleParentTable(ctx: AppContext, cell: RegionRow): void {
  if (cell.kind !== 'table_cell' || !cell.parent_region_id) return;
  const parent = getRegion(ctx, cell.parent_region_id);
  if (!parent || parent.status !== 'needs_review') return;
  const cellsLeft = ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM source_region WHERE parent_region_id = ? AND status = 'needs_review'`, [parent.id])!.n;
  const ownOpen = ctx.db.get(`SELECT 1 AS x FROM review_queue_item WHERE status = 'open' AND entity_type = 'source_region' AND entity_id = ?`, [parent.id]);
  if (cellsLeft === 0 && !ownOpen) ctx.db.run(`UPDATE source_region SET status = 'owner_reviewed', updated_at = ? WHERE id = ?`, [ctx.clock.now(), parent.id]);
}

function auditSnippet(t: string | null): string | null {
  return t == null ? null : t.length > 400 ? `${t.slice(0, 399)}…` : t;
}

export interface RegionDecisionInput {
  regionId: string;
  itemId: string | null;
  note: string | null;
}

/** «correct»: the owner's text replaces the extracted text (previous text kept in the history). */
export function correctRegion(ctx: AppContext, input: RegionDecisionInput & { text: string }): CorrectionOutcome {
  const text = cleanOwnerText(input.text);
  return ctx.db.tx(() => {
    const region = getRegion(ctx, input.regionId);
    if (!region) throw new AppError('NOT_FOUND', 'المنطقة المطلوبة لم تعد موجودة (ربما أُعيدت معالجة الصفحة).', 404);
    const o = owningOf(ctx, region.version_id);
    assertWritable(o);
    assertNotReplaced(ctx, region.id);
    if (region.kind === 'table' || region.kind === 'figure' || region.kind === 'diagram') {
      throw new AppError('BAD_REQUEST', 'لا يُصحَّح نص الجدول أو الشكل كاملًا من هنا؛ صحّح الخلية أو التعليق المقصود.', 400);
    }
    if ((region.text ?? '') === text && region.text_origin === 'owner' && region.status === 'owner_reviewed') {
      throw new AppError('CONFLICT', 'النص مطابق لما حفظته سابقًا؛ لا يوجد ما يُصحَّح.', 409);
    }
    if ((region.text ?? '') === text) {
      throw new AppError('VALIDATION_FAILED', 'لم يتغير النص. إن كان النص المستخرج صحيحًا فاختر «قبول كما هو».', 400, {
        where: 'body',
        issues: [{ path: 'text', code: 'unchanged', message: 'النص مطابق للنص المستخرج.' }],
      });
    }
    const page = region.page_id ? getPage(ctx, region.page_id) : undefined;
    const now = ctx.clock.now();
    const correctionId = recordHistory(ctx, {
      region,
      regionId: region.id,
      pageId: region.page_id,
      o,
      itemId: input.itemId,
      action: 'correct',
      afterText: text,
      afterOrigin: 'owner',
      afterStatus: 'owner_reviewed',
      note: input.note,
    });
    // a cited region keeps its text (evidence contract): the corrected text becomes its successor
    const superseded = isCited(ctx, region.id);
    const currentId = superseded
      ? supersedeRegion(ctx, region, { text, textOrigin: 'owner', status: 'owner_reviewed', confidence: null })
      : region.id;
    if (!superseded) {
      ctx.db.run(`UPDATE source_region SET text = ?, text_origin = 'owner', status = 'owner_reviewed', confidence = NULL, updated_at = ? WHERE id = ?`, [text, now, region.id]);
    }
    const parentId = syncParentTable(ctx, { ...region, id: currentId }, text);
    const closed = closeSiblingItems(ctx, currentId, input.itemId, 'corrected', 'أُغلق لأنك صحّحت نص المنطقة نفسها.');
    const idx = reindex(ctx, o);
    const pageReady = refreshPageState(ctx, region.page_id);
    const where = page ? pageLabelAr(page) : 'هذه المنطقة';
    const alert = alertFor(
      ctx,
      o,
      page,
      region.text_origin === 'ocr' ? 'ocr_corrected' : 'source_updated',
      `صحّحتَ يدويًا نص ${REGION_KIND_LABELS_AR[region.kind] ?? 'منطقة'} في ${where}؛ النص المستخرج السابق محفوظ في سجل التصحيحات.`,
    );
    ctx.db.run('UPDATE control_region_correction SET alert_id = ? WHERE id = ?', [alert.id, correctionId]);
    ctx.audit.record({
      entityType: 'source_region',
      entityId: region.id,
      action: 'correct',
      summary: `صحّحتَ نص ${REGION_KIND_LABELS_AR[region.kind] ?? 'منطقة'} في «${o.sourceTitle}» — ${where}`,
      before: { text: auditSnippet(region.text), text_origin: region.text_origin, status: region.status, confidence: region.confidence },
      after: {
        text: auditSnippet(text),
        text_origin: 'owner',
        status: 'owner_reviewed',
        correction_id: correctionId,
        alert_id: alert.id,
        ...(superseded ? { successor_region_id: currentId } : {}),
      },
    });
    const effects = [
      `حُفظ النص الذي كتبته لـ${REGION_KIND_LABELS_AR[region.kind] ?? 'المنطقة'} في ${where} (مصدره الآن: أنت). النص السابق كما استُخرج محفوظ في سجل التصحيحات ولم يُحذف.`,
    ];
    if (superseded) effects.push(SUPERSEDED_EFFECT_AR);
    if (parentId) effects.push('حُدّث الجدول الذي تنتمي إليه الخلية ليحمل النص المصحَّح.');
    if (closed) effects.push(`أُغلق ${closed === 1 ? 'عنصر مراجعة آخر' : `${closed} عناصر مراجعة أخرى`} عن المنطقة نفسها.`);
    effects.push(idx.inserted || idx.deleted ? 'حُدّث فهرس البحث لهذه النسخة ليجد النص المصحَّح.' : 'فهرس البحث لم يحتج تغييرًا.');
    if (pageReady) effects.push('لم تعد هذه الصفحة بحاجة إلى مراجعة.');
    effects.push(alertEffect(alert));
    return {
      effects_ar: effects,
      alertId: alert.id,
      alertCounts: alert.id ? { still_valid: alert.still_valid, needs_regeneration: alert.needs_regeneration, needs_review: alert.needs_review } : null,
      correctionId,
    };
  });
}

/** «accept»: the extracted text is right as it is. */
export function acceptRegion(ctx: AppContext, input: RegionDecisionInput): CorrectionOutcome {
  return ctx.db.tx(() => {
    const region = getRegion(ctx, input.regionId);
    if (!region) throw new AppError('NOT_FOUND', 'المنطقة المطلوبة لم تعد موجودة (ربما أُعيدت معالجة الصفحة).', 404);
    const o = owningOf(ctx, region.version_id);
    assertWritable(o);
    assertNotReplaced(ctx, region.id);
    const page = region.page_id ? getPage(ctx, region.page_id) : undefined;
    const correctionId = recordHistory(ctx, {
      region,
      regionId: region.id,
      pageId: region.page_id,
      o,
      itemId: input.itemId,
      action: 'accept',
      afterText: region.text,
      afterOrigin: region.text_origin,
      afterStatus: 'owner_reviewed',
      note: input.note,
    });
    ctx.db.run(`UPDATE source_region SET status = 'owner_reviewed', updated_at = ? WHERE id = ?`, [ctx.clock.now(), region.id]);
    settleParentTable(ctx, region);
    const closed = closeSiblingItems(ctx, region.id, input.itemId, 'accepted', 'أُغلق لأنك قبلت نص المنطقة نفسها.');
    const effects = [`أكّدتَ أن النص المستخرج صحيح كما هو؛ لم يتغير النص، وصار وسمه «راجعته شخصيًا».`];
    if (region.status === 'rejected') {
      reindex(ctx, o);
      effects.push('عاد النص إلى البحث والأدلة بعد أن كان مستبعدًا.');
    }
    if (closed) effects.push(`أُغلق ${closed === 1 ? 'عنصر مراجعة آخر' : `${closed} عناصر مراجعة أخرى`} عن المنطقة نفسها.`);
    if (refreshPageState(ctx, region.page_id)) effects.push('لم تعد هذه الصفحة بحاجة إلى مراجعة.');
    ctx.audit.record({
      entityType: 'source_region',
      entityId: region.id,
      action: 'accept',
      summary: `أكّدتَ نص ${REGION_KIND_LABELS_AR[region.kind] ?? 'منطقة'} في «${o.sourceTitle}»${page ? ` — ${pageLabelAr(page)}` : ''}`,
      before: { status: region.status },
      after: { status: 'owner_reviewed', correction_id: correctionId },
    });
    return { effects_ar: effects, alertId: null, alertCounts: null, correctionId };
  });
}

/** «reject»: the extracted text is not usable — excluded from search and evidence, kept for the record. */
export function rejectRegion(ctx: AppContext, input: RegionDecisionInput): CorrectionOutcome {
  return ctx.db.tx(() => {
    const region = getRegion(ctx, input.regionId);
    if (!region) throw new AppError('NOT_FOUND', 'المنطقة المطلوبة لم تعد موجودة (ربما أُعيدت معالجة الصفحة).', 404);
    const o = owningOf(ctx, region.version_id);
    assertWritable(o);
    assertNotReplaced(ctx, region.id);
    if (region.status === 'rejected') throw new AppError('CONFLICT', 'هذا النص مستبعد من قبل.', 409);
    const page = region.page_id ? getPage(ctx, region.page_id) : undefined;
    const correctionId = recordHistory(ctx, {
      region,
      regionId: region.id,
      pageId: region.page_id,
      o,
      itemId: input.itemId,
      action: 'reject',
      afterText: region.text,
      afterOrigin: region.text_origin,
      afterStatus: 'rejected',
      note: input.note,
    });
    ctx.db.run(`UPDATE source_region SET status = 'rejected', updated_at = ? WHERE id = ?`, [ctx.clock.now(), region.id]);
    settleParentTable(ctx, region);
    const closed = closeSiblingItems(ctx, region.id, input.itemId, 'rejected', 'أُغلق لأنك استبعدت نص المنطقة نفسها.');
    reindex(ctx, o);
    const pageReady = refreshPageState(ctx, region.page_id);
    const where = page ? pageLabelAr(page) : 'هذه المنطقة';
    const alert = alertFor(ctx, o, page, region.text_origin === 'ocr' ? 'ocr_corrected' : 'source_updated', `استبعدتَ نص ${REGION_KIND_LABELS_AR[region.kind] ?? 'منطقة'} في ${where} لأنه غير صالح؛ النص محفوظ في سجل التصحيحات.`);
    ctx.db.run('UPDATE control_region_correction SET alert_id = ? WHERE id = ?', [alert.id, correctionId]);
    ctx.audit.record({
      entityType: 'source_region',
      entityId: region.id,
      action: 'reject',
      summary: `استبعدتَ نص ${REGION_KIND_LABELS_AR[region.kind] ?? 'منطقة'} في «${o.sourceTitle}» — ${where}`,
      before: { status: region.status, text: auditSnippet(region.text) },
      after: { status: 'rejected', correction_id: correctionId, alert_id: alert.id },
    });
    const effects = [`استُبعد هذا النص من البحث ومن الأدلة الجديدة. لم يُحذف: يبقى محفوظًا ويمكنك تصحيحه لاحقًا.`];
    if (closed) effects.push(`أُغلق ${closed === 1 ? 'عنصر مراجعة آخر' : `${closed} عناصر مراجعة أخرى`} عن المنطقة نفسها.`);
    if (pageReady) effects.push('لم تعد هذه الصفحة بحاجة إلى مراجعة.');
    effects.push(alertEffect(alert));
    return {
      effects_ar: effects,
      alertId: alert.id,
      alertCounts: alert.id ? { still_valid: alert.still_valid, needs_regeneration: alert.needs_regeneration, needs_review: alert.needs_review } : null,
      correctionId,
    };
  });
}

/** The owner's transcription region of a page (created by «اكتب نص الصفحة»), if any. */
export function ownerTranscription(ctx: AppContext, pageId: string): RegionRow | undefined {
  return ctx.db.get<RegionRow>(
    `SELECT id, version_id, page_id, parent_region_id, kind, reading_order, text, text_origin, confidence, status, structure_json, locator_json
       FROM source_region WHERE page_id = ? AND text_origin = 'owner' AND status <> 'rejected' AND json_valid(locator_json) AND json_extract(locator_json, '$.owner_transcription') = 1
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [pageId],
  );
}

/** «correct» on an unreadable page: the owner types the page's text (one region without a box — no position is claimed). */
export function transcribePage(ctx: AppContext, input: { pageId: string; itemId: string | null; note: string | null; text: string }): CorrectionOutcome {
  const text = cleanOwnerText(input.text);
  return ctx.db.tx(() => {
    const page = getPage(ctx, input.pageId);
    if (!page) throw new AppError('NOT_FOUND', 'الصفحة غير موجودة.', 404);
    const o = owningOf(ctx, page.version_id);
    assertWritable(o);
    const now = ctx.clock.now();
    const existing = ownerTranscription(ctx, page.id);
    let regionId: string;
    if (existing) {
      if ((existing.text ?? '') === text) throw new AppError('CONFLICT', 'النص مطابق لما كتبته سابقًا لهذه الصفحة.', 409);
      regionId = existing.id;
    } else {
      regionId = newId(now);
    }
    const correctionId = recordHistory(ctx, {
      region: existing ?? null,
      regionId,
      pageId: page.id,
      o,
      itemId: input.itemId,
      action: existing ? 'correct' : 'owner_text',
      afterText: text,
      afterOrigin: 'owner',
      afterStatus: 'owner_reviewed',
      note: input.note,
    });
    // a cited transcription keeps its text (evidence contract): the new text becomes its successor
    const superseded = !!existing && isCited(ctx, existing.id);
    if (existing && superseded) {
      regionId = supersedeRegion(ctx, existing, { text, textOrigin: 'owner', status: 'owner_reviewed', confidence: null });
    } else if (existing) {
      ctx.db.run(`UPDATE source_region SET text = ?, updated_at = ? WHERE id = ?`, [text, now, regionId]);
    } else {
      const order = ctx.db.get<{ m: number | null }>('SELECT MAX(reading_order) AS m FROM source_region WHERE page_id = ?', [page.id])?.m ?? -1;
      ctx.db.run(
        `INSERT INTO source_region (id, version_id, page_id, parent_region_id, kind, reading_order, bbox_json, locator_json, text, text_origin, lang, confidence, structure_json, status, created_at, updated_at)
         VALUES (?, ?, ?, NULL, 'text_block', ?, NULL, ?, ?, 'owner', NULL, NULL, NULL, 'owner_reviewed', ?, ?)`,
        [regionId, page.version_id, page.id, order + 1, toJson({ owner_transcription: true }), text, now, now],
      );
    }
    const idx = reindex(ctx, o);
    const alert = alertFor(ctx, o, page, 'source_updated', `كتبتَ بنفسك نص ${pageLabelAr(page)} لأن النص لم يُقرأ آليًا.`);
    ctx.db.run('UPDATE control_region_correction SET alert_id = ? WHERE id = ?', [alert.id, correctionId]);
    ctx.audit.record({
      entityType: 'source_page',
      entityId: page.id,
      action: existing ? 'correct' : 'owner_text',
      summary: `${existing ? 'عدّلتَ' : 'كتبتَ'} نص ${pageLabelAr(page)} في «${o.sourceTitle}» بنفسك`,
      before: existing ? { text: auditSnippet(existing.text) } : { text_status: page.text_status },
      after: { text: auditSnippet(text), region_id: regionId, correction_id: correctionId },
    });
    const effects = [
      `حُفظ النص الذي كتبته لـ${pageLabelAr(page)} كنص مصدره أنت (لا يُدّعى أنه قُرئ آليًا، ولا يُحدَّد له موضع على الصفحة).`,
      idx.inserted || idx.deleted ? 'صار نص الصفحة قابلًا للبحث والاستشهاد به.' : 'فهرس البحث لم يحتج تغييرًا.',
    ];
    if (existing) effects.push('النص السابق الذي كتبته محفوظ في سجل التصحيحات.');
    if (superseded) effects.push(SUPERSEDED_EFFECT_AR);
    effects.push(alertEffect(alert));
    return {
      effects_ar: effects,
      alertId: alert.id,
      alertCounts: alert.id ? { still_valid: alert.still_valid, needs_regeneration: alert.needs_regeneration, needs_review: alert.needs_review } : null,
      correctionId,
    };
  });
}

/** Remove history rows whose source no longer exists (a permanent delete must not leave its text behind here). */
export function pruneOrphanHistory(ctx: AppContext): number {
  return ctx.db.run(`DELETE FROM control_region_correction WHERE source_id NOT IN (SELECT id FROM source)`).changes;
}
