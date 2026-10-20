// H2 item 10 — the REAL pipeline (upload → processing → extraction) for the question-extraction fixes whose effect
// is in the stored vault: (c) the structured stem joins «38.4 ° C» while the raw keeps it verbatim; (d) a resumed
// extraction reports what THIS job created; (e) the keyed photo records the circle merged with option B as a mark;
// (f) a question stored with a pre-fix fingerprint is re-fingerprinted, so «base excess 8» is not merged into it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { EXTRACT_QUESTIONS_JOB_KIND, richTextToPlain, type ExtractionSummaryView } from '@medlevo/shared';
import { REPO_ROOT } from '../../src/config';
import { sha256 } from '../../src/lib/hash';
import { refingerprintVersions } from '../../src/modules/questions/fingerprints';
import { normPhrase } from '../../src/modules/questions/text';
import { api, createNode, createQuestionsApp, detail, golden, listAll, questionAt, uploadAndProcess, type QApp } from './helpers';

const acc = (name: string) => readFileSync(join(REPO_ROOT, 'fixtures', 'acceptance', name));
const plain = (rt: Parameters<typeof richTextToPlain>[0]) => richTextToPlain(rt);

/** the exact-duplicate fingerprint as it was computed BEFORE the G5 / AC-17 fix (symbols dropped by normPhrase) */
const preFixFingerprint = (stem: string, options: string[]) => sha256(`${normPhrase(stem)}\u0001${options.map(normPhrase).sort().join('\u0002')}`);

const cleanup: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const c of cleanup.reverse()) await c().catch(() => undefined);
});

async function app(): Promise<{ t: QApp; course: string }> {
  const t = await createQuestionsApp();
  cleanup.push(() => t.close());
  return { t, course: (await createNode(t, 'H2 extraction course')).id };
}

describe('c. «38.4 ° C» — structured stem joined, raw verbatim (Word → LibreOffice Arabic question)', () => {
  it('the stored stem reads «38.4 °C»; the raw extraction keeps what the PDF text layer gave', async () => {
    const { t, course } = await app();
    const ar = await uploadAndProcess(t, course, 'g4_long_question_ar.pdf', acc('g4_long_question_ar.pdf'), 'question_source', 'H2 Arabic long question');
    const d = await detail(t, questionAt(t, ar.sourceId, '', '2'));
    const raw = d.question.current.stem_raw ?? '';
    expect(raw).toMatch(/38\.4 ° C/); // what LibreOffice's text layer holds (line split inside «°C»)
    expect(plain(d.question.current.stem)).toContain('38.4 °C');
    expect(plain(d.question.current.stem)).not.toMatch(/° C/);
    expect(d.question.current.extraction_status).toBe('checks_passed'); // numbers / units of raw and structured agree
  }, 240_000);
});

describe('d. a resumed extraction reports the questions this job created', () => {
  async function run(crash: boolean): Promise<ExtractionSummaryView> {
    const { t, course } = await app();
    await uploadAndProcess(t, course, 'questions_surgery_course1.pdf', golden('questions_surgery_course1.pdf'), 'question_source', 'Surgery Course 1 Questions');
    let fired = 0;
    const db = t.ctx.db as unknown as { run: (sql: string, params?: unknown) => unknown };
    const orig = db.run.bind(db);
    if (crash) {
      // a power loss right after the extraction committed, before its checkpoint row is written
      db.run = (sql: string, params?: unknown) => {
        if (fired === 0 && sql.trimStart().startsWith('INSERT INTO job_checkpoint') && Array.isArray(params) && params[1] === 'extract') {
          fired++;
          throw new Error('simulated power loss');
        }
        return orig(sql, params);
      };
    }
    const prev = await uploadAndProcess(t, course, 'questions_previous_exam_2024.pdf', golden('questions_previous_exam_2024.pdf'), 'previous_exam', 'Previous exam 2024');
    db.run = orig;
    if (crash) expect(fired).toBe(1);
    const job = t.ctx.jobs.list({ kind: EXTRACT_QUESTIONS_JOB_KIND, limit: 10 }).jobs.map((j) => t.ctx.jobs.get(j.id)!).find((j) => (j.input as { version_id: string }).version_id === prev.versionId)!;
    expect(job.attempts).toBe(crash ? 2 : 1);
    return (await api(t).get(`/api/questions/extractions/${prev.versionId}`)).json().summary as ExtractionSummaryView;
  }

  it('new / already-in-the-vault counts equal those of an uninterrupted run', async () => {
    const clean = await run(false);
    const resumed = await run(true);
    expect(clean.new_questions).toBeGreaterThan(0);
    expect(clean.exact_duplicates_attached).toBeGreaterThan(0);
    expect({ n: resumed.new_questions, a: resumed.exact_duplicates_attached, msg: resumed.message_ar }).toEqual({ n: clean.new_questions, a: clean.exact_duplicates_attached, msg: clean.message_ar });
  }, 480_000);
});

describe('e. the keyed question photo: the circle read with «B» is an unofficial mark on option B', () => {
  it('four options, the printed key C, the circle on B recorded as a mark (never a key), held for review', async () => {
    const { t, course } = await app();
    const s = await uploadAndProcess(t, course, 'g3_photo_circled_with_key.png', acc('g3_photo_circled_with_key.png'), 'question_source', 'H2 keyed photo');
    const [q] = await listAll(t, `source_id=${s.sourceId}`);
    const d = await detail(t, q!.id);
    expect(d.question.current.options.map((o) => o.source_label)).toEqual(['A', 'B', 'C', 'D']);
    expect(d.question.current.answer_status).toBe('source_key');
    expect(d.key_entries.map((k) => [k.mark_kind, k.key_label, k.origin_known, k.binding]).sort()).toEqual(
      [
        ['circled_option', 'B', false, 'unofficial'],
        ['printed_key', 'C', true, 'bound'],
      ].sort(),
    );
    expect(d.question.current.extraction_status).toBe('needs_review'); // the circled line is a weak OCR reading
    expect(d.scorable).toBe(false);
  }, 240_000);
});

describe('f. questions stored with a pre-fix fingerprint are re-fingerprinted', () => {
  it('«base excess −8» stored before the fix is not merged with a later «base excess 8» from another file', async () => {
    const { t, course } = await app();
    const a = await uploadAndProcess(t, course, 'g5_signs_a.pdf', acc('g5_signs_a.pdf'), 'question_source', 'Signs A');
    const minus = questionAt(t, a.sourceId, '', '1');
    // the vault as a server before the G5 fix left it: pre-fix fingerprints, marked by migration 0530 as algo 1
    for (const v of t.ctx.db.all<{ id: string; stem_json: string }>('SELECT id, stem_json FROM question_version')) {
      const stem = richTextToPlain(JSON.parse(v.stem_json));
      const opts = t.ctx.db.all<{ text_json: string }>('SELECT text_json FROM question_option WHERE question_version_id = ? ORDER BY ord', [v.id]).map((o) => richTextToPlain(JSON.parse(o.text_json)));
      t.ctx.db.run('UPDATE question_version SET fingerprint = ?, fingerprint_algo = 1 WHERE id = ?', [preFixFingerprint(stem, opts), v.id]);
    }
    // boot of the new server: the module recomputes them
    expect(refingerprintVersions(t.ctx)).toBeGreaterThan(0);
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM question_version WHERE fingerprint_algo < 2')!.n).toBe(0);
    expect(refingerprintVersions(t.ctx)).toBe(0); // idempotent
    const b = await uploadAndProcess(t, course, 'g5_signs_b.pdf', acc('g5_signs_b.pdf'), 'question_source', 'Signs B');
    const plus = questionAt(t, b.sourceId, '', '1');
    expect(plus).not.toBe(minus);
    expect((await detail(t, minus)).question.current.answer_status).toBe('source_key');
    expect((await detail(t, plus)).question.current.answer_status).toBe('source_key');
  }, 240_000);
});
