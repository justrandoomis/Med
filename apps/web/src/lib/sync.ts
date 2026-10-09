// Outbox sync engine (ARCHITECTURE §3.4, §4; spec §26, §47).
//
// Guarantees
//  * Writes are local first: a feature writes its Dexie row AND enqueues the op in ONE transaction
//    (enqueue() refuses to run outside such a transaction).
//  * Ops are never dropped on failure. Network/server failures keep the op `pending` with
//    exponential backoff; only ops the server confirmed (applied/merged/duplicate) become `synced`
//    (and are pruned after a retention period).
//  * Idempotent: every op has a client ULID op_id; re-sending returns `duplicate` → treated as success.
//  * Per-entity order is preserved: at most one op per entity per batch; later ops wait for earlier ones.
//  * conflict_kept_both (server kept both copies) and rejected-with-server-copy surface as `conflict`;
//    rejected without a copy surfaces as `error`. Both stay visible until the owner acknowledges/retries.
//  * Pull: GET /api/sync/pull?since=<seq>; the cursor lives in kv. Changes go to the applier a feature
//    registered for the entity type, or wait in `syncInbox` until one is registered (lazy routes).
//  * Multi-tab safe: one push/pull at a time across tabs via the Web Locks API (when available);
//    server idempotency covers browsers without it.
import Dexie, { liveQuery, type EntityTable, type Table } from 'dexie';
import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  newId,
  type SyncChange,
  type SyncOp,
  type SyncOpResult,
  type SyncPullResponse,
  type SyncPushRequest,
  type SyncPushResponse,
  type SyncState,
} from '@medlevo/shared';
import { api, ApiError, isApiError } from './api';
import { getDeviceId } from './deviceId';
import {
  ENTITY_TABLE,
  getDb,
  kvGet,
  kvSet,
  type MedLevoDB,
  type OutboxRecord,
  type SyncedRowBase,
  type SyncEntityType,
  type SyncOpKind,
  type SyncResult,
} from './localdb';

// ─── wire types (§3.4, packages/shared/src/api.ts) ───────────────────────────────────────
export type PushOp = SyncOp;
export type PushResultItem = SyncOpResult;
export type PullChange = SyncChange;
export type PullResponse = SyncPullResponse;

export interface SyncTransport {
  push(body: SyncPushRequest): Promise<PushResultItem[]>;
  pull(since: number, limit: number): Promise<PullResponse>;
}

/** Accepts the documented `{ results: […] }` envelope (and a bare array, defensively). */
export function normalizePushResponse(raw: unknown): PushResultItem[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? (raw as Partial<SyncPushResponse>).results : undefined;
  if (!Array.isArray(list)) throw new ApiError({ code: 'BAD_RESPONSE', status: 200, message: 'ردّ المزامنة من الخادم غير مفهوم.' });
  return list.filter((r): r is PushResultItem => !!r && typeof r === 'object' && typeof (r as PushResultItem).op_id === 'string');
}

// Background requests never trigger the global "session expired → /login" redirect: sync runs on
// timers while the owner may be mid-stroke (§55: writing never stops because of the network). A 401
// pauses sync (`authRequired`) and the save indicator offers sign-in instead.
export const httpTransport: SyncTransport = {
  async push(body) {
    return normalizePushResponse(await api.post<SyncPushResponse>('/sync/push', body, { timeoutMs: 60_000, skipAuthRedirect: true }));
  },
  async pull(since, limit) {
    const res = await api.get<SyncPullResponse>('/sync/pull', { query: { since, limit }, timeoutMs: 60_000, skipAuthRedirect: true });
    return { changes: Array.isArray(res?.changes) ? res.changes : [], next_since: Number(res?.next_since ?? since), has_more: !!res?.has_more };
  },
};

// ─── enqueue (same transaction as the entity write) ────────────────────────────────────────
export interface EnqueueInput {
  entity_type: SyncEntityType | (string & {});
  entity_id: string;
  op: SyncOpKind;
  payload: unknown;
  base_rev?: number | null;
  op_id?: string;
  client_ts?: number;
}

type OutboxListener = (db: MedLevoDB) => void;
const outboxListeners = new Set<OutboxListener>();

/**
 * Adds a sync op to the outbox. MUST be called inside `db.transaction('rw', [entityTable, db.outbox], …)`
 * together with the entity write, so the row and its op commit (or roll back) together.
 * An unsent pending upsert of the same entity is coalesced (latest payload REPLACES the earlier one,
 * same op_id) — so an `upsert` payload must always be the entity's FULL current state, never a
 * partial patch (a partial patch would silently drop the fields of the earlier, coalesced edit).
 */
export async function enqueue(db: MedLevoDB, input: EnqueueInput): Promise<OutboxRecord> {
  const tx = Dexie.currentTransaction;
  if (!tx || tx.mode !== 'readwrite' || !tx.storeNames.includes('outbox')) {
    throw new Error('enqueue() must run inside a read-write db.transaction that includes db.outbox and the entity table.');
  }
  const now = input.client_ts ?? Date.now();
  if (input.op === 'upsert') {
    const ops = await db.outbox.where('[entity_type+entity_id]').equals([input.entity_type, input.entity_id]).sortBy('seq');
    const lastPending = [...ops].reverse().find((o) => o.status === 'pending');
    if (lastPending && lastPending.op === 'upsert' && !lastPending.sentAt && lastPending.seq != null) {
      const merged: OutboxRecord = { ...lastPending, payload: input.payload, client_ts: now };
      await db.outbox.put(merged);
      tx.on('complete', () => notifyOutbox(db));
      return merged;
    }
  }
  const rec: OutboxRecord = {
    op_id: input.op_id ?? newId(now),
    entity_type: input.entity_type,
    entity_id: input.entity_id,
    op: input.op,
    base_rev: input.base_rev ?? null,
    payload: input.payload,
    client_ts: now,
    status: 'pending',
    attempts: 0,
    nextAttemptAt: 0,
    sentAt: null,
    lastError: null,
  };
  const seq = await db.outbox.add(rec);
  tx.on('complete', () => notifyOutbox(db));
  return { ...rec, seq: seq as number };
}

function notifyOutbox(db: MedLevoDB) {
  outboxListeners.forEach((l) => {
    try {
      l(db);
    } catch {
      // listeners must not break the write path
    }
  });
}

/**
 * Convenience: put a row and enqueue its op atomically. The row is stored with
 * syncState 'pending_sync' (the UI shows «محفوظ محليًا» while offline).
 */
export async function writeAndEnqueue<T extends SyncedRowBase>(
  db: MedLevoDB,
  table: EntityTable<T, 'id'>,
  row: T,
  op: Omit<EnqueueInput, 'entity_id' | 'payload'> & { payload?: unknown },
): Promise<OutboxRecord> {
  return db.transaction('rw', [table, db.outbox], async () => {
    await table.put({ ...row, syncState: 'pending_sync' });
    return enqueue(db, { ...op, entity_id: row.id, payload: op.payload ?? row });
  });
}

// ─── appliers (pull + push results → local rows) ───────────────────────────────────────────
export interface ApplierContext {
  db: MedLevoDB;
  /** where the change came from */
  source: 'pull' | 'push';
  /** unsynced local ops for this entity (pending / conflict / rejected) — don't overwrite their writes */
  localOps: OutboxRecord[];
}
export type SyncApplier = (change: PullChange | (Omit<PullChange, 'seq'> & { seq: null }), ctx: ApplierContext) => Promise<void> | void;

// ─── engine ────────────────────────────────────────────────────────────────────────────────
export interface SyncSnapshot {
  online: boolean;
  running: boolean;
  phase: 'idle' | 'pushing' | 'pulling';
  /** ops waiting to be sent */
  pending: number;
  /** unacknowledged conflicts */
  conflicts: number;
  /** unacknowledged rejections + ops failing repeatedly with server errors */
  errors: number;
  lastSyncedAt: number | null;
  lastError: { message: string; at: number; offline: boolean } | null;
  nextRetryAt: number | null;
  /** the server answered 401: sync paused until the owner signs in again */
  authRequired: boolean;
  /** the last pull failed with a server error (not merely offline) */
  pullFailed: boolean;
  /** aggregate state for the global SaveStatus */
  state: SyncState;
}

export interface SyncEngineOptions {
  db?: MedLevoDB;
  transport?: SyncTransport;
  now?: () => number;
  random?: () => number;
  batchSize?: number;
  pullLimit?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** ops failing this many times with server errors count as `error` */
  errorAfterAttempts?: number;
  syncedRetentionMs?: number;
  /** Web Locks; null disables cross-tab locking (tests / old browsers) */
  locks?: LockManager | null;
  deviceId?: string;
  isOnline?: () => boolean;
  pushDebounceMs?: number;
  pollIntervalMs?: number;
}

const PULL_CURSOR_KEY = 'sync.pull.since';
const LAST_SYNC_KEY = 'sync.lastSyncedAt';
const LOCK_NAME = 'medlevo-sync';

export function backoffDelay(attempts: number, base: number, max: number, random: () => number): number {
  const exp = Math.min(max, base * 2 ** Math.max(0, attempts - 1));
  const jitter = 0.8 + random() * 0.4; // ±20 %
  return Math.round(Math.min(max, exp * jitter));
}

function entityKey(type: string, id: string) {
  return `${type}\u0000${id}`;
}

/** Per-entity save state from its outbox ops (null = no local ops recorded). */
export function entityStateFromOps(ops: OutboxRecord[], online: boolean, errorAfterAttempts = 3): SyncState | null {
  if (ops.length === 0) return null;
  const open = ops.filter((o) => !o.acknowledgedAt);
  if (open.some((o) => o.status === 'conflict')) return 'conflict';
  if (open.some((o) => o.status === 'rejected')) return 'error';
  const pending = ops.filter((o) => o.status === 'pending');
  if (pending.length > 0) {
    if (pending.some((o) => o.attempts >= errorAfterAttempts && o.lastError && !isOfflineError(o))) return 'error';
    return online ? 'pending_sync' : 'saved_locally';
  }
  return 'synced';
}

function isOfflineError(o: OutboxRecord): boolean {
  return (o.resultDetail as { offline?: boolean } | undefined)?.offline === true;
}

export class SyncEngine {
  readonly db: MedLevoDB;
  private transport: SyncTransport;
  private now: () => number;
  private random: () => number;
  private batchSize: number;
  private pullLimit: number;
  private base: number;
  private max: number;
  private errorAfter: number;
  private retention: number;
  private locks: LockManager | null;
  private deviceId: string | undefined;
  private isOnlineFn: () => boolean;
  private debounceMs: number;
  private pollMs: number;

  private appliers = new Map<string, SyncApplier>();
  /** every applier call runs through this chain → server changes are applied strictly in order */
  private applyChain: Promise<unknown> = Promise.resolve();
  private listeners = new Set<() => void>();
  private snapshot: SyncSnapshot;
  private running = false;
  private inFlight: Promise<void> | null = null;
  private rerun = false;
  /** a caller asked for a pull; consumed by the next run (a push-only run in flight must not swallow it) */
  private wantPull = false;
  private pushTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private liveSub: { unsubscribe(): void } | undefined;
  private cleanup: Array<() => void> = [];

  constructor(opts: SyncEngineOptions = {}) {
    this.db = opts.db ?? getDb();
    this.transport = opts.transport ?? httpTransport;
    this.now = opts.now ?? (() => Date.now());
    this.random = opts.random ?? Math.random;
    this.batchSize = Math.min(opts.batchSize ?? 100, 500); // server MAX_PUSH_OPS = 500
    this.pullLimit = opts.pullLimit ?? 200;
    this.base = opts.backoffBaseMs ?? 1_000;
    this.max = opts.backoffMaxMs ?? 5 * 60_000;
    this.errorAfter = opts.errorAfterAttempts ?? 3;
    this.retention = opts.syncedRetentionMs ?? 7 * 24 * 60 * 60_000;
    this.locks = opts.locks !== undefined ? opts.locks : typeof navigator !== 'undefined' && navigator.locks ? navigator.locks : null;
    this.deviceId = opts.deviceId;
    this.isOnlineFn = opts.isOnline ?? (() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false));
    this.debounceMs = opts.pushDebounceMs ?? 400;
    this.pollMs = opts.pollIntervalMs ?? 60_000;
    this.snapshot = {
      online: this.isOnlineFn(),
      running: false,
      phase: 'idle',
      pending: 0,
      conflicts: 0,
      errors: 0,
      lastSyncedAt: null,
      lastError: null,
      nextRetryAt: null,
      authRequired: false,
      pullFailed: false,
      state: 'synced',
    };
  }

  // ── observable state ──
  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getSnapshot = (): SyncSnapshot => this.snapshot;

  private patch(p: Partial<SyncSnapshot>) {
    const next = { ...this.snapshot, ...p };
    next.state = aggregateState(next);
    this.snapshot = next;
    this.listeners.forEach((l) => l());
  }

  /** Recompute counts from the outbox (also driven by a liveQuery while running → multi-tab). */
  async refresh(): Promise<SyncSnapshot> {
    const rows = await this.db.outbox.where('status').anyOf('pending', 'conflict', 'rejected').toArray();
    const lastSyncedAt = (await kvGet<number>(this.db, LAST_SYNC_KEY)) ?? this.snapshot.lastSyncedAt;
    this.applyCounts(rows, lastSyncedAt ?? null);
    return this.snapshot;
  }

  private applyCounts(rows: OutboxRecord[], lastSyncedAt?: number | null) {
    let pending = 0;
    let conflicts = 0;
    let errors = 0;
    let nextRetryAt: number | null = null;
    for (const r of rows) {
      if (r.status === 'pending') {
        pending++;
        if (r.attempts >= this.errorAfter && r.lastError && !isOfflineError(r)) errors++;
        if (r.nextAttemptAt > this.now()) nextRetryAt = nextRetryAt == null ? r.nextAttemptAt : Math.min(nextRetryAt, r.nextAttemptAt);
      } else if (!r.acknowledgedAt) {
        if (r.status === 'conflict') conflicts++;
        else if (r.status === 'rejected') errors++;
      }
    }
    this.patch({ pending, conflicts, errors, nextRetryAt, online: this.isOnlineFn(), ...(lastSyncedAt !== undefined ? { lastSyncedAt } : {}) });
  }

  /** Save state of one entity (for its SaveStatus). */
  async entityState(entityType: string, entityId: string): Promise<SyncState | null> {
    const ops = await this.db.outbox.where('[entity_type+entity_id]').equals([entityType, entityId]).toArray();
    return entityStateFromOps(ops, this.isOnlineFn(), this.errorAfter);
  }

  // ── lifecycle ──
  start(): void {
    if (this.running) return;
    this.running = true;
    this.patch({ running: true, authRequired: false, online: this.isOnlineFn() });
    if (typeof window !== 'undefined') {
      const onOnline = () => {
        this.patch({ online: true });
        void this.resetBackoff().then(() => this.syncNow());
      };
      const onOffline = () => this.patch({ online: false });
      const onVisible = () => {
        if (document.visibilityState === 'visible') void this.syncNow();
      };
      window.addEventListener('online', onOnline);
      window.addEventListener('offline', onOffline);
      document.addEventListener('visibilitychange', onVisible);
      this.cleanup.push(() => {
        window.removeEventListener('online', onOnline);
        window.removeEventListener('offline', onOffline);
        document.removeEventListener('visibilitychange', onVisible);
      });
    }
    const listener: OutboxListener = (db) => {
      if (db === this.db) this.schedulePush();
    };
    outboxListeners.add(listener);
    this.cleanup.push(() => outboxListeners.delete(listener));
    try {
      this.liveSub = liveQuery(() => this.db.outbox.where('status').anyOf('pending', 'conflict', 'rejected').toArray()).subscribe({
        next: (rows) => {
          const before = this.snapshot.pending;
          this.applyCounts(rows);
          // ops enqueued by another tab: push them (the lock keeps it to one tab at a time)
          if (rows.length && this.snapshot.pending > before) this.schedulePush();
        },
        error: () => {},
      });
    } catch {
      this.liveSub = undefined;
    }
    this.pollTimer = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState !== 'hidden') void this.syncNow();
    }, this.pollMs);
    void this.refresh().then(() => this.syncNow());
  }

  stop(): void {
    this.running = false;
    this.cleanup.forEach((f) => f());
    this.cleanup = [];
    this.liveSub?.unsubscribe();
    this.liveSub = undefined;
    clearTimeout(this.pushTimer);
    clearTimeout(this.retryTimer);
    clearInterval(this.pollTimer);
    this.patch({ running: false, phase: 'idle' });
  }

  /** Debounced push after local writes. */
  schedulePush(delay = this.debounceMs): void {
    if (!this.running) return;
    clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => void this.syncNow({ pull: false }), delay);
  }

  private scheduleRetry() {
    clearTimeout(this.retryTimer);
    const at = this.snapshot.nextRetryAt;
    if (!this.running || at == null) return;
    this.retryTimer = setTimeout(() => void this.syncNow({ pull: false }), Math.max(250, at - this.now()));
  }

  /** Push due ops, then pull. Concurrent calls coalesce; other tabs are excluded by a Web Lock. */
  syncNow(opts: { pull?: boolean } = {}): Promise<void> {
    if (opts.pull !== false) this.wantPull = true;
    if (this.inFlight) {
      this.rerun = true;
      return this.inFlight;
    }
    const run = async () => {
      do {
        this.rerun = false;
        const pull = this.wantPull;
        this.wantPull = false;
        await this.withLock(async () => {
          if (!this.isOnlineFn()) {
            this.patch({ online: false });
            return;
          }
          this.patch({ online: true });
          await this.pushAll();
          if (pull && !this.snapshot.authRequired) await this.pullOnce();
        });
      } while (this.rerun && this.running);
    };
    this.inFlight = run()
      .catch(() => {})
      .finally(() => {
        this.inFlight = null;
        this.patch({ phase: 'idle' });
        this.scheduleRetry();
      });
    return this.inFlight;
  }

  private async withLock(fn: () => Promise<void>): Promise<void> {
    if (!this.locks) return fn();
    await this.locks.request(LOCK_NAME, { ifAvailable: true }, async (lock) => {
      if (!lock) return; // another tab is syncing; its liveQuery updates reach us
      await fn();
    });
  }

  private async getDeviceId(): Promise<string> {
    if (!this.deviceId) this.deviceId = await getDeviceId(this.db);
    return this.deviceId;
  }

  /** Clears backoff for ops that failed because the device was offline (called when back online). */
  async resetBackoff(): Promise<void> {
    await this.db.transaction('rw', this.db.outbox, async () => {
      await this.db.outbox
        .where('status')
        .equals('pending')
        .modify((o) => {
          if (isOfflineError(o) || o.attempts === 0) o.nextAttemptAt = 0;
        });
    });
  }

  private async pushAll(): Promise<void> {
    for (let i = 0; i < 20; i++) {
      const r = await this.pushOnce();
      if (r.sent === 0 || r.failed || r.sent < this.batchSize) break;
    }
  }

  /** One push round. Exposed for tests and the Control Center ("sync now"). */
  async pushOnce(): Promise<{ sent: number; failed: boolean; results: PushResultItem[] }> {
    const db = this.db;
    const now = this.now();
    const deviceId = await this.getDeviceId();

    // select + mark sentAt in one transaction (no coalescing into an op that is on the wire)
    const batch = await db.transaction('rw', db.outbox, async () => {
      const pending = await db.outbox.where('status').equals('pending').sortBy('seq');
      const chosen: OutboxRecord[] = [];
      const taken = new Set<string>();
      const blocked = new Set<string>();
      for (const op of pending) {
        const key = entityKey(op.entity_type, op.entity_id);
        if (blocked.has(key) || taken.has(key)) {
          blocked.add(key);
          continue;
        }
        if (op.nextAttemptAt > now) {
          blocked.add(key); // keep later ops of this entity behind it
          continue;
        }
        taken.add(key);
        chosen.push(op);
        if (chosen.length >= this.batchSize) break;
      }
      for (const op of chosen) {
        if (!op.sentAt) {
          op.sentAt = now;
          await db.outbox.update(op.seq!, { sentAt: now });
        }
      }
      return chosen;
    });
    if (batch.length === 0) return { sent: 0, failed: false, results: [] };

    this.patch({ phase: 'pushing' });
    let results: PushResultItem[];
    try {
      results = await this.transport.push({
        ops: batch.map((o) => ({
          op_id: o.op_id,
          device_id: deviceId,
          entity_type: o.entity_type,
          entity_id: o.entity_id,
          op: o.op,
          base_rev: o.base_rev ?? null,
          payload: o.payload,
          client_ts: o.client_ts,
        })),
      });
    } catch (e) {
      await this.recordFailure(batch, e);
      return { sent: batch.length, failed: true, results: [] };
    }

    const byId = new Map(results.map((r) => [r.op_id, r]));
    const toApply: Array<{ op: OutboxRecord; res: PushResultItem }> = [];
    const tables = this.entityTables();
    await db.transaction('rw', [db.outbox, ...tables], async () => {
      for (const op of batch) {
        const res = byId.get(op.op_id);
        const fresh = await db.outbox.get(op.seq!);
        if (!fresh) continue;
        // a duplicate reports what happened the first time (e.g. the conflict whose answer we lost)
        const effective = res?.result === 'duplicate' && res.original_result && res.original_result !== 'duplicate' ? res.original_result : res?.result;
        if (!res || !isSyncResult(effective) || res.retryable) {
          // no verdict, or a transient server failure for this op: keep it queued with backoff
          const attempts = fresh.attempts + 1;
          await db.outbox.update(op.seq!, {
            attempts,
            nextAttemptAt: now + backoffDelay(attempts, this.base, this.max, this.random),
            lastError: res?.detail || 'لم يُكمل الخادم هذه العملية؛ ستُعاد المحاولة تلقائيًا.',
            resultDetail: { offline: false },
          });
          continue;
        }
        const status =
          effective === 'conflict_kept_both'
            ? 'conflict'
            : effective === 'rejected'
              ? res.entity != null
                ? 'conflict'
                : 'rejected'
              : 'synced';
        await db.outbox.update(op.seq!, {
          status,
          result: res.result,
          resultDetail: res.detail ?? null,
          resultEntity: res.entity ?? null,
          resolvedAt: now,
          lastError: status === 'rejected' ? detailMessage(res.detail) : null,
        });
        if (status === 'synced') await this.rebaseFollowing(fresh, res.entity);
        if (res.entity !== undefined && res.entity !== null) toApply.push({ op: fresh, res });
      }
      await this.mirrorRowStates(batch.map((o) => [o.entity_type, o.entity_id] as const));
    });

    const prunedBefore = now - this.retention;
    await db.outbox
      .where('status')
      .equals('synced')
      .filter((o) => (o.resolvedAt ?? now) < prunedBefore)
      .delete();

    for (const { op, res } of toApply) await this.dispatch({ seq: null, entity_type: op.entity_type, entity_id: op.entity_id, entity: res.entity ?? null }, 'push');

    await kvSet(db, LAST_SYNC_KEY, now);
    this.patch({ lastSyncedAt: now, lastError: null, authRequired: false });
    await this.refresh();
    return { sent: batch.length, failed: false, results };
  }

  /** After op A for entity X is acknowledged with a new rev, later ops built on A's base move to that rev. */
  private async rebaseFollowing(op: OutboxRecord, entity: unknown) {
    const rev = entity && typeof entity === 'object' ? (entity as { rev?: unknown }).rev : undefined;
    if (typeof rev !== 'number' || op.op === 'append') return;
    const later = await this.db.outbox.where('[entity_type+entity_id]').equals([op.entity_type, op.entity_id]).toArray();
    for (const l of later) {
      if (l.seq! > op.seq! && l.status === 'pending' && (l.base_rev ?? null) === (op.base_rev ?? null)) {
        await this.db.outbox.update(l.seq!, { base_rev: rev });
      }
    }
  }

  private async recordFailure(batch: OutboxRecord[], e: unknown) {
    const now = this.now();
    if (isApiError(e) && e.status === 401) {
      // not the op's fault: keep it untouched, pause until the owner signs in again
      this.patch({ authRequired: true, lastError: { message: e.message, at: now, offline: false } });
      return;
    }
    const offline = isApiError(e) ? e.offline : false;
    const message = isApiError(e) ? e.message : 'تعذّر إرسال التغييرات؛ ستُعاد المحاولة تلقائيًا.';
    await this.db.transaction('rw', this.db.outbox, async () => {
      for (const op of batch) {
        const fresh = await this.db.outbox.get(op.seq!);
        if (!fresh || fresh.status !== 'pending') continue;
        const attempts = fresh.attempts + 1;
        await this.db.outbox.update(op.seq!, {
          attempts,
          nextAttemptAt: now + backoffDelay(attempts, this.base, this.max, this.random),
          lastError: message,
          resultDetail: { offline },
        });
      }
    });
    this.patch({ lastError: { message, at: now, offline }, online: offline ? this.isOnlineFn() : true });
    await this.refresh();
  }

  private entityTables(): Table[] {
    return Object.values(ENTITY_TABLE).map((name) => this.db.table(name));
  }

  /** Mirror the computed state onto local rows (their `syncState` index). */
  private async mirrorRowStates(keys: ReadonlyArray<readonly [string, string]>) {
    const seen = new Set<string>();
    for (const [type, id] of keys) {
      const k = entityKey(type, id);
      if (seen.has(k)) continue;
      seen.add(k);
      const tableName = ENTITY_TABLE[type as SyncEntityType];
      if (!tableName) continue;
      const ops = await this.db.outbox.where('[entity_type+entity_id]').equals([type, id]).toArray();
      const state = entityStateFromOps(ops, true, this.errorAfter);
      if (!state) continue;
      const table = this.db.table(tableName);
      const row = await table.get(id);
      if (row && row.syncState !== state) await table.update(id, { syncState: state });
    }
  }

  // ── pull ──
  async pullOnce(): Promise<{ applied: number; inboxed: number }> {
    let since = (await kvGet<number>(this.db, PULL_CURSOR_KEY)) ?? 0;
    let applied = 0;
    let inboxed = 0;
    this.patch({ phase: 'pulling' });
    await this.drainInbox();
    try {
      for (let page = 0; page < 50; page++) {
        const res = await this.transport.pull(since, this.pullLimit);
        for (const ch of res.changes) {
          if ((await this.dispatch(ch, 'pull')) === 'applied') applied++;
          else inboxed++;
        }
        const maxSeq = res.changes.reduce((m, c) => Math.max(m, c.seq), since);
        since = Number.isFinite(res.next_since) && res.next_since >= since ? res.next_since : maxSeq;
        await kvSet(this.db, PULL_CURSOR_KEY, since);
        if (!res.has_more || res.changes.length === 0) break;
      }
    } catch (e) {
      if (isApiError(e) && e.status === 401) this.patch({ authRequired: true });
      else {
        const offline = isApiError(e) ? e.offline : false;
        this.patch({ pullFailed: !offline, lastError: { message: isApiError(e) ? e.message : 'تعذّر جلب التغييرات من الخادم.', at: this.now(), offline } });
      }
      return { applied, inboxed };
    }
    // a complete pull means this device has everything the server had at that moment
    const at = this.now();
    if (this.snapshot.pending === 0) await kvSet(this.db, LAST_SYNC_KEY, at);
    this.patch({ pullFailed: false, ...(this.snapshot.pending === 0 ? { lastSyncedAt: at, lastError: null } : {}) });
    return { applied, inboxed };
  }

  /** Routes one server change to its applier, or parks it in syncInbox. */
  private dispatch(change: PullChange | (Omit<PullChange, 'seq'> & { seq: null }), source: 'pull' | 'push'): Promise<'applied' | 'inboxed'> {
    return this.serial(() => this.dispatchNow(change, source));
  }

  private async dispatchNow(change: PullChange | (Omit<PullChange, 'seq'> & { seq: null }), source: 'pull' | 'push'): Promise<'applied' | 'inboxed'> {
    const key: [string, string] = [change.entity_type, change.entity_id];
    const parked = await this.db.syncInbox.get(key);
    // a newer parked change wins over an older one arriving late
    if (parked && change.seq != null && parked.seq > change.seq) return 'inboxed';
    const applier = this.appliers.get(change.entity_type);
    if (applier) {
      try {
        const localOps = await this.db.outbox
          .where('[entity_type+entity_id]')
          .equals(key)
          .filter((o) => o.status !== 'synced')
          .toArray();
        await applier(change, { db: this.db, source, localOps });
        if (parked && (change.seq == null || parked.seq <= change.seq)) await this.db.syncInbox.delete(key);
        return 'applied';
      } catch {
        // fall through: keep the change for a later attempt
      }
    }
    if (change.seq != null && (!parked || parked.seq <= change.seq)) {
      await this.db.syncInbox.put({ entity_type: change.entity_type, entity_id: change.entity_id, seq: change.seq, entity: change.entity, receivedAt: this.now() });
    }
    return 'inboxed';
  }

  /**
   * Feature modules register how pulled entities are written into their Dexie tables.
   * Parked changes for that type are delivered immediately.
   */
  registerApplier(entityType: string, applier: SyncApplier): () => void {
    this.appliers.set(entityType, applier);
    void this.drainInbox(entityType);
    return () => {
      if (this.appliers.get(entityType) === applier) this.appliers.delete(entityType);
    };
  }

  /**
   * Delivers parked changes to their appliers. Drains are serialized (no change is delivered twice
   * by concurrent drains); appliers should still be idempotent (a crash between apply and delete
   * re-delivers the change once).
   */
  drainInbox(entityType?: string): Promise<number> {
    return this.serial(() => this.drainInboxNow(entityType));
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.applyChain.then(fn);
    this.applyChain = run.catch(() => undefined);
    return run;
  }

  private async drainInboxNow(entityType?: string): Promise<number> {
    const rows = entityType ? await this.db.syncInbox.where('entity_type').equals(entityType).sortBy('seq') : await this.db.syncInbox.orderBy('seq').toArray();
    let n = 0;
    for (const r of rows) {
      const applier = this.appliers.get(r.entity_type);
      if (!applier) continue;
      const current = await this.db.syncInbox.get([r.entity_type, r.entity_id]);
      if (!current || current.seq !== r.seq) continue; // already delivered or superseded
      try {
        const localOps = await this.db.outbox
          .where('[entity_type+entity_id]')
          .equals([r.entity_type, r.entity_id])
          .filter((o) => o.status !== 'synced')
          .toArray();
        await applier({ seq: r.seq, entity_type: r.entity_type, entity_id: r.entity_id, entity: r.entity }, { db: this.db, source: 'pull', localOps });
        await this.db.syncInbox.delete([r.entity_type, r.entity_id]);
        n++;
      } catch {
        // stays parked
      }
    }
    return n;
  }

  // ── owner actions ──
  /** Owner saw the conflict / rejection and decided (kept both copies or accepted the server copy). */
  async acknowledge(opId: string): Promise<void> {
    const op = await this.db.outbox.where('op_id').equals(opId).first();
    if (!op) return;
    await this.db.transaction('rw', [this.db.outbox, ...this.entityTables()], async () => {
      await this.db.outbox.update(op.seq!, { acknowledgedAt: this.now() });
      await this.mirrorRowStates([[op.entity_type, op.entity_id]]);
    });
    await this.refresh();
  }

  /**
   * Send a rejected / conflicting write again (e.g. after the owner fixed something on the server).
   *
   * The server records every verdict under its op_id and answers a repeated op_id with `duplicate` +
   * the ORIGINAL result (§3.4 idempotency) — re-sending the same op_id could never succeed. So the
   * retry is a NEW op (fresh op_id, same entity/payload/base_rev/client_ts) queued behind any later
   * ops of the entity; the old op stays in the outbox, acknowledged and marked `supersededBy`.
   * Returns the new op, or null when there is nothing to retry (unknown, synced, pending or already retried).
   */
  async retry(opId: string): Promise<OutboxRecord | null> {
    const db = this.db;
    const created = await db.transaction('rw', [db.outbox, ...this.entityTables()], async () => {
      const op = await db.outbox.where('op_id').equals(opId).first();
      if (!op || (op.status !== 'rejected' && op.status !== 'conflict') || op.supersededBy) return null;
      const now = this.now();
      const rec: OutboxRecord = {
        op_id: newId(now),
        entity_type: op.entity_type,
        entity_id: op.entity_id,
        op: op.op,
        base_rev: op.base_rev ?? null,
        payload: op.payload,
        client_ts: op.client_ts,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: 0,
        sentAt: null,
        lastError: null,
        retryOf: op.op_id,
      };
      const seq = (await db.outbox.add(rec)) as number;
      await db.outbox.update(op.seq!, { acknowledgedAt: op.acknowledgedAt ?? now, supersededBy: rec.op_id });
      await this.mirrorRowStates([[op.entity_type, op.entity_id]]);
      return { ...rec, seq };
    });
    if (!created) return null;
    await this.refresh();
    this.schedulePush(0);
    return created;
  }

  /** Unacknowledged conflicts / rejections for a Control Center list. */
  async openIssues(): Promise<OutboxRecord[]> {
    return (await this.db.outbox.where('status').anyOf('conflict', 'rejected').toArray()).filter((o) => !o.acknowledgedAt);
  }
}

function isSyncResult(v: unknown): v is SyncResult {
  return v === 'applied' || v === 'merged' || v === 'conflict_kept_both' || v === 'duplicate' || v === 'rejected';
}

function detailMessage(detail: unknown): string {
  if (typeof detail === 'string' && detail) return detail;
  if (detail && typeof detail === 'object' && typeof (detail as { message?: unknown }).message === 'string') return (detail as { message: string }).message;
  return 'رفض الخادم هذا التغيير. راجعه قبل إعادة الإرسال.';
}

export function aggregateState(s: Pick<SyncSnapshot, 'pending' | 'conflicts' | 'errors' | 'online' | 'authRequired' | 'pullFailed'>): SyncState {
  if (s.conflicts > 0) return 'conflict';
  if (s.errors > 0) return 'error';
  if (s.pending > 0) return s.online && !s.authRequired ? 'pending_sync' : 'saved_locally';
  // signed out by the server: nothing local is pending, but nothing can be pulled either → never «تمت المزامنة»
  if (s.authRequired) return 'error';
  if (s.pullFailed && s.online) return 'error';
  return 'synced';
}

/** Arabic explanation for the global save indicator. */
export function describeSyncSnapshot(s: SyncSnapshot): string {
  if (s.conflicts > 0) return `تعارضات تحتاج مراجعتك: ${s.conflicts}. احتُفظ بالنسختين ولم يُحذف شيء.`;
  if (s.errors > 0) return `${s.lastError?.message ?? 'تعذّرت مزامنة بعض التغييرات.'} عدد العمليات المتأثرة: ${s.errors}.`;
  if (s.pullFailed && s.online && s.pending === 0) return `${s.lastError?.message ?? 'تعذّر جلب التغييرات من الخادم.'} تغييراتك المحلية كلها وصلت؛ ستُعاد محاولة الجلب تلقائيًا.`;
  if (s.authRequired && s.pending > 0) return `التغييرات محفوظة على هذا الجهاز (${s.pending}). سجّل الدخول لإكمال المزامنة.`;
  if (s.authRequired) return 'لا توجد تغييرات محلية معلّقة، لكن جلب التغييرات من الخادم متوقف حتى تسجّل الدخول.';
  if (s.pending > 0)
    return s.online
      ? `عدد التغييرات التي تنتظر الإرسال: ${s.pending}.`
      : `دون اتصال. التغييرات محفوظة على هذا الجهاز (${s.pending}) وستُرسل عند عودة الاتصال.`;
  return s.lastSyncedAt ? 'هذا الجهاز متزامن مع الخادم: لا تغييرات معلّقة في أي اتجاه.' : 'لا توجد تغييرات محلية بانتظار المزامنة.';
}

// ─── app singleton & hooks ─────────────────────────────────────────────────────────────────
let engine: SyncEngine | null = null;

export function getSyncEngine(): SyncEngine {
  if (!engine) engine = new SyncEngine();
  return engine;
}

/** Global sync snapshot (re-renders on change). */
export function useSyncSnapshot(e: SyncEngine = getSyncEngine()): SyncSnapshot {
  return useSyncExternalStore(e.subscribe, e.getSnapshot, e.getSnapshot);
}

/**
 * Live save state of one entity, e.g. for a note editor's SaveStatus. `null` while unknown
 * (no local ops recorded for it → treat as synced / server-only).
 */
export function useEntitySyncState(entityType: string, entityId: string | null | undefined, e: SyncEngine = getSyncEngine()): SyncState | null {
  const [state, setState] = useState<SyncState | null>(null);
  const { online } = useSyncSnapshot(e);
  useEffect(() => {
    if (!entityId) {
      setState(null);
      return;
    }
    const sub = liveQuery(() => e.db.outbox.where('[entity_type+entity_id]').equals([entityType, entityId]).toArray()).subscribe({
      next: (ops) => setState(entityStateFromOps(ops, online)),
      error: () => setState('error'),
    });
    return () => sub.unsubscribe();
  }, [e, entityType, entityId, online]);
  return state;
}
