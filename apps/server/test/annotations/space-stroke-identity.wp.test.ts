// PRD AOS-21.12 «strokes carry author, layer and document / fork» — the document / fork part (migration 0863).
//
//  * A stroke written on an official lecture's study copy stores the DOCUMENT (`source:<id>` — the vault's stub keeps
//    the space's source id, so this names the official lecture) and the COPY whose layer holds it (`document_copy.id`:
//    the personal copy, a fork, a followed copy). Both are server-derived; a client's value is ignored.
//  * Two forks of the same lecture keep separate strokes: a read for fork A (`copy_id`) never answers fork B's strokes
//    (nor the personal copy's); the document's own items (an extra layer, no copy) show on both; without `copy_id` every
//    item is answered as before.
//  * The migration applies on an existing vault (backfill from the layers; nothing else of a row changes, the change
//    feed untouched) and on an existing space database (columns added, nothing changed).
//  * An older client's sync payload (no layer_id, no x-medlevo-client — user #1's stale tab) is still applied and its
//    strokes get the identity anyway.
// Every file and stroke is a TEST FIXTURE generated here.
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultPersonalLayerId, sourceDocumentKey, type AnnotationDTO, type DocumentCopyView, type PublicationView, type SourceAnnotationsResponse, type StartStudyingResponse, type SyncOpResult } from '@medlevo/shared';
import { type Db, openDb } from '../../src/db/db';
import { migrate, MIGRATIONS_DIR, SPACE_MIGRATIONS_DIR } from '../../src/db/migrate';
import { newId } from '../../src/lib/ids';
import { call, createCode, ok } from '../channels/helpers';
import { createLayer, createPubWorld, inVault, op, pageAnchor, publish, push, startPersonal, strokes, typedNote, type PubWorld, type Who } from '../forks/pubWorld';
import { inkData } from './helpers';

const MIGRATION = '0863_stroke_copy_identity.sql';

// ───────────────────────────── on the server ─────────────────────────────
let w: PubWorld;
let pubH: PublicationView;
let pubD: PublicationView;
let personal: DocumentCopyView;
let forkA: DocumentCopyView;
let forkB: DocumentCopyView;

async function fork(who: Who, pub: PublicationView): Promise<DocumentCopyView> {
  return ok<StartStudyingResponse>(await call(w.t, w.p[who].h, 'POST', '/api/copies', { id: newId(), space_id: w.space, lecture_id: w.lecture.id, mode: 'independent_fork', publication_id: pub.id, version_no: 1 })).copy;
}
const rowOf = (who: Who, id: string) =>
  inVault(w, who, () => w.t.ctx.db.get<{ document_key: string | null; document_copy_id: string | null; layer_id: string | null }>('SELECT document_key, document_copy_id, layer_id FROM annotation WHERE id = ?', [id]))!;
const idsOfCopy = (who: Who, copyId: string) => inVault(w, who, () => w.t.ctx.db.all<{ id: string }>('SELECT id FROM annotation WHERE document_copy_id = ? AND deleted_at IS NULL', [copyId]).map((r) => r.id));
async function readSource(who: Who, copyId?: string): Promise<SourceAnnotationsResponse> {
  return ok<SourceAnnotationsResponse>(await call(w.t, w.p[who].h, 'GET', `/api/annotations/source/${w.lecture.sourceId}${copyId ? `?copy_id=${copyId}` : ''}`));
}

const mine: Record<string, string[]> = {};
let docLayerStroke: string;

beforeAll(async () => {
  w = await createPubWorld(4);
  // two explanations of the SAME official lecture, by two students
  await startPersonal(w, 'hasan');
  const hl = await createLayer(w, 'hasan', 'شرح حسن');
  await strokes(w, 'hasan', hl, 0, 3);
  pubH = await publish(w, 'hasan', [hl], 'شرح حسن');
  await startPersonal(w, 'huda');
  const dl = await createLayer(w, 'huda', 'شرح هدى');
  await strokes(w, 'huda', dl, 1, 2);
  pubD = await publish(w, 'huda', [dl], 'شرح هدى');
  // علي: «نسختي», then a fork of each explanation
  personal = await startPersonal(w, 'ali');
  forkA = await fork('ali', pubH);
  forkB = await fork('ali', pubD);
}, 300_000);
afterAll(async () => {
  await w?.close();
});

describe('AOS-21.12: a stroke on a space lecture copy stores the document and the copy', () => {
  it('«نسختي», fork A and fork B are three copies of one lecture, each with its own personal layer', () => {
    expect(new Set([personal.source_id, forkA.source_id, forkB.source_id])).toEqual(new Set([w.lecture.sourceId]));
    // the vault's stub keeps the space's source id: the document IS the official lecture
    expect(w.t.ctx.dbs.space(w.space).get<{ source_id: string }>('SELECT source_id FROM official_lecture WHERE id = ?', [w.lecture.id])!.source_id).toBe(w.lecture.sourceId);
    expect(personal.personal_layer_id).toBe(defaultPersonalLayerId(sourceDocumentKey(w.lecture.sourceId)));
    expect(new Set([personal.personal_layer_id, forkA.personal_layer_id, forkB.personal_layer_id]).size).toBe(3);
  });

  it('strokes written on each copy store both ids (sync answer and row)', async () => {
    mine.personal = await strokes(w, 'ali', null, 0, 2);
    mine.forkA = await strokes(w, 'ali', forkA.personal_layer_id, 0, 2);
    mine.forkB = await strokes(w, 'ali', forkB.personal_layer_id, 0, 3);
    // a stroke on fork B's own (writable) copied layer
    mine.forkBCopied = await strokes(w, 'ali', forkB.copied_layer_id, 0, 1);
    const doc = sourceDocumentKey(w.lecture.sourceId);
    for (const [key, copy] of [['personal', personal], ['forkA', forkA], ['forkB', forkB], ['forkBCopied', forkB]] as const) {
      for (const id of mine[key]!) expect(rowOf('ali', id), key).toMatchObject({ document_key: doc, document_copy_id: copy.id });
    }
    // the sync answer carries it to the device
    const id = newId();
    const [r] = await push(w, 'ali', [op({ entity_type: 'annotation', entity_id: id, payload: { kind: 'ink', tool: 'pen', anchor: pageAnchor(w, 1), data: inkData(0.4), layer: 'ink', z: 0, locked: false, layer_id: forkA.personal_layer_id } })]);
    expect(r!.result, JSON.stringify(r)).toBe('applied');
    expect((r!.entity as AnnotationDTO).document_copy_id).toBe(forkA.id);
    mine.forkA.push(id);
  });

  it('the items a fork copied from its explanation belong to that fork (stamped when the copy row is written)', () => {
    const copiedA = inVault(w, 'ali', () => w.t.ctx.db.all<{ document_copy_id: string | null }>('SELECT document_copy_id FROM annotation WHERE layer_id = ?', [forkA.copied_layer_id]));
    expect(copiedA).toHaveLength(3);
    for (const r of copiedA) expect(r.document_copy_id).toBe(forkA.id);
    const copiedB = inVault(w, 'ali', () => w.t.ctx.db.all<{ document_copy_id: string | null }>(`SELECT document_copy_id FROM annotation WHERE layer_id = ? AND origin = 'fork_copy'`, [forkB.copied_layer_id]));
    expect(copiedB).toHaveLength(2);
    for (const r of copiedB) expect(r.document_copy_id).toBe(forkB.id);
  });

  it('a client cannot name another copy: the identity follows the layer, a payload value is ignored', async () => {
    const id = newId();
    const [r] = await push(w, 'ali', [
      op({ entity_type: 'annotation', entity_id: id, payload: { kind: 'ink', tool: 'pen', anchor: pageAnchor(w, 0), data: inkData(0.5), layer: 'ink', z: 0, locked: false, layer_id: forkA.personal_layer_id, document_copy_id: forkB.id, document_key: 'source:OTHER' } }),
    ]);
    expect(r!.result, JSON.stringify(r)).toBe('applied');
    expect(rowOf('ali', id)).toMatchObject({ document_key: sourceDocumentKey(w.lecture.sourceId), document_copy_id: forkA.id });
    mine.forkA!.push(id);
    // moving a stroke to another copy's layer moves its identity with it
    const moved = mine.forkB!.pop()!;
    const [m] = await push(w, 'ali', [
      op({ entity_type: 'annotation', entity_id: moved, base_rev: 1, payload: { kind: 'ink', tool: 'pen', anchor: pageAnchor(w, 0), data: inkData(0.9), layer: 'ink', z: 0, locked: false, layer_id: forkA.personal_layer_id } }),
    ]);
    expect(m!.result, JSON.stringify(m)).toBe('applied');
    expect(rowOf('ali', moved).document_copy_id).toBe(forkA.id);
    mine.forkA!.push(moved);
  });
});

describe('AOS-21.12: two forks of the same lecture keep separate strokes', () => {
  it('a read for fork A never answers fork B’s strokes (nor «نسختي»’s); the document’s own layer shows on both', async () => {
    // an extra layer علي made on the document itself (not part of any copy)
    const extra = await createLayer(w, 'ali', 'ملخصي');
    docLayerStroke = (await strokes(w, 'ali', extra, 0, 1))[0]!;
    expect(rowOf('ali', docLayerStroke)).toMatchObject({ document_key: sourceDocumentKey(w.lecture.sourceId), document_copy_id: null });

    const a = (await readSource('ali', forkA.id)).annotations.map((x) => x.id);
    const b = (await readSource('ali', forkB.id)).annotations.map((x) => x.id);
    const aOwn = idsOfCopy('ali', forkA.id);
    const bOwn = idsOfCopy('ali', forkB.id);
    expect(aOwn.length).toBe(3 + mine.forkA!.length);
    expect(bOwn.length).toBe(2 + mine.forkB!.length + mine.forkBCopied!.length);
    expect(new Set(a)).toEqual(new Set([...aOwn, docLayerStroke]));
    expect(new Set(b)).toEqual(new Set([...bOwn, docLayerStroke]));
    for (const id of [...bOwn, ...mine.personal!]) expect(a).not.toContain(id);
    for (const id of [...aOwn, ...mine.personal!]) expect(b).not.toContain(id);
    // the DTO names the copy
    for (const x of (await readSource('ali', forkB.id)).annotations) expect(x.document_copy_id ?? null).toBe(x.id === docLayerStroke ? null : forkB.id);
  });

  it('the page read (by-targets) filters the same way; without copy_id every item is answered as before', async () => {
    const key = `source_page:${w.lecture.pageIds[0]}`;
    const byA = ok<{ annotations: AnnotationDTO[] }>(await call(w.t, w.p.ali.h, 'GET', `/api/annotations/by-targets?keys=${key}&copy_id=${forkA.id}`)).annotations;
    expect(byA.length).toBeGreaterThan(0);
    for (const x of byA) expect([forkA.id, undefined]).toContain(x.document_copy_id ?? undefined);
    expect(byA.map((x) => x.id)).not.toContain(mine.forkBCopied![0]);
    const all = ok<{ annotations: AnnotationDTO[] }>(await call(w.t, w.p.ali.h, 'GET', `/api/annotations/by-targets?keys=${key}`)).annotations.map((x) => x.id);
    for (const id of [...mine.personal!, ...mine.forkB!, ...mine.forkBCopied!, docLayerStroke]) expect(all).toContain(id);
    const everything = (await readSource('ali')).annotations.length;
    expect(everything).toBe(inVault(w, 'ali', () => w.t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM annotation WHERE deleted_at IS NULL')!.n));
  });

  it('notes follow the same rule', async () => {
    const nA = await typedNote(w, 'ali', forkA.personal_layer_id, 0, 'ملاحظة على النسخة أ');
    const nB = await typedNote(w, 'ali', forkB.personal_layer_id, 0, 'ملاحظة على النسخة ب');
    const a = (await readSource('ali', forkA.id)).notes.map((n) => n.id);
    expect(a).toContain(nA);
    expect(a).not.toContain(nB);
    expect(inVault(w, 'ali', () => w.t.ctx.db.get('SELECT document_copy_id FROM note WHERE id = ?', [nB]))).toEqual({ document_copy_id: forkB.id });
  });

  it('a copy that is not this lecture’s (or does not exist) is answered «not found»; another student’s copy id finds nothing in my vault', async () => {
    expect((await call(w.t, w.p.ali.h, 'GET', `/api/annotations/source/${w.lecture.sourceId}?copy_id=NOPE`)).statusCode).toBe(404);
    const zCopy = await startPersonal(w, 'zainab');
    expect((await call(w.t, w.p.ali.h, 'GET', `/api/annotations/source/${w.lecture.sourceId}?copy_id=${zCopy.id}`)).statusCode).toBe(404);
  });

  it('devices learn the identity from the change feed, including the fork items stamped after they were written', async () => {
    const pull = ok<{ changes: Array<{ entity_type: string; entity_id: string; entity: AnnotationDTO | null }> }>(await call(w.t, w.p.ali.h, 'GET', '/api/sync/pull?since=0&limit=1000'));
    const byId = new Map(pull.changes.filter((c) => c.entity_type === 'annotation').map((c) => [c.entity_id, c.entity]));
    const copied = inVault(w, 'ali', () => w.t.ctx.db.all<{ id: string }>('SELECT id FROM annotation WHERE layer_id = ?', [forkA.copied_layer_id]).map((r) => r.id));
    for (const id of copied) expect(byId.get(id)?.document_copy_id).toBe(forkA.id);
    for (const id of mine.forkB!) expect(byId.get(id)?.document_copy_id).toBe(forkB.id);
  });
});

describe('AOS-21.12: an older client keeps working', () => {
  it('an R1-a payload (no layer_id) from user #1’s stale tab (no x-medlevo-client) is applied and gets the identity', async () => {
    const owner = await w.t.login();
    const code = (await createCode(w.t, owner, w.subject.id, { requires_approval: false })).code!;
    await call(w.t, owner, 'POST', '/api/channels/join', { code });
    const copy = ok<StartStudyingResponse>(await call(w.t, owner, 'POST', '/api/copies', { id: newId(), space_id: w.space, lecture_id: w.lecture.id, mode: 'personal' })).copy;
    const old = Object.fromEntries(Object.entries(owner).filter(([k]) => k !== 'x-medlevo-client'));
    const id = newId();
    const payload = { kind: 'ink', tool: 'pen', anchor: pageAnchor(w, 2), data: inkData(0.3), layer: 'ink', z: 0, locked: false };
    const res = await w.t.app.inject({ method: 'POST', url: '/api/sync/push', headers: old, payload: { ops: [op({ entity_type: 'annotation', entity_id: id, payload })] } });
    expect(res.statusCode, res.body).toBe(200);
    const [r] = res.json().results as SyncOpResult[];
    expect(r!.result, JSON.stringify(r)).toBe('applied');
    const ownerVault = w.t.ctx.system.vaults.ofUserInternal(w.t.ctx.system.users.firstUserIdInternal()!)!.id;
    const row = () => w.t.ctx.binding.run({ kind: 'vault', vaultId: ownerVault, viewer: null }, () => w.t.ctx.db.get<Record<string, unknown>>('SELECT layer_id, rev, document_key, document_copy_id FROM annotation WHERE id = ?', [id]));
    expect(row()).toEqual({ layer_id: null, rev: 1, document_key: sourceDocumentKey(w.lecture.sourceId), document_copy_id: copy.id });
    // an R1-a edit (same shape, base_rev) keeps both
    const edit = await w.t.app.inject({ method: 'POST', url: '/api/sync/push', headers: old, payload: { ops: [op({ entity_type: 'annotation', entity_id: id, base_rev: 1, payload: { ...payload, data: inkData(0.35) } })] } });
    expect((edit.json().results as SyncOpResult[])[0]!.result).toBe('applied');
    expect(row()).toEqual({ layer_id: null, rev: 2, document_key: sourceDocumentKey(w.lecture.sourceId), document_copy_id: copy.id });
    // the old read (no copy_id) answers it
    const got = (await w.t.app.inject({ method: 'GET', url: `/api/annotations/source/${w.lecture.sourceId}`, headers: old })).json() as SourceAnnotationsResponse;
    expect(got.annotations.map((a) => a.id)).toContain(id);
  });
});

// ───────────────────────────── the migration on existing databases ─────────────────────────────
describe('migration 0863 on existing databases', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'medlevo-0863-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** every shipped file of the given directories except 0863 (= a database written by the release before it) */
  function previousDir(name: string, dirs: string[]): string {
    const prev = join(dir, name);
    mkdirSync(prev);
    for (const d of dirs) for (const f of readdirSync(d)) if (f.endsWith('.sql') && f !== MIGRATION) copyFileSync(join(d, f), join(prev, f));
    return prev;
  }

  const NOW = 1_770_000_000_000;
  const DOC = 'source:STUB1';
  const DEF = defaultPersonalLayerId(DOC);
  const pageAnchorJson = (src: string, ver: string, page: string) => JSON.stringify({ type: 'page', source_id: src, version_id: ver, page_id: page, page_index: 0, space: 'page_norm' });
  const ink = JSON.stringify(inkData(0.2));

  function seedVault(d: Db): void {
    for (const [id, stub] of [['STUB1', 1], ['PRIV1', 0]] as const) {
      d.run(`INSERT INTO source (id, title, source_type, created_at, updated_at, is_stub, origin_space_id, origin_lecture_id) VALUES (?, 'محاضرة', 'lecture', ?, ?, ?, ?, ?)`, [
        id,
        NOW,
        NOW,
        stub,
        stub ? 'SPACE1' : null,
        stub ? 'LEC1' : null,
      ]);
      d.run(`INSERT INTO source_version (id, source_id, version_no, kind, content_hash, mime, format, page_count, created_at) VALUES (?, ?, 1, 'original', ?, 'application/pdf', 'pdf', 1, ?)`, [`V_${id}`, id, `h_${id}`, NOW]);
      d.run(`INSERT INTO source_page (id, version_id, page_index, kind, width, height, unit, created_at, updated_at) VALUES (?, ?, 0, 'page', 595, 842, 'pt', ?, ?)`, [`P_${id}`, `V_${id}`, NOW, NOW]);
    }
    d.run(`INSERT INTO library_node (id, kind, title, sort_order, created_at, updated_at) VALUES ('NB1', 'notebook', 'دفتر', 0, ?, ?)`, [NOW, NOW]);
    d.run(`INSERT INTO note_page (id, node_id, source_id, title, template, width, height, sort_order, created_at, updated_at, rev) VALUES ('NP1', 'NB1', NULL, 'صفحة', 'blank', 595, 842, 0, ?, ?, 1)`, [NOW, NOW]);
    const layer = (id: string, kind: string, sort: number) =>
      d.run(`INSERT INTO annotation_layer (id, document_key, kind, title, writable, frozen, visible, locked, sort_order, rev, created_at, updated_at) VALUES (?, ?, ?, 'طبقة', 1, 0, 1, 0, ?, 1, ?, ?)`, [id, DOC, kind, sort, NOW, NOW]);
    layer(DEF, 'personal', -1e9);
    layer('ly_forkpersonal', 'personal', 1);
    layer('ly_forkcopied', 'forked', 2);
    layer('LY_EXTRA', 'explanation', 3);
    const copy = (id: string, mode: string, personalLayer: string, copied: string | null, pub: string | null) =>
      d.run(
        `INSERT INTO document_copy (id, source_id, origin_space_id, origin_lecture_id, mode, publication_id, applied_version_no, personal_layer_id, copied_layer_id, created_at, updated_at)
         VALUES (?, 'STUB1', 'SPACE1', 'LEC1', ?, ?, ?, ?, ?, ?, ?)`,
        [id, mode, pub, pub ? 1 : null, personalLayer, copied, NOW, NOW],
      );
    copy('C_PERSONAL', 'personal', DEF, null, null);
    copy('C_FORK', 'independent_fork', 'ly_forkpersonal', 'ly_forkcopied', 'PUB1');
    const stub = pageAnchorJson('STUB1', 'V_STUB1', 'P_STUB1');
    const rows: Array<[string, string, string | null]> = [
      ['A_DEFAULT', stub, null],
      ['A_FORK_PERSONAL', stub, 'ly_forkpersonal'],
      ['A_FORK_COPIED', stub, 'ly_forkcopied'],
      ['A_EXTRA', stub, 'LY_EXTRA'],
      ['A_PRIVATE', pageAnchorJson('PRIV1', 'V_PRIV1', 'P_PRIV1'), null],
      ['A_NOTEBOOK', JSON.stringify({ type: 'note_page', note_page_id: 'NP1', space: 'page_norm' }), null],
    ];
    for (const [id, anchor, layerId] of rows) {
      d.run(`INSERT INTO annotation (id, kind, tool, anchor_json, data_json, layer, z, locked, anchor_status, device_id, rev, created_at, updated_at, layer_id) VALUES (?, 'ink', 'pen', ?, ?, 'ink', 0, 0, 'ok', 'dev', 1, ?, ?, ?)`, [
        id,
        anchor,
        ink,
        NOW,
        NOW,
        layerId,
      ]);
      d.run(`INSERT INTO sync_change (entity_type, entity_id, changed_at) VALUES ('annotation', ?, ?)`, [id, NOW]);
    }
    const body = JSON.stringify({ v: 1, paragraphs: [{ dir: 'rtl', runs: [{ t: 'ملاحظة' }] }] });
    d.run(
      `INSERT INTO note (id, node_id, title, body_json, anchor_json, origin, rev, device_id, created_at, updated_at, source_id, anchor_target_key, layer_id)
       VALUES ('N_DEFAULT', NULL, NULL, ?, ?, 'owner', 1, 'dev', ?, ?, 'STUB1', 'source_page:P_STUB1', NULL),
              ('N_FORK', NULL, NULL, ?, ?, 'owner', 1, 'dev', ?, ?, 'STUB1', 'source_page:P_STUB1', 'ly_forkcopied'),
              ('N_BOOK', 'NB1', NULL, ?, NULL, 'owner', 1, 'dev', ?, ?, NULL, NULL, NULL)`,
      [body, stub, NOW, NOW, body, stub, NOW, NOW, body, NOW, NOW],
    );
  }

  const OLD_COLUMNS = 'id, kind, tool, anchor_json, data_json, layer, z, locked, anchor_status, device_id, rev, created_at, updated_at, deleted_at, layer_id, author_user_id, origin';

  it('an existing vault: every row gets its document, the rows of a copy’s layers that copy; nothing else changes', () => {
    const db = openDb(join(dir, 'vault.sqlite'));
    try {
      migrate(db, { dir: previousDir('vault-prev', [MIGRATIONS_DIR]) });
      seedVault(db);
      const before = { rows: db.all(`SELECT ${OLD_COLUMNS} FROM annotation ORDER BY id`), feed: db.all('SELECT * FROM sync_change ORDER BY seq') };

      expect(migrate(db).applied).toEqual([MIGRATION]);
      expect(db.all(`SELECT id, document_key, document_copy_id FROM annotation ORDER BY id`)).toEqual([
        { id: 'A_DEFAULT', document_key: DOC, document_copy_id: 'C_PERSONAL' },
        { id: 'A_EXTRA', document_key: DOC, document_copy_id: null },
        { id: 'A_FORK_COPIED', document_key: DOC, document_copy_id: 'C_FORK' },
        { id: 'A_FORK_PERSONAL', document_key: DOC, document_copy_id: 'C_FORK' },
        { id: 'A_NOTEBOOK', document_key: 'notebook:NB1', document_copy_id: null },
        { id: 'A_PRIVATE', document_key: 'source:PRIV1', document_copy_id: null },
      ]);
      expect(db.all(`SELECT id, document_key, document_copy_id FROM note ORDER BY id`)).toEqual([
        { id: 'N_BOOK', document_key: 'notebook:NB1', document_copy_id: null },
        { id: 'N_DEFAULT', document_key: DOC, document_copy_id: 'C_PERSONAL' },
        { id: 'N_FORK', document_key: DOC, document_copy_id: 'C_FORK' },
      ]);
      // the backfill rewrote no revision, timestamp or data, and put nothing on the change feed
      expect(db.all(`SELECT ${OLD_COLUMNS} FROM annotation ORDER BY id`)).toEqual(before.rows);
      expect(db.all('SELECT * FROM sync_change ORDER BY seq')).toEqual(before.feed);
      expect(db.all('PRAGMA foreign_key_check')).toEqual([]);
      expect(db.all<{ integrity_check: string }>('PRAGMA integrity_check')[0]!.integrity_check).toBe('ok');
      expect(migrate(db).applied).toEqual([]);

      // and from now on the database keeps it: a new stroke on the fork's layer, a later copy of the private upload
      db.run(`INSERT INTO annotation (id, kind, tool, anchor_json, data_json, layer, z, locked, anchor_status, rev, created_at, updated_at, layer_id) VALUES ('A_NEW', 'ink', 'pen', ?, ?, 'ink', 0, 0, 'ok', 1, ?, ?, 'ly_forkpersonal')`, [
        pageAnchorJson('STUB1', 'V_STUB1', 'P_STUB1'),
        ink,
        NOW,
        NOW,
      ]);
      expect(db.get('SELECT document_key, document_copy_id FROM annotation WHERE id = ?', ['A_NEW'])).toEqual({ document_key: DOC, document_copy_id: 'C_FORK' });
      db.run(`INSERT INTO annotation_layer (id, document_key, kind, title, writable, frozen, visible, locked, sort_order, rev, created_at, updated_at) VALUES (?, 'source:PRIV1', 'personal', 'ملاحظاتي', 1, 0, 1, 0, -1e9, 1, ?, ?)`, [
        defaultPersonalLayerId('source:PRIV1'),
        NOW,
        NOW,
      ]);
      db.run(`INSERT INTO document_copy (id, source_id, mode, personal_layer_id, created_at, updated_at) VALUES ('C_PRIV', 'PRIV1', 'personal', ?, ?, ?)`, [defaultPersonalLayerId('source:PRIV1'), NOW + 1, NOW + 1]);
      expect(db.get('SELECT document_copy_id FROM annotation WHERE id = ?', ['A_PRIVATE'])).toEqual({ document_copy_id: 'C_PRIV' });
      // …and puts the stamped stroke back on the feed so devices learn it
      expect(db.get<{ seq: number }>(`SELECT seq FROM sync_change WHERE entity_type = 'annotation' AND entity_id = 'A_PRIVATE'`)!.seq).toBeGreaterThan(before.feed.length);
    } finally {
      db.close();
    }
  });

  it('an existing space database: the migration applies after the space set, adds the columns, changes nothing', () => {
    const db = openDb(join(dir, 'space.sqlite'));
    try {
      migrate(db, { dir: previousDir('space-prev', [MIGRATIONS_DIR, SPACE_MIGRATIONS_DIR]) });
      db.run(`INSERT INTO source (id, title, source_type, created_at, updated_at) VALUES ('SRC_S', 'محاضرة رسمية', 'lecture', ?, ?)`, [NOW, NOW]);
      db.run(`INSERT INTO official_lecture (id, source_id, subject_node_id, title, status, uploaded_by, created_at, updated_at) VALUES ('LEC_S', 'SRC_S', 'SUBJ', 'محاضرة رسمية', 'draft', 'U1', ?, ?)`, [NOW, NOW]);
      const lectures = db.all('SELECT * FROM official_lecture');
      const res = migrate(db, { sets: ['base', 'space'] });
      expect(res.applied).toEqual([MIGRATION]);
      const cols = (t: string) => db.all<{ name: string }>(`PRAGMA table_info(${t})`).map((c) => c.name);
      for (const t of ['annotation', 'note']) expect(cols(t)).toEqual(expect.arrayContaining(['document_key', 'document_copy_id']));
      expect(db.all('SELECT * FROM official_lecture')).toEqual(lectures);
      expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM annotation')!.n).toBe(0);
      expect(db.all<{ integrity_check: string }>('PRAGMA integrity_check')[0]!.integrity_check).toBe('ok');
      expect(migrate(db, { sets: ['base', 'space'] }).applied).toEqual([]);
    } finally {
      db.close();
    }
  });
});
