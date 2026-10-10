// Owner-day helpers (§45, §47). Storage is UTC epoch ms; «days» are YYYY-MM-DD in an EXPLICIT IANA timezone
// (owner setting, default Asia/Baghdad). Nothing here reads the process / device timezone: every conversion goes
// through Intl with a timeZone or through Date.UTC, so changing the device timezone never shifts a due day.
import { localDate, tzOffsetMs } from '../../lib/time';

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
export const DAY_MS = 86_400_000;

export function isDay(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  const m = DAY_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

function parts(day: string): [number, number, number] {
  const m = DAY_RE.exec(day);
  if (!m) throw new Error(`invalid day ${day}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Owner day of an instant. */
export function dayOf(ms: number, timeZone: string): string {
  return localDate(ms, timeZone);
}

/**
 * UTC epoch ms of the first instant of `day` in `timeZone` (DST-safe). Usually local midnight (two passes). In zones
 * where a DST jump skips midnight (e.g. America/Santiago, America/Havana) the day starts at the jump: when the guess
 * is not the first instant of `day`, the boundary is searched (the local date never decreases over time).
 */
export function dayStartMs(day: string, timeZone: string): number {
  const [y, m, d] = parts(day);
  const midnightAsUtc = Date.UTC(y, m - 1, d, 0, 0, 0);
  let guess = midnightAsUtc - tzOffsetMs(midnightAsUtc, timeZone);
  guess = midnightAsUtc - tzOffsetMs(guess, timeZone);
  if (localDate(guess, timeZone) === day && localDate(guess - 1, timeZone) < day) return guess;
  // first minute whose local date is `day`, within ±6 h of the guess (DST jumps are at most a few hours)
  let lo = guess - 6 * 3_600_000; // local date < day
  let hi = guess + 6 * 3_600_000; // local date ≥ day
  while (hi - lo > 60_000) {
    const mid = lo + Math.floor((hi - lo) / 120_000) * 60_000;
    if (localDate(mid, timeZone) < day) lo = mid;
    else hi = mid;
  }
  return hi;
}

/** UTC epoch ms where `day` ends (= start of the next day) in `timeZone`. */
export function dayEndMs(day: string, timeZone: string): number {
  return dayStartMs(addDays(day, 1), timeZone);
}

/** Calendar arithmetic on YYYY-MM-DD (timezone-free). */
export function addDays(day: string, n: number): string {
  const [y, m, d] = parts(day);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}

/** Whole calendar days from a to b (b − a). */
export function daysBetween(a: string, b: string): number {
  const [ya, ma, da] = parts(a);
  const [yb, mb, db] = parts(b);
  return Math.round((Date.UTC(yb, mb - 1, db) - Date.UTC(ya, ma - 1, da)) / DAY_MS);
}

/** 0 = Sunday … 6 = Saturday (of the calendar day itself). */
export function weekdayOf(day: string): number {
  const [y, m, d] = parts(day);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

const WEEKDAYS_AR = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
export function weekdayAr(day: string): string {
  return WEEKDAYS_AR[weekdayOf(day)]!;
}

/** «الأحد 12 تشرين الأول» style is locale-heavy; keep a neutral, unambiguous form. */
export function dayLabelAr(day: string): string {
  return `${weekdayAr(day)} ${day}`;
}
