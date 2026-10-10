// G7 — AC-25 «انقطاع أثناء job»: after an interruption, a retry resumes from the right checkpoint without creating
// duplicate questions and without publishing a cut-off explanation.
//
// Two kinds of interruption are simulated against the REAL jobs (Golden Set sources processed by the real pipeline):
//  * a POWER LOSS between a step's commit and its checkpoint: the checkpoint write throws exactly there, so nothing
//    after the committed step runs on that attempt (the queue re-queues the job, as `requeueStale` does after a crash);
//  * a FROZEN / KILLED PROCESS in the middle of a step: the job's handler stops forever at that point (no catch block,
//    no cleanup runs), then a SECOND app instance — a new process boot with the same pid and another boot nonce, like a
//    restarted container — is opened on the same data directory, re-queues the orphaned job at once and finishes it.
// AI paths use the TEST-ONLY scripted providers (no key exists here; never registered in production).
import { afterAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { EXTRACT_QUESTIONS_JOB_KIND, type GenerateQuestionsResponse, type StudyBookView } from '@medlevo/shared';
import { buildApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import type { AiProvider, ProviderRequest, ProviderResponse } from '../../src/modules/ai/types';
import { ProviderError } from '../../src/modules/ai/types';
import { MODULES, type ModuleEntry } from '../../src/modules';
import { createProcessingModule } from '../../src/modules/processing';
import { createStudybookModule, type StudybookModuleOptions } from '../../src/modules/studybook';
import { planStudyBookSections } from '../../src/modules/studybook/book';
import { aliasWith, allSupported, pageId, ScriptedAi as ExamAi } from '../exams/helpers';
import { createClock, createTestApp, TEST_ORIGIN, type TestApp } from '../helpers/app';
import { addSource, processVersion } from '../processing/helpers';
import { createNode, golden, uploadAndProcess, type QApp } from '../questions/helpers';
import { content, lectureOnly, regionsIn, S, ScriptedAi as BookAi } from '../studybook/helpers';

const cleanup: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const c of cleanup.reverse()) await c().catch(() => undefined);
});

// ───────── interruption tools ─────────
interface Crash {
  /** how many times the simulated power loss fired */
  fired(): number;
  restore(): void;
}

/** Power loss right after a step committed, before its checkpoint row is written (once, for matching step keys). */
function powerLossBeforeCheckpoint(t: TestApp, match: (stepKey: string) => boolean): Crash {
  const db = t.ctx.db as unknown as { run: (sql: string, params?: unknown) => unknown };
  const orig = db.run.bind(db);
  let fired = 0;
  db.run = (sql: string, params?: unknown) => {
    if (fired === 0 && sql.trimStart().startsWith('INSERT INTO job_checkpoint') && Array.isArray(params) && match(String(params[1]))) {
      fired++;
      throw new Error('simulated power loss: the step committed, its checkpoint was never written');
    }
    return orig(sql, params);
  };
  return { fired: () => fired, restore: () => void (db.run = orig) };
}

/** A gate a hook / provider can stop at forever (the process «freezes» there); `reached` resolves when it is entered. */
function freezePoint() {
  let enter!: () => void;
  const reached = new Promise<void>((r) => (enter = r));
  return {
    reached,
    freeze(): Promise<never> {
      enter();
      return new Promise<never>(() => undefined); // never settles: no catch / finally of the job ever runs
    },
  };
}

/** A second boot on the same data directory (same pid, new boot nonce — like a restarted container). */
async function reopen(dataDir: string, ai: AiProvider | null, modules: ModuleEntry[]): Promise<FastifyInstance> {
  const config = loadConfig({ NODE_ENV: 'test', MEDLEVO_DATA_DIR: dataDir, MEDLEVO_ORIGIN: TEST_ORIGIN, MEDLEVO_LOG_LEVEL: 'silent', MEDLEVO_SCRYPT_LOG_N: '12' });
  const app = await buildApp({ config, overrides: { clock: createClock(), aiProvider: ai, jobs: JOBS }, modules });
  await app.ready();
  return app;
}

/** jobs re-try at once; a stopped process gives a frozen handler only 20 ms (the queue accepts the option; the test helper type does not list it) */
const JOBS = { backoffBaseMs: 0, backoffMaxMs: 0, shutdownGraceMs: 20 } as { backoffBaseMs: number; backoffMaxMs: number };

const processingModules = (extra: (m: ModuleEntry) => ModuleEntry = (m) => m): ModuleEntry[] =>
  MODULES.map((m) => (m.name === 'processing' ? { ...m, plugin: createProcessingModule({}) } : extra(m)));

const count = (t: { ctx: TestApp['ctx'] }, sql: string, params: unknown[] = []) => t.ctx.db.get<{ n: number }>(sql, params)!.n;

// ───────── 1. question extraction ─────────
describe('AC-25 question extraction: a power loss after the vault was written never duplicates a question', () => {
  async function vault(crash: boolean) {
    const t = await createTestApp({ modules: processingModules(), jobs: { backoffBaseMs: 0, backoffMaxMs: 0 } });
    cleanup.push(() => t.close());
    const h = await t.login();
    const q = Object.assign(t, { h }) as QApp;
    const course = (await createNode(q, 'Surgery Course 1')).id;
    await uploadAndProcess(q, course, 'lecture_appendicitis.pdf', golden('lecture_appendicitis.pdf'), 'lecture', 'Acute Appendicitis (TEST FIXTURE)');
    const c1 = await uploadAndProcess(q, course, 'questions_surgery_course1.pdf', golden('questions_surgery_course1.pdf'), 'question_source', 'Surgery Course 1 Questions');
    // the previous exam holds an exact duplicate of A1 (attached, never a new question) and a near-duplicate of A2
    const power = crash ? powerLossBeforeCheckpoint(t, (k) => k === 'extract') : null;
    const prev = await uploadAndProcess(q, course, 'questions_previous_exam_2024.pdf', golden('questions_previous_exam_2024.pdf'), 'previous_exam', 'Previous exam 2024');
    await t.ctx.jobs.drain();
    power?.restore();
    const job = t.ctx.jobs.list({ kind: EXTRACT_QUESTIONS_JOB_KIND, limit: 10 }).jobs.map((j) => t.ctx.jobs.get(j.id)!).find((j) => (j.input as { version_id: string }).version_id === prev.versionId)!;
    const occ = t.ctx.db.all<{ k: string }>(
      `SELECT s.title || '|' || o.section_key || '|' || COALESCE(o.item_key, o.printed_number, '') AS k FROM question_occurrence o JOIN source s ON s.id = o.source_id ORDER BY k`,
    );
    const snapshot = {
      questions: count(t, 'SELECT COUNT(*) AS n FROM question'),
      versions: count(t, 'SELECT COUNT(*) AS n FROM question_version'),
      options: count(t, 'SELECT COUNT(*) AS n FROM question_option'),
      occurrences: occ.map((o) => o.k),
      keys: count(t, 'SELECT COUNT(*) AS n FROM answer_key_entry'),
      lecture_links: count(t, 'SELECT COUNT(*) AS n FROM question_lecture_link'),
      duplicate_suggestions: t.ctx.db.all<{ kind: string }>('SELECT kind FROM question_duplicate ORDER BY kind').map((r) => r.kind),
      open_review_items: t.ctx.db.all<{ kind: string }>("SELECT kind FROM review_queue_item WHERE status = 'open' ORDER BY kind").map((r) => r.kind),
      matched_jobs: t.ctx.jobs.list({ kind: 'match_questions', limit: 50 }).jobs.length,
    };
    return { t, q, c1, prev, job, power, snapshot };
  }

  it('the extraction job resumes after the power loss; the vault equals the vault of an uninterrupted run', async () => {
    const clean = await vault(false);
    const crashed = await vault(true);
    expect(crashed.power!.fired(), 'the simulated power loss really happened').toBe(1);
    expect(crashed.job.status).toBe('completed');
    expect(crashed.job.attempts).toBe(2);
    expect(clean.job.attempts).toBe(1);
    // the same questions, versions, options, occurrences (one per printed item), keys, links, review items
    expect(crashed.snapshot).toEqual(clean.snapshot);
    expect(new Set(crashed.snapshot.occurrences).size).toBe(crashed.snapshot.occurrences.length);
    // and the near-duplicate of A2 is suggested on the resumed run too (never merged)
    expect(clean.snapshot.duplicate_suggestions.length).toBeGreaterThan(0);
  }, 300_000);
});

// ───────── 2. Study Book ─────────
function bookGenerator(req: ProviderRequest) {
  const regions = regionsIn(req.prompt);
  const blocks: unknown[] = [{ kind: 'heading', sentences: [S.n('قسم من كتاب الدراسة')] }];
  for (const r of regions) {
    if (!r.alias) continue;
    const quote = r.text.replace(/^\[E\d+\] \[R\d+\]\n/, '');
    const first = (quote.split(/(?<=[.!?؟])\s+/)[0] ?? '').trim().slice(0, 220);
    if (!first) continue;
    blocks.push({ kind: 'paragraph', sentences: [S.c(first, [r.alias], 'directly_stated')], explains_regions: [r.region] });
  }
  return content(blocks);
}

describe('AC-25 Study Book: a process killed mid-section never publishes the cut-off section; the restart regenerates only it', () => {
  const studyModules = (opts: StudybookModuleOptions) => processingModules((m) => (m.name === 'studybook' ? { ...m, plugin: createStudybookModule(opts) } : m));
  let t: TestApp;
  let h: Awaited<ReturnType<TestApp['login']>>;
  let lecture: { sourceId: string; versionId: string };
  let app2: FastifyInstance;
  let ai2: BookAi;
  let bookId: string;
  const frozen = freezePoint();
  let freezeOn: number | null = 1; // ord of the section the first process dies in

  it('process 1 generates sections, then dies while writing section 2 — the book is still «generating», the half section invisible', async () => {
    const ai1 = new BookAi();
    ai1.always('study_book', bookGenerator);
    t = await createTestApp({
      ai: ai1,
      modules: studyModules({
        hooks: {
          beforeSectionPublish: async ({ artifactId, sectionKey }) => {
            const sec = t.ctx.db.get<{ ord: number }>('SELECT ord FROM artifact_section WHERE artifact_id = ? AND section_key = ?', [artifactId, sectionKey])!;
            if (freezeOn !== null && sec.ord === freezeOn) await frozen.freeze();
          },
        },
      }),
      jobs: JOBS,
    });
    cleanup.push(() => t.close());
    lecture = await addSource(t, 'lecture_appendicitis.pdf', 'pdf', { sourceType: 'lecture', title: 'Acute Appendicitis (TEST FIXTURE)' });
    expect(['completed', 'partial']).toContain((await processVersion(t, lecture.versionId)).status);
    h = await t.login();
    const plans = planStudyBookSections(t.ctx, lecture.versionId);
    expect(plans.length).toBeGreaterThan(2);

    const res = await t.app.inject({ method: 'POST', url: '/api/studybook/books', headers: h, payload: { source_id: lecture.sourceId, scope: { mode: 'lecture_only', lecture_source_id: lecture.sourceId } } });
    expect(res.statusCode, res.body).toBe(200);
    bookId = (res.json() as { book: StudyBookView }).book.artifact.id;
    void t.ctx.jobs.drain().catch(() => undefined);
    await frozen.reached;

    // what the owner sees while the job is stuck there
    const v = (await t.app.inject({ method: 'GET', url: `/api/studybook/books/${bookId}`, headers: h })).json() as StudyBookView;
    expect(v.artifact.status).toBe('generating');
    const cut = v.sections.find((s) => s.ord === 1)!;
    expect(cut.status).toBe('generating');
    expect(cut.block_count).toBe(0);
    expect(v.artifact.blocks.filter((b) => b.section_key === cut.section_key)).toEqual([]);
    expect(v.sections.find((s) => s.ord === 0)!.status).toBe('complete');
    expect(ai1.callsFor('study_book').length).toBe(2); // section 1 was generated, never written
  }, 300_000);

  it('process 2 boots on the same data: the orphaned job is re-queued at once; only the cut section (and the ones after it) are generated', async () => {
    freezeOn = null;
    ai2 = new BookAi();
    ai2.always('study_book', bookGenerator);
    app2 = await reopen(t.dataDir, ai2, studyModules({}));
    cleanup.unshift(() => app2.close()); // closed before process 1 (whose close removes the data dir)
    expect(app2.ctx.jobs.requeueStale()).toBe(1);
    await app2.ctx.jobs.drain();
    const login = await app2.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-medlevo-csrf': '1' }, payload: { username: 'owner', password: 'test-password-123' } });
    const h2 = { cookie: String(login.headers['set-cookie']).split(';')[0]!, 'x-medlevo-csrf': '1' };
    const v = (await app2.inject({ method: 'GET', url: `/api/studybook/books/${bookId}`, headers: h2 })).json() as StudyBookView;
    expect(v.artifact.status).toBe('published');
    expect(v.progress).toMatchObject({ sections_complete: v.sections.length, sections_failed: 0 });
    // section 0 was finished before the crash: never generated again
    expect(ai2.callsFor('study_book').length).toBe(v.sections.length - 1);
    // no duplicated block, every section's blocks match its count, every block in order and complete
    const keys = v.artifact.blocks.map((b) => b.block_key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const s of v.sections) {
      expect(s.status).toBe('complete');
      expect(v.artifact.blocks.filter((b) => b.section_key === s.section_key).length).toBe(s.block_count);
    }
    expect(count(app2, 'SELECT COUNT(*) AS n FROM content_block WHERE artifact_id = ?', [bookId])).toBe(keys.length);
  }, 300_000);

  it('a power loss right after a section was written (before its checkpoint): that section is not generated twice', async () => {
    const power = powerLossBeforeCheckpoint({ ctx: app2.ctx } as TestApp, (k) => k.startsWith('section:'));
    const login = await app2.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-medlevo-csrf': '1' }, payload: { username: 'owner', password: 'test-password-123' } });
    const h2 = { cookie: String(login.headers['set-cookie']).split(';')[0]!, 'x-medlevo-csrf': '1' };
    const before = ai2.callsFor('study_book').length;
    const res = await app2.inject({ method: 'POST', url: '/api/studybook/books', headers: h2, payload: { source_id: lecture.sourceId, scope: { mode: 'lecture_only', lecture_source_id: lecture.sourceId }, regenerate: true } });
    expect(res.statusCode, res.body).toBe(200);
    const id = (res.json() as { book: StudyBookView }).book.artifact.id;
    await app2.ctx.jobs.drain();
    power.restore();
    expect(power.fired()).toBe(1);
    const v = (await app2.inject({ method: 'GET', url: `/api/studybook/books/${id}`, headers: h2 })).json() as StudyBookView;
    expect(v.artifact.status).toBe('published');
    expect(v.job?.attempts).toBe(2);
    expect(ai2.callsFor('study_book').length - before).toBe(v.sections.length); // each section exactly once
    const keys = v.artifact.blocks.map((b) => b.block_key);
    expect(new Set(keys).size).toBe(keys.length);
  }, 300_000);

  it('a cut-off model answer (max_tokens) is never published: that section is failed with the reason, the book is partial', async () => {
    const login = await app2.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-medlevo-csrf': '1' }, payload: { username: 'owner', password: 'test-password-123' } });
    const h2 = { cookie: String(login.headers['set-cookie']).split(';')[0]!, 'x-medlevo-csrf': '1' };
    let n = 0;
    ai2.always('study_book', (req) => (++n === 2 ? new ProviderError('truncated', { model: 'fake-model-1', usage: { inputTokens: 900, outputTokens: 9000 } }) : bookGenerator(req)));
    const res = await app2.inject({ method: 'POST', url: '/api/studybook/books', headers: h2, payload: { source_id: lecture.sourceId, scope: { mode: 'lecture_only', lecture_source_id: lecture.sourceId }, regenerate: true } });
    const id = (res.json() as { book: StudyBookView }).book.artifact.id;
    await app2.ctx.jobs.drain();
    ai2.always('study_book', bookGenerator);
    const v = (await app2.inject({ method: 'GET', url: `/api/studybook/books/${id}`, headers: h2 })).json() as StudyBookView;
    const cut = v.sections.find((s) => s.ord === 1)!;
    expect(cut.status).toBe('failed');
    expect(cut.block_count).toBe(0);
    expect(JSON.stringify(cut)).toContain('انقطع رد النموذج');
    expect(v.artifact.blocks.filter((b) => b.section_key === cut.section_key)).toEqual([]);
    expect(v.artifact.status).not.toBe('published');
    expect(v.sections.filter((s) => s.status === 'complete').length).toBe(v.sections.length - 1);
  }, 300_000);
});

// ───────── 3. generated MCQs ─────────
const STEMS = [
  'A 28-year-old woman of reproductive age presents with periumbilical pain that has moved to the right iliac fossa, with anorexia and nausea. Which investigation should be performed first to exclude an important differential diagnosis?',
  'A 31-year-old woman with suspected appendicitis has right iliac fossa pain for one day and a regular menstrual cycle. Before any imaging is ordered, which test must be done to exclude an important differential diagnosis?',
];

function question(prompt: string, stem: string) {
  const preg = aliasWith(prompt, 'pregnancy test');
  const us = aliasWith(prompt, 'Ultrasound is the first-line');
  const ct = aliasWith(prompt, 'CT abdomen is preferred');
  const ddx = aliasWith(prompt, 'differential diagnosis includes');
  return {
    item_type: 'investigation',
    learning_objective: 'Choose the first investigation that excludes ectopic pregnancy in a woman of reproductive age with right iliac fossa pain.',
    concepts: ['acute appendicitis', 'ectopic pregnancy'],
    difficulty_est: 'hard',
    stem,
    options: [
      { key: 'A', text: 'Serum amylase level' },
      { key: 'B', text: 'Pregnancy test (β-hCG)' },
      { key: 'C', text: 'Barium enema study' },
      { key: 'D', text: 'Upper GI endoscopy' },
    ],
    best_answer: 'B',
    explanation: [
      { text: 'A pregnancy test (β-hCG) is required in women of reproductive age.', claim: { support_type: 'directly_stated', evidence: [preg] } },
      { text: 'Ectopic pregnancy is included in the differential diagnosis.', claim: { support_type: 'derived', evidence: [ddx] } },
    ],
    distractors: [
      { option: 'A', explanation: [{ text: 'The investigations listed for this presentation are ultrasound, CT abdomen and a pregnancy test.', claim: { support_type: 'synthesized', evidence: [us, ct, preg] } }] },
      { option: 'C', explanation: [{ text: 'Ultrasound is the first-line imaging test in children and in pregnant women.', claim: { support_type: 'directly_stated', evidence: [us] } }] },
      { option: 'D', explanation: [{ text: 'CT abdomen is preferred in adults when the diagnosis remains uncertain after clinical assessment.', claim: { support_type: 'directly_stated', evidence: [ct] } }] },
    ],
  };
}
const VALID = { chosen_option: 'B', defensible_options: ['B'], answerable_from_evidence: true, clue_issues: [], issues: [], verdict: 'valid' };

/** Delegates to a scripted provider; the N-th call of `task` freezes forever (the process dies inside that call). */
class FreezingAi implements AiProvider {
  readonly name = 'scripted-test';
  private n = 0;
  constructor(
    private readonly inner: ExamAi,
    private readonly task: string,
    private readonly nth: number,
    private readonly gate: ReturnType<typeof freezePoint>,
  ) {}
  supports(task: Parameters<AiProvider['supports']>[0]) {
    return this.inner.supports(task);
  }
  modelFor() {
    return this.inner.modelFor();
  }
  estimateCostUsd() {
    return this.inner.estimateCostUsd();
  }
  async generateStructured(req: ProviderRequest): Promise<ProviderResponse> {
    if (req.task === this.task && ++this.n === this.nth) return this.gate.freeze();
    return this.inner.generateStructured(req);
  }
}

describe('AC-25 generated MCQs: killed between two questions → the restart publishes the rest, never a question twice', () => {
  it('candidate 1 is published, the process dies validating candidate 2; process 2 resumes from the stored generation (no new model generation, no duplicate)', async () => {
    const inner = new ExamAi();
    inner.on('generate_questions', (req) => ({ abstain: null, questions: STEMS.map((s) => question(req.prompt, s)) }))
      .on('validate_question', () => VALID)
      .on('verify_support', allSupported);
    const gate = freezePoint();
    const ai1 = new FreezingAi(inner, 'validate_question', 2, gate);
    const t = await createTestApp({ ai: ai1, modules: processingModules(), jobs: JOBS });
    cleanup.push(() => t.close());
    const h = await t.login();
    const q = Object.assign(t, { h }) as QApp;
    const course = (await createNode(q, 'Surgery Course 1')).id;
    const lecture = await uploadAndProcess(q, course, 'lecture_appendicitis.pdf', golden('lecture_appendicitis.pdf'), 'lecture', 'Acute Appendicitis (TEST FIXTURE)');
    const req = { lecture_source_id: lecture.sourceId, page_ids: [pageId(q, lecture.versionId, 1)], topic: 'pregnancy test investigations', count: 2, difficulty: 'hard', item_types: ['investigation'] };
    const res = await t.app.inject({ method: 'POST', url: '/api/exams/generate', headers: h, payload: req });
    expect(res.statusCode, res.body).toBe(200);
    const runId = (res.json() as GenerateQuestionsResponse).run.id;
    void t.ctx.jobs.drain().catch(() => undefined);
    await gate.reached;
    const generated = () => count(t, `SELECT COUNT(*) AS n FROM question WHERE origin_type = 'generated'`);
    expect(generated()).toBe(1);
    expect(inner.callsFor('generate_questions')).toHaveLength(1);

    // process 2: the generator is NOT asked again (its output is checkpointed); candidate 1 is not re-validated
    const inner2 = new ExamAi();
    inner2.on('generate_questions', () => {
      throw new Error('the generation step must resume from its checkpoint, not call the model again');
    })
      .on('validate_question', () => VALID)
      .on('verify_support', allSupported);
    const app2 = await reopen(t.dataDir, inner2, processingModules());
    cleanup.unshift(() => app2.close());
    expect(app2.ctx.jobs.requeueStale()).toBe(1);
    await app2.ctx.jobs.drain();
    const run = (await app2.inject({ method: 'GET', url: `/api/exams/generate/${runId}`, headers: h })).json() as GenerateQuestionsResponse;
    expect(run.run.status).toBe('completed');
    expect(run.run.candidates.map((c) => c.status)).toEqual(['published', 'published']);
    expect(new Set(run.run.candidates.map((c) => c.question_id)).size).toBe(2);
    expect(inner2.callsFor('generate_questions')).toHaveLength(0);
    expect(inner2.callsFor('validate_question')).toHaveLength(1);
    expect(count(app2, `SELECT COUNT(*) AS n FROM question WHERE origin_type = 'generated'`)).toBe(2);
    expect(count(app2, 'SELECT COUNT(*) AS n FROM generated_question_candidate WHERE run_id = ?', [runId])).toBe(2);
    // every published generated question has its full explanation (answer + every distractor), nothing cut off
    for (const c of run.run.candidates) {
      const qv = (await app2.inject({ method: 'GET', url: `/api/questions/${c.question_id}`, headers: h })).json() as { question: { current: { distractor_explanations: Record<string, unknown>; explanation: unknown } } };
      expect(Object.keys(qv.question.current.distractor_explanations)).toHaveLength(3);
      expect(qv.question.current.explanation).toBeTruthy();
    }
  }, 300_000);
});
