// Client error tracking (§56): redacted before it leaves the browser, grouped with counts, batched, sent with the CSRF
// header and the session cookie only while signed in, silent on its own failures (never console noise), bounded.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createErrorReporter, installErrorReporter, reportError, uninstallErrorReporter } from '../src/lib/errorReporter';

type Sent = { url: string; init: RequestInit; body: { errors: Array<Record<string, unknown>> } };

function fakeFetch(status = 200) {
  const sent: Sent[] = [];
  const impl = vi.fn(async (url: string, init: RequestInit) => {
    sent.push({ url, init, body: JSON.parse(String(init.body)) });
    return new Response('{}', { status });
  });
  return { sent, impl };
}

afterEach(() => uninstallErrorReporter());

describe('createErrorReporter', () => {
  it('redacts before sending: no query, no long quoted text, no secrets; stack reduced to code locations', async () => {
    const f = fakeFetch();
    const r = createErrorReporter({ fetchImpl: f.impl, flushMs: 0, route: () => '/search?q=الزائدة', appVersion: '0.1.0' });
    const err = new TypeError(`bad token sk-ant-abc123 in "${'The appendix is a blind-ended tube connected to the cecum'}"`);
    err.stack = 'TypeError: x\n    at Search (https://medlevo.example/assets/index-1.js?v=2:3:4)';
    r.report('error', err);
    await r.flush();
    const e = f.sent[0]!.body.errors[0]!;
    expect(e.kind).toBe('error');
    expect(e.route).toBe('/search');
    expect(String(e.message)).toContain('TypeError: ');
    expect(String(e.message)).not.toContain('sk-ant');
    expect(String(e.message)).not.toContain('cecum');
    expect(e.stack).toBe('Search (/assets/index-1.js:3:4)');
    expect(e.app_version).toBe('0.1.0');
    expect(f.sent[0]!.url).toBe('/api/control/client-errors');
    expect(f.sent[0]!.init).toMatchObject({ method: 'POST', credentials: 'same-origin', headers: { 'x-medlevo-csrf': '1', 'content-type': 'application/json' } });
  });

  it('groups the same problem with a count and sends one batch; ignores benign browser noise', async () => {
    const f = fakeFetch();
    const r = createErrorReporter({ fetchImpl: f.impl, flushMs: 0 });
    for (let i = 0; i < 5; i++) r.report('unhandledrejection', new Error(`Request failed after ${i * 100} ms`));
    r.report('error', 'ResizeObserver loop completed with undelivered notifications.');
    r.report('error', 'Script error.');
    expect(r.pending()).toBe(1);
    await r.flush();
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]!.body.errors).toHaveLength(1);
    expect(f.sent[0]!.body.errors[0]!.count).toBe(5);
    await r.flush(); // nothing left
    expect(f.sent).toHaveLength(1);
  });

  it('keeps the batch while signed out or offline, drops it on 401/403, retries after a 5xx; never logs to the console', async () => {
    const spy = vi.spyOn(console, 'error');
    const warn = vi.spyOn(console, 'warn');
    let signedIn = false;
    let mode: 'offline' | 401 | 500 | 200 = 'offline';
    const sent: number[] = [];
    const r = createErrorReporter({
      flushMs: 0,
      canSend: () => signedIn,
      fetchImpl: async () => {
        sent.push(1);
        if (mode === 'offline') throw new TypeError('Failed to fetch');
        return new Response('{}', { status: mode });
      },
    });
    r.report('error', new Error('boom'));
    await r.flush();
    expect(sent).toHaveLength(0); // signed out: not sent, kept
    expect(r.pending()).toBe(1);
    signedIn = true;
    await r.flush();
    expect(r.pending()).toBe(1); // offline: kept
    mode = 500;
    await r.flush();
    expect(r.pending()).toBe(1); // server error: kept for the next flush
    mode = 401;
    await r.flush();
    expect(r.pending()).toBe(0); // refused: dropped, never retried forever
    expect(spy).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('is bounded: at most 20 pending and 30 distinct problems per page session', async () => {
    const f = fakeFetch();
    const r = createErrorReporter({ fetchImpl: f.impl, flushMs: 0 });
    for (let i = 0; i < 50; i++) r.report('error', new Error(`distinct problem ${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))}`));
    expect(r.pending()).toBe(20);
    await r.flush();
    for (let i = 50; i < 80; i++) r.report('error', new Error(`another problem ${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))}`));
    expect(r.pending()).toBe(10); // 20 sent + 10 more = the 30 distinct cap
  });

  it('flushes on its interval', async () => {
    vi.useFakeTimers();
    try {
      const f = fakeFetch();
      const r = createErrorReporter({ fetchImpl: f.impl, flushMs: 1000 });
      r.report('error', new Error('later'));
      expect(f.sent).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.sent).toHaveLength(1);
      r.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('installErrorReporter', () => {
  it('captures window errors, unhandled rejections and route errors reported by the app; flushes with keepalive on pagehide', async () => {
    const f = fakeFetch();
    const r = installErrorReporter(window, { fetchImpl: f.impl, flushMs: 0, route: () => '/library' });
    window.dispatchEvent(new ErrorEvent('error', { message: 'Uncaught ReferenceError: foo is not defined', error: new ReferenceError('foo is not defined') }));
    const ev = new Event('unhandledrejection') as Event & { reason?: unknown };
    ev.reason = new Error('upload promise rejected');
    window.dispatchEvent(ev);
    reportError('route', new Error('loader failed'));
    expect(r.pending()).toBe(3);
    window.dispatchEvent(new Event('pagehide'));
    await vi.waitFor(() => expect(f.sent).toHaveLength(1));
    expect(f.sent[0]!.init.keepalive).toBe(true);
    expect(f.sent[0]!.body.errors.map((e) => e.kind).sort()).toEqual(['error', 'route', 'unhandledrejection']);
    expect(f.sent[0]!.body.errors.every((e) => e.route === '/library')).toBe(true);
    // a second install returns the same reporter (one set of listeners)
    expect(installErrorReporter(window, { fetchImpl: f.impl })).toBe(r);
  });

  it('reportError is a no-op when the reporter is not installed', () => {
    expect(() => reportError('route', new Error('x'))).not.toThrow();
  });
});
