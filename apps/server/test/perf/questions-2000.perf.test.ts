// PERF (MEDLEVO_PERF=1): a 2 000-question bank (20 sections × 100, answer key per section) through the REAL upload
// API → processing → question extraction (+ the lecture-matching follow-up) → Question Vault list / search / detail.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LibraryNodeView, QuestionListResponse, UploadResponse } from '@medlevo/shared';
import type { AuthHeaders, TestApp } from '../helpers/app';
import { createProcessingApp } from '../processing/helpers';
import { multipart } from '../sources/helpers';
import { PERF_ENABLED, questionBankPdf } from './fixtures';
import { latency, report, withMemory } from './measure';

const COUNT = Number(process.env.MEDLEVO_PERF_QUESTIONS || 2000);

describe.skipIf(!PERF_ENABLED)(`perf: ${COUNT}-question bank`, () => {
  let t: TestApp;
  let h: AuthHeaders;
  beforeAll(async () => {
    t = await createProcessingApp();
    t.clock.now = () => Date.now();
    h = await t.login();
  }, 120_000);
  afterAll(async () => {
    await t?.close();
  });

  it('extracts, keys and serves the questions', async () => {
    const bank = await questionBankPdf(COUNT);
    const node = await t.app.inject({ method: 'POST', url: '/api/library/nodes', headers: h, payload: { parent_id: null, kind: 'course', title: 'Perf questions' } });
    const nodeId = (node.json() as { node: LibraryNodeView }).node.id;
    const body = multipart({ node_id: nodeId, source_type: 'question_source', title: 'Perf question bank (TEST FIXTURE)' }, [{ name: 'perf-bank.pdf', data: bank.data }]);
    const res = await t.app.inject({ method: 'POST', url: '/api/sources/upload', headers: { ...h, 'content-type': body.contentType }, payload: body.payload });
    expect(res.statusCode).toBe(200);
    const r = (res.json() as UploadResponse).results[0]!;
    expect(r.status).toBe('accepted');

    const run = await withMemory(() => t.ctx.jobs.drain());
    const db = t.ctx.db;
    const jobs = db.all<{ kind: string; status: string; ms: number; attempts: number }>(
      `SELECT kind, status, finished_at - started_at AS ms, attempts FROM processing_job ORDER BY created_at, id`,
    );
    const pages = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM source_page WHERE version_id = ?', [r.version_id])!.n;
    const n = (sql: string) => db.get<{ n: number }>(sql)!.n;
    const counts = {
      questions: n('SELECT COUNT(*) AS n FROM question'),
      occurrences: n('SELECT COUNT(*) AS n FROM question_occurrence'),
      options: n('SELECT COUNT(*) AS n FROM question_option'),
      keys: n('SELECT COUNT(*) AS n FROM answer_key_entry'),
      keys_bound: n(`SELECT COUNT(*) AS n FROM answer_key_entry WHERE binding = 'bound'`),
      fts_rows: n('SELECT COUNT(*) AS n FROM question_fts'),
      open_review_items: n(`SELECT COUNT(*) AS n FROM review_queue_item WHERE status = 'open' AND json_extract(details_json, '$.origin') = 'questions'`),
    };
    // the bank is what it says: (close to) every printed question became one question
    expect(counts.questions).toBeGreaterThanOrEqual(COUNT * 0.95);

    const get = (url: string) =>
      t.app.inject({ method: 'GET', url, headers: h }).then((x) => {
        if (x.statusCode !== 200) throw new Error(`${url} → ${x.statusCode}: ${x.body}`);
        return x.json();
      });
    const first = (await get('/api/questions?limit=50')) as QuestionListResponse;
    const ids = first.items.map((i) => i.id);
    const lastPage = await latency(20, () => get(`/api/questions?limit=50&cursor=${Math.max(0, counts.questions - 50)}`));
    const listFirst = await latency(20, () => get('/api/questions?limit=50'));
    const listBySource = await latency(20, () => get(`/api/questions?limit=50&source_id=${r.source_id}`));
    const listSearch = await latency(20, (i) => get(`/api/questions?limit=50&q=${encodeURIComponent(['fixture question 1500', 'mmol', 'NOT', 'خيار تجريبي'][i % 4]!)}`));
    const universal = await latency(20, (i) => get(`/api/search?types=questions&limit=20&q=${encodeURIComponent(['fixture question', 'option C', 'القيمة التجريبية'][i % 3]!)}`));
    const detail = await latency(20, (i) => get(`/api/questions/${ids[i % ids.length]}`));

    report('questions-2000', {
      scenario: `${COUNT} MCQs in ${bank.sections} sections (numbering restarts per section, A–D / أ–د options, NOT/EXCEPT stems, per-section answer key)`,
      file_mb: Math.round((bank.data.length / 1024 / 1024) * 100) / 100,
      pages,
      jobs,
      drain_ms: Math.round(run.ms),
      memory: run.mem,
      counts,
      api_ms: { list_first_page: listFirst, list_last_page: lastPage, list_by_source: listBySource, list_fts_search: listSearch, universal_search_questions: universal, question_detail: detail },
    });
  }, 60 * 60_000);
});
