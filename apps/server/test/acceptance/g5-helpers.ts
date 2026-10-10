// Shared helpers of the G5 acceptance tests (AC-16, AC-17, AC-18, AC-19): the REAL pipeline (upload → processing →
// questions hook → extraction → matching) through `appWith` (G4), plus small exam helpers — answer every delivered
// item and finish the attempt through the real sync push, as the web runner does.
import { richTextToPlain, type AttemptFeedbackView, type ExamCreateRequest, type ExamCreateResponse, type ExamSessionView, type RichText } from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import { push } from '../exams/helpers';
import { api, type QApp } from '../questions/helpers';
import { stateOf } from './g4-helpers';

export { acceptanceFixture, appWith, ScriptedAi } from './g4-helpers';

export const plain = (rt: RichText | null | undefined): string => (rt ? richTextToPlain(rt) : '');

export async function exam(t: QApp, req: Partial<ExamCreateRequest> & Pick<ExamCreateRequest, 'mode' | 'count'>): Promise<ExamSessionView> {
  const res = await api(t).post('/api/exams', { title: '', ...req });
  if (res.statusCode !== 200) throw new Error(`create exam failed: ${res.statusCode} ${res.body}`);
  return (res.json() as ExamCreateResponse).session;
}

/** Answer every item (the option whose text contains `pick(item)`, else the first) and finish through sync push. */
export async function finishExam(t: QApp, s: ExamSessionView, pick: (i: ExamSessionView['items'][number]) => string | null = () => null): Promise<void> {
  const now = t.ctx.clock.now();
  const answers: Record<string, unknown> = {};
  for (const it of s.items) {
    const want = pick(it);
    const opt = (want && it.options.find((o) => plain(o.text).includes(want))) || it.options[0];
    if (!opt) continue;
    answers[String(it.index)] = { attempt_id: newId(), selected_option_ids: [opt.id], confidence: 'confident', at: now, time_ms: 1000, hints_used: 0, solution_viewed_before_answer: false, submitted: false };
  }
  const r = await push(t, [{ entity_type: 'exam_attempt', entity_id: s.attempt.id, op: 'upsert', payload: stateOf(s, { status: 'completed', answers: answers as never, elapsed_ms: 5000, finished_at: now } as never) }]);
  if (r[0]!.result !== 'applied') throw new Error(`finish failed: ${JSON.stringify(r[0])}`);
}

export async function feedback(t: QApp, attemptId: string, index: number): Promise<{ status: number; body: AttemptFeedbackView & { error?: { code: string; message: string } } }> {
  const res = await api(t).get(`/api/exams/attempts/${attemptId}/items/${index}/feedback`);
  return { status: res.statusCode, body: res.json() as AttemptFeedbackView & { error?: { code: string; message: string } } };
}
