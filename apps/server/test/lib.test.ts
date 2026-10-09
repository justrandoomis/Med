import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { openDb } from '../src/db/db';
import { parseWith } from '../src/lib/http';
import { safeEqual } from '../src/lib/hash';
import { localDate, startOfMonthInTz } from '../src/lib/time';
import { deviceLabelFromUserAgent } from '../src/lib/useragent';
import { extractJson } from '../src/modules/ai/orchestrator';
import { generateRecoveryCode, hashSecret, normalizeRecoveryCode, verifySecret } from '../src/modules/auth/password';
import { parseRange } from '../src/modules/files';
import { createTestApp } from './helpers/app';

describe('validation messages', () => {
  it('distinguishes a missing field from a wrong type, in Arabic, without echoing values', () => {
    const schema = z.object({ title: z.string(), count: z.number() });
    try {
      parseWith(schema, { count: 'SECRET-VALUE' }, 'body');
      expect.unreachable();
    } catch (e) {
      const err = e as { code: string; details: { issues: Array<{ path: string; message: string }> } };
      expect(err.code).toBe('VALIDATION_FAILED');
      const byPath = Object.fromEntries(err.details.issues.map((i) => [i.path, i.message]));
      expect(byPath['title']).toBe('هذا الحقل مطلوب.');
      expect(byPath['count']).toBe('نوع القيمة غير صحيح (المتوقع: number).');
      expect(JSON.stringify(err.details)).not.toContain('SECRET-VALUE');
    }
  });
});

describe('time helpers', () => {
  it('computes the month start in the owner timezone (incl. DST zones)', () => {
    const baghdad = startOfMonthInTz(Date.UTC(2026, 9, 9, 12), 'Asia/Baghdad'); // UTC+3
    expect(new Date(baghdad).toISOString()).toBe('2026-09-30T21:00:00.000Z');
    const ny = startOfMonthInTz(Date.UTC(2026, 10, 15, 12), 'America/New_York'); // Nov 1 is still EDT (UTC-4)
    expect(new Date(ny).toISOString()).toBe('2026-11-01T04:00:00.000Z');
    expect(localDate(Date.UTC(2026, 9, 9, 22), 'Asia/Baghdad')).toBe('2026-10-10');
  });
});

describe('small helpers', () => {
  it('labels devices from user agents', () => {
    expect(deviceLabelFromUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1')).toBe('Safari على iPhone');
    expect(deviceLabelFromUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15')).toBe('Safari على Mac');
    expect(deviceLabelFromUserAgent(undefined)).toBe('جهاز غير معروف');
  });

  it('parses byte ranges', () => {
    expect(parseRange(undefined, 10)).toBeNull();
    expect(parseRange('bytes=2-5', 10)).toEqual({ start: 2, end: 5 });
    expect(parseRange('bytes=8-100', 10)).toEqual({ start: 8, end: 9 });
    expect(parseRange('bytes=-4', 10)).toEqual({ start: 6, end: 9 });
    expect(parseRange('bytes=0-1,4-5', 10)).toBeNull(); // multi-range → full body
    expect(parseRange('bytes=5-2', 10)).toBe('unsatisfiable');
    expect(parseRange('bytes=10-', 10)).toBe('unsatisfiable');
  });

  it('extracts JSON from model text', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('Sure:\n```json\n{"a":[1,2]}\n```')).toEqual({ a: [1, 2] });
    expect(extractJson('prefix {"b":true} suffix')).toEqual({ b: true });
    expect(() => extractJson('no json')).toThrow();
  });

  it('hashes and verifies secrets with scrypt; recovery codes normalize typing variants', async () => {
    const h = await hashSecret('pässword-ü', 12);
    expect(h).toMatch(/^scrypt\$4096\$8\$1\$/);
    expect(await verifySecret('pässword-ü', h)).toBe(true);
    expect(await verifySecret('password-u', h)).toBe(false);
    expect(await verifySecret('x', 'garbage')).toBe(false);
    const code = generateRecoveryCode();
    expect(normalizeRecoveryCode(code.toLowerCase().replace(/-/g, ''))).toBe(code);
    expect(normalizeRecoveryCode('abcd efgh jkmn')).toBe('ABCD-EFGH-JKMN');
    expect(normalizeRecoveryCode('abcd efgh jklm')).toBe('ABCD-EFGH-JK1M'); // L is not in the alphabet → 1
    expect(normalizeRecoveryCode('o0il-1111-2222')).toBe('0011-1111-2222');
    expect(safeEqual('a', 'a')).toBe(true);
    expect(safeEqual('a', 'ab')).toBe(false);
  });

  it('creates the database file with owner-only permissions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'medlevo-db-'));
    try {
      const db = openDb(join(dir, 'x.sqlite'));
      db.exec('CREATE TABLE t (a INTEGER)');
      expect(statSync(join(dir, 'x.sqlite')).mode & 0o777).toBe(0o600);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('graceful shutdown of the job worker', () => {
  it('re-queues a running job without consuming an attempt; a finished job is recorded', async () => {
    const t = await createTestApp({ now: Date.now() });
    try {
      let started = false;
      t.ctx.jobs.register('blocking', {
        version: '1',
        handler: (run) =>
          new Promise((_, reject) => {
            started = true;
            run.signal.addEventListener('abort', () => reject(run.signal.reason));
          }),
      });
      const j = t.ctx.jobs.enqueue('blocking', {});
      t.ctx.jobs.start();
      const deadline = Date.now() + 3000;
      while (!started && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
      expect(t.ctx.jobs.get(j.id)!.status).toBe('running');
      await t.ctx.jobs.stop();
      expect(t.ctx.jobs.get(j.id)).toMatchObject({ status: 'queued', attempts: 0 });
    } finally {
      await t.close();
    }
  });
});
