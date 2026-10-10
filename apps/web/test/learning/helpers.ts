// Test helpers for the learning web screens: an SRS config built from the server-generated parity fixture, card views,
// a JSON fetch mock, and a clean shared IndexedDB.
import { richTextFromPlain, type FlashcardView, type SrsConfigView, type SrsParams } from '@medlevo/shared';
import { getDb } from '../../src/lib/localdb';
import fixture from './fixtures/srs-parity.json';

interface FixtureCase {
  name: string;
  params: SrsParams;
  created_at: number;
  events: Array<{ id: string; rating: 1 | 2 | 3 | 4; reviewed_at: number }>;
  resets: number[];
  at: number;
  expected: SrsConfigView['parity_check']['expected'];
}
const cases = (fixture as { cases: FixtureCase[] }).cases;

export function srsConfigFixture(over: Partial<SrsConfigView> = {}): SrsConfigView {
  const c = cases.find((x) => x.name === 'lapse and relearning')!;
  return {
    algorithm: 'FSRS-6 · ts-fsrs v5.4.2 using FSRS-6.0 · desired_retention=0.90',
    library: { name: 'ts-fsrs', version: 'v5.4.2 using FSRS-6.0' },
    params: c.params,
    params_key: 'test',
    daily_new_limit: 20,
    timezone: 'Asia/Baghdad',
    replay: {
      order: 'reviewed_at, id',
      initial: 'createEmptyCard(card.created_at)',
      resets: 'forget(card, at, false)',
      duplicates: 'one event per id',
      rating_map: { 1: 'Again', 2: 'Hard', 3: 'Good', 4: 'Easy' },
      note_ar: '',
    },
    parity_check: { created_at: c.created_at, events: c.events, resets: c.resets, at: c.at, expected: c.expected },
    ...over,
  };
}

export function cardView(id: string, over: Partial<FlashcardView> = {}): FlashcardView {
  const t = Date.UTC(2026, 9, 1);
  return {
    id,
    kind: 'basic',
    front: richTextFromPlain(`Question ${id}?`),
    back: richTextFromPlain(`Answer ${id}.`),
    image: null,
    concept_id: null,
    topic_id: null,
    source_id: 'S1',
    source_version_id: 'V1',
    evidence_ids: [],
    origin: 'owner',
    origin_ref: null,
    suspended: false,
    buried_until: null,
    rev: 1,
    device_id: null,
    created_at: t,
    updated_at: t,
    deleted_at: null,
    note_id: null,
    cloze_index: null,
    conflict_of_id: null,
    merged_into_id: null,
    schedule_resets: [],
    review_state: { card_id: id, algorithm: 'x', state: 'new', due_at: t, stability: null, difficulty: null, reps: 0, lapses: 0, last_review_at: null, retrievability: null },
    estimated_mastered: false,
    needs_review: false,
    impacts: [],
    evidence: [],
    origin_label_ar: 'بطاقة كتبتها بنفسك',
    kind_label_ar: 'سؤال وجواب',
    ...over,
  };
}

export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** fetch mock: path (without /api, query stripped) → body | (url) => Response. Unknown paths → 404 JSON. */
export function routeFetch(routes: Record<string, unknown | ((url: string, init: RequestInit) => Response | Promise<Response>)>) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const fn = async (input: string, init: RequestInit = {}) => {
    const url = String(input);
    const path = url.replace(/^\/api/, '').split('?')[0]!;
    calls.push({ method: init.method ?? 'GET', url, body: init.body ? JSON.parse(String(init.body)) : null });
    const r = routes[`${init.method ?? 'GET'} ${path}`] ?? routes[path];
    if (r === undefined) return json({ error: { code: 'NOT_FOUND', message: 'غير موجود' } }, 404);
    return typeof r === 'function' ? (r as (u: string, i: RequestInit) => Response)(url, init) : json(r);
  };
  return { fn, calls };
}

export async function clearDb(): Promise<void> {
  const db = getDb();
  await db.open();
  await Promise.all(db.tables.map((t) => t.clear()));
}
