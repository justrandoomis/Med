// «انقل ملاحظاتي إلى الإصدار الجديد» — copy, NEVER move (Academic OS P1-T2 step 3; ARCHITECTURE_DELTA §6.3; BUILD_PLAN
// §3.4 step 3; PRD AOS-3.13, 4.17, 4.20, Q35; Scenario 4, the note side, inside one vault).
//
//  * The page map is P1-T3's (`modules/versions/pagemap.ts`, contract in `packages/shared/src/academic/versions.ts`):
//    an item of an old page may be copied to `entry.to_page_id` only when `isCopyTarget(entry)`; ink, shapes, text boxes,
//    stickies, pictures and links (coordinate-anchored) also need `layout_safe` or a page the owner confirmed; a text
//    highlight needs its quote found again on the new page (same rectangles on an identical layout, or rectangles
//    re-derived from an identical paragraph that moved); a bookmark or a page note needs the page only.
//  * Everything else is listed «تحتاج مراجعة» with the old place and the map's candidate page — never guessed. The owner
//    copies it to a page they pick (Round 7's re-anchoring route `POST /api/annotations/reanchor`, reused AS A COPY) or
//    keeps it on the earlier version.
//  * Invariants (test/annotations/reanchor-copy.test.ts): the original row is never changed; a copy has a deterministic
//    id (`reanchorCopyId(old_id, to_version_id)`, so retries and a second device never duplicate), `migrated_from_id`,
//    `previous_anchor_json` = the old anchor, `anchor_status = 'reanchored'`, `origin = 'reanchor_copy'` and the SAME
//    layer; items of a read-only layer (a followed copy) are never re-anchored by the follower; the preview writes
//    nothing; a second run copies nothing; undo tombstones the run's copies only (a copy changed since is kept), and a
//    later run revives the same ids; a copy the owner erased is never revived; total = moved + needs review + kept.
//  * A run is one transaction. Bookkeeping lives in `reanchor_copy_run` / `reanchor_copy_item` / `reanchor_copy_decision`
//    (migration 0274); the copies are ordinary rows in the sync feed, so every device receives them.
import { createHash } from 'node:crypto';
import {
  annotationTargetKey,
  isCopyTarget,
  itemsCountAr,
  pagesCountAr,
  REANCHOR_KEPT_REASONS_AR,
  REANCHOR_REVIEW_REASONS_AR,
  richTextToPlain,
  type AnnotationAnchor,
  type AnnotationDTO,
  type NormBox,
  type NoteDTO,
  type PageMapEntry,
  type ReanchorCopyActionResponse,
  type ReanchorCopyPreview,
  type ReanchorCopyReport,
  type ReanchorCopyRunResponse,
  type ReanchorKeptReason,
  type ReanchorPageRef,
  type ReanchorReviewItem,
  type ReanchorReviewReason,
  type ReanchorVersionRef,
  type RichText,
  type TextQuote,
  type VersionPageMap,
  reanchorCopyActionSchema,
  reanchorCopyRunSchema,
} from '@medlevo/shared';
import type { z } from 'zod';
import type { AppContext } from '../../context';
import { fromJson, toJson } from '../../db/db';
import { AppError } from '../../lib/errors';
import { newId } from '../../lib/ids';
import { fingerprintsComplete, VERSION_ANALYSIS_JOB } from '../processing/fingerprint';
import { pageLabelKnown, versionIsNumbered } from '../sources/pagelabel';
import { requestAnalysis } from '../versions/compare';
import { computeAndStorePageMap, pageMapIsCurrent, readPageMap } from '../versions/pagemap';
import { recordAnnotationRevision, recordNoteRevision } from './history';
import { checkExistingItem } from './layers';
import { bboxOf, boxOf, translateData } from './reanchor';
import { getAnnotation, getNote, indexNote, toAnnotationDTO, toNoteDTO, writeAnnotationTarget, type AnnotationRow, type NoteRow } from './repo';

type RunBody = z.output<typeof reanchorCopyRunSchema>;
type ActionBody = z.output<typeof reanchorCopyActionSchema>;
type PageAnchor = Extract<AnnotationAnchor, { type: 'page' }>;

/** the review list is bounded (the counts never are) */
const REVIEW_LIMIT = 500;

// ───────────────────────────── pure parts ─────────────────────────────
/** Deterministic id of the copy of `oldId` on `toVersionId` (retries and a second device find it again). */
export function reanchorCopyId(oldId: string, toVersionId: string): string {
  return `rc_${createHash('sha256').update(`reanchor_copy|${oldId}|${toVersionId}`).digest('hex').slice(0, 26)}`;
}

/** coordinate-anchored kinds: copied only onto the same layout (or a page the owner confirmed) */
const COORDINATE_KINDS = new Set(['ink', 'highlight', 'underline', 'shape', 'text', 'sticky', 'image', 'link']);

export type ItemPlan =
  | { action: 'copy'; to_page_id: string; to_page_index: number; rects?: NormBox[] }
  | { action: 'review'; reason: ReanchorReviewReason; suggested_page_id: string | null };

/**
 * What may happen to one item of an old page, from its page-map entry (pure). `hl` is for text highlights only: was the
 * quote found on the new page, and — when the layout changed — the rectangles re-derived from the new page (or null).
 */
export function planItem(kind: string, e: PageMapEntry | undefined, hl: { found: boolean; rects: NormBox[] | null } | null): ItemPlan {
  if (!e || !e.to_page_id || e.to_page_index === null || e.status === 'none' || e.status === 'rejected') return { action: 'review', reason: 'page_removed', suggested_page_id: null };
  if (!isCopyTarget(e)) {
    const reason: ReanchorReviewReason = e.change === 'moved' ? 'page_moved' : e.change === 'changed' ? 'page_changed' : 'page_uncertain';
    return { action: 'review', reason, suggested_page_id: e.to_page_id };
  }
  const copy = { action: 'copy' as const, to_page_id: e.to_page_id, to_page_index: e.to_page_index };
  const layoutReview = { action: 'review' as const, reason: 'layout_changed' as const, suggested_page_id: e.to_page_id };
  if (kind === 'note' || kind === 'bookmark') return copy;
  if (kind === 'text_highlight') {
    if (!hl?.found) return { action: 'review', reason: 'quote_not_found', suggested_page_id: e.to_page_id };
    if (e.layout_safe) return copy;
    return hl.rects ? { ...copy, rects: hl.rects } : layoutReview;
  }
  // coordinate kinds (and any kind added later): the same normalised coordinates are right only on the same layout
  return e.layout_safe || e.status === 'confirmed' ? copy : layoutReview;
}

/** letters only: whitespace, bidi / zero-width marks and tatweel never decide a match; NFKC folds presentation forms */
const normQuote = (s: string) =>
  s
    .normalize('NFKC')
    .replace(/[\s\u0640\u200b-\u200f\u202a-\u202e\u2066-\u2069]+/g, '')
    .toLowerCase();

/**
 * Is the quote on the page text? Matching is by letters (spacing and line breaks ignored). By default a quote that occurs
 * more than once must be told apart by its prefix / suffix; `anyOccurrence` accepts any (the rectangles then come from an
 * identical layout, so the place is already known).
 */
export function quoteFoundIn(text: string, quote: TextQuote | null | undefined, opts: { anyOccurrence?: boolean } = {}): boolean {
  const exact = normQuote(quote?.exact ?? '');
  if (!exact) return false;
  const hay = normQuote(text);
  const hits: number[] = [];
  for (let i = hay.indexOf(exact); i >= 0 && hits.length < 50; i = hay.indexOf(exact, i + 1)) hits.push(i);
  if (hits.length === 0) return false;
  if (hits.length === 1 || opts.anyOccurrence) return true;
  const pre = normQuote(quote?.prefix ?? '');
  const suf = normQuote(quote?.suffix ?? '');
  if (!pre && !suf) return false;
  return hits.some((h) => (!pre || hay.slice(Math.max(0, h - pre.length), h) === pre) && (!suf || hay.slice(h + exact.length, h + exact.length + suf.length) === suf));
}

interface RegionGeo {
  text: string;
  box: NormBox | null;
}

const SAME_SIZE = 0.003;
/**
 * Rectangles of a highlight moved with their paragraph: each rectangle sits in an old region whose text is found, once,
 * as an identical region of the same size on the new page → translated by that region's offset. Anything else → null.
 */
export function translateRects(rects: NormBox[], oldRegions: RegionGeo[], newRegions: RegionGeo[]): NormBox[] | null {
  const out: NormBox[] = [];
  for (const r of rects) {
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    const old = oldRegions.find((g) => g.box && cx >= g.box.x && cx <= g.box.x + g.box.w && cy >= g.box.y && cy <= g.box.y + g.box.h);
    if (!old?.box) return null;
    const key = normQuote(old.text);
    if (!key) return null;
    const same = newRegions.filter((g) => g.box && normQuote(g.text) === key && Math.abs(g.box.w - old.box!.w) <= SAME_SIZE && Math.abs(g.box.h - old.box!.h) <= SAME_SIZE);
    if (same.length !== 1) return null;
    const dx = same[0]!.box!.x - old.box.x;
    const dy = same[0]!.box!.y - old.box.y;
    out.push({ ...r, x: Math.round((r.x + dx) * 1e5) / 1e5, y: Math.round((r.y + dy) * 1e5) / 1e5 });
  }
  return out.length ? out : null;
}

// ───────────────────────────── reading the vault ─────────────────────────────
interface VersionRow {
  id: string;
  source_id: string;
  version_no: number;
  format: string;
  display_file_id: string | null;
  processing_status: string;
}

const versionRef = (v: VersionRow): ReanchorVersionRef => ({ id: v.id, version_no: v.version_no });

function getVersion(ctx: AppContext, id: string): VersionRow | undefined {
  return ctx.db.get<VersionRow>('SELECT id, source_id, version_no, format, display_file_id, processing_status FROM source_version WHERE id = ?', [id]);
}

function versionsOf(ctx: AppContext, sourceId: string): VersionRow[] {
  return ctx.db.all<VersionRow>('SELECT id, source_id, version_no, format, display_file_id, processing_status FROM source_version WHERE source_id = ? ORDER BY version_no', [sourceId]);
}

interface PageRow {
  id: string;
  page_index: number;
  printed_label: string | null;
  kind: string;
  render_file_id: string | null;
}

/** page refs of one version (labels the way every other screen writes them, AC-04) */
class Pages {
  private cache = new Map<string, Map<string, ReanchorPageRef>>();
  constructor(private ctx: AppContext) {}
  of(v: VersionRow): Map<string, ReanchorPageRef> {
    let m = this.cache.get(v.id);
    if (m) return m;
    const numbered = versionIsNumbered(this.ctx.db, v.id);
    const renderable = v.format === 'pdf' || !!v.display_file_id;
    m = new Map(
      this.ctx.db
        .all<PageRow>('SELECT id, page_index, printed_label, kind, render_file_id FROM source_page WHERE version_id = ? ORDER BY page_index', [v.id])
        .map((p) => [
          p.id,
          {
            page_id: p.id,
            page_index: p.page_index,
            label_ar: pageLabelKnown({ page_index: p.page_index, printed_label: p.printed_label, kind: p.kind, numbered_version: numbered }),
            thumbnail: !!p.render_file_id || (renderable && (p.kind === 'page' || p.kind === 'slide')),
          },
        ]),
    );
    this.cache.set(v.id, m);
    return m;
  }
}

interface Item {
  type: 'annotation' | 'note';
  row: AnnotationRow | NoteRow;
  /** the annotation kind, or 'note' */
  kind: string;
  anchor: PageAnchor;
}

/** Live personal items anchored to a page of `versionId` (annotations through annotation_target, notes by target key). */
function itemsOn(ctx: AppContext, versionId: string): Item[] {
  const out: Item[] = [];
  const onVersion = (a: AnnotationAnchor | null): a is PageAnchor => a?.type === 'page' && a.version_id === versionId;
  for (const r of ctx.db.all<AnnotationRow>(
    `SELECT a.* FROM annotation_target t JOIN annotation a ON a.id = t.annotation_id
      WHERE t.target_type = 'source_page' AND t.target_id IN (SELECT id FROM source_page WHERE version_id = ?) AND a.deleted_at IS NULL
      ORDER BY a.created_at, a.id`,
    [versionId],
  )) {
    const anchor = fromJson<AnnotationAnchor>(r.anchor_json);
    if (onVersion(anchor)) out.push({ type: 'annotation', row: r, kind: r.kind, anchor });
  }
  for (const r of ctx.db.all<NoteRow>(
    `SELECT n.* FROM note n WHERE n.deleted_at IS NULL AND n.anchor_target_key IN (SELECT 'source_page:' || id FROM source_page WHERE version_id = ?) ORDER BY n.created_at, n.id`,
    [versionId],
  )) {
    const anchor = r.anchor_json ? fromJson<AnnotationAnchor>(r.anchor_json) : null;
    if (onVersion(anchor)) out.push({ type: 'note', row: r, kind: 'note', anchor });
  }
  return out;
}

const keyOf = (type: string, id: string) => `${type}:${id}`;

/** originals already carried forward by a run or a review copy of this lecture (and not undone) */
function carriedOf(ctx: AppContext, sourceId: string): Set<string> {
  return new Set(
    ctx.db
      .all<{ entity_type: string; from_id: string }>(
        `SELECT i.entity_type, i.from_id FROM reanchor_copy_item i JOIN reanchor_copy_run r ON r.id = i.run_id WHERE r.source_id = ? AND i.undone_at IS NULL`,
        [sourceId],
      )
      .map((r) => keyOf(r.entity_type, r.from_id)),
  );
}

function decidedOf(ctx: AppContext, toVersionId: string): Set<string> {
  return new Set(ctx.db.all<{ entity_type: string; entity_id: string }>('SELECT entity_type, entity_id FROM reanchor_copy_decision WHERE to_version_id = ?', [toVersionId]).map((r) => keyOf(r.entity_type, r.entity_id)));
}

/**
 * (review 2026-10-21) The items (keys `type:id`) whose copy on `toVersionId` is alive although no run may carry it:
 * after an undo, a device's queued edit of the copy brings it back (sync «merged»: an edit concurrent with a delete is
 * kept). That copy is the owner's now — carried forward, never written over by a later tap or review copy. One query
 * per 400 ids (the deterministic copy ids are primary keys).
 */
function liveCopiesOf(ctx: AppContext, items: ReadonlyArray<Pick<Item, 'type' | 'row'>>, toVersionId: string): Set<string> {
  const out = new Set<string>();
  for (const type of ['annotation', 'note'] as const) {
    const byCopy = new Map(items.filter((i) => i.type === type).map((i) => [reanchorCopyId(i.row.id, toVersionId), keyOf(type, i.row.id)]));
    const ids = [...byCopy.keys()];
    for (let i = 0; i < ids.length; i += 400) {
      const chunk = ids.slice(i, i + 400);
      for (const r of ctx.db.all<{ id: string }>(`SELECT id FROM ${type} WHERE deleted_at IS NULL AND id IN (${chunk.map(() => '?').join(',')})`, chunk)) out.add(byCopy.get(r.id)!);
    }
  }
  return out;
}

/** text and geometry of a page's regions (for quotes and moved paragraphs) */
function regionsOf(ctx: AppContext, pageId: string): RegionGeo[] {
  return ctx.db
    .all<{ text: string | null; bbox_json: string | null }>(`SELECT text, bbox_json FROM source_region WHERE page_id = ? AND status <> 'rejected' ORDER BY reading_order`, [pageId])
    .map((r) => ({ text: r.text ?? '', box: boxOf(fromJson(r.bbox_json)) }));
}

// ───────────────────────────── the page map ─────────────────────────────
type MapState = { state: 'ready'; map: VersionPageMap } | { state: 'pending' | 'failed'; reason_ar: string };

function latestAnalysisStatus(ctx: AppContext, versionId: string): string | null {
  return (
    ctx.db.get<{ status: string }>(`SELECT status FROM processing_job WHERE kind = ? AND json_extract(input_json, '$.version_id') = ? ORDER BY created_at DESC, id DESC LIMIT 1`, [VERSION_ANALYSIS_JOB, versionId])?.status ??
    null
  );
}

/** The map between the two versions; never renders on the request (an analysis job is queued when fingerprints are missing). */
function mapBetween(ctx: AppContext, from: VersionRow, to: VersionRow): MapState {
  for (const v of [from, to]) {
    if (fingerprintsComplete(ctx, v.id)) continue;
    if (v.processing_status === 'pending' || v.processing_status === 'processing') return { state: 'pending', reason_ar: `يُعالَج الإصدار ${v.version_no} الآن؛ تظهر معاينة النقل عند انتهائه.` };
    if (v.processing_status === 'failed') return { state: 'failed', reason_ar: `تعذّرت معالجة الإصدار ${v.version_no}؛ أعد معالجته من صفحة المصدر ثم حاول مجددًا. لم يُنقل شيء.` };
    const st = latestAnalysisStatus(ctx, v.id);
    if (st === 'failed') return { state: 'failed', reason_ar: `تعذّر تحليل صفحات الإصدار ${v.version_no}؛ أعد معالجته ثم حاول مجددًا. لم يُنقل شيء.` };
    if (st !== 'queued' && st !== 'running' && !requestAnalysis(ctx, v.id, 'reanchor_copy')) {
      return { state: 'failed', reason_ar: 'مطابقة الصفحات بين الإصدارين غير متاحة على هذا الخادم؛ لم يُنقل شيء.' };
    }
    return { state: 'pending', reason_ar: 'يجري تحليل صفحات الإصدارين (بصمة كل صفحة) لمعرفة ما يطابق ماذا؛ تظهر معاينة النقل عند انتهائه.' };
  }
  const map = pageMapIsCurrent(ctx, from.id, to.id) ? readPageMap(ctx, from.id, to.id)! : computeAndStorePageMap(ctx, from.id, to.id);
  return { state: 'ready', map };
}

// ───────────────────────────── the plan ─────────────────────────────
interface Planned {
  item: Item;
  status: 'carried' | 'copy' | 'review' | 'kept';
  keptReason?: ReanchorKeptReason;
  plan?: ItemPlan;
}

function writable(ctx: AppContext, it: Item): boolean {
  return checkExistingItem(ctx.db, it.row, null).ok;
}

function planAll(ctx: AppContext, from: VersionRow, to: VersionRow, items: Item[], map: VersionPageMap | null): Planned[] {
  const carried = carriedOf(ctx, from.source_id);
  const decided = decidedOf(ctx, to.id);
  const live = liveCopiesOf(ctx, items, to.id);
  const byFrom = new Map((map?.entries ?? []).map((e) => [e.from_page_id, e]));
  const regions = new Map<string, RegionGeo[]>();
  const regionsCached = (pageId: string) => {
    let r = regions.get(pageId);
    if (!r) regions.set(pageId, (r = regionsOf(ctx, pageId)));
    return r;
  };
  return items.map((item): Planned => {
    const k = keyOf(item.type, item.row.id);
    if (carried.has(k) || live.has(k)) return { item, status: 'carried' };
    if (decided.has(k)) return { item, status: 'kept', keptReason: 'owner_choice' };
    // R5: an item of a read-only layer (a followed copy) follows its author's republish, never the follower's re-anchor
    if (!writable(ctx, item)) return { item, status: 'kept', keptReason: 'read_only_layer' };
    if (!map) return { item, status: 'review' };
    const e = byFrom.get(item.anchor.page_id);
    let hl: { found: boolean; rects: NormBox[] | null } | null = null;
    if (item.kind === 'text_highlight' && e && e.to_page_id && isCopyTarget(e)) {
      const data = fromJson<{ quote?: TextQuote; rects?: unknown[] }>((item.row as AnnotationRow).data_json) ?? {};
      const newRegions = regionsCached(e.to_page_id);
      const found = quoteFoundIn(newRegions.map((r) => r.text).join('\n'), data.quote, { anyOccurrence: e.layout_safe });
      const rects = (Array.isArray(data.rects) ? data.rects : []).map(boxOf).filter((b): b is NormBox => !!b);
      hl = { found, rects: found && !e.layout_safe && rects.length ? translateRects(rects, regionsCached(item.anchor.page_id), newRegions) : null };
    }
    const plan = planItem(item.kind, e, hl);
    return { item, status: plan.action === 'copy' ? 'copy' : 'review', plan };
  });
}

interface Tally {
  total: number;
  copy: number;
  already_moved: number;
  needs_review: number;
  kept: number;
}
function tallyOf(plan: Planned[]): Tally {
  const t: Tally = { total: plan.length, copy: 0, already_moved: 0, needs_review: 0, kept: 0 };
  for (const p of plan) {
    if (p.status === 'copy') t.copy++;
    else if (p.status === 'carried') t.already_moved++;
    else if (p.status === 'review') t.needs_review++;
    else t.kept++;
  }
  return t;
}

// ───────────────────────────── wording ─────────────────────────────
const KIND_LABEL_AR: Record<string, string> = {
  ink: 'كتابة بالقلم',
  highlight: 'تظليل بالقلم',
  underline: 'تسطير بالقلم',
  shape: 'شكل',
  text: 'مربع نص',
  sticky: 'ملاحظة لاصقة',
  image: 'صورة',
  link: 'رابط صفحة',
  bookmark: 'علامة',
  text_highlight: 'تظليل نص',
  note: 'ملاحظة',
};

function plainOf(body: unknown): string {
  try {
    return richTextToPlain(body as RichText)
      .replace(/\s+/g, ' ')
      .trim();
  } catch {
    return '';
  }
}

function previewOf(it: Item): string | null {
  if (it.type === 'note') {
    const n = it.row as NoteRow;
    const text = (n.title?.trim() || plainOf(fromJson(n.body_json))).slice(0, 120);
    return text || null;
  }
  const d = fromJson<Record<string, unknown>>((it.row as AnnotationRow).data_json) ?? {};
  if (it.kind === 'text_highlight') return (d.quote as TextQuote | undefined)?.exact?.slice(0, 120) || null;
  if (it.kind === 'sticky') return typeof d.text === 'string' ? d.text.slice(0, 120) || null : null;
  if (it.kind === 'text') return plainOf(d.text).slice(0, 120) || null;
  return null;
}

function reviewPart(n: number): string {
  if (n === 0) return 'لا شيء يحتاج مراجعتك';
  if (n === 1) return 'عنصر واحد يحتاج مراجعتك';
  if (n === 2) return 'عنصران يحتاجان مراجعتك';
  return `${itemsCountAr(n)} تحتاج مراجعتك`;
}
function keptPart(n: number): string {
  if (n === 0) return 'لا شيء بقي على الإصدار السابق';
  if (n === 1) return 'عنصر واحد بقي على الإصدار السابق';
  if (n === 2) return 'عنصران بقيا على الإصدار السابق';
  return `${itemsCountAr(n)} بقيت على الإصدار السابق`;
}

/** «نُقل 41 عنصرًا إلى 12 صفحة؛ 6 تحتاج مراجعتك؛ 3 بقيت على الإصدار السابق» */
export function reportSummaryAr(c: { copied: number; pages: number; needs_review: number; kept: number; already_moved: number }): string {
  const moved = c.copied > 0 ? `نُقل ${itemsCountAr(c.copied)} إلى ${pagesCountAr(c.pages)}` : c.already_moved > 0 ? `لم يُنقل شيء جديد (${itemsCountAr(c.already_moved)} نُقل من قبل)` : 'لم يُنقل شيء';
  return `${moved}؛ ${reviewPart(c.needs_review)}؛ ${keptPart(c.kept)}`;
}

// ───────────────────────────── runs and reports ─────────────────────────────
interface RunRow {
  id: string;
  source_id: string;
  from_version_id: string;
  to_version_id: string;
  kind: 'run' | 'manual';
  algo: string | null;
  counts_json: string;
  device_id: string | null;
  created_at: number;
  undone_at: number | null;
  undo_json: string | null;
}
interface RunCounts extends Omit<Tally, 'copy'> {
  copied: number;
  by_page: Array<{ page_id: string; items: number }>;
}

function reportOf(ctx: AppContext, r: RunRow, pages = new Pages(ctx)): ReanchorCopyReport {
  const c = fromJson<RunCounts>(r.counts_json)!;
  const from = getVersion(ctx, r.from_version_id);
  const to = getVersion(ctx, r.to_version_id);
  const toPages = to ? pages.of(to) : new Map<string, ReanchorPageRef>();
  const byPage = c.by_page.map((b) => ({ page: toPages.get(b.page_id) ?? { page_id: b.page_id, page_index: -1, label_ar: 'صفحة لم تعد موجودة', thumbnail: false }, items: b.items }));
  return {
    id: r.id,
    source_id: r.source_id,
    kind: r.kind,
    from_version: from ? versionRef(from) : { id: r.from_version_id, version_no: 0 },
    to_version: to ? versionRef(to) : { id: r.to_version_id, version_no: 0 },
    total: c.total,
    copied: c.copied,
    already_moved: c.already_moved,
    needs_review: c.needs_review,
    kept: c.kept,
    pages: byPage.length,
    by_page: byPage,
    summary_ar: reportSummaryAr({ ...c, pages: byPage.length }),
    created_at: r.created_at,
    undone_at: r.undone_at,
    undo: r.undo_json ? fromJson<{ tombstoned: number; kept_edited: number }>(r.undo_json) : null,
  };
}

function lastRun(ctx: AppContext, sourceId: string, fromId: string, toId: string): RunRow | undefined {
  return ctx.db.get<RunRow>(`SELECT * FROM reanchor_copy_run WHERE source_id = ? AND from_version_id = ? AND to_version_id = ? AND kind = 'run' ORDER BY created_at DESC, id DESC LIMIT 1`, [sourceId, fromId, toId]);
}

// ───────────────────────────── writing one copy ─────────────────────────────
interface CopyTx {
  ctx: AppContext;
  now: number;
  device: string;
  runId: string;
  to: VersionRow;
}

/** the copy's attribution: the original's chain plus this hop (own items without attribution get none) */
function copyAttribution(c: CopyTx, type: 'annotation' | 'note', fromId: string, copyId: string, documentKey: string): void {
  const prev = c.ctx.db.get<{ author_user_id: string; author_display: string; derived_from_json: string }>('SELECT author_user_id, author_display, derived_from_json FROM attribution WHERE entity_type = ? AND entity_id = ?', [type, fromId]);
  if (!prev) return;
  const chain = [...(fromJson<Array<Record<string, unknown>>>(prev.derived_from_json) ?? []), { space_id: null, publication_id: null, version_no: c.to.version_no, item_id: fromId, document_key: documentKey }];
  c.ctx.db.run(
    `INSERT INTO attribution (entity_type, entity_id, author_user_id, author_display, derived_from_json, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(entity_type, entity_id) DO UPDATE SET derived_from_json = excluded.derived_from_json`,
    [type, copyId, prev.author_user_id, prev.author_display, toJson(chain), c.now],
  );
}

/** Writes (or revives after an undo) the copy of `it` at `anchor` with `data` (annotations). Returns its id and rev. */
function writeCopy(c: CopyTx, it: Item, anchor: PageAnchor, data: Record<string, unknown> | null): { id: string; rev: number } {
  const db = c.ctx.db;
  const id = reanchorCopyId(it.row.id, c.to.id);
  const rtx = { db, now: c.now, deviceId: c.device };
  // (review) only an undone copy (a tombstone) is ever revived; a live row under this id is the owner's — never written
  // over (the planner counts it carried; this guard keeps the whole transaction from overwriting it if it ever got here)
  const live = (it.type === 'annotation' ? getAnnotation(db, id) : getNote(db, id))?.deleted_at === null;
  if (live) throw new AppError('CONFLICT', 'هذا العنصر منسوخ إلى الإصدار الجديد من قبل؛ لم يُنسخ فوق نسختك. حدّث القائمة.', 409, { id: it.row.id });
  if (it.type === 'annotation') {
    const r = it.row as AnnotationRow;
    const dataJson = data ? toJson(data) : r.data_json;
    const existing = getAnnotation(db, id);
    if (!existing) {
      db.run(
        `INSERT INTO annotation (id, kind, tool, anchor_json, data_json, layer, z, locked, anchor_status, previous_anchor_json, input_json, device_id, rev, created_at, updated_at, deleted_at,
                                 conflict_of_id, layer_id, author_user_id, migrated_from_id, origin)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'reanchored', ?, ?, ?, 1, ?, ?, NULL, NULL, ?, ?, ?, 'reanchor_copy')`,
        [id, r.kind, r.tool, toJson(anchor), dataJson, r.layer, r.z, r.locked, r.anchor_json, r.input_json, c.device, c.now, c.now, r.layer_id ?? null, r.author_user_id ?? null, r.id],
      );
    } else {
      // an undone copy (tombstoned by the undo) comes back under the same id, from the original as it is now
      recordAnnotationRevision(rtx, existing as unknown as Record<string, unknown> & AnnotationRow, 'restore', null);
      db.run(
        `UPDATE annotation SET kind = ?, tool = ?, anchor_json = ?, data_json = ?, layer = ?, z = ?, locked = ?, anchor_status = 'reanchored', previous_anchor_json = ?, input_json = ?,
                               layer_id = ?, author_user_id = ?, migrated_from_id = ?, deleted_at = NULL, detached_at = NULL, device_id = ?, rev = rev + 1, updated_at = ?
          WHERE id = ?`,
        [r.kind, r.tool, toJson(anchor), dataJson, r.layer, r.z, r.locked, r.anchor_json, r.input_json, r.layer_id ?? null, r.author_user_id ?? null, r.id, c.device, c.now, id],
      );
    }
    writeAnnotationTarget(db, id, anchor);
    if (r.kind === 'image') {
      const key = (fromJson<{ image_key?: string }>(dataJson) ?? {}).image_key;
      if (key) db.run('UPDATE annotation_image SET referenced = 1, released_at = NULL WHERE image_key = ?', [key]);
    }
    c.ctx.sync.touch('annotation', id);
  } else {
    const r = it.row as NoteRow;
    const existing = getNote(db, id);
    const sourceId = anchor.source_id;
    if (!existing) {
      db.run(
        `INSERT INTO note (id, node_id, title, body_json, anchor_json, origin, ai_record_json, rev, base_rev, conflict_of_id, device_id, created_at, updated_at, deleted_at,
                           source_id, anchor_target_key, layer_id, author_user_id, migrated_from_id, previous_anchor_json, detached_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL, NULL, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, NULL)`,
        [id, r.node_id, r.title, r.body_json, toJson(anchor), r.origin, r.ai_record_json, c.device, c.now, c.now, sourceId, annotationTargetKey(anchor), r.layer_id ?? null, r.author_user_id ?? null, r.id, r.anchor_json],
      );
    } else {
      recordNoteRevision(rtx, existing as unknown as Record<string, unknown> & NoteRow, 'restore', null);
      db.run(
        `UPDATE note SET node_id = ?, title = ?, body_json = ?, anchor_json = ?, origin = ?, ai_record_json = ?, source_id = ?, anchor_target_key = ?, layer_id = ?, author_user_id = ?,
                         migrated_from_id = ?, previous_anchor_json = ?, deleted_at = NULL, detached_at = NULL, device_id = ?, rev = rev + 1, updated_at = ?
          WHERE id = ?`,
        [r.node_id, r.title, r.body_json, toJson(anchor), r.origin, r.ai_record_json, sourceId, annotationTargetKey(anchor), r.layer_id ?? null, r.author_user_id ?? null, r.id, r.anchor_json, c.device, c.now, id],
      );
    }
    indexNote(db, { id, title: r.title, body: fromJson<RichText>(r.body_json) ?? { v: 1, paragraphs: [] }, origin: r.origin, deleted: false });
    c.ctx.sync.touch('note', id);
  }
  copyAttribution(c, it.type, it.row.id, id, `source:${anchor.source_id}`);
  const rev = (it.type === 'annotation' ? getAnnotation(db, id) : getNote(db, id))!.rev;
  db.run(
    `INSERT INTO reanchor_copy_item (entity_type, copy_id, run_id, from_id, to_version_id, to_page_id, copy_rev, created_at, undone_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(entity_type, copy_id) DO UPDATE SET run_id = excluded.run_id, from_id = excluded.from_id, to_version_id = excluded.to_version_id, to_page_id = excluded.to_page_id,
       copy_rev = excluded.copy_rev, created_at = excluded.created_at, undone_at = NULL`,
    [it.type, id, c.runId, it.row.id, c.to.id, anchor.page_id, rev, c.now],
  );
  return { id, rev };
}

function pageAnchorOn(to: VersionRow, page: { page_id: string; page_index: number }): PageAnchor {
  return { type: 'page', source_id: to.source_id, version_id: to.id, page_id: page.page_id, page_index: page.page_index, space: 'page_norm' };
}

function insertRun(ctx: AppContext, r: Omit<RunRow, 'undone_at' | 'undo_json'>): void {
  ctx.db.run(
    `INSERT INTO reanchor_copy_run (id, source_id, from_version_id, to_version_id, kind, algo, counts_json, device_id, created_at, undone_at, undo_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    [r.id, r.source_id, r.from_version_id, r.to_version_id, r.kind, r.algo, r.counts_json, r.device_id, r.created_at],
  );
}

// ───────────────────────────── the versions of a request ─────────────────────────────
function sourceOrThrow(ctx: AppContext, sourceId: string): void {
  if (!ctx.db.get('SELECT 1 AS x FROM source WHERE id = ?', [sourceId])) throw new AppError('NOT_FOUND', 'المصدر غير موجود.', 404);
}

function versionOf(ctx: AppContext, sourceId: string, id: string): VersionRow {
  const v = getVersion(ctx, id);
  if (!v || v.source_id !== sourceId) throw new AppError('NOT_FOUND', 'الإصدار غير موجود في هذا المصدر.', 404);
  return v;
}

function checkPair(from: VersionRow, to: VersionRow): void {
  if (from.id === to.id) throw new AppError('VALIDATION_FAILED', 'اختر إصدارين مختلفين: الملاحظات تُنسخ من إصدار سابق إلى إصدار أحدث.', 400);
  if (from.version_no > to.version_no) throw new AppError('VALIDATION_FAILED', 'تُنسخ الملاحظات من إصدار سابق إلى إصدار أحدث فقط.', 400);
}

// ───────────────────────────── preview ─────────────────────────────
export function previewReanchorCopy(ctx: AppContext, q: { source_id: string; from_version_id?: string; to_version_id?: string }): ReanchorCopyPreview {
  sourceOrThrow(ctx, q.source_id);
  const versions = versionsOf(ctx, q.source_id);
  const to = q.to_version_id ? versionOf(ctx, q.source_id, q.to_version_id) : versions[versions.length - 1];
  if (!to) throw new AppError('NOT_FOUND', 'لا يوجد إصدار لهذا المصدر.', 404);
  const carried = carriedOf(ctx, q.source_id);
  const decided = decidedOf(ctx, to.id);
  const earlierItems = versions
    .filter((v) => v.version_no < to.version_no)
    .map((v) => {
      const items = itemsOn(ctx, v.id);
      // waiting = what a tap or the review list can still carry (never a carried, kept or read-only item)
      const live = liveCopiesOf(ctx, items, to.id);
      const waiting = (it: Item) => !carried.has(keyOf(it.type, it.row.id)) && !live.has(keyOf(it.type, it.row.id)) && !decided.has(keyOf(it.type, it.row.id)) && writable(ctx, it);
      const pending = items.filter(waiting).length;
      return { v, items, pending };
    })
    .filter((e) => e.items.length > 0);
  const earlier = earlierItems.map((e) => ({ version: versionRef(e.v), items: e.items.length, pending: e.pending }));
  let fromEntry = q.from_version_id ? null : ([...earlierItems].reverse().find((e) => e.pending > 0) ?? earlierItems[earlierItems.length - 1] ?? null);
  if (q.from_version_id) {
    const v = versionOf(ctx, q.source_id, q.from_version_id);
    checkPair(v, to);
    fromEntry = earlierItems.find((e) => e.v.id === v.id) ?? { v, items: itemsOn(ctx, v.id), pending: 0 };
  }
  const empty = { copy: 0, already_moved: 0, needs_review: 0, kept: 0, will_copy: [], by_kind: {}, review: [], kept_by_reason: [], kept_items: [] };
  if (!fromEntry || fromEntry.items.length === 0) {
    return {
      state: 'none',
      reason_ar: 'لا توجد ملاحظات أو كتابة على إصدار سابق من هذا المصدر.',
      source_id: q.source_id,
      from_version: fromEntry ? versionRef(fromEntry.v) : null,
      to_version: versionRef(to),
      algo: null,
      map_computed_at: null,
      total: 0,
      ...empty,
      earlier,
      last_run: null,
      summary_ar: 'لا شيء لنقله.',
    };
  }
  const from = fromEntry.v;
  const pages = new Pages(ctx);
  const last = lastRun(ctx, q.source_id, from.id, to.id);
  const ms = mapBetween(ctx, from, to);
  const plan = planAll(ctx, from, to, fromEntry.items, ms.state === 'ready' ? ms.map : null);
  const tally = tallyOf(plan);
  const fromPages = pages.of(from);
  const toPages = pages.of(to);
  const unknownPage = (id: string): ReanchorPageRef => ({ page_id: id, page_index: -1, label_ar: 'صفحة غير معروفة', thumbnail: false });
  const keptBy = new Map<ReanchorKeptReason, number>();
  for (const p of plan) if (p.status === 'kept') keptBy.set(p.keptReason!, (keptBy.get(p.keptReason!) ?? 0) + 1);
  const keptItems = plan
    .filter((p) => p.status === 'kept' && p.keptReason === 'owner_choice')
    .slice(0, REVIEW_LIMIT)
    .map((p) => ({
      kind: p.item.type,
      id: p.item.row.id,
      rev: p.item.row.rev,
      item_kind: p.item.kind,
      label_ar: KIND_LABEL_AR[p.item.kind] ?? 'عنصر',
      preview: previewOf(p.item),
      from: fromPages.get(p.item.anchor.page_id) ?? unknownPage(p.item.anchor.page_id),
    }));
  const base = {
    source_id: q.source_id,
    kept_items: keptItems,
    from_version: versionRef(from),
    to_version: versionRef(to),
    total: tally.total,
    kept_by_reason: [...keptBy].map(([reason, items]) => ({ reason, reason_ar: REANCHOR_KEPT_REASONS_AR[reason], items })),
    earlier,
    last_run: last ? reportOf(ctx, last, pages) : null,
  };
  if (ms.state !== 'ready') {
    return { ...base, ...empty, kept_by_reason: base.kept_by_reason, kept_items: base.kept_items, kept: tally.kept, already_moved: tally.already_moved, state: ms.state, reason_ar: ms.reason_ar, algo: null, map_computed_at: null, summary_ar: ms.reason_ar };
  }
  const willCopy = new Map<string, { page: ReanchorPageRef; from_page_index: number; from: ReanchorPageRef; items: number }>();
  const byKind: Record<string, number> = {};
  const review: ReanchorReviewItem[] = [];
  for (const p of plan) {
    if (p.status === 'copy' && p.plan?.action === 'copy') {
      const w = willCopy.get(p.plan.to_page_id) ?? {
          page: toPages.get(p.plan.to_page_id) ?? unknownPage(p.plan.to_page_id),
          from_page_index: p.item.anchor.page_index,
          from: fromPages.get(p.item.anchor.page_id) ?? unknownPage(p.item.anchor.page_id),
          items: 0,
        };
      w.items++;
      willCopy.set(p.plan.to_page_id, w);
      byKind[p.item.kind] = (byKind[p.item.kind] ?? 0) + 1;
    } else if (p.status === 'review' && p.plan?.action === 'review' && review.length < REVIEW_LIMIT) {
      const reason = p.plan.reason;
      const ink = COORDINATE_KINDS.has(p.item.kind) && p.item.kind !== 'text' && p.item.kind !== 'sticky';
      review.push({
        group_key: ink ? `ink:${p.item.anchor.page_id}:${reason}` : keyOf(p.item.type, p.item.row.id),
        kind: p.item.type,
        id: p.item.row.id,
        rev: p.item.row.rev,
        item_kind: p.item.kind,
        label_ar: KIND_LABEL_AR[p.item.kind] ?? 'عنصر',
        preview: previewOf(p.item),
        from: fromPages.get(p.item.anchor.page_id) ?? unknownPage(p.item.anchor.page_id),
        suggested: p.plan.suggested_page_id ? (toPages.get(p.plan.suggested_page_id) ?? null) : null,
        reason,
        reason_ar: REANCHOR_REVIEW_REASONS_AR[reason],
      });
    }
  }
  review.sort((a, b) => a.from.page_index - b.from.page_index);
  const summary = `سيُنقل ${tally.copy} · يحتاج مراجعة ${tally.needs_review} · يبقى على الإصدار ${from.version_no}: ${tally.kept}${tally.already_moved ? ` · نُقل سابقًا: ${tally.already_moved}` : ''}`;
  return {
    ...base,
    state: 'ready',
    reason_ar: null,
    algo: ms.map.algo,
    map_computed_at: ms.map.computed_at,
    copy: tally.copy,
    already_moved: tally.already_moved,
    needs_review: tally.needs_review,
    kept: tally.kept,
    will_copy: [...willCopy.values()].sort((a, b) => a.page.page_index - b.page.page_index),
    by_kind: byKind,
    review,
    summary_ar: summary,
  };
}

// ───────────────────────────── the tap ─────────────────────────────
export function runReanchorCopy(ctx: AppContext, body: RunBody, opts: { deviceId: string | null }): ReanchorCopyRunResponse {
  sourceOrThrow(ctx, body.source_id);
  const from = versionOf(ctx, body.source_id, body.from_version_id);
  const to = versionOf(ctx, body.source_id, body.to_version_id);
  checkPair(from, to);
  const ms = mapBetween(ctx, from, to);
  if (ms.state !== 'ready') throw new AppError('CONFLICT', `${ms.reason_ar}`, 409, { state: ms.state });
  if (body.map_computed_at != null && body.map_computed_at !== ms.map.computed_at) {
    throw new AppError('CONFLICT', 'تغيّرت مطابقة الصفحات منذ المعاينة؛ راجع المعاينة الجديدة ثم انقل. لم يُنسخ شيء.', 409, { reason: 'map_changed' });
  }
  const now = ctx.clock.now();
  const device = opts.deviceId ?? 'server';
  return ctx.db.tx(() => {
    const plan = planAll(ctx, from, to, itemsOn(ctx, from.id), ms.map);
    const tally = tallyOf(plan);
    const toCopy = plan.filter((p) => p.status === 'copy' && p.plan?.action === 'copy');
    const byPage = new Map<string, number>();
    for (const p of toCopy) {
      const pl = p.plan as Extract<ItemPlan, { action: 'copy' }>;
      byPage.set(pl.to_page_id, (byPage.get(pl.to_page_id) ?? 0) + 1);
    }
    const counts: RunCounts = { total: tally.total, copied: tally.copy, already_moved: tally.already_moved, needs_review: tally.needs_review, kept: tally.kept, by_page: [...byPage].map(([page_id, items]) => ({ page_id, items })) };
    const runId = toCopy.length ? newId(now) : null;
    const row: RunRow = { id: runId ?? '', source_id: from.source_id, from_version_id: from.id, to_version_id: to.id, kind: 'run', algo: ms.map.algo, counts_json: JSON.stringify(counts), device_id: device, created_at: now, undone_at: null, undo_json: null };
    if (!runId) return { report: { ...reportOf(ctx, row), id: null } };
    insertRun(ctx, row);
    const c: CopyTx = { ctx, now, device, runId, to };
    for (const p of toCopy) {
      const pl = p.plan as Extract<ItemPlan, { action: 'copy' }>;
      const data = pl.rects ? { ...(fromJson<Record<string, unknown>>((p.item.row as AnnotationRow).data_json) ?? {}), rects: pl.rects } : null;
      writeCopy(c, p.item, pageAnchorOn(to, { page_id: pl.to_page_id, page_index: pl.to_page_index }), data);
    }
    const report = reportOf(ctx, row);
    ctx.audit.record({
      entityType: 'source_version',
      entityId: to.id,
      action: 'reanchor_copy',
      summary: `نسخ المالك ملاحظاته من الإصدار ${from.version_no} إلى الإصدار ${to.version_no}: ${report.summary_ar}. لم يتغير شيء على الإصدار ${from.version_no}.`,
      before: null,
      after: { run_id: runId, from_version_id: from.id, to_version_id: to.id, algo: ms.map.algo, ...counts },
    });
    return { report };
  });
}

// ───────────────────────────── undo ─────────────────────────────
export function undoReanchorCopy(ctx: AppContext, runId: string, opts: { deviceId: string | null }): ReanchorCopyRunResponse {
  const run = ctx.db.get<RunRow>('SELECT * FROM reanchor_copy_run WHERE id = ?', [runId]);
  if (!run) throw new AppError('NOT_FOUND', 'لا يوجد نقل بهذا المعرّف.', 404);
  if (run.undone_at !== null) return { report: reportOf(ctx, run) };
  const now = ctx.clock.now();
  const device = opts.deviceId ?? 'server';
  return ctx.db.tx(() => {
    const items = ctx.db.all<{ entity_type: 'annotation' | 'note'; copy_id: string; copy_rev: number }>('SELECT entity_type, copy_id, copy_rev FROM reanchor_copy_item WHERE run_id = ? AND undone_at IS NULL', [runId]);
    let tombstoned = 0;
    let keptEdited = 0;
    const rtx = { db: ctx.db, now, deviceId: device };
    for (const it of items) {
      const row = it.entity_type === 'annotation' ? getAnnotation(ctx.db, it.copy_id) : getNote(ctx.db, it.copy_id);
      // (review) a copy the owner erased before the undo stays carried (its item row is left as it is), so a later tap
      // never revives what the owner erased
      if (row && row.deleted_at !== null) continue;
      if (row) {
        // a copy the owner changed after the copy is theirs now: kept (and still counted as carried forward)
        if (row.rev !== it.copy_rev) {
          keptEdited++;
          continue;
        }
        if (it.entity_type === 'annotation') {
          recordAnnotationRevision(rtx, row as unknown as Record<string, unknown> & AnnotationRow, 'delete', null);
          ctx.db.run('UPDATE annotation SET deleted_at = ?, rev = rev + 1, updated_at = ?, device_id = ? WHERE id = ?', [now, now, device, it.copy_id]);
        } else {
          const n = row as NoteRow;
          recordNoteRevision(rtx, n as unknown as Record<string, unknown> & NoteRow, 'delete', null);
          ctx.db.run('UPDATE note SET deleted_at = ?, rev = rev + 1, updated_at = ?, device_id = ? WHERE id = ?', [now, now, device, it.copy_id]);
          indexNote(ctx.db, { id: n.id, title: n.title, body: { v: 1, paragraphs: [] }, origin: n.origin, deleted: true });
        }
        ctx.sync.touch(it.entity_type, it.copy_id);
        tombstoned++;
      }
      ctx.db.run('UPDATE reanchor_copy_item SET undone_at = ? WHERE entity_type = ? AND copy_id = ?', [now, it.entity_type, it.copy_id]);
    }
    const undo = { tombstoned, kept_edited: keptEdited };
    ctx.db.run('UPDATE reanchor_copy_run SET undone_at = ?, undo_json = ? WHERE id = ?', [now, toJson(undo), runId]);
    ctx.audit.record({
      entityType: 'source_version',
      entityId: run.to_version_id,
      action: 'reanchor_copy_undo',
      summary: `تراجع المالك عن نقل الملاحظات: حُذفت ${tombstoned} من النسخ${keptEdited ? `، وبقيت ${keptEdited} عدّلتها بعد النقل` : ''}. الأصول على الإصدار السابق لم تتغير.`,
      before: { run_id: runId },
      after: { run_id: runId, ...undo },
    });
    return { report: reportOf(ctx, { ...run, undone_at: now, undo_json: toJson(undo) }) };
  });
}

// ───────────────────────────── the review list's decisions (POST /api/annotations/reanchor, cross-version) ─────────────
function loadItem(ctx: AppContext, it: ActionBody['items'][number]): Item {
  const row = it.kind === 'annotation' ? getAnnotation(ctx.db, it.id) : getNote(ctx.db, it.id);
  if (!row || row.deleted_at !== null) throw new AppError('NOT_FOUND', 'أحد العناصر غير موجود على الخادم أو حُذف؛ لم يتغير شيء.', 404, { id: it.id });
  if (row.rev !== it.rev) throw new AppError('CONFLICT', 'تغيّر أحد العناصر على جهاز آخر بعد أن فتحت هذه القائمة؛ لم يتغير شيء. حدّث القائمة ثم أعد الاختيار.', 409, { id: it.id, rev: row.rev });
  const own = checkExistingItem(ctx.db, row, null);
  if (!own.ok) throw new AppError(own.code === 'layer_read_only' ? 'LAYER_READ_ONLY' : 'FORBIDDEN', `${own.detail} لم يتغير شيء.`, own.code === 'layer_read_only' ? 409 : 403, { id: it.id, detail_code: own.code });
  const anchor = row.anchor_json ? fromJson<AnnotationAnchor>(row.anchor_json) : null;
  if (anchor?.type !== 'page') throw new AppError('VALIDATION_FAILED', 'يُنسخ إلى إصدار أحدث ما كان على صفحة من المصدر فقط.', 400, { id: it.id });
  return { type: it.kind, row, kind: it.kind === 'annotation' ? (row as AnnotationRow).kind : 'note', anchor };
}

export function reanchorCopyAction(ctx: AppContext, body: ActionBody, opts: { deviceId: string | null }): ReanchorCopyActionResponse {
  const to = getVersion(ctx, body.to_version_id);
  if (!to) throw new AppError('NOT_FOUND', 'الإصدار الجديد غير موجود.', 404);
  const items = body.items.map((i) => loadItem(ctx, i));
  const fromIds = new Set(items.map((i) => i.anchor.version_id));
  if (fromIds.size !== 1) throw new AppError('VALIDATION_FAILED', 'اختر عناصر من إصدار واحد في كل مرة.', 400);
  const from = getVersion(ctx, [...fromIds][0]!);
  if (!from || from.source_id !== to.source_id || items.some((i) => i.anchor.source_id !== to.source_id)) throw new AppError('VALIDATION_FAILED', 'تُنسخ الملاحظات إلى إصدار من المصدر نفسه فقط.', 400);
  checkPair(from, to);
  const now = ctx.clock.now();
  const device = opts.deviceId ?? 'server';
  const n = items.length;
  const what = items.every((i) => i.type === 'note') ? (n === 1 ? 'الملاحظة' : 'الملاحظات') : n === 1 ? 'العنصر' : itemsCountAr(n);

  if (body.action === 'keep_on_previous' || body.action === 'review_again') {
    ctx.db.tx(() => {
      for (const it of items) {
        if (body.action === 'keep_on_previous') {
          ctx.db.run(`INSERT OR IGNORE INTO reanchor_copy_decision (entity_type, entity_id, to_version_id, decision, created_at) VALUES (?, ?, ?, 'keep_on_previous', ?)`, [it.type, it.row.id, to.id, now]);
        } else {
          ctx.db.run('DELETE FROM reanchor_copy_decision WHERE entity_type = ? AND entity_id = ? AND to_version_id = ?', [it.type, it.row.id, to.id]);
        }
      }
      ctx.audit.record({
        entityType: 'source_version',
        entityId: to.id,
        action: body.action === 'keep_on_previous' ? 'reanchor_copy_keep' : 'reanchor_copy_review_again',
        summary: body.action === 'keep_on_previous' ? `أبقى المالك ${what} على الإصدار ${from.version_no} (لم يُنسخ ولم يتغير شيء).` : `أعاد المالك ${what} إلى قائمة المراجعة.`,
        before: null,
        after: { to_version_id: to.id, items: items.map((i) => ({ kind: i.type, id: i.row.id })) },
      });
    });
    return {
      annotations: [],
      notes: [],
      report: null,
      summary_ar:
        body.action === 'keep_on_previous'
          ? `${what} ${n === 1 ? 'تبقى' : 'تبقى'} على الإصدار ${from.version_no} كما ${n === 1 ? 'هي' : 'هي'}، ولا تُنسخ إلى الإصدار ${to.version_no}. يمكنك إعادتها إلى المراجعة في أي وقت.`
          : `أُعيدت ${what} إلى قائمة «تحتاج مراجعة».`,
    };
  }

  // copy to the page the owner picked
  const carried = carriedOf(ctx, to.source_id);
  const live = liveCopiesOf(ctx, items, to.id);
  const already = items.filter((i) => carried.has(keyOf(i.type, i.row.id)) || live.has(keyOf(i.type, i.row.id)));
  if (already.length) throw new AppError('CONFLICT', 'نُسخ هذا العنصر إلى إصدار أحدث من قبل؛ لم يُنسخ مرة ثانية. حدّث القائمة.', 409, { ids: already.map((i) => i.row.id) });
  const t = body.target!;
  const page = ctx.db.get<{ id: string; page_index: number }>('SELECT id, page_index FROM source_page WHERE id = ? AND version_id = ?', [t.page_id, to.id]);
  if (!page) throw new AppError('VALIDATION_FAILED', 'الصفحة المختارة ليست من الإصدار الجديد.', 400);
  let region: NormBox | null = null;
  if (t.region_id) {
    const r = ctx.db.get<{ bbox_json: string | null; page_id: string | null; status: string }>('SELECT bbox_json, page_id, status FROM source_region WHERE id = ?', [t.region_id]);
    if (!r || r.page_id !== page.id || r.status === 'rejected') throw new AppError('VALIDATION_FAILED', 'الفقرة المختارة ليست على الصفحة المختارة.', 400);
    region = boxOf(fromJson(r.bbox_json));
  }
  // as Round 7's re-anchoring: the group keeps its shape; its bounding box's corner goes to the region's corner
  let dx = 0;
  let dy = 0;
  if (region) {
    const boxes = items
      .filter((i) => i.type === 'annotation')
      .map((i) => bboxOf(i.kind, fromJson<Record<string, unknown>>((i.row as AnnotationRow).data_json) ?? {}))
      .filter((b): b is NormBox => !!b);
    if (boxes.length) {
      const gx = Math.min(...boxes.map((b) => b.x));
      const gy = Math.min(...boxes.map((b) => b.y));
      const gw = Math.max(...boxes.map((b) => b.x + b.w)) - gx;
      const gh = Math.max(...boxes.map((b) => b.y + b.h)) - gy;
      dx = Math.round((Math.min(Math.max(0, region.x), Math.max(0, 1 - gw)) - gx) * 1e5) / 1e5;
      dy = Math.round((Math.min(Math.max(0, region.y), Math.max(0, 1 - gh)) - gy) * 1e5) / 1e5;
    }
  }
  const anchor = pageAnchorOn(to, { page_id: page.id, page_index: page.page_index });
  const label = new Pages(ctx).of(to).get(page.id)?.label_ar ?? 'الصفحة المختارة';
  return ctx.db.tx(() => {
    const runId = newId(now);
    const counts: RunCounts = { total: n, copied: n, already_moved: 0, needs_review: 0, kept: 0, by_page: [{ page_id: page.id, items: n }] };
    const row: RunRow = { id: runId, source_id: to.source_id, from_version_id: from.id, to_version_id: to.id, kind: 'manual', algo: null, counts_json: JSON.stringify(counts), device_id: device, created_at: now, undone_at: null, undo_json: null };
    insertRun(ctx, row);
    const c: CopyTx = { ctx, now, device, runId, to };
    const annOut: AnnotationDTO[] = [];
    const noteOut: NoteDTO[] = [];
    for (const it of items) {
      const data = it.type === 'annotation' && (dx !== 0 || dy !== 0) ? translateData(it.kind, fromJson<Record<string, unknown>>((it.row as AnnotationRow).data_json) ?? {}, dx, dy) : null;
      const { id } = writeCopy(c, it, anchor, data);
      ctx.db.run('DELETE FROM reanchor_copy_decision WHERE entity_type = ? AND entity_id = ? AND to_version_id = ?', [it.type, it.row.id, to.id]);
      if (it.type === 'annotation') annOut.push(toAnnotationDTO(getAnnotation(ctx.db, id)!));
      else noteOut.push(toNoteDTO(getNote(ctx.db, id)!));
    }
    const summary = `نُسخت ${what} إلى «${label}» في الإصدار ${to.version_no}${region ? ' عند الفقرة المختارة' : ''}. ${n === 1 ? 'بقي الأصل' : 'بقيت الأصول'} على الإصدار ${from.version_no} كما ${n === 1 ? 'هو' : 'هي'}.`;
    ctx.audit.record({
      entityType: 'source_version',
      entityId: to.id,
      action: 'reanchor_copy_manual',
      summary: `نسخ المالك من قائمة المراجعة: ${summary}`,
      before: null,
      after: { run_id: runId, to_page_id: page.id, region_id: t.region_id ?? null, moved_by: { dx, dy }, items: items.map((i) => ({ kind: i.type, id: i.row.id })) },
    });
    return { annotations: annOut, notes: noteOut, summary_ar: summary, report: reportOf(ctx, row) };
  });
}
