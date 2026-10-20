// Round 7 — H3 item 7: a note page whose notebook was purged while a device wrote on it offline reached the server with
// neither a notebook nor a source and was listed NOWHERE (kept, but invisible). The library now shows «صفحات بلا دفتر»:
// the page, how much is written on it, «انقل إلى دفتر…» (one rev-checked upsert into the chosen notebook) and the trash
// (tombstone + restore). Nothing is deleted.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { AnnotationDTO, LibraryNodeView, NotePageView, OrphanNotePagesResponse } from '@medlevo/shared';
import { ToastProvider } from '../../../design';
import { api } from '../../../lib/api';
import { getDb } from '../../../lib/localdb';
import { buildIndex } from '../../library/model';
import type { WorkspaceNotePageRow } from '../data/local';
import { OrphanNotePages } from './OrphanNotePages';

const orphan: NotePageView = {
  id: 'NP1',
  node_id: null,
  source_id: null,
  after_page_index: null,
  after_page_id: null,
  title: 'ملاحظات القلب',
  template: 'ruled',
  kind: 'page',
  color: null,
  width: 595,
  height: 842,
  sort_order: 1,
  rev: 1,
  created_at: 1,
  updated_at: 2,
  deleted_at: null,
};
const stroke: AnnotationDTO = {
  id: 'A1',
  kind: 'ink',
  tool: 'pen',
  anchor: { type: 'note_page', note_page_id: 'NP1', space: 'page_norm' },
  data: { v: 1, points: [[0.1, 0.1, 0], [0.2, 0.2, 16]], style: { tool: 'pen', color: 'ink-blue', width: 0.0025 }, bbox: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 }, pressure_available: false, tilt_available: false },
  layer: 'ink',
  z: 0,
  locked: false,
  anchor_status: 'ok',
  previous_anchor: null,
  input: null,
  device_id: 'B',
  rev: 1,
  created_at: 1,
  updated_at: 1,
  deleted_at: null,
};
const notebook: LibraryNodeView = {
  id: 'NB2',
  parent_id: null,
  kind: 'notebook',
  title: 'دفتر القلب',
  description: null,
  color: null,
  icon: null,
  cover: null,
  template: null,
  sort_order: 1,
  sort_mode: 'manual',
  is_favorite: false,
  archived_at: null,
  deleted_at: null,
  created_at: 1,
  updated_at: 1,
  tags: [],
};

beforeEach(async () => {
  const db = getDb();
  await db.open();
  await Promise.all([db.notePages.clear(), db.annotations.clear(), db.outbox.clear()]);
  vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path === '/annotations/orphan-pages') return { note_pages: [orphan], annotations: [stroke] } satisfies OrphanNotePagesResponse;
    throw new Error(`unexpected ${path}`);
  });
});

function show() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <OrphanNotePages index={buildIndex([notebook], [])} />
      </ToastProvider>
    </MemoryRouter>,
  );
}

const ops = () => getDb().outbox.where('[entity_type+entity_id]').equals(['note_page', 'NP1']).sortBy('seq');

describe('«صفحات بلا دفتر» (H3 item 7)', () => {
  it('lists a page the server kept with neither link — also when this device still filed it under the purged notebook', async () => {
    // this device saw the page in its old notebook at the same revision (the purge removed that notebook)
    await getDb().notePages.put({ ...orphan, nodeId: 'DEAD', sourceId: null, afterPageIndex: null, sortOrder: 1, createdAt: 1, updatedAt: 1, deletedAt: null, syncState: 'synced', rev: 1 } as unknown as WorkspaceNotePageRow);
    show();
    const section = await screen.findByRole('region', { name: 'صفحات بلا دفتر' });
    expect(within(section).getByText('ملاحظات القلب')).toBeTruthy();
    await waitFor(() => expect(within(section).getByText(/عليها عنصر واحد/)).toBeTruthy());
    expect(within(section).getByText(/حُذف دفتر هذه الصفحات أو مصدرها نهائيًا/)).toBeTruthy();
  });

  it('«انقل إلى دفتر…» moves the page into the chosen notebook: one upsert naming the server rev, the page leaves the list', async () => {
    show();
    const section = await screen.findByRole('region', { name: 'صفحات بلا دفتر' });
    fireEvent.click(within(section).getByRole('button', { name: /انقل إلى دفتر/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('radio', { name: /دفتر القلب/ }));
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'انقل إلى هنا' }));
    });
    await waitFor(async () => expect(await ops()).toHaveLength(1));
    const [op] = await ops();
    expect(op).toMatchObject({ op: 'upsert', base_rev: 1, status: 'pending' });
    expect(op!.payload).toMatchObject({ id: 'NP1', node_id: 'NB2', source_id: null, title: 'ملاحظات القلب' });
    expect(await getDb().notePages.get('NP1')).toMatchObject({ nodeId: 'NB2', deletedAt: null });
    await waitFor(() => expect(screen.queryByRole('region', { name: 'صفحات بلا دفتر' })).toBeNull());
    // the writing stays with the page id (nothing copied, nothing removed)
    expect(await getDb().annotations.get('A1')).toMatchObject({ targetKey: 'note_page:NP1', deletedAt: null });
  });

  it('the trash is a tombstone with a restore list — never a removal', async () => {
    show();
    const section = await screen.findByRole('region', { name: 'صفحات بلا دفتر' });
    await act(async () => {
      fireEvent.click(within(section).getByRole('button', { name: 'انقل ملاحظات القلب إلى المحذوفات' }));
    });
    await waitFor(async () => expect((await ops()).map((o) => o.op)).toEqual(['delete']));
    expect((await getDb().notePages.get('NP1'))?.deletedAt).toBeTruthy();
    const toggle = await screen.findByRole('button', { name: /المحذوفة \(1\)/ });
    fireEvent.click(toggle);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'استعادة ملاحظات القلب' }));
    });
    await waitFor(async () => expect((await getDb().notePages.get('NP1'))?.deletedAt).toBeNull());
  });
});
