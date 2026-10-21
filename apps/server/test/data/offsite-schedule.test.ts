// PL-0: daily-slot and retention arithmetic of off-site backups (modules/data/offsite-schedule.ts).
import { describe, expect, it } from 'vitest';
import { isoWeekKey, lastSlotAt, nextSlotAt, parseObjectName, planRetention } from '../../src/modules/data/offsite-schedule';

const S = { hour: 3, minute: 15 };

describe('daily slot', () => {
  it('Asia/Baghdad (UTC+3, no DST): 03:15 local = 00:15 UTC', () => {
    const tz = 'Asia/Baghdad';
    expect(lastSlotAt(Date.UTC(2026, 9, 20, 0, 15, 0), S, tz)).toBe(Date.UTC(2026, 9, 20, 0, 15, 0));
    expect(lastSlotAt(Date.UTC(2026, 9, 20, 0, 14, 59), S, tz)).toBe(Date.UTC(2026, 9, 19, 0, 15, 0));
    expect(lastSlotAt(Date.UTC(2026, 9, 19, 22, 0, 0), S, tz)).toBe(Date.UTC(2026, 9, 19, 0, 15, 0)); // 01:00 local on the 20th
    expect(nextSlotAt(Date.UTC(2026, 9, 20, 0, 15, 0), S, tz)).toBe(Date.UTC(2026, 9, 21, 0, 15, 0));
    expect(nextSlotAt(Date.UTC(2026, 9, 19, 22, 0, 0), S, tz)).toBe(Date.UTC(2026, 9, 20, 0, 15, 0));
  });

  it('a zone with daylight saving keeps the local wall-clock time across the change (Europe/Berlin)', () => {
    const tz = 'Europe/Berlin';
    // 2026-10-25: clocks go back from CEST (UTC+2) to CET (UTC+1)
    expect(lastSlotAt(Date.UTC(2026, 9, 24, 12, 0, 0), S, tz)).toBe(Date.UTC(2026, 9, 24, 1, 15, 0));
    expect(nextSlotAt(Date.UTC(2026, 9, 24, 12, 0, 0), S, tz)).toBe(Date.UTC(2026, 9, 25, 2, 15, 0));
  });
});

describe('ISO weeks', () => {
  it('matches ISO-8601 at year boundaries', () => {
    expect(isoWeekKey('2026-01-01')).toBe('2026-W01');
    expect(isoWeekKey('2021-01-03')).toBe('2020-W53');
    expect(isoWeekKey('2024-12-30')).toBe('2025-W01');
    expect(isoWeekKey('2026-10-20')).toBe('2026-W43');
  });
});

describe('retention plan', () => {
  const key = (iso: string, id: string) => `medlevo/backups/medlevo-backup-${iso.replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}Z-${id}.tar.gz.mlenc`;

  it('parses only MedLevo object names', () => {
    expect(parseObjectName(key('2026-10-20T03:15:00', 'abcd1234'))).toEqual({ fileName: 'medlevo-backup-20261020-031500Z-abcd1234.tar.gz', createdAt: Date.UTC(2026, 9, 20, 3, 15, 0) });
    expect(parseObjectName('medlevo/backups/notes.txt')).toBeNull();
    expect(parseObjectName('medlevo/backups/medlevo-backup-20261020-031500Z-abcd1234.tar.gz')).toBeNull();
  });

  it('newest of each of the last N days + newest of each of the last M weeks; the newest and «alwaysKeep» are never deleted', () => {
    const keys: string[] = [];
    for (let d = 1; d <= 30; d++) keys.push(key(`2026-09-${String(d).padStart(2, '0')}T00:15:00`, `d${String(d).padStart(7, '0')}`));
    keys.push(key('2026-09-30T10:00:00', 'late0000')); // second backup on the 30th (newest overall)
    keys.push('medlevo/backups/README.txt');
    const plan = planRetention(keys, { keepDaily: 3, keepWeekly: 2, tz: 'UTC', alwaysKeep: [key('2026-09-02T00:15:00', 'd0000002')] });
    expect(plan.keep).toEqual([
      key('2026-09-30T10:00:00', 'late0000'),
      key('2026-09-29T00:15:00', 'd0000029'),
      key('2026-09-28T00:15:00', 'd0000028'),
      key('2026-09-27T00:15:00', 'd0000027'), // newest of the previous ISO week (W39 ends Sunday the 27th)
      key('2026-09-02T00:15:00', 'd0000002'),
    ]);
    expect(plan.delete).toContain(key('2026-09-30T00:15:00', 'd0000030'));
    expect(plan.delete).not.toContain('medlevo/backups/README.txt');
    expect(plan.keep.length + plan.delete.length).toBe(31);
  });

  it('keeps everything when there is little', () => {
    const one = [key('2026-09-30T00:15:00', 'only0000')];
    expect(planRetention(one, { keepDaily: 7, keepWeekly: 4, tz: 'Asia/Baghdad' })).toEqual({ keep: one, delete: [] });
    expect(planRetention([], { keepDaily: 7, keepWeekly: 4, tz: 'Asia/Baghdad' })).toEqual({ keep: [], delete: [] });
  });
});
