// Time display (ARCHITECTURE §3.1, spec §45): storage is UTC epoch ms; display uses the owner's
// timezone (default Asia/Baghdad) via Intl. Digits are Latin (nu-latn) so dates read consistently
// next to page numbers and medical values (e.g. «ص12», 5 mg).
export const DEFAULT_TIMEZONE = 'Asia/Baghdad';
const LOCALE = 'ar-u-nu-latn';

let ownerTimeZone = DEFAULT_TIMEZONE;

/** Called by the settings store when the owner's timezone is known/changed. */
export function setOwnerTimeZone(tz: string | null | undefined): void {
  ownerTimeZone = tz && isValidTimeZone(tz) ? tz : DEFAULT_TIMEZONE;
}

export function getOwnerTimeZone(): string {
  return ownerTimeZone;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** IANA zones supported by this browser (falls back to a short list). */
export function listTimeZones(): string[] {
  const supported = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
  if (supported) {
    try {
      const list = supported('timeZone');
      if (!list.includes(DEFAULT_TIMEZONE)) list.unshift(DEFAULT_TIMEZONE);
      return list;
    } catch {
      // fall through
    }
  }
  return [DEFAULT_TIMEZONE, 'Asia/Riyadh', 'Asia/Kuwait', 'Asia/Dubai', 'Asia/Amman', 'Asia/Beirut', 'Africa/Cairo', 'Europe/Istanbul', 'Europe/London', 'UTC'];
}

const cache = new Map<string, Intl.DateTimeFormat>();
function fmt(opts: Intl.DateTimeFormatOptions, tz: string): Intl.DateTimeFormat {
  const key = tz + JSON.stringify(opts);
  let f = cache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(LOCALE, { ...opts, timeZone: tz });
    cache.set(key, f);
  }
  return f;
}

/** e.g. «9 أكتوبر 2026» */
export function formatDate(ms: number, tz = ownerTimeZone): string {
  return fmt({ day: 'numeric', month: 'long', year: 'numeric' }, tz).format(ms);
}

/** e.g. «9 أكتوبر 2026، 3:45 م» */
export function formatDateTime(ms: number, tz = ownerTimeZone): string {
  return fmt({ day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit' }, tz).format(ms);
}

/** e.g. «3:45 م» */
export function formatTime(ms: number, tz = ownerTimeZone): string {
  return fmt({ hour: 'numeric', minute: '2-digit' }, tz).format(ms);
}

/** e.g. «الخميس» */
export function formatWeekday(ms: number, tz = ownerTimeZone): string {
  return fmt({ weekday: 'long' }, tz).format(ms);
}

/** Calendar day key in the owner's zone (YYYY-MM-DD) — for grouping and "today" without UTC drift. */
export function dayKey(ms: number, tz = ownerTimeZone): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(ms);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

const rtf = new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto' });

/** e.g. «قبل 5 دقائق», «أمس», «بعد 3 أيام». Falls back to a date beyond ~30 days. */
export function formatRelative(ms: number, now = Date.now(), tz = ownerTimeZone): string {
  const diff = ms - now;
  const abs = Math.abs(diff);
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;
  if (abs < 45_000) return 'الآن';
  if (abs < hour) return rtf.format(Math.round(diff / min), 'minute');
  if (abs < day) return rtf.format(Math.round(diff / hour), 'hour');
  const days = Math.round((Date.parse(dayKey(ms, tz)) - Date.parse(dayKey(now, tz))) / day);
  if (Math.abs(days) < 30) return rtf.format(days, 'day');
  return formatDate(ms, tz);
}
