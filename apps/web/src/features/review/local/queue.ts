// The due queue computed on the device (§43, AC-23) — same rules as the server's GET /review/queue
// (apps/server/src/modules/learning/review.ts): learning/relearning due now → review due (oldest due first) → new cards
// in creation order up to `daily_new_limit − new cards first reviewed today` (OWNER day, explicit timezone). Suspended,
// buried and deleted cards are not asked. Pure: the same rows, events, config and time give the same queue.
import type { SrsParams } from '@medlevo/shared';
import { foldReviews, isEstimatedMastered, stateOf, type FoldEvent, type FoldResult, type LocalStateView } from './srs';
import type { LocalCardRow, LocalEventRow } from './store';
import { DAY_MS, dayEndMs, dayOf, dayStartMs } from './time';

export interface QueueConfig {
  params: SrsParams;
  daily_new_limit: number;
  timezone: string;
}

export interface CardSchedule {
  card: LocalCardRow;
  fold: FoldResult;
  view: LocalStateView;
  mastered: boolean;
}

export type QueueReason = 'learning' | 'due' | 'new' | 'ahead';

export interface LocalQueueItem extends CardSchedule {
  reason: QueueReason;
  reason_ar: string;
}

export interface LocalQueue {
  day: string;
  items: LocalQueueItem[];
  counts: {
    due_now: number;
    due_today: number;
    new_available: number;
    new_limit: number;
    new_introduced_today: number;
    /** chosen cards (explicit list) that are not due yet and were not reviewed since `aheadSince` */
    ahead: number;
    suspended: number;
    buried: number;
    needs_review: number;
    total: number;
  };
  next_due_at: number | null;
}

export interface QueueOptions {
  sourceId?: string | null;
  /** restrict to these cards (a revision session), in any order */
  cardIds?: readonly string[] | null;
  limit?: number;
  /**
   * Review ahead (explicit lists only, the owner's opt-in): chosen cards that are not due yet are asked too — once:
   * a card reviewed at or after this instant is not asked again until it is really due.
   */
  aheadSince?: number | null;
}

function aheadAr(days: number): string {
  return days <= 0 ? 'موعدها بعد أقل من يوم' : days === 1 ? 'موعدها بعد يوم' : days === 2 ? 'موعدها بعد يومين' : days <= 10 ? `موعدها بعد ${days} أيام` : `موعدها بعد ${days} يومًا`;
}

export function toFoldEvents(rows: readonly LocalEventRow[] | undefined): FoldEvent[] {
  return (rows ?? []).map((r) => ({ id: r.id, rating: r.rating, reviewed_at: r.reviewedAt }));
}

export function scheduleOf(cfg: Pick<QueueConfig, 'params'>, card: LocalCardRow, events: readonly LocalEventRow[] | undefined, now: number): CardSchedule {
  const fold = foldReviews(cfg.params, card.createdAt ?? card.updatedAt, toFoldEvents(events), card.scheduleResets ?? []);
  const view = stateOf(cfg.params, fold, now);
  return { card, fold, view, mastered: isEstimatedMastered(view) };
}

function overdueAr(days: number): string {
  return days === 1 ? 'يوم' : days === 2 ? 'يومين' : days <= 10 ? `${days} أيام` : `${days} يومًا`;
}

export function computeQueue(cfg: QueueConfig, cards: readonly LocalCardRow[], events: ReadonlyMap<string, readonly LocalEventRow[]>, now: number, o: QueueOptions = {}): LocalQueue {
  const today = dayOf(now, cfg.timezone);
  const start = dayStartMs(today, cfg.timezone);
  const end = dayEndMs(today, cfg.timezone);
  const only = o.cardIds ? new Set(o.cardIds) : null;
  const live = cards
    .filter((c) => !c.deletedAt && (!o.sourceId || c.sourceId === o.sourceId) && (!only || only.has(c.id)))
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const suspended = live.filter((c) => c.suspended).length;
  const buried = live.filter((c) => !c.suspended && c.buriedUntil != null && c.buriedUntil > now).length;
  const active = live.filter((c) => !c.suspended && (c.buriedUntil == null || c.buriedUntil <= now));

  // «introduced today» counts every card first reviewed in the owner's day (like the server's review_state rows)
  let introducedToday = 0;
  const schedules = new Map<string, CardSchedule>();
  for (const c of cards) {
    if (c.deletedAt) continue;
    const s = scheduleOf(cfg, c, events.get(c.id), now);
    schedules.set(c.id, s);
    if (s.fold.firstReviewAt !== null && s.fold.firstReviewAt >= start && s.fold.firstReviewAt < end) introducedToday++;
  }
  const newLimitLeft = Math.max(0, cfg.daily_new_limit - introducedToday);

  const learning: CardSchedule[] = [];
  const due: CardSchedule[] = [];
  const fresh: CardSchedule[] = [];
  // chosen cards (explicit list) that are not due yet: offered for an early review only when the owner opts in
  const ahead: CardSchedule[] = [];
  let dueToday = 0;
  let nextDue: number | null = null;
  for (const c of active) {
    const s = schedules.get(c.id)!;
    if (s.view.state === 'new' && s.fold.eventCount === 0) {
      fresh.push(s);
      continue;
    }
    if (s.view.due_at < end) dueToday++;
    if (s.view.due_at <= now) (s.view.state === 'learning' || s.view.state === 'relearning' ? learning : due).push(s);
    else {
      nextDue = nextDue === null ? s.view.due_at : Math.min(nextDue, s.view.due_at);
      if (only && (o.aheadSince == null || (s.view.last_review_at ?? -Infinity) < o.aheadSince)) ahead.push(s);
    }
  }
  const byDue = (a: CardSchedule, b: CardSchedule) => a.view.due_at - b.view.due_at || (a.card.id < b.card.id ? -1 : 1);
  learning.sort(byDue);
  due.sort(byDue);
  ahead.sort(byDue);
  // a revision session asks its chosen cards even when the daily new-card limit is used up (the owner chose them)
  const newToday = only ? fresh : fresh.slice(0, newLimitLeft);
  const picked: LocalQueueItem[] = [
    ...learning.map((s) => ({ ...s, reason: 'learning' as const, reason_ar: 'قيد التعلّم: خطوة قصيرة حان وقتها.' })),
    ...due.map((s) => {
      const overdue = Math.floor((now - s.view.due_at) / DAY_MS);
      return { ...s, reason: 'due' as const, reason_ar: overdue >= 1 ? `مستحقة منذ ${overdueAr(overdue)}.` : 'حان موعد مراجعتها.' };
    }),
    ...newToday.map((s) => ({ ...s, reason: 'new' as const, reason_ar: only ? 'بطاقة جديدة اخترتها لهذه الجلسة.' : 'بطاقة جديدة ضمن حدّك اليومي للبطاقات الجديدة.' })),
    ...(only && o.aheadSince != null
      ? ahead.map((s) => ({
          ...s,
          reason: 'ahead' as const,
          reason_ar: `مراجعة مبكرة اخترتها: ${aheadAr(Math.round((s.view.due_at - now) / DAY_MS))}، وتُحسب في جدولتها.`,
        }))
      : []),
  ];
  return {
    day: today,
    items: o.limit != null ? picked.slice(0, o.limit) : picked,
    counts: {
      due_now: learning.length + due.length,
      due_today: dueToday,
      new_available: newToday.length,
      new_limit: cfg.daily_new_limit,
      new_introduced_today: introducedToday,
      ahead: ahead.length,
      suspended,
      buried,
      needs_review: live.filter((c) => c.needsReview).length,
      total: live.length,
    },
    next_due_at: nextDue,
  };
}

/** Start of the next owner day — the default «bury until tomorrow» (same rule as the server). */
export function tomorrowStart(now: number, timezone: string): number {
  return dayEndMs(dayOf(now, timezone), timezone);
}
