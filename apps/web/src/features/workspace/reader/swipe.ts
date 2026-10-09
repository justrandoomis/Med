// Touch swipe → next / previous spread in the paged layouts (§24), and the rule that no page flip is ever
// caused by writing. A finger the ink layer claimed for a stroke (it calls preventDefault on the pointer's
// events) is never a swipe; neither is a touch that moved while a stroke was in progress (a palm resting
// next to the pen). The ink layer ends its stroke BEFORE the canvas sees the pointerup (its native listener
// runs before React's root listener), so "is a stroke active now?" alone is not enough — this tracker
// remembers that the gesture was claimed.

export interface SwipePointer {
  pointerId: number;
  pointerType: string;
  clientX: number;
  clientY: number;
  timeStamp: number;
  /** the event was claimed by a nested handler (the ink layer writing) */
  defaultPrevented: boolean;
}

export const SWIPE_MIN_PX = 64;
export const SWIPE_MAX_MS = 800;

interface Tracked {
  id: number;
  x: number;
  y: number;
  t: number;
  claimed: boolean;
}

export class SwipeTracker {
  private cur: Tracked | null = null;

  /** A touch started. `busy` = a stroke is in progress right now. */
  down(e: SwipePointer, busy = false): void {
    if (e.pointerType !== 'touch') return;
    this.cur = { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp, claimed: e.defaultPrevented || busy };
  }

  move(e: SwipePointer, busy = false): void {
    const c = this.cur;
    if (!c || c.id !== e.pointerId) return;
    if (e.defaultPrevented || busy) c.claimed = true;
  }

  /** a second finger (pinch) or anything else that ends swipe tracking */
  cancel(): void {
    this.cur = null;
  }

  /**
   * The touch ended: 1 = next spread, -1 = previous, 0 = not a swipe.
   * @param rtl the book reads right-to-left (next page comes from the left: a left-to-right swipe)
   */
  up(e: SwipePointer & { cancelled?: boolean }, rtl: boolean, busy = false): 1 | -1 | 0 {
    const c = this.cur;
    if (!c || c.id !== e.pointerId) return 0;
    this.cur = null;
    if (c.claimed || busy || e.defaultPrevented || e.cancelled) return 0;
    const dx = e.clientX - c.x;
    const dy = e.clientY - c.y;
    if (Math.abs(dx) <= SWIPE_MIN_PX || Math.abs(dx) <= Math.abs(dy) * 1.5 || e.timeStamp - c.t >= SWIPE_MAX_MS) return 0;
    const next = rtl ? dx > 0 : dx < 0;
    return next ? 1 : -1;
  }
}

/** How long after a stroke ends a swipe still counts as part of the writing (palm lift, finger stroke). */
export const STROKE_SETTLE_MS = 500;

/**
 * May the reader turn the page now? Never during a pen stroke or a text selection (§24); a swipe is also
 * refused right after a stroke ended (the same hand is still on the glass).
 */
export function flipBlocked(s: { strokeActive: boolean; lastStrokeEndAt: number | null; now: number; hasSelection: boolean; gesture: 'key' | 'swipe' }): boolean {
  if (s.strokeActive || s.hasSelection) return true;
  return s.gesture === 'swipe' && s.lastStrokeEndAt != null && s.now - s.lastStrokeEndAt < STROKE_SETTLE_MS;
}
