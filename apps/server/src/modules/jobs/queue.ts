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
//
// Tenancy (P1-T1 step 1, ADR-0003 §3.2): each job's row and checkpoints live in the database of the request that
// enqueued it (a user's vault, later a subject space). The system DB's job_index says where due work is; the single
// worker loop, its heartbeat, poke() and every timer run in the explicit empty ROOT context (no database at all), and
// the worker binds each job's own database before claiming and before running the handler. A job enqueued from user
// A's request therefore never runs against anyone else's vault, and nothing in the loop inherits a request's binding.
// The job's own row stays the truth; the index is reconciled whenever the worker consults it.
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
import type { Binding, TenantBinding } from '../../system/binding';
import type { JobIndex } from '../../system/repos';

/** Where a job lives. */
export interface JobDbRef {
  kind: 'vault' | 'space';
  id: string;
}

/** What the queue needs from tenancy (context.ts wires it). */
export interface JobTenancy {
  binding: TenantBinding;
  index: JobIndex;
  /** keep the job's database open while it runs (pool lease) */
  lease(ref: JobDbRef): () => void;
  /** is this database registered and usable? */
  usable(ref: JobDbRef): boolean;
}

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
  ref: JobDbRef;
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
    /** the BOUND database proxy (ctx.db): every statement goes to the database of the current binding */
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly log: FastifyBaseLogger,
    opts: JobQueueOptions,
    private readonly tenancy: JobTenancy,
  ) {
    this.opts = { backoffBaseMs: 2000, backoffMaxMs: 5 * 60_000, shutdownGraceMs: 10_000, ...opts };
  }

  // ───────── tenancy helpers ─────────

  private activeKey(ref: JobDbRef, id: string): string {
    return `${ref.kind}:${ref.id}/${id}`;
  }

  private bindingOf(ref: JobDbRef): Binding {
    return ref.kind === 'vault' ? { kind: 'vault', vaultId: ref.id, viewer: null } : { kind: 'space', spaceId: ref.id, subjectNodeId: '', viewer: null, access: 'moderator', route: null };
  }

  private inDb<T>(ref: JobDbRef, fn: () => T): T {
    return this.tenancy.binding.run(this.bindingOf(ref), fn);
  }

  /** The database of the current binding (or the test harness default); null in the root context / unbound. */
  private ambientRef(): JobDbRef | null {
    const b = this.tenancy.binding.current() ?? this.tenancy.binding.harnessDefault();
    if (!b) return null;
    if (b.kind === 'vault') return { kind: 'vault', id: b.vaultId };
    if (b.kind === 'space') return { kind: 'space', id: b.spaceId };
    return null;
  }

  /** The database the caller is bound to — enqueue / cancel / retry act there. Throws NO_TENANT_BOUND otherwise. */
  private boundRef(): JobDbRef {
    const ref = this.ambientRef();
    if (!ref) {
      this.db.get('SELECT 1'); // throws NO_TENANT_BOUND with the binding's own message
      throw new Error('unreachable: no bound database');
    }
    return ref;
  }

  /**
   * Make the system job index agree with one database's own job rows (P1-T1 step 1 review): every job that is not
   * finished is indexed with its current state, and an index entry whose job is gone or finished is corrected. The job
   * row is the truth. Needed because the two live in different files: a restore brings back a system DB snapshotted
   * BEFORE the vaults (a job enqueued in between has no entry), and an entry met while its vault was locked is parked
   * as «unavailable». Runs when the pool first opens a database in this process (context.ts) and, for parked entries,
   * from the heartbeat. Idempotent; two indexed reads. Returns how many entries changed.
   */
  reconcileIndex(ref: JobDbRef): number {
    return this.inDb(ref, () => {
      const rows = this.db.all<{ id: string; kind: string; status: string; run_after: number }>(
        `SELECT id, kind, status, run_after FROM processing_job WHERE status IN ('queued', 'running', 'waiting_for_input')`,
      );
      const indexed = new Map(this.tenancy.index.ofDbInternal(ref.id).map((e) => [e.job_id, e]));
      let changed = 0;
      for (const r of rows) {
        const e = indexed.get(r.id);
        indexed.delete(r.id);
        if (e && e.status === r.status && e.kind === r.kind && e.run_after === r.run_after) continue;
        this.tenancy.index.upsertInternal({ db_kind: ref.kind, db_id: ref.id, job_id: r.id, kind: r.kind, status: r.status, run_after: r.run_after, actor_user_id: null });
        changed++;
      }
      for (const e of indexed.values()) {
        if (TERMINAL.has(e.status as JobStatus)) continue;
        const cur = this.db.get<{ status: string }>('SELECT status FROM processing_job WHERE id = ?', [e.job_id]);
        // no job row: an entry «queued» may belong to an enqueue in progress (the index row is written first and this
        // runs when that enqueue's INSERT opens the database) — the worker drops it when it fails to claim it. Only a
        // parked «unavailable» entry is dropped here.
        if (!cur && e.status !== 'unavailable') continue;
        this.mirror(ref, e.job_id); // finished → its final state; gone → removed
        changed++;
      }
      if (changed) this.log.info({ db: ref.id, changed }, 'job index reconciled with the database');
      return changed;
    });
  }

  /** Copy the job's current state into the system job index (call while bound to `ref`). */
  private mirror(ref: JobDbRef, id: string): void {
    try {
      const r = this.db.get<{ kind: string; status: string; run_after: number }>('SELECT kind, status, run_after FROM processing_job WHERE id = ?', [id]);
      if (!r) this.tenancy.index.removeInternal(ref.id, id);
      else this.tenancy.index.upsertInternal({ db_kind: ref.kind, db_id: ref.id, job_id: id, kind: r.kind, status: r.status, run_after: r.run_after, actor_user_id: null });
    } catch (e) {
      this.log.error({ err: e, jobId: id, db: ref.id }, 'job index update failed');
    }
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
    const ref = this.boundRef();
    if (opts.idempotencyKey) {
      const existing = this.rowByKey(opts.idempotencyKey);
      if (existing) return this.existingForKey(existing, kind);
    }
    const now = this.clock.now();
    const id = newId(now);
    const runAfter = opts.runAfter ?? now;
    // the index row FIRST: a crash between the two writes leaves an index row without a job (reconciled away by the
    // worker), never a queued job the worker cannot find
    this.tenancy.index.upsertInternal({
      db_kind: ref.kind,
      db_id: ref.id,
      job_id: id,
      kind,
      status: 'queued',
      run_after: runAfter,
      actor_user_id: this.tenancy.binding.viewer()?.userId ?? null,
    });
    try {
      this.db.run(
        `INSERT INTO processing_job (id, kind, status, idempotency_key, input_json, attempts, max_attempts, run_after, parent_job_id, version, created_at)
         VALUES (?, ?, 'queued', ?, ?, 0, ?, ?, ?, ?, ?)`,
        [id, kind, opts.idempotencyKey ?? null, toJson(validInput ?? null), def.maxAttempts ?? 3, runAfter, opts.parentJobId ?? null, def.version, now],
      );
    } catch (e) {
      this.tenancy.index.removeInternal(ref.id, id);
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
    const ref = this.boundRef();
    const active = this.active.get(this.activeKey(ref, id));
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
    this.mirror(ref, id);
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
    this.mirror(this.boundRef(), id);
    this.poke();
    return this.get(id)!;
  }

  // ───────── worker ─────────
  //
  // Everything below runs in the ROOT context (no database): start() creates its timers there, poke() schedules the
  // next tick there, and each job runs inside an explicit binding of its own database (inDb) — never in the context of
  // whichever request enqueued it.

  start(): void {
    if (this.started) return;
    this.started = true;
    // the caller's own database too (tests start the queue from a bound context; production boots unbound)
    const ambient = this.ambientRef();
    this.tenancy.binding.runRoot(() => {
      this.requeueStale(ambient);
      this.pollTimer = setInterval(() => this.tick(), this.opts.pollIntervalMs);
      this.pollTimer.unref();
      this.heartbeatTimer = setInterval(() => this.heartbeat(), this.opts.heartbeatMs);
      this.heartbeatTimer.unref();
      this.tick();
    });
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

  /**
   * Tests: run every runnable job (sequentially) until none is left — in every database the job index knows plus the
   * caller's own (test code may write processing_job rows directly). Retries scheduled in the future wait for the clock.
   */
  async drain(maxRuns = 10_000): Promise<void> {
    const ambient = this.ambientRef();
    for (let i = 0; i < maxRuns; i++) {
      if (this.active.size > 0) {
        await Promise.allSettled([...this.active.values()].map((a) => a.promise));
        continue;
      }
      const next = this.tenancy.binding.runRoot(() => this.claimAnywhere(ambient));
      if (!next) return;
      await this.launch(next.ref, next.row).promise;
    }
    throw new Error('JobQueue.drain exceeded maxRuns');
  }

  /**
   * Re-queue running jobs whose process died: heartbeat stale, or the claiming process provably gone. Looks in every
   * database the index believes has a running job, plus the caller's own. Returns the count.
   */
  requeueStale(extra: JobDbRef | null = null): number {
    // databases the worker could not reach (locked for a restore or migration) get their entries back once usable
    for (const d of this.tenancy.index.unavailableDatabasesInternal()) {
      const ref: JobDbRef = { kind: d.db_kind, id: d.db_id };
      if (!this.tenancy.usable(ref)) continue;
      try {
        this.reconcileIndex(ref);
      } catch (e) {
        this.log.error({ err: e, db: ref.id }, 'job index reconciliation failed for one database');
      }
    }
    const refs = new Map<string, JobDbRef>();
    if (extra) refs.set(`${extra.kind}:${extra.id}`, extra);
    const ambient = this.ambientRef();
    if (ambient) refs.set(`${ambient.kind}:${ambient.id}`, ambient);
    for (const r of this.tenancy.index.runningInternal()) refs.set(`${r.db_kind}:${r.db_id}`, { kind: r.db_kind, id: r.db_id });
    let n = 0;
    for (const ref of refs.values()) {
      if (!this.tenancy.usable(ref)) continue;
      try {
        n += this.inDb(ref, () => this.requeueStaleIn(ref));
      } catch (e) {
        this.log.error({ err: e, db: ref.id }, 'requeue of stale jobs failed for one database');
      }
    }
    if (n) this.log.warn({ count: n }, 'requeued stale running jobs');
    return n;
  }

  /** The single-database requeue (bound to `ref`). */
  private requeueStaleIn(ref: JobDbRef): number {
    const now = this.clock.now();
    const threshold = now - this.opts.staleAfterMs;
    const rows = this.db.all<JobRow>(
      `SELECT * FROM processing_job WHERE status = 'running'
         AND (heartbeat_at IS NULL OR heartbeat_at < ? OR (worker_id IS NOT NULL AND worker_id <> ?))`,
      [threshold, this.workerId],
    );
    let n = 0;
    for (const r of rows) {
      if (this.active.has(this.activeKey(ref, r.id))) continue;
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
      this.mirror(ref, r.id);
    }
    // the index may still call a job «running» that this database already finished (crash between the two writes)
    for (const e of this.tenancy.index.runningInternal()) {
      if (e.db_id === ref.id && !this.active.has(this.activeKey(ref, e.job_id))) {
        const cur = this.db.get<{ status: string }>('SELECT status FROM processing_job WHERE id = ?', [e.job_id]);
        if (!cur || cur.status !== 'running') this.mirror(ref, e.job_id);
      }
    }
    return n;
  }

  private poke(): void {
    // never inherit the caller's binding (a request that enqueued): schedule the tick from the root context
    if (this.started) this.tenancy.binding.runRoot(() => setImmediate(() => this.tick()));
  }

  private tick(): void {
    if (!this.started) return;
    try {
      while (this.active.size < this.opts.concurrency) {
        const next = this.claimAnywhere(null);
        if (!next) break;
        const a = this.launch(next.ref, next.row);
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
        try {
          this.inDb(a.ref, () => {
            this.db.run(`UPDATE processing_job SET heartbeat_at = ? WHERE id = ? AND status = 'running'`, [now, a.id]);
            if (!a.cancelRequested) {
              const r = this.db.get<{ cancel_requested_at: number | null }>('SELECT cancel_requested_at FROM processing_job WHERE id = ?', [a.id]);
              if (r?.cancel_requested_at) {
                a.cancelRequested = true;
                a.controller.abort(new JobError('JOB_CANCELLED', MSG.cancelled, { retryable: false }));
              }
            }
          });
        } catch (e) {
          this.log.error({ err: e, jobId: a.id }, 'job heartbeat failed');
        }
      }
      this.requeueStale();
    } catch (e) {
      this.log.error({ err: e }, 'job heartbeat failed');
    }
  }

  private claimableKinds(): string[] {
    const runningByKind = new Map<string, number>();
    for (const a of this.active.values()) runningByKind.set(a.kind, (runningByKind.get(a.kind) ?? 0) + 1);
    return [...this.defs.entries()].filter(([k, d]) => (runningByKind.get(k) ?? 0) < (d.concurrency ?? Number.POSITIVE_INFINITY)).map(([k]) => k);
  }

  /**
   * Claim the next due job anywhere: first from the job index (binding each candidate's own database to claim it
   * there), then — tests only — the caller's own database. Index rows that no longer match their job are reconciled.
   */
  private claimAnywhere(ambient: JobDbRef | null): { ref: JobDbRef; row: JobRow } | null {
    const kinds = this.claimableKinds();
    if (kinds.length === 0) return null;
    const now = this.clock.now();
    const tried = new Set<string>();
    for (let round = 0; round < 50; round++) {
      const candidates = this.tenancy.index.dueInternal(now, kinds, 20, tried);
      if (candidates.length === 0) break;
      for (const c of candidates) {
        tried.add(`${c.db_id}/${c.job_id}`);
        const ref: JobDbRef = { kind: c.db_kind, id: c.db_id };
        if (!this.tenancy.usable(ref)) {
          this.log.error({ db: c.db_id, jobId: c.job_id }, 'job index names a database that is not registered or not usable; skipped');
          this.tenancy.index.upsertInternal({ ...c, status: 'unavailable' });
          continue;
        }
        const row = this.inDb(ref, () => {
          const claimed = this.claimById(c.job_id, kinds, now);
          this.mirror(ref, c.job_id);
          return claimed;
        });
        if (row) return { ref, row };
      }
    }
    if (ambient && this.tenancy.usable(ambient)) {
      const row = this.inDb(ambient, () => {
        const claimed = this.claimNext(kinds, now);
        if (claimed) this.mirror(ambient, claimed.id);
        return claimed;
      });
      if (row) return { ref: ambient, row };
    }
    return null;
  }

  private claimById(id: string, kinds: string[], now: number): JobRow | undefined {
    return this.db.get<JobRow>(
      `UPDATE processing_job SET status = 'running', attempts = attempts + 1, started_at = ?, heartbeat_at = ?, finished_at = NULL, worker_id = ?
       WHERE id = ? AND status = 'queued' AND run_after <= ? AND kind IN (${kinds.map(() => '?').join(',')})
       RETURNING *`,
      [now, now, this.workerId, id, now, ...kinds],
    );
  }

  private claimNext(kinds: string[], now: number): JobRow | undefined {
    return this.db.get<JobRow>(
      `UPDATE processing_job SET status = 'running', attempts = attempts + 1, started_at = ?, heartbeat_at = ?, finished_at = NULL, worker_id = ?
       WHERE id = (SELECT id FROM processing_job WHERE status = 'queued' AND run_after <= ? AND kind IN (${kinds.map(() => '?').join(',')})
                   ORDER BY run_after, id LIMIT 1)
       RETURNING *`,
      [now, now, this.workerId, now, ...kinds],
    );
  }

  private launch(ref: JobDbRef, row: JobRow): ActiveJob {
    const active: ActiveJob = {
      id: row.id,
      kind: row.kind,
      ref,
      controller: new AbortController(),
      cancelRequested: false,
      shutdown: false,
      finished: false,
      promise: Promise.resolve(),
    };
    const key = this.activeKey(ref, row.id);
    this.active.set(key, active);
    let release: () => void = () => undefined;
    try {
      release = this.tenancy.lease(ref);
    } catch (e) {
      this.log.error({ err: e, db: ref.id }, 'could not lease the job database');
    }
    // the handler and everything it awaits run bound to the job's OWN database
    active.promise = this.inDb(ref, () => this.execute(row, active)).finally(() => {
      active.finished = true;
      this.active.delete(key);
      release();
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
    this.mirror(active.ref, row.id);
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
