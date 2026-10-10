// Starts a practice set on an explicit list of questions (revision steps, weakness actions) through the exams module.
import { newId } from '@medlevo/shared';
import { examsApi } from '../exams/api';

/** Creates the practice set (idempotent by the attempt id the caller keeps) and returns the runner URL. */
export async function startPracticeSet(questionIds: string[], title: string, attemptId: string = newId()): Promise<string> {
  const res = await examsApi.create({ title, mode: 'practice', count: questionIds.length, question_ids: questionIds, attempt_id: attemptId });
  return `/exams/${encodeURIComponent(res.session.attempt.id)}`;
}
