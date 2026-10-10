// Links between transcript segments and source pages / regions (§29). Every link says whether it is MANUAL (the
// owner made it) or AUTO (made by an automatic matcher). No automatic matcher exists in this version, so no auto link
// is ever created here — but the contract, the labels and the owner's controls over auto links (confirm / remove)
// are in place and tested. Removing a link is a tombstone (audited).
import { mediaLinkCreateSchema, pageDisplayLabel, type MediaLinkView } from '@medlevo/shared';
import type { AppContext } from '../../context';
import { AppError } from '../../lib/errors';
import { parseWith } from '../../lib/http';
import { newId } from '../../lib/ids';
import { clip } from '../cases/text';

interface LinkRow {
  id: string;
  from_type: 'transcript_segment' | 'annotation';
  from_id: string;
  to_region_id: string | null;
  to_page_id: string | null;
  origin: 'manual' | 'auto';
  created_at: number;
  confirmed_at: number | null;
  deleted_at: number | null;
  to_version_id: string | null;
  to_source_id: string | null;
}

export const LINK_ORIGIN_LABELS_AR = { manual: 'ربط يدوي (أنشأته أنت)', auto: 'ربط تلقائي — قابل للتعديل، تحقق منه' } as const;

function view(ctx: AppContext, l: LinkRow): MediaLinkView {
  const page = l.to_page_id
    ? ctx.db.get<{ page_index: number; printed_label: string | null; kind: string; version_id: string }>('SELECT page_index, printed_label, kind, version_id FROM source_page WHERE id = ?', [l.to_page_id])
    : null;
  const region = l.to_region_id ? ctx.db.get<{ text: string | null }>('SELECT text FROM source_region WHERE id = ?', [l.to_region_id]) : null;
  const src = l.to_source_id ? ctx.db.get<{ title: string }>('SELECT title FROM source WHERE id = ?', [l.to_source_id]) : null;
  return {
    id: l.id,
    from_type: l.from_type,
    from_id: l.from_id,
    source_id: l.to_source_id,
    source_title: src?.title ?? null,
    version_id: l.to_version_id ?? page?.version_id ?? null,
    page_id: l.to_page_id,
    page_index: page?.page_index ?? null,
    page_label_ar: page ? pageDisplayLabel({ page_index: page.page_index, printed_label: page.printed_label, kind: page.kind as never }) : null,
    region_id: l.to_region_id,
    region_preview: region?.text ? clip(region.text, 140) : null,
    origin: l.origin,
    origin_label_ar: l.origin === 'auto' && l.confirmed_at ? 'ربط تلقائي أكّدته' : LINK_ORIGIN_LABELS_AR[l.origin],
    confirmed: l.confirmed_at !== null,
    created_at: l.created_at,
  };
}

export function linksFrom(ctx: AppContext, fromType: LinkRow['from_type'], fromId: string): MediaLinkView[] {
  return ctx.db
    .all<LinkRow>('SELECT * FROM media_region_link WHERE from_type = ? AND from_id = ? AND deleted_at IS NULL ORDER BY created_at, id', [fromType, fromId])
    .map((l) => view(ctx, l));
}

function getLink(ctx: AppContext, id: string): LinkRow {
  const l = ctx.db.get<LinkRow>('SELECT * FROM media_region_link WHERE id = ?', [id]);
  if (!l || l.deleted_at !== null) throw new AppError('NOT_FOUND', 'الرابط غير موجود.', 404);
  return l;
}

/** Owner action: link a segment to a page or a region (origin 'manual'). Idempotent for the same target. */
export function createLink(ctx: AppContext, segmentId: string, body: unknown): MediaLinkView {
  const req = parseWith(mediaLinkCreateSchema, body, 'body');
  const seg = ctx.db.get<{ id: string; deleted_at: number | null }>('SELECT id, deleted_at FROM transcript_segment WHERE id = ?', [segmentId]);
  if (!seg || seg.deleted_at !== null) throw new AppError('NOT_FOUND', 'مقطع التفريغ غير موجود.', 404);
  let pageId: string | null = req.page_id ?? null;
  const regionId: string | null = req.region_id ?? null;
  if (regionId) {
    const r = ctx.db.get<{ page_id: string | null; version_id: string }>('SELECT page_id, version_id FROM source_region WHERE id = ?', [regionId]);
    if (!r) throw new AppError('NOT_FOUND', 'المنطقة المحددة غير موجودة.', 404);
    if (pageId && r.page_id && pageId !== r.page_id) throw new AppError('BAD_REQUEST', 'المنطقة لا تقع في الصفحة المحددة.', 400);
    pageId = r.page_id ?? pageId;
  }
  const page = pageId
    ? ctx.db.get<{ version_id: string; source_id: string; deleted_at: number | null }>(
        'SELECT p.version_id, v.source_id, s.deleted_at FROM source_page p JOIN source_version v ON v.id = p.version_id JOIN source s ON s.id = v.source_id WHERE p.id = ?',
        [pageId],
      )
    : null;
  if (pageId && !page) throw new AppError('NOT_FOUND', 'الصفحة المحددة غير موجودة.', 404);
  if (page?.deleted_at) throw new AppError('CONFLICT', 'مصدر هذه الصفحة في سلة المحذوفات.', 409);
  if (!pageId && !regionId) throw new AppError('BAD_REQUEST', 'اختر صفحة أو منطقة للربط.', 400);
  const existing = ctx.db.get<LinkRow>(
    `SELECT * FROM media_region_link WHERE from_type = 'transcript_segment' AND from_id = ? AND deleted_at IS NULL AND COALESCE(to_page_id,'') = ? AND COALESCE(to_region_id,'') = ?`,
    [segmentId, pageId ?? '', regionId ?? ''],
  );
  if (existing) return view(ctx, existing);
  const now = ctx.clock.now();
  const id = newId(now);
  ctx.db.tx(() => {
    ctx.db.run(
      `INSERT INTO media_region_link (id, from_type, from_id, to_region_id, to_page_id, origin, created_at, confirmed_at, deleted_at, to_version_id, to_source_id)
       VALUES (?, 'transcript_segment', ?, ?, ?, 'manual', ?, NULL, NULL, ?, ?)`,
      [id, segmentId, regionId, pageId, now, page?.version_id ?? null, page?.source_id ?? null],
    );
    ctx.audit.record({ entityType: 'media_region_link', entityId: id, action: 'create', summary: 'ربط مقطع صوتي بصفحة (يدوي)', after: { page_id: pageId, region_id: regionId }, actor: 'owner' });
  });
  return view(ctx, getLink(ctx, id));
}

export function removeLink(ctx: AppContext, id: string): void {
  const l = getLink(ctx, id);
  const now = ctx.clock.now();
  ctx.db.tx(() => {
    ctx.db.run('UPDATE media_region_link SET deleted_at = ? WHERE id = ?', [now, l.id]);
    ctx.audit.record({ entityType: 'media_region_link', entityId: l.id, action: 'trash', summary: `إزالة ${l.origin === 'auto' ? 'ربط تلقائي' : 'ربط يدوي'} بين مقطع صوتي وصفحة`, actor: 'owner' });
  });
}

/** The owner confirms an AUTO link: it stays labelled auto («ربط تلقائي أكّدته»). */
export function confirmLink(ctx: AppContext, id: string): MediaLinkView {
  const l = getLink(ctx, id);
  if (l.origin !== 'auto') throw new AppError('BAD_REQUEST', 'هذا ربط يدوي أنشأته بنفسك؛ لا يحتاج تأكيدًا.', 400);
  ctx.db.run('UPDATE media_region_link SET confirmed_at = COALESCE(confirmed_at, ?) WHERE id = ?', [ctx.clock.now(), id]);
  return view(ctx, getLink(ctx, id));
}

/** Reverse lookup for the reader: segments linked to a page / region / source (with play position). */
export function linksTo(ctx: AppContext, q: { page_id?: string; region_id?: string; source_id?: string }) {
  const where: string[] = [`l.deleted_at IS NULL`, `l.from_type = 'transcript_segment'`, `t.deleted_at IS NULL`];
  const params: unknown[] = [];
  if (q.page_id) {
    where.push('l.to_page_id = ?');
    params.push(q.page_id);
  }
  if (q.region_id) {
    where.push('l.to_region_id = ?');
    params.push(q.region_id);
  }
  if (q.source_id) {
    where.push('l.to_source_id = ?');
    params.push(q.source_id);
  }
  const rows = ctx.db.all<LinkRow & { audio_id: string; start_ms: number; end_ms: number; seg_text: string; corrected_text: string | null }>(
    `SELECT l.*, t.audio_id, t.start_ms, t.end_ms, t.text AS seg_text, t.corrected_text FROM media_region_link l JOIN transcript_segment t ON t.id = l.from_id
      WHERE ${where.join(' AND ')} ORDER BY t.start_ms LIMIT 200`,
    params,
  );
  return {
    links: rows.map((r) => ({ link: view(ctx, r), audio_id: r.audio_id, start_ms: r.start_ms, end_ms: r.end_ms, text: clip(r.corrected_text ?? r.seg_text, 200) })),
  };
}
