import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JobError } from '../src/lib/errors';
import { type AuthHeaders, createTestApp, type TestApp } from './helpers/app';

let t: TestApp;
beforeEach(async () => {
  t = await createTestApp({ jobs: { backoffBaseMs: 1000, backoffMaxMs: 60_000 } });
});
afterEach(async () => {
  await t.close();
});

const tick = () => new Promise((r) => setImmediate(r));

describe('JobQueue', () => {
  it('returns the existing job for the same idempotency key', async () => {
    t.ctx.jobs.register('echo', { version: '1', handler: async (run) => run.input });
    const a = t.ctx.jobs.enqueue('echo', { n: 1 }, { idempotencyKey: 'source:1:process' });
    const b = t.ctx.jobs.enqueue('echo', { n: 2 }, { idempotencyKey: 'source:1:process' });
    expect(b.id).toBe(a.id);
    expect(b.input).toEqual({ n: 1 });
    expect(t.ctx.jobs.list().jobs).toHaveLength(1);
    t.ctx.jobs.register('other', { version: '1', handler: async () => null });
    expect(() => t.ctx.jobs.enqueue('other', {}, { idempotencyKey: 'source:1:process' })).toThrow(/مفتاح منع التكرار/);
    await t.ctx.jobs.drain();
    expect(t.ctx.jobs.get(a.id)!.status).toBe('completed');
    expect(t.ctx.jobs.get(a.id)!.output).toEqual({ n: 1 });
  });

  it('resumes from checkpoints after a retryable failure (completed steps are not redone)', async () => {
    const calls = { page1: 0, page2: 0 };
    t.ctx.jobs.register<{ pages: number }, { pages: string[] }>('process', {
      version: '1',
      handler: async (run) => {
        run.progress({ stage: 'extract', done: 0, total: 2, unit: 'pages' });
        const p1 = await run.checkpoint('page:1', () => {
          calls.page1++;
          return 'text-1';
        });
        run.progress({ stage: 'extract', done: 1, total: 2, unit: 'pages' });
        const p2 = await run.checkpoint('page:2', () => {
          calls.page2++;
          if (run.attempt === 1) throw new JobError('OCR_TEMPORARY', 'تعذر التعرف الضوئي مؤقتًا؛ ستُعاد المحاولة.', { retryable: true });
          return 'text-2';
        });
        run.progress({ stage: 'extract', done: 2, total: 2, unit: 'pages' });
        return { pages: [p1, p2] };
      },
    });
    const job = t.ctx.jobs.enqueue('process', { pages: 2 });
    await t.ctx.jobs.drain();
    let v = t.ctx.jobs.get(job.id)!;
    expect(v.status).toBe('queued'); // waiting for backoff
    expect(v.error).toEqual({ code: 'OCR_TEMPORARY', message: 'تعذر التعرف الضوئي مؤقتًا؛ ستُعاد المحاولة.', retryable: true });
    expect(v.run_after).toBe(t.clock.now() + 1000);
    expect(v.checkpoints).toBe(1);
    expect(v.progress).toEqual({ stage: 'extract', done: 1, total: 2, unit: 'pages' });

    t.clock.advance(1000);
    await t.ctx.jobs.drain();
    v = t.ctx.jobs.get(job.id)!;
    expect(v.status).toBe('completed');
    expect(v.attempts).toBe(2);
    expect(v.error).toBeNull();
    expect(v.output).toEqual({ pages: ['text-1', 'text-2'] });
    expect(v.progress).toEqual({ stage: 'extract', done: 2, total: 2, unit: 'pages' });
    expect(calls).toEqual({ page1: 1, page2: 2 });
  });

  it('distinguishes retryable from fatal failures', async () => {
    t.ctx.jobs.register('fatal', {
      version: '1',
      handler: async () => {
        throw new JobError('PDF_INVALID', 'الملف ليس PDF صالحًا. ارفع نسخة أخرى من الملف.', { retryable: false });
      },
    });
    t.ctx.jobs.register('flaky', {
      version: '1',
      maxAttempts: 3,
      handler: async () => {
        throw new JobError('NETWORK', 'انقطع الاتصال؛ ستُعاد المحاولة.', { retryable: true });
      },
    });
    const f = t.ctx.jobs.enqueue('fatal', {});
    const r = t.ctx.jobs.enqueue('flaky', {});
    await t.ctx.jobs.drain();
    expect(t.ctx.jobs.get(f.id)).toMatchObject({ status: 'failed', attempts: 1, error: { code: 'PDF_INVALID', retryable: false } });
    for (let i = 0; i < 5; i++) {
      t.clock.advance(60_000);
      await t.ctx.jobs.drain();
    }
    expect(t.ctx.jobs.get(r.id)).toMatchObject({ status: 'failed', attempts: 3, error: { code: 'NETWORK', retryable: true } });
  });

  it('never stores stack traces for unexpected errors', async () => {
    t.ctx.jobs.register('boom', {
      version: '1',
      maxAttempts: 1,
      handler: async () => {
        throw new TypeError('secret internal detail /var/lib/x.sqlite');
      },
    });
    const j = t.ctx.jobs.enqueue('boom', {});
    await t.ctx.jobs.drain();
    const v = t.ctx.jobs.get(j.id)!;
    expect(v.status).toBe('failed');
    expect(v.error!.code).toBe('INTERNAL');
    expect(v.error!.message).toMatch(/[؀-ۿ]/);
    expect(JSON.stringify(v)).not.toContain('secret internal detail');
  });

  it('keeps partial distinct from completed', async () => {
    t.ctx.jobs.register('half', { version: '1', handler: async () => ({ partial: true as const, output: { pages_ok: 3, pages_failed: [4] } }) });
    t.ctx.jobs.register('full', { version: '1', handler: async () => ({ pages_ok: 4 }) });
    const a = t.ctx.jobs.enqueue('half', {});
    const b = t.ctx.jobs.enqueue('full', {});
    await t.ctx.jobs.drain();
    expect(t.ctx.jobs.get(a.id)).toMatchObject({ status: 'partial', status_label_ar: 'اكتمل جزئيًا', output: { pages_ok: 3, pages_failed: [4] } });
    expect(t.ctx.jobs.get(b.id)).toMatchObject({ status: 'completed', output: { pages_ok: 4 } });
  });

  it('cancel keeps completed checkpoints; retry resumes without redoing them', async () => {
    let step1Runs = 0;
    let block = true;
    let release: (() => void) | null = null;
    t.ctx.jobs.register('long', {
      version: '1',
      handler: async (run) => {
        await run.checkpoint('step:1', () => {
          step1Runs++;
          return 'done-1';
        });
        if (block && !run.isCancelled()) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return 'finished';
      },
    });
    const j = t.ctx.jobs.enqueue('long', {});
    const draining = t.ctx.jobs.drain();
    while (t.ctx.jobs.get(j.id)!.checkpoints < 1) await tick();
    const cancelled = t.ctx.jobs.cancel(j.id);
    expect(cancelled.cancel_requested_at).not.toBeNull();
    await draining;
    let v = t.ctx.jobs.get(j.id)!;
    expect(v.status).toBe('cancelled');
    expect(v.checkpoints).toBe(1);
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM job_checkpoint WHERE job_id = ?', [j.id])!.n).toBe(1);
    expect(() => t.ctx.jobs.cancel(j.id)).toThrow(/منتهية/);
    block = false;
    (release as (() => void) | null)?.();

    t.ctx.jobs.retry(j.id);
    await t.ctx.jobs.drain();
    v = t.ctx.jobs.get(j.id)!;
    expect(v.status).toBe('completed');
    expect(step1Runs).toBe(1);
  });

  // regression: shutdown was checked before cancel, so a job cancelled just before the server stopped
  // was re-queued (attempt given back) and ran again on the next boot despite the owner's cancel.
  it('a cancel that races with shutdown stays cancelled (never re-queued)', async () => {
    const real = await createTestApp({ now: Date.now() });
    try {
      let started = false;
      real.ctx.jobs.register('blocking', {
        version: '1',
        handler: (run) =>
          new Promise((_, reject) => {
            started = true;
            run.signal.addEventListener('abort', () => reject(run.signal.reason));
          }),
      });
      const j = real.ctx.jobs.enqueue('blocking', {});
      real.ctx.jobs.start();
      const deadline = Date.now() + 3000;
      while (!started && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
      expect(real.ctx.jobs.get(j.id)!.status).toBe('running');
      real.ctx.jobs.cancel(j.id);
      await real.ctx.jobs.stop(); // same tick as the cancel
      expect(real.ctx.jobs.get(j.id)).toMatchObject({ status: 'cancelled', error: { code: 'JOB_CANCELLED' } });
    } finally {
      await real.close();
    }
  });

  it('cancels queued jobs immediately', async () => {
    t.ctx.jobs.register('later', { version: '1', handler: async () => 'x' });
    const j = t.ctx.jobs.enqueue('later', {}, { runAfter: t.clock.now() + 60_000 });
    expect(t.ctx.jobs.cancel(j.id).status).toBe('cancelled');
    t.clock.advance(120_000);
    await t.ctx.jobs.drain();
    expect(t.ctx.jobs.get(j.id)!.status).toBe('cancelled');
  });

  it('re-queues running jobs with a stale heartbeat (crash recovery) and resumes from checkpoints', async () => {
    let s1 = 0;
    t.ctx.jobs.register('resumable', {
      version: '1',
      handler: async (run) => {
        const a = await run.checkpoint('s1', () => ++s1);
        return { a };
      },
    });
    const j = t.ctx.jobs.enqueue('resumable', {});
    // simulate a crash mid-run: running row, step 1 saved, heartbeat 2 minutes old
    t.ctx.db.run(`UPDATE processing_job SET status = 'running', attempts = 1, heartbeat_at = ? WHERE id = ?`, [t.clock.now() - 120_000, j.id]);
    t.ctx.db.run(`INSERT INTO job_checkpoint (job_id, step_key, data_json, done_at) VALUES (?, 's1', '41', ?)`, [j.id, t.clock.now()]);
    // a fresh heartbeat is NOT stale
    const fresh = t.ctx.jobs.enqueue('resumable', { other: true });
    t.ctx.db.run(`UPDATE processing_job SET status = 'running', attempts = 1, heartbeat_at = ? WHERE id = ?`, [t.clock.now() - 1000, fresh.id]);

    expect(t.ctx.jobs.requeueStale()).toBe(1);
    expect(t.ctx.jobs.get(j.id)).toMatchObject({ status: 'queued', error: { code: 'JOB_INTERRUPTED', retryable: true } });
    expect(t.ctx.jobs.get(fresh.id)!.status).toBe('running');
    await t.ctx.jobs.drain();
    expect(t.ctx.jobs.get(j.id)).toMatchObject({ status: 'completed', output: { a: 41 }, error: null });
    expect(s1).toBe(0);

    // exhausted attempts → failed (owner may retry)
    const k = t.ctx.jobs.enqueue('resumable', { k: 1 });
    t.ctx.db.run(`UPDATE processing_job SET status = 'running', attempts = 3, heartbeat_at = NULL WHERE id = ?`, [k.id]);
    t.ctx.jobs.requeueStale();
    expect(t.ctx.jobs.get(k.id)).toMatchObject({ status: 'failed', error: { code: 'JOB_INTERRUPTED' } });
  });

  it('times out via AbortSignal and retries', async () => {
    let sawAbort = false;
    t.ctx.jobs.register('slow', {
      version: '1',
      timeoutMs: 30,
      maxAttempts: 2,
      handler: (run) =>
        new Promise((_, reject) => {
          run.signal.addEventListener('abort', () => {
            sawAbort = true;
            reject(run.signal.reason);
          });
        }),
    });
    const j = t.ctx.jobs.enqueue('slow', {});
    await t.ctx.jobs.drain();
    expect(sawAbort).toBe(true);
    expect(t.ctx.jobs.get(j.id)).toMatchObject({ status: 'queued', error: { code: 'JOB_TIMEOUT', retryable: true } });
  });

  it('supports waiting_for_input and owner retry', async () => {
    let needInput = true;
    t.ctx.jobs.register('needs-owner', {
      version: '1',
      handler: async () => {
        if (needInput) throw new JobError('PASSWORD_PROTECTED', 'الملف محمي بكلمة مرور. أزل الحماية ثم أعد المحاولة.', { retryable: false, waitForInput: true });
        return 'ok';
      },
    });
    const j = t.ctx.jobs.enqueue('needs-owner', {});
    await t.ctx.jobs.drain();
    expect(t.ctx.jobs.get(j.id)!.status).toBe('waiting_for_input');
    needInput = false;
    t.ctx.jobs.retry(j.id);
    await t.ctx.jobs.drain();
    expect(t.ctx.jobs.get(j.id)!.status).toBe('completed');
  });

  it('validates input with the registered schema and clamps progress counts', async () => {
    const { z } = await import('zod');
    t.ctx.jobs.register('typed', {
      version: '1',
      inputSchema: z.object({ sourceId: z.string() }),
      handler: async (run) => {
        run.progress({ stage: 'x', done: 9, total: 3, unit: 'pages' });
        return null;
      },
    });
    expect(() => t.ctx.jobs.enqueue('typed', { nope: 1 })).toThrow();
    const j = t.ctx.jobs.enqueue('typed', { sourceId: 's' });
    // progress is written while running; capture it via a second job kind would be overkill: check after run
    await t.ctx.jobs.drain();
    expect(t.ctx.jobs.get(j.id)!.progress).toEqual({ stage: 'x', done: 3, total: 3, unit: 'pages' });
  });

  it('runs jobs automatically once started, with bounded concurrency', async () => {
    const real = await createTestApp({ now: Date.now() });
    try {
      let concurrent = 0;
      let maxConcurrent = 0;
      real.ctx.jobs.register('work', {
        version: '1',
        handler: async () => {
          concurrent++;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await new Promise((r) => setTimeout(r, 20));
          concurrent--;
          return 'ok';
        },
      });
      const ids = Array.from({ length: 5 }, (_, i) => real.ctx.jobs.enqueue('work', { i }).id);
      real.ctx.jobs.start();
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && ids.some((id) => real.ctx.jobs.get(id)!.status !== 'completed')) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(ids.map((id) => real.ctx.jobs.get(id)!.status)).toEqual(Array(5).fill('completed'));
      expect(maxConcurrent).toBeLessThanOrEqual(real.config.jobs.concurrency);
    } finally {
      await real.close();
    }
  });
});

describe('jobs API', () => {
  let h: AuthHeaders;
  beforeEach(async () => {
    ({ headers: h } = await t.setupOwner());
    t.ctx.jobs.register('api-fail', {
      version: '1',
      handler: async () => {
        throw new JobError('UNREADABLE', 'تعذر قراءة الصفحة 3. أعد رفع الملف أو صحّحه يدويًا.', { retryable: false });
      },
    });
  });

  it('lists with filters, shows details, cancels and retries (audited)', async () => {
    const j = t.ctx.jobs.enqueue('api-fail', { sourceId: 'x' });
    await t.ctx.jobs.drain();
    const list = await t.app.inject({ method: 'GET', url: '/api/jobs?status=failed&kind=api-fail', headers: h });
    expect(list.statusCode).toBe(200);
    expect(list.json().jobs.map((x: { id: string }) => x.id)).toEqual([j.id]);
    expect(list.json().jobs[0].error.message).toContain('الصفحة 3');
    expect((await t.app.inject({ method: 'GET', url: '/api/jobs?status=completed', headers: h })).json().jobs).toEqual([]);
    expect((await t.app.inject({ method: 'GET', url: '/api/jobs?status=bogus', headers: h })).statusCode).toBe(400);

    const detail = await t.app.inject({ method: 'GET', url: `/api/jobs/${j.id}`, headers: h });
    expect(detail.json()).toMatchObject({ id: j.id, status: 'failed', input: { sourceId: 'x' } });

    const cancelTerminal = await t.app.inject({ method: 'POST', url: `/api/jobs/${j.id}/cancel`, headers: h });
    expect(cancelTerminal.statusCode).toBe(409);
    const retry = await t.app.inject({ method: 'POST', url: `/api/jobs/${j.id}/retry`, headers: h });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().status).toBe('queued');
    const cancel = await t.app.inject({ method: 'POST', url: `/api/jobs/${j.id}/cancel`, headers: h });
    expect(cancel.json().status).toBe('cancelled');
    expect(t.ctx.audit.list({ entityType: 'processing_job', entityId: j.id }).entries.map((e) => e.action)).toEqual(['cancel', 'retry']);
    expect((await t.app.inject({ method: 'GET', url: '/api/jobs/01J0000000000000000000000Z', headers: h })).statusCode).toBe(404);
  });
});
