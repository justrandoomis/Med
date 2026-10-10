// Local spaced-repetition fold (§43, AC-23, AC-24) — the SAME algorithm and parameters as the server
// (apps/server/src/modules/learning/srs.ts): FSRS-6 via ts-fsrs, params from GET /api/learning/srs-config (fuzz off),
// fold(createEmptyCard(created_at), events sorted by (reviewed_at, id), relearn markers as forget(card, at, false)
// after events at the same ms), one event per id. The schedule is derived, never authored: an offline device computes
// the next due time from the review log it holds, and the server recomputes the same value from the same events.
// Before trusting its own fold, the device replays the server's live parity sample (`parity_check`).
import { State, createEmptyCard, fsrs, generatorParameters, type Card, type FSRS, type Grade } from 'ts-fsrs';
import type { CardState, ReviewRating, ReviewStateView, SrsConfigView, SrsParams } from '@medlevo/shared';

export interface FoldEvent {
  id: string;
  rating: ReviewRating;
  reviewed_at: number;
}

export interface FoldResult {
  card: Card;
  eventCount: number;
  firstReviewAt: number | null;
}

const STATE_NAMES: Record<State, CardState> = {
  [State.New]: 'new',
  [State.Learning]: 'learning',
  [State.Review]: 'review',
  [State.Relearning]: 'relearning',
};

const schedulers = new Map<string, FSRS>();
function keyOf(p: SrsParams): string {
  return JSON.stringify([p.request_retention, p.maximum_interval, p.w, p.enable_fuzz, p.enable_short_term, p.learning_steps, p.relearning_steps]);
}

/** ts-fsrs scheduler for exactly these params (cached). */
export function scheduler(p: SrsParams): FSRS {
  const key = keyOf(p);
  let f = schedulers.get(key);
  if (!f) {
    f = fsrs(
      generatorParameters({
        request_retention: p.request_retention,
        maximum_interval: p.maximum_interval,
        w: [...p.w],
        enable_fuzz: false, // a re-sent or replayed event must never move a due date
        enable_short_term: p.enable_short_term,
        learning_steps: p.learning_steps as never,
        relearning_steps: p.relearning_steps as never,
      }),
    );
    schedulers.set(key, f);
  }
  return f;
}

type HistoryItem = { kind: 'event'; e: FoldEvent } | { kind: 'reset'; at: number };

/** Deterministic order: time, then events before relearn markers at the same ms, then id. Duplicate ids once. */
export function sortHistory(events: readonly FoldEvent[], resets: readonly number[]): HistoryItem[] {
  const seen = new Set<string>();
  const unique = events.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
  const items: HistoryItem[] = [...unique.map((e) => ({ kind: 'event' as const, e })), ...resets.map((at) => ({ kind: 'reset' as const, at }))];
  const t = (i: HistoryItem) => (i.kind === 'event' ? i.e.reviewed_at : i.at);
  items.sort((a, b) => {
    const d = t(a) - t(b);
    if (d !== 0) return d;
    if (a.kind !== b.kind) return a.kind === 'event' ? -1 : 1;
    if (a.kind === 'event' && b.kind === 'event') return a.e.id < b.e.id ? -1 : a.e.id > b.e.id ? 1 : 0;
    return 0;
  });
  return items;
}

/** Pure fold of a card's history (any input order → same result). */
export function foldReviews(p: SrsParams, createdAt: number, events: readonly FoldEvent[], resets: readonly number[] = []): FoldResult {
  const f = scheduler(p);
  let card = createEmptyCard(new Date(createdAt));
  let count = 0;
  let first: number | null = null;
  for (const item of sortHistory(events, resets)) {
    if (item.kind === 'reset') {
      card = f.forget(card, new Date(item.at), false).card;
      continue;
    }
    card = f.next(card, new Date(item.e.reviewed_at), item.e.rating as unknown as Grade).card;
    count++;
    if (first === null) first = item.e.reviewed_at;
  }
  return { card, eventCount: count, firstReviewAt: first };
}

function round(n: number): number {
  return Math.round(n * 1e8) / 1e8;
}

export function retrievabilityAt(p: SrsParams, card: Card, at: number): number | null {
  if (card.state === State.New || !card.last_review) return null;
  const r = scheduler(p).get_retrievability(card, new Date(at), false);
  return Number.isFinite(r) ? Math.max(0, Math.min(1, r)) : null;
}

export type LocalStateView = Omit<ReviewStateView, 'card_id' | 'algorithm'>;

/** The state view of a fold at `now` (same rounding as the server). */
export function stateOf(p: SrsParams, fold: FoldResult, now: number): LocalStateView {
  const c = fold.card;
  const isNew = c.state === State.New;
  return {
    state: STATE_NAMES[c.state],
    due_at: c.due.getTime(),
    stability: isNew ? null : round(c.stability),
    difficulty: isNew ? null : round(c.difficulty),
    reps: c.reps,
    lapses: c.lapses,
    last_review_at: c.last_review ? c.last_review.getTime() : null,
    retrievability: retrievabilityAt(p, c, now),
  };
}

/** Next due time for each rating if the card were answered at `now` (button previews). */
export function previewIntervals(p: SrsParams, card: Card, now: number): Record<ReviewRating, number> {
  const f = scheduler(p);
  const out = {} as Record<ReviewRating, number>;
  for (const r of [1, 2, 3, 4] as ReviewRating[]) out[r] = f.next(card, new Date(now), r as unknown as Grade).card.due.getTime();
  return out;
}

/** «بعد 10 دقائق» / «بعد يومين» / «بعد 3 أشهر» — same wording as the server's button labels. */
export function intervalLabelAr(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return min === 1 ? 'بعد دقيقة' : min === 2 ? 'بعد دقيقتين' : min <= 10 ? `بعد ${min} دقائق` : `بعد ${min} دقيقة`;
  const h = Math.round(min / 60);
  if (h < 24) return h === 1 ? 'بعد ساعة' : h === 2 ? 'بعد ساعتين' : h <= 10 ? `بعد ${h} ساعات` : `بعد ${h} ساعة`;
  const d = Math.round(h / 24);
  if (d < 31) return d === 1 ? 'بعد يوم' : d === 2 ? 'بعد يومين' : d <= 10 ? `بعد ${d} أيام` : `بعد ${d} يومًا`;
  const mo = Math.round(d / 30);
  if (mo < 12) return mo === 1 ? 'بعد شهر' : mo === 2 ? 'بعد شهرين' : mo <= 10 ? `بعد ${mo} أشهر` : `بعد ${mo} شهرًا`;
  const y = Math.round(d / 365);
  return y === 1 ? 'بعد سنة' : y === 2 ? 'بعد سنتين' : y <= 10 ? `بعد ${y} سنوات` : `بعد ${y} سنة`;
}

export interface ParityResult {
  ok: boolean;
  /** which fields differ (empty when ok) */
  mismatches: string[];
}

/** Replays the server's live sample with the client fold: the device only schedules offline when this passes. */
export function checkParity(cfg: Pick<SrsConfigView, 'params' | 'parity_check'>): ParityResult {
  const s = cfg.parity_check;
  const fold = foldReviews(cfg.params, s.created_at, s.events as FoldEvent[], s.resets);
  const got = stateOf(cfg.params, fold, s.at);
  const mismatches: string[] = [];
  const close = (a: number | null, b: number | null) => (a === null || b === null ? a === b : Math.abs(a - b) <= 1e-6);
  if (got.state !== s.expected.state) mismatches.push('state');
  if (got.due_at !== s.expected.due_at) mismatches.push('due_at');
  if (!close(got.stability, s.expected.stability)) mismatches.push('stability');
  if (!close(got.difficulty, s.expected.difficulty)) mismatches.push('difficulty');
  if (got.reps !== s.expected.reps) mismatches.push('reps');
  if (got.lapses !== s.expected.lapses) mismatches.push('lapses');
  if (got.last_review_at !== s.expected.last_review_at) mismatches.push('last_review_at');
  if (!close(got.retrievability, s.expected.retrievability)) mismatches.push('retrievability');
  return { ok: mismatches.length === 0, mismatches };
}

/** «تقديري»: review state with stability ≥ 21 days (same rule as the server); it still comes back for review. */
export function isEstimatedMastered(v: Pick<LocalStateView, 'state' | 'stability'>): boolean {
  return v.state === 'review' && (v.stability ?? 0) >= 21;
}
