import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Db, fromJson, openDb, toJson } from '../src/db/db';
import { migrate, MigrationError, MIGRATIONS_DIR } from '../src/db/migrate';
import { sha256 } from '../src/lib/hash';

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'medlevo-mig-'));
  db = openDb(join(dir, 'test.sqlite'));
});
afterEach(() => {
  if (db.isOpen) db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('migration runner', () => {
  it('applies the core schema on a fresh database, including FTS5 tables and triggers', () => {
    const res = migrate(db);
    expect(res.applied).toContain('0001_core.sql');

    const row = db.get<{ name: string; checksum: string; applied_at: number }>('SELECT * FROM schema_migration WHERE name = ?', ['0001_core.sql']);
    const expected = sha256(readFileSync(join(MIGRATIONS_DIR, '0001_core.sql'), 'utf8').replace(/\r\n/g, '\n'));
    expect(row?.checksum).toBe(expected);

    const names = db.all<{ name: string; type: string }>("SELECT name, type FROM sqlite_master WHERE type IN ('table','trigger')").map((r) => r.name);
    for (const t of ['owner', 'auth_session', 'processing_job', 'job_checkpoint', 'sync_operation', 'sync_change', 'usage_record', 'chunk_fts', 'owner_content_fts']) {
      expect(names).toContain(t);
    }
    expect(names).toEqual(expect.arrayContaining(['chunk_fts_ai', 'chunk_fts_ad', 'chunk_fts_au']));

    // the whole file ran: inserting a chunk fires the FTS trigger and MATCH finds it
    const now = 1;
    db.run(`INSERT INTO source (id, title, source_type, created_at, updated_at) VALUES ('s1', 'TEST FIXTURE', 'lecture', ?, ?)`, [now, now]);
    db.run(
      `INSERT INTO source_version (id, source_id, version_no, kind, content_hash, mime, format, created_at)
       VALUES ('v1', 's1', 1, 'original', 'h', 'application/pdf', 'pdf', ?)`,
      [now],
    );
    db.run(
      `INSERT INTO document_chunk (id, version_id, source_id, kind, text, region_ids_json, page_ids_json, index_version, created_at)
       VALUES ('c1', 'v1', 's1', 'text', 'synthetic hepatocyte fixture text', '[]', '[]', 'idx1', ?)`,
      [now],
    );
    const hit = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM chunk_fts WHERE chunk_fts MATCH 'hepatocyte'`);
    expect(hit?.n).toBe(1);
    expect(db.get<{ foreign_keys: number }>('PRAGMA foreign_keys')?.foreign_keys).toBe(1);
    expect(db.get<{ journal_mode: string }>('PRAGMA journal_mode')?.journal_mode).toBe('wal');
  });

  it('is a no-op when re-run', () => {
    migrate(db);
    const count = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM schema_migration')?.n;
    const again = migrate(db);
    expect(again.applied).toEqual([]);
    expect(again.alreadyApplied).toContain('0001_core.sql');
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM schema_migration')?.n).toBe(count);
  });

  it('refuses to run when an applied migration was edited (checksum mismatch)', () => {
    const migDir = join(dir, 'migrations');
    mkdirSync(migDir);
    copyFileSync(join(MIGRATIONS_DIR, '0001_core.sql'), join(migDir, '0001_core.sql'));
    migrate(db, { dir: migDir });
    writeFileSync(join(migDir, '0001_core.sql'), readFileSync(join(migDir, '0001_core.sql'), 'utf8') + '\n-- edited\n');
    expect(() => migrate(db, { dir: migDir })).toThrow(MigrationError);
    expect(() => migrate(db, { dir: migDir })).toThrow(/Checksum mismatch/);
  });

  it('rolls back a failing migration completely and does not record it', () => {
    const migDir = join(dir, 'm2');
    mkdirSync(migDir);
    writeFileSync(join(migDir, '0001_a.sql'), 'CREATE TABLE a (id TEXT PRIMARY KEY) STRICT;');
    writeFileSync(join(migDir, '0002_bad.sql'), 'CREATE TABLE b (id TEXT PRIMARY KEY) STRICT;\nTHIS IS NOT SQL;');
    expect(() => migrate(db, { dir: migDir })).toThrow(/0002_bad.sql failed/);
    const tables = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name);
    expect(tables).toContain('a');
    expect(tables).not.toContain('b');
    expect(db.all('SELECT name FROM schema_migration').map((r) => (r as { name: string }).name)).toEqual(['0001_a.sql']);
  });

  it('rejects a database that has migrations unknown to this build, and invalid file names', () => {
    const migDir = join(dir, 'm3');
    mkdirSync(migDir);
    writeFileSync(join(migDir, '0001_a.sql'), 'CREATE TABLE a (id TEXT) STRICT;');
    migrate(db, { dir: migDir });
    db.run("INSERT INTO schema_migration (name, checksum, applied_at) VALUES ('0099_future.sql', 'x', 1)");
    expect(() => migrate(db, { dir: migDir })).toThrow(/not present in this build/);

    const badDir = join(dir, 'm4');
    mkdirSync(badDir);
    writeFileSync(join(badDir, 'core.sql'), 'SELECT 1;');
    expect(() => migrate(openDb(':memory:'), { dir: badDir })).toThrow(/Invalid migration file name/);
  });
});

describe('Db wrapper', () => {
  beforeEach(() => {
    db.exec('CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER, flag INTEGER, data TEXT) STRICT');
  });

  it('supports positional and named params, booleans and JSON helpers', () => {
    db.run('INSERT INTO t (id, n, flag, data) VALUES (?, ?, ?, ?)', ['a', 1, true, toJson({ x: [1, 2] })]);
    db.run('INSERT INTO t (id, n, flag, data) VALUES ($id, $n, $flag, $data)', { id: 'b', n: 2, flag: false, data: undefined });
    const a = db.get<{ id: string; flag: number; data: string }>('SELECT * FROM t WHERE id = ?', ['a']);
    expect(a?.flag).toBe(1);
    expect(fromJson<{ x: number[] }>(a?.data)).toEqual({ x: [1, 2] });
    const b = db.get<{ flag: number; data: string | null }>('SELECT * FROM t WHERE id = $id', { id: 'b' });
    expect(b).toEqual({ id: 'b', n: 2, flag: 0, data: null });
    expect(Object.getPrototypeOf(b)).toBe(Object.prototype);
    expect(fromJson('not json', 'fallback')).toBe('fallback');
    expect(db.all('SELECT * FROM t').length).toBe(2);
  });

  it('commits/rolls back transactions and uses savepoints when nested', () => {
    db.tx(() => {
      db.run("INSERT INTO t (id, n) VALUES ('x', 1)");
      expect(() =>
        db.tx(() => {
          db.run("INSERT INTO t (id, n) VALUES ('y', 2)");
          throw new Error('inner failure');
        }),
      ).toThrow('inner failure');
      expect(db.inTransaction).toBe(true);
    });
    expect(db.all<{ id: string }>('SELECT id FROM t').map((r) => r.id)).toEqual(['x']);

    expect(() =>
      db.tx(() => {
        db.run("INSERT INTO t (id, n) VALUES ('z', 3)");
        throw new Error('outer failure');
      }),
    ).toThrow('outer failure');
    expect(db.get("SELECT id FROM t WHERE id = 'z'")).toBeUndefined();
    expect(db.inTransaction).toBe(false);
  });

  it('refuses async transaction callbacks (no interleaving inside BEGIN … COMMIT)', () => {
    expect(() => db.tx((async () => db.run("INSERT INTO t (id) VALUES ('q')")) as unknown as () => void)).toThrow(/synchronous/);
    expect(db.get("SELECT id FROM t WHERE id = 'q'")).toBeUndefined();
  });

  it('rejects unsupported parameter types', () => {
    expect(() => db.run('INSERT INTO t (id, data) VALUES (?, ?)', ['k', { obj: 1 }])).toThrow(/toJson/);
  });
});
