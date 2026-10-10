// Review Queue across all kinds (§48): list / filter / counts, detail with the ORIGINAL location (source → version
// → page → region box) next to the structured data and the specific reason, and resolution (accept / correct /
// reject / dismiss) with resolution_json + audit. Items whose data belongs to another screen (questions, generated
// questions, notes to re-anchor, claims) deep-link there; this module never re-implements their decisions.
import {
  LECTURE_KINDS,
  LECTURE_KIND_LABELS_AR,
  REVIEW_ACTION_STATUS,
  REVIEW_ITEM_STATUS_LABELS_AR,
  REVIEW_KIND_LABELS_AR,
  REVIEW_QUEUE_KINDS,
  STATUS_LABELS_AR,
  SUPPORT_TYPE_LABELS_AR,
  richTextToPlain,
  type LectureKind,
  type NormBox,
  type RegionCorrectionView,
  type ResolveReviewRequest,
  type ResolveReviewResponse,
  type ReviewAction,
  type ReviewActionSpec,
  type ReviewHandledIn,
  type ReviewItemDetail,
  type ReviewItemStatus,
  type ReviewLink,
  type ReviewOriginal,
  type ReviewQueueCounts,
  type ReviewQueueItemView,
  type ReviewQueueKind,
  type ReviewQueueListResponse,
  type ReviewResolution,
  type ReviewStructured,
  type RichText,
  type SourceType,
  type SupportType,
  type VerificationStatus,
} from '@medlevo/shared';
import type { AppContext } from '../../context';
import { fromJson, toJson } from '../../db/db';
import { AppError } from '../../lib/errors';
import { SourcesService } from '../sources/service';
import {
  acceptRegion,
  correctRegion,
  currentRegionId,
  getPage,
  getRegion,
  ownerTranscription,
  pageLabelAr,
  refreshPageState,
  regionChain,
  rejectRegion,
  transcribePage,
  type CorrectionOutcome,
  type PageRow,
} from './corrections';
import { CORRECTION_ACTION_LABELS_AR, PAGE_TEXT_STATUS_LABELS_AR, REGION_KIND_LABELS_AR, REGION_STATUS_LABELS_AR, TEXT_ORIGIN_LABELS_AR, oneLine } from './labels';

export interface ItemRow {
  id: string;
  kind: ReviewQueueKind;
  entity_type: string;
  entity_id: string;
  source_id: string | null;
  reason: string;
  details_json: string | null;
  status: ReviewItemStatus;
  resolution_json: string | null;
  created_at: number;
  resolved_at: number | null;
  source_title: string | null;
  source_type: SourceType | null;
}

type Details = Record<string, unknown> & {
  origin?: string;
  page_id?: string;
  version_id?: string;
  question_id?: string;
  candidate_id?: string;
  artifact_id?: string;
};

const QUESTION_ENTITY_TYPES = new Set(['question', 'question_version', 'question_occurrence', 'question_lecture_link', 'question_duplicate', 'answer_key_entry', 'question_extraction']);

const ITEM_SQL = `SELECT r.id, r.kind, r.entity_type, r.entity_id, r.source_id, r.reason, r.details_json, r.status, r.resolution_json, r.created_at, r.resolved_at,
    s.title AS source_title, s.source_type AS source_type
  FROM review_queue_item r LEFT JOIN source s ON s.id = r.source_id`;
/** items of a source in the trash are hidden with it (they come back when the source is restored) */
const LIVE = `(r.source_id IS NULL OR s.deleted_at IS NULL)`;

function details(r: Pick<ItemRow, 'details_json'>): Details {
  return (fromJson<Details | null>(r.details_json, null) ?? {}) as Details;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

// ───────── routing: where an item is really resolved ─────────
interface Routing {
  handledIn: ReviewHandledIn;
  link: ReviewLink | null;
}

function studyLink(sourceId: string | null, extra: { versionId?: string | null; pageIndex?: number | null; pageId?: string | null; regionId?: string | null } = {}): string | null {
  if (!sourceId) return null;
  const q = new URLSearchParams();
  if (extra.versionId) q.set('v', extra.versionId);
  if (typeof extra.pageIndex === 'number') q.set('page', String(extra.pageIndex));
  if (extra.pageId) q.set('page_id', extra.pageId);
  if (extra.regionId) q.set('region', extra.regionId);
  const qs = q.toString();
  return `/study/${encodeURIComponent(sourceId)}${qs ? `?${qs}` : ''}`;
}

function questionIdOf(r: ItemRow, d: Details): string | null {
  return str(d.question_id) ?? (r.entity_type === 'question' ? r.entity_id : null);
}

function routing(ctx: AppContext, r: ItemRow, d: Details): Routing {
  if (d.origin === 'questions' || QUESTION_ENTITY_TYPES.has(r.entity_type)) {
    const qid = questionIdOf(r, d);
    return {
      handledIn: 'questions',
      link: qid ? { href: `/questions/${encodeURIComponent(qid)}/review`, label_ar: 'افتح السؤال للمراجعة جنبًا إلى جنب' } : { href: '/questions/review', label_ar: 'افتح قائمة مراجعة الأسئلة' },
    };
  }
  if (r.entity_type === 'generated_question_candidate') return { handledIn: 'exams', link: { href: '/exams/generate', label_ar: 'افتح توليد الأسئلة' } };
  if (r.kind === 'needs_reanchor') {
    const href = studyLink(r.source_id);
    return { handledIn: 'workspace', link: href ? { href, label_ar: 'افتح المصدر في مساحة الدراسة لإعادة الربط' } : null };
  }
  if (r.kind === 'claim_unsupported' || r.entity_type === 'claim') {
    const sourceId = claimArtifactSource(ctx, r.entity_id) ?? r.source_id;
    const href = studyLink(sourceId);
    return { handledIn: 'workspace', link: href ? { href, label_ar: 'افتح المحتوى في مساحة الدراسة' } : null };
  }
  return { handledIn: 'control', link: null };
}

function claimArtifactSource(ctx: AppContext, claimId: string): string | null {
  const c = ctx.db.get<{ owner_type: string; owner_id: string }>('SELECT owner_type, owner_id FROM claim WHERE id = ?', [claimId]);
  if (!c) return null;
  if (c.owner_type === 'content_block') {
    return ctx.db.get<{ s: string | null }>('SELECT a.primary_source_id AS s FROM content_block b JOIN artifact a ON a.id = b.artifact_id WHERE b.id = ?', [c.owner_id])?.s ?? null;
  }
  if (c.owner_type === 'artifact') return ctx.db.get<{ s: string | null }>('SELECT primary_source_id AS s FROM artifact WHERE id = ?', [c.owner_id])?.s ?? null;
  return null;
}

// ───────── location ─────────
function pageIdOf(ctx: AppContext, r: ItemRow, d: Details): string | null {
  if (r.entity_type === 'source_page') return r.entity_id;
  if (r.entity_type === 'source_region') return getRegion(ctx, r.entity_id)?.page_id ?? str(d.page_id);
  return str(d.page_id);
}

function locationLabels(ctx: AppContext, rows: Array<{ r: ItemRow; d: Details }>): Map<string, string | null> {
  const out = new Map<string, string | null>();
  const pageIds = new Map<string, string>();
  for (const { r, d } of rows) {
    const pid = pageIdOf(ctx, r, d);
    if (pid) pageIds.set(r.id, pid);
    else out.set(r.id, null);
  }
  const unique = [...new Set(pageIds.values())];
  const pages = new Map<string, Pick<PageRow, 'page_index' | 'printed_label' | 'kind'>>();
  for (let i = 0; i < unique.length; i += 400) {
    const chunk = unique.slice(i, i + 400);
    for (const p of ctx.db.all<{ id: string; page_index: number; printed_label: string | null; kind: PageRow['kind'] }>(
      `SELECT id, page_index, printed_label, kind FROM source_page WHERE id IN (${chunk.map(() => '?').join(',')})`,
      chunk,
    ))
      pages.set(p.id, p);
  }
  for (const [itemId, pid] of pageIds) {
    const p = pages.get(pid);
    out.set(itemId, p ? pageLabelAr(p) : null);
  }
  return out;
}

function toView(ctx: AppContext, r: ItemRow, location: string | null): ReviewQueueItemView {
  const d = details(r);
  const route = routing(ctx, r, d);
  return {
    id: r.id,
    kind: r.kind,
    kind_label_ar: REVIEW_KIND_LABELS_AR[r.kind] ?? r.kind,
    status: r.status,
    status_label_ar: REVIEW_ITEM_STATUS_LABELS_AR[r.status] ?? r.status,
    entity_type: r.entity_type,
    entity_id: r.entity_id,
    origin: str(d.origin),
    source_id: r.source_id,
    source_title: oneLine(r.source_title, 200),
    source_type: r.source_type,
    reason: r.reason,
    location_label_ar: location,
    handled_in: route.handledIn,
    link: route.link,
    created_at: r.created_at,
    resolved_at: r.resolved_at,
  };
}

// ───────── list ─────────
export interface ListQuery {
  status: 'open' | 'resolved' | 'all';
  kind?: ReviewQueueKind;
  source_id?: string;
  origin?: string;
  limit: number;
  cursor?: string;
}

function decodeCursor(c: string | undefined): { at: number; id: string } | null {
  if (!c) return null;
  const m = /^(\d{1,16})_([0-9A-Za-z]{1,64})$/.exec(c);
  if (!m) throw new AppError('VALIDATION_FAILED', 'مؤشر الصفحة غير صالح.', 400, { where: 'query', issues: [{ path: 'cursor', code: 'invalid_format', message: 'صيغة القيمة غير صحيحة.' }] });
  return { at: Number(m[1]), id: m[2]! };
}

export function counts(ctx: AppContext): ReviewQueueCounts {
  const byStatus: Record<ReviewItemStatus, number> = { open: 0, accepted: 0, corrected: 0, rejected: 0, dismissed: 0 };
  for (const row of ctx.db.all<{ status: ReviewItemStatus; n: number }>(`SELECT r.status, COUNT(*) AS n FROM review_queue_item r LEFT JOIN source s ON s.id = r.source_id WHERE ${LIVE} GROUP BY r.status`)) {
    if (row.status in byStatus) byStatus[row.status] = row.n;
  }
  const openByKind: Partial<Record<ReviewQueueKind, number>> = {};
  for (const row of ctx.db.all<{ kind: ReviewQueueKind; n: number }>(
    `SELECT r.kind, COUNT(*) AS n FROM review_queue_item r LEFT JOIN source s ON s.id = r.source_id WHERE r.status = 'open' AND ${LIVE} GROUP BY r.kind`,
  )) {
    openByKind[row.kind] = row.n;
  }
  return { open: byStatus.open, open_by_kind: openByKind, by_status: byStatus };
}

export function listReview(ctx: AppContext, q: ListQuery): ReviewQueueListResponse {
  const where = [LIVE];
  const params: unknown[] = [];
  if (q.status === 'open') where.push(`r.status = 'open'`);
  else if (q.status === 'resolved') where.push(`r.status <> 'open'`);
  if (q.kind) {
    where.push('r.kind = ?');
    params.push(q.kind);
  }
  if (q.source_id) {
    where.push('r.source_id = ?');
    params.push(q.source_id);
  }
  if (q.origin) {
    where.push(`json_valid(r.details_json) AND json_extract(r.details_json, '$.origin') = ?`);
    params.push(q.origin);
  }
  const cur = decodeCursor(q.cursor);
  if (cur) {
    where.push('(r.created_at < ? OR (r.created_at = ? AND r.id < ?))');
    params.push(cur.at, cur.at, cur.id);
  }
  const rows = ctx.db.all<ItemRow>(`${ITEM_SQL} WHERE ${where.join(' AND ')} ORDER BY r.created_at DESC, r.id DESC LIMIT ?`, [...params, q.limit + 1]);
  const more = rows.length > q.limit;
  const page = rows.slice(0, q.limit);
  const labels = locationLabels(ctx, page.map((r) => ({ r, d: details(r) })));
  const last = page[page.length - 1];
  const sources = ctx.db.all<{ id: string; title: string; open: number }>(
    `SELECT s.id, s.title, SUM(CASE WHEN r.status = 'open' THEN 1 ELSE 0 END) AS open FROM review_queue_item r JOIN source s ON s.id = r.source_id
      WHERE s.deleted_at IS NULL GROUP BY s.id ORDER BY open DESC, s.title LIMIT 200`,
  );
  return {
    items: page.map((r) => toView(ctx, r, labels.get(r.id) ?? null)),
    counts: counts(ctx),
    sources: sources.map((s) => ({ id: s.id, title: oneLine(s.title, 200) ?? '', open: s.open })),
    next_cursor: more && last ? `${last.created_at}_${last.id}` : null,
  };
}

// ───────── detail ─────────
function getItem(ctx: AppContext, id: string): ItemRow {
  const r = ctx.db.get<ItemRow>(`${ITEM_SQL} WHERE r.id = ?`, [id]);
  if (!r) throw new AppError('NOT_FOUND', 'عنصر المراجعة غير موجود.', 404);
  return r;
}

interface VersionRow {
  id: string;
  source_id: string;
  version_no: number;
  format: string;
  file_id: string | null;
  display_file_id: string | null;
}

function original(ctx: AppContext, opts: { pageId: string | null; versionId: string | null; regionId: string | null; bbox: NormBox | null }): ReviewOriginal | null {
  const page = opts.pageId ? getPage(ctx, opts.pageId) : undefined;
  const versionId = page?.version_id ?? opts.versionId;
  if (!versionId) return null;
  const v = ctx.db.get<VersionRow>('SELECT id, source_id, version_no, format, file_id, display_file_id FROM source_version WHERE id = ?', [versionId]);
  if (!v) return null;
  const s = ctx.db.get<{ id: string; title: string; source_type: SourceType; current_version_id: string | null; frozen_version_id: string | null }>(
    'SELECT id, title, source_type, current_version_id, frozen_version_id FROM source WHERE id = ?',
    [v.source_id],
  );
  if (!s) return null;
  let render: ReviewOriginal['render'];
  const pdfFile = v.display_file_id ?? (v.format === 'pdf' ? v.file_id : null);
  if (!page) render = { kind: 'none', reason_ar: 'هذا العنصر لا يشير إلى صفحة محددة.' };
  else if (pdfFile && page.kind !== 'image' && page.kind !== 'docx_section') render = { kind: 'pdf', file_id: pdfFile, page_index: page.page_index };
  else if (page.render_file_id) render = { kind: 'image', file_id: page.render_file_id };
  else render = { kind: 'none', reason_ar: page.kind === 'docx_section' ? 'ملفات Word لا صفحات ثابتة لها؛ يُعرض النص المستخرج فقط.' : 'لا يوجد عرض ثابت لهذه الصفحة.' };
  const href = studyLink(s.id, { versionId: v.id, pageIndex: page?.page_index ?? null, pageId: page?.id ?? null, regionId: opts.regionId });
  return {
    source_id: s.id,
    source_title: oneLine(s.title, 200) ?? '',
    source_type: s.source_type,
    version_id: v.id,
    version_no: v.version_no,
    is_active_version: (s.frozen_version_id ?? s.current_version_id) === v.id,
    page_id: page?.id ?? null,
    page_index: page?.page_index ?? null,
    page_label_ar: page ? pageLabelAr(page) : null,
    page_kind: page?.kind ?? null,
    bbox: opts.bbox,
    render,
    open_link: href ? { href, label_ar: 'افتح في مساحة الدراسة' } : null,
  };
}

function regionBbox(ctx: AppContext, regionId: string): NormBox | null {
  const r = ctx.db.get<{ bbox_json: string | null }>('SELECT bbox_json FROM source_region WHERE id = ?', [regionId]);
  const b = fromJson<NormBox | null>(r?.bbox_json ?? null, null);
  return b && [b.x, b.y, b.w, b.h].every((n) => typeof n === 'number' && Number.isFinite(n)) ? b : null;
}

function correctionsFor(ctx: AppContext, where: { regionId?: string | null; pageId?: string | null; itemId: string }): RegionCorrectionView[] {
  const conds = ['review_item_id = ?'];
  const params: unknown[] = [where.itemId];
  if (where.regionId) {
    // a corrected CITED region was replaced by a successor: its history belongs to the whole chain
    const chain = regionChain(ctx, where.regionId);
    conds.push(`region_id IN (${chain.map(() => '?').join(',')})`);
    params.push(...chain);
  }
  if (where.pageId) {
    conds.push(`(page_id = ? AND action = 'owner_text')`);
    params.push(where.pageId);
  }
  const rows = ctx.db.all<{
    id: string;
    region_id: string;
    page_id: string | null;
    action: RegionCorrectionView['action'];
    before_text: string | null;
    after_text: string | null;
    before_origin: string | null;
    after_origin: string | null;
    before_status: string | null;
    after_status: string | null;
    alert_id: string | null;
    note: string | null;
    created_at: number;
  }>(`SELECT * FROM control_region_correction WHERE ${conds.join(' OR ')} ORDER BY created_at DESC, id DESC LIMIT 50`, params);
  return rows.map((c) => ({ ...c, action_label_ar: CORRECTION_ACTION_LABELS_AR[c.action] ?? c.action }));
}

const LECTURE_KIND_OPTIONS = LECTURE_KINDS.map((k) => ({ value: k, label_ar: LECTURE_KIND_LABELS_AR[k] }));

function regionData(ctx: AppContext, regionId: string): ReviewStructured {
  const reg = getRegion(ctx, regionId);
  if (!reg) return { type: 'other', facts: [{ label_ar: 'الحالة', value: 'المنطقة لم تعد موجودة (أُعيدت معالجة الصفحة على الأرجح).' }] };
  return {
    type: 'region',
    region: {
      id: reg.id,
      kind: reg.kind,
      kind_label_ar: REGION_KIND_LABELS_AR[reg.kind] ?? reg.kind,
      text: reg.text,
      text_origin: reg.text_origin,
      text_origin_label_ar: reg.text_origin ? (TEXT_ORIGIN_LABELS_AR[reg.text_origin] ?? reg.text_origin) : 'غير معروف',
      confidence: reg.confidence,
      status: reg.status,
      status_label_ar: REGION_STATUS_LABELS_AR[reg.status] ?? reg.status,
    },
  };
}

function pageData(ctx: AppContext, pageId: string): ReviewStructured {
  const p = getPage(ctx, pageId);
  if (!p) return { type: 'other', facts: [{ label_ar: 'الحالة', value: 'الصفحة لم تعد موجودة.' }] };
  const n = ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM source_region WHERE page_id = ? AND status <> 'rejected' AND text IS NOT NULL AND trim(text) <> '' AND kind NOT IN ('header','footer')`, [pageId])!.n;
  return {
    type: 'page',
    page: {
      id: p.id,
      text_status: p.text_status,
      text_status_label_ar: PAGE_TEXT_STATUS_LABELS_AR[p.text_status] ?? p.text_status,
      processing_status: p.processing_status,
      ocr_confidence: p.ocr_confidence,
      error_code: p.error_code,
      error_detail_ar: p.error_detail,
      region_count: n,
      owner_text: ownerTranscription(ctx, p.id)?.text ?? null,
    },
  };
}

function structured(ctx: AppContext, r: ItemRow, d: Details): ReviewStructured {
  if (r.entity_type === 'source_region') return regionData(ctx, r.status === 'open' ? r.entity_id : currentRegionId(ctx, r.entity_id));
  if (r.entity_type === 'source_page') return pageData(ctx, r.entity_id);
  if (r.kind === 'classification_suggestion' && r.entity_type === 'source') {
    const s = ctx.db.get<{ lecture_kind: LectureKind | null; lecture_kind_origin: 'auto' | 'owner' | null }>('SELECT lecture_kind, lecture_kind_origin FROM source WHERE id = ?', [r.entity_id]);
    const suggested = typeof d.suggested === 'string' && (LECTURE_KINDS as readonly string[]).includes(d.suggested) ? (d.suggested as LectureKind) : null;
    const reasons = Array.isArray(d.reasons_ar) ? (d.reasons_ar as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 12) : [];
    return { type: 'classification', current: s?.lecture_kind ?? null, current_origin: s?.lecture_kind_origin ?? null, suggested, reasons_ar: reasons, options: LECTURE_KIND_OPTIONS };
  }
  if (r.entity_type === 'claim') {
    const c = ctx.db.get<{ text: string; support_type: SupportType; verification_status: VerificationStatus; owner_type: string; owner_id: string }>(
      'SELECT text, support_type, verification_status, owner_type, owner_id FROM claim WHERE id = ?',
      [r.entity_id],
    );
    if (!c) return { type: 'other', facts: [{ label_ar: 'الحالة', value: 'الجملة لم تعد موجودة (أُعيد توليد المحتوى على الأرجح).' }] };
    const title =
      c.owner_type === 'content_block'
        ? (ctx.db.get<{ t: string | null }>('SELECT a.title AS t FROM content_block b JOIN artifact a ON a.id = b.artifact_id WHERE b.id = ?', [c.owner_id])?.t ?? null)
        : c.owner_type === 'artifact'
          ? (ctx.db.get<{ t: string | null }>('SELECT title AS t FROM artifact WHERE id = ?', [c.owner_id])?.t ?? null)
          : null;
    return {
      type: 'claim',
      text: c.text,
      support_label_ar: SUPPORT_TYPE_LABELS_AR[c.support_type] ?? c.support_type,
      status_label_ar: (STATUS_LABELS_AR as Record<string, string>)[c.verification_status] ?? c.verification_status,
      artifact_title: oneLine(title, 200),
    };
  }
  if (r.entity_type === 'generated_question_candidate') {
    const c = ctx.db.get<{ candidate_json: string; issues_json: string }>('SELECT candidate_json, issues_json FROM generated_question_candidate WHERE id = ?', [r.entity_id]);
    const cand = fromJson<{ stem?: unknown; options?: Array<{ text?: unknown }> } | null>(c?.candidate_json ?? null, null);
    const issues = fromJson<Array<{ reason_ar?: unknown }>>(c?.issues_json ?? null, []) ?? [];
    return {
      type: 'generated_question',
      stem: typeof cand?.stem === 'string' ? cand.stem.slice(0, 2000) : null,
      options: Array.isArray(cand?.options) ? cand!.options.map((o) => (typeof o?.text === 'string' ? o.text.slice(0, 500) : '')).filter(Boolean).slice(0, 10) : [],
      issues_ar: issues.map((i) => (typeof i.reason_ar === 'string' ? i.reason_ar : '')).filter(Boolean).slice(0, 12),
    };
  }
  if (r.kind === 'needs_reanchor') {
    let preview: string | null = null;
    if (r.entity_type === 'note') {
      const n = ctx.db.get<{ title: string | null; body_json: string }>('SELECT title, body_json FROM note WHERE id = ?', [r.entity_id]);
      preview = n ? oneLine(n.title || richTextToPlain(fromJson<RichText | null>(n.body_json, null)), 240) : null;
    } else if (r.entity_type === 'annotation') {
      const a = ctx.db.get<{ kind: string; data_json: string }>('SELECT kind, data_json FROM annotation WHERE id = ?', [r.entity_id]);
      const text = fromJson<{ text?: unknown }>(a?.data_json ?? null, {})?.text;
      preview = typeof text === 'string' ? oneLine(text, 240) : a ? `كتابة من نوع ${a.kind}` : null;
    }
    return {
      type: 'note_anchor',
      target_kind: r.entity_type,
      preview,
      previous_version_no: typeof d.previous_version_no === 'number' ? d.previous_version_no : null,
      new_version_no: typeof d.new_version_no === 'number' ? d.new_version_no : null,
    };
  }
  const qid = questionIdOf(r, d);
  if (d.origin === 'questions' || QUESTION_ENTITY_TYPES.has(r.entity_type)) {
    let stem: string | null = null;
    if (qid) {
      const v = ctx.db.get<{ stem_json: string }>('SELECT v.stem_json FROM question q JOIN question_version v ON v.id = q.current_version_id WHERE q.id = ?', [qid]);
      stem = v ? oneLine(richTextToPlain(fromJson<RichText | null>(v.stem_json, null)), 400) : null;
    }
    return { type: 'question', question_id: qid, stem_preview: stem };
  }
  const facts: Array<{ label_ar: string; value: string }> = [];
  for (const [k, v] of Object.entries(d)) {
    if (k === 'origin' || v === null || typeof v === 'object') continue;
    facts.push({ label_ar: k, value: String(v).slice(0, 300) });
    if (facts.length >= 8) break;
  }
  return { type: 'other', facts };
}

// ───────── available actions ─────────
function spec(action: ReviewAction, label: string, effect: string, input: ReviewActionSpec['input'] = 'none'): ReviewActionSpec {
  return { action, label_ar: label, effect_ar: effect, input };
}

const DISMISS = spec('dismiss', 'أغلقه دون تغيير', 'يُغلق هذا العنصر ويُحفظ قرارك في السجل. لا يتغير أي نص أو بيانات.');

function actionsFor(ctx: AppContext, r: ItemRow, routeIn: ReviewHandledIn, s: ReviewStructured): { actions: ReviewActionSpec[]; note: string | null } {
  if (r.status !== 'open') return { actions: [], note: 'عولج هذا العنصر؛ قرارك محفوظ أدناه.' };
  if (routeIn === 'questions') {
    return {
      actions: [DISMISS],
      note: 'قرارات الأسئلة (المفتاح، الخيارات، الربط بالمحاضرة، التكرار) تُتخذ في شاشة مراجعة السؤال جنبًا إلى جنب مع الصفحة الأصلية، حتى تبقى محاولاتك ونسخ السؤال مرتبطة بقرارك.',
    };
  }
  if (routeIn === 'exams') {
    return {
      actions: [spec('reject', 'أبقِه غير منشور', 'يبقى السؤال المولّد خارج بنك أسئلتك (لم يجتز الفحص)، ويُغلق هذا العنصر. لا يُنشر أي سؤال لم يجتز التحقق.'), DISMISS],
      note: 'سؤال مولّد لم يجتز الفحص لا يُنشر من هنا. يمكنك توليد أسئلة جديدة من شاشة التوليد.',
    };
  }
  if (r.kind === 'needs_reanchor') {
    return { actions: [DISMISS], note: 'ملاحظتك لم تتغير ولن تُحذف. أعد ربطها من مساحة الدراسة، أو أغلق العنصر لتبقى كما هي غير مرتبطة بفقرة.' };
  }
  if (routeIn === 'workspace') {
    return { actions: [DISMISS], note: 'لا تُغيَّر حالة جملة مولّدة من هنا؛ افتح المحتوى وأعد توليده أو راجعه هناك. الجملة المتعارضة تبقى معلَّمة.' };
  }
  if (s.type === 'region') {
    const region = s.region;
    if (region.kind === 'table' || region.kind === 'figure' || region.kind === 'diagram') {
      return {
        actions: [spec('accept', 'قبول كما هو', 'يُعلَّم المحتوى «راجعته شخصيًا» دون تغيير.'), DISMISS],
        note: 'نص الجدول أو الشكل لا يُصحَّح كاملًا من هنا؛ صحّح الخلية أو التعليق المقصود من عنصره.',
      };
    }
    return {
      actions: [
        spec('accept', 'قبول كما هو', 'النص المستخرج صحيح: لا يتغير النص، ويُعلَّم «راجعته شخصيًا». لا يُنشأ تنبيه.'),
        spec(
          'correct',
          'تصحيح النص',
          'يحل نصك محل النص المستخرج (مصدره: أنت)، ويُحفظ النص السابق في سجل التصحيحات، ويُحدَّث البحث، ويُنشأ تنبيه لكل شرح أو سؤال أو بطاقة يعتمد على هذه الصفحة. لا يُعاد توليد شيء تلقائيًا.',
          'text',
        ),
        spec('reject', 'استبعاد النص', 'يُستبعد النص من البحث ومن الأدلة الجديدة دون حذفه، ويُنشأ تنبيه لما يعتمد على هذه الصفحة.'),
        DISMISS,
      ],
      note: null,
    };
  }
  if (s.type === 'page') {
    const unreadable = r.kind === 'unreadable_page';
    return {
      actions: [
        unreadable
          ? spec('accept', 'الصفحة لا تحتاج نصًا', 'تؤكد أن الصفحة فارغة أو صورة لا نص فيها؛ تُعدّ جاهزة دون نص. لا يُخترع أي نص.')
          : spec('accept', 'راجعت الصفحة ونصها مقبول', 'تؤكد أن جودة المسح لا تمنع الاعتماد على نص هذه الصفحة؛ تبقى عناصر النص المشكوك فيها منفصلة.'),
        ...(unreadable
          ? [spec('correct', 'اكتب نص الصفحة بنفسك', 'يُحفظ ما تكتبه كنص للصفحة مصدره أنت (لا يُدّعى أنه قُرئ آليًا)، ويصبح قابلًا للبحث والاستشهاد.', 'text')]
          : []),
        DISMISS,
      ],
      note: 'يمكنك أيضًا إعادة معالجة الصفحة من قسم «المعالجة» (مثلًا بعد تثبيت أداة OCR).',
    };
  }
  if (s.type === 'classification') {
    return {
      actions: [
        spec('accept', 'قبول التصنيف المقترح', 'يُثبَّت التصنيف المقترح كقرار منك (لن يغيّره تحليل لاحق).'),
        spec('correct', 'اختر تصنيفًا آخر', 'يُحفظ التصنيف الذي تختاره كقرار منك.', 'lecture_kind'),
        spec('reject', 'بلا تصنيف', 'يُزال التصنيف التلقائي، وتبقى المحاضرة بلا نوع محدد.'),
        DISMISS,
      ],
      note: null,
    };
  }
  return {
    actions: [spec('accept', 'قبول', 'يُغلق العنصر مقبولًا ويُحفظ قرارك في السجل.'), spec('reject', 'رفض', 'يُغلق العنصر مرفوضًا ويُحفظ قرارك في السجل.'), DISMISS],
    note: null,
  };
}

function resolutionOf(r: ItemRow): ReviewResolution | null {
  if (r.status === 'open') return null;
  const j = fromJson<Record<string, unknown> | null>(r.resolution_json, null) ?? {};
  return {
    action: str(j.action) ?? r.status,
    by: str(j.by) ?? 'owner',
    note: str(j.note) ?? str(j.reason_ar),
    at: r.resolved_at,
    effects_ar: Array.isArray(j.effects_ar) ? (j.effects_ar as unknown[]).filter((x): x is string => typeof x === 'string') : [],
    alert_id: str(j.alert_id),
  };
}

export function reviewDetail(ctx: AppContext, id: string): ReviewItemDetail {
  const r = getItem(ctx, id);
  const d = details(r);
  const pageId = pageIdOf(ctx, r, d);
  const view = toView(ctx, r, locationLabels(ctx, [{ r, d }]).get(r.id) ?? null);
  // (an item about a region whose cited text was later replaced shows the region that holds the text now)
  const regionId = r.entity_type === 'source_region' ? currentRegionId(ctx, r.entity_id) : null;
  let orig: ReviewOriginal | null = null;
  if (pageId || str(d.version_id)) {
    orig = original(ctx, { pageId, versionId: str(d.version_id), regionId, bbox: regionId ? regionBbox(ctx, regionId) : null });
  }
  const s = structured(ctx, r, d);
  const { actions, note } = actionsFor(ctx, r, view.handled_in, s);
  return {
    ...view,
    original: orig,
    structured: s,
    actions,
    actions_note_ar: note,
    resolution: resolutionOf(r),
    corrections: correctionsFor(ctx, { regionId, pageId: r.entity_type === 'source_page' ? r.entity_id : null, itemId: r.id }),
  };
}

// ───────── resolve ─────────
function closeItem(ctx: AppContext, r: ItemRow, action: ReviewAction, note: string | null, effects: string[], extra: Record<string, unknown> = {}): void {
  const now = ctx.clock.now();
  const status = REVIEW_ACTION_STATUS[action];
  const res = ctx.db.run(`UPDATE review_queue_item SET status = ?, resolved_at = ?, resolution_json = ? WHERE id = ? AND status = 'open'`, [
    status,
    now,
    toJson({ by: 'owner', via: 'control', action, note, effects_ar: effects, ...extra }),
    r.id,
  ]);
  if (res.changes !== 1) throw new AppError('CONFLICT', 'عولج هذا العنصر من قبل؛ حدّث الصفحة لترى القرار المحفوظ.', 409);
  ctx.audit.record({
    entityType: 'review_queue_item',
    entityId: r.id,
    action: `review_${status}`,
    summary: `${REVIEW_KIND_LABELS_AR[r.kind] ?? r.kind}: ${oneLine(r.reason, 160)}`,
    before: { status: 'open' },
    after: { status, note, ...extra },
  });
}

function outcomeExtra(o: CorrectionOutcome): Record<string, unknown> {
  return { correction_id: o.correctionId, alert_id: o.alertId };
}

export function resolveReview(ctx: AppContext, id: string, body: ResolveReviewRequest): ResolveReviewResponse {
  const note = body.note?.trim() ? body.note.trim().slice(0, 1000) : null;
  let alert: ResolveReviewResponse['alert'] = null;
  let effects: string[] = [];
  ctx.db.tx(() => {
    const r = getItem(ctx, id);
    if (r.status !== 'open') throw new AppError('CONFLICT', 'عولج هذا العنصر من قبل؛ حدّث الصفحة لترى القرار المحفوظ.', 409);
    if (r.source_id && ctx.db.get(`SELECT 1 AS x FROM source WHERE id = ? AND deleted_at IS NOT NULL`, [r.source_id])) {
      throw new AppError('CONFLICT', 'مصدر هذا العنصر في سلة المحذوفات. استعده أولًا.', 409);
    }
    const d = details(r);
    const route = routing(ctx, r, d);
    const s = structured(ctx, r, d);
    const allowed = actionsFor(ctx, r, route.handledIn, s).actions.map((a) => a.action);
    if (!allowed.includes(body.action)) {
      throw new AppError(
        'BAD_REQUEST',
        route.handledIn === 'control' ? 'هذا الإجراء غير متاح لهذا النوع من العناصر.' : `هذا العنصر يُعالج في شاشته الخاصة${route.link ? ` («${route.link.label_ar}»)` : ''}؛ يمكنك هنا إغلاقه فقط.`,
        400,
        { allowed },
      );
    }
    let extra: Record<string, unknown> = {};
    if (body.action === 'dismiss') {
      effects = ['أُغلق العنصر دون أي تغيير في النص أو البيانات.'];
    } else if (s.type === 'region') {
      const input = { regionId: r.entity_id, itemId: r.id, note };
      const o =
        body.action === 'correct'
          ? correctRegion(ctx, { ...input, text: body.text ?? '' })
          : body.action === 'accept'
            ? acceptRegion(ctx, input)
            : rejectRegion(ctx, input);
      effects = o.effects_ar;
      extra = outcomeExtra(o);
      if (o.alertId && o.alertCounts) alert = { id: o.alertId, summary: alertSummary(ctx, o.alertId), counts: o.alertCounts };
    } else if (s.type === 'page') {
      if (body.action === 'correct') {
        const o = transcribePage(ctx, { pageId: r.entity_id, itemId: r.id, note, text: body.text ?? '' });
        effects = o.effects_ar;
        extra = outcomeExtra(o);
        if (o.alertId && o.alertCounts) alert = { id: o.alertId, summary: alertSummary(ctx, o.alertId), counts: o.alertCounts };
      } else {
        effects = [r.kind === 'unreadable_page' ? 'سُجّل أن هذه الصفحة لا تحتاج نصًا؛ لم يُخترع أي نص لها.' : 'سُجّل أنك راجعت الصفحة وأن جودة المسح لا تمنع الاعتماد على نصها.'];
      }
    } else if (s.type === 'classification') {
      const svc = new SourcesService(ctx);
      if (body.action === 'accept') {
        if (!s.suggested) throw new AppError('CONFLICT', 'لا يوجد تصنيف مقترح لقبوله.', 409);
        svc.patch(r.entity_id, { lecture_kind: s.suggested });
        effects = [`ثُبّت التصنيف «${LECTURE_KIND_LABELS_AR[s.suggested]}» كقرار منك؛ لن يغيّره تحليل لاحق.`];
      } else if (body.action === 'correct') {
        const k = body.lecture_kind;
        if (!k || !(LECTURE_KINDS as readonly string[]).includes(k)) {
          throw new AppError('VALIDATION_FAILED', 'اختر نوع المحاضرة.', 400, { where: 'body', issues: [{ path: 'lecture_kind', code: 'invalid_value', message: 'اختر نوعًا من القائمة.' }] });
        }
        svc.patch(r.entity_id, { lecture_kind: k });
        effects = [`حُفظ التصنيف «${LECTURE_KIND_LABELS_AR[k]}» كقرار منك.`];
        extra = { lecture_kind: k };
      } else {
        svc.patch(r.entity_id, { lecture_kind: null });
        effects = ['أُزيل التصنيف التلقائي؛ المحاضرة بلا نوع محدد الآن.'];
      }
    } else if (route.handledIn === 'exams') {
      effects = ['يبقى السؤال المولّد غير منشور، ولم يُضف إلى بنك أسئلتك.'];
    } else {
      effects = [body.action === 'accept' ? 'أُغلق العنصر مقبولًا.' : 'أُغلق العنصر مرفوضًا.'];
    }
    closeItem(ctx, r, body.action, note, effects, extra);
    if (r.entity_type === 'source_page' && body.action !== 'dismiss' && refreshPageState(ctx, r.entity_id)) {
      effects.push('لم تعد هذه الصفحة بحاجة إلى مراجعة.');
      ctx.db.run(`UPDATE review_queue_item SET resolution_json = json_set(resolution_json, '$.effects_ar', json(?)) WHERE id = ?`, [JSON.stringify(effects), r.id]);
    }
  });
  return { item: reviewDetail(ctx, id), effects_ar: effects, alert };
}

function alertSummary(ctx: AppContext, alertId: string): string {
  return ctx.db.get<{ summary: string }>('SELECT summary FROM content_alert WHERE id = ?', [alertId])?.summary ?? '';
}

export const REVIEW_KIND_SET: ReadonlySet<string> = new Set(REVIEW_QUEUE_KINDS);
