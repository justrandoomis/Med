// Owner-day helpers for the learning screens (§45, §47). Storage is UTC epoch ms; a «day» is YYYY-MM-DD in an
// EXPLICIT IANA timezone (the owner setting, default Asia/Baghdad, or a plan's stored timezone). Nothing here reads
// the device timezone: conversions go through Intl with a timeZone, and calendar labels of a day key are formatted
// in UTC from Date.UTC — so a device in another zone never shifts a due day or a plan day.
// Mirrors apps/server/src/modules/learning/time.ts (same day-start rule, also on days where DST skips midnight).

export const DAY_MS = 86_400_000;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCALE = 'ar-u-nu-latn';

const dateFmt = new Map<string, Intl.DateTimeFormat>();
function partsFmt(timeZone: string): Intl.DateTimeFormat {
  let f = dateFmt.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    dateFmt.set(timeZone, f);
  }
  return f;
}

function wall(ms: number, timeZone: string): { y: number; m: number; d: number; h: number; mi: number; s: number } {
  const parts = partsFmt(timeZone).formatToParts(ms);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { y: get('year'), m: get('month'), d: get('day'), h: get('hour') % 24, mi: get('minute'), s: get('second') };
}

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

const pad = (n: number) => String(n).padStart(2, '0');

/** The owner day (YYYY-MM-DD) of an instant in `timeZone`. */
export function dayOf(ms: number, timeZone: string): string {
  const w = wall(ms, timeZone);
  return `${w.y}-${pad(w.m)}-${pad(w.d)}`;
}

/** Offset of `timeZone` from UTC at `ms` (ms; positive east of Greenwich). */
export function tzOffsetMs(ms: number, timeZone: string): number {
  const w = wall(ms, timeZone);
  const asUtc = Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** UTC epoch ms of the first instant of `day` in `timeZone` (DST-safe, like the server). */
export function dayStartMs(day: string, timeZone: string): number {
  const [y, m, d] = parts(day);
  const midnightAsUtc = Date.UTC(y, m - 1, d, 0, 0, 0);
  let guess = midnightAsUtc - tzOffsetMs(midnightAsUtc, timeZone);
  guess = midnightAsUtc - tzOffsetMs(guess, timeZone);
  if (dayOf(guess, timeZone) === day && dayOf(guess - 1, timeZone) < day) return guess;
  let lo = guess - 6 * 3_600_000;
  let hi = guess + 6 * 3_600_000;
  while (hi - lo > 60_000) {
    const mid = lo + Math.floor((hi - lo) / 120_000) * 60_000;
    if (dayOf(mid, timeZone) < day) lo = mid;
    else hi = mid;
  }
  return hi;
}

/** UTC epoch ms where `day` ends (the start of the next day) in `timeZone`. */
export function dayEndMs(day: string, timeZone: string): number {
  return dayStartMs(addDays(day, 1), timeZone);
}

/** Calendar arithmetic on YYYY-MM-DD (timezone-free). */
export function addDays(day: string, n: number): string {
  const [y, m, d] = parts(day);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Whole calendar days from a to b (b − a). */
export function daysBetween(a: string, b: string): number {
  const [ya, ma, da] = parts(a);
  const [yb, mb, db] = parts(b);
  return Math.round((Date.UTC(yb, mb - 1, db) - Date.UTC(ya, ma - 1, da)) / DAY_MS);
}

/** 0 = Sunday … 6 = Saturday of the calendar day itself. */
export function weekdayOf(day: string): number {
  const [y, m, d] = parts(day);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export const WEEKDAYS_AR = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'] as const;

const labelFmt = new Map<string, Intl.DateTimeFormat>();
function utcFmt(opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify(opts);
  let f = labelFmt.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(LOCALE, { ...opts, timeZone: 'UTC' });
    labelFmt.set(key, f);
  }
  return f;
}

/**
 * «الأحد 12 أكتوبر» for a day KEY. The key already is the day in the plan / owner timezone, so it is formatted as a
 * calendar date (UTC noon) — never re-interpreted in the device timezone.
 */
export function dayLabelAr(day: string, opts: { year?: boolean; weekday?: boolean } = {}): string {
  const [y, m, d] = parts(day);
  const at = Date.UTC(y, m - 1, d, 12);
  const date = utcFmt({ day: 'numeric', month: 'long', ...(opts.year ? { year: 'numeric' } : {}) }).format(at);
  return opts.weekday === false ? date : `${WEEKDAYS_AR[weekdayOf(day)]} ${date}`;
}

/** «اليوم» / «غدًا» / «أمس» / the date label, relative to `today` (both day keys). */
export function relativeDayAr(day: string, today: string): string {
  const n = daysBetween(today, day);
  if (n === 0) return 'اليوم';
  if (n === 1) return 'غدًا';
  if (n === -1) return 'أمس';
  return dayLabelAr(day);
}

/** «بعد 3 أيام» / «بعد يومين» … for a count of days (Arabic plural rules for small numbers). */
export function daysCountAr(n: number): string {
  const a = Math.abs(n);
  if (a === 0) return 'اليوم';
  if (a === 1) return 'يوم واحد';
  if (a === 2) return 'يومان';
  if (a <= 10) return `${a} أيام`;
  return `${a} يومًا`;
}

/** «دقيقة» / «دقيقتان» / «5 دقائق» / «25 دقيقة». */
export function minutesAr(n: number): string {
  const a = Math.round(n);
  if (a === 1) return 'دقيقة واحدة';
  if (a === 2) return 'دقيقتان';
  if (a >= 3 && a <= 10) return `${a} دقائق`;
  return `${a} دقيقة`;
}

/** «بطاقة واحدة» / «بطاقتان» / «3 بطاقات» / «12 بطاقة». */
export function cardsAr(n: number): string {
  if (n === 0) return 'لا بطاقات';
  if (n === 1) return 'بطاقة واحدة';
  if (n === 2) return 'بطاقتان';
  if (n <= 10) return `${n} بطاقات`;
  return `${n} بطاقة`;
}

/** «سؤال واحد» / «سؤالان» / «3 أسئلة» / «12 سؤالًا». */
export function questionsAr(n: number): string {
  if (n === 0) return 'لا أسئلة';
  if (n === 1) return 'سؤال واحد';
  if (n === 2) return 'سؤالان';
  if (n <= 10) return `${n} أسئلة`;
  return `${n} سؤالًا`;
}

/** «عنصر واحد» / «عنصران» / «3 عناصر» / «12 عنصرًا». */
export function itemsAr(n: number): string {
  if (n === 1) return 'عنصر واحد';
  if (n === 2) return 'عنصران';
  if (n >= 3 && n <= 10) return `${n} عناصر`;
  return `${n} عنصرًا`;
}
