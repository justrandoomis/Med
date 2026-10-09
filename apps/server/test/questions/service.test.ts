// Service used by the exams/generation tracks, owner links, the review-queue API, and the processing hook guard.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXTRACT_QUESTIONS_JOB_KIND, type QuestionDetailResponse, type ReviewQueueResponse } from '@medlevo/shared';
import { MODULES } from '../../src/modules';
import { createProcessingModule } from '../../src/modules/processing';
import { createQuestion, createVersion, dedupeCandidates, getQuestion, listForExam } from '../../src/modules/questions/service';
import { createTestApp, type TestApp } from '../helpers/app';
import { addSource, processVersion } from '../processing/helpers';
import { api, createNode, createQuestionsApp, type QApp } from './helpers';

let t: QApp;
beforeAll(async () => {
  t = await createQuestionsApp();
}, 120_000);
afterAll(async () => {
  await t?.close();
});

describe('service for the exams / generation tracks', () => {
  it('generated questions are labelled generated, AI-derived answers are never source keys', () => {
    const g = createQuestion(t.ctx, {
      origin: 'generated',
      qtype: 'sba',
      stem: 'Which finding best supports acute appendicitis in this vignette?',
      options: [{ text: 'Rebound tenderness' }, { text: 'Bradycardia' }, { text: 'Hypothermia' }],
      correctOptionIndexes: [0],
      answerStatus: 'ai_derived',
      model: 'fake-model-1',
    });
    const v = getQuestion(t.ctx, g.questionId);
    expect(v.origin_type).toBe('generated');
    expect(v.origin_label_ar).toBe('سؤال مولد بواسطة MedLevo من المصادر المحددة');
    expect(v.current.created_by).toBe('generation');
    expect(v.current.answer_status).toBe('ai_derived');
    expect(v.occurrences).toHaveLength(0);
    expect(() =>
      createQuestion(t.ctx, { origin: 'generated', qtype: 'sba', stem: 'x?', options: [{ text: 'a' }, { text: 'b' }], answerStatus: 'source_key' as never }),
    ).toThrow(/ai_derived/);
  });

  it('createVersion appends (the previous version is untouched) and re-validates', () => {
    const q = createQuestion(t.ctx, {
      origin: 'owner',
      qtype: 'sba',
      stem: 'Serum sodium of 125 mmol/L indicates which state?',
      options: [{ text: 'Hyponatraemia', label: 'A' }, { text: 'Hypernatraemia', label: 'B' }],
      correctOptionIndexes: [0],
      answerStatus: 'owner_key',
    });
    const first = getQuestion(t.ctx, q.questionId).current;
    const r = createVersion(t.ctx, q.questionId, { kind: 'translation', createdBy: 'translation', stem: 'صوديوم المصل 125 mmol/L يدل على أي حالة؟', note: 'ترجمة' });
    const v = getQuestion(t.ctx, q.questionId);
    expect(v.current.id).toBe(r.versionId);
    expect(v.current.kind).toBe('translation');
    expect(v.current.derived_from_version_id).toBe(first.id);
    expect(v.current.answer_status).toBe('owner_key');
    const old = t.ctx.db.get<{ stem_json: string }>('SELECT stem_json FROM question_version WHERE id = ?', [first.id])!;
    expect(old.stem_json).toContain('Serum sodium');
  });

  it('listForExam groups confirmed duplicates so one exam never shows both', async () => {
    const mk = (stem: string) =>
      createQuestion(t.ctx, { origin: 'owner', qtype: 'sba', stem, options: [{ text: 'Phrenic nerve' }, { text: 'Vagus nerve' }, { text: 'Accessory nerve' }], correctOptionIndexes: [0], answerStatus: 'owner_key' }).questionId;
    const a = mk('Which nerve supplies motor fibres to the diaphragm muscle?');
    const b = mk('Which nerve supplies motor fibres to the diaphragm?');
    const dup = t.ctx.db.get<{ id: string; status: string }>('SELECT id, status FROM question_duplicate WHERE (question_a_id = ? AND question_b_id = ?) OR (question_a_id = ? AND question_b_id = ?)', [a, b, b, a]);
    expect(dup?.status).toBe('suggested');
    const before = dedupeCandidates(listForExam(t.ctx, { questionIds: [a, b] }));
    expect(before).toHaveLength(2);
    expect((await api(t).post(`/api/questions/duplicates/${dup!.id}/decision`, { status: 'confirmed' })).statusCode).toBe(200);
    const after = dedupeCandidates(listForExam(t.ctx, { questionIds: [a, b] }));
    expect(after).toHaveLength(1);
    // nothing was merged: both questions still exist with their own versions
    expect(getQuestion(t.ctx, a).id).toBe(a);
    expect(getQuestion(t.ctx, b).id).toBe(b);
  });
});

describe('owner links and the review queue API', () => {
  it('an owner-made link is accepted with the owner as origin', async () => {
    const node = await createNode(t, 'Physiology');
    const lec = await addSource(t, 'lecture_cholecystitis.pdf', 'pdf', { sourceType: 'lecture' });
    const q = createQuestion(t.ctx, { origin: 'owner', qtype: 'short_answer', stem: 'Describe Murphy sign.', options: [], answerStatus: 'not_applicable', courseNodeId: node.id }).questionId;
    const res = await api(t).post(`/api/questions/${q}/links`, { lecture_source_id: lec.sourceId, relation: 'directly_covered', reason: 'مذكورة في الصفحة الأولى' });
    expect(res.statusCode).toBe(200);
    const link = (res.json() as { question: { lecture_links: Array<{ origin: string; status: string; reason: string }> } }).question.lecture_links[0]!;
    expect(link).toMatchObject({ origin: 'owner', status: 'accepted' });
    expect(link.reason).toContain('ربطته بنفسك');
    expect((await api(t).post(`/api/questions/${q}/links`, { lecture_source_id: 'nope', relation: 'directly_covered' })).statusCode).toBe(404);
  });

  it('review items are listed with the question and can be resolved once', async () => {
    const q = createQuestion(t.ctx, { origin: 'owner', qtype: 'sba', stem: 'Which of the following is correct?', options: [{ text: 'only one' }], answerStatus: 'missing_key' }).questionId;
    const list = (await api(t).get(`/api/questions/review-queue?question_id=${q}`)).json() as ReviewQueueResponse;
    const item = list.items.find((i) => i.kind === 'missing_option')!;
    expect(item).toBeTruthy();
    expect(item.reason).toContain('خيار واحد');
    expect(item.question_stem_preview).toContain('Which of the following');
    const r1 = await api(t).post(`/api/questions/review-queue/${item.id}/resolve`, { action: 'dismissed', note: 'سؤال تجريبي' });
    expect(r1.statusCode).toBe(200);
    expect((await api(t).post(`/api/questions/review-queue/${item.id}/resolve`, { action: 'dismissed' })).statusCode).toBe(409);
    const d = (await api(t).get(`/api/questions/${q}`)).json() as QuestionDetailResponse;
    expect(d.review_items.find((i) => i.id === item.id)?.status).toBe('dismissed');
  });

  it('validation errors are reported in Arabic per field', async () => {
    const res = await api(t).patch('/api/questions/whatever', { options: [{ text: '' }] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
  });
});

describe('processing hook guard', () => {
  let bare: TestApp;
  afterAll(async () => {
    await bare?.close();
  });

  it('processing still completes when the questions module is absent (no follow-up job)', async () => {
    bare = await createTestApp({
      modules: MODULES.filter((m) => m.name !== 'questions').map((m) => (m.name === 'processing' ? { ...m, plugin: createProcessingModule() } : m)),
      jobs: { backoffBaseMs: 0, backoffMaxMs: 0 },
    });
    const src = await addSource(bare, 'questions_previous_exam_2024.pdf', 'pdf', { sourceType: 'previous_exam' });
    const job = await processVersion(bare, src.versionId);
    expect(job.status).toBe('completed');
    expect(bare.ctx.jobs.isRegistered(EXTRACT_QUESTIONS_JOB_KIND)).toBe(false);
    expect(bare.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM processing_job WHERE kind = ?`, [EXTRACT_QUESTIONS_JOB_KIND])!.n).toBe(0);
  }, 60_000);
});
