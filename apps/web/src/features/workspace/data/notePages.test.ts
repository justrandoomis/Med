// Note pages on this device (track F1, §26 / §47): every change is an IndexedDB row + its outbox op in one transaction,
// never waits for the network; edits made while the create is still queued coalesce (one op, full state); once the
// server acknowledged a revision, the next edit names it as base_rev (never mistaken for a stale edit); trash is a
// tombstone + delete op; restore is an upsert; server seeding never overwrites a page with unsynced changes.
import { beforeEach, describe, expect, it } from 'vitest';
import { newId, type NotePageView } from '@medlevo/shared';
import { MedLevoDB } from '../../../lib/localdb';
import type { WorkspaceNotePageRow } from './local';
import { createNotePage, expectedRev, mergeServerNotePages, movedSortOrder, restoreNotePage, sortOrderAtEnd, sortOrderBetween, trashNotePage, updateNotePage } from './notePages';

let db: MedLevoDB;
beforeEach(async () => {
  db = new MedLevoDB(`notepages-${newId()}`);
  await db.open();
});

const ops = (id: string) => db.outbox.where('[entity_type+entity_id]').equals(['note_page', id]).sortBy('seq');

/** the server acknowledged every pending op (as the sync engine records it) */
async function ack(id: string, rev: number) {
  for (const o of await ops(id)) {
    if (o.status !== 'pending') continue;
    await db.outbox.update(o.seq!, { status: 'synced', sentAt: Date.now(), result: 'applied', resultEntity: { id, rev } });
  }
  await db.notePages.update(id, { rev });
}

describe('note pages, local-first', () => {
  it('creates a notebook page: row + one upsert op with the full state, no network', async () => {
    const row = await createNotePage(db, { nodeId: 'NODE', template: 'ruled', title: '  خلاصة  ', sortOrder: 3 });
    expect(await db.notePages.get(row.id)).toMatchObject({ nodeId: 'NODE', sourceId: null, template: 'ruled', title: 'خلاصة', kind: 'page', width: 595, height: 842, syncState: 'pending_sync' });
    const [op] = await ops(row.id);
    expect(op).toMatchObject({ op: 'upsert', base_rev: null, status: 'pending' });
    expect(op!.payload).toMatchObject({ id: row.id, node_id: 'NODE', source_id: null, after_page_index: null, template: 'ruled', kind: 'page', sort_order: 3 });
  });

  it('a page placed in a source keeps its source page; placement fields are dropped for notebook pages', async () => {
    const inSource = await createNotePage(db, { sourceId: 'S1', afterPageIndex: 4, afterPageId: 'P4', template: 'dotted', sortOrder: 1 });
    expect((await ops(inSource.id))[0]!.payload).toMatchObject({ source_id: 'S1', after_page_index: 4, after_page_id: 'P4' });
    const inBook = await createNotePage(db, { nodeId: 'N', afterPageIndex: 4, afterPageId: 'P4', template: 'blank', sortOrder: 1 });
    expect((await ops(inBook.id))[0]!.payload).toMatchObject({ after_page_index: null, after_page_id: null });
  });

  it('a rename while the create is still queued coalesces into the same op (full state, never a partial patch)', async () => {
    const row = await createNotePage(db, { nodeId: 'NODE', template: 'ruled', sortOrder: 1 });
    await updateNotePage(db, row, { title: 'عنوان' });
    await updateNotePage(db, row, { template: 'grid' });
    const list = await ops(row.id);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ op: 'upsert', base_rev: null });
    expect(list[0]!.payload).toMatchObject({ title: 'عنوان', template: 'grid', node_id: 'NODE' });
  });

  it('after the server acknowledged rev 1, an edit names base_rev 1; one queued behind a sent op names rev + 1', async () => {
    const row = await createNotePage(db, { nodeId: 'NODE', template: 'ruled', sortOrder: 1 });
    await ack(row.id, 1);
    await updateNotePage(db, row, { title: 'أ' });
    expect((await ops(row.id)).at(-1)).toMatchObject({ op: 'upsert', base_rev: 1, status: 'pending' });
    // the op is on its way (sent, unanswered): a later edit must not coalesce into it and builds on rev 2
    const sent = (await ops(row.id)).at(-1)!;
    await db.outbox.update(sent.seq!, { sentAt: Date.now() });
    await updateNotePage(db, row, { title: 'ب' });
    const last = (await ops(row.id)).at(-1)!;
    expect(last.op_id).not.toBe(sent.op_id);
    expect(last.base_rev).toBe(2);
    expect(await expectedRev(db, 'note_page', row.id, 1)).toBe(3);
  });

  it('trash is a tombstone + delete op; restore is an upsert of the full page (its ink is never touched)', async () => {
    const row = await createNotePage(db, { nodeId: 'NODE', template: 'ruled', sortOrder: 1, title: 'صفحة' });
    await ack(row.id, 1);
    await trashNotePage(db, row);
    const trashed = (await db.notePages.get(row.id)) as WorkspaceNotePageRow;
    expect(trashed.deletedAt).toBeTruthy();
    expect((await ops(row.id)).at(-1)).toMatchObject({ op: 'delete', base_rev: 1 });
    await restoreNotePage(db, trashed);
    expect((await db.notePages.get(row.id))!.deletedAt).toBeNull();
    const last = (await ops(row.id)).at(-1)!;
    expect(last).toMatchObject({ op: 'upsert', base_rev: 2 });
    expect(last.payload).toMatchObject({ title: 'صفحة', template: 'ruled' });
  });

  it('server seeding: newer server rows land; a page with unsynced local changes is never overwritten', async () => {
    const mine = await createNotePage(db, { nodeId: 'NODE', template: 'ruled', sortOrder: 1, title: 'محلي' });
    const server = (id: string, title: string, rev = 3): NotePageView => ({
      id,
      node_id: 'NODE',
      source_id: null,
      after_page_index: null,
      title,
      template: 'grid',
      width: 595,
      height: 842,
      sort_order: 2,
      rev,
      created_at: 1,
      updated_at: 2,
      deleted_at: null,
      kind: 'divider',
      color: 'teal',
      after_page_id: null,
    });
    const otherId = newId();
    expect(await mergeServerNotePages(db, [server(mine.id, 'من الخادم'), server(otherId, 'قسم')])).toBe(1);
    expect((await db.notePages.get(mine.id))!.title).toBe('محلي');
    expect(await db.notePages.get(otherId)).toMatchObject({ title: 'قسم', kind: 'divider', color: 'teal', rev: 3, syncState: 'synced' });
    // an older copy never replaces a newer one
    expect(await mergeServerNotePages(db, [server(otherId, 'قديم', 2)])).toBe(0);
  });
});

describe('ordering', () => {
  it('sort orders between neighbours, at the end, and for a move up / down', () => {
    expect(sortOrderBetween(1, 2)).toBe(1.5);
    expect(sortOrderBetween(null, 5)).toBe(4);
    expect(sortOrderBetween(5, null)).toBe(6);
    expect(sortOrderBetween(null, null)).toBe(1);
    expect(sortOrderBetween(3, 3)).toBeGreaterThan(3);
    const rows = [1, 2, 3, 4].map((n) => ({ id: `R${n}`, sortOrder: n, createdAt: n }) as WorkspaceNotePageRow);
    expect(sortOrderAtEnd(rows)).toBe(5);
    expect(movedSortOrder(rows, 'R3', -1)).toBe(1.5); // between R1 and R2
    expect(movedSortOrder(rows, 'R2', 1)).toBe(3.5); // between R3 and R4
    expect(movedSortOrder(rows, 'R4', 1)).toBeNull(); // already the last page
    expect(movedSortOrder(rows, 'R1', -1)).toBeNull();
  });
});
