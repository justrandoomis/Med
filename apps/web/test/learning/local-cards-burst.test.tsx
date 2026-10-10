// Regression (I2 performance pass, docs/PERFORMANCE.md): the review hub / home / session read cards and events with two
// whole-table live queries, and every consumer re-folds all cards (FSRS) on each new set of rows. A first sync of 3 000
// cards + 12 000 events re-read both tables and re-folded everything after almost every pulled change (profiled in
// Chromium: > 50 % of the main thread; ~55 events/s). useLocalCards now coalesces bursts of writes, while a single
// write after a quiet period is still reflected at once.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { getDb } from '../../src/lib/localdb';
import { LOCAL_CARDS_RELOAD_MS, useLocalCards } from '../../src/features/review/local/hooks';

const card = (id: string) => ({ id, kind: 'basic' as const, front: null, back: null, origin: 'owner' as const, createdAt: 1, updatedAt: 1, syncState: 'synced' as const });
const event = (i: number) => ({ id: `E${i}`, cardId: 'C1', rating: 3 as const, reviewedAt: 1000 + i, updatedAt: 1, syncState: 'synced' as const });

beforeEach(async () => {
  const db = getDb();
  await db.open();
  await db.flashcards.clear();
  await db.reviewEvents.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('useLocalCards under a burst of writes', () => {
  it('coalesces 300 single-row writes into a handful of re-reads and ends with every row', async () => {
    const db = getDb();
    await db.flashcards.put(card('C1'));
    const reads = vi.spyOn(db.reviewEvents, 'toArray');
    const { result } = renderHook(() => useLocalCards());
    await waitFor(() => expect(result.current.ready).toBe(true));
    const before = reads.mock.calls.length;
    for (let i = 0; i < 300; i++) await db.reviewEvents.put(event(i)); // one transaction per row, like the sync pull
    await waitFor(() => expect(result.current.events.get('C1')?.length).toBe(300), { timeout: 5000 });
    const rereads = reads.mock.calls.length - before;
    expect(rereads).toBeGreaterThanOrEqual(1);
    expect(rereads).toBeLessThanOrEqual(12);
  });

  it('a single write after a quiet period is reflected at once (no waiting for the window)', async () => {
    const db = getDb();
    await db.flashcards.put(card('C1'));
    const { result } = renderHook(() => useLocalCards());
    await waitFor(() => expect(result.current.ready).toBe(true));
    await new Promise((r) => setTimeout(r, LOCAL_CARDS_RELOAD_MS + 50));
    const t0 = performance.now();
    await db.reviewEvents.put(event(1));
    await waitFor(() => expect(result.current.events.get('C1')?.length).toBe(1), { interval: 5 });
    expect(performance.now() - t0).toBeLessThan(LOCAL_CARDS_RELOAD_MS / 2);
    // a card written in the same quiet way shows up too (both tables are watched)
    await new Promise((r) => setTimeout(r, LOCAL_CARDS_RELOAD_MS + 50));
    await db.flashcards.put(card('C2'));
    await waitFor(() => expect(result.current.cards.map((c) => c.id).sort()).toEqual(['C1', 'C2']));
  });
});
