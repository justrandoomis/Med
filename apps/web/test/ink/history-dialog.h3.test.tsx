// Round 7 — H3 item 1, the owner's side: after a reload the toolbar's «تراجع» works again (the command log came back
// from IndexedDB); a step that would bring back writing erased on another device opens a question instead of acting —
// «تخطَّ هذه الخطوة» leaves the writing erased, nothing is resurrected silently.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { annotationTargetKey, newId, type AnnotationAnchor, type InkPoint } from '@medlevo/shared';
import { InkProvider, InkToolbar } from '../../src/features/workspace/ink';
import { __resetStores, getDocumentStore } from '../../src/features/workspace/ink/store';
import { makeInkItem, transformItem } from '../../src/features/workspace/ink/model';
import { getDb } from '../../src/lib/localdb';

const anchor: AnnotationAnchor = { type: 'page', source_id: 'S-H3', version_id: 'V-H3', page_id: 'P-H3', page_index: 0, space: 'page_norm' };
const KEY = annotationTargetKey(anchor);
const AR = 842 / 595;

beforeEach(() => {
  __resetStores();
  window.localStorage.clear();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});
afterEach(() => __resetStores());

describe('H3 item 1 — undo after a reload, honest about writing erased elsewhere', () => {
  it('«تراجع» is enabled again after a reload; a step that would bring back erased writing asks first, «تخطَّ» keeps it erased', async () => {
    const doc = `doc-h3-${newId()}`;
    // a session: write a stroke and move it, then the app closes
    const first = getDocumentStore(doc);
    await first.historyReady;
    first.attachPage(KEY, anchor, AR);
    await first.whenLoaded(KEY);
    const points: InkPoint[] = Array.from({ length: 10 }, (_, i) => [0.1 + i * 0.03, 0.4, i * 8]);
    const s = makeInkItem({ id: newId(), anchor, now: 1, z: 1, style: { tool: 'pen', color: 'ink-blue', width: 0.0025 }, points, pressureAvailable: false, tiltAvailable: false, pointerType: 'mouse' });
    first.commit('كتابة', [{ id: s.id, targetKey: KEY, before: null, after: s }]);
    first.commit('نقل', [{ id: s.id, targetKey: KEY, before: s, after: transformItem(s, [1, 0, 0, 1, 0.1, 0], AR, 2) }]);
    await first.flush();
    await first.flushHistory();
    __resetStores();
    // another device erased the stroke; the pull stored the tombstone here
    await getDb().annotations.update(s.id, { deletedAt: 5, rev: 3, syncState: 'synced' });

    // the reader opens the document again
    render(
      <InkProvider documentKey={doc}>
        <InkToolbar />
      </InkProvider>,
    );
    const bar = screen.getByRole('toolbar', { name: 'أدوات الكتابة' });
    const undo = within(bar).getByRole('button', { name: 'تراجع' });
    await waitFor(() => expect(undo).toHaveProperty('disabled', false));
    fireEvent.click(undo);
    const dialog = await screen.findByRole('alertdialog', { name: /التراجع عن «نقل»/ });
    expect(dialog.textContent).toMatch(/يعيد عنصر واحد من كتابتك حُذف بعد هذه الخطوة/);
    expect(within(dialog).getByRole('button', { name: 'نفّذها وأعِد الكتابة' })).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'تخطَّ هذه الخطوة' }));
    });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    const store = getDocumentStore(doc);
    await store.flush();
    expect((await getDb().annotations.get(s.id))!.deletedAt).toBe(5);
    expect(store.history.undoLabel).toBe('كتابة');
  });
});
