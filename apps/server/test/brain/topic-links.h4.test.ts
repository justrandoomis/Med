// Round 7 H4 item 1 — clinical cases, generated explanations (artifacts) and past attempts can be linked to a topic
// (§05 «داخل الموضوع يمكن الوصول إلى: … الشرح … الحالات … ومحاولاتي السابقة»). Before H4 the topic link validator
// knew only sources / regions / questions / folders / concepts / images / cards / notes: linking a case answered 400.
// TEST rows only (synthetic titles, no medical reference content).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TopicDetailResponse, TopicLinkView } from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import { appendicitisCase, createCase, start } from '../cases/helpers';
import { brainApp, call, type BApp } from './helpers';

describe('Round 7 H4 — topic links for cases, explanations and attempts', () => {
  let t: BApp;
  let topicId: string;
  let caseId: string;
  let artifactId: string;
  beforeAll(async () => {
    t = await brainApp();
    topicId = (await call(t).ok<{ topic: { id: string } }>('POST', '/api/library/topics', { title: 'Appendicitis' })).topic.id;
    const c = await createCase(t, t.h, appendicitisCase({ title: 'Acute appendicitis — guided case (TEST)' }));
    caseId = c.id;
    const now = t.ctx.clock.now();
    artifactId = newId(now);
    t.ctx.db.run(
      `INSERT INTO artifact (id, lineage_id, version_no, kind, title, primary_source_id, scope_json, params_json, cache_key, rules_version, generator_version, verifier_version, status, created_at, updated_at)
       VALUES (?, ?, 1, 'explanation', 'شرح: الألم المهاجر (TEST)', NULL, '{}', '{}', 'k-h4', '1', '1', '1', 'published', ?, ?)`,
      [artifactId, `L_${artifactId}`, now, now],
    );
  });
  afterAll(async () => t.close());

  it('a case whose title names the topic is SUGGESTED (with its reason); the owner decision is kept on the next run', async () => {
    const s = await call(t).ok<{ created: number }>('POST', '/api/brain/topics/suggest', { topic_id: topicId });
    expect(s.created).toBeGreaterThanOrEqual(1);
    let d = await call(t).ok<TopicDetailResponse>('GET', `/api/brain/topics/${topicId}`);
    const link = d.links.find((l) => l.entity_type === 'clinical_case' && l.entity_id === caseId)!;
    expect(link).toMatchObject({ status: 'suggested', origin: 'auto', href: `/cases/${caseId}`, reason_ar: 'اسم الموضوع في عنوان الحالة.' });
    expect(link.label).toContain('Acute appendicitis');
    expect(link.sublabel).toContain('حالة سريرية تدريجية');
    expect(link.sublabel).toContain('كتبتها بنفسك');
    // reject → never suggested again
    await call(t).ok('PATCH', `/api/library/topic-links/${link.id}`, { status: 'rejected' });
    await call(t).ok('POST', '/api/brain/topics/suggest', { topic_id: topicId });
    d = await call(t).ok<TopicDetailResponse>('GET', `/api/brain/topics/${topicId}`);
    expect(d.links.find((l) => l.id === link.id)!.status).toBe('rejected');
    // the owner links it by hand → accepted
    const own = await call(t).ok<{ link: TopicLinkView }>('POST', `/api/library/topics/${topicId}/links`, { entity_type: 'clinical_case', entity_id: caseId });
    expect(own.link).toMatchObject({ status: 'accepted', origin: 'owner' });
  });

  it('a generated explanation is linked by the owner and labelled as GENERATED with its own page', async () => {
    await call(t).ok('POST', `/api/library/topics/${topicId}/links`, { entity_type: 'artifact', entity_id: artifactId });
    const d = await call(t).ok<TopicDetailResponse>('GET', `/api/brain/topics/${topicId}`);
    const l = d.links.find((x) => x.entity_type === 'artifact')!;
    expect(l).toMatchObject({ status: 'accepted', href: `/explanations/${artifactId}`, label: 'شرح: الألم المهاجر (TEST)' });
    expect(l.sublabel).toContain('شرح مولّد');
    // a newer version of the same lineage → the old link says so (it is never silently swapped)
    const now = t.ctx.clock.now() + 1000;
    t.ctx.db.run(
      `INSERT INTO artifact (id, lineage_id, version_no, kind, title, primary_source_id, scope_json, params_json, cache_key, rules_version, generator_version, verifier_version, status, created_at, updated_at)
       VALUES (?, ?, 2, 'explanation', 'شرح: الألم المهاجر (TEST) 2', NULL, '{}', '{}', 'k-h4-2', '1', '1', '1', 'published', ?, ?)`,
      [newId(now), `L_${artifactId}`, now, now],
    );
    const d2 = await call(t).ok<TopicDetailResponse>('GET', `/api/brain/topics/${topicId}`);
    expect(d2.links.find((x) => x.entity_type === 'artifact')!.sublabel).toContain('توجد نسخة أحدث');
  });

  it('validation: unknown types are refused (400), missing rows are 404, CSRF still required', async () => {
    expect((await call(t).post(`/api/library/topics/${topicId}/links`, { entity_type: 'exam', entity_id: caseId })).statusCode).toBe(400);
    expect((await call(t).post(`/api/library/topics/${topicId}/links`, { entity_type: 'clinical_case', entity_id: newId() })).statusCode).toBe(404);
    expect((await call(t).post(`/api/library/topics/${topicId}/links`, { entity_type: 'case_attempt', entity_id: newId() })).statusCode).toBe(404);
    const noCsrf = await t.app.inject({ method: 'POST', url: `/api/library/topics/${topicId}/links`, headers: { cookie: t.h.cookie }, payload: { entity_type: 'artifact', entity_id: artifactId } });
    expect(noCsrf.statusCode).toBe(403);
  });

  it('past attempts: linked exam attempts, attempts on linked questions and on linked cases — newest first, rejected links contribute nothing', async () => {
    // a case attempt on the linked case
    const run = await start(t, t.h, caseId);
    // an exam attempt the owner links, with two scored answers (one right) and one unscored
    const now = t.ctx.clock.now();
    const q = await call(t).ok<{ question_id: string }>('POST', '/api/questions/quick-add', { text: '1. Which sign is TEST-only?\nA. One\nB. Two\nC. Three', key_label: 'B' });
    const qid = q.question_id;
    const qv = t.ctx.db.get<{ v: string }>('SELECT current_version_id AS v FROM question WHERE id = ?', [qid])!.v;
    const examId = newId(now);
    const attemptId = newId(now);
    t.ctx.db.run(`INSERT INTO exam (id, title, mode, config_json, policy_json, items_json, created_at) VALUES (?, 'تدريب: الحفرة الحرقفية (TEST)', 'practice', '{}', '{}', '[]', ?)`, [examId, now]);
    t.ctx.db.run(`INSERT INTO exam_attempt (id, exam_id, status, started_at, finished_at, updated_at) VALUES (?, ?, 'completed', ?, ?, ?)`, [attemptId, examId, now - 5000, now - 1000, now]);
    const ins = (correct: number | null, scored: number, at: number) =>
      t.ctx.db.run(
        `INSERT INTO question_attempt (id, question_id, question_version_id, exam_attempt_id, is_correct, scored, answered_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [newId(at), qid, qv, attemptId, correct, scored, at, at],
      );
    ins(1, 1, now - 4000);
    ins(0, 1, now - 3000);
    ins(null, 0, now - 2000);
    await call(t).ok('POST', `/api/library/topics/${topicId}/links`, { entity_type: 'exam_attempt', entity_id: attemptId });
    let d = await call(t).ok<TopicDetailResponse>('GET', `/api/brain/topics/${topicId}`);
    const linked = d.links.find((l) => l.entity_type === 'exam_attempt')!;
    expect(linked).toMatchObject({ href: `/exams/${attemptId}/results`, label: 'تدريب: الحفرة الحرقفية (TEST)' });
    expect(linked.sublabel).toContain('صحيحة 1 من 2 مُقيَّمة');
    const att = d.attempts!;
    expect(att.items.find((a) => a.kind === 'exam_attempt' && a.id === attemptId)).toMatchObject({ via: 'linked' });
    expect(att.items.find((a) => a.kind === 'case_attempt' && a.id === run.attempt.id)).toMatchObject({ via: 'case', href: `/cases/run/${run.attempt.id}` });
    // question attempts appear only once the question is linked to the topic
    expect(att.items.some((a) => a.kind === 'question_attempt')).toBe(false);
    const ql = await call(t).ok<{ link: TopicLinkView }>('POST', `/api/library/topics/${topicId}/links`, { entity_type: 'question', entity_id: qid });
    d = await call(t).ok<TopicDetailResponse>('GET', `/api/brain/topics/${topicId}`);
    const qas = d.attempts!.items.filter((a) => a.kind === 'question_attempt');
    expect(qas).toHaveLength(3);
    expect(qas.map((a) => a.sublabel!.split(' · ')[1])).toEqual(['غير مُقيَّمة (لا مفتاح مؤكد)', 'خاطئة', 'صحيحة']);
    expect(qas.every((a) => a.via === 'question' && a.href === `/exams/${attemptId}/results`)).toBe(true);
    expect(d.attempts!.total).toBe(d.attempts!.items.length);
    const ats = d.attempts!.items.map((a) => a.at);
    expect([...ats].sort((a, b) => b - a)).toEqual(ats);
    // a rejected (or removed) question link contributes nothing
    await call(t).ok('PATCH', `/api/library/topic-links/${ql.link.id}`, { status: 'rejected' });
    d = await call(t).ok<TopicDetailResponse>('GET', `/api/brain/topics/${topicId}`);
    expect(d.attempts!.items.some((a) => a.kind === 'question_attempt')).toBe(false);
  });

  it('a case in the trash still resolves (labelled), attempts are kept; the case attempt can be linked directly', async () => {
    const run = await start(t, t.h, caseId);
    await call(t).ok('POST', `/api/library/topics/${topicId}/links`, { entity_type: 'case_attempt', entity_id: run.attempt.id });
    const del = await call(t).del(`/api/cases/${caseId}`);
    expect([200, 204]).toContain(del.statusCode);
    const d = await call(t).ok<TopicDetailResponse>('GET', `/api/brain/topics/${topicId}`);
    expect(d.links.find((l) => l.entity_type === 'clinical_case')!.sublabel).toContain('في سلة المحذوفات');
    expect(d.attempts!.items.find((a) => a.id === run.attempt.id)).toMatchObject({ via: 'linked', kind: 'case_attempt' });
  });
});
