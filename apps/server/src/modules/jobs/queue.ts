// Durable, SQLite-backed job queue (§53). One process, bounded concurrency, checkpoints per step.
//
// States: queued → running → (completed | partial | failed | cancelled | waiting_for_input).
//  * partial ≠ completed (handler returns { partial: true, output })
//  * retryable failures re-queue with exponential backoff until max_attempts; fatal ones fail at once
//  * timeouts abort the run via AbortSignal (retryable)
//  * cancel never deletes checkpoints or outputs
//  * running jobs whose heartbeat is stale (process died) are re-queued on boot and while running; a job whose
//    claiming process is provably gone (same host, its pid no longer exists — or our own pid with another boot nonce,
//    e.g. pid 1 in a restarted container) is re-queued at once instead of waiting for the heartbeat to go stale
//  * idempotency_key → enqueue returns the existing job instead of creating a duplicate
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import type { FastifyBaseLogger } from 'fastify';
import type { z } from 'zod';
import { JOB_STATUS_LABELS_AR, type JobProgress, type JobStatus, type JobView } from '@medlevo/shared';
import type { Db } from '../../db/db';
import { fromJson, toJson } from '../../db/db';
import { AppError, isAppError, isJobError, JobError } from '../../lib/errors';
import { parseWith } from '../../lib/http';
import { newId } from '../../lib/ids';
import type { Clock } from '../../lib/time';

export interface PartialResult<O> {
  partial: true;
  output: O;
}

export interface JobRun<I> {
  id: string;
  kind: string;
  input: I;
  /** 1-based attempt number of this run */
  attempt: number;
  signal: AbortSignal;
  log: FastifyBaseLogger;
  /** Runs `fn` once per (job, stepKey); on retry/resume returns the stored (JSON) result instead. */
  checkpoint<T>(stepKey: string, fn: () => Promise<T> | T): Promise<T>;
  /** Report REAL progress (counts of real units). No fake percentages. */
  progress(p: JobProgress): void;
  isCancelled(): boolean;
}

export interface JobDefinition<I = unknown, O = unknown> {
  version: string;
  maxAttempts?: number;
  timeoutMs?: number;
  /** max concurrently running jobs of this kind (default: global concurrency) */
  concurrency?: number;
  /** validated at enqueue time */
  inputSchema?: z.ZodType<I>;
  handler: (run: JobRun<I>) => Promise<O | PartialResult<O>>;
}

export interface EnqueueOptions {
  idempotencyKey?: string;
  runAfter?: number;
  parentJobId?: string;
}

export interface JobFilter {
  status?: JobStatus | JobStatus[];
  kind?: string;
  parentJobId?: string;
  limit?: number;
  /** id cursor (exclusive) */
  before?: string;
}

export interface JobQueueOptions {
  concurrency: number;
  pollIntervalMs: number;
  heartbeatMs: number;
  staleAfterMs: number;
  defaultTimeoutMs: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** how long stop() waits for running handlers to observe the abort */
  shutdownGraceMs?: number;
}

interface JobRow {
  id: string;
  kind: string;
  status: JobStatus;
  idempotency_key: string | null;
  input_json: string;
  output_json: string | null;
  progress_json: string | null;
  attempts: number;
  max_attempts: number;
  error_code: string | null;
  error_detail: string | null;
  retryable: number | null;
  run_after: number;
  parent_job_id: string | null;
  version: string;
  created_at: number;
  started_at: number | null;
  heartbeat_at: number | null;
  finished_at: number | null;
  cancel_requested_at: number | null;
  /** '<hostname>/<pid>/<boot nonce>' of the process that claimed the job (migration 0030; NULL on older rows) */
  worker_id?: string | null;
  checkpoints?: number;
}

interface ActiveJob {
  id: string;
  kind: string;
  controller: AbortController;
  cancelRequested: boolean;
  shutdown: boolean;
  finished: boolean;
  promise: Promise<void>;
}

type Outcome = { ok: true; output: unknown; partial: boolean } | { ok: false; error: unknown };

const TERMINAL: ReadonlySet<JobStatus> = new Set(['completed', 'partial', 'failed', 'cancelled']);
const RETRYABLE_FROM: ReadonlySet<JobStatus> = new Set(['failed', 'cancelled', 'partial', 'waiting_for_input']);

const MSG = {
  timeout: 'تجاوزت المهمة المهلة المحددة لها. ستُعاد المحاولة تلقائيًا من آخر نقطة محفوظة.',
  cancelled: 'أُلغيت المهمة بطلب منك. الأجزاء المكتملة محفوظة ويمكنك إعادة المحاولة لاحقًا.',
  shutdown: 'توقف الخادم أثناء المعالجة؛ ستُستأنف المهمة عند التشغيل التالي.',
  interruptedRequeued: 'انقطعت المعالجة (توقف الخادم أو تعطله)؛ استُؤنفت المهمة تلقائيًا من آخر نقطة محفوظة.',
  interruptedFailed: 'انقطعت المعالجة بشكل متكرر واستُنفدت المحاولات. راجع سجل الخادم ثم أعد المحاولة.',
  internal: 'حدث خطأ غير متوقع أثناء المعالجة. ستُعاد المحاولة تلقائيًا؛ وإذا تكرر الفشل راجع سجل الخادم.',
  unknownKind: 'نوع المهمة غير مسجل في هذا الإصدار من الخادم.',
};

function isPartial(v: unknown): v is PartialResult<unknown> {
  return typeof v === 'object' && v !== null && (v as { partial?: unknown }).partial === true && 'output' in v;
}

function sanitizeProgress(p: JobProgress): JobProgress {
  const out: JobProgress = { stage: String(p.stage).slice(0, 200) };
  const nonNeg = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined);
  const done = nonNeg(p.done);
  const total = nonNeg(p.total);
  if (done !== undefined) out.done = done;
  if (total !== undefined) out.total = total;
  if (out.done !== undefined && out.total !== undefined && out.done > out.total) out.done = out.total;
  if (p.unit !== undefined) out.unit = p.unit === null ? null : String(p.unit).slice(0, 32);
  return out;
}

export class JobQueue {
  private readonly defs = new Map<string, JobDefinition<any, any>>(); // eslint-disable-line @typescript-eslint/no-explicit-any
  private readonly active = new Map<string, ActiveJob>();
  private pollTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private started = false;
  private readonly opts: Required<JobQueueOptions>;
  private readonly host = hostname();
  private readonly bootNonce = randomBytes(6).toString('hex');
  /** recorded on every job this process claims: '<hostname>/<pid>/<boot nonce>' */
  readonly workerId = `${this.host}/${process.pid}/${this.bootNonce}`;

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly log: FastifyBaseLogger,
    opts: JobQueueOptions,
  ) {
    this.opts = { backoffBaseMs: 2000, backoffMaxMs: 5 * 60_000, shutdownGraceMs: 10_000, ...opts };
  }

  /**
   * Is the process that claimed a running job certainly gone? Only provable on this host: its pid no longer exists,
   * or it is our own pid with another boot nonce (a restarted container reuses pid 1). Unknown owners (NULL, another
   * host, a live pid — even a reused one) are not provably gone: they keep the heartbeat rule.
   */
  private claimerGone(workerId: string | null | undefined): boolean {
    if (!workerId || workerId === this.workerId) return false;
    const parts = workerId.split('/');
    if (parts.length !== 3 || parts[0] !== this.host) return false;
    const pid = Number(parts[1]);
    if (!Number.isInteger(pid) || pid <= 0) return false;
    if (pid === process.pid) return parts[2] !== this.bootNonce;
    try {
      process.kill(pid, 0); // signal 0: existence check only
      return false;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'ESRCH'; // EPERM = exists (another user's process)
    }
  }

  // ───────── registration & enqueue ─────────

  register<I, O>(kind: string, def: JobDefinition<I, O>): void {
    if (!/^[a-z][a-z0-9_.:-]{1,63}$/.test(kind)) throw new Error(`Invalid job kind: ${kind}`);
    if (this.defs.has(kind)) throw new Error(`Job kind already registered: ${kind}`);
    this.defs.set(kind, def);
  }

  isRegistered(kind: string): boolean {
    return this.defs.has(kind);
  }

  enqueue<I>(kind: string, input: I, opts: EnqueueOptions = {}): JobView {
    const def = this.defs.get(kind);
    if (!def) throw new Error(`Unknown job kind: ${kind}`);
    const validInput = def.inputSchema ? parseWith(def.inputSchema, input, 'value') : input;
    if (opts.idempotencyKey) {
      const existing = this.rowByKey(opts.idempotencyKey);
      if (existing) return this.existingForKey(existing, kind);
    }
    const now = this.clock.now();
    const id = newId(now);
    try {
      this.db.run(
        `INSERT INTO processing_job (id, kind, status, idempotency_key, input_json, attempts, max_attempts, run_after, parent_job_id, version, created_at)
         VALUES (?, ?, 'queued', ?, ?, 0, ?, ?, ?, ?, ?)`,
        [id, kind, opts.idempotencyKey ?? null, toJson(validInput ?? null), def.maxAttempts ?? 3, opts.runAfter ?? now, opts.parentJobId ?? null, def.version, now],
      );
    } catch (e) {
      if (opts.idempotencyKey) {
        const raced = this.rowByKey(opts.idempotencyKey);
        if (raced) return this.existingForKey(raced, kind);
      }
      throw e;
    }
    this.poke();
    return this.get(id)!;
  }

  private existingForKey(row: JobRow, kind: string): JobView {
    if (row.kind !== kind) {
      throw new AppError('CONFLICT', 'مفتاح منع التكرار مستخدم لمهمة من نوع آخر.', 409);
    }
    return this.view(row, true);
  }

  private rowByKey(key: string): JobRow | undefined {
    return this.db.get<JobRow>(
      'SELECT j.*, (SELECT COUNT(*) FROM job_checkpoint c WHERE c.job_id = j.id) AS checkpoints FROM processing_job j WHERE idempotency_key = ?',
      [key],
    );
  }

  // ───────── queries ─────────

  get(id: string): JobView | null {
    const row = this.row(id);
    return row ? this.view(row, true) : null;
  }

  private row(id: string): JobRow | undefined {
    return this.db.get<JobRow>(
      'SELECT j.*, (SELECT COUNT(*) FROM job_checkpoint c WHERE c.job_id = j.id) AS checkpoints FROM processing_job j WHERE id = ?',
      [id],
    );
  }

  list(filter: JobFilter = {}): { jobs: JobView[]; next_before: string | null } {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const where: string[] = [];
    const params: unknown[] = [];
    const statuses = filter.status === undefined ? [] : Array.isArray(filter.status) ? filter.status : [filter.status];
    if (statuses.length) {
      where.push(`status IN (${statuses.map(() => '?').join(',')})`);
      params.push(...statuses);
    }
    if (filter.kind) {
      where.push('kind = ?');
      params.push(filter.kind);
    }
    if (filter.parentJobId) {
      where.push('parent_job_id = ?');
      params.push(filter.parentJobId);
    }
    if (filter.before) {
      where.push('id < ?');
      params.push(filter.before);
    }
    const rows = this.db.all<JobRow>(
      `SELECT j.*, (SELECT COUNT(*) FROM job_checkpoint c WHERE c.job_id = j.id) AS checkpoints
       FROM processing_job j ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`,
      [...params, limit + 1],
    );
    const page = rows.slice(0, limit);
    return { jobs: page.map((r) => this.view(r, false)), next_before: rows.length > limit ? page[page.length - 1]!.id : null };
  }

  private view(r: JobRow, includeIo: boolean): JobView {
    const v: JobView = {
      id: r.id,
      kind: r.kind,
      status: r.status,
      status_label_ar: JOB_STATUS_LABELS_AR[r.status] ?? r.status,
      progress: fromJson<JobProgress>(r.progress_json),
      attempts: r.attempts,
      max_attempts: r.max_attempts,
      error: r.error_code ? { code: r.error_code, message: r.error_detail ?? '', retryable: r.retryable === 1 } : null,
      idempotency_key: r.idempotency_key,
      run_after: r.run_after,
      parent_job_id: r.parent_job_id,
      version: r.version,
      created_at: r.created_at,
      started_at: r.started_at,
      heartbeat_at: r.heartbeat_at,
      finished_at: r.finished_at,
      cancel_requested_at: r.cancel_requested_at,
      checkpoints: r.checkpoints ?? 0,
    };
    if (includeIo) {
      v.input = fromJson(r.input_json);
      v.output = fromJson(r.output_json);
    }
    return v;
  }

  // ───────── owner actions ─────────

  cancel(id: string): JobView {
    const row = this.row(id);
    if (!row) throw new AppError('NOT_FOUND', 'المهمة غير موجودة.', 404);
    if (TERMINAL.has(row.status)) throw new AppError('CONFLICT', 'لا يمكن إلغاء مهمة منتهية.', 409);
    const now = this.clock.now();
    const active = this.active.get(id);
    if (row.status === 'running' && active) {
      this.db.run('UPDATE processing_job SET cancel_requested_at = ? WHERE id = ?', [now, id]);
      active.cancelRequested = true;
      active.controller.abort(new JobError('JOB_CANCELLED', MSG.cancelled, { retryable: false }));
    } else {
      // queued / waiting_for_input / orphaned running row: cancel immediately (checkpoints & output kept)
      this.db.run(
        `UPDATE processing_job SET status = 'cancelled', cancel_requested_at = ?, finished_at = ?, heartbeat_at = NULL,
           error_code = 'JOB_CANCELLED', error_detail = ?, retryable = 0 WHERE id = ?`,
        [now, now, MSG.cancelled, id],
      );
    }
    return this.get(id)!;
  }

  retry(id: string): JobView {
    const row = this.row(id);
    if (!row) throw new AppError('NOT_FOUND', 'المهمة غير موجودة.', 404);
    if (!RETRYABLE_FROM.has(row.status)) {
      throw new AppError('CONFLICT', 'لا يمكن إعادة محاولة هذه المهمة في حالتها الحالية.', 409);
    }
    if (!this.defs.has(row.kind)) throw new AppError('CONFLICT', MSG.unknownKind, 409);
    const now = this.clock.now();
    this.db.run(
      `UPDATE processing_job SET status = 'queued', attempts = 0, run_after = ?, error_code = NULL, error_detail = NULL,
         retryable = NULL, finished_at = NULL, cancel_requested_at = NULL, heartbeat_at = NULL WHERE id = ?`,
      [now, id],
    );
    this.poke();
    return this.get(id)!;
  }

  // ───────── worker ─────────

  start(): void {
    if (this.started) return;
    this.started = true;
    this.requeueStale();
    this.pollTimer = setInterval(() => this.tick(), this.opts.pollIntervalMs);
    this.pollTimer.unref();
    this.heartbeatTimer = setInterval(() => this.heartbeat(), this.opts.heartbeatMs);
    this.heartbeatTimer.unref();
    this.tick();
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.pollTimer = this.heartbeatTimer = null;
    const running = [...this.active.values()];
    for (const a of running) {
      a.shutdown = true;
      a.controller.abort(new JobError('SHUTDOWN', MSG.shutdown, { retryable: true }));
    }
    if (running.length) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.allSettled(running.map((a) => a.promise)),
        new Promise<void>((r) => {
          timer = setTimeout(r, this.opts.shutdownGraceMs);
          timer.unref();
        }),
      ]);
      if (timer) clearTimeout(timer);
    }
  }

  /** Tests: run every runnable job (sequentially) until none is left. Retries scheduled in the future wait for the clock. */
  async drain(maxRuns = 10_000): Promise<void> {
    for (let i = 0; i < maxRuns; i++) {
      if (this.active.size > 0) {
        await Promise.allSettled([...this.active.values()].map((a) => a.promise));
        continue;
      }
      const row = this.claimNext();
      if (!row) return;
      await this.launch(row).promise;
    }
    throw new Error('JobQueue.drain exceeded maxRuns');
  }

  /** Re-queue running jobs whose process died: heartbeat stale, or the claiming process provably gone. Returns the count. */
  requeueStale(): number {
    const now = this.clock.now();
    const threshold = now - this.opts.staleAfterMs;
    const rows = this.db.all<JobRow>(
      `SELECT * FROM processing_job WHERE status = 'running'
         AND (heartbeat_at IS NULL OR heartbeat_at < ? OR (worker_id IS NOT NULL AND worker_id <> ?))`,
      [threshold, this.workerId],
    );
    let n = 0;
    for (const r of rows) {
      if (this.active.has(r.id)) continue;
      const stale = r.heartbeat_at === null || r.heartbeat_at < threshold;
      if (!stale && !this.claimerGone(r.worker_id)) continue; // a live (or unknown) process may still be running it
      n++;
      if (r.cancel_requested_at) {
        this.db.run(
          `UPDATE processing_job SET status = 'cancelled', finished_at = ?, heartbeat_at = NULL, error_code = 'JOB_CANCELLED', error_detail = ?, retryable = 0 WHERE id = ? AND status = 'running'`,
          [now, MSG.cancelled, r.id],
        );
      } else if (r.attempts >= r.max_attempts) {
        this.db.run(
          `UPDATE processing_job SET status = 'failed', finished_at = ?, heartbeat_at = NULL, error_code = 'JOB_INTERRUPTED', error_detail = ?, retryable = 1 WHERE id = ? AND status = 'running'`,
          [now, MSG.interruptedFailed, r.id],
        );
      } else {
        this.db.run(
          `UPDATE processing_job SET status = 'queued', run_after = ?, heartbeat_at = NULL, error_code = 'JOB_INTERRUPTED', error_detail = ?, retryable = 1 WHERE id = ? AND status = 'running'`,
          [now, MSG.interruptedRequeued, r.id],
        );
      }
    }
    if (n) this.log.warn({ count: n }, 'requeued stale running jobs');
    return n;
  }

  private poke(): void {
    if (this.started) setImmediate(() => this.tick());
  }

  private tick(): void {
    if (!this.started) return;
    try {
      while (this.active.size < this.opts.concurrency) {
        const row = this.claimNext();
        if (!row) break;
        const a = this.launch(row);
        void a.promise.then(() => this.poke());
      }
    } catch (e) {
      this.log.error({ err: e }, 'job queue tick failed');
    }
  }

  private heartbeat(): void {
    try {
      const now = this.clock.now();
      for (const a of this.active.values()) {
        this.db.run(`UPDATE processing_job SET heartbeat_at = ? WHERE id = ? AND status = 'running'`, [now, a.id]);
        if (!a.cancelRequested) {
          const r = this.db.get<{ cancel_requested_at: number | null }>('SELECT cancel_requested_at FROM processing_job WHERE id = ?', [a.id]);
          if (r?.cancel_requested_at) {
            a.cancelRequested = true;
            a.controller.abort(new JobError('JOB_CANCELLED', MSG.cancelled, { retryable: false }));
          }
        }
      }
      this.requeueStale();
    } catch (e) {
      this.log.error({ err: e }, 'job heartbeat failed');
    }
  }

  private claimNext(): JobRow | undefined {
    const runningByKind = new Map<string, number>();
    for (const a of this.active.values()) runningByKind.set(a.kind, (runningByKind.get(a.kind) ?? 0) + 1);
    const kinds = [...this.defs.entries()]
      .filter(([k, d]) => (runningByKind.get(k) ?? 0) < (d.concurrency ?? Number.POSITIVE_INFINITY))
      .map(([k]) => k);
    if (kinds.length === 0) return undefined;
    const now = this.clock.now();
    return this.db.get<JobRow>(
      `UPDATE processing_job SET status = 'running', attempts = attempts + 1, started_at = ?, heartbeat_at = ?, finished_at = NULL, worker_id = ?
       WHERE id = (SELECT id FROM processing_job WHERE status = 'queued' AND run_after <= ? AND kind IN (${kinds.map(() => '?').join(',')})
                   ORDER BY run_after, id LIMIT 1)
       RETURNING *`,
      [now, now, this.workerId, now, ...kinds],
    );
  }

  private launch(row: JobRow): ActiveJob {
    const active: ActiveJob = {
      id: row.id,
      kind: row.kind,
      controller: new AbortController(),
      cancelRequested: false,
      shutdown: false,
      finished: false,
      promise: Promise.resolve(),
    };
    this.active.set(row.id, active);
    active.promise = this.execute(row, active).finally(() => {
      active.finished = true;
      this.active.delete(row.id);
    });
    return active;
  }

  private async execute(row: JobRow, active: ActiveJob): Promise<void> {
    const def = this.defs.get(row.kind)!;
    const log = this.log.child({ jobId: row.id, kind: row.kind, attempt: row.attempts });
    const signal = active.controller.signal;
    const timeoutMs = def.timeoutMs ?? this.opts.defaultTimeoutMs;
    const timer = setTimeout(() => {
      active.controller.abort(new JobError('JOB_TIMEOUT', MSG.timeout, { retryable: true }));
    }, timeoutMs);
    timer.unref();

    const run: JobRun<unknown> = {
      id: row.id,
      kind: row.kind,
      input: fromJson(row.input_json),
      attempt: row.attempts,
      signal,
      log,
      checkpoint: async <T>(stepKey: string, fn: () => Promise<T> | T): Promise<T> => {
        const key = String(stepKey).slice(0, 300);
        const stored = this.db.get<{ data_json: string | null }>('SELECT data_json FROM job_checkpoint WHERE job_id = ? AND step_key = ?', [row.id, key]);
        if (stored) return fromJson<T>(stored.data_json) as T;
        if (signal.aborted) throw signal.reason;
        const value = await fn();
        this.db.run(
          'INSERT INTO job_checkpoint (job_id, step_key, data_json, done_at) VALUES (?, ?, ?, ?) ON CONFLICT (job_id, step_key) DO NOTHING',
          [row.id, key, toJson(value === undefined ? null : value), this.clock.now()],
        );
        return value;
      },
      progress: (p: JobProgress) => {
        if (active.finished) return;
        this.db.run(`UPDATE processing_job SET progress_json = ?, heartbeat_at = ? WHERE id = ? AND status = 'running'`, [
          toJson(sanitizeProgress(p)),
          this.clock.now(),
          row.id,
        ]);
      },
      isCancelled: () => active.cancelRequested,
    };

    let outcome: Outcome;
    try {
      const aborted = new Promise<never>((_, reject) => {
        if (signal.aborted) reject(signal.reason);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      const result = await Promise.race([Promise.resolve().then(() => def.handler(run)), aborted]);
      outcome = isPartial(result) ? { ok: true, output: result.output, partial: true } : { ok: true, output: result, partial: false };
    } catch (e) {
      outcome = { ok: false, error: e };
    } finally {
      clearTimeout(timer);
    }
    active.finished = true;
    try {
      this.finalize(row, def, active, outcome, log);
    } catch (e) {
      log.error({ err: e }, 'failed to persist job outcome');
    }
  }

  private finalize(row: JobRow, def: JobDefinition<unknown, unknown>, active: ActiveJob, outcome: Outcome, log: FastifyBaseLogger): void {
    const now = this.clock.now();
    // the owner's cancel wins over a concurrent shutdown: a cancelled job must never be re-queued
    if (active.shutdown && !outcome.ok && !active.cancelRequested) {
      // interrupted by shutdown — not the job's fault: give the attempt back and resume on next boot
      this.db.run(
        `UPDATE processing_job SET status = 'queued', attempts = MAX(attempts - 1, 0), run_after = ?, heartbeat_at = NULL WHERE id = ?`,
        [now, row.id],
      );
      return;
    }
    if (active.cancelRequested) {
      this.db.run(
        `UPDATE processing_job SET status = 'cancelled', finished_at = ?, heartbeat_at = NULL, output_json = COALESCE(?, output_json),
           error_code = 'JOB_CANCELLED', error_detail = ?, retryable = 0 WHERE id = ?`,
        [now, outcome.ok ? toJson(outcome.output ?? null) : null, MSG.cancelled, row.id],
      );
      return;
    }
    if (outcome.ok) {
      this.db.run(
        `UPDATE processing_job SET status = ?, output_json = ?, finished_at = ?, heartbeat_at = NULL,
           error_code = NULL, error_detail = NULL, retryable = NULL WHERE id = ?`,
        [outcome.partial ? 'partial' : 'completed', toJson(outcome.output ?? null), now, row.id],
      );
      return;
    }

    const err = outcome.error;
    let code: string;
    let message: string;
    let retryable: boolean;
    let waitForInput = false;
    if (isJobError(err)) {
      code = err.code;
      message = err.messageAr;
      retryable = err.retryable;
      waitForInput = err.waitForInput;
    } else if (isAppError(err)) {
      code = err.code;
      message = err.messageAr;
      retryable = err.status >= 500 || err.code === 'RATE_LIMITED' || err.code === 'AI_PROVIDER_ERROR';
    } else {
      code = 'INTERNAL';
      message = MSG.internal;
      retryable = true;
      log.error({ err }, 'job handler threw an unexpected error');
    }

    if (waitForInput) {
      this.db.run(
        `UPDATE processing_job SET status = 'waiting_for_input', heartbeat_at = NULL, error_code = ?, error_detail = ?, retryable = 0 WHERE id = ?`,
        [code, message, row.id],
      );
      return;
    }
    const maxAttempts = row.max_attempts ?? def.maxAttempts ?? 3;
    if (retryable && row.attempts < maxAttempts) {
      const delay = Math.min(this.opts.backoffBaseMs * 2 ** Math.max(0, row.attempts - 1), this.opts.backoffMaxMs);
      this.db.run(
        `UPDATE processing_job SET status = 'queued', run_after = ?, heartbeat_at = NULL, error_code = ?, error_detail = ?, retryable = 1 WHERE id = ?`,
        [now + delay, code, message, row.id],
      );
      log.warn({ code, delay }, 'job attempt failed; retry scheduled');
      return;
    }
    this.db.run(
      `UPDATE processing_job SET status = 'failed', finished_at = ?, heartbeat_at = NULL, error_code = ?, error_detail = ?, retryable = ? WHERE id = ?`,
      [now, code, message, retryable ? 1 : 0, row.id],
    );
    log.warn({ code }, 'job failed');
  }

  /** number of jobs currently executing in this process */
  get activeCount(): number {
    return this.active.size;
  }
}
