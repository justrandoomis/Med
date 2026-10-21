// Schedule and retention arithmetic for off-site backups (PL-0). Pure functions on epoch ms and the owner's timezone
// (MEDLEVO_TIMEZONE): a daily slot «HH:MM local», and «keep the newest N daily + M weekly» over object names.
import type { OffsiteSchedule } from '../../lib/objectstore/offsite-config';
import { localDate, tzOffsetMs } from '../../lib/time';

/** UTC epoch ms of local wall-clock time y-m-d H:M in `tz` (two passes handle a DST change in between). */
export function localTimeToUtc(y: number, m: number, d: number, hour: number, minute: number, tz: string): number {
  const asUtc = Date.UTC(y, m - 1, d, hour, minute, 0);
  let guess = asUtc - tzOffsetMs(asUtc, tz);
  guess = asUtc - tzOffsetMs(guess, tz);
  return guess;
}

/** The most recent daily slot at or before `now`. */
export function lastSlotAt(now: number, s: OffsiteSchedule, tz: string): number {
  const [y, m, d] = localDate(now, tz).split('-').map(Number) as [number, number, number];
  const today = localTimeToUtc(y, m, d, s.hour, s.minute, tz);
  if (today <= now) return today;
  const prev = new Date(Date.UTC(y, m - 1, d - 1));
  return localTimeToUtc(prev.getUTCFullYear(), prev.getUTCMonth() + 1, prev.getUTCDate(), s.hour, s.minute, tz);
}

/** The next daily slot strictly after `now`. */
export function nextSlotAt(now: number, s: OffsiteSchedule, tz: string): number {
  const [y, m, d] = localDate(now, tz).split('-').map(Number) as [number, number, number];
  const today = localTimeToUtc(y, m, d, s.hour, s.minute, tz);
  if (today > now) return today;
  const t = new Date(Date.UTC(y, m - 1, d + 1));
  return localTimeToUtc(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate(), s.hour, s.minute, tz);
}

/** ISO-8601 week key («2026-W43») of a local calendar date «YYYY-MM-DD». */
export function isoWeekKey(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d));
  const dow = t.getUTCDay() || 7; // Monday = 1 … Sunday = 7
  t.setUTCDate(t.getUTCDate() + 4 - dow); // Thursday of this week decides the year
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** An off-site object made by MedLevo: `<prefix>backups/medlevo-backup-YYYYMMDD-HHMMSSZ-<id8>.tar.gz.mlenc` */
export const OFFSITE_OBJECT_RE = /(?:^|\/)(medlevo-backup-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})Z-([0-9a-z]{8})\.tar\.gz)\.mlenc$/;

export function parseObjectName(key: string): { fileName: string; createdAt: number } | null {
  const m = OFFSITE_OBJECT_RE.exec(key);
  if (!m) return null;
  return { fileName: m[1]!, createdAt: Date.UTC(+m[2]!, +m[3]! - 1, +m[4]!, +m[5]!, +m[6]!, +m[7]!) };
}

export interface RetentionPlan {
  keep: string[];
  delete: string[];
}

/**
 * Keep the newest object of each of the `keepDaily` most recent local days that have a backup, plus the newest of
 * each of the `keepWeekly` most recent ISO weeks; always keep the newest object and every name in `alwaysKeep`.
 * Only names that parse as MedLevo backups are ever candidates for deletion.
 */
export function planRetention(keys: string[], o: { keepDaily: number; keepWeekly: number; tz: string; alwaysKeep?: string[] }): RetentionPlan {
  const items = keys
    .map((key) => ({ key, parsed: parseObjectName(key) }))
    .filter((x): x is { key: string; parsed: { fileName: string; createdAt: number } } => x.parsed !== null)
    .sort((a, b) => b.parsed.createdAt - a.parsed.createdAt || (a.key < b.key ? 1 : -1));
  const keep = new Set<string>(o.alwaysKeep ?? []);
  if (items[0]) keep.add(items[0].key);
  const days: string[] = [];
  const weeks: string[] = [];
  for (const it of items) {
    const day = localDate(it.parsed.createdAt, o.tz);
    if (!days.includes(day) && days.length < o.keepDaily) {
      days.push(day);
      keep.add(it.key);
    }
    const week = isoWeekKey(day);
    if (!weeks.includes(week) && weeks.length < o.keepWeekly) {
      weeks.push(week);
      keep.add(it.key);
    }
  }
  return { keep: items.filter((i) => keep.has(i.key)).map((i) => i.key), delete: items.filter((i) => !keep.has(i.key)).map((i) => i.key) };
}
