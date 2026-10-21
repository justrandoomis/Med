// The database pool (ADR-0003 §3.2, ARCHITECTURE_DELTA §1; P1-T1 step 1): one LRU of open vault and space
// connections, each WAL-mode, opened through the unchanged migration runner (pending base migrations run on open; the
// «already migrated?» check is cheap). Measured in the design spike S2: a hit ≈ 0.24 ms p50, a miss ≈ 28 ms p50 with
// eviction, ≈ 1 MB RSS and 3–5 file descriptors per open database. The pool size is a config value
// (MEDLEVO_DB_POOL_SIZE, default 500) checked at boot against the process's real open-file limit.
//
// Safety rules:
//   * a database file opens only through its registry row (system DB); a missing file is an error, never a fresh
//     empty database (openDb would silently create one);
//   * a connection that is leased (a request or job is using it) or inside a transaction is never evicted — the
//     pool runs over its size for a moment instead;
//   * a binding resolves its database by id, so a handle the pool closed is simply re-opened on next use.
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { type Db, openDb } from '../db/db';
import { migrate, migrationsFingerprint, type MigrationSet } from '../db/migrate';

export type PooledKind = 'vault' | 'space';

export const DB_FILE_RE = /^[A-Za-z0-9_-]{1,80}\.sqlite$/;

/** File descriptors one open WAL database holds (db, -wal, -shm) plus a margin for transient journal files. */
export const FDS_PER_DATABASE = 4;
/** File descriptors kept free for sockets, uploads, blobs, the system DB and child processes. */
export const FD_RESERVE = 256;

export interface PoolResolver {
  /** db_file (relative to its directory) of a registered, usable database; null when not registered */
  fileOf(kind: PooledKind, id: string): string | null;
}

export interface PoolOptions {
  vaultsDir: string;
  spacesDir: string;
  /** where the migrated vault template is kept (DATA_DIR/tmp in production; a per-process dir in tests) */
  templateDir: string;
  maxOpen: number;
  resolver: PoolResolver;
  now: () => number;
  /** warnings (pool size clamped, …) */
  warn?: (msg: string, data?: Record<string, unknown>) => void;
  /** test hook: override the detected open-file limit */
  openFileLimit?: number | null;
}

interface Entry {
  db: Db;
  leases: number;
}

export interface PoolStats {
  open: number;
  max: number;
  hits: number;
  misses: number;
  evictions: number;
  /** the soft RLIMIT_NOFILE seen at boot (null when unknown) */
  fdLimit: number | null;
}

/** Soft open-file limit of this process (Linux /proc), or null when it cannot be read. */
export function readOpenFileLimit(): number | null {
  try {
    const text = readFileSync('/proc/self/limits', 'utf8');
    const line = text.split('\n').find((l) => l.startsWith('Max open files'));
    if (!line) return null;
    const soft = line.slice('Max open files'.length).trim().split(/\s+/)[0];
    if (!soft || soft === 'unlimited') return null;
    const n = Number(soft);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** The pool size actually used: the configured one, lowered when the open-file limit cannot hold it. */
export function effectivePoolSize(configured: number, fdLimit: number | null): number {
  if (fdLimit === null) return configured;
  const fit = Math.floor((fdLimit - FD_RESERVE) / FDS_PER_DATABASE);
  return Math.max(4, Math.min(configured, fit));
}

const templates = new Map<string, string>();

function fsyncFile(path: string): void {
  try {
    const fd = openSync(path, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // best effort
  }
}

/** Work a module needs once per database when it is opened (data repairs that used to run at boot). */
export type OpenHook = (kind: PooledKind, id: string) => void;

export class DatabasePool {
  private readonly entries = new Map<string, Entry>();
  private readonly openHooks: { kind: PooledKind; name: string; fn: OpenHook }[] = [];
  /** databases whose open hooks already ran in this process (re-opening after an eviction does not repeat them) */
  private readonly hooked = new Set<string>();
  /** set by the context: runs a hook bound to the database being opened */
  runBound: (kind: PooledKind, id: string, fn: () => void) => void = (_k, _i, fn) => fn();
  private readonly maxOpen: number;
  private readonly fdLimit: number | null;
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private closed = false;

  constructor(private readonly opts: PoolOptions) {
    mkdirSync(opts.vaultsDir, { recursive: true, mode: 0o700 });
    mkdirSync(opts.spacesDir, { recursive: true, mode: 0o700 });
    this.fdLimit = opts.openFileLimit === undefined ? readOpenFileLimit() : opts.openFileLimit;
    this.maxOpen = effectivePoolSize(opts.maxOpen, this.fdLimit);
    if (this.maxOpen < opts.maxOpen) {
      opts.warn?.('database pool size lowered to fit the open-file limit', { configured: opts.maxOpen, used: this.maxOpen, fdLimit: this.fdLimit });
    }
  }

  private key(kind: PooledKind, id: string): string {
    return `${kind}:${id}`;
  }

  private dirOf(kind: PooledKind): string {
    return kind === 'vault' ? this.opts.vaultsDir : this.opts.spacesDir;
  }

  private setsOf(kind: PooledKind): MigrationSet[] {
    return kind === 'vault' ? ['base'] : ['base', 'space'];
  }

  /** Absolute path of a database file name inside its directory (validated). */
  pathOfFile(kind: PooledKind, file: string): string {
    if (!DB_FILE_RE.test(file)) throw new Error(`invalid ${kind} db_file`);
    return join(this.dirOf(kind), file);
  }

  /** Absolute path of a registered database file (validated name; never outside its directory). */
  pathOf(kind: PooledKind, id: string): string {
    const file = this.opts.resolver.fileOf(kind, id);
    if (file === null) throw new Error(`${kind} ${id} is not registered`);
    if (!DB_FILE_RE.test(file)) throw new Error(`${kind} ${id} has an invalid db_file`);
    return join(this.dirOf(kind), file);
  }

  /** The open connection of a registered vault or space (opened, migrated and pooled on a miss). */
  get(kind: PooledKind, id: string): Db {
    if (this.closed) throw new Error('database pool is closed');
    const k = this.key(kind, id);
    const hit = this.entries.get(k);
    if (hit && hit.db.isOpen) {
      this.hits++;
      // LRU: most recently used at the end
      this.entries.delete(k);
      this.entries.set(k, hit);
      return hit.db;
    }
    this.misses++;
    const path = this.pathOf(kind, id);
    if (!existsSync(path)) throw new Error(`${kind} ${id}: database file is missing (refusing to create an empty one)`);
    const db = openDb(path);
    try {
      migrate(db, { sets: this.setsOf(kind), now: this.opts.now });
    } catch (e) {
      db.close();
      throw e;
    }
    this.entries.delete(k);
    this.entries.set(k, { db, leases: hit?.leases ?? 0 });
    this.runOpenHooks(kind, id);
    this.evict(k); // never the connection being handed out (all older ones may be leased)
    return db;
  }

  /**
   * Register per-database work that runs the first time a database of `kind` is opened in this process, bound to that
   * database. It replaces boot-time data repairs and «interrupted by a restart» marks: with one database per user there
   * is no single database at boot. Hooks must be idempotent; a failing hook is logged and never blocks the open.
   */
  onOpen(kind: PooledKind, name: string, fn: OpenHook): void {
    if (this.openHooks.some((h) => h.name === name)) throw new Error(`open hook already registered: ${name}`);
    this.openHooks.push({ kind, name, fn });
  }

  private runOpenHooks(kind: PooledKind, id: string): void {
    const k = this.key(kind, id);
    if (this.hooked.has(k)) return;
    this.hooked.add(k);
    for (const h of this.openHooks) {
      if (h.kind !== kind) continue;
      try {
        this.runBound(kind, id, () => h.fn(kind, id));
      } catch (e) {
        this.opts.warn?.('database open hook failed', { hook: h.name, kind, id, error: (e as Error).message });
      }
    }
  }

  /** Mark a database as in use (a request or a job); a leased database is never evicted. */
  acquire(kind: PooledKind, id: string): () => void {
    const k = this.key(kind, id);
    this.get(kind, id);
    const e = this.entries.get(k)!;
    e.leases++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const cur = this.entries.get(k);
      if (cur) cur.leases = Math.max(0, cur.leases - 1);
      this.evict();
    };
  }

  private evict(keep: string | null = null): void {
    if (this.entries.size <= this.maxOpen) return;
    for (const [k, e] of this.entries) {
      if (this.entries.size <= this.maxOpen) break;
      if (k === keep || e.leases > 0 || (e.db.isOpen && e.db.inTransaction)) continue;
      this.entries.delete(k);
      if (e.db.isOpen) e.db.close();
      this.evictions++;
    }
  }

  /** Close one database (e.g. before its file is replaced). Refused while leased or inside a transaction. */
  close(kind: PooledKind, id: string): boolean {
    const k = this.key(kind, id);
    const e = this.entries.get(k);
    if (!e) return true;
    if (e.leases > 0 || (e.db.isOpen && e.db.inTransaction)) return false;
    this.entries.delete(k);
    if (e.db.isOpen) e.db.close();
    return true;
  }

  closeAll(): void {
    this.closed = true;
    for (const e of this.entries.values()) if (e.db.isOpen) e.db.close();
    this.entries.clear();
  }

  isOpen(kind: PooledKind, id: string): boolean {
    return this.entries.get(this.key(kind, id))?.db.isOpen ?? false;
  }

  stats(): PoolStats {
    return { open: this.entries.size, max: this.maxOpen, hits: this.hits, misses: this.misses, evictions: this.evictions, fdLimit: this.fdLimit };
  }

  // ───────── new databases ─────────

  /** A migrated, empty database file to copy (8.9 ms per vault instead of ≈ 0.4 s of migrations, spike S2). */
  private template(kind: PooledKind): string {
    const sets = this.setsOf(kind);
    const fp = migrationsFingerprint(sets).slice(0, 16);
    const path = join(this.opts.templateDir, `${kind}-template-${fp}.sqlite`);
    if (templates.get(path) === path && existsSync(path)) return path;
    mkdirSync(this.opts.templateDir, { recursive: true, mode: 0o700 });
    if (!existsSync(path)) {
      const work = `${path}.${randomBytes(4).toString('hex')}.build`;
      const db = openDb(work);
      try {
        migrate(db, { sets, now: this.opts.now });
        const out = `${path}.${randomBytes(4).toString('hex')}.tmp`;
        db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
        fsyncFile(out);
        renameSync(out, path);
      } finally {
        db.close();
        for (const suffix of ['', '-wal', '-shm']) rmSync(`${work}${suffix}`, { force: true });
      }
    }
    templates.set(path, path);
    return path;
  }

  /**
   * Create the file of a NEW vault or space (`<id>.sqlite`) from the template, atomically (copy → fsync → rename).
   * Returns the db_file to register. The fresh database gets its own sync epoch (the template's would be shared).
   */
  createFile(kind: PooledKind, id: string): string {
    const file = `${id}.sqlite`;
    if (!DB_FILE_RE.test(file)) throw new Error(`invalid ${kind} id`);
    const final = join(this.dirOf(kind), file);
    if (existsSync(final)) throw new Error(`${kind} ${id}: a database file already exists (refusing to overwrite)`);
    const tmp = `${final}.${randomBytes(4).toString('hex')}.tmp`;
    copyFileSync(this.template(kind), tmp);
    try {
      const db = openDb(tmp);
      try {
        const now = this.opts.now();
        db.run(
          `UPDATE data_server_epoch SET id = lower(hex(randomblob(16))), started_at = ?, created_at = ?
           WHERE is_current = 1 AND reason = 'initial'`,
          [now, now],
        );
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } finally {
        db.close();
      }
      for (const suffix of ['-wal', '-shm']) rmSync(`${tmp}${suffix}`, { force: true });
      fsyncFile(tmp);
      renameSync(tmp, final);
      fsyncFile(this.dirOf(kind));
    } catch (e) {
      for (const suffix of ['', '-wal', '-shm']) rmSync(`${tmp}${suffix}`, { force: true });
      throw e;
    }
    return file;
  }
}
