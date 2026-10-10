// Regenerates srs-parity.json from the SERVER's FSRS fold (apps/server/src/modules/learning/srs.ts), so the web's
// local fold is tested against the exact algorithm the server uses (same ts-fsrs, same params, same replay rules).
// Usage (repo root): NODE_OPTIONS='--disable-warning=ExperimentalWarning' npx tsx apps/web/test/learning/fixtures/make-srs-fixture.mjs
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { foldReviews, previewIntervals, srsParams, toStateView, TS_FSRS_VERSION } from '../../../../server/src/modules/learning/srs.ts';

const here = dirname(fileURLToPath(import.meta.url));
const MIN = 60_000;
const DAY = 86_400_000;
const created = Date.UTC(2026, 8, 1, 7, 30, 0);

const ev = (id, rating, t) => ({ id, rating, reviewed_at: t });
const cases = [
  { name: 'new card, no events', retention: 0.9, created_at: created, events: [], resets: [], at: created + DAY },
  {
    name: 'learning steps then review',
    retention: 0.9,
    created_at: created,
    events: [ev('01E0000000000000000000000A', 3, created + MIN), ev('01E0000000000000000000000B', 3, created + 11 * MIN), ev('01E0000000000000000000000C', 3, created + 4 * DAY)],
    resets: [],
    at: created + 10 * DAY,
  },
  {
    name: 'lapse and relearning',
    retention: 0.9,
    created_at: created,
    events: [
      ev('01E0000000000000000000001A', 4, created + 2 * MIN),
      ev('01E0000000000000000000001B', 1, created + 9 * DAY),
      ev('01E0000000000000000000001C', 2, created + 9 * DAY + 10 * MIN),
      ev('01E0000000000000000000001D', 3, created + 9 * DAY + 25 * MIN),
    ],
    resets: [],
    at: created + 12 * DAY,
  },
  {
    name: 'duplicate ids fold once, ties by id',
    retention: 0.9,
    created_at: created,
    events: [
      ev('01E0000000000000000000002B', 3, created + 5 * MIN),
      ev('01E0000000000000000000002A', 1, created + 5 * MIN),
      ev('01E0000000000000000000002B', 3, created + 5 * MIN),
      ev('01E0000000000000000000002C', 3, created + 2 * DAY),
    ],
    resets: [],
    at: created + 3 * DAY,
  },
  {
    name: 'relearn marker (reset) keeps history',
    retention: 0.9,
    created_at: created,
    events: [ev('01E0000000000000000000003A', 3, created + MIN), ev('01E0000000000000000000003B', 4, created + 3 * DAY), ev('01E0000000000000000000003C', 3, created + 20 * DAY)],
    resets: [created + 10 * DAY, created + 20 * DAY],
    at: created + 25 * DAY,
  },
  {
    name: 'desired retention 0.85',
    retention: 0.85,
    created_at: created,
    events: [ev('01E0000000000000000000004A', 3, created + MIN), ev('01E0000000000000000000004B', 3, created + 15 * MIN), ev('01E0000000000000000000004C', 2, created + 6 * DAY), ev('01E0000000000000000000004D', 4, created + 30 * DAY)],
    resets: [],
    at: created + 45 * DAY,
  },
  {
    name: 'many reviews over months',
    retention: 0.9,
    created_at: created,
    events: Array.from({ length: 12 }, (_, i) => ev(`01E00000000000000000005${String.fromCharCode(65 + i)}0`, [3, 3, 4, 2, 3, 1, 3, 3, 4, 3, 2, 3][i], created + Math.round(i * i * 1.7 * DAY) + i * 7 * MIN)),
    resets: [],
    at: created + 400 * DAY,
  },
];

const out = cases.map((c) => {
  const p = srsParams(c.retention);
  const fold = foldReviews(p, c.created_at, c.events, c.resets);
  const v = toStateView('fixture', p, fold, c.at);
  const prev = previewIntervals(p, fold.card, c.at);
  return { ...c, params: p, expected: { state: v.state, due_at: v.due_at, stability: v.stability, difficulty: v.difficulty, reps: v.reps, lapses: v.lapses, last_review_at: v.last_review_at, retrievability: v.retrievability }, preview: prev, event_count: fold.eventCount, first_review_at: fold.firstReviewAt };
});

writeFileSync(join(here, 'srs-parity.json'), JSON.stringify({ generated_by: 'apps/server/src/modules/learning/srs.ts', library: `ts-fsrs ${TS_FSRS_VERSION}`, cases: out }, null, 2) + '\n');
console.log(`wrote ${out.length} cases (ts-fsrs ${TS_FSRS_VERSION})`);
