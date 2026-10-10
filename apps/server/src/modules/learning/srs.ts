// Spaced repetition (§43, AC-24): FSRS-6 through ts-fsrs with FIXED parameters.
//
//  * The schedule of a card is DERIVED: fold(createEmptyCard(created_at), events sorted by (reviewed_at, id),
//    relearn markers as `forget`). The same events in any arrival order give the same state; an event id is
//    folded once. review_state is only a cache of that fold (rebuildable: params_key mismatch → recompute).
//  * Parameters: default FSRS-6 weights of the installed ts-fsrs, desired retention from the owner settings, no fuzz
//    (fuzz is random — a re-sent event must never move a due date), short-term learning steps 1m/10m, relearning 10m.
//  * ts-fsrs counts elapsed days by UTC calendar date (dateDiffInDays); due times are exact epoch ms, so the device
//    timezone never changes a schedule. «Due today» / the daily new-card limit use the OWNER day (time.ts).
import { createHash } from 'node:crypto';
import {
  FSRSVersion,
  Rating,
  State,
  createEmptyCard,
  default_learning_steps,
  default_maximum_interval,
  default_relearning_steps,
  default_w,
  fsrs,
  generatorParameters,
  type Card,
  type FSRS,
  type Grade,
} from 'ts-fsrs';
import { REVIEW_RATING_FSRS, stableStringify, type CardState, type ReviewRating, type ReviewStateView, type SrsParams } from '@medlevo/shared';

export const TS_FSRS_VERSION = FSRSVersion; // e.g. 'v5.4.2 using FSRS-6.0'

export function srsParams(desiredRetention: number): SrsParams {
  return {
    request_retention: Math.round(desiredRetention * 1000) / 1000,
    maximum_interval: default_maximum_interval,
    w: [...default_w],
    enable_fuzz: false,
    enable_short_term: true,
    learning_steps: [...default_learning_steps],
    relearning_steps: [...default_relearning_steps],
  };
}

/** Cache key of a schedule: the params AND the library version (an upgraded ts-fsrs may fold the same params differently). */
export function paramsKey(p: SrsParams): string {
  return createHash('sha256').update(stableStringify({ params: p, library: `ts-fsrs ${TS_FSRS_VERSION}` })).digest('hex');
}

export function algorithmString(p: SrsParams): string {
  return [
    'FSRS-6',
    `ts-fsrs ${TS_FSRS_VERSION}`,
    `w=default(${p.w.length})`,
    `desired_retention=${p.request_retention.toFixed(2)}`,
    `learning_steps=${p.learning_steps.join(',')}`,
    `relearning_steps=${p.relearning_steps.join(',')}`,
    `max_interval=${p.maximum_interval}d`,
    'fuzz=off',
    `short_term=${p.enable_short_term ? 'on' : 'off'}`,
    'order=(reviewed_at,id)',
  ].join(' · ');
}

const schedulers = new Map<string, FSRS>();
export function scheduler(p: SrsParams): FSRS {
  const key = paramsKey(p);
  let f = schedulers.get(key);
  if (!f) {
    f = fsrs(generatorParameters({ ...p, w: [...p.w], learning_steps: p.learning_steps as never, relearning_steps: p.relearning_steps as never }));
    schedulers.set(key, f);
  }
  return f;
}

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

/** Deterministic order of a card's history: time, then events before relearn markers at the same ms, then id. */
export function sortHistory(events: FoldEvent[], resets: number[]): Array<{ kind: 'event'; e: FoldEvent } | { kind: 'reset'; at: number }> {
  const seen = new Set<string>();
  const unique = events.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
  const items: Array<{ kind: 'event'; e: FoldEvent } | { kind: 'reset'; at: number }> = [
    ...unique.map((e) => ({ kind: 'event' as const, e })),
    ...resets.map((at) => ({ kind: 'reset' as const, at })),
  ];
  const t = (i: (typeof items)[number]) => (i.kind === 'event' ? i.e.reviewed_at : i.at);
  items.sort((a, b) => {
    const d = t(a) - t(b);
    if (d !== 0) return d;
    if (a.kind !== b.kind) return a.kind === 'event' ? -1 : 1;
    if (a.kind === 'event' && b.kind === 'event') return a.e.id < b.e.id ? -1 : a.e.id > b.e.id ? 1 : 0;
    return 0;
  });
  return items;
}

/**
 * Fold a card's history. Pure: same input (in any order) → same output. Duplicate event ids count once.
 * `onEvent` sees the card state before and after each folded event (the weakness center uses it to find lapses with
 * exactly the same ordering as the schedule).
 */
export function foldReviews(
  p: SrsParams,
  createdAt: number,
  events: FoldEvent[],
  resets: number[] = [],
  onEvent?: (e: FoldEvent, before: Card, after: Card) => void,
): FoldResult {
  const f = scheduler(p);
  let card = createEmptyCard(new Date(createdAt));
  let count = 0;
  let first: number | null = null;
  for (const item of sortHistory(events, resets)) {
    if (item.kind === 'reset') {
      card = f.forget(card, new Date(item.at), false).card;
      continue;
    }
    const before = card;
    card = f.next(card, new Date(item.e.reviewed_at), item.e.rating as unknown as Grade).card;
    onEvent?.(item.e, before, card);
    count++;
    if (first === null) first = item.e.reviewed_at;
  }
  return { card, eventCount: count, firstReviewAt: first };
}

export function cardStateName(card: Card): CardState {
  return STATE_NAMES[card.state];
}

export function retrievabilityAt(p: SrsParams, card: Card, at: number): number | null {
  if (card.state === State.New || !card.last_review) return null;
  const r = scheduler(p).get_retrievability(card, new Date(at), false);
  return Number.isFinite(r) ? Math.max(0, Math.min(1, r)) : null;
}

export function toStateView(cardId: string, p: SrsParams, fold: FoldResult, now: number): ReviewStateView {
  const c = fold.card;
  const isNew = c.state === State.New;
  return {
    card_id: cardId,
    algorithm: algorithmString(p),
    state: cardStateName(c),
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

/** Rebuild a ts-fsrs Card from a cached review_state row (exactly what the fold produced). */
export function cardFromCache(r: {
  state: CardState;
  due_at: number;
  stability: number | null;
  difficulty: number | null;
  reps: number;
  lapses: number;
  last_review_at: number | null;
  learning_steps: number;
  scheduled_days: number;
}): Card {
  const state = r.state === 'new' ? State.New : r.state === 'learning' ? State.Learning : r.state === 'review' ? State.Review : State.Relearning;
  const card: Card = {
    due: new Date(r.due_at),
    stability: r.stability ?? 0,
    difficulty: r.difficulty ?? 0,
    elapsed_days: 0,
    scheduled_days: r.scheduled_days,
    learning_steps: r.learning_steps,
    reps: r.reps,
    lapses: r.lapses,
    state,
  };
  if (r.last_review_at !== null) card.last_review = new Date(r.last_review_at);
  return card;
}

/** «بعد 10 دقائق» / «بعد يومين» / «بعد 3 أشهر» — the interval a button would give (display only). */
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

export const RATING_NAMES = REVIEW_RATING_FSRS;
export { Rating, State };

function round(n: number): number {
  return Math.round(n * 1e8) / 1e8;
}
