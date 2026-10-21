// Migration runner: applies NNNN_name.sql files in filename order, each inside its own transaction (BEGIN IMMEDIATE),
// and records (name, sha256 checksum, applied_at) in the database's own schema_migration table. Re-running is a no-op.
// Editing an already-applied migration is a hard error (never edit; add a new file).
//
// Three sets (ARCHITECTURE_DELTA §3.1, P1-T1 step 1), each in its own directory and number band:
//   base   — db/migrations/          0001–1999  every vault AND every space (today's schema + additive base files)
//   system — db/migrations-system/   2000–2999  DATA_DIR/system.sqlite only
//   space  — db/migrations-space/    3000–3999  every space, after the base set
// The «unknown migration» check runs against the union of the requested sets, so a system file is never opened as a
// vault (or the other way round) and an older build refuses a newer database of any kind.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../lib/hash';
import type { Db } from './db';

const HERE = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(HERE, 'migrations');
export const SYSTEM_MIGRATIONS_DIR = join(HERE, 'migrations-system');
export const SPACE_MIGRATIONS_DIR = join(HERE, 'migrations-space');
const NAME_RE = /^(\d{4})_[a-z0-9_]+\.sql$/;

export type MigrationSet = 'base' | 'system' | 'space';

const SETS: Record<MigrationSet, { dir: string; min: number; max: number }> = {
  base: { dir: MIGRATIONS_DIR, min: 1, max: 1999 },
  system: { dir: SYSTEM_MIGRATIONS_DIR, min: 2000, max: 2999 },
  space: { dir: SPACE_MIGRATIONS_DIR, min: 3000, max: 3999 },
};

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

export interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

/** The shipped sets never change while the process runs: read each once (opening a vault must stay cheap). */
const shippedCache = new Map<MigrationSet, MigrationFile[]>();

/**
 * Read and validate the migration files of a directory. With `set`, every number must lie inside that set's band.
 * The shipped directories are cached; any other directory (tests) is read fresh every time.
 */
export function readMigrations(dir = MIGRATIONS_DIR, set?: MigrationSet): MigrationFile[] {
  const shipped = set !== undefined && SETS[set].dir === dir ? set : undefined;
  if (shipped && shippedCache.has(shipped)) return shippedCache.get(shipped)!;
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.sql'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT' && dir !== MIGRATIONS_DIR) names = [];
    else throw e;
  }
  for (const n of names) {
    if (!NAME_RE.test(n)) throw new MigrationError(`Invalid migration file name: ${n} (expected NNNN_snake_case.sql)`);
    if (set !== undefined) {
      const num = Number(n.slice(0, 4));
      if (num < SETS[set].min || num > SETS[set].max) {
        throw new MigrationError(`Migration ${n} is outside the ${set} band ${SETS[set].min}–${SETS[set].max}`);
      }
    }
  }
  names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const seen = new Set<string>();
  const files = names.map((name) => {
    const prefix = name.slice(0, 4);
    if (seen.has(prefix)) throw new MigrationError(`Duplicate migration number ${prefix}`);
    seen.add(prefix);
    // normalize line endings so a CRLF checkout does not look like an edited migration
    const sql = readFileSync(join(dir, name), 'utf8').replace(/\r\n/g, '\n');
    return { name, sql, checksum: sha256(sql) };
  });
  if (shipped) shippedCache.set(shipped, files);
  return files;
}

export interface MigrateResult {
  applied: string[];
  alreadyApplied: string[];
}

export interface MigrateOptions {
  /** a single custom directory (tests); overrides `sets` */
  dir?: string;
  /** which shipped sets to apply, in order (default ['base']) */
  sets?: MigrationSet[];
  now?: () => number;
}

export function migrate(db: Db, opts: MigrateOptions = {}): MigrateResult {
  const now = opts.now ?? Date.now;
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migration (
    name TEXT PRIMARY KEY,
    checksum TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  ) STRICT;`);

  const files: MigrationFile[] = opts.dir !== undefined ? readMigrations(opts.dir) : (opts.sets ?? ['base']).flatMap((s) => readMigrations(SETS[s].dir, s));
  const applied = new Map(
    db.all<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migration').map((r) => [r.name, r.checksum]),
  );

  const fileNames = new Set(files.map((f) => f.name));
  for (const name of applied.keys()) {
    if (!fileNames.has(name)) {
      throw new MigrationError(
        `Database has migration ${name} which is not present in this build. Refusing to run older code against a newer database.`,
      );
    }
  }

  const result: MigrateResult = { applied: [], alreadyApplied: [] };
  for (const f of files) {
    const existing = applied.get(f.name);
    if (existing !== undefined) {
      if (existing !== f.checksum) {
        throw new MigrationError(
          `Checksum mismatch for applied migration ${f.name}. Applied migrations must never be edited — add a new migration instead.`,
        );
      }
      result.alreadyApplied.push(f.name);
      continue;
    }
    try {
      db.tx(() => {
        db.exec(f.sql);
        db.run('INSERT INTO schema_migration (name, checksum, applied_at) VALUES (?, ?, ?)', [f.name, f.checksum, now()]);
      });
    } catch (e) {
      throw new MigrationError(`Migration ${f.name} failed: ${(e as Error).message}`);
    }
    result.applied.push(f.name);
  }
  // PRAGMA foreign_keys is a no-op inside a transaction; make sure it is on for the connection.
  db.exec('PRAGMA foreign_keys = ON;');
  return result;
}

/** Combined checksum of the shipped files of the given sets (the vault template is keyed by it). */
export function migrationsFingerprint(sets: MigrationSet[] = ['base']): string {
  return sha256(sets.flatMap((s) => readMigrations(SETS[s].dir, s).map((f) => `${f.name}:${f.checksum}`)).join('\n'));
}
