// Robustness pass (production: after container restarts the queue logged «requeued stale running jobs» then «job
// failed» JOB_INTERRUPTED). A job cut off because its process went away (restart, deploy, host move, crash) gives its
// attempt back and the interruption is counted apart (processing_job.interruptions, migration 0031) with its own,
// higher cap — so restarts never exhaust the attempts of a real error, while a job that keeps killing its process
// still stops. Also: the «not ready yet» deferral (JobError retryAfterMs) and runNow (one job, awaited, bounded).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JobError } from '../../src/lib/errors';
import { createTestApp, type TestApp } from '../helpers/app';

let t: TestApp;
beforeEach(async () => {
  t = await createTestApp({ jobs: { backoffBaseMs: 1000, backoffMaxMs: 60_000 } });
});
afterEach(async () => {
  await t.close();
});

/** the process that ran the job vanished: running row, stale heartbeat */
function crash(id: string): void {
  t.ctx.db.run(`UPDATE processing_job SET status = 'running', attempts = attempts + 1, heartbeat_at = ? WHERE id = ?`, [t.clock.now() - 10 * 60_000, id]);
}
const counters = (id: string) => t.ctx.db.get<{ attempts: number; interruptions: number; deferrals: number; status: string }>('SELECT attempts, interruptions, deferrals, status FROM processing_job WHERE id = ?', [id])!;

describe('interruptions are not attempts', () => {
  beforeEach(() => {
    t.ctx.jobs.register('one_shot', { version: '1', maxAttempts: 2, handler: async () => ({ ok: true }) });
  });

  it('several restarts in a row re-queue the job without spending its attempts; it then completes', async () => {
    const j = t.ctx.jobs.enqueue('one_shot', {});
    for (let i = 1; i <= 4; i++) {
      crash(j.id);
      expect(t.ctx.jobs.requeueStale()).toBe(1);
      expect(counters(j.id)).toMatchObject({ status: 'queued', attempts: 0, interruptions: i });
      expect(t.ctx.jobs.get(j.id)).toMatchObject({ error: { code: 'JOB_INTERRUPTED', retryable: true } });
    }
    await t.ctx.jobs.drain();
    expect(t.ctx.jobs.get(j.id)).toMatchObject({ status: 'completed', attempts: 1, error: null });
  });

  it('a job interrupted on its LAST attempt (max_attempts reached) is resumed, not failed', async () => {
    const j = t.ctx.jobs.enqueue('one_shot', {});
    t.ctx.db.run(`UPDATE processing_job SET status = 'running', attempts = 2, heartbeat_at = NULL WHERE id = ?`, [j.id]);
    t.ctx.jobs.requeueStale();
    expect(counters(j.id)).toMatchObject({ status: 'queued', attempts: 1, interruptions: 1 });
    await t.ctx.jobs.drain();
    expect(t.ctx.jobs.get(j.id)!.status).toBe('completed');
  });

  it('a job that keeps killing its process still stops: failed JOB_INTERRUPTED after maxInterruptions (5)', () => {
    const j = t.ctx.jobs.enqueue('one_shot', {});
    for (let i = 1; i <= 5; i++) {
      crash(j.id);
      t.ctx.jobs.requeueStale();
      expect(counters(j.id).status).toBe('queued');
    }
    crash(j.id);
    t.ctx.jobs.requeueStale();
    expect(counters(j.id)).toMatchObject({ status: 'failed', interruptions: 6 });
    expect(t.ctx.jobs.get(j.id)).toMatchObject({ status: 'failed', error: { code: 'JOB_INTERRUPTED', retryable: true } });
    // the owner's retry starts both budgets again
    expect(t.ctx.jobs.retry(j.id).status).toBe('queued');
    expect(counters(j.id)).toMatchObject({ attempts: 0, interruptions: 0, deferrals: 0 });
  });

  it('real errors keep their own budget: interruptions in between do not shorten or lengthen it', async () => {
    let calls = 0;
    t.ctx.jobs.register('flaky', {
      version: '1',
      maxAttempts: 2,
      handler: async () => {
        calls++;
        throw new JobError('BOOM', 'خطأ تجريبي.', { retryable: true });
      },
    });
    const j = t.ctx.jobs.enqueue('flaky', {});
    crash(j.id);
    t.ctx.jobs.requeueStale();
    await t.ctx.jobs.drain(); // real attempt 1 → retry scheduled
    expect(counters(j.id)).toMatchObject({ status: 'queued', attempts: 1, interruptions: 1 });
    t.clock.advance(60_000);
    await t.ctx.jobs.drain(); // real attempt 2 → failed
    expect(calls).toBe(2);
    expect(t.ctx.jobs.get(j.id)).toMatchObject({ status: 'failed', attempts: 2, error: { code: 'BOOM' } });
  });

  it('a graceful shutdown (SIGTERM → stop) re-queues a running job with its attempt given back', async () => {
    t.ctx.jobs.register('long', {
      version: '1',
      maxAttempts: 1,
      handler: (run) => new Promise((_, reject) => run.signal.addEventListener('abort', () => reject(run.signal.reason))),
    });
    const j = t.ctx.jobs.enqueue('long', {});
    t.ctx.jobs.start();
    await new Promise((r) => setTimeout(r, 20));
    expect(t.ctx.jobs.get(j.id)!.status).toBe('running');
    await t.ctx.jobs.stop();
    expect(counters(j.id)).toMatchObject({ status: 'queued', attempts: 0, interruptions: 0 });
  });
});

describe('«not ready yet» deferrals', () => {
  it('re-queues after retryAfterMs without spending an attempt, up to maxDeferrals, then the normal budget applies', async () => {
    let ready = false;
    const seen: number[] = [];
    t.ctx.jobs.register('waiter', {
      version: '1',
      maxAttempts: 1,
      maxDeferrals: 3,
      handler: async (run) => {
        seen.push(run.deferrals);
        if (!ready) throw new JobError('NOT_READY', 'لم يجهز بعد.', { retryable: true, retryAfterMs: 5000 });
        return { ok: true };
      },
    });
    const a = t.ctx.jobs.enqueue('waiter', {});
    await t.ctx.jobs.drain();
    expect(counters(a.id)).toMatchObject({ status: 'queued', attempts: 0, deferrals: 1 });
    expect(t.ctx.jobs.get(a.id)!.run_after).toBe(t.clock.now() + 5000);
    t.clock.advance(5000);
    ready = true;
    await t.ctx.jobs.drain();
    expect(t.ctx.jobs.get(a.id)).toMatchObject({ status: 'completed', attempts: 1 });
    expect(seen).toEqual([0, 1]);

    // never ready: 3 deferrals, then the one real attempt fails
    ready = false;
    const b = t.ctx.jobs.enqueue('waiter', { b: 1 });
    for (let i = 0; i < 5; i++) {
      await t.ctx.jobs.drain();
      t.clock.advance(5000);
    }
    expect(counters(b.id)).toMatchObject({ status: 'failed', attempts: 1, deferrals: 3 });
    expect(t.ctx.jobs.get(b.id)).toMatchObject({ error: { code: 'NOT_READY', retryable: true } });
  });

  it('retryAfterMs on a non-retryable error is ignored (fails at once)', async () => {
    t.ctx.jobs.register('fatal', {
      version: '1',
      handler: async () => {
        throw new JobError('FATAL', 'خطأ نهائي.', { retryable: false, retryAfterMs: 1000 });
      },
    });
    const j = t.ctx.jobs.enqueue('fatal', {});
    await t.ctx.jobs.drain();
    expect(counters(j.id)).toMatchObject({ status: 'failed', deferrals: 0 });
  });
});

describe('runNow: one job, awaited, also while the worker is stopped', () => {
  it('runs the job and returns its outcome', async () => {
    t.ctx.jobs.register('quick', { version: '1', handler: async (run) => ({ id: run.id }) });
    const j = t.ctx.jobs.enqueue('quick', {});
    const other = t.ctx.jobs.enqueue('quick', { other: true });
    const out = await t.ctx.jobs.runNow(j.id, { timeoutMs: 5000 });
    expect(out).toMatchObject({ status: 'completed', output: { id: j.id } });
    expect(t.ctx.jobs.get(other.id)!.status).toBe('queued'); // nothing else was claimed
  });

  it('on timeout the job is aborted like a shutdown: back in the queue, attempt given back', async () => {
    t.ctx.jobs.register('stuck', {
      version: '1',
      handler: (run) => new Promise((_, reject) => run.signal.addEventListener('abort', () => reject(run.signal.reason))),
    });
    const j = t.ctx.jobs.enqueue('stuck', {});
    const out = await t.ctx.jobs.runNow(j.id, { timeoutMs: 30 });
    expect(out).toMatchObject({ status: 'queued', attempts: 0 });
  });
});
