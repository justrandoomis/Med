// Generic, idempotent sync engine (§47, ARCHITECTURE §3.4).
//  * every client op has a unique op_id; applied at most once (sync_operation). A repeated op_id returns
//    'duplicate' together with the ORIGINAL result — so a retried request never double-applies.
//  * concrete merge policies live in entity handlers registered by the owning modules
//    (append-only insert-if-absent, rev-based keep-both, tombstones, ...). The engine never does blind LWW.
//  * modules call touch(entityType, id) inside the same transaction as their write; pull reads the
//    monotonic sync_change feed (one row per entity at its latest seq).
import type { SyncChange, SyncOp, SyncOpResult, SyncPullResponse, SyncPushResponse, SyncResult } from '@medlevo/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/db';
import { fromJson, toJson } from '../../db/db';
import { isAppError } from '../../lib/errors';
import type { Clock } from '../../lib/time';

export interface SyncTx {
  db: Db;
  now: number;
  deviceId: string;
  /** record a change for pull (call for every entity row you write, including conflict copies) */
  touch(entityType: string, entityId: string): void;
}

export interface SyncApplyResult {
  result: Exclude<SyncResult, 'duplicate'> | 'duplicate';
  /** serialized entity as stored now (optional; pull uses serialize()) */
  entity?: unknown;
  /** Arabic, human-readable detail (e.g. why rejected / where the kept copy went) */
  detail?: string;
}

export interface SyncEntityHandler {
  /** Apply one op synchronously inside the engine's transaction. Throw AppError to reject. */
  apply(op: SyncOp, tx: SyncTx): SyncApplyResult;
  /** Current server representation (null when deleted/absent). */
  serialize(id: string): unknown | null;
}

interface SyncOperationRow {
  op_id: string;
  entity_type: string;
  entity_id: string;
  result: SyncResult;
  result_detail: string | null;
  server_seq: number;
}

export const MAX_PUSH_OPS = 500;
export const MAX_PULL_LIMIT = 1000;

export class SyncRegistry {
  private readonly handlers = new Map<string, SyncEntityHandler>();
  private readonly listeners: Array<(types: string[]) => void> = [];

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly log: FastifyBaseLogger,
  ) {}

  registerEntity(entityType: string, handler: SyncEntityHandler): void {
    if (!/^[a-z][a-z0-9_]{1,63}$/.test(entityType)) throw new Error(`Invalid sync entity type: ${entityType}`);
    if (this.handlers.has(entityType)) throw new Error(`Sync entity already registered: ${entityType}`);
    this.handlers.set(entityType, handler);
    const types = this.registeredTypes();
    for (const fn of this.listeners) fn(types);
  }

  /** Called after every registerEntity (e.g. to keep the `sync` capability honest). */
  onRegister(fn: (types: string[]) => void): void {
    this.listeners.push(fn);
  }

  registeredTypes(): string[] {
    return [...this.handlers.keys()].sort();
  }

  /** Append to the change feed. Keeps one row per entity (its latest seq). Call inside the writer's tx. */
  touch(entityType: string, entityId: string): number {
    // atomic even if a caller forgets its own transaction (nested → SAVEPOINT): never DELETE without INSERT
    return this.db.tx(() => {
      this.db.run('DELETE FROM sync_change WHERE entity_type = ? AND entity_id = ?', [entityType, entityId]);
      const r = this.db.run('INSERT INTO sync_change (entity_type, entity_id, changed_at) VALUES (?, ?, ?)', [
        entityType,
        entityId,
        this.clock.now(),
      ]);
      return Number(r.lastInsertRowid);
    });
  }

  headSeq(): number {
    // sqlite_sequence keeps the AUTOINCREMENT high-water mark even after rows are deleted
    const r = this.db.get<{ seq: number }>("SELECT seq FROM sqlite_sequence WHERE name = 'sync_change'");
    return r?.seq ?? 0;
  }

  push(ops: SyncOp[]): SyncPushResponse {
    const results: SyncOpResult[] = [];
    for (const op of ops) results.push(this.applyOne(op));
    return { results, server_seq: this.headSeq() };
  }

  private applyOne(op: SyncOp): SyncOpResult {
    const seen = this.db.get<SyncOperationRow>('SELECT * FROM sync_operation WHERE op_id = ?', [op.op_id]);
    if (seen) return this.duplicateOf(op, seen);

    const handler = this.handlers.get(op.entity_type);
    if (!handler) {
      // not recorded: a newer server version may support it, so the client keeps the op and retries later
      return { op_id: op.op_id, result: 'rejected', detail: 'نوع البيانات غير مدعوم للمزامنة في هذا الإصدار من الخادم.', retryable: true };
    }

    try {
      return this.db.tx(() => {
        // re-check inside the write lock (two concurrent pushes of the same op)
        const again = this.db.get<SyncOperationRow>('SELECT * FROM sync_operation WHERE op_id = ?', [op.op_id]);
        if (again) return this.duplicateOf(op, again);
        const now = this.clock.now();
        const tx: SyncTx = { db: this.db, now, deviceId: op.device_id, touch: (t, id) => void this.touch(t, id) };
        let applied: SyncApplyResult;
        try {
          applied = handler.apply(op, tx);
        } catch (e) {
          if (!isAppError(e)) throw e;
          applied = { result: 'rejected', detail: e.messageAr };
        }
        this.db.run(
          `INSERT INTO sync_operation (op_id, device_id, entity_type, entity_id, op, base_rev, payload_json, result, result_detail, client_ts, server_seq, received_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            op.op_id,
            op.device_id,
            op.entity_type,
            op.entity_id,
            op.op,
            op.base_rev ?? null,
            toJson(op.payload ?? null),
            applied.result,
            applied.detail ?? null,
            op.client_ts ?? null,
            this.headSeq(),
            now,
          ],
        );
        const out: SyncOpResult = { op_id: op.op_id, result: applied.result };
        if (applied.entity !== undefined) out.entity = applied.entity;
        if (applied.detail) out.detail = applied.detail;
        return out;
      });
    } catch (e) {
      // unexpected failure: rolled back and NOT recorded → the client keeps the op and retries
      this.log.error({ err: e, entityType: op.entity_type }, 'sync op failed');
      return { op_id: op.op_id, result: 'rejected', detail: 'تعذر حفظ التغيير على الخادم مؤقتًا؛ ستُعاد المحاولة تلقائيًا.', retryable: true };
    }
  }

  private duplicateOf(op: SyncOp, row: SyncOperationRow): SyncOpResult {
    const out: SyncOpResult = { op_id: op.op_id, result: 'duplicate', original_result: row.result };
    if (row.result_detail) out.detail = row.result_detail;
    const handler = this.handlers.get(row.entity_type);
    if (handler) {
      const entity = handler.serialize(row.entity_id);
      if (entity !== null && entity !== undefined) out.entity = entity;
    }
    return out;
  }

  pull(since: number, limit = 200): SyncPullResponse {
    const lim = Math.min(Math.max(1, Math.floor(limit)), MAX_PULL_LIMIT);
    const rows = this.db.all<{ seq: number; entity_type: string; entity_id: string }>(
      'SELECT seq, entity_type, entity_id FROM sync_change WHERE seq > ? ORDER BY seq LIMIT ?',
      [since, lim + 1],
    );
    const page = rows.slice(0, lim);
    const changes: SyncChange[] = page.map((r) => {
      const handler = this.handlers.get(r.entity_type);
      return { seq: r.seq, entity_type: r.entity_type, entity_id: r.entity_id, entity: handler ? (handler.serialize(r.entity_id) ?? null) : null };
    });
    const last = page[page.length - 1];
    return { changes, next_since: last ? last.seq : since, has_more: rows.length > lim };
  }

  /** what happened to an op (for diagnostics / tests) */
  operation(opId: string): (SyncOperationRow & { payload: unknown }) | null {
    const r = this.db.get<SyncOperationRow & { payload_json: string }>('SELECT * FROM sync_operation WHERE op_id = ?', [opId]);
    if (!r) return null;
    const { payload_json, ...rest } = r;
    return { ...rest, payload: fromJson(payload_json) };
  }
}
