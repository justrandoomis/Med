// Regression (I2 performance pass, docs/PERFORMANCE.md): «questions of this source» lookups must use one index probe
// per question, not a rescan of every occurrence of the source. Without migration 0510 SQLite (no ANALYZE stats) drove
// `o.question_id = q.id AND o.source_id = ?` through idx_question_occurrence_source — measured 0.9–1.1 s per statement
// on a 2 000-question bank. The statements below mirror the WHERE shapes used by the code:
//   questions/routes.ts  GET /api/questions?source_id=…            (count + page)
//   questions/service.ts listForExam({ sourceIds })                  (exam / practice candidates)
//   search/service.ts    universal search, questions with source_id
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/app';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

function plan(sql: string, params: unknown[]): string {
  return t.ctx.db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, params).map((r) => r.detail).join(' | ');
}

const SHAPES: Array<[string, string, unknown[]]> = [
  [
    'Question Vault list filtered by source',
    `SELECT COUNT(*) AS n FROM question q JOIN question_version v ON v.id = q.current_version_id
      WHERE q.deleted_at IS NULL AND q.current_version_id IS NOT NULL AND q.status <> 'retired'
        AND EXISTS (SELECT 1 FROM question_occurrence o WHERE o.question_id = q.id AND o.source_id = ?)`,
    ['SRC'],
  ],
  [
    'exam candidates by source',
    `SELECT q.id FROM question q JOIN question_version v ON v.id = q.current_version_id
      WHERE q.deleted_at IS NULL AND q.status IN ('ready','needs_review')
        AND EXISTS (SELECT 1 FROM question_occurrence o WHERE o.question_id = q.id AND o.source_id IN (?, ?))`,
    ['SRC', 'SRC2'],
  ],
  [
    'universal search, questions of one source',
    `SELECT f.question_id FROM question_fts f JOIN question q ON q.id = f.question_id
      WHERE question_fts MATCH ? AND EXISTS (SELECT 1 FROM question_occurrence o JOIN source s ON s.id = o.source_id WHERE o.question_id = q.id AND s.id = ?)`,
    ['fixture', 'SRC'],
  ],
];

describe('question ↔ source occurrence lookups', () => {
  it('has the composite (question_id, source_id) index', () => {
    const idx = t.ctx.db.get<{ sql: string }>(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_question_occurrence_q_source'`);
    expect(idx?.sql).toMatch(/question_occurrence\s*\(\s*question_id\s*,\s*source_id\s*\)/);
  });

  it.each(SHAPES)('%s: one index probe per question, never a rescan of the source', (_label, sql, params) => {
    const p = plan(sql, params);
    expect(p).toContain('idx_question_occurrence_q_source (question_id=? AND source_id=?)');
    expect(p).not.toMatch(/SEARCH o USING INDEX idx_question_occurrence_source/);
  });
});
