// P1-T2 step 1 — the layer migration on the owner's EXISTING database (PRD AOS-4.6, AOS-21.11; ARCHITECTURE_DELTA §4.3).
// Release R1-a ships inside today's single-owner database: every migration up to 0810 (plus T1's 0041 / 0050 and T3's
// files) is already applied there, so 0271 / 0272 / 0861 run «out of order», after newer files. Every existing
// annotation (ink, highlights, text boxes, stickies, pictures, links, bookmarks, tombstones, conflict copies) and every
// note must survive byte for byte and land on the owner's personal layer («ملاحظاتي»: layer_id NULL) — zero loss.
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultPersonalLayerId, type LayersResponse } from '@medlevo/shared';
import { buildApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import { type Db, openDb } from '../../src/db/db';
import { migrate, MIGRATIONS_DIR } from '../../src/db/migrate';
import { CSRF, createClock, sessionCookie, TEST_ORIGIN } from '../helpers/app';

const NEW = ['0271_annotation_layers.sql', '0272_annotation_revision.sql', '0861_attribution.sql'];

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'medlevo-t2-mig-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** every shipped migration except P1-T2's (= the owner's database before this release) */
function previousMigrationsDir(): string {
  const prev = join(dir, 'previous');
  mkdirSync(prev);
  for (const f of readdirSync(MIGRATIONS_DIR)) if (f.endsWith('.sql') && !NEW.includes(f)) copyFileSync(join(MIGRATIONS_DIR, f), join(prev, f));
  return prev;
}

const NOW = 1_760_000_000_000;
const anchor = (page: string, idx: number) => JSON.stringify({ type: 'page', source_id: 'SRC1', version_id: 'VER1', page_id: page, page_index: idx, space: 'page_norm' });
const ink = (x: number) =>
  JSON.stringify({ v: 1, points: [[x, 0.3, 0, 0.5], [x + 0.05, 0.31, 16, 0.6]], style: { tool: 'pen', color: 'ink-blue', width: 0.0025 }, bbox: { x, y: 0.3, w: 0.05, h: 0.01 }, pressure_available: true, tilt_available: false });

/** The owner's writing as Round 7 stored it: every kind, plus tombstones, a conflict copy, a detached item and notes. */
function seedOwnerWriting(d: Db): void {
  d.run(`INSERT INTO library_node (id, kind, title, sort_order, created_at, updated_at) VALUES ('NB1', 'notebook', 'دفتر التشريح', 0, ?, ?)`, [NOW, NOW]);
  d.run(`INSERT INTO source (id, title, source_type, created_at, updated_at) VALUES ('SRC1', 'محاضرة القلب', 'lecture', ?, ?)`, [NOW, NOW]);
  d.run(
    `INSERT INTO source_version (id, source_id, version_no, kind, content_hash, mime, format, page_count, created_at) VALUES ('VER1', 'SRC1', 1, 'original', 'h1', 'application/pdf', 'pdf', 2, ?)`,
    [NOW],
  );
  d.run('UPDATE source SET current_version_id = ? WHERE id = ?', ['VER1', 'SRC1']);
  for (const [id, i] of [['P1', 0], ['P2', 1]] as const) {
    d.run(`INSERT INTO source_page (id, version_id, page_index, kind, width, height, unit, created_at, updated_at) VALUES (?, 'VER1', ?, 'page', 595, 842, 'pt', ?, ?)`, [id, i, NOW, NOW]);
  }
  d.run(`INSERT INTO note_page (id, node_id, source_id, title, template, width, height, sort_order, created_at, updated_at, rev) VALUES ('NP1', 'NB1', NULL, 'صفحة', 'ruled', 595, 842, 0, ?, ?, 1)`, [NOW, NOW]);
  d.run(`INSERT INTO stored_file (id, sha256, size, mime, storage_key, created_at) VALUES ('F1', ?, 3, 'image/png', 'ab/cd/x', ?)`, ['a'.repeat(64), NOW]);
  d.run(`INSERT INTO annotation_image (image_key, file_id, mime, bytes, width, height, referenced, device_id, created_at) VALUES ('IMG1', 'F1', 'image/png', 3, 10, 10, 1, 'dev-A', ?)`, [NOW]);
  const rows: Array<[string, string, string | null, string, string, string, number]> = [
    ['A_INK', 'ink', 'pen', anchor('P1', 0), ink(0.2), 'ink', 1],
    ['A_HL', 'text_highlight', null, anchor('P1', 0), JSON.stringify({ v: 1, style: 'highlight', color: 'hl-yellow', rects: [{ x: 0.1, y: 0.1, w: 0.3, h: 0.02 }], quote: { exact: 'الصمام التاجي' } }), 'highlight', 3],
    ['A_TEXT', 'text', 'text', anchor('P2', 1), JSON.stringify({ v: 1, box: { x: 0.1, y: 0.5, w: 0.3, h: 0.1 }, text: { v: 1, paragraphs: [{ dir: 'rtl', runs: [{ t: 'مهم' }] }] }, color: 'ink-black', font_scale: 0.02 }), 'text', 2],
    ['A_IMG', 'image', 'image', anchor('P2', 1), JSON.stringify({ v: 1, image_key: 'IMG1', box: { x: 0.2, y: 0.2, w: 0.2, h: 0.2 }, mime: 'image/png', natural_w: 10, natural_h: 10, bytes: 3 }), 'media', 1],
    ['A_STICKY', 'sticky', 'sticky', anchor('P1', 0), JSON.stringify({ v: 1, at: [0.9, 0.1], text: 'راجع', color: 'hl-pink' }), 'text', 1],
    ['A_NBINK', 'ink', 'fountain', JSON.stringify({ type: 'note_page', note_page_id: 'NP1', space: 'page_norm' }), ink(0.4), 'ink', 1],
    ['A_DEAD', 'ink', 'pen', anchor('P1', 0), ink(0.6), 'ink', 2],
  ];
  for (const [id, kind, tool, anc, data, layer, rev] of rows) {
    d.run(
      `INSERT INTO annotation (id, kind, tool, anchor_json, data_json, layer, z, locked, anchor_status, input_json, device_id, rev, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0, 'ok', '{"pointer_type":"pen","pressure":true}', 'dev-A', ?, ?, ?, ?)`,
      [id, kind, tool, anc, data, layer, rev, NOW, NOW + rev, id === 'A_DEAD' ? NOW + 5 : null],
    );
    const t = JSON.parse(anc) as { type: string; page_id?: string; note_page_id?: string };
    d.run(`INSERT INTO annotation_target (annotation_id, target_type, target_id) VALUES (?, ?, ?)`, [id, t.type === 'page' ? 'source_page' : 'note_page', t.page_id ?? t.note_page_id]);
  }
  // a conflict copy kept next to the original (AC-24) and an item the owner kept detached (H3)
  d.run(
    `INSERT INTO annotation (id, kind, tool, anchor_json, data_json, layer, z, locked, anchor_status, device_id, rev, created_at, updated_at, conflict_of_id, detached_at)
     VALUES ('A_COPY', 'ink', 'pen', ?, ?, 'ink', 1, 0, 'ok', 'dev-B', 1, ?, ?, 'A_INK', NULL), ('A_DET', 'ink', 'pen', ?, ?, 'ink', 0, 0, 'needs_reanchor', 'dev-B', 3, ?, ?, NULL, ?)`,
    [anchor('P1', 0), ink(0.25), NOW, NOW, anchor('P2', 1), ink(0.7), NOW, NOW, NOW + 9],
  );
  d.run(`INSERT INTO annotation_target (annotation_id, target_type, target_id) VALUES ('A_COPY', 'source_page', 'P1'), ('A_DET', 'source_page', 'P2')`);
  const body = (t: string) => JSON.stringify({ v: 1, paragraphs: [{ dir: 'rtl', runs: [{ t }] }] });
  d.run(
    `INSERT INTO note (id, node_id, title, body_json, anchor_json, origin, rev, device_id, created_at, updated_at, source_id, anchor_target_key)
     VALUES ('N_PAGE', NULL, 'ملاحظة', ?, ?, 'owner', 2, 'dev-A', ?, ?, 'SRC1', 'source_page:P1'),
            ('N_BOOK', 'NB1', NULL, ?, NULL, 'owner', 1, 'dev-A', ?, ?, NULL, NULL),
            ('N_AI', NULL, 'جواب', ?, ?, 'ai_answer', 1, 'dev-A', ?, ?, 'SRC1', 'source_page:P2')`,
    [body('القلب'), anchor('P1', 0), NOW, NOW, body('دفتر'), NOW, NOW, body('شرح'), anchor('P2', 1), NOW, NOW],
  );
}

const OLD_ANNOTATION_COLUMNS =
  'id, kind, tool, anchor_json, data_json, layer, z, locked, anchor_status, previous_anchor_json, input_json, device_id, rev, created_at, updated_at, deleted_at, conflict_of_id, detached_at';
const OLD_NOTE_COLUMNS =
  'id, node_id, title, body_json, anchor_json, origin, ai_record_json, rev, base_rev, conflict_of_id, device_id, created_at, updated_at, deleted_at, source_id, anchor_target_key, previous_anchor_json, detached_at';
const snapshot = (d: Db) => ({
  annotations: d.all(`SELECT ${OLD_ANNOTATION_COLUMNS} FROM annotation ORDER BY id`),
  notes: d.all(`SELECT ${OLD_NOTE_COLUMNS} FROM note ORDER BY id`),
  targets: d.all('SELECT * FROM annotation_target ORDER BY annotation_id'),
  pages: d.all('SELECT * FROM note_page ORDER BY id'),
  images: d.all('SELECT * FROM annotation_image ORDER BY image_key'),
});

describe('migration 0271 / 0272 / 0861 on the owner database (zero loss)', () => {
  it('keeps every annotation and note byte for byte and puts all of them on the personal layer', () => {
    const db = openDb(join(dir, 'medlevo.sqlite'));
    try {
      migrate(db, { dir: previousMigrationsDir() });
      seedOwnerWriting(db);
      const before = snapshot(db);
      expect(before.annotations).toHaveLength(9);
      expect(before.notes).toHaveLength(3);

      const res = migrate(db);
      expect(res.applied).toEqual(NEW);
      expect(snapshot(db)).toEqual(before);
      // every legacy row is on the default personal layer, written by the vault's user, on the device that wrote it
      expect(db.all(`SELECT DISTINCT layer_id, author_user_id, migrated_from_id, origin FROM annotation`)).toEqual([
        { layer_id: null, author_user_id: null, migrated_from_id: null, origin: 'device' },
      ]);
      expect(db.all(`SELECT DISTINCT layer_id, author_user_id, migrated_from_id FROM note`)).toEqual([{ layer_id: null, author_user_id: null, migrated_from_id: null }]);
      // nothing was materialised or invented: no layer rows, no history, no attribution
      for (const t of ['annotation_layer', 'annotation_revision', 'attribution']) expect(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`)!.n).toBe(0);
      expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sync_operation WHERE detail_code IS NOT NULL')!.n).toBe(0);
      expect(db.all('PRAGMA foreign_key_check')).toEqual([]);
      expect(db.all<{ integrity_check: string }>('PRAGMA integrity_check')[0]!.integrity_check).toBe('ok');
      expect(migrate(db).applied).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('the upgraded server lists that writing on «ملاحظاتي» and keeps serving it unchanged; an old client keeps editing it', async () => {
    const dataDir = join(dir, 'data');
    mkdirSync(dataDir);
    const old = openDb(join(dataDir, 'medlevo.sqlite'));
    migrate(old, { dir: previousMigrationsDir() });
    seedOwnerWriting(old);
    const before = snapshot(old);
    old.close();

    const config = loadConfig({ NODE_ENV: 'test', MEDLEVO_DATA_DIR: dataDir, MEDLEVO_ORIGIN: TEST_ORIGIN, MEDLEVO_LOG_LEVEL: 'silent', MEDLEVO_SCRYPT_LOG_N: '12' });
    const app = await buildApp({ config, overrides: { clock: createClock(NOW + 100_000), aiProvider: null } });
    try {
      await app.ready();
      expect(snapshot(app.ctx.db)).toEqual(before);
      const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', headers: { ...CSRF, 'user-agent': 'vitest' }, payload: { username: 'owner', password: 'test-password-123' } });
      const headers = { cookie: sessionCookie(setup), ...CSRF };

      const src = (await app.inject({ method: 'GET', url: '/api/annotations/layers?document_key=source:SRC1', headers })).json() as LayersResponse;
      expect(src.layers).toHaveLength(1);
      expect(src.layers[0]).toMatchObject({ id: defaultPersonalLayerId('source:SRC1'), kind: 'personal', title: 'ملاحظاتي', is_default: true, access: 'write', visible: true });
      // live items of the lecture: 7 annotations on its pages (incl. the conflict copy and the detached item; the
      // tombstone is not counted) + 2 notes
      expect(src.layers[0]!.item_count).toBe(9);
      const nb = (await app.inject({ method: 'GET', url: '/api/annotations/layers?document_key=notebook:NB1', headers })).json() as LayersResponse;
      expect(nb.layers[0]).toMatchObject({ is_default: true, item_count: 2 });

      // the read API serves the stored rows exactly as before (no new keys on a legacy row)
      const got = (await app.inject({ method: 'GET', url: '/api/annotations/by-targets?keys=source_page:P1,source_page:P2', headers })).json();
      const ids = (got.annotations as Array<{ id: string }>).map((a) => a.id).sort();
      expect(ids).toEqual(['A_COPY', 'A_DET', 'A_HL', 'A_IMG', 'A_INK', 'A_STICKY', 'A_TEXT']);
      const inkRow = (got.annotations as Array<Record<string, unknown>>).find((a) => a.id === 'A_INK')!;
      expect(inkRow.data).toEqual(JSON.parse(ink(0.2)));
      for (const k of ['layer_id', 'author_user_id', 'migrated_from_id', 'origin']) expect(inkRow).not.toHaveProperty(k);

      // an old client (no layer_id in its payload) edits a legacy stroke: applied as today, still on «ملاحظاتي»
      const edit = await app.inject({
        method: 'POST',
        url: '/api/sync/push',
        headers,
        payload: {
          ops: [
            {
              op_id: '01J0000000000000000000OLD1',
              device_id: 'dev-A',
              entity_type: 'annotation',
              entity_id: 'A_INK',
              op: 'upsert',
              base_rev: 1,
              payload: { kind: 'ink', tool: 'pen', anchor: JSON.parse(anchor('P1', 0)), data: JSON.parse(ink(0.21)), layer: 'ink', z: 0, locked: false },
            },
          ],
        },
      });
      expect(edit.json().results[0]).toMatchObject({ result: 'applied' });
      expect(app.ctx.db.get('SELECT layer_id, rev FROM annotation WHERE id = ?', ['A_INK'])).toEqual({ layer_id: null, rev: 2 });
    } finally {
      await app.close();
    }
  });
});
