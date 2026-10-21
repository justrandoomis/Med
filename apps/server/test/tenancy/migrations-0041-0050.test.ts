// P1-T1 step 0 — base migrations 0041 (sync actor + visibility key) and 0050 (change_log actor), ARCHITECTURE_DELTA §4.2.
// They ship in release R1-a inside today's single-owner database, so they must be safe on the owner's EXISTING database:
// that database already has every Round 7 migration (up to 0810), so 0041 and 0050 are applied «out of order», after
// newer files. Every existing row must survive unchanged; the new columns start NULL («the vault's user» / «every reader
// of this DB»); nothing else in the schema changes.
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Db, openDb } from '../../src/db/db';
import { migrate, MIGRATIONS_DIR } from '../../src/db/migrate';
import { bootOnVaultFile } from '../helpers/tenancy';

const NEW = ['0041_sync_actor_visibility.sql', '0050_change_log_actor.sql'];

let dir: string;
let db: Db;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'medlevo-step0-mig-'));
  db = openDb(join(dir, 'medlevo.sqlite'));
});
afterEach(() => {
  if (db.isOpen) db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A migrations directory with every shipped file except the two new ones (= the owner's Round 7 database). */
function previousMigrationsDir(): string {
  const prev = join(dir, 'previous');
  mkdirSync(prev);
  for (const f of readdirSync(MIGRATIONS_DIR)) if (f.endsWith('.sql') && !NEW.includes(f)) copyFileSync(join(MIGRATIONS_DIR, f), join(prev, f));
  return prev;
}

function seedOwnerRows(d: Db): void {
  d.run(
    `INSERT INTO sync_operation (op_id, device_id, entity_type, entity_id, op, base_rev, payload_json, result, result_detail, client_ts, server_seq, received_at)
     VALUES ('op-1', 'dev-A', 'note', 'n1', 'upsert', NULL, '{"title":"ملاحظة"}', 'applied', NULL, 10, 1, 11),
            ('op-2', 'dev-B', 'annotation', 'a1', 'append', NULL, '{"kind":"ink"}', 'rejected', 'سبب الرفض', 12, 1, 13)`,
  );
  d.run(`INSERT INTO sync_change (entity_type, entity_id, changed_at) VALUES ('note', 'n1', 11), ('annotation', 'a1', 13), ('flashcard', 'f1', 14)`);
  d.run(
    `INSERT INTO change_log (id, entity_type, entity_id, action, summary, before_json, after_json, actor, job_id, created_at)
     VALUES ('cl-1', 'source', 's1', 'rename', 'إعادة تسمية', '{"title":"a"}', '{"title":"b"}', 'owner', NULL, 20),
            ('cl-2', 'source', 's1', 'process', NULL, NULL, NULL, 'job', 'job-1', 21),
            ('cl-3', 'server', 'data', 'restore', 'استعادة', NULL, '{}', 'system', NULL, 22)`,
  );
}

const snapshot = (d: Db) => ({
  ops: d.all('SELECT op_id, device_id, entity_type, entity_id, op, base_rev, payload_json, result, result_detail, client_ts, server_seq, received_at FROM sync_operation ORDER BY op_id'),
  changes: d.all('SELECT seq, entity_type, entity_id, changed_at FROM sync_change ORDER BY seq'),
  log: d.all('SELECT id, entity_type, entity_id, action, summary, before_json, after_json, actor, job_id, created_at FROM change_log ORDER BY id'),
  head: d.get<{ seq: number }>("SELECT seq FROM sqlite_sequence WHERE name = 'sync_change'")?.seq ?? null,
});

const columns = (d: Db, table: string) => d.all<{ name: string; type: string; notnull: number; dflt_value: unknown }>(`PRAGMA table_info(${table})`);

describe('base migrations 0041 / 0050 (P1-T1 step 0)', () => {
  it('a fresh database gets the actor and visibility columns and the partial visibility index', () => {
    migrate(db);
    expect(columns(db, 'sync_operation').find((c) => c.name === 'actor_user_id')).toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null });
    expect(columns(db, 'sync_change').find((c) => c.name === 'visibility_key')).toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null });
    expect(columns(db, 'change_log').find((c) => c.name === 'actor_user_id')).toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null });
    expect(columns(db, 'change_log').find((c) => c.name === 'actor_role')).toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null });
    const idx = db.get<{ sql: string }>(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_sync_change_visibility'`);
    expect(idx?.sql).toMatch(/ON sync_change\s*\(\s*visibility_key\s*,\s*seq\s*\)\s*WHERE visibility_key IS NOT NULL/);
    for (const n of NEW) expect(db.get('SELECT 1 AS x FROM schema_migration WHERE name = ?', [n])).toBeTruthy();
  });

  it("the owner's existing Round 7 database (every migration up to 0810) upgrades without losing or changing a row", () => {
    migrate(db, { dir: previousMigrationsDir() });
    for (const n of NEW) expect(db.get('SELECT 1 AS x FROM schema_migration WHERE name = ?', [n])).toBeUndefined();
    expect(columns(db, 'sync_operation').map((c) => c.name)).not.toContain('actor_user_id');
    seedOwnerRows(db);
    const before = snapshot(db);
    const otherSchema = db.all(`SELECT type, name, sql FROM sqlite_master WHERE name NOT IN ('sync_operation','sync_change','change_log','idx_sync_change_visibility') AND name NOT LIKE 'sqlite_%' ORDER BY name`);

    const res = migrate(db); // the full set: only the two new files are pending
    expect(res.applied).toEqual(NEW);
    expect(snapshot(db)).toEqual(before);
    // new columns are NULL on every legacy row: «the vault's user» / «every reader of this DB»
    expect(db.all('SELECT actor_user_id FROM sync_operation').every((r) => (r as { actor_user_id: unknown }).actor_user_id === null)).toBe(true);
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sync_change WHERE visibility_key IS NOT NULL')!.n).toBe(0);
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM change_log WHERE actor_user_id IS NOT NULL OR actor_role IS NOT NULL')!.n).toBe(0);
    // nothing else in the schema moved
    expect(db.all(`SELECT type, name, sql FROM sqlite_master WHERE name NOT IN ('sync_operation','sync_change','change_log','idx_sync_change_visibility') AND name NOT LIKE 'sqlite_%' ORDER BY name`)).toEqual(otherSchema);
    expect(db.all('PRAGMA foreign_key_check')).toEqual([]);
    expect(db.all<{ integrity_check: string }>('PRAGMA integrity_check')[0]!.integrity_check).toBe('ok');
    // re-running is a no-op
    expect(migrate(db).applied).toEqual([]);
    // the feed keeps its autoincrement head: the next change continues after the old head
    db.run(`INSERT INTO sync_change (entity_type, entity_id, changed_at) VALUES ('note', 'n2', 30)`);
    expect(db.get<{ seq: number }>(`SELECT seq FROM sync_change WHERE entity_id = 'n2'`)!.seq).toBe(before.head! + 1);
  });

  it('the visibility filter of a space pull (ARCHITECTURE_DELTA §8.4) can use the partial index', () => {
    migrate(db);
    db.run(`INSERT INTO sync_change (entity_type, entity_id, changed_at, visibility_key) VALUES ('annotation', 'x', 1, 'pub:1'), ('annotation', 'y', 2, NULL)`);
    const plan = db.all<{ detail: string }>(
      `EXPLAIN QUERY PLAN SELECT seq FROM sync_change WHERE visibility_key = 'pub:1' AND seq > 0 ORDER BY seq`,
    );
    expect(plan.map((p) => p.detail).join(' ')).toContain('idx_sync_change_visibility');
  });

  it('the server boots on an upgraded owner data directory: old rows intact, sync and audit keep working (new columns NULL)', async () => {
    // P1-T1 step 1: the owner's database is a vault (a single-owner data dir is refused until the owner migration,
    // step 3); the pool migrates a vault when it opens it — the same in-place upgrade as before
    let before!: ReturnType<typeof snapshot>;
    const booted = await bootOnVaultFile(join(dir, 'data'), (path) => {
      const old = openDb(path);
      migrate(old, { dir: previousMigrationsDir() });
      seedOwnerRows(old);
      before = snapshot(old);
      old.close();
    });
    const { app, ctx, headers } = booted;
    try {
      expect(snapshot(ctx.db)).toEqual(before);
      const pushed = await app.inject({
        method: 'POST',
        url: '/api/sync/push',
        headers,
        payload: { ops: [{ op_id: '01J00000000000000000000001', device_id: 'dev-A', entity_type: 'note', entity_id: '01J00000000000000000000002', op: 'upsert', payload: { body: { v: 1, paragraphs: [{ dir: 'rtl', runs: [{ t: 'نص' }] }] } } }] },
      });
      expect(pushed.statusCode).toBe(200);
      expect(pushed.json().results[0].result).toBe('applied');
      const rec = ctx.db.get<{ actor_user_id: string | null }>(`SELECT actor_user_id FROM sync_operation WHERE op_id = '01J00000000000000000000001'`);
      expect(rec).toEqual({ actor_user_id: null });
      const pulled = (await app.inject({ method: 'GET', url: `/api/sync/pull?since=${before.head}`, headers })).json();
      expect(pulled.changes.map((c: { entity_id: string }) => c.entity_id)).toContain('01J00000000000000000000002');
      // the audit log still lists the legacy entries, with today's shape (no new fields leak into the API)
      const audit = (await app.inject({ method: 'GET', url: '/api/audit?entity_type=source&entity_id=s1', headers })).json();
      expect(audit.entries.map((e: { id: string }) => e.id).sort()).toEqual(['cl-1', 'cl-2']);
      expect(Object.keys(audit.entries[0]).sort()).toEqual(['action', 'actor', 'after', 'before', 'created_at', 'entity_id', 'entity_type', 'id', 'job_id', 'summary']);
    } finally {
      await app.close();
    }
  });
});
