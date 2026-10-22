// P1-T1 step 1 — three migration sets (ARCHITECTURE_DELTA §3.1): base (every vault and space), system
// (DATA_DIR/system.sqlite, 2000–2999) and space commons (3000–3999). Each set is recorded in its own file's
// schema_migration table; the checksum / «edited» / «unknown migration» rules apply per set, so a system database is
// never opened as a vault (or the other way round) and a file name never means two different migrations.
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Db, openDb } from '../../src/db/db';
import { migrate, MigrationError, MIGRATIONS_DIR, readMigrations, SYSTEM_MIGRATIONS_DIR, SPACE_MIGRATIONS_DIR } from '../../src/db/migrate';

let dir: string;
let db: Db;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'medlevo-sysmig-'));
  db = openDb(join(dir, 'x.sqlite'));
});
afterEach(() => {
  if (db.isOpen) db.close();
  rmSync(dir, { recursive: true, force: true });
});

const tables = (d: Db) => d.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name);

describe('system migration set', () => {
  it('ships exactly the R1-b system files 2000, 2010, 2040, 2250, 2300 — all inside the 2000–2999 band', () => {
    const names = readMigrations(SYSTEM_MIGRATIONS_DIR).map((f) => f.name);
    // R1-c (P1-T4 step 1) appends 2050_directory and 2100_permissions; P1-T4 step 2 2200_notifications and 2310_moderation
    expect(names).toEqual(['2000_identity.sql', '2010_devices.sql', '2040_registry.sql', '2050_directory.sql', '2060_lecture_copy.sql', '2100_permissions.sql', '2150_publications.sql', '2200_notifications.sql', '2250_ops.sql', '2300_security.sql', '2310_moderation.sql']);
    // R1-b carries no space commons migration and no new BASE migration (owner-migration rule, BUILD_PLAN §1.3)
    // R1-c: the space commons set starts with P1-T5 step 1 (official lectures, subject content)
    expect(readMigrations(SPACE_MIGRATIONS_DIR).map((f) => f.name)).toEqual(['3000_official_lectures.sql', '3010_subject_content.sql', '3050_publications.sql', '3300_scoped_fts.sql']);
    for (const f of readMigrations(MIGRATIONS_DIR)) expect(Number(f.name.slice(0, 4))).toBeLessThan(2000);
  });

  it('creates the identity, device, registry, ops and security tables and nothing of the vault schema', () => {
    const res = migrate(db, { sets: ['system'] });
    expect(res.applied).toEqual(['2000_identity.sql', '2010_devices.sql', '2040_registry.sql', '2050_directory.sql', '2060_lecture_copy.sql', '2100_permissions.sql', '2150_publications.sql', '2200_notifications.sql', '2250_ops.sql', '2300_security.sql', '2310_moderation.sql']);
    const t = tables(db);
    for (const name of ['user_account', 'user_profile', 'auth_session', 'login_attempt', 'device', 'space', 'vault', 'blob', 'blob_ref', 'blob_mark', 'job_index', 'upload_session', 'user_quota', 'space_quota', 'ai_budget_ledger', 'security_audit', 'consent_record']) {
      expect(t, name).toContain(name);
    }
    for (const vaultOnly of ['owner', 'source', 'annotation', 'processing_job', 'owner_setting', 'stored_file']) expect(t).not.toContain(vaultOnly);
    // the column the design added for multi-user sessions
    const cols = db.all<{ name: string }>('PRAGMA table_info(auth_session)').map((c) => c.name);
    expect(cols).toContain('user_id');
    expect(migrate(db, { sets: ['system'] }).applied).toEqual([]);
  });

  it('enforces the design constraints: one legacy owner, unique login key, registry foreign keys, device_uid unique', () => {
    migrate(db, { sets: ['system'] });
    const user = (id: string, norm: string, legacy = 0) =>
      db.run(
        `INSERT INTO user_account (id, username, username_norm, display_name, password_hash, password_changed_at, legacy_owner, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'x', 1, ?, 1, 1)`,
        [id, norm, norm, norm, legacy],
      );
    user('u1', 'a', 1);
    expect(() => user('u2', 'a')).toThrow(/UNIQUE/);
    expect(() => user('u3', 'b', 1)).toThrow(/UNIQUE/);
    user('u4', 'c');
    expect(() => db.run(`INSERT INTO vault (id, user_id, db_file, created_at) VALUES ('v1', 'nobody', 'v1.sqlite', 1)`)).toThrow(/FOREIGN KEY/);
    db.run(`INSERT INTO vault (id, user_id, db_file, created_at) VALUES ('v1', 'u1', 'v1.sqlite', 1)`);
    expect(() => db.run(`INSERT INTO vault (id, user_id, db_file, created_at) VALUES ('v2', 'u1', 'v2.sqlite', 1)`)).toThrow(/UNIQUE/); // one vault per user
    db.run(`INSERT INTO device (user_id, device_id, device_uid, first_seen_at, last_seen_at) VALUES ('u1', 'd', 'uid-1', 1, 1)`);
    // the same client device id under another user is another row with its own server-issued uid
    db.run(`INSERT INTO device (user_id, device_id, device_uid, first_seen_at, last_seen_at) VALUES ('u4', 'd', 'uid-2', 1, 1)`);
    expect(() => db.run(`INSERT INTO device (user_id, device_id, device_uid, first_seen_at, last_seen_at) VALUES ('u4', 'e', 'uid-1', 1, 1)`)).toThrow(/UNIQUE/);
    expect(() => db.run(`UPDATE user_account SET status = 'gone' WHERE id = 'u1'`)).toThrow(/CHECK/);
  });
});

describe('sets never mix', () => {
  it('a system database is refused as a vault, and a vault is refused as a system database', () => {
    migrate(db, { sets: ['system'] });
    expect(() => migrate(db)).toThrow(MigrationError);
    expect(() => migrate(db, { sets: ['base'] })).toThrow(/2000_identity\.sql/);

    const vault = openDb(join(dir, 'v.sqlite'));
    try {
      migrate(vault);
      expect(() => migrate(vault, { sets: ['system'] })).toThrow(/0001_core\.sql/);
    } finally {
      vault.close();
    }
  });

  it('base + space applies both sets and records both in the space file (the space set is empty in R1-b)', () => {
    const res = migrate(db, { sets: ['base', 'space'] });
    expect(res.applied[0]).toBe('0001_core.sql');
    // R1-c (P1-T5 step 1): the space set now ships 3000/3010 — base files first, then the space band, all recorded
    expect(res.applied.every((n) => Number(n.slice(0, 4)) < 2000 || (Number(n.slice(0, 4)) >= 3000 && Number(n.slice(0, 4)) <= 3999))).toBe(true);
    expect(res.applied.slice(-4)).toEqual(['3000_official_lectures.sql', '3010_subject_content.sql', '3050_publications.sql', '3300_scoped_fts.sql']);
    // and the runner refuses the vault set alone on this space file (unknown migration: an older build never opens it)
    expect(() => migrate(db, { sets: ['base'] })).toThrow(/not present in this build/);
  });

  it('a migration outside its set band is refused (a file name never means two migrations)', () => {
    const custom = join(dir, 'sys');
    mkdirSync(custom);
    writeFileSync(join(custom, '0100_wrong_band.sql'), 'CREATE TABLE t (x INTEGER) STRICT;');
    expect(() => readMigrations(custom, 'system')).toThrow(/band/);
    expect(() => readMigrations(MIGRATIONS_DIR, 'system')).toThrow(/band/);
    expect(() => readMigrations(SYSTEM_MIGRATIONS_DIR, 'base')).toThrow(/band/);
  });
});
