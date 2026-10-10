// Learning test helpers: a plain test app (fast, no processing) and small API / sync helpers. Tests that need real
// sources / questions use the Golden Set through the real pipeline (questions / exams helpers).
import type { SyncOpResult } from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import { createTestApp, type AuthHeaders, type TestApp } from '../helpers/app';

export interface LApp extends TestApp {
  h: AuthHeaders;
}

export async function createLearningApp(opts: { now?: number } = {}): Promise<LApp> {
  const t = await createTestApp({ ...(opts.now ? { now: opts.now } : {}) });
  const h = await t.login();
  return Object.assign(t, { h });
}

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
export function api(t: { app: TestApp['app']; h: AuthHeaders }) {
  const call = (method: Method, url: string, payload?: unknown) => t.app.inject({ method, url, headers: t.h, payload: payload as never });
  return {
    get: (url: string) => call('GET', url),
    post: (url: string, payload: unknown = {}) => call('POST', url, payload),
    patch: (url: string, payload: unknown) => call('PATCH', url, payload),
    del: (url: string) => call('DELETE', url),
  };
}

export async function ok<T = any>(p: Promise<{ statusCode: number; body: string; json(): unknown }>, status = 200): Promise<T> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const r = await p;
  if (r.statusCode !== status) throw new Error(`expected ${status}, got ${r.statusCode}: ${r.body}`);
  return r.json() as T;
}

export const DEVICE = 'device-learning-1';

/** Move the test clock (sessions expire after 30 days, so log in again after a jump). */
export async function jump(t: LApp, to: number): Promise<void> {
  t.clock.set(to);
  t.h = await t.login();
}

export interface PushOp {
  entity_type: string;
  entity_id: string;
  op: 'upsert' | 'append' | 'delete';
  payload: unknown;
  op_id?: string;
  base_rev?: number | null;
  device_id?: string;
}

export async function push(t: { app: TestApp['app']; h: AuthHeaders; ctx: TestApp['ctx'] }, ops: PushOp[]): Promise<SyncOpResult[]> {
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/sync/push',
    headers: t.h,
    payload: { ops: ops.map((o) => ({ op_id: o.op_id ?? newId(), device_id: o.device_id ?? DEVICE, client_ts: t.ctx.clock.now(), ...o })) as never },
  });
  if (res.statusCode !== 200) throw new Error(`push failed: ${res.statusCode} ${res.body}`);
  return (res.json() as { results: SyncOpResult[] }).results;
}

export const rt = (text: string) => ({ v: 1 as const, paragraphs: [{ dir: /[؀-ۿ]/.test(text) ? ('rtl' as const) : ('ltr' as const), runs: [{ t: text }] }] });

export const MIN = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

/** Fisher–Yates with a seeded LCG (deterministic shuffles in tests). */
export function shuffled<T>(xs: T[], seed: number): T[] {
  const a = [...xs];
  let s = seed >>> 0;
  for (let i = a.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}
