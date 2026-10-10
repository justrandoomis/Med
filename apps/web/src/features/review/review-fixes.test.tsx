// Regression tests for the independent review of the learning web track (L2):
//  * a session on an explicit card list (e.g. the Weakness Center's «راجع البطاقات التي نسيتها») whose cards are not
//    due yet used to end at once with nothing reviewed — the owner can now opt in to an early review, asked once;
//  * a rating whose send was attempted and failed says so (undo stays refused — it may be on the server);
//  * the session's «back» link accepts in-app paths only (`/\host` is another site for browsers);
//  * a «للمراجعة» mark in the Review hub names its book (the selection toolbar never knows the title).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { newId, type SrsParams } from '@medlevo/shared';
import { ToastProvider } from '../../design';
import { setFetchImpl } from '../../lib/api';
import { getDb, MedLevoDB } from '../../lib/localdb';
import { cardView, clearDb, routeFetch, srsConfigFixture } from '../../../test/learning/helpers';
import fixture from '../../../test/learning/fixtures/srs-parity.json';
import { CardReviewer } from './components/CardReviewer';
import { ReviewSession } from './ReviewSession';
import { ReviewHub } from './ReviewHub';
import { addRevisionMark } from './local/revisionMarks';
import { computeQueue } from './local/queue';
import { UNDO_ATTEMPTED_AR, UNDO_SENT_AR, eventsByCard, putServerCards, recordRating, undoCheck, type LocalCardRow, type LocalEventRow } from './local/store';

const T = { timeout: 5000 };
const params = (fixture as { cases: Array<{ params: SrsParams }> }).cases[0]!.params;
const cfg = { params, daily_new_limit: 20, timezone: 'Asia/Baghdad' };

beforeEach(async () => {
  await clearDb();
});
afterEach(() => setFetchImpl(null));

/** A card answered «Easy» an hour ago: in review, due in days — not due now. */
async function seedNotDueCard(db: MedLevoDB, id: string, now: number) {
  await putServerCards(db, [cardView(id, { created_at: now - 2 * 3_600_000 })]);
  const ev: LocalEventRow = { id: newId(now - 3_600_000), cardId: id, rating: 4, reviewedAt: now - 3_600_000, durationMs: null, createdAt: now, updatedAt: now, syncState: 'synced' };
  await db.reviewEvents.put(ev);
}

describe('explicit card lists: review ahead only when the owner opts in, and only once', () => {
  it('queue: chosen cards that are not due are counted, asked after opting in, and not asked again once reviewed', async () => {
    const db = getDb();
    const now = Date.UTC(2026, 9, 10, 9, 0);
    await seedNotDueCard(db, 'C1', now);
    const cards = () => db.flashcards.toArray() as Promise<LocalCardRow[]>;

    const plain = computeQueue(cfg, await cards(), await eventsByCard(db), now, { cardIds: ['C1'] });
    expect(plain.items).toHaveLength(0); // the old behaviour stays the default: nothing is asked early by itself
    expect(plain.counts.ahead).toBe(1);

    const optedIn = now + 1000;
    const ahead = computeQueue(cfg, await cards(), await eventsByCard(db), now + 2000, { cardIds: ['C1'], aheadSince: optedIn });
    expect(ahead.items.map((i) => [i.card.id, i.reason])).toEqual([['C1', 'ahead']]);
    expect(ahead.items[0]!.reason_ar).toMatch(/^مراجعة مبكرة اخترتها: موعدها بعد/);

    await recordRating(db, { cardId: 'C1', rating: 3, reviewedAt: now + 3000 }, now + 3000);
    const after = computeQueue(cfg, await cards(), await eventsByCard(db), now + 4000, { cardIds: ['C1'], aheadSince: optedIn });
    expect(after.items).toHaveLength(0); // reviewed since opting in → not asked again until it is really due
    expect(after.counts.ahead).toBe(0);

    // the normal queue (no explicit list) never offers early reviews
    const normal = computeQueue(cfg, await cards(), await eventsByCard(db), now + 4000, { aheadSince: optedIn });
    expect(normal.counts.ahead).toBe(0);
    expect(normal.items).toHaveLength(0);
  });

  it('reviewer: the session on a chosen, not-due card offers «راجعها الآن قبل موعدها»; one rating, then done', async () => {
    const db = getDb();
    const now = Date.now();
    await seedNotDueCard(db, 'C1', now);
    setFetchImpl(routeFetch({ '/learning/srs-config': srsConfigFixture() }).fn as never);
    render(
      <MemoryRouter>
        <ToastProvider>
          <CardReviewer cardIds={['C1']} />
        </ToastProvider>
      </MemoryRouter>,
    );
    await screen.findByText('انتهت بطاقات هذه الجلسة', undefined, T);
    expect(screen.getByText(/بطاقة واحدة من البطاقات المختارة لم يحن موعدها بعد/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'راجعها الآن قبل موعدها' }));
    await screen.findByText('Question C1?', undefined, T);
    expect(screen.getByText(/مراجعة مبكرة اخترتها/)).toBeTruthy();
    fireEvent.keyDown(window, { key: ' ' });
    await screen.findByText('Answer C1.', undefined, T);
    fireEvent.keyDown(window, { key: '3' });
    await screen.findByText('انتهت بطاقات هذه الجلسة', undefined, T);
    await waitFor(async () => expect(await db.reviewEvents.count()).toBe(2), T);
    expect(screen.queryByRole('button', { name: 'راجعها الآن قبل موعدها' })).toBeNull();
  }, 20_000);

  it('the daily queue (no explicit list) never shows the early-review offer', async () => {
    const db = getDb();
    await seedNotDueCard(db, 'C1', Date.now());
    setFetchImpl(routeFetch({ '/learning/srs-config': srsConfigFixture() }).fn as never);
    render(
      <MemoryRouter>
        <ToastProvider>
          <CardReviewer />
        </ToastProvider>
      </MemoryRouter>,
    );
    await screen.findByText('لا بطاقات مستحقة الآن', undefined, T);
    expect(screen.queryByRole('button', { name: 'راجعها الآن قبل موعدها' })).toBeNull();
  });
});

describe('undo after a failed send', () => {
  it('says the send was attempted (it may be on the server) — still refused; a plain sent op keeps the old reason', async () => {
    const db = getDb();
    await putServerCards(db, [cardView('C1')]);
    const ev = await recordRating(db, { cardId: 'C1', rating: 3, reviewedAt: 1_000 }, 1_000);
    const op = (await db.outbox.toArray())[0]!;
    await db.outbox.update(op.seq!, { sentAt: 2_000 });
    expect(await undoCheck(db, ev.id)).toEqual({ possible: false, reason_ar: UNDO_SENT_AR });
    await db.outbox.update(op.seq!, { attempts: 1, lastError: 'تعذّر الاتصال بالخادم.' });
    expect(await undoCheck(db, ev.id)).toEqual({ possible: false, reason_ar: UNDO_ATTEMPTED_AR });
    expect(await db.reviewEvents.get(ev.id)).toBeDefined();
  });
});

describe('session «back» link', () => {
  function renderSession(back: string) {
    setFetchImpl(routeFetch({ '/learning/srs-config': srsConfigFixture() }).fn as never);
    return render(
      <MemoryRouter initialEntries={[`/review/session?back=${encodeURIComponent(back)}`]}>
        <ToastProvider>
          <ReviewSession />
        </ToastProvider>
      </MemoryRouter>,
    );
  }
  it('refuses /\\host (another site for browsers) and //host; keeps in-app paths', async () => {
    const a = renderSession('/\\evil.example');
    expect(screen.getByRole('link', { name: /إنهاء الجلسة/ }).getAttribute('href')).toBe('/review');
    a.unmount();
    const b = renderSession('//evil.example');
    expect(screen.getByRole('link', { name: /إنهاء الجلسة/ }).getAttribute('href')).toBe('/review');
    b.unmount();
    renderSession('/weakness');
    expect(screen.getByRole('link', { name: /إنهاء الجلسة/ }).getAttribute('href')).toBe('/weakness');
  });
});

describe('Review hub revision marks', () => {
  it('name the book of each mark from the library (the mark itself carries no title)', async () => {
    const db = getDb();
    await addRevisionMark(db, { type: 'page', source_id: 'S1', version_id: 'V1', page_id: 'P3', page_index: 2, space: 'page_norm' }, { quote: 'The appendix …', pageLabel: 'ص 3', sourceTitle: null });
    setFetchImpl(
      routeFetch({
        '/learning/srs-config': srsConfigFixture(),
        '/library/tree': { nodes: [], sources: [{ id: 'S1', title: 'Acute Appendicitis' }] },
      }).fn as never,
    );
    render(
      <MemoryRouter>
        <ToastProvider>
          <ReviewHub />
        </ToastProvider>
      </MemoryRouter>,
    );
    await screen.findByText('مقاطع أضفتها للمراجعة من الكتاب', undefined, T);
    const where = await waitFor(() => {
      const el = document.querySelector('.lw-mark__where');
      expect(el?.textContent).toBe('Acute Appendicitis — ص 3');
      return el!;
    }, T);
    expect(where.closest('a')?.getAttribute('href')).toBe('/study/S1?v=V1&page_id=P3');
  });
});
