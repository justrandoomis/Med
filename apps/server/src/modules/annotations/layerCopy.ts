// «انسخ الطبقة» — copy ONE layer (Academic OS P1-T2 step 2; PRD AOS-4.11 Phase 1; ARCHITECTURE_DELTA §6.6, §7.5).
//
//  * A preview counts what would be copied, per kind and per page, the pictures it references (bytes are shared, never
//    duplicated), what an earlier run already copied and what cannot be copied (with the reason). Nothing is written.
//  * The copy writes NEW rows with derived ids (sha256 of target layer + source item), so a second run copies nothing
//    twice and never revives a copy the owner erased since; `migrated_from_id` = the source item, `origin` =
//    'layer_copy', and one `attribution` row per copied item (the original author, the chain of hops). The source
//    layer and its items are never changed.
//  * Same document: anchors are kept. Another document (another copy of the same lecture): source pages are matched
//    by position when both versions have the same number of pages; anything else is listed as skipped — page matching
//    across different versions comes with P1-T3's page map (BUILD_PLAN §3.4 step 3).
//  * Runs in one transaction (all or nothing). Measured on the 5 000-stroke page in test/annotations/layer-copy.test.ts.
import { createHash } from 'node:crypto';
import {
  defaultPersonalLayerId,
  parseDocumentKey,
  VAULT_SELF_USER,
  type AnnotationAnchor,
  type CopyKindFilter,
  type CopyLayersResponse,
  type CopyPreview,
  type UserRef,
} from '@medlevo/shared';
import type { z } from 'zod';
import type { copyLayersRequestSchema } from '@medlevo/shared';
import type { AppContext } from '../../context';
import { fromJson, toJson } from '../../db/db';
import { AppError } from '../../lib/errors';
import { ANNOTATION_DOC_SQL, DEFAULT_LAYER_TITLE_AR, getLayer, NOTE_DOC_SQL, resolveTargetLayer, type LayerRow } from './layers';
import { indexNote, pageLabelAr, writeAnnotationTarget, type AnnotationRow, type NoteRow, type PageInfoRow } from './repo';

type Req = z.output<typeof copyLayersRequestSchema>;

interface Endpoint {
  /** the layer's id (a default layer's derived id) */
  id: string;
  /** stored `layer_id` of its items (NULL for the default layer) */
  storedId: string | null;
  documentKey: string;
  row: LayerRow | null;
}

function resolveSourceLayer(ctx: AppContext, id: string, documentKey: string | undefined): Endpoint {
  const row = getLayer(ctx.db, id);
  if (row && row.deleted_at === null) {
    const isDefault = id === defaultPersonalLayerId(row.document_key);
    return { id, storedId: isDefault ? null : id, documentKey: row.document_key, row };
  }
  if (!row && documentKey && defaultPersonalLayerId(documentKey) === id) return { id, storedId: null, documentKey, row: null };
  throw new AppError('NOT_FOUND', 'الطبقة المراد نسخها غير موجودة.', 404);
}

/** the kind filter bucket of an item */
function bucketOf(kind: string, layer: string | null): CopyKindFilter {
  if (kind === 'note') return 'note';
  if (kind === 'ink' && layer === 'highlight') return 'highlight';
  if (kind === 'underline') return 'text_highlight';
  return kind as CopyKindFilter;
}

/** derived, stable id of the copy of `sourceId` in the target layer (a re-run finds it again) */
export function copyIdOf(targetLayerKey: string, sourceId: string): string {
  return `lc_${createHash('sha256').update(`layer_copy|${targetLayerKey}|${sourceId}`).digest('hex').slice(0, 26)}`;
}

interface Candidate {
  type: 'annotation' | 'note';
  row: AnnotationRow | NoteRow;
  bucket: CopyKindFilter;
  anchor: AnnotationAnchor | null;
  /** the anchor the copy gets, or the reason it cannot be copied */
  mapped: { anchor: AnnotationAnchor | null } | { skip: string };
  targetKey: string | null;
}

const SKIP_PAGES_DIFFER = 'صفحات النسختين لا تتطابق في العدد؛ مطابقة الصفحات بين إصدارين مختلفين تأتي مع ميزة نقل الملاحظات إلى الإصدار الجديد.';
const SKIP_NOTE_PAGE = 'صفحات الملاحظات المضافة وكتاب الدراسة لا تُنسخ إلى مستند آخر بعد؛ تبقى في نسختك الأصلية.';

/** Maps a page anchor of the source document onto the target document (another copy of the same lecture). */
function pageMapper(ctx: AppContext, targetDoc: string) {
  const target = parseDocumentKey(targetDoc);
  const targetVersion =
    target?.type === 'source'
      ? ctx.db.get<{ id: string; page_count: number | null }>(
          `SELECT v.id, (SELECT COUNT(*) FROM source_page p WHERE p.version_id = v.id) AS page_count FROM source s JOIN source_version v ON v.id = s.current_version_id WHERE s.id = ?`,
          [target.id],
        )
      : undefined;
  const pagesByIndex = new Map<number, string>();
  if (targetVersion) {
    for (const p of ctx.db.all<{ id: string; page_index: number }>('SELECT id, page_index FROM source_page WHERE version_id = ?', [targetVersion.id])) pagesByIndex.set(p.page_index, p.id);
  }
  const countOf = new Map<string, number>();
  return (anchor: AnnotationAnchor | null): { anchor: AnnotationAnchor | null } | { skip: string } => {
    if (!anchor) return { anchor: null };
    if (anchor.type !== 'page' || !target || target.type !== 'source' || !targetVersion) return { skip: SKIP_NOTE_PAGE };
    let n = countOf.get(anchor.version_id);
    if (n === undefined) {
      n = ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM source_page WHERE version_id = ?', [anchor.version_id])!.n;
      countOf.set(anchor.version_id, n);
    }
    const pageId = pagesByIndex.get(anchor.page_index);
    if (n !== targetVersion.page_count || !pageId) return { skip: SKIP_PAGES_DIFFER };
    return { anchor: { type: 'page', source_id: target.id, version_id: targetVersion.id, page_id: pageId, page_index: anchor.page_index, space: 'page_norm' } };
  };
}

function targetKeyOf(anchor: AnnotationAnchor | null): string | null {
  if (!anchor) return null;
  if (anchor.type === 'page') return `source_page:${anchor.page_id}`;
  if (anchor.type === 'note_page') return `note_page:${anchor.note_page_id}`;
  return `artifact_block:${anchor.lineage_id}:${anchor.block_key}`;
}

function pageLabel(ctx: AppContext, targetKey: string): string {
  const [type, id] = [targetKey.slice(0, targetKey.indexOf(':')), targetKey.slice(targetKey.indexOf(':') + 1)];
  if (type === 'source_page') {
    const p = ctx.db.get<PageInfoRow>('SELECT id, version_id, page_index, printed_label, kind FROM source_page WHERE id = ?', [id]);
    return p ? pageLabelAr(ctx.db, p) : 'صفحة';
  }
  if (type === 'note_page') {
    const t = ctx.db.get<{ title: string | null }>('SELECT title FROM note_page WHERE id = ?', [id])?.title;
    return t ? `صفحة ملاحظات: ${t}` : 'صفحة ملاحظات';
  }
  return 'كتاب الدراسة';
}

function collect(ctx: AppContext, from: Endpoint, targetDoc: string, req: Req): Candidate[] {
  const db = ctx.db;
  const annCond = from.storedId === null ? `a.layer_id IS NULL AND ${ANNOTATION_DOC_SQL('a')} = ?` : 'a.layer_id = ?';
  const noteCond = from.storedId === null ? `n.layer_id IS NULL AND ${NOTE_DOC_SQL('n')} = ?` : 'n.layer_id = ?';
  const param = from.storedId === null ? from.documentKey : from.storedId;
  const kinds = req.kinds ? new Set<CopyKindFilter>(req.kinds) : null;
  const pages = req.page_ids ? new Set(req.page_ids) : null;
  const sameDoc = targetDoc === from.documentKey;
  const map = sameDoc ? (a: AnnotationAnchor | null) => ({ anchor: a }) : pageMapper(ctx, targetDoc);
  const out: Candidate[] = [];
  const keep = (anchor: AnnotationAnchor | null) => {
    if (!pages) return true;
    if (!anchor) return false;
    return (anchor.type === 'page' && pages.has(anchor.page_id)) || (anchor.type === 'note_page' && pages.has(anchor.note_page_id));
  };
  for (const r of db.all<AnnotationRow>(`SELECT a.* FROM annotation a WHERE ${annCond} AND a.deleted_at IS NULL ORDER BY a.created_at, a.id`, [param])) {
    const bucket = bucketOf(r.kind, r.layer);
    if (kinds && !kinds.has(bucket)) continue;
    const anchor = fromJson<AnnotationAnchor>(r.anchor_json) ?? null;
    if (!keep(anchor)) continue;
    const mapped = map(anchor);
    out.push({ type: 'annotation', row: r, bucket, anchor, mapped, targetKey: targetKeyOf('anchor' in mapped ? mapped.anchor : anchor) });
  }
  if (!kinds || kinds.has('note')) {
    for (const r of db.all<NoteRow>(`SELECT n.* FROM note n WHERE ${noteCond} AND n.deleted_at IS NULL ORDER BY n.created_at, n.id`, [param])) {
      const anchor = r.anchor_json ? (fromJson<AnnotationAnchor>(r.anchor_json) ?? null) : null;
      if (!keep(anchor)) continue;
      // a note with no anchor lives in its notebook: copied only inside the same document
      const mapped = !anchor && !sameDoc ? { skip: SKIP_NOTE_PAGE } : map(anchor);
      out.push({ type: 'note', row: r, bucket: 'note', anchor, mapped, targetKey: targetKeyOf('anchor' in mapped ? mapped.anchor : anchor) });
    }
  }
  return out;
}

function exists(ctx: AppContext, type: 'annotation' | 'note', id: string): boolean {
  return !!ctx.db.get(`SELECT 1 AS x FROM ${type} WHERE id = ?`, [id]);
}

interface Chain {
  author_user_id: string;
  author_display: string;
  derived_from: Array<Record<string, unknown>>;
}
function attributionOf(ctx: AppContext, type: 'annotation' | 'note', row: AnnotationRow | NoteRow, from: Endpoint): Chain {
  const prev = ctx.db.get<{ author_user_id: string; author_display: string; derived_from_json: string }>('SELECT author_user_id, author_display, derived_from_json FROM attribution WHERE entity_type = ? AND entity_id = ?', [type, row.id]);
  // a followed / published layer says who wrote it and from which publication (origin_json, written by the feed)
  const origin = fromJson<{ author_user_id?: string | null; author_display?: string | null; publication_id?: string | null; version_no?: number | null; space_id?: string | null }>(from.row?.origin_json ?? null) ?? {};
  const hop = { space_id: origin.space_id ?? null, publication_id: origin.publication_id ?? null, version_no: origin.version_no ?? null, item_id: row.id, layer_id: from.id, document_key: from.documentKey };
  if (prev) return { author_user_id: prev.author_user_id, author_display: prev.author_display, derived_from: [...(fromJson<Array<Record<string, unknown>>>(prev.derived_from_json) ?? []), hop] };
  const author = row.author_user_id ?? VAULT_SELF_USER;
  const named = author !== VAULT_SELF_USER && origin.author_user_id === author && typeof origin.author_display === 'string' && origin.author_display.trim() ? origin.author_display.trim() : null;
  return { author_user_id: author, author_display: author === VAULT_SELF_USER ? 'أنت' : (named ?? 'كاتب آخر'), derived_from: [hop] };
}

/** Preview (`preview: true`) or copy one layer. */
export function copyLayer(ctx: AppContext, req: Req, opts: { deviceId: string | null }): CopyLayersResponse {
  const from = resolveSourceLayer(ctx, req.from_layer_ids[0]!, req.document_key);
  const targetDoc = req.into.document_key ?? from.documentKey;
  const target = parseDocumentKey(targetDoc);
  if (!target) throw new AppError('VALIDATION_FAILED', 'مفتاح المستند غير صالح.', 400);
  // (P1-T2 review) a document that does not exist (a typo, a lecture purged meanwhile) never gets a layer: no purge of a
  // document that is already gone would ever remove it
  const targetRow = ctx.db.get(target.type === 'source' ? 'SELECT 1 AS x FROM source WHERE id = ?' : 'SELECT 1 AS x FROM library_node WHERE id = ?', [target.id]);
  if (!targetRow) throw new AppError('NOT_FOUND', 'المستند المراد النسخ إليه غير موجود؛ لم يُنسخ شيء.', 404);

  // the target layer (an existing one, a never-renamed default, or a new one named by the owner)
  let into: Endpoint;
  let createTitle: string | null = null;
  if ('layer_id' in req.into) {
    const verdict = resolveTargetLayer(ctx.db, req.into.layer_id, targetDoc);
    if (!verdict.ok) throw new AppError('LAYER_READ_ONLY', verdict.detail, 409, { detail_code: verdict.code });
    const row = getLayer(ctx.db, req.into.layer_id);
    if (!row && req.into.layer_id !== defaultPersonalLayerId(targetDoc)) throw new AppError('NOT_FOUND', 'الطبقة المراد النسخ إليها غير موجودة.', 404);
    into = { id: req.into.layer_id, storedId: verdict.layerId, documentKey: targetDoc, row: row ?? null };
  } else {
    createTitle = req.into.new_title;
    const id = `ly_${createHash('sha256').update(`new_layer|${from.id}|${targetDoc}|${createTitle}`).digest('hex').slice(0, 26)}`;
    const row = getLayer(ctx.db, id);
    into = { id, storedId: id, documentKey: targetDoc, row: row ?? null };
  }
  if (into.id === from.id && into.documentKey === from.documentKey) throw new AppError('VALIDATION_FAILED', 'اختر طبقة غير الطبقة المنسوخة.', 400);
  const targetLayerKey = into.storedId ?? `default:${targetDoc}`;

  const candidates = collect(ctx, from, targetDoc, req);
  const byKind: Record<string, number> = {};
  const byPage = new Map<string, number>();
  const skipped = new Map<string, number>();
  const images = new Set<string>();
  const authors = new Map<string, UserRef>();
  let already = 0;
  const toCopy: Array<Candidate & { newId: string; anchorOut: AnnotationAnchor | null }> = [];
  for (const c of candidates) {
    if ('skip' in c.mapped) {
      skipped.set(c.mapped.skip, (skipped.get(c.mapped.skip) ?? 0) + 1);
      continue;
    }
    const newId = copyIdOf(targetLayerKey, c.row.id);
    if (exists(ctx, c.type, newId)) {
      already++;
      continue;
    }
    toCopy.push({ ...c, newId, anchorOut: c.mapped.anchor });
    byKind[c.bucket] = (byKind[c.bucket] ?? 0) + 1;
    if (c.targetKey) byPage.set(c.targetKey, (byPage.get(c.targetKey) ?? 0) + 1);
    if (c.type === 'annotation' && (c.row as AnnotationRow).kind === 'image') {
      const key = (fromJson<{ image_key?: string }>((c.row as AnnotationRow).data_json) ?? {}).image_key;
      if (key) images.add(key);
    }
    const a = attributionOf(ctx, c.type, c.row, from);
    if (!authors.has(a.author_user_id)) authors.set(a.author_user_id, { id: a.author_user_id, display_name: a.author_display, avatar_url: null });
  }
  const preview: CopyPreview = {
    items: toCopy.length,
    by_kind: byKind,
    pages: byPage.size,
    by_page: [...byPage].map(([target_key, items]) => ({ target_key, label_ar: pageLabel(ctx, target_key), items })),
    images: images.size,
    already_copied: already,
    skipped: [...skipped].map(([reason_ar, items]) => ({ reason_ar, items })),
    attributions: [...authors.values()],
    into_layer_id: into.row || 'layer_id' in req.into ? into.id : null,
  };
  if (req.preview) return { preview };

  const now = ctx.clock.now();
  const device = opts.deviceId ?? 'server';
  ctx.db.tx(() => {
    if (createTitle !== null && !into.row) {
      // after the document's other layers: a small ordinal (devices accept |sort_order| ≤ 1e12; a timestamp is larger)
      const sortOrder = (ctx.db.get<{ m: number | null }>('SELECT MAX(sort_order) AS m FROM annotation_layer WHERE document_key = ? AND ABS(sort_order) < 1e9', [targetDoc])?.m ?? 0) + 1;
      ctx.db.run(
        `INSERT INTO annotation_layer (id, document_key, kind, title, owner_user_id, writable, frozen, origin_json, visible, locked, color, sort_order, rev, device_id, created_at, updated_at, deleted_at)
         VALUES (?, ?, 'personal', ?, NULL, 1, 0, ?, 1, 0, NULL, ?, 1, ?, ?, ?, NULL)`,
        [into.id, targetDoc, createTitle, toJson({ copied_from_layer_id: from.id, copied_from_document_key: from.documentKey }), Math.max(1, sortOrder), device, now, now],
      );
      ctx.db.run(
        `INSERT OR IGNORE INTO attribution (entity_type, entity_id, author_user_id, author_display, derived_from_json, created_at) VALUES ('annotation_layer', ?, ?, ?, ?, ?)`,
        [into.id, VAULT_SELF_USER, from.row?.title ?? DEFAULT_LAYER_TITLE_AR, toJson([{ space_id: null, publication_id: null, version_no: null, item_id: from.id, layer_id: from.id, document_key: from.documentKey }]), now],
      );
      ctx.sync.touch('annotation_layer', into.id);
    } else if (into.row && into.row.deleted_at !== null) {
      throw new AppError('NOT_FOUND', 'الطبقة المراد النسخ إليها محذوفة.', 404);
    }
    for (const c of toCopy) {
      const chain = attributionOf(ctx, c.type, c.row, from);
      if (c.type === 'annotation') {
        const r = c.row as AnnotationRow;
        ctx.db.run(
          `INSERT INTO annotation (id, kind, tool, anchor_json, data_json, layer, z, locked, anchor_status, previous_anchor_json, input_json, device_id, rev, created_at, updated_at, deleted_at,
                                   conflict_of_id, layer_id, author_user_id, migrated_from_id, origin)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 1, ?, ?, NULL, NULL, ?, NULL, ?, 'layer_copy')`,
          [c.newId, r.kind, r.tool, toJson(c.anchorOut), r.data_json, r.layer, r.z, r.locked, r.anchor_status, r.input_json, device, now, now, into.storedId, r.id],
        );
        writeAnnotationTarget(ctx.db, c.newId, c.anchorOut!);
        if (r.kind === 'image') {
          const key = (fromJson<{ image_key?: string }>(r.data_json) ?? {}).image_key;
          if (key) ctx.db.run('UPDATE annotation_image SET referenced = 1, released_at = NULL WHERE image_key = ?', [key]);
        }
        ctx.sync.touch('annotation', c.newId);
      } else {
        const r = c.row as NoteRow;
        const anchor = c.anchorOut;
        const sourceId = anchor?.type === 'page' ? anchor.source_id : anchor ? r.source_id : r.source_id;
        const targetKey = anchor ? targetKeyOf(anchor) : null;
        ctx.db.run(
          `INSERT INTO note (id, node_id, title, body_json, anchor_json, origin, ai_record_json, rev, base_rev, conflict_of_id, device_id, created_at, updated_at, deleted_at,
                             source_id, anchor_target_key, layer_id, author_user_id, migrated_from_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL, NULL, ?, ?, ?, NULL, ?, ?, ?, NULL, ?)`,
          [c.newId, r.node_id, r.title, r.body_json, anchor ? toJson(anchor) : null, r.origin, r.ai_record_json, device, now, now, sourceId, targetKey, into.storedId, r.id],
        );
        indexNote(ctx.db, { id: c.newId, title: r.title, body: fromJson(r.body_json) ?? { v: 1, paragraphs: [] }, origin: r.origin, deleted: false });
        ctx.sync.touch('note', c.newId);
      }
      ctx.db.run(
        `INSERT OR IGNORE INTO attribution (entity_type, entity_id, author_user_id, author_display, derived_from_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        [c.type, c.newId, chain.author_user_id, chain.author_display, toJson(chain.derived_from), now],
      );
    }
    ctx.audit.record({
      entityType: 'annotation_layer',
      entityId: into.id,
      action: 'layer_copy',
      summary: `نُسخت ${toCopy.length} من عناصر طبقة «${from.row?.title ?? DEFAULT_LAYER_TITLE_AR}» إلى «${into.row?.title ?? createTitle ?? DEFAULT_LAYER_TITLE_AR}» (لم تتغير الطبقة الأصلية).`,
      before: null,
      after: { from_layer_id: from.id, from_document_key: from.documentKey, into_layer_id: into.id, into_document_key: targetDoc, copied: toCopy.length, already_copied: already, by_kind: byKind },
    });
  });
  return { preview: { ...preview, into_layer_id: into.id }, result: { into_layer_id: into.id, copied: toCopy.length, already_copied: already } };
}
