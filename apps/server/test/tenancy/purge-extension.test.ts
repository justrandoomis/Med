// P1-T1 step 0 — the purge-extension registry of modules/sources/purge.ts (BUILD_PLAN §3.2): a module registers its own
// purge step from its own plugin (T2: layers and revisions, T3: fingerprints and page maps) instead of editing the purge.
// Blob deletion is delegated to modules/files/blobs.ts. With no extension registered, today's purge is unchanged.
import { existsSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ImpactReport } from '@medlevo/shared';
import { removeStoredFileIfUnreferenced as removeFromBlobs } from '../../src/modules/files/blobs';
import { AppError } from '../../src/lib/errors';
import {
  type PurgeExtension,
  purgeExtensions,
  registerPurgeExtension,
  removeStoredFileIfUnreferenced as removeFromPurge,
} from '../../src/modules/sources/purge';
import { api, createNode, golden, type Harness, makeHarness, uploadOk } from '../sources/helpers';

let t: Harness;
/**
 * (P1-T2) modules register their own purge extensions from their plugins (P1-T2: layers, revisions, attribution); these
 * registry tests start from an empty registry: re-registering a name and calling the returned function removes it.
 */
const withoutModuleExtensions = (h: Harness) => {
  for (const e of purgeExtensions(h.ctx)) registerPurgeExtension(h.ctx, { name: e.name, apply: () => undefined })();
};
beforeEach(async () => {
  t = await makeHarness();
  withoutModuleExtensions(t);
  // a table «added later by another module» that references purged pages and versions WITHOUT a cascade
  t.ctx.db.exec(`CREATE TABLE ext_page_mark (
    id TEXT PRIMARY KEY,
    page_id TEXT NOT NULL REFERENCES source_page(id),
    version_id TEXT NOT NULL REFERENCES source_version(id),
    label TEXT NOT NULL
  ) STRICT`);
});
afterEach(async () => {
  await t.close();
});

async function seedSource(name = 'scanned_page.png') {
  const course = await createNode(t, { kind: 'course', title: `Course ${name}` });
  const r = (await uploadOk(t, course.id, [{ name, data: golden(name) }])).results[0]!;
  const page = t.ctx.db.get<{ id: string }>('SELECT id FROM source_page WHERE version_id = ? ORDER BY page_index LIMIT 1', [r.version_id!])!;
  return { course, id: r.source_id!, versionId: r.version_id!, pageId: page.id };
}

const mark = (id: string, s: { pageId: string; versionId: string }) =>
  t.ctx.db.run('INSERT INTO ext_page_mark (id, page_id, version_id, label) VALUES (?, ?, ?, ?)', [id, s.pageId, s.versionId, `mark ${id}`]);
const markIds = () => t.ctx.db.all<{ id: string }>('SELECT id FROM ext_page_mark ORDER BY id').map((r) => r.id);

/** A permanent purge starts from the trash (a second trash call answers 409 and changes nothing). */
const impactOf = async (sourceId: string, mode: 'purge' | 'trash' = 'purge') => {
  if (mode === 'purge') await api(t).post(`/api/sources/${sourceId}/trash`);
  return (await api(t).get(`/api/sources/${sourceId}/impact?mode=${mode}`)).json() as ImpactReport;
};
const purge = (sourceId: string, token: string) => api(t).del(`/api/sources/${sourceId}?confirm_token=${encodeURIComponent(token)}`);

/** The extension a module would register for ext_page_mark. */
function marksExtension(over: Partial<PurgeExtension> = {}): PurgeExtension {
  return {
    name: 'test-marks',
    handledForeignKeys: ['ext_page_mark.page_id', 'ext_page_mark.version_id'],
    count: (ctx, set) => ({
      marks: ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ext_page_mark WHERE page_id IN ${set.in('page')} OR version_id IN ${set.in('version')}`)!.n,
    }),
    linesAr: (c, mode) => (mode === 'purge' && c.marks ? [`علامات مرتبطة بهذه الصفحات: ${c.marks}.`] : []),
    apply: (ctx, set) => {
      const ids = ctx.db.all<{ id: string }>(`SELECT id FROM ext_page_mark WHERE page_id IN ${set.in('page')} OR version_id IN ${set.in('version')}`);
      ctx.db.run(`DELETE FROM ext_page_mark WHERE page_id IN ${set.in('page')} OR version_id IN ${set.in('version')}`);
      return ids.map((r) => ['ext_page_mark', r.id] as const);
    },
    ...over,
  };
}

describe('purge-extension registry (P1-T1 step 0)', () => {
  it('without an extension, an unknown table that still references the purge set aborts the purge and deletes nothing (today’s guard)', async () => {
    const s = await seedSource();
    mark('M1', s);
    const impact = await impactOf(s.id);
    const res = await purge(s.id, impact.confirm_token!);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.details).toMatchObject({ table: 'ext_page_mark' });
    expect((await api(t).get(`/api/sources/${s.id}`)).statusCode).toBe(200);
    expect(markIds()).toEqual(['M1']);
  });

  it('a registered extension counts in the preview, binds the confirm token, deletes its rows in the purge transaction and announces them to sync', async () => {
    registerPurgeExtension(t.ctx, marksExtension());
    const s = await seedSource();
    const other = await seedSource('flowchart.png');
    mark('M1', s);
    mark('M2', other);

    const impact = await impactOf(s.id);
    expect(impact.lines_ar).toContain('علامات مرتبطة بهذه الصفحات: 1.');
    // the trash preview stays the trash preview (the extension chose to add nothing there)
    expect((await impactOf(s.id, 'trash')).lines_ar.join(' ')).not.toContain('علامات');

    // the impact changed after the preview → the token no longer matches, nothing is deleted
    t.ctx.db.run('INSERT INTO ext_page_mark (id, page_id, version_id, label) VALUES (?, ?, ?, ?)', ['M3', s.pageId, s.versionId, 'late']);
    const stale = await purge(s.id, impact.confirm_token!);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('CONFLICT');
    expect(markIds()).toEqual(['M1', 'M2', 'M3']);

    const fresh = await impactOf(s.id);
    expect(fresh.lines_ar).toContain('علامات مرتبطة بهذه الصفحات: 2.');
    const seqBefore = t.ctx.sync.headSeq();
    const res = await purge(s.id, fresh.confirm_token!);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().removed.extensions).toEqual({ 'test-marks': { marks: 2 } });
    expect(markIds()).toEqual(['M2']); // the other source's row is untouched
    expect((await api(t).get(`/api/sources/${s.id}`)).statusCode).toBe(404);
    const announced = t.ctx.db.all<{ entity_id: string }>(`SELECT entity_id FROM sync_change WHERE entity_type = 'ext_page_mark' AND seq > ? ORDER BY entity_id`, [seqBefore]);
    expect(announced.map((r) => r.entity_id)).toEqual(['M1', 'M3']);
  });

  it('an extension that fails rolls the whole purge back (one transaction): the source, its pages and every row stay', async () => {
    registerPurgeExtension(
      t.ctx,
      marksExtension({
        apply: (ctx, set) => {
          ctx.db.run(`DELETE FROM ext_page_mark WHERE page_id IN ${set.in('page')}`);
          throw new AppError('CONFLICT', 'تعذّر حذف بيانات وحدة الاختبار؛ لم يُحذف أي شيء.', 409);
        },
      }),
    );
    const s = await seedSource();
    mark('M1', s);
    const impact = await impactOf(s.id);
    const res = await purge(s.id, impact.confirm_token!);
    expect(res.statusCode).toBe(409);
    expect(markIds()).toEqual(['M1']);
    expect((await api(t).get(`/api/sources/${s.id}`)).statusCode).toBe(200);
    expect(t.ctx.db.get('SELECT 1 AS x FROM source_page WHERE id = ?', [s.pageId])).toBeTruthy();
  });

  it('fill() may add ids to a core purge set (counted and deleted by the core purge)', async () => {
    const s = await seedSource();
    const now = t.clock.now();
    // a note the core purge does not find (it is anchored by something only this module understands)
    t.ctx.db.run(`INSERT INTO note (id, body_json, created_at, updated_at) VALUES ('N-EXT', '{"v":1,"paragraphs":[]}', ?, ?)`, [now, now]);
    t.ctx.db.run('INSERT INTO ext_page_mark (id, page_id, version_id, label) VALUES (?, ?, ?, ?)', ['M1', s.pageId, s.versionId, 'N-EXT']);
    registerPurgeExtension(
      t.ctx,
      marksExtension({
        fill: (ctx, set) => {
          ctx.db.run(`INSERT OR IGNORE INTO ${set.table('note')} (id) SELECT label FROM ext_page_mark WHERE page_id IN ${set.in('page')} AND label IN (SELECT id FROM note)`);
        },
      }),
    );
    const impact = await impactOf(s.id);
    expect(impact.notes).toBe(1);
    const res = await purge(s.id, impact.confirm_token!);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().removed.notes).toBe(1);
    expect(t.ctx.db.get(`SELECT 1 AS x FROM note WHERE id = 'N-EXT'`)).toBeUndefined();
  });

  it('with no extension registered the preview and the purge answer keep today’s shape exactly', async () => {
    const s = await seedSource();
    const impact = await impactOf(s.id);
    expect(Object.keys(impact).sort()).toEqual(['annotations', 'artifacts', 'confirm_token', 'flashcards', 'lines_ar', 'nodes', 'notes', 'pages', 'questions', 'sources', 'versions']);
    const res = await purge(s.id, impact.confirm_token!);
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json().removed).sort()).toEqual(
      ['annotations', 'artifacts', 'attempts', 'external_dependents', 'flashcards', 'note_pages', 'nodes', 'notes', 'pages', 'questions', 'review_events', 'sources', 'threads', 'versions'].sort(),
    );
  });

  it('the registry belongs to one app: re-registering a name replaces it, the returned function unregisters it, another app never sees it', async () => {
    const other = await makeHarness();
    withoutModuleExtensions(other);
    try {
      const off = registerPurgeExtension(t.ctx, marksExtension());
      registerPurgeExtension(t.ctx, marksExtension({ linesAr: () => [] }));
      expect(purgeExtensions(t.ctx).map((e) => e.name)).toEqual(['test-marks']);
      expect(purgeExtensions(other.ctx)).toEqual([]);
      // a second registration with the same name replaced the first; the first one's unregister does not remove it
      off();
      expect(purgeExtensions(t.ctx).map((e) => e.name)).toEqual(['test-marks']);
      const off2 = registerPurgeExtension(t.ctx, marksExtension({ name: 'second' }));
      off2();
      expect(purgeExtensions(t.ctx).map((e) => e.name)).toEqual(['test-marks']);
      expect(() => registerPurgeExtension(t.ctx, marksExtension({ name: '' }))).toThrow();
    } finally {
      await other.close();
    }
  });
});

describe('blob deletion delegated to files/blobs.ts (P1-T1 step 0)', () => {
  it('the purge uses the files module’s function; a stored file is removed only when nothing references it', async () => {
    expect(removeFromPurge).toBe(removeFromBlobs);
    const loose = await t.ctx.files.put(Buffer.from('TEST FIXTURE — unreferenced bytes'), { mime: 'text/plain' });
    const loosePath = t.ctx.files.path(loose.id);
    const s = await seedSource();
    const used = t.ctx.db.get<{ file_id: string }>('SELECT file_id FROM source_version WHERE id = ?', [s.versionId])!.file_id;
    const usedPath = t.ctx.files.path(used);

    expect(removeFromBlobs(t.ctx, used)).toBe(false);
    expect(existsSync(usedPath)).toBe(true);
    expect(t.ctx.files.stat(used)).not.toBeNull();

    expect(removeFromBlobs(t.ctx, loose.id)).toBe(true);
    expect(existsSync(loosePath)).toBe(false);
    expect(t.ctx.files.stat(loose.id)).toBeNull();
    expect(removeFromBlobs(t.ctx, loose.id)).toBe(false); // already gone: a no-op
  });
});
