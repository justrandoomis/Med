// A realistic single-owner data directory of release R1-a (P1-T1 step 3 tests): what DATA_DIR looks like on the owner's
// server before the owner migration — DATA_DIR/medlevo.sqlite with the owner account and its sessions, the shared
// files/ store, a verified backup in backups/ listed in the database, secret.key.
//
// The content is written through the REAL modules and routes (base schema = R1-a's: this release adds no base
// migration, test/tenancy/owner-migration.test.ts checks it): two processed Golden-Set PDFs (pages, chunks, FTS,
// questions, lecture links), ink v1 and in a second authorship layer, a highlight, a note, a study session, cards with
// review history, a practice attempt and an exam in progress, a Study Book, an in-app recording, and sync operations
// from two devices. The database file is then given exactly what R1-a's single-owner auth wrote into it: the `owner`
// row (scrypt password, hashed recovery codes), `auth_session` rows (two active devices + an expired one) and
// `login_attempt` history. Built once per test file and copied for each scenario.
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ExamSessionView, SyncOp, SyncOpResult } from '@medlevo/shared';
import { openDb } from '../../src/db/db';
import { randomToken, sha256 } from '../../src/lib/hash';
import { newId } from '../../src/lib/ids';
import { generateRecoveryCode, hashSecret } from '../../src/modules/auth/password';
import { createBackup } from '../../src/modules/data/backup';
import { recordCliBackup } from '../../src/modules/data/backups';
import { stateOf } from '../acceptance/g4-helpers';
import { dataLibrary, pageAnchor, rt, writeOwnerData } from '../data/helpers';
import { multipart } from '../sources/helpers';

export const LEGACY_USERNAME = 'owner_r1a';
export const LEGACY_PASSWORD = 'R1a-owner-password-0123';
export const IPAD = 'IPAD_DEVICE_01';
export const PHONE = 'PHONE_DEVICE_02';

export interface LegacyFixture {
  /** DATA_DIR of the single-owner layout (never touched by a test: copy it with copyLegacy) */
  dir: string;
  recoveryCodes: string[];
  /** cookie tokens of the two active legacy sessions, and of an expired one (not migrated) */
  tokens: { ipad: string; phone: string; expired: string };
  /** every op already applied before the upgrade (a device that never got the ack pushes them again) */
  pushedOps: SyncOp[];
  /** ops queued in the outboxes of the two devices before the upgrade, never sent */
  queuedOps: SyncOp[];
  /** what the devices had pulled: the full feed answer before the upgrade */
  pullBefore: { head_seq: number; server_epoch: string; changes: number };
  /** answers of read APIs before the upgrade (compared after it) */
  apiBefore: Record<string, unknown>;
  ids: { lectureSourceId: string; noteId: string; inkId: string; layerId: string; recordingId: string; examAttemptId: string };
}

const READ_APIS = ['/api/library/tree', '/api/sync/pull?since=0&limit=1000', '/api/settings', '/api/media/audio'];

function inkData(x: number) {
  return {
    v: 1,
    points: [
      [x, 0.4, 0, 0.4],
      [x + 0.05, 0.42, 16, 0.7],
      [x + 0.1, 0.45, 32, 0.5],
    ],
    style: { tool: 'fountain', color: 'ink-black', width: 0.003 },
    bbox: { x, y: 0.4, w: 0.1, h: 0.05 },
    pressure_available: true,
    tilt_available: true,
  };
}

/** The start of a WebM file holding only an Opus audio track (what MediaRecorder writes) + filler. */
function webmAudio(bytes = 6000): Buffer {
  const ebml = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x01, 0x42, 0xf2, 0x81, 0x04, 0x42, 0xf3, 0x81, 0x08, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d, 0x42, 0x87, 0x81, 0x04, 0x42, 0x85, 0x81, 0x02]);
  const segment = Buffer.from([0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
  const name = Buffer.from('A_OPUS', 'latin1');
  const tracks = Buffer.concat([Buffer.from([0x16, 0x54, 0xae, 0x6b, 0x80 | (name.length + 4), 0xae, 0x80 | (name.length + 2), 0x86, 0x80 | name.length]), name]);
  return Buffer.concat([ebml, segment, tracks, Buffer.alloc(bytes, 0x5a)]);
}

export async function buildLegacyFixture(parent: string): Promise<LegacyFixture> {
  const lib = await dataLibrary();
  try {
    const t = lib.t;
    const h = lib.h;
    const now = t.ctx.clock.now();
    const owner = await writeOwnerData(lib);
    const pushedOps: SyncOp[] = [];
    const push = async (device: string, ops: Array<Omit<SyncOp, 'op_id' | 'device_id'>>): Promise<SyncOpResult[]> => {
      const full = ops.map((o) => ({ op_id: newId(), device_id: device, client_ts: now, base_rev: null, ...o }) as SyncOp);
      const res = await t.app.inject({ method: 'POST', url: '/api/sync/push', headers: h, payload: { ops: full } });
      if (res.statusCode !== 200) throw new Error(`push ${res.statusCode} ${res.body}`);
      const results = (res.json() as { results: SyncOpResult[] }).results;
      for (const r of results) if (!['applied', 'merged'].includes(r.result)) throw new Error(`fixture op not applied: ${JSON.stringify(r)}`);
      pushedOps.push(...full);
      return results;
    };

    // a second authorship layer on the lecture with ink in it, and ink written on the iPad and the phone
    const doc = `source:${lib.lecture.sourceId}`;
    const layerId = newId();
    await push(IPAD, [{ entity_type: 'annotation_layer', entity_id: layerId, op: 'upsert', payload: { id: layerId, document_key: doc, kind: 'answers', title: 'إجاباتي' } }]);
    const layerInk = newId();
    await push(IPAD, [
      { entity_type: 'annotation', entity_id: layerInk, op: 'append', payload: { kind: 'ink', tool: 'fountain', anchor: pageAnchor(lib, 1), data: inkData(0.3), layer: 'ink', z: 1, locked: false, layer_id: layerId } },
      { entity_type: 'annotation', entity_id: newId(), op: 'append', payload: { kind: 'ink', tool: 'pen', anchor: pageAnchor(lib, 2), data: inkData(0.5), layer: 'ink', z: 2, locked: false } },
    ]);
    await push(PHONE, [{ entity_type: 'note', entity_id: newId(), op: 'upsert', payload: { title: 'من الهاتف', body: rt('ملاحظة كتبتها على الهاتف'), anchor: pageAnchor(lib, 0), origin: 'owner' } }]);

    // an exam in progress (two answers)
    const ex = await t.app.inject({ method: 'POST', url: '/api/exams', headers: h, payload: { title: '', mode: 'exam', count: 3, source_ids: [lib.questions.sourceId], seed: 'owner-migration' } });
    if (ex.statusCode !== 200) throw new Error(`exam ${ex.statusCode} ${ex.body}`);
    const session = (ex.json() as { session: ExamSessionView }).session;
    const answers = Object.fromEntries(
      session.items.slice(0, 2).map((it) => [String(it.index), { attempt_id: newId(), selected_option_ids: [it.options[0]!.id], confidence: 'unsure', at: now, time_ms: 9000, hints_used: 0, solution_viewed_before_answer: false, submitted: false }]),
    );
    await push(IPAD, [{ entity_type: 'exam_attempt', entity_id: session.attempt.id, op: 'upsert', payload: stateOf(session, { status: 'in_progress', answers: answers as never, elapsed_ms: 60_000, current_index: 2 }) }]);

    // an in-app recording linked to the lecture
    const recordingId = newId();
    const mp = multipart({ recording_id: recordingId, started_at: String(now - 3_600_000), duration_ms: '93000', linked_source_id: lib.lecture.sourceId }, [
      { name: 'recording.webm', data: webmAudio(), contentType: 'audio/webm;codecs=opus', field: 'file' },
    ]);
    const rec = await t.app.inject({ method: 'POST', url: '/api/media/recordings', headers: { ...h, 'content-type': mp.contentType }, payload: mp.payload });
    if (rec.statusCode !== 201) throw new Error(`recording ${rec.statusCode} ${rec.body}`);
    await t.ctx.jobs.drain();

    // what the devices had seen before the upgrade
    const apiBefore: Record<string, unknown> = {};
    for (const url of READ_APIS) {
      const r = await t.app.inject({ method: 'GET', url, headers: h });
      if (r.statusCode !== 200) throw new Error(`read ${url} ${r.statusCode} ${r.body}`);
      apiBefore[url] = r.json();
    }
    const feed = apiBefore['/api/sync/pull?since=0&limit=1000'] as { head_seq: number; server_epoch: string; changes: unknown[] };

    // ops queued in the two devices' outboxes before the upgrade (never sent)
    const queuedOps: SyncOp[] = [
      { op_id: newId(), device_id: IPAD, entity_type: 'annotation', entity_id: newId(), op: 'append', base_rev: null, client_ts: now + 1000, payload: { kind: 'ink', tool: 'pen', anchor: pageAnchor(lib, 0), data: inkData(0.6), layer: 'ink', z: 3, locked: false } },
      { op_id: newId(), device_id: IPAD, entity_type: 'note', entity_id: newId(), op: 'upsert', base_rev: null, client_ts: now + 2000, payload: { title: null, body: rt('كتبتها دون اتصال قبل الترقية'), anchor: pageAnchor(lib, 1), origin: 'owner' } },
      { op_id: newId(), device_id: PHONE, entity_type: 'review_event', entity_id: newId(), op: 'append', base_rev: null, client_ts: now + 3000, payload: { card_id: owner.cardIds[0]!, rating: 3, reviewed_at: now + 3000, duration_ms: 4000 } },
    ];

    // the single-owner database file, as R1-a leaves it after a clean stop
    const dir = join(parent, 'legacy-data');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const legacyPath = join(dir, 'medlevo.sqlite');
    t.ctx.db.run('VACUUM INTO ?', [legacyPath]);
    // exactly as R1-a issued them (modules/auth: generateRecoveryCode → hashSecret of the formatted code)
    const recoveryCodes = [generateRecoveryCode(), generateRecoveryCode(), generateRecoveryCode()];
    const codeHashes = await Promise.all(recoveryCodes.map((c) => hashSecret(c, 12)));
    const passwordHash = await hashSecret(LEGACY_PASSWORD, 12);
    const tokens = { ipad: randomToken(32), phone: randomToken(32), expired: randomToken(32) };
    const real = Date.now();
    const db = openDb(legacyPath);
    try {
      db.run(`INSERT INTO owner (id, username, password_hash, recovery_codes_json, password_changed_at, created_at, updated_at) VALUES ('owner', ?, ?, ?, ?, ?, ?)`, [
        LEGACY_USERNAME,
        passwordHash,
        JSON.stringify(codeHashes),
        now - 40 * 86_400_000,
        now - 90 * 86_400_000,
        now - 40 * 86_400_000,
      ]);
      const session = (id: string, token: string, device: string, label: string, expires: number) =>
        db.run(
          `INSERT INTO auth_session (id, token_hash, device_id, device_label, user_agent, ip, created_at, last_seen_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
          [id, sha256(token), device, label, 'Mozilla/5.0 (fixture)', '203.0.113.7', now - 10 * 86_400_000, now - 3_600_000, expires],
        );
      session(newId(), tokens.ipad, IPAD, 'Safari على iPad', real + 25 * 86_400_000);
      session(newId(), tokens.phone, PHONE, 'Chrome على هاتف Android', real + 20 * 86_400_000);
      session(newId(), tokens.expired, 'OLD_LAPTOP_03', 'Firefox على Linux', real - 86_400_000);
      for (let i = 0; i < 3; i++) db.run('INSERT INTO login_attempt (id, ip, succeeded, created_at) VALUES (?, ?, ?, ?)', [newId(), '203.0.113.7', i === 2 ? 1 : 0, now - i * 60_000]);
    } finally {
      db.close();
    }
    cpSync(join(t.dataDir, 'files'), join(dir, 'files'), { recursive: true });
    if (existsSync(join(t.dataDir, 'secret.key'))) cpSync(join(t.dataDir, 'secret.key'), join(dir, 'secret.key'));
    // a CLI backup R1-a made and listed (the AC-30 machinery on the single-owner layout)
    const backup = await createBackup({ dataDir: dir, dbPath: legacyPath, filesDir: join(dir, 'files'), outDir: join(dir, 'backups'), appVersion: '0.1.0', now: () => now });
    const bdb = openDb(legacyPath);
    try {
      recordCliBackup(bdb, {
        backupId: backup.backupId,
        fileName: backup.fileName,
        size: backup.size,
        sha256: backup.sha256,
        summary: backup.summary,
        warnings_ar: backup.warnings_ar,
        createdAt: backup.manifest.created_at,
        finishedAt: now,
      });
      bdb.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
      bdb.close();
    }
    return {
      dir,
      recoveryCodes,
      tokens,
      pushedOps,
      queuedOps,
      pullBefore: { head_seq: feed.head_seq, server_epoch: feed.server_epoch, changes: feed.changes.length },
      apiBefore,
      ids: { lectureSourceId: lib.lecture.sourceId, noteId: owner.noteId, inkId: owner.inkId, layerId, recordingId, examAttemptId: session.attempt.id },
    };
  } finally {
    await lib.t.close();
  }
}

/** A fresh copy of the fixture's data directory for one scenario. */
export function copyLegacy(f: LegacyFixture, target: string): string {
  rmSync(target, { recursive: true, force: true });
  cpSync(f.dir, target, { recursive: true });
  return target;
}

export const READ_API_URLS = READ_APIS;
