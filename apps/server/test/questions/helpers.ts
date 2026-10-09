// Question Vault test helpers: a test app with the REAL processing pipeline (+ questions hook), uploads through
// the real sources API into library nodes, and lookups of extracted questions by (source, section, number).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LibraryNodeView, QuestionListItem, QuestionView, UploadResponse } from '@medlevo/shared';
import type { AuthHeaders, TestApp } from '../helpers/app';
import { createProcessingApp, FIXTURES as GOLDEN } from '../processing/helpers';
import { multipart } from '../sources/helpers';

export const LOCAL = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
export const golden = (name: string) => readFileSync(join(GOLDEN, name));
export const local = (name: string) => readFileSync(join(LOCAL, name));

export interface QApp extends TestApp {
  h: AuthHeaders;
}

export async function createQuestionsApp(): Promise<QApp> {
  const t = await createProcessingApp();
  const h = await t.login();
  return Object.assign(t, { h });
}

export function api(t: QApp) {
  const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => t.app.inject({ method, url, headers: t.h, payload: payload as never });
  return {
    get: (url: string) => call('GET', url),
    post: (url: string, payload: unknown = {}) => call('POST', url, payload),
    patch: (url: string, payload: unknown) => call('PATCH', url, payload),
  };
}

export async function createNode(t: QApp, title: string, kind = 'course'): Promise<LibraryNodeView> {
  const res = await t.app.inject({ method: 'POST', url: '/api/library/nodes', headers: t.h, payload: { parent_id: null, kind, title } });
  if (res.statusCode !== 200) throw new Error(`create node failed: ${res.statusCode} ${res.body}`);
  return (res.json() as { node: LibraryNodeView }).node;
}

/** Upload through the real sources API (content sniffing, version, processing job) and run every job. */
export async function uploadAndProcess(t: QApp, nodeId: string, name: string, data: Buffer, sourceType: string, title = name): Promise<{ sourceId: string; versionId: string }> {
  const body = multipart({ node_id: nodeId, source_type: sourceType, title, on_duplicate: 'create' }, [{ name, data }]);
  const res = await t.app.inject({ method: 'POST', url: '/api/sources/upload', headers: { ...t.h, 'content-type': body.contentType }, payload: body.payload });
  if (res.statusCode !== 200) throw new Error(`upload failed: ${res.statusCode} ${res.body}`);
  const r = (res.json() as UploadResponse).results[0]!;
  if (r.status !== 'accepted') throw new Error(`upload not accepted: ${JSON.stringify(r)}`);
  await t.ctx.jobs.drain();
  return { sourceId: r.source_id!, versionId: r.version_id! };
}

export async function listAll(t: QApp, query = ''): Promise<QuestionListItem[]> {
  const res = await api(t).get(`/api/questions?limit=200${query ? `&${query}` : ''}`);
  if (res.statusCode !== 200) throw new Error(`list failed: ${res.statusCode} ${res.body}`);
  return (res.json() as { items: QuestionListItem[] }).items;
}

/** The question whose occurrence in `sourceId` has (section, number). */
export function questionAt(t: QApp, sourceId: string, section: string, n: string): string {
  const row = t.ctx.db.get<{ question_id: string }>(
    'SELECT question_id FROM question_occurrence WHERE source_id = ? AND section_key = ? AND printed_number = ?',
    [sourceId, section, n],
  );
  if (!row) throw new Error(`no question ${section}/${n} in ${sourceId}`);
  return row.question_id;
}

export async function detail(t: QApp, id: string) {
  const res = await api(t).get(`/api/questions/${id}`);
  if (res.statusCode !== 200) throw new Error(`detail failed: ${res.statusCode} ${res.body}`);
  return res.json() as import('@medlevo/shared').QuestionDetailResponse;
}

export function correctTexts(q: QuestionView): string[] {
  const ids = q.current.correct_option_ids ?? [];
  return q.current.options.filter((o) => ids.includes(o.id)).map((o) => o.text.paragraphs.map((p) => p.runs.map((r) => r.t).join('')).join('\n'));
}

export function counts(t: QApp): Record<string, number> {
  const n = (sql: string) => t.ctx.db.get<{ n: number }>(sql)!.n;
  return {
    questions: n('SELECT COUNT(*) AS n FROM question'),
    versions: n('SELECT COUNT(*) AS n FROM question_version'),
    options: n('SELECT COUNT(*) AS n FROM question_option'),
    occurrences: n('SELECT COUNT(*) AS n FROM question_occurrence'),
    keys: n('SELECT COUNT(*) AS n FROM answer_key_entry'),
    fts: n('SELECT COUNT(*) AS n FROM question_fts'),
    open_review: n(`SELECT COUNT(*) AS n FROM review_queue_item WHERE status = 'open' AND json_extract(details_json, '$.origin') = 'questions'`),
    duplicates: n('SELECT COUNT(*) AS n FROM question_duplicate'),
  };
}
