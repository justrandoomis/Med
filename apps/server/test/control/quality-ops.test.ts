// §56 (track F5): the client error sink (redacted twice, grouped with counts, retention by age and row cap, owner
// session + CSRF, rate limited, audited clear) and the daily trend metrics for citation / verification failures and
// sync rejections / conflicts (owner time zone, denominators, computed from the real rows the modules write).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLIENT_ERROR_MAX_ROWS, type ClientErrorsResponse, type HealthTrendsResponse } from '@medlevo/shared';
import { toJson } from '../../src/db/db';
import { newId } from '../../src/lib/ids';
import { browserFamily } from '../../src/modules/control/client-errors';
import { dayBoundaries, startOfDayInTz } from '../../src/modules/control/trends';
import { CSRF, createTestApp, type AuthHeaders, type TestApp } from '../helpers/app';

const DAY = 24 * 3600 * 1000;
let t: TestApp;
let h: AuthHeaders;

beforeAll(async () => {
  t = await createTestApp();
  h = await t.login();
});
afterAll(async () => {
  await t?.close();
});

const post = (errors: unknown[], headers: Record<string, string> = h) =>
  t.app.inject({ method: 'POST', url: '/api/control/client-errors', headers: { ...headers, 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' }, payload: { errors } });
const list = async () => (await t.app.inject({ method: 'GET', url: '/api/control/client-errors', headers: h })).json() as ClientErrorsResponse;

describe('client error sink', () => {
  it('stores a redacted error: no document text, no query, no token; frames reduced to code locations', async () => {
    const res = await post([
      {
        kind: 'error',
        message: `Unexpected token in "${'Pain usually begins in the periumbilical region and later migrates'}" token=abc123secret`,
        stack: 'TypeError: x\n    at Foo (https://medlevo.example/assets/index-1.js?v=1:10:20)\n    owner note: يبدأ الألم عادة حول السرة ثم ينتقل إلى الحفرة',
        route: '/search?q=appendicitis#top',
        app_version: '0.1.0',
      },
    ]);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ stored: 1, dropped: 0 });
    const row = (await list()).items[0]!;
    expect(row.message).not.toContain('periumbilical');
    expect(row.message).not.toContain('abc123secret');
    expect(row.message).toContain('[quoted-text]');
    expect(row.stack).toBe('Foo (/assets/index-1.js:10:20)');
    expect(row.route).toBe('/search');
    expect(row.user_agent).toBe('Chrome 131');
    expect(JSON.stringify(row)).not.toMatch(/يبدأ|appendicitis|medlevo\.example/);
  });

  it('groups the same problem by fingerprint with a count (numbers in the message do not split it)', async () => {
    const e = (n: number) => ({ kind: 'unhandledrejection', message: `Request failed after ${n} ms`, stack: 'at load (https://x/assets/a.js:1:1)', route: '/library', count: 2 });
    await post([e(120), e(4500)]);
    await post([e(77)]);
    const rows = (await list()).items.filter((r) => r.kind === 'unhandledrejection');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.count).toBe(6);
  });

  it('a batch keeps at most 20 errors and says how many it dropped; invalid bodies are refused', async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ kind: 'route', message: `route error ${String.fromCharCode(65 + i)}`, stack: `at r (https://x/assets/r.js:${i + 1}:1)` }));
    expect((await post(many)).json()).toEqual({ stored: 20, dropped: 5 });
    expect((await post([{ kind: 'nope', message: 'x' }])).statusCode).toBe(400);
    expect((await post([])).statusCode).toBe(400);
    expect((await post([{ kind: 'error', message: 'x', extra: 'field' }])).statusCode).toBe(400);
  });

  it('needs the owner session and the CSRF header', async () => {
    const anon = await t.app.inject({ method: 'POST', url: '/api/control/client-errors', headers: CSRF, payload: { errors: [{ kind: 'error', message: 'x' }] } });
    expect(anon.statusCode).toBe(401);
    const noCsrf = await t.app.inject({ method: 'POST', url: '/api/control/client-errors', headers: { cookie: h.cookie }, payload: { errors: [{ kind: 'error', message: 'x' }] } });
    expect(noCsrf.statusCode).toBe(403);
    expect((await t.app.inject({ method: 'GET', url: '/api/control/client-errors' })).statusCode).toBe(401);
  });

  it('retention: 30 days after the last occurrence, and at most 500 different errors', async () => {
    await post([{ kind: 'error', message: 'old problem', stack: 'at old (https://x/o.js:1:1)' }]);
    t.clock.advance(31 * DAY);
    h = await t.login(); // the 30-day session expired with the clock
    const after = await list();
    expect(after.items.some((r) => r.message === 'old problem')).toBe(false);
    expect(after.retention_ar).toContain('30');
    // fill above the cap: the oldest go first
    const now = t.clock.now();
    t.ctx.db.tx(() => {
      for (let i = 0; i < CLIENT_ERROR_MAX_ROWS + 20; i++) {
        t.ctx.db.run(
          `INSERT INTO client_error (id, fingerprint, kind, message, stack, route, app_version, user_agent, count, first_seen_at, last_seen_at) VALUES (?, ?, 'error', ?, NULL, NULL, NULL, NULL, 1, ?, ?)`,
          [newId(), `fp-${i}`, `bulk ${i}`, now - i * 1000, now - i * 1000],
        );
      }
    });
    await post([{ kind: 'error', message: 'newest', stack: 'at n (https://x/n.js:1:1)' }]);
    const capped = await list();
    expect(capped.total).toBe(CLIENT_ERROR_MAX_ROWS);
    expect(t.ctx.db.get('SELECT 1 AS x FROM client_error WHERE fingerprint = ?', [`fp-${CLIENT_ERROR_MAX_ROWS + 19}`])).toBeUndefined();
    expect(capped.items[0]!.message).toBe('newest');
  });

  it('clearing is an owner action recorded in the history', async () => {
    const res = await t.app.inject({ method: 'DELETE', url: '/api/control/client-errors', headers: h });
    expect(res.statusCode).toBe(200);
    expect(res.json().deleted).toBeGreaterThan(0);
    expect((await list()).total).toBe(0);
    expect(t.ctx.db.get<{ action: string }>(`SELECT action FROM change_log WHERE entity_type = 'client_error' ORDER BY created_at DESC LIMIT 1`)?.action).toBe('clear');
  });

  it('browser family only, never the full user agent', () => {
    expect(browserFamily('Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1')).toBe('Safari 18');
    expect(browserFamily('Mozilla/5.0 (Windows NT 10.0; rv:133.0) Gecko/20100101 Firefox/133.0')).toBe('Firefox 133');
    expect(browserFamily('Mozilla/5.0 Chrome/131.0 Safari/537.36 Edg/131.0')).toBe('Edge 131');
    expect(browserFamily(undefined)).toBeNull();
  });
});

describe('(review F5) the sink is rate limited and cheap on hostile bodies', () => {
  let t2: TestApp;
  let h2: AuthHeaders;
  beforeAll(async () => {
    t2 = await createTestApp();
    h2 = await t2.login();
  });
  afterAll(async () => {
    await t2?.close();
  });

  it('30 batches a minute per client, then 429 with a retry hint; nothing more is stored', async () => {
    const send = (i: number) => t2.app.inject({ method: 'POST', url: '/api/control/client-errors', headers: h2, payload: { errors: [{ kind: 'error', message: `burst ${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))}` }] } });
    const codes: number[] = [];
    for (let i = 0; i < 32; i++) codes.push((await send(i)).statusCode);
    expect(codes.slice(0, 30).every((c) => c === 200)).toBe(true);
    const limited = await send(99);
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('RATE_LIMITED');
    expect(codes.slice(30)).toEqual([429, 429]);
    const n = t2.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM client_error')!.n;
    expect(n).toBe(30);
    // another route of the control module is not affected by this limit
    expect((await t2.app.inject({ method: 'GET', url: '/api/control/client-errors', headers: h2 })).statusCode).toBe(200);
  });

  it('a hostile stack (catastrophic-backtracking shape) is redacted in linear time, not minutes', async () => {
    const t3 = await createTestApp();
    try {
      const h3 = await t3.login();
      const stack = [`at ${' '.repeat(15_000)}x`].join('\n');
      const errors = Array.from({ length: 5 }, (_, i) => ({ kind: 'error', message: `hostile ${i}`, stack }));
      const t0 = Date.now();
      const res = await t3.app.inject({ method: 'POST', url: '/api/control/client-errors', headers: h3, payload: { errors } });
      expect(res.statusCode).toBe(200);
      expect(Date.now() - t0).toBeLessThan(3000);
      expect(t3.ctx.db.all<{ stack: string | null }>('SELECT stack FROM client_error').every((r) => r.stack === null)).toBe(true);
    } finally {
      await t3.close();
    }
  });
});

describe('daily trends (owner time zone, with denominators)', () => {
  it('day boundaries are local midnights (Asia/Baghdad = UTC+3) and the window ends tomorrow', () => {
    const now = Date.UTC(2026, 9, 10, 22, 30); // 01:30 on Oct 11 in Baghdad
    expect(startOfDayInTz(now, 'Asia/Baghdad')).toBe(Date.UTC(2026, 9, 10, 21, 0));
    const b = dayBoundaries(now, 3, 'Asia/Baghdad');
    expect(b).toEqual([Date.UTC(2026, 9, 8, 21), Date.UTC(2026, 9, 9, 21), Date.UTC(2026, 9, 10, 21), Date.UTC(2026, 9, 11, 21)]);
    // a DST zone: the day of the spring change is 23 hours long
    const ny = dayBoundaries(Date.UTC(2026, 2, 9, 12), 2, 'America/New_York');
    expect(ny[1]! - ny[0]!).toBe(23 * 3600 * 1000);
  });

  it('counts claims checked, rejected citations, unsupported claims and sync rejections / conflicts per day', async () => {
    const now = t.clock.now();
    const today = startOfDayInTz(now, 'Asia/Baghdad') + 3600 * 1000;
    const yesterday = today - DAY;
    const claim = (at: number, checks: Array<[string, boolean, Record<string, unknown>?]>) => {
      const id = newId();
      t.ctx.db.run(`INSERT INTO claim (id, owner_type, owner_id, text, support_type, verification_status, created_at, updated_at) VALUES (?, 'content_block', 'b', 'x', 'derived', 'rejected', ?, ?)`, [id, at, at]);
      for (const [check, passed, details] of checks) {
        t.ctx.db.run(`INSERT INTO verification_result (id, subject_type, subject_id, check_name, passed, details_json, verifier, verifier_version, created_at) VALUES (?, 'claim', ?, ?, ?, ?, 'deterministic', 'v', ?)`, [
          newId(),
          id,
          check,
          passed ? 1 : 0,
          toJson(details ?? {}),
          at,
        ]);
      }
    };
    claim(yesterday, [['evidence_exists', false], ['in_scope', false]]); // one claim, two failed citation checks → counted once
    claim(yesterday, [['evidence_exists', true], ['critical_tokens', false]]);
    claim(today, [['evidence_exists', true], ['entailment', false, { status: 'unavailable' }]]); // no verifier: NOT an unsupported claim
    claim(today, [['evidence_exists', true], ['entailment', false, { verdict: 'not_supported' }]]);
    claim(today, [['evidence_exists', true], ['entailment', true, { verdict: 'supported' }]]);
    const op = (at: number, result: string) =>
      t.ctx.db.run(`INSERT INTO sync_operation (op_id, device_id, entity_type, entity_id, op, payload_json, result, server_seq, received_at) VALUES (?, 'd', 'note', ?, 'upsert', '{}', ?, 1, ?)`, [newId(), newId(), result, at]);
    op(yesterday, 'applied');
    op(yesterday, 'rejected');
    op(today, 'conflict_kept_both');
    op(today, 'applied');
    op(today, 'duplicate');
    op(now - 30 * DAY, 'rejected'); // outside a 14-day window

    const res = await t.app.inject({ method: 'GET', url: '/api/control/health?days=14', headers: h });
    expect(res.statusCode).toBe(200);
    const tr = res.json() as HealthTrendsResponse;
    expect(tr.timezone).toBe('Asia/Baghdad');
    expect(tr.days).toHaveLength(14);
    const s = Object.fromEntries(tr.series.map((x) => [x.key, x]));
    const last2 = (k: string) => s[k]!.counts.slice(-2);
    expect(last2('claims_checked')).toEqual([2, 3]);
    expect(last2('citation_invalid')).toEqual([1, 0]);
    expect(last2('claim_unsupported')).toEqual([1, 1]);
    expect(last2('sync_ops')).toEqual([2, 3]);
    expect(last2('sync_rejected')).toEqual([1, 0]);
    expect(last2('sync_conflict')).toEqual([0, 1]);
    expect(s.sync_rejected!.total).toBe(1);
    expect(s.citation_invalid!.of).toBe('claims_checked');
    expect(s.sync_conflict!.of).toBe('sync_ops');
    expect(tr.notes_ar.join(' ')).toContain('لا نسب مئوية');
    expect((await t.app.inject({ method: 'GET', url: '/api/control/health?days=400', headers: h })).statusCode).toBe(400);
    expect((await t.app.inject({ method: 'GET', url: '/api/control/health' })).statusCode).toBe(401);
  });
});
