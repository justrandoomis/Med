// Request and job binding (ADR-0003 §3.2, ARCHITECTURE_DELTA §1.1; P1-T1 step 1).
//
// `ctx.db` (and through it ctx.files / sync / audit / settings / ai / jobs) is a PROXY: every call resolves the database
// of the CURRENT binding through AsyncLocalStorage. There is NO default database — a call with no binding, or inside the
// explicit empty root context of background work, throws NO_TENANT_BOUND (also from timers).
//
//   * the onRequest binding hook binds the session's OWN vault (session → user → vault), or the root context for
//     public / unauthenticated requests;
//   * the job worker loop, its heartbeat, poke() and every server timer run inside the root context (`runRoot`), and
//     the worker binds each job's own database explicitly before its handler runs;
//   * the test harness may set a default binding for code that runs OUTSIDE any context (test bodies calling
//     ctx.db directly): only when NODE_ENV=test, and never inside a request or the root context (those stay strict).
import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks';
import { AppError } from '../lib/errors';
import type { Db, RunResult, SqlParams } from '../db/db';

export interface Viewer {
  userId: string;
  /** the client device id the session reported (may be null for older clients) */
  deviceId: string | null;
  isPlatformAdmin: boolean;
}

/** Minimum access a space route needs in THIS subject (ARCHITECTURE_DELTA §5.5). */
export type SpaceAccess = 'member' | 'moderator' | 'guest_publication';

/** One entry of the space-route allow-list: a route may be mounted under /api/spaces/:s only if listed. */
export interface SpaceRouteGrant {
  module: string;
  method: string;
  path: string;
  minAccess: SpaceAccess;
}

export type Binding =
  /** a user's own vault; `viewer` null = background work acting inside that vault (job, timer) */
  | { kind: 'vault'; vaultId: string; viewer: Viewer | null }
  | {
      kind: 'space';
      spaceId: string;
      subjectNodeId: string;
      viewer: Viewer | null;
      /** computed from membership / role on THIS subject node (or an ancestor) — never from another subject */
      access: SpaceAccess;
      route: SpaceRouteGrant | null;
    }
  /** the job worker loop, heartbeats, timers and unauthenticated requests: no database at all */
  | { kind: 'root'; viewer: Viewer | null };

export type DbBinding = Extract<Binding, { kind: 'vault' } | { kind: 'space' }>;

export const ROOT: Binding = Object.freeze({ kind: 'root', viewer: null });

interface Store {
  binding: Binding;
  /** resolved handle, re-resolved when the pool closed it */
  db: Db | null;
}

export class NoTenantBoundError extends AppError {
  constructor(where: string) {
    super('NO_TENANT_BOUND', 'حدث خطأ داخلي غير متوقع في الخادم. أعد المحاولة، وإذا تكرر فراجع سجل الخادم.', 500, undefined);
    this.message = `NO_TENANT_BOUND: database access ${where}`;
  }
}

export function isNoTenantBound(e: unknown): boolean {
  return e instanceof AppError && e.code === 'NO_TENANT_BOUND';
}

const REQ_RESOURCE = Symbol('medlevo.binding.resource');

interface BindableRequest {
  [REQ_RESOURCE]?: AsyncResource;
}

export interface BindingOptions {
  /** opens (or returns the pooled) database of a vault or space binding */
  resolve: (b: DbBinding) => Db;
  /** test runs only: a default binding may be set by the harness */
  allowHarnessDefault: boolean;
}

export class TenantBinding {
  private readonly als = new AsyncLocalStorage<Store>();
  private harness: (() => Binding | null) | null = null;

  constructor(private readonly opts: BindingOptions) {}

  /** The binding in force here, or null outside any context (the harness default is NOT reported). */
  current(): Binding | null {
    return this.als.getStore()?.binding ?? null;
  }

  /** The viewer of the current binding (requests), or null (root, jobs, no context). */
  viewer(): Viewer | null {
    return this.als.getStore()?.binding.viewer ?? null;
  }

  /** Run `fn` (sync or async) inside `b`. Everything it awaits, schedules or enqueues inherits `b`. */
  run<T>(b: Binding, fn: () => T): T {
    return this.als.run({ binding: b, db: null }, fn);
  }

  /** The explicit empty root context of background work: database access inside throws NO_TENANT_BOUND. */
  runRoot<T>(fn: () => T): T {
    return this.run(ROOT, fn);
  }

  /** A function that always runs in the root context, whoever calls it (timers, poke(), event callbacks). */
  bindRoot<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    return (...args: A) => this.runRoot(() => fn(...args));
  }

  /** The database of the current binding, or NO_TENANT_BOUND. */
  db(): Db {
    const store = this.als.getStore();
    if (store) {
      const b = store.binding;
      if (b.kind === 'root') throw new NoTenantBoundError('inside the root context (background work or an unauthenticated request) without an explicit binding');
      if (store.db && store.db.isOpen) return store.db;
      store.db = this.opts.resolve(b);
      return store.db;
    }
    const h = this.harnessDefault();
    if (h) return this.opts.resolve(h);
    throw new NoTenantBoundError('outside any request or job context');
  }

  // ───────── test harness (NODE_ENV=test only) ─────────

  /**
   * Test harness only (NODE_ENV=test): the binding used by code running OUTSIDE every context (test bodies calling
   * ctx.db directly). A function, resolved on use (the harness creates the test account lazily). Never consulted
   * inside a request or the root context.
   */
  setHarnessDefault(b: Binding | (() => Binding | null) | null): void {
    if (!this.opts.allowHarnessDefault) throw new Error('a harness default binding is only allowed in tests');
    this.harness = b === null ? null : typeof b === 'function' ? b : () => b;
  }

  harnessDefault(): DbBinding | null {
    const b = this.harness?.() ?? null;
    return b && b.kind !== 'root' ? b : null;
  }

  // ───────── Fastify request integration ─────────

  /**
   * Enter `b` for the rest of the request (callback-style onRequest hook). The body parser runs the remaining hooks
   * and the handler from the request stream's events, which lose the async context, so `reenter` (preValidation)
   * restores it from the AsyncResource kept on the request.
   */
  enterRequest(req: object, b: Binding, done: (err?: Error) => void): void {
    this.als.run({ binding: b, db: null }, () => {
      const res = new AsyncResource('medlevo-binding');
      (req as BindableRequest)[REQ_RESOURCE] = res;
      res.runInAsyncScope(done);
    });
  }

  reenter(req: object, done: (err?: Error) => void): void {
    const res = (req as BindableRequest)[REQ_RESOURCE];
    if (res) res.runInAsyncScope(done);
    else done();
  }
}

/**
 * The `Db` every module keeps receiving as `ctx.db`: each call goes to the database of the current binding. The proxy
 * never closes anything (the pool owns connections), and `isOpen` says whether a database is bound here.
 */
export function createBoundDb(binding: TenantBinding): Db {
  return {
    get raw() {
      return binding.db().raw;
    },
    get path() {
      return binding.db().path;
    },
    get<T = Record<string, unknown>>(sql: string, params?: SqlParams): T | undefined {
      return binding.db().get<T>(sql, params);
    },
    all<T = Record<string, unknown>>(sql: string, params?: SqlParams): T[] {
      return binding.db().all<T>(sql, params);
    },
    run(sql: string, params?: SqlParams): RunResult {
      return binding.db().run(sql, params);
    },
    exec(sql: string): void {
      binding.db().exec(sql);
    },
    tx<T>(fn: () => T): T {
      return binding.db().tx(fn);
    },
    get inTransaction() {
      return binding.db().inTransaction;
    },
    close(): void {
      // the pool owns the connections; closing «the current database» through the proxy is never meaningful
    },
    get isOpen() {
      try {
        return binding.db().isOpen;
      } catch {
        return false;
      }
    },
  };
}
