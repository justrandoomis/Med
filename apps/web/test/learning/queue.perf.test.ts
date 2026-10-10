// PERF (MEDLEVO_PERF=1): the device's review-queue fold on its own — 3 000 cards × 4 review events replayed with
// FSRS (ts-fsrs, the same parameters as the server) in Node/V8 on this container. No IndexedDB, no rendering: the
// browser number (e2e/perf.spec.ts) includes those. Run: MEDLEVO_PERF=1 npx vitest run test/learning/queue.perf.test.ts
import { describe, expect, it } from 'vitest';
import { computeQueue } from '../../src/features/review/local/queue';
import type { LocalCardRow, LocalEventRow } from '../../src/features/review/local/store';
import { srsConfigFixture } from './helpers';

const CARDS = Number(process.env.MEDLEVO_PERF_CARDS || 3000);
const EVENTS = 4;
const DAY = 86_400_000;

describe.skipIf(process.env.MEDLEVO_PERF !== '1')('perf: local review queue fold', () => {
  it(`folds ${CARDS} cards × ${EVENTS} events`, () => {
    const now = Date.UTC(2026, 9, 10, 9, 0, 0);
    const cfg = srsConfigFixture();
    const cards: LocalCardRow[] = [];
    const events = new Map<string, LocalEventRow[]>();
    for (let i = 0; i < CARDS; i++) {
      const id = `C${i}`;
      const created = now - 120 * DAY + i * 1000;
      cards.push({ id, kind: 'basic', front: null, back: null, origin: 'owner', createdAt: created, updatedAt: created, syncState: 'synced' } as LocalCardRow);
      events.set(
        id,
        [1, 4, 12, 40].slice(0, EVENTS).map((d, k) => ({ id: `E${i}-${k}`, cardId: id, rating: ((i + k) % 11 === 0 ? 1 : 3) as 1 | 3, reviewedAt: created + d * DAY, updatedAt: created, syncState: 'synced' }) as LocalEventRow),
      );
    }
    const runs: number[] = [];
    let due = 0;
    for (let r = 0; r < 5; r++) {
      const t0 = performance.now();
      const q = computeQueue({ params: cfg.params, daily_new_limit: 20, timezone: 'Asia/Baghdad' }, cards, events, now);
      runs.push(performance.now() - t0);
      due = q.counts.due_now;
    }
    expect(due).toBeGreaterThan(0);
    const sorted = [...runs].sort((a, b) => a - b);
    process.stdout.write(`\n[perf] local queue fold: ${CARDS} cards / ${CARDS * EVENTS} events → due_now ${due}; runs (ms) ${runs.map((x) => x.toFixed(0)).join(', ')}; median ${sorted[2]!.toFixed(0)} ms\n`);
  }, 120_000);
});
