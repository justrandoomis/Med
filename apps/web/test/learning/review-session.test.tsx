// Review session keyboard flow and offline behaviour (§43, §55, AC-23, AC-24): Space reveals, 1–4 rate (nothing before
// the answer is shown), each rating is a local review_event + outbox op (no network needed), the next card follows,
// Ctrl+Z withdraws the last rating while it is unsent, the interval previews come from the local FSRS fold. Image
// occlusion: the front never contains the hidden part's name (DOM text, attributes, image alt or URL).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { richTextFromPlain } from '@medlevo/shared';
import { ToastProvider } from '../../src/design';
import { setFetchImpl } from '../../src/lib/api';
import { getDb } from '../../src/lib/localdb';
import { CardReviewer } from '../../src/features/review/components/CardReviewer';
import { CardFace } from '../../src/features/review/components/CardFace';
import { putServerCards, storeCardImage, type LocalCardRow } from '../../src/features/review/local/store';
import { cardView, clearDb, routeFetch, srsConfigFixture } from './helpers';

const T = { timeout: 5000 };

beforeEach(async () => {
  await clearDb();
});
afterEach(() => {
  setFetchImpl(null);
});

function renderReviewer() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <CardReviewer />
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe('flashcard review: keyboard flow, local-first ratings, undo before sync', () => {
  it('Space reveals, 1–4 rate, the rating is stored locally with its op, the next card follows; Ctrl+Z withdraws it', async () => {
    const t = Date.UTC(2026, 8, 1);
    await putServerCards(getDb(), [cardView('C1', { created_at: t }), cardView('C2', { created_at: t + 1000 })]);
    const net = routeFetch({ '/learning/srs-config': srsConfigFixture() });
    setFetchImpl(net.fn as never);
    renderReviewer();

    await screen.findByText('Question C1?', undefined, T);
    expect(screen.queryByText('Answer C1.')).toBeNull();
    // rating before the answer is shown does nothing
    fireEvent.keyDown(window, { key: '3' });
    expect(await getDb().reviewEvents.count()).toBe(0);

    fireEvent.keyDown(window, { key: ' ' });
    await screen.findByText('Answer C1.', undefined, T);
    const group = screen.getByRole('group', { name: 'قيّم تذكّرك' });
    expect(group.querySelectorAll('button')).toHaveLength(4);
    // previews from the local fold (a new card rated Good → 10 minutes)
    expect(screen.getByRole('button', { name: /جيد.*Good.*بعد 10 دقائق/ })).toBeTruthy();

    fireEvent.keyDown(window, { key: '3' });
    await screen.findByText('Question C2?', undefined, T);
    const events = await getDb().reviewEvents.toArray();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ cardId: 'C1', rating: 3 });
    const ops = await getDb().outbox.toArray();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ entity_type: 'review_event', op: 'append', status: 'pending', payload: { card_id: 'C1', rating: 3 } });
    // the only network call was the (optional) configuration refresh — the rating itself never touched the network
    expect(net.calls.every((c) => c.url.includes('/learning/srs-config'))).toBe(true);

    // undo while unsent
    await screen.findByRole('button', { name: 'تراجع (قبل المزامنة فقط)' }, T);
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    await screen.findByText('Answer C1.', undefined, T);
    expect(await getDb().reviewEvents.count()).toBe(0);
    expect(await getDb().outbox.count()).toBe(0);
  }, 20_000);

  it('once the rating was handed to the network, undo is refused and says why', async () => {
    await putServerCards(getDb(), [cardView('C1'), cardView('C2')]);
    setFetchImpl(routeFetch({ '/learning/srs-config': srsConfigFixture() }).fn as never);
    renderReviewer();
    await screen.findByText('Question C1?', undefined, T);
    fireEvent.keyDown(window, { key: 'Enter' });
    await screen.findByText('Answer C1.', undefined, T);
    fireEvent.keyDown(window, { key: '4' });
    await screen.findByText('Question C2?', undefined, T);
    const op = (await getDb().outbox.toArray())[0]!;
    await act(async () => {
      await getDb().outbox.update(op.seq!, { sentAt: Date.now() });
    });
    await screen.findByText(/أُرسل هذا التقييم إلى الخادم، فلا يمكن التراجع عنه/, undefined, T);
    expect(screen.queryByRole('button', { name: 'تراجع (قبل المزامنة فقط)' })).toBeNull();
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    await waitFor(async () => expect(await getDb().reviewEvents.count()).toBe(1), T);
  });

  it('works offline from the saved configuration (the server cannot be reached)', async () => {
    const db = getDb();
    await putServerCards(db, [cardView('C1')]);
    await db.kv.put({ key: 'learning.srs-config', value: { config: srsConfigFixture(), fetchedAt: 1 }, updatedAt: 1 });
    setFetchImpl((() => Promise.reject(new TypeError('Failed to fetch'))) as never);
    renderReviewer();
    await screen.findByText('Question C1?', undefined, T);
    fireEvent.keyDown(window, { key: ' ' });
    fireEvent.click(await screen.findByRole('button', { name: /صعب/ }, T));
    await waitFor(async () => expect(await db.reviewEvents.count()).toBe(1), T);
    expect((await db.reviewEvents.toArray())[0]).toMatchObject({ cardId: 'C1', rating: 2 });
  });

  it('without a saved configuration and offline, it says it cannot schedule (no guessed schedule)', async () => {
    await putServerCards(getDb(), [cardView('C1')]);
    setFetchImpl((() => Promise.reject(new TypeError('Failed to fetch'))) as never);
    renderReviewer();
    await screen.findByText('لا يمكن جدولة المراجعة على هذا الجهاز بعد', undefined, T);
    expect(screen.queryByText('Question C1?')).toBeNull();
  });

  it('a configuration whose parity sample does not reproduce is refused', async () => {
    const cfg = srsConfigFixture();
    cfg.parity_check = { ...cfg.parity_check, expected: { ...cfg.parity_check.expected, due_at: cfg.parity_check.expected.due_at + 1 } };
    await putServerCards(getDb(), [cardView('C1')]);
    setFetchImpl(routeFetch({ '/learning/srs-config': cfg }).fn as never);
    renderReviewer();
    await screen.findByText('جدولة هذا الجهاز لا تطابق الخادم', undefined, T);
  });
});

describe('image occlusion review never leaks the answer on the front', () => {
  it('no mask label in text, attributes, alt or URL; the back reveals it', async () => {
    const created = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:medlevo/neutral');
    (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => undefined;
    const db = getDb();
    const masks = [
      { id: 'caecum', box: { x: 0.1, y: 0.1, w: 0.2, h: 0.1 }, label: 'Caecum' },
      { id: 'ileum', box: { x: 0.5, y: 0.5, w: 0.2, h: 0.1 }, label: 'Ileum' },
    ];
    const view = cardView('O1', {
      kind: 'image_occlusion',
      front: richTextFromPlain('ما اسم الجزء المخفي في المنطقة المحددة؟'),
      back: richTextFromPlain('Caecum'),
      image: { image_asset_id: 'IMG1', masks, active_mask_id: 'caecum' },
      kind_label_ar: 'إخفاء جزء من صورة (Image Occlusion)',
    });
    await putServerCards(db, [view]);
    await storeCardImage(db, 'IMG1', new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }), 'S1');
    const row = (await db.flashcards.get('O1')) as LocalCardRow;
    setFetchImpl((() => Promise.reject(new TypeError('offline'))) as never);

    const front = render(<CardFace card={row} side="front" />);
    const img = await screen.findByRole('img', undefined, T);
    expect(img.getAttribute('alt')).toBe('صورة البطاقة؛ المنطقة المطلوب تسميتها محددة بإطار مميز.');
    expect(img.getAttribute('src')).toBe('blob:medlevo/neutral');
    const html = front.container.innerHTML.toLowerCase();
    expect(html).not.toContain('caecum');
    expect(html).not.toContain('ileum');
    expect(front.container.textContent).toContain('المطلوب: المنطقة 1 من 2');
    front.unmount();

    const back = render(<CardFace card={row} side="back" />);
    await screen.findByRole('img', undefined, T);
    expect(back.container.textContent).toContain('Caecum');
    created.mockRestore();
  });
});
