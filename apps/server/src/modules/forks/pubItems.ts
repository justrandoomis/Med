// The content model of a publication (P1-T5 step 3; ARCHITECTURE_DELTA §6.4, §4.4 `3050_publications`; ADR-0004 §2.4).
//
//  * A publication version n is the set of `publication_item` rows of the subject's space with valid_from ≤ n and
//    (valid_to IS NULL or valid_to > n). Each item keeps ONE stable id in every version and in every follower's vault:
//    `stableItemId(publication_id, author_item_id)`.
//  * The canonical row is what the author wrote and what a reader needs to draw it — kind, tool, anchor, data, render
//    class, z for annotations; title, body, anchor, origin for notes. Its sha256 (`content_hash`) decides «changed».
//    Nothing of the author's vault rides along: no device, no rev, no history, no layer id, no file.
//  * Pure helpers over a space handle (`Db`): reads and diffs. Writes happen in publications.ts (space) and
//    following.ts (a reader's vault).
import { createHash } from 'node:crypto';
import {
  inkDataForClient,
  stableStringify,
  type AnnotationAnchor,
  type AnnotationDTO,
  type NoteDTO,
  type ReanchorPageRef,
  type RichText,
  type UpstreamPreview,
  upstreamSummaryAr,
} from '@medlevo/shared';
import type { Db } from '../../db/db';
import { fromJson } from '../../db/db';
import { pageLabelAr } from '../annotations/repo';

export interface CanonicalAnnotation {
  t: 'annotation';
  kind: AnnotationDTO['kind'];
  tool: string | null;
  anchor: AnnotationAnchor;
  data: AnnotationDTO['data'];
  layer: AnnotationDTO['layer'];
  z: number;
}

export interface CanonicalNote {
  t: 'note';
  title: string | null;
  body: RichText;
  anchor: AnnotationAnchor | null;
  origin: NoteDTO['origin'];
}

export type CanonicalItem = CanonicalAnnotation | CanonicalNote;

export interface PublicationItemRow {
  publication_id: string;
  item_id: string;
  valid_from: number;
  valid_to: number | null;
  entity_type: 'annotation' | 'note' | 'note_page';
  content_hash: string;
  row_json: string;
  source_crop: number;
}

export interface PublicationVersionRow {
  id: string;
  publication_id: string;
  version_no: number;
  lecture_id: string;
  lecture_version_id: string;
  author_user_id: string;
  change_note: string | null;
  item_count: number;
  pages_covered: number;
  pages_total: number;
  content_hash: string;
  created_at: number;
  author_layer_ids_json: string;
  skipped_json: string;
}

/** The one id an item keeps in every version of a publication and in every follower's vault. */
export function stableItemId(publicationId: string, authorItemId: string): string {
  return `pi_${createHash('sha256').update(`publication_item|${publicationId}|${authorItemId}`).digest('hex').slice(0, 26)}`;
}

/** A fork's own id for an item it copied (never the stable id: the fork is the user's, independent of the source). */
export function forkItemId(copyId: string, itemId: string): string {
  return `fk_${createHash('sha256').update(`fork_item|${copyId}|${itemId}`).digest('hex').slice(0, 26)}`;
}

export function hashItem(item: CanonicalItem): string {
  return createHash('sha256').update(stableStringify(item)).digest('hex');
}

/** sha256 over the canonical item list of a version (sorted by stable id): the same content ⇒ the same hash. */
export function hashVersion(items: ReadonlyArray<{ item_id: string; content_hash: string }>): string {
  const h = createHash('sha256');
  for (const i of [...items].sort((a, b) => (a.item_id < b.item_id ? -1 : a.item_id > b.item_id ? 1 : 0))) h.update(`${i.item_id}:${i.content_hash}\n`);
  return h.digest('hex');
}

export function parseItem(row: Pick<PublicationItemRow, 'row_json'>): CanonicalItem {
  return fromJson<CanonicalItem>(row.row_json) as CanonicalItem;
}

/** The page an item sits on (null for a note without an anchor or a non-page anchor). */
export function pageOf(item: CanonicalItem): string | null {
  const a = item.anchor;
  return a && a.type === 'page' ? a.page_id : null;
}

export function versionRow(space: Db, publicationId: string, versionNo: number): PublicationVersionRow | null {
  return space.get<PublicationVersionRow>('SELECT * FROM publication_version WHERE publication_id = ? AND version_no = ?', [publicationId, versionNo]) ?? null;
}

export function versionRows(space: Db, publicationId: string): PublicationVersionRow[] {
  return space.all<PublicationVersionRow>('SELECT * FROM publication_version WHERE publication_id = ? ORDER BY version_no', [publicationId]);
}

/** The items valid at version n, by stable id. */
export function itemsAt(space: Db, publicationId: string, versionNo: number): Map<string, PublicationItemRow> {
  const rows = space.all<PublicationItemRow>(
    'SELECT * FROM publication_item WHERE publication_id = ? AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?) ORDER BY item_id',
    [publicationId, versionNo, versionNo],
  );
  return new Map(rows.map((r) => [r.item_id, r]));
}

export interface ItemDiff {
  added: PublicationItemRow[];
  removed: PublicationItemRow[];
  changed: Array<{ before: PublicationItemRow; after: PublicationItemRow }>;
}

/** What changes from version `from` to version `to` (either direction; `from` = 0 means «nothing yet»). */
export function diffVersions(space: Db, publicationId: string, from: number, to: number): ItemDiff {
  const a = from > 0 ? itemsAt(space, publicationId, from) : new Map<string, PublicationItemRow>();
  const b = itemsAt(space, publicationId, to);
  const out: ItemDiff = { added: [], removed: [], changed: [] };
  for (const [id, row] of b) {
    const old = a.get(id);
    if (!old) out.added.push(row);
    else if (old.content_hash !== row.content_hash) out.changed.push({ before: old, after: row });
  }
  for (const [id, row] of a) if (!b.has(id)) out.removed.push(row);
  return out;
}

/** A page of the space as the update preview names it («ص 12»). */
export function pageRef(space: Db, pageId: string): ReanchorPageRef | null {
  const p = space.get<{
    id: string;
    version_id: string;
    page_index: number;
    printed_label: string | null;
    kind: 'page' | 'slide' | 'image' | 'docx_section' | 'audio_segment';
    thumbnail_file_id: string | null;
    render_file_id: string | null;
    format: string | null;
    display_file_id: string | null;
  }>(
    `SELECT p.id, p.version_id, p.page_index, p.printed_label, p.kind, p.thumbnail_file_id, p.render_file_id, v.format, v.display_file_id
       FROM source_page p LEFT JOIN source_version v ON v.id = p.version_id WHERE p.id = ?`,
    [pageId],
  );
  if (!p) return null;
  // a picture exists when the page has one stored, or a PDF page the thumbnail route renders (lectures/index.ts)
  const renderable = (p.kind === 'page' || p.kind === 'slide') && (p.format === 'pdf' || !!p.display_file_id);
  return { page_id: p.id, page_index: p.page_index, label_ar: pageLabelAr(space, p), thumbnail: !!p.thumbnail_file_id || !!p.render_file_id || renderable };
}

/** Items of a version as the reader's DTOs (stable ids, the author, the student-content origin). */
export function toDtos(
  rows: Iterable<PublicationItemRow>,
  opts: { authorUserId: string; createdAt: number; inkFormat?: 1 | 2 },
): { items: AnnotationDTO[]; notes: NoteDTO[] } {
  const items: AnnotationDTO[] = [];
  const notes: NoteDTO[] = [];
  for (const r of rows) {
    const c = parseItem(r);
    if (c.t === 'annotation') {
      items.push({
        id: r.item_id,
        kind: c.kind,
        tool: c.tool,
        anchor: c.anchor,
        data: opts.inkFormat === 2 ? inkDataForClient(c.kind, c.data, 2) : c.data,
        layer: c.layer,
        z: c.z,
        locked: false,
        anchor_status: 'ok',
        previous_anchor: null,
        input: null,
        device_id: null,
        rev: r.valid_from,
        created_at: opts.createdAt,
        updated_at: opts.createdAt,
        deleted_at: null,
        detached_at: null,
        author_user_id: opts.authorUserId,
        origin: 'publish_copy',
      } as AnnotationDTO);
    } else {
      notes.push({
        id: r.item_id,
        node_id: null,
        title: c.title,
        body: c.body,
        anchor: c.anchor,
        origin: c.origin,
        ai_record: null,
        rev: r.valid_from,
        conflict_of_id: null,
        device_id: null,
        created_at: opts.createdAt,
        updated_at: opts.createdAt,
        deleted_at: null,
        previous_anchor: null,
        detached_at: null,
        author_user_id: opts.authorUserId,
      } as NoteDTO);
    }
  }
  return { items, notes };
}

/** What changes from version `from` to `to` (counts and pages); the personal layer is never part of it. */
export function upstreamPreview(space: Db, publicationId: string, from: number, to: number): UpstreamPreview {
  const d = from === to ? { added: [], removed: [], changed: [] } : diffVersions(space, publicationId, from, to);
  const pages = new Map<string, { added: number; removed: number; changed: number }>();
  const bump = (pageId: string | null, k: 'added' | 'removed' | 'changed') => {
    if (!pageId) return;
    const p = pages.get(pageId) ?? { added: 0, removed: 0, changed: 0 };
    p[k]++;
    pages.set(pageId, p);
  };
  for (const r of d.added) bump(pageOf(parseItem(r)), 'added');
  for (const r of d.removed) bump(pageOf(parseItem(r)), 'removed');
  for (const c of d.changed) {
    const before = pageOf(parseItem(c.before));
    const after = pageOf(parseItem(c.after));
    bump(after ?? before, 'changed');
    if (before && after && before !== after) bump(before, 'changed');
  }
  const refs = [...pages.entries()]
    .map(([pageId, c]) => ({ page: pageRef(space, pageId), ...c }))
    .filter((p): p is { page: NonNullable<ReturnType<typeof pageRef>>; added: number; removed: number; changed: number } => !!p.page)
    .sort((a, b) => a.page.page_index - b.page.page_index);
  const counts = { added: d.added.length, removed: d.removed.length, changed: d.changed.length };
  const v = from === to ? null : versionRow(space, publicationId, to);
  return {
    publication_id: publicationId,
    from_version_no: from,
    to_version_no: to,
    change_note: v?.change_note ?? null,
    counts,
    pages: refs,
    personal_items_affected: 0,
    summary_ar: upstreamSummaryAr(counts, refs.filter((p) => p.added > 0).length),
  };
}
