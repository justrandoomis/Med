// Round 7 — independent review of track H4 item 1 (topic «محاولاتي السابقة»): an exam that is still running in an
// assessed mode (exam / time pressure / simulation) or with solutions «at the end» shows NO result before it is finished
// (AC-19 «لا تُكشف الإجابات أثناءه» — the results route refuses with 409). Before the fix the topic page listed each
// answer of such a running exam as «صحيحة / خاطئة» and the linked attempt as «صحيحة 1 من 2 مُقيَّمة», and linked the
// running exam to its results page. TEST rows only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TopicDetailResponse } from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import { brainApp, call, type BApp } from './helpers';

describe('review H4 — a running assessed exam reveals nothing on the topic page', () => {
  let t: BApp;
  let topicId: string;
  beforeAll(async () => {
    t = await brainApp();
    topicId = (await call(t).ok<{ topic: { id: string } }>('POST', '/api/library/topics', { title: 'Right iliac fossa (TEST)' })).topic.id;
  });
  afterAll(async () => t.close());

  async function examWithAnswers(mode: string, status: 'in_progress' | 'completed', policy: Record<string, unknown> = {}) {
    const now = t.ctx.clock.now();
    const q = await call(t).ok<{ question_id: string }>('POST', '/api/questions/quick-add', { text: `1. Which TEST sign ${newId(now)}?\nA. One\nB. Two\nC. Three`, key_label: 'B' });
    const qv = t.ctx.db.get<{ v: string }>('SELECT current_version_id AS v FROM question WHERE id = ?', [q.question_id])!.v;
    const examId = newId(now);
    const attemptId = newId(now);
    t.ctx.db.run(`INSERT INTO exam (id, title, mode, config_json, policy_json, items_json, created_at) VALUES (?, ?, ?, '{}', ?, '[]', ?)`, [examId, `امتحان ${mode} (TEST)`, mode, JSON.stringify(policy), now]);
    t.ctx.db.run(`INSERT INTO exam_attempt (id, exam_id, status, started_at, finished_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`, [attemptId, examId, status, now - 5000, status === 'completed' ? now - 1000 : null, now]);
    for (const [correct, at] of [[1, now - 4000], [0, now - 3000]] as const) {
      t.ctx.db.run(
        `INSERT INTO question_attempt (id, question_id, question_version_id, exam_attempt_id, is_correct, scored, answered_at, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
        [newId(at), q.question_id, qv, attemptId, correct, at, at],
      );
    }
    await call(t).ok('POST', `/api/library/topics/${topicId}/links`, { entity_type: 'question', entity_id: q.question_id });
    await call(t).ok('POST', `/api/library/topics/${topicId}/links`, { entity_type: 'exam_attempt', entity_id: attemptId });
    return { attemptId, questionId: q.question_id };
  }

  it('exam mode, in progress: no «صحيحة / خاطئة», no score, no link to the results; once finished they appear', async () => {
    const running = await examWithAnswers('exam', 'in_progress');
    // the exams module itself refuses the result while the exam runs
    expect((await call(t).get(`/api/exams/attempts/${running.attemptId}/result`)).statusCode).not.toBe(200);
    let d = await call(t).ok<TopicDetailResponse>('GET', `/api/brain/topics/${topicId}`);
    const linked = d.links.find((l) => l.entity_type === 'exam_attempt' && l.entity_id === running.attemptId)!;
    expect(linked.sublabel).not.toMatch(/صحيحة|مُقيَّمة/);
    expect(linked.href).toBe(`/exams/${running.attemptId}`);
    const answers = d.attempts!.items.filter((a) => a.kind === 'question_attempt');
    expect(answers).toHaveLength(2);
    for (const a of answers) {
      expect(a.sublabel).not.toMatch(/صحيحة|خاطئة/);
      expect(a.sublabel).toContain('النتيجة بعد إنهاء الامتحان');
      expect(a.href).toBe(`/exams/${running.attemptId}`);
    }
    // finished: the results are the owner's to see
    t.ctx.db.run(`UPDATE exam_attempt SET status = 'completed', finished_at = ? WHERE id = ?`, [t.ctx.clock.now(), running.attemptId]);
    d = await call(t).ok<TopicDetailResponse>('GET', `/api/brain/topics/${topicId}`);
    expect(d.links.find((l) => l.entity_id === running.attemptId)!.sublabel).toContain('صحيحة 1 من 2 مُقيَّمة');
    expect(d.attempts!.items.filter((a) => a.kind === 'question_attempt').map((a) => a.sublabel!.split(' · ')[1]).sort()).toEqual(['خاطئة', 'صحيحة']);
  });

  it('practice with solutions «at the end», in progress: hidden too; practice with feedback after each answer: shown', async () => {
    const atEnd = await examWithAnswers('practice', 'in_progress', { show_solution: 'at_end' });
    let d = await call(t).ok<TopicDetailResponse>('GET', `/api/brain/topics/${topicId}`);
    expect(d.links.find((l) => l.entity_id === atEnd.attemptId)!.sublabel).not.toMatch(/صحيحة|مُقيَّمة/);
    const afterEach = await examWithAnswers('practice', 'in_progress', { show_solution: 'after_each' });
    d = await call(t).ok<TopicDetailResponse>('GET', `/api/brain/topics/${topicId}`);
    expect(d.links.find((l) => l.entity_id === afterEach.attemptId)!.sublabel).toContain('صحيحة 1 من 2 مُقيَّمة');
  });
});
