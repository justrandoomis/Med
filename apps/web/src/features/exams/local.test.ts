// Local-first persistence of attempts (fake-indexeddb): full-state upserts coalesce while unsent, a checked
// answer is appended once (idempotent by its client id), the owner's mistake type is an upsert of the derived
// signal only, and server copies never overwrite unsynced local answers.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId, type ExamAttemptDTO, type QuestionAttemptDTO } from '@medlevo/shared';
import { MedLevoDB } from '../../lib/localdb';
import type { ApplierContext } from '../../lib/sync';
import { __test, recordQuestionAttempt, saveMistakeType, saveState, type LocalExamAttemptRow, type LocalQuestionAttemptRow } from './local';
import { chooseOption, stateFromDTO } from './model';

let db: MedLevoDB;
beforeEach(async () => {
  db = new MedLevoDB(`exams-test-${newId()}`);
  await db.open();
});
afterEach(async () => {
  db.close();
  await db.delete();
});

const ctx = async (type: string, id: string, source: 'pull' | 'push' = 'pull'): Promise<ApplierContext> => ({
  db,
  source,
  localOps: await db.outbox.where('[entity_type+entity_id]').equals([type, id]).filter((o) => o.status !== 'synced').toArray(),
});

const dto = (patch: Partial<ExamAttemptDTO> = {}): ExamAttemptDTO => ({
  id: 'A1',
  exam_id: 'E1',
  status: 'in_progress',
  started_at: 1,
  finished_at: null,
  elapsed_ms: 1000,
  current_index: 0,
  answers: {},
  flagged: [],
  timer: { item_ms: {}, pauses: 0, paused_at: null },
  rev: 2,
  updated_at: 2,
  ...patch,
});

describe('exam attempt state', () => {
  it('is written with a full-state upsert; unsent upserts coalesce into one op', async () => {
    const meta = { attemptId: 'A1', examId: 'E1', startedAt: 1 };
    let s = stateFromDTO(dto());
    s = chooseOption(s, 0, 'o1', { multi: false, attemptId: 'q1', now: 5 });
    await saveState(db, meta, s, 5);
    s = chooseOption(s, 1, 'p2', { multi: false, attemptId: 'q2', now: 6 });
    await saveState(db, meta, s, 6);
    const ops = await db.outbox.toArray();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ entity_type: 'exam_attempt', entity_id: 'A1', op: 'upsert' });
    expect(Object.keys((ops[0]!.payload as { answers: object }).answers).sort()).toEqual(['0', '1']);
    expect(((await db.examAttempts.get('A1')) as LocalExamAttemptRow).state.answers['1']!.selected_option_ids).toEqual(['p2']);
  });

  it('a server copy merges with unsynced local answers instead of replacing them', async () => {
    const local = chooseOption(stateFromDTO(dto()), 0, 'o1', { multi: false, attemptId: 'q1', now: 50 });
    await saveState(db, { attemptId: 'A1', examId: 'E1', startedAt: 1 }, local, 50);
    const server = dto({ answers: { '1': { attempt_id: 'qx', selected_option_ids: ['p1'], confidence: null, at: 40, time_ms: null, hints_used: 0, solution_viewed_before_answer: false, submitted: false } }, elapsed_ms: 9000 });
    await __test.examAttemptApplier({ seq: 1, entity_type: 'exam_attempt', entity_id: 'A1', entity: server }, await ctx('exam_attempt', 'A1'));
    const row = (await db.examAttempts.get('A1')) as LocalExamAttemptRow;
    expect(Object.keys(row.state.answers).sort()).toEqual(['0', '1']);
    expect(row.state.elapsed_ms).toBe(9000);
    // without local ops the server copy is taken as is
    await db.outbox.clear();
    await __test.examAttemptApplier({ seq: 2, entity_type: 'exam_attempt', entity_id: 'A1', entity: dto({ status: 'completed', finished_at: 99 }) }, await ctx('exam_attempt', 'A1'));
    expect(((await db.examAttempts.get('A1')) as LocalExamAttemptRow).state.status).toBe('completed');
  });
});

describe('question attempts', () => {
  const payload = { id: 'QA1', question_id: 'Q1', question_version_id: 'V1', exam_attempt_id: 'A1', exam_item_index: 0, selected_option_ids: ['o2'], confidence: 'guess' as const, hints_used: 1, answered_at: 7 };

  it('a checked answer is appended once (idempotent by its client id)', async () => {
    await recordQuestionAttempt(db, payload, 7);
    await recordQuestionAttempt(db, { ...payload, selected_option_ids: ['o3'] }, 8);
    const ops = await db.outbox.toArray();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ entity_type: 'question_attempt', entity_id: 'QA1', op: 'append' });
    expect(ops[0]!.payload).toMatchObject({ selected_option_ids: ['o2'], hints_used: 1, confidence: 'guess' });
    expect(((await db.questionAttempts.get('QA1')) as LocalQuestionAttemptRow).selectedOptionIds).toEqual(['o2']);
  });

  it('the owner mistake type is an upsert of the signal only; a server copy does not overwrite it while pending', async () => {
    await recordQuestionAttempt(db, payload, 7);
    await saveMistakeType(db, { id: 'QA1', question_id: 'Q1', question_version_id: 'V1', answered_at: 7 }, 'misread', 9);
    const ops = await db.outbox.toArray();
    expect(ops.map((o) => o.op)).toEqual(['append', 'upsert']);
    expect(ops[1]!.payload).toEqual({ mistake_type: 'misread' });
    const server: QuestionAttemptDTO = {
      id: 'QA1', question_id: 'Q1', question_version_id: 'V1', exam_attempt_id: 'A1', exam_item_index: 0, selected_option_ids: ['o2'], is_correct: false, scored: true, unscored_reason_ar: null,
      confidence: 'guess', hints_used: 1, solution_viewed_before_answer: false, time_ms: null, time_budget_ms: null, flagged: false, mistake_type: 'knowledge_gap', mistake_origin: 'auto',
      auto_mistake_type: 'knowledge_gap', auto_mistake_reason_ar: 'x', answered_at: 7, created_at: 7, rev: 1,
    };
    await __test.questionAttemptApplier({ seq: 3, entity_type: 'question_attempt', entity_id: 'QA1', entity: server }, await ctx('question_attempt', 'QA1'));
    expect(((await db.questionAttempts.get('QA1')) as LocalQuestionAttemptRow).mistakeType).toBe('misread');
  });
});
