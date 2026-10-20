// H1: content_alert.kind is a CHECK constraint; question-text corrections used to be stored as «source_updated».
// Migration 0310 rebuilds the table with the dedicated kind «question_corrected», keeping every alert row, every
// content_alert_item row (the item table cascades from content_alert: a naive DROP would have deleted them), the
// indexes, and relabelling only the alerts the question-correction writer made.
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONTENT_ALERT_KINDS, CONTENT_ALERT_KIND_LABELS_AR } from '@medlevo/shared';
import { type Db, openDb } from '../../src/db/db';
import { migrate, MIGRATIONS_DIR } from '../../src/db/migrate';

const MIGRATION = '0310_content_alert_question_corrected.sql';
let dir: string;
let db: Db;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'medlevo-alertkind-'));
  db = openDb(join(dir, 'test.sqlite'));
});
afterEach(() => {
  if (db.isOpen) db.close();
  rmSync(dir, { recursive: true, force: true });
});

function migrateUpTo(name: string): void {
  const before = join(dir, 'before');
  mkdirSync(before);
  for (const f of readdirSync(MIGRATIONS_DIR)) if (f.endsWith('.sql') && f < name) copyFileSync(join(MIGRATIONS_DIR, f), join(before, f));
  migrate(db, { dir: before });
}

const alert = (id: string, kind: string, details: string | null) =>
  db.run(
    `INSERT INTO content_alert (id, kind, severity, source_id, source_version_id, summary, affected_json, status, created_at, resolved_at, from_version_id, acknowledged_at, details_json)
     VALUES (?, ?, 'fact_change', 's1', 'v1', ?, '[]', 'acknowledged', 10, NULL, 'v0', 11, ?)`,
    [id, kind, `summary ${id}`, details],
  );

describe('migration 0310 — content_alert kind «question_corrected»', () => {
  it('keeps every alert and item, relabels only question-correction alerts, and accepts the new kind', () => {
    migrateUpTo(MIGRATION);
    for (const k of ['source_updated', 'ocr_corrected', 'key_corrected', 'source_deleted', 'source_replaced', 'conflict_found', 'layout_changed']) alert(`A-${k}`, k, '{"pages_changed":[1]}');
    alert('Q-1', 'source_updated', JSON.stringify({ question_id: 'q1', corrected: 'نص الخيار', by: 'owner' }));
    // a question-correction alert can not be written with the new kind before the migration
    expect(() => alert('Q-early', 'question_corrected', null)).toThrow();
    for (const a of ['A-source_updated', 'Q-1', 'A-key_corrected']) {
      db.run(`INSERT INTO content_alert_item (alert_id, dependent_type, dependent_id, impact, frozen, reason_ar, version_ids_json) VALUES (?, 'question_attempt', ?, 'still_valid', 1, 'سبب', '["v0"]')`, [a, `att-${a}`]);
    }
    const alertsBefore = db.all('SELECT id, severity, source_id, source_version_id, summary, affected_json, status, created_at, resolved_at, from_version_id, acknowledged_at, details_json FROM content_alert ORDER BY id');
    const itemsBefore = db.all('SELECT * FROM content_alert_item ORDER BY alert_id');

    migrate(db); // the full set: applies 0310 (and anything after it)
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM schema_migration WHERE name = ?', [MIGRATION])!.n).toBe(1);
    expect(db.all('SELECT id, severity, source_id, source_version_id, summary, affected_json, status, created_at, resolved_at, from_version_id, acknowledged_at, details_json FROM content_alert ORDER BY id')).toEqual(alertsBefore);
    expect(db.all('SELECT * FROM content_alert_item ORDER BY alert_id')).toEqual(itemsBefore);
    // only the question-correction alert changed kind
    expect(db.get<{ kind: string }>(`SELECT kind FROM content_alert WHERE id = 'Q-1'`)!.kind).toBe('question_corrected');
    expect(db.get<{ kind: string }>(`SELECT kind FROM content_alert WHERE id = 'A-source_updated'`)!.kind).toBe('source_updated');
    // the CHECK accepts the new kind, still refuses an unknown one
    alert('Q-2', 'question_corrected', null);
    expect(() => alert('X', 'made_up_kind', null)).toThrow();
    // the cascade still works and the indexes are back
    db.run(`DELETE FROM content_alert WHERE id = 'Q-1'`);
    expect(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM content_alert_item WHERE alert_id = 'Q-1'`)!.n).toBe(0);
    const idx = db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'content_alert'`).map((r) => r.name);
    expect(idx).toEqual(expect.arrayContaining(['idx_content_alert_status', 'idx_content_alert_source']));
    expect(db.get<{ foreign_keys: number }>('PRAGMA foreign_keys')!.foreign_keys).toBe(1);
    expect(db.all('PRAGMA foreign_key_check')).toEqual([]);
  });

  it('an owner database already at the latest Round 6/7 schema (every migration but 0310) gets 0310 applied last, out of order, without losing a row', () => {
    const allBut = join(dir, 'all-but');
    mkdirSync(allBut);
    for (const f of readdirSync(MIGRATIONS_DIR)) if (f.endsWith('.sql') && f !== MIGRATION) copyFileSync(join(MIGRATIONS_DIR, f), join(allBut, f));
    migrate(db, { dir: allBut });
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM schema_migration WHERE name = ?', [MIGRATION])!.n).toBe(0);
    alert('A-1', 'ocr_corrected', '{"pages_changed":[2]}');
    alert('Q-1', 'source_updated', JSON.stringify({ question_id: 'q1', corrected: 'نص السؤال', by: 'owner' }));
    db.run(`INSERT INTO content_alert_item (alert_id, dependent_type, dependent_id, impact, frozen, reason_ar, version_ids_json) VALUES ('A-1', 'artifact', 'art-1', 'needs_regeneration', 0, NULL, '[]')`);
    db.run(`INSERT INTO content_alert_job (job_id, alert_id, created_at) VALUES ('job-1', 'A-1', 5)`);
    const before = { alerts: db.all('SELECT * FROM content_alert ORDER BY id'), items: db.all('SELECT * FROM content_alert_item'), jobs: db.all('SELECT * FROM content_alert_job') };

    const r = migrate(db);
    expect(r.applied).toEqual([MIGRATION]);
    const after = db.all<Record<string, unknown>>('SELECT * FROM content_alert ORDER BY id');
    expect(after.map((a) => ({ ...a, kind: a.id === 'Q-1' ? 'source_updated' : a.kind }))).toEqual(before.alerts);
    expect(after.find((a) => a.id === 'Q-1')!.kind).toBe('question_corrected');
    expect(db.all('SELECT * FROM content_alert_item')).toEqual(before.items);
    expect(db.all('SELECT * FROM content_alert_job')).toEqual(before.jobs);
    expect(db.all('PRAGMA foreign_key_check')).toEqual([]);
    expect(db.all(`SELECT name FROM sqlite_temp_master WHERE name LIKE 'h1_%'`)).toEqual([]);
  });

  it('the shared contract names the kind with an Arabic label', () => {
    expect(CONTENT_ALERT_KINDS).toContain('question_corrected');
    expect(CONTENT_ALERT_KIND_LABELS_AR.question_corrected).toMatch(/سؤال/);
  });
});
