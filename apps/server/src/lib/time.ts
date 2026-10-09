// Time helpers. Storage is always UTC epoch ms; calendar boundaries use the owner timezone.

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function partsInTz(ms: number, timeZone: string): { y: number; m: number; d: number; h: number; mi: number; s: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const get = (type: string) => Number(fmt.formatToParts(new Date(ms)).find((p) => p.type === type)?.value ?? 0);
  return { y: get('year'), m: get('month'), d: get('day'), h: get('hour'), mi: get('minute'), s: get('second') };
}

/** Offset (ms) of `timeZone` from UTC at instant `ms` (positive east of UTC). */
export function tzOffsetMs(ms: number, timeZone: string): number {
  const p = partsInTz(ms, timeZone);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** UTC epoch ms of local midnight on the 1st of the month containing `ms` in `timeZone`. */
export function startOfMonthInTz(ms: number, timeZone: string): number {
  const p = partsInTz(ms, timeZone);
  const localMidnightAsUtc = Date.UTC(p.y, p.m - 1, 1, 0, 0, 0);
  // two passes handle DST transitions between `ms` and the month start
  let guess = localMidnightAsUtc - tzOffsetMs(ms, timeZone);
  guess = localMidnightAsUtc - tzOffsetMs(guess, timeZone);
  return guess;
}

/** YYYY-MM-DD of `ms` in `timeZone`. */
export function localDate(ms: number, timeZone: string): string {
  const p = partsInTz(ms, timeZone);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}
