// Migration runner: applies db/migrations/NNNN_name.sql in filename order, each inside its own
// transaction (BEGIN IMMEDIATE), and records (name, sha256 checksum, applied_at) in schema_migration.
// Re-running is a no-op. Editing an already-applied migration is a hard error (never edit; add a new file).
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../lib/hash';
import type { Db } from './db';

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
const NAME_RE = /^(\d{4})_[a-z0-9_]+\.sql$/;

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

export function readMigrations(dir = MIGRATIONS_DIR): MigrationFile[] {
  const names = readdirSync(dir).filter((n) => n.endsWith('.sql'));
  for (const n of names) {
    if (!NAME_RE.test(n)) throw new MigrationError(`Invalid migration file name: ${n} (expected NNNN_snake_case.sql)`);
  }
  names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const seen = new Set<string>();
  return names.map((name) => {
    const prefix = name.slice(0, 4);
    if (seen.has(prefix)) throw new MigrationError(`Duplicate migration number ${prefix}`);
    seen.add(prefix);
    // normalize line endings so a CRLF checkout does not look like an edited migration
    const sql = readFileSync(join(dir, name), 'utf8').replace(/\r\n/g, '\n');
    return { name, sql, checksum: sha256(sql) };
  });
}

export interface MigrateResult {
  applied: string[];
  alreadyApplied: string[];
}

export function migrate(db: Db, opts: { dir?: string; now?: () => number } = {}): MigrateResult {
  const now = opts.now ?? Date.now;
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migration (
    name TEXT PRIMARY KEY,
    checksum TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  ) STRICT;`);

  const files = readMigrations(opts.dir);
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
