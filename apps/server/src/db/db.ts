// Thin wrapper over node:sqlite (DatabaseSync). Swapping the driver (e.g. better-sqlite3) is a
// one-file change. All access is synchronous; transactions MUST be synchronous callbacks so that no
// other request's statements can interleave inside BEGIN … COMMIT on the shared connection.
import { chmodSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';

export type SqlParams = readonly unknown[] | Readonly<Record<string, unknown>>;

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface Db {
  readonly raw: DatabaseSync;
  readonly path: string;
  get<T = Record<string, unknown>>(sql: string, params?: SqlParams): T | undefined;
  all<T = Record<string, unknown>>(sql: string, params?: SqlParams): T[];
  run(sql: string, params?: SqlParams): RunResult;
  /** execute one or more statements without parameters (migrations, DDL) */
  exec(sql: string): void;
  /** BEGIN IMMEDIATE … COMMIT; nested calls use SAVEPOINTs. `fn` must be synchronous. */
  tx<T>(fn: () => T): T;
  readonly inTransaction: boolean;
  close(): void;
  readonly isOpen: boolean;
}

const STATEMENT_CACHE_MAX = 512;

function normalizeValue(v: unknown): SQLInputValue {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'bigint') return v;
  if (v instanceof Date) return v.getTime();
  if (ArrayBuffer.isView(v)) return v as NodeJS.ArrayBufferView;
  throw new TypeError(`Unsupported SQL parameter type: ${typeof v} (serialize objects with toJson)`);
}

function isThenable(v: unknown): v is PromiseLike<unknown> {
  return typeof v === 'object' && v !== null && typeof (v as { then?: unknown }).then === 'function';
}

function plain<T>(row: unknown): T {
  // node:sqlite returns null-prototype objects; convert to ordinary objects for predictable behavior.
  return row === undefined ? (undefined as T) : ({ ...(row as object) } as T);
}

export interface OpenDbOptions {
  readOnly?: boolean;
}

export function openDb(path: string, opts: OpenDbOptions = {}): Db {
  const raw = new DatabaseSync(path, { readOnly: opts.readOnly ?? false });
  if (!opts.readOnly && path !== ':memory:' && process.platform !== 'win32') {
    try {
      chmodSync(path, 0o600); // private study data; WAL/SHM files inherit the database file's mode
    } catch {
      // best effort (e.g. read-only filesystem)
    }
  }
  if (!opts.readOnly && path !== ':memory:') raw.exec('PRAGMA journal_mode = WAL;');
  raw.exec('PRAGMA foreign_keys = ON;');
  raw.exec('PRAGMA busy_timeout = 5000;');
  raw.exec('PRAGMA synchronous = NORMAL;');

  const cache = new Map<string, StatementSync>();
  let depth = 0;
  let savepointSeq = 0;
  let open = true;

  function stmt(sql: string): StatementSync {
    let s = cache.get(sql);
    if (s) {
      // refresh LRU position
      cache.delete(sql);
      cache.set(sql, s);
      return s;
    }
    s = raw.prepare(sql);
    cache.set(sql, s);
    if (cache.size > STATEMENT_CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    return s;
  }

  function bind(params: SqlParams | undefined): { named?: Record<string, SQLInputValue>; positional: SQLInputValue[] } {
    if (params === undefined) return { positional: [] };
    if (Array.isArray(params)) return { positional: (params as unknown[]).map(normalizeValue) };
    const named: Record<string, SQLInputValue> = {};
    for (const [k, v] of Object.entries(params as Record<string, unknown>)) named[k] = normalizeValue(v);
    return { named, positional: [] };
  }

  const db: Db = {
    raw,
    path,
    get<T>(sql: string, params?: SqlParams): T | undefined {
      const b = bind(params);
      const s = stmt(sql);
      return plain<T>(b.named ? s.get(b.named) : s.get(...b.positional));
    },
    all<T>(sql: string, params?: SqlParams): T[] {
      const b = bind(params);
      const s = stmt(sql);
      const rows = b.named ? s.all(b.named) : s.all(...b.positional);
      return rows.map((r) => plain<T>(r));
    },
    run(sql: string, params?: SqlParams): RunResult {
      const b = bind(params);
      const s = stmt(sql);
      const r = b.named ? s.run(b.named) : s.run(...b.positional);
      return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
    },
    exec(sql: string): void {
      raw.exec(sql);
    },
    tx<T>(fn: () => T): T {
      const outer = depth === 0;
      const sp = outer ? '' : `sp_${++savepointSeq}`;
      raw.exec(outer ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
      depth++;
      try {
        const result = fn();
        if (isThenable(result)) {
          throw new Error('Db.tx callback must be synchronous (do not await inside a transaction)');
        }
        depth--;
        raw.exec(outer ? 'COMMIT' : `RELEASE ${sp}`);
        return result;
      } catch (err) {
        depth--;
        try {
          if (outer) raw.exec('ROLLBACK');
          else raw.exec(`ROLLBACK TO ${sp}; RELEASE ${sp}`);
        } catch {
          // the transaction may already have been rolled back by SQLite (e.g. SQLITE_FULL)
        }
        throw err;
      }
    },
    get inTransaction() {
      return depth > 0;
    },
    get isOpen() {
      return open;
    },
    close() {
      if (!open) return;
      open = false;
      cache.clear();
      raw.close();
    },
  };
  return db;
}

/** Serialize a value for a *_json column. `undefined` → NULL. */
export function toJson(value: unknown): string | null {
  if (value === undefined) return null;
  return JSON.stringify(value);
}

/** Parse a *_json column. NULL/invalid → fallback (default null). */
export function fromJson<T>(text: string | null | undefined, fallback: T | null = null): T | null {
  if (text === null || text === undefined || text === '') return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
