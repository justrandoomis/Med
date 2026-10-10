// Course Brain test helpers. Synthetic TEST lectures are written as rows (source → version → pages → regions, the same
// contract the processing pipeline fulfils) so relation / decision tests do not depend on PDF processing; the Golden
// Set test uses the real pipeline. Texts are generic teaching-style TEST sentences, never medical reference material.
import type { LibraryNodeView } from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import type { AuthHeaders, TestApp } from '../helpers/app';
import { createTestApp } from '../helpers/app';

export interface BApp extends TestApp {
  h: AuthHeaders;
}

export async function brainApp(): Promise<BApp> {
  const t = await createTestApp({ jobs: { backoffBaseMs: 0, backoffMaxMs: 0 } });
  const h = await t.login();
  return Object.assign(t, { h });
}

export function call(t: BApp) {
  const go = async (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => t.app.inject({ method, url, headers: t.h, payload: payload as never });
  return {
    get: (url: string) => go('GET', url),
    post: (url: string, payload: unknown = {}) => go('POST', url, payload),
    patch: (url: string, payload: unknown) => go('PATCH', url, payload),
    del: (url: string) => go('DELETE', url),
    ok: async <T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown): Promise<T> => {
      const res = await go(method, url, payload);
      if (res.statusCode !== 200) throw new Error(`${method} ${url} → ${res.statusCode} ${res.body}`);
      return res.json() as T;
    },
  };
}

export async function createCourse(t: BApp, title: string): Promise<LibraryNodeView> {
  const nb = await call(t).ok<{ node: LibraryNodeView }>('POST', '/api/library/nodes', { parent_id: null, kind: 'notebook', title: `${title} notebook` });
  return (await call(t).ok<{ node: LibraryNodeView }>('POST', '/api/library/nodes', { parent_id: nb.node.id, kind: 'course', title })).node;
}

export interface RegionSpec {
  kind: string;
  text: string;
  structure?: unknown;
}

export interface InsertedLecture {
  sourceId: string;
  versionId: string;
  pageIds: string[];
  regionIds: string[][];
}

/** A processed TEST lecture (status ready) with the given pages of regions, placed in the course. */
export function insertLecture(t: BApp, courseId: string, title: string, pages: RegionSpec[][], opts: { sourceType?: string; sortOrder?: number } = {}): InsertedLecture {
  const { ctx } = t;
  const now = ctx.clock.now();
  const sourceId = newId(now);
  const versionId = newId(now);
  const pageIds: string[] = [];
  const regionIds: string[][] = [];
  ctx.db.tx(() => {
    ctx.db.run(
      `INSERT INTO source (id, title, source_type, node_id, course_node_id, processing_status, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'ready', ?, ?, ?)`,
      [sourceId, title, opts.sourceType ?? 'lecture', courseId, courseId, opts.sortOrder ?? now, now, now],
    );
    ctx.db.run(
      `INSERT INTO source_version (id, source_id, version_no, kind, content_hash, mime, file_name, format, page_count, processing_status, created_at)
       VALUES (?, ?, 1, 'original', ?, 'application/pdf', ?, 'pdf', ?, 'ready', ?)`,
      [versionId, sourceId, newId(now), `${title}.pdf`, pages.length, now],
    );
    ctx.db.run('UPDATE source SET current_version_id = ? WHERE id = ?', [versionId, sourceId]);
    pages.forEach((regions, i) => {
      const pageId = newId(now);
      pageIds.push(pageId);
      ctx.db.run(
        `INSERT INTO source_page (id, version_id, page_index, kind, text_status, processing_status, created_at, updated_at) VALUES (?, ?, ?, 'page', 'digital', 'ready', ?, ?)`,
        [pageId, versionId, i, now, now],
      );
      const ids: string[] = [];
      regions.forEach((r, j) => {
        const rid = newId(now);
        ids.push(rid);
        ctx.db.run(
          `INSERT INTO source_region (id, version_id, page_id, kind, reading_order, text, text_origin, structure_json, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'digital', ?, 'extracted', ?, ?)`,
          [rid, versionId, pageId, r.kind, j, r.text, r.structure ? JSON.stringify(r.structure) : null, now, now],
        );
      });
      regionIds.push(ids);
    });
  });
  return { sourceId, versionId, pageIds, regionIds };
}

/** POST /api/brain/extract for one source and run the jobs. */
export async function extract(t: BApp, sourceId: string): Promise<void> {
  const res = await call(t).post('/api/brain/extract', { source_id: sourceId });
  if (res.statusCode !== 200) throw new Error(`extract failed ${res.statusCode} ${res.body}`);
  await t.ctx.jobs.drain();
}

export function conceptByName(t: BApp, name: string): { id: string; status: string; merged_into_id: string | null; name_en: string | null; name_ar: string | null } | undefined {
  return t.ctx.db.get(`SELECT id, status, merged_into_id, name_en, name_ar FROM concept WHERE name_en = ? OR name_ar = ?`, [name, name]);
}
