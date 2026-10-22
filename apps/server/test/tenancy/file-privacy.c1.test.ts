// AOS-21.38 / AOS-5.22 — files are private by default: the cross-user FILE, PULL, DUPLICATE, SEARCH and EXPORT checks,
// space files included, with the real routes. Amal and Basim study in one deployment; Amal is a member of the subject
// space SPACE_A, Basim is not. Every check has a positive control (Amal sees her own) so a broken fixture cannot pass.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SearchResponse, SyncPullResponse, UploadResponse } from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import { exportsDir } from '../../src/modules/accounts/export';
import { verifyBackup } from '../../src/modules/data/restore';
import { inkData } from '../annotations/helpers';
import { inSpaceDb, inVault, publishLecture, type Published, vaultIdOf } from '../forks/helpers';
import { createLectureWorld, drain, lecturePdf, type LectureWorld, type Person, sp, SPACE_A } from '../lectures/world';

const AMAL: Person = 'contrib'; // member of SPACE_A
const BASIM: Person = 'outsider'; // no subject at all
const WORD = 'Zygomaticotemporalis';
let w: LectureWorld;
let pdf: Buffer;
let mine: { sourceId: string; versionId: string; fileId: string; sha256: string };
let official: Published & { fileId: string };
let annotationId: string;

async function privateUpload(person: Person, name: string, data: Buffer): Promise<UploadResponse['results'][number]> {
  const folder = inVault(w, person, () => {
    const id = newId();
    const now = Date.now();
    w.t.ctx.db.run(`INSERT INTO library_node (id, parent_id, kind, title, created_at, updated_at) VALUES (?, NULL, 'folder', 'ملفاتي', ?, ?)`, [id, now, now]);
    return id;
  });
  const res = await w.upload(person, '/api/sources/upload', { name, data }, { node_id: folder, source_type: 'lecture' });
  expect(res.statusCode, res.body).toBe(200);
  await drain(w);
  await drain(w);
  return (res.json() as UploadResponse).results[0]!;
}

beforeAll(async () => {
  w = await createLectureWorld();
  pdf = lecturePdf([[`${WORD} nerve passes through the zygomatic bone`, 'Private notes of Amal page one', 'Clinical correlation of the face']]);
  const r = await privateUpload(AMAL, 'amal-private.pdf', pdf);
  expect(['created', 'accepted']).toContain(r.status);
  mine = inVault(w, AMAL, () => {
    const v = w.t.ctx.db.get<{ id: string; file_id: string }>('SELECT v.id, v.file_id FROM source s JOIN source_version v ON v.id = s.current_version_id WHERE s.id = ?', [r.source_id!])!;
    const f = w.t.ctx.db.get<{ sha256: string }>('SELECT sha256 FROM stored_file WHERE id = ?', [v.file_id])!;
    return { sourceId: r.source_id!, versionId: v.id, fileId: v.file_id, sha256: f.sha256 };
  });
  // a stroke of Amal's on her own lecture (sync)
  annotationId = newId();
  const page = inVault(w, AMAL, () => w.t.ctx.db.get<{ id: string }>('SELECT id FROM source_page WHERE version_id = ? ORDER BY page_index LIMIT 1', [mine.versionId])!.id);
  const push = await w.req(AMAL, 'POST', '/api/sync/push', {
    ops: [
      {
        op_id: newId(),
        device_id: 'DEV-AMAL',
        entity_type: 'annotation',
        entity_id: annotationId,
        op: 'append',
        payload: {
          kind: 'ink',
          tool: 'pen',
          anchor: { type: 'page', source_id: mine.sourceId, version_id: mine.versionId, page_id: page, page_index: 0, space: 'page_norm' },
          data: inkData(),
          layer: 'ink',
          z: 1,
          locked: false,
        },
      },
    ],
  });
  expect(push.statusCode, push.body).toBe(200);
  expect(push.json().results[0].result, push.body).toBe('applied');
  // an official lecture of SPACE_A
  const pub = await publishLecture(w, SPACE_A, 'Facial nerves (TEST FIXTURE)', [['Official lecture page one about cranial nerves', 'Second line', 'Third line']]);
  official = { ...pub, fileId: inSpaceDb(w, SPACE_A, (db) => db.get<{ file_id: string }>('SELECT file_id FROM source_version WHERE id = ?', [pub.versionId])!.file_id) };
}, 300_000);

afterAll(async () => {
  await w?.close();
});

describe('AOS-21.38 — the cross-user FILE check', () => {
  it("Basim cannot read, describe or link Amal's file by its id (404, the answer of a missing file)", async () => {
    expect((await w.req(AMAL, 'GET', `/api/files/${mine.fileId}`)).statusCode).toBe(200);
    const missing = await w.req(BASIM, 'GET', `/api/files/${newId()}`);
    for (const [method, url] of [
      ['GET', `/api/files/${mine.fileId}`],
      ['GET', `/api/files/${mine.fileId}/meta`],
      ['POST', `/api/files/${mine.fileId}/token`],
      ['GET', `/api/sources/${mine.sourceId}`],
    ] as const) {
      const res = await w.req(BASIM, method, url, method === 'POST' ? {} : undefined);
      expect(res.statusCode, `${method} ${url}`).toBe(404);
      expect(res.json().error.code).toBe(missing.json().error.code);
    }
  });
});

describe('AOS-21.38 — the cross-user PULL check', () => {
  it("Basim's change feed never carries Amal's lecture or stroke", async () => {
    const pull = async (p: Person) => (await w.req(p, 'GET', '/api/sync/pull?since=0&limit=1000')).json() as SyncPullResponse;
    const amal = (await pull(AMAL)).changes.map((c) => c.entity_id);
    expect(amal).toContain(annotationId);
    const basim = await pull(BASIM);
    const ids = basim.changes.map((c) => c.entity_id);
    expect(ids).not.toContain(annotationId);
    expect(ids).not.toContain(mine.sourceId);
    expect(JSON.stringify(basim)).not.toContain(mine.fileId);
  });

  it("Basim pushing an op with Amal's entity id writes in HIS vault only", async () => {
    const res = await w.req(BASIM, 'POST', '/api/sync/push', {
      ops: [{ op_id: newId(), device_id: 'DEV-BASIM', entity_type: 'annotation', entity_id: annotationId, op: 'delete', payload: null }],
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(inVault(w, AMAL, () => w.t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM annotation WHERE id = ? AND deleted_at IS NULL', [annotationId])!.n)).toBe(1);
  });
});

describe('AOS-21.38 — the cross-user DUPLICATE check', () => {
  it("the same bytes uploaded by Basim are not reported as a duplicate of Amal's lecture (nothing of hers is named)", async () => {
    const r = await privateUpload(BASIM, 'same-bytes.pdf', pdf);
    expect(['created', 'accepted']).toContain(r.status);
    expect(r.duplicate_of).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain(mine.sourceId);
    // a second upload by Basim IS his own duplicate (positive control)
    const again = await privateUpload(BASIM, 'same-bytes-2.pdf', pdf);
    expect(again.status).toBe('duplicate');
    expect(again.duplicate_of!.source_id).toBe(r.source_id);
  });
});

describe('AOS-21.38 — the cross-user SEARCH check', () => {
  it("Amal finds her own word; Basim's results never name her source (his own copy of the same bytes is his)", async () => {
    const search = async (p: Person) => (await w.req(p, 'GET', `/api/search?q=${encodeURIComponent(WORD)}`)).json() as SearchResponse;
    const amal = await search(AMAL);
    expect(JSON.stringify(amal)).toContain(mine.sourceId);
    const basim = await search(BASIM);
    expect(JSON.stringify(basim)).not.toContain(mine.sourceId);
    expect(JSON.stringify(basim)).not.toContain(mine.versionId);
  });
});

describe('AOS-21.38 — the cross-user EXPORT check', () => {
  it("Basim's «نسخة من بياناتي» holds his vault and his files only", async () => {
    const start = await w.req(BASIM, 'POST', '/api/accounts/me/export', {});
    expect(start.statusCode, start.body).toBe(200);
    await w.t.ctx.binding.run({ kind: 'vault', vaultId: vaultIdOf(w, BASIM), viewer: null }, () => w.t.ctx.jobs.drain());
    const dir = exportsDir(w.t.ctx, vaultIdOf(w, BASIM));
    const archive = readdirSync(dir).find((n) => n.endsWith('.tar.gz'));
    expect(archive).toBeTruthy();
    const v = await verifyBackup(join(dir, archive!), { workDir: w.t.config.tmpDir, keep: true, bootCheck: false });
    try {
      expect(v.report.ok, JSON.stringify(v.report.checks.filter((c) => !c.ok))).toBe(true);
      expect(v.manifest!.vaults!.map((x) => x.vault_id)).toEqual([vaultIdOf(w, BASIM)]);
      expect(v.manifest!.account!.user_id).toBe(w.id[BASIM]);
      // his own copy of the same bytes is his; Amal's source and stroke are not in his database
      const dbFile = join(v.dataDir!, 'vaults', v.manifest!.vaults![0]!.db_file);
      expect(existsSync(dbFile)).toBe(true);
      const raw = readFileSync(dbFile);
      expect(raw.includes(Buffer.from(mine.sourceId)), 'source id').toBe(false);
      expect(raw.includes(Buffer.from('amal-private')), "Amal's file name").toBe(false);
      // (Basim's own push above named Amal's stroke id in HIS vault — a tombstone of nothing; her stroke is not there)
      const { openDb } = await import('../../src/db/db');
      const db = openDb(dbFile);
      try {
        expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM annotation WHERE id = ? AND deleted_at IS NULL", [annotationId])!.n).toBe(0);
      } finally {
        db.close();
      }
      expect(existsSync(join(v.dataDir!, 'system.sqlite')), 'system').toBe(false);
      expect(existsSync(join(v.dataDir!, 'spaces')), 'spaces').toBe(false);
    } finally {
      if (v.workDir) (await import('node:fs')).rmSync(v.workDir, { recursive: true, force: true });
    }
  });
});

describe('AOS-21.38 — space files', () => {
  it('a member reads an official lecture file through its space; a non-member gets 404 there and through the vault route', async () => {
    expect((await w.req(AMAL, 'GET', sp(SPACE_A, `/files/${official.fileId}`))).statusCode).toBe(200);
    const asStranger = await w.req(BASIM, 'GET', sp(SPACE_A, `/files/${official.fileId}`));
    expect([403, 404]).toContain(asStranger.statusCode);
    expect(asStranger.body).not.toContain('%PDF');
    // a space file id is not a file of anyone's vault
    expect((await w.req(BASIM, 'GET', `/api/files/${official.fileId}`)).statusCode).toBe(404);
    expect((await w.req(AMAL, 'GET', `/api/files/${official.fileId}`)).statusCode).toBe(404);
    // Amal's private file is not reachable through a space either
    expect((await w.req(AMAL, 'GET', sp(SPACE_A, `/files/${mine.fileId}`))).statusCode).toBe(404);
  });
});
