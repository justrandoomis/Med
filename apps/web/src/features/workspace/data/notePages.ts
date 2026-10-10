// Note pages — paper pages of a notebook, or inserted after a page of a source (§26, §5, track F1).
// Local-first like everything the owner writes (§47): every change is one IndexedDB row + its outbox op in ONE
// transaction (writeAndEnqueue) and never waits for the network. Deleting moves a page to the trash (a tombstone that
// keeps its ink); restoring is an upsert of the tombstoned page (the server restores it, «merged»).
import { useMemo } from 'react';
import { newId, type AnnotationsByTargetsResponse, type NotebookContentResponse, type NotePagesResponse, type NotePageTemplate, type NotePageView } from '@medlevo/shared';
import { api } from '../../../lib/api';
import type { MedLevoDB, OutboxRecord } from '../../../lib/localdb';
import { getDb } from '../../../lib/localdb';
import { writeAndEnqueue } from '../../../lib/sync';
import { useLive } from './hooks';
import { blockingOps, mergeServerAnnotations, notePageRowFromDTO, type WorkspaceNotePageRow } from './local';

/** A4 portrait in points — the size of a new paper page (the ink layer is resolution independent). */
export const NOTE_PAGE_SIZE = { width: 595, height: 842 } as const;
export const NOTE_PAGE_ENTITY = 'note_page';

export interface NewNotePage {
  nodeId?: string | null;
  sourceId?: string | null;
  /** inserted after this source page (index in its version, -1 = before the first page) … */
  afterPageIndex?: number | null;
  /** … and its id (placement survives a re-numbered version) */
  afterPageId?: string | null;
  template: NotePageTemplate;
  kind?: 'page' | 'divider';
  title?: string | null;
  color?: string | null;
  sortOrder: number;
  id?: string;
}

/** Full state of a note page as the server expects it (an upsert is never a partial patch — ops coalesce). */
export function notePagePayload(row: WorkspaceNotePageRow): Partial<NotePageView> {
  return {
    id: row.id,
    node_id: row.nodeId ?? null,
    source_id: row.sourceId ?? null,
    after_page_index: row.sourceId ? (row.afterPageIndex ?? null) : null,
    after_page_id: row.sourceId ? (row.afterPageId ?? null) : null,
    title: row.title ?? null,
    template: row.template,
    kind: row.kind ?? 'page',
    color: row.color ?? null,
    width: row.width,
    height: row.height,
    sort_order: row.sortOrder,
    created_at: row.createdAt,
  };
}

/**
 * The server rev a new op must name as base_rev: the last acknowledged rev advanced by every op still queued (the
 * first upsert creates rev 1, each later upsert / delete adds one). Without it a rename made while the page's create
 * is still queued would look stale and be rejected (note pages are «rejected with the server copy» on a stale edit).
 */
export async function expectedRev(db: MedLevoDB, entityType: string, id: string, rowRev: number | null | undefined): Promise<number | null> {
  const ops: OutboxRecord[] = await db.outbox.where('[entity_type+entity_id]').equals([entityType, id]).sortBy('seq');
  let rev: number | null = rowRev ?? null;
  for (const op of ops) {
    const er = (op.resultEntity as { rev?: unknown } | null | undefined)?.rev;
    if (typeof er === 'number' && (op.status === 'synced' || op.result === 'applied' || op.result === 'merged')) rev = Math.max(rev ?? 0, er);
  }
  for (const op of ops) {
    if (op.status !== 'pending') continue;
    if (op.op === 'append') rev = rev ?? 1;
    else rev = (op.base_rev ?? rev ?? 0) + 1;
  }
  return rev;
}

export async function createNotePage(db: MedLevoDB, input: NewNotePage): Promise<WorkspaceNotePageRow> {
  const now = Date.now();
  const row: WorkspaceNotePageRow = {
    id: input.id ?? newId(now),
    nodeId: input.nodeId ?? null,
    sourceId: input.sourceId ?? null,
    afterPageIndex: input.sourceId ? (input.afterPageIndex ?? null) : null,
    afterPageId: input.sourceId ? (input.afterPageId ?? null) : null,
    title: input.title?.trim() || null,
    template: input.template,
    kind: input.kind ?? 'page',
    color: input.color ?? null,
    width: NOTE_PAGE_SIZE.width,
    height: NOTE_PAGE_SIZE.height,
    sortOrder: input.sortOrder,
    rev: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    syncState: 'pending_sync',
  };
  await writeAndEnqueue(db, db.notePages, row, { entity_type: NOTE_PAGE_ENTITY, op: 'upsert', base_rev: null, payload: notePagePayload(row) });
  return row;
}

export type NotePagePatch = Partial<Pick<WorkspaceNotePageRow, 'title' | 'template' | 'sortOrder' | 'color' | 'afterPageIndex' | 'afterPageId' | 'kind'>>;

/** Rename, change the paper, move: one rev-checked upsert of the page's full state. */
export async function updateNotePage(db: MedLevoDB, row: WorkspaceNotePageRow, patch: NotePagePatch): Promise<WorkspaceNotePageRow> {
  return db.transaction('rw', [db.notePages, db.outbox], async () => {
    const cur = ((await db.notePages.get(row.id)) as WorkspaceNotePageRow | undefined) ?? row;
    const next: WorkspaceNotePageRow = { ...cur, ...patch, title: patch.title !== undefined ? patch.title?.trim() || null : cur.title, updatedAt: Date.now(), deletedAt: null };
    const base = await expectedRev(db, NOTE_PAGE_ENTITY, row.id, cur.rev);
    await writeAndEnqueue(db, db.notePages, next, { entity_type: NOTE_PAGE_ENTITY, op: 'upsert', base_rev: base, payload: notePagePayload(next) });
    return next;
  });
}

/** Move to the trash: a tombstone (its ink stays on the server and on this device; restore brings both back). */
export async function trashNotePage(db: MedLevoDB, row: WorkspaceNotePageRow): Promise<void> {
  await db.transaction('rw', [db.notePages, db.outbox], async () => {
    const cur = ((await db.notePages.get(row.id)) as WorkspaceNotePageRow | undefined) ?? row;
    const now = Date.now();
    const base = await expectedRev(db, NOTE_PAGE_ENTITY, row.id, cur.rev);
    await writeAndEnqueue(db, db.notePages, { ...cur, deletedAt: now, updatedAt: now }, { entity_type: NOTE_PAGE_ENTITY, op: 'delete', base_rev: base, payload: { id: row.id } });
  });
}

/**
 * Restore from the trash: an upsert of the full page. A page trashed before this device ever opened it has its writing
 * only on the server (seeding brings the ink of LIVE pages only), so — when online — this device fetches what is
 * written on it right away; «استُعيدت مع كتابتها» is then true here too. Offline it arrives with the next seeding.
 */
export async function restoreNotePage(db: MedLevoDB, row: WorkspaceNotePageRow, opts: { fetchInk?: (id: string) => Promise<unknown>; online?: () => boolean } = {}): Promise<WorkspaceNotePageRow> {
  const next = await updateNotePage(db, row, {});
  const online = opts.online ?? (() => typeof navigator === 'undefined' || navigator.onLine !== false);
  if (online()) void (opts.fetchInk ?? ((id: string) => fetchNotePageInk(id, db)))(row.id).catch(() => undefined);
  return next;
}

/** The (live) writing on one note page from the server, merged without overwriting unsynced local changes. */
export async function fetchNotePageInk(id: string, db: MedLevoDB = getDb()): Promise<number> {
  const r = await api.get<AnnotationsByTargetsResponse>('/annotations/by-targets', { query: { keys: `note_page:${id}` }, timeoutMs: 30_000, skipAuthRedirect: true });
  return mergeServerAnnotations(db, r.annotations);
}

// ───────── ordering (fractional sort_order: one upsert per move) ─────────
export function byOrder(a: Pick<WorkspaceNotePageRow, 'sortOrder' | 'createdAt' | 'id'>, b: Pick<WorkspaceNotePageRow, 'sortOrder' | 'createdAt' | 'id'>): number {
  return a.sortOrder - b.sortOrder || (a.createdAt ?? 0) - (b.createdAt ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** A sort order between two neighbours (either may be missing). */
export function sortOrderBetween(prev: number | null | undefined, next: number | null | undefined): number {
  if (prev == null && next == null) return 1;
  if (prev == null) return next! - 1;
  if (next == null) return prev + 1;
  if (next - prev > 1e-9) return (prev + next) / 2;
  return prev + 1e-6; // neighbours with equal orders: still after prev (ties fall back to creation time)
}

export function sortOrderAtEnd(rows: ReadonlyArray<Pick<WorkspaceNotePageRow, 'sortOrder'>>): number {
  return rows.reduce((m, r) => Math.max(m, r.sortOrder), 0) + 1;
}

/** New sort order that moves `id` one place earlier (-1) or later (+1) among `rows`; null at the edge. */
export function movedSortOrder(rows: ReadonlyArray<WorkspaceNotePageRow>, id: string, dir: -1 | 1): number | null {
  const list = [...rows].sort(byOrder);
  const i = list.findIndex((r) => r.id === id);
  if (i < 0) return null;
  const j = i + dir;
  if (j < 0 || j >= list.length) return null;
  // between the neighbour we jump over and the one beyond it
  return dir < 0 ? sortOrderBetween(list[j - 1]?.sortOrder, list[j]!.sortOrder) : sortOrderBetween(list[j]!.sortOrder, list[j + 1]?.sortOrder);
}

// ───────── server seeding (never overwrites a page with unsynced local changes) ─────────
export async function mergeServerNotePages(db: MedLevoDB, list: readonly NotePageView[]): Promise<number> {
  let written = 0;
  await db.transaction('rw', [db.notePages, db.outbox], async () => {
    for (const p of list) {
      const ops = await db.outbox.where('[entity_type+entity_id]').equals([NOTE_PAGE_ENTITY, p.id]).filter((o) => o.status !== 'synced').toArray();
      if (blockingOps(ops).length > 0) continue;
      const cur = await db.notePages.get(p.id);
      if (cur && (cur.rev ?? 0) >= p.rev) continue;
      await db.notePages.put(notePageRowFromDTO(p));
      written++;
    }
  });
  return written;
}

export function fetchNotebook(nodeId: string): Promise<NotebookContentResponse> {
  return api.get<NotebookContentResponse>(`/annotations/notebook/${encodeURIComponent(nodeId)}`, { timeoutMs: 30_000, skipAuthRedirect: true });
}

export function fetchNotePages(q: { nodeId?: string; sourceId?: string; includeDeleted?: boolean }): Promise<NotePagesResponse> {
  return api.get<NotePagesResponse>('/annotations/note-pages', {
    query: { ...(q.nodeId ? { node_id: q.nodeId } : {}), ...(q.sourceId ? { source_id: q.sourceId } : {}), ...(q.includeDeleted ? { include_deleted: '1' } : {}) },
    timeoutMs: 30_000,
    skipAuthRedirect: true,
  });
}

/** Seed this device with a notebook's pages (trashed ones too, for the restore list) and their writing. */
export async function seedNotebook(nodeId: string, db: MedLevoDB = getDb()): Promise<void> {
  const [content, all] = await Promise.all([fetchNotebook(nodeId), fetchNotePages({ nodeId, includeDeleted: true })]);
  await mergeServerNotePages(db, all.note_pages);
  await mergeServerAnnotations(db, content.annotations);
}

// ───────── live views ─────────
export function useNotePagesOfNode(nodeId: string | null): WorkspaceNotePageRow[] {
  return useLive(
    async () => (nodeId ? ((await getDb().notePages.where('nodeId').equals(nodeId).toArray()) as WorkspaceNotePageRow[]).sort(byOrder) : []),
    [nodeId],
    [],
  );
}

export function useNotePagesOfSource(sourceId: string | null): WorkspaceNotePageRow[] {
  return useLive(
    async () => (sourceId ? ((await getDb().notePages.where('sourceId').equals(sourceId).toArray()) as WorkspaceNotePageRow[]).sort(byOrder) : []),
    [sourceId],
    [],
  );
}

/** Live (not trashed) / trashed split of a list. */
export function useSplitTrash(rows: WorkspaceNotePageRow[]): { live: WorkspaceNotePageRow[]; trashed: WorkspaceNotePageRow[] } {
  return useMemo(() => ({ live: rows.filter((r) => !r.deletedAt), trashed: rows.filter((r) => !!r.deletedAt).sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0)) }), [rows]);
}
