// Regression (I2 resilience pass, docs/PERFORMANCE.md): after a crash (SIGKILL / OOM kill / power loss) the restarted
// server resumes a job at once when the process that claimed it is provably gone — measured before this fix: the job
// stayed «running» for 61.6 s after a restart, until its last heartbeat went stale. Owners that may still be alive
// (live pid, other host, unknown) keep the heartbeat rule, so two live processes never take each other's jobs.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { hostname } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './helpers/app';

let t: TestApp;
const children: ChildProcess[] = [];
beforeEach(async () => {
  t = await createTestApp();
});
afterEach(async () => {
  for (const c of children.splice(0)) if (c.exitCode === null) c.kill('SIGKILL');
  await t.close();
});

/** a pid that existed a moment ago and is gone now */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', '0']);
  return r.pid!;
}

/** a live process on this host (killed after the test) */
function livePid(): number {
  const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  children.push(c);
  return c.pid!;
}

/** simulate a job claimed by `workerId` that was running a moment ago (fresh heartbeat), step 1 checkpointed */
function crashedRun(workerId: string | null): string {
  const j = t.ctx.jobs.enqueue('resumable', {});
  t.ctx.db.run(`UPDATE processing_job SET status = 'running', attempts = 1, heartbeat_at = ?, worker_id = ? WHERE id = ?`, [t.clock.now() - 1000, workerId, j.id]);
  t.ctx.db.run(`INSERT INTO job_checkpoint (job_id, step_key, data_json, done_at) VALUES (?, 's1', '7', ?)`, [j.id, t.clock.now()]);
  return j.id;
}

describe('crash resume: the claiming process is recorded and checked', () => {
  let s1 = 0;
  beforeEach(() => {
    s1 = 0;
    t.ctx.jobs.register('resumable', {
      version: '1',
      handler: async (run) => {
        const a = await run.checkpoint('s1', () => ++s1);
        return { a, worker: t.ctx.db.get<{ worker_id: string }>('SELECT worker_id FROM processing_job WHERE id = ?', [run.id])!.worker_id };
      },
    });
  });

  it('records this process as the claimer of a running job', async () => {
    const j = t.ctx.jobs.enqueue('resumable', {});
    await t.ctx.jobs.drain();
    expect(t.ctx.jobs.workerId).toBe(`${hostname()}/${process.pid}/${t.ctx.jobs.workerId.split('/')[2]}`);
    expect(t.ctx.jobs.get(j.id)!.output).toMatchObject({ worker: t.ctx.jobs.workerId });
  });

  it('re-queues at once a job whose claiming process no longer exists (fresh heartbeat), and resumes from its checkpoint', async () => {
    const id = crashedRun(`${hostname()}/${deadPid()}/abc123`);
    expect(t.ctx.jobs.requeueStale()).toBe(1);
    expect(t.ctx.jobs.get(id)).toMatchObject({ status: 'queued', error: { code: 'JOB_INTERRUPTED', retryable: true } });
    await t.ctx.jobs.drain();
    expect(t.ctx.jobs.get(id)).toMatchObject({ status: 'completed', output: { a: 7 }, attempts: 2 });
    expect(s1).toBe(0); // the checkpointed step was not redone
  });

  it('re-queues a job claimed by an earlier boot that had the same pid (restarted container, pid 1)', () => {
    const id = crashedRun(`${hostname()}/${process.pid}/previous-boot`);
    expect(t.ctx.jobs.requeueStale()).toBe(1);
    expect(t.ctx.jobs.get(id)!.status).toBe('queued');
  });

  it('leaves alone a fresh job whose claimer may still be alive: live pid, other host, unknown owner', () => {
    const live = crashedRun(`${hostname()}/${livePid()}/other`);
    const remote = crashedRun(`another-host.example/${deadPid()}/x`);
    const legacy = crashedRun(null);
    const garbled = crashedRun('not-a-worker-id');
    expect(t.ctx.jobs.requeueStale()).toBe(0);
    for (const id of [live, remote, legacy, garbled]) expect(t.ctx.jobs.get(id)!.status).toBe('running');
    // …until their heartbeat goes stale (the general rule still applies)
    t.clock.advance(120_000);
    expect(t.ctx.jobs.requeueStale()).toBe(4);
  });

  it('does the check at start(): a crashed job resumes without waiting for the stale window', async () => {
    const id = crashedRun(`${hostname()}/${deadPid()}/abc123`);
    t.ctx.jobs.start();
    for (let i = 0; i < 100 && t.ctx.jobs.get(id)!.status !== 'completed'; i++) await new Promise((r) => setTimeout(r, 20));
    await t.ctx.jobs.stop();
    expect(t.ctx.jobs.get(id)).toMatchObject({ status: 'completed', output: { a: 7 } });
  });
});
