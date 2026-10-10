// G3 regression (found by the AC-13 end-to-end run): checking a practice answer fired a GET …/feedback for the very
// answer being sent (the «reopened after a reload» effect saw `submitted` before the POST returned). The server
// answered 409 «not answered yet» — a failed request in the browser console on every practice check. The feedback
// must come from the POST alone; an unscored item (no official key: an unofficial circled mark, AC-13) says so.
import { afterEach, beforeEach, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { EXAM_ITEM_ORIGIN_LABELS_AR, type AttemptFeedbackView, type ExamSessionView, type RichText } from '@medlevo/shared';
import { ToastProvider } from '../../design';
import { setFetchImpl } from '../../lib/api';
import { getDb } from '../../lib/localdb';
import { RunnerScreen } from './RunnerScreen';

const rt = (t: string): RichText => ({ v: 1, paragraphs: [{ dir: 'ltr', runs: [{ t }] }] });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const UNSCORED = 'لا يوجد مفتاح — يُستخدم للتدريب غير المحسوب فقط.';

const options = [
  { id: 'o1', display_label: 'A', text: rt('Ultrasound') },
  { id: 'o2', display_label: 'B', text: rt('CT abdomen') },
  { id: 'o3', display_label: 'C', text: rt('MRCP') },
  { id: 'o4', display_label: 'D', text: rt('ERCP') },
];

const session: ExamSessionView = {
  exam: {
    id: 'E1',
    title: 'تدريب',
    mode: 'practice',
    mode_label_ar: 'تدريب',
    policy: { pause_allowed: true, hints: 'progressive', show_solution: 'after_each', shuffle_options: false, per_question_seconds: null, total_seconds: null, anti_shortcut: false },
    created_at: 1,
    is_generated_simulation: false,
    item_count: 1,
    scored_count: 0,
    build: null,
  },
  attempt: { id: 'A1', exam_id: 'E1', status: 'in_progress', started_at: 1, finished_at: null, elapsed_ms: 0, current_index: 0, answers: {}, flagged: [], timer: { item_ms: {}, pauses: 0, paused_at: null }, rev: 1, updated_at: 1 },
  items: [
    {
      index: 0,
      question_id: 'Q7',
      question_version_id: 'V7',
      qtype: 'sba',
      stem: rt('Which investigation is first-line for suspected gallstones?'),
      options,
      has_negation: false,
      negation_terms: [],
      media: [],
      scored: false,
      origin_type: 'source',
      origin_label_ar: EXAM_ITEM_ORIGIN_LABELS_AR.source,
    },
  ],
  media_expires_at: null,
  unscored_reasons: { '0': UNSCORED },
};

const fb: AttemptFeedbackView = {
  is_correct: null,
  scored: false,
  correct_option_ids: null,
  answer_status: 'missing_key',
  explanation: null,
  distractor_explanations: null,
  occurrences: [],
  suggested_mistake_type: null,
  question_id: 'Q7',
  question_version_id: 'V7',
  attempt: {
    id: 'X7',
    question_id: 'Q7',
    question_version_id: 'V7',
    exam_attempt_id: 'A1',
    exam_item_index: 0,
    selected_option_ids: ['o1'],
    is_correct: null,
    scored: false,
    unscored_reason_ar: UNSCORED,
    confidence: null,
    hints_used: 0,
    solution_viewed_before_answer: false,
    time_ms: 1000,
    time_budget_ms: null,
    flagged: false,
    mistake_type: null,
    mistake_origin: null,
    auto_mistake_type: null,
    auto_mistake_reason_ar: null,
    answered_at: 1,
    created_at: 1,
    rev: 1,
  },
  origin_type: 'source',
  origin_label_ar: 'سؤال من مصدر الأسئلة — سؤال مصوّر — صورة 1 — رقم السؤال 7',
  answer_status_label_ar: 'لا يوجد مفتاح',
  options,
  stem: session.items[0]!.stem,
  negation_terms: [],
  unscored_reason_ar: UNSCORED,
  mastery_signal: null,
  mistake_reason_ar: null,
  claims: {},
  lecture_links: [],
  newer_version_note_ar: null,
  learning_objective: null,
  difficulty_est: null,
};

let calls: Array<{ url: string; method: string }> = [];
let releaseAnswer: (() => void) | null = null;

beforeEach(async () => {
  const db = getDb();
  await Promise.all([db.outbox.clear(), db.examAttempts.clear(), db.questionAttempts.clear(), db.kv.clear()]);
  calls = [];
  setFetchImpl(async (url, init) => {
    const method = String(init.method ?? 'GET');
    calls.push({ url, method });
    if (url.endsWith('/api/exams/attempts/A1')) return json(session);
    if (url.includes('/items/0/answer')) {
      // the server takes its time: the window in which the racing GET used to fire
      await new Promise<void>((r) => (releaseAnswer = r));
      return json(fb);
    }
    if (url.includes('/items/0/feedback')) return json({ error: { code: 'CONFLICT', message: 'لم تُجب بعد.' } }, 409);
    if (url.includes('/api/sync/push')) return json({ results: [], server_seq: 0 });
    if (url.includes('/api/sync/pull')) return json({ changes: [], next_since: 0, has_more: false });
    return json({ error: { code: 'NOT_FOUND', message: 'غير موجود' } }, 404);
  });
});
afterEach(() => {
  setFetchImpl(null);
});

it('checking a practice answer asks for its feedback once (the POST) — no racing GET; an unscored item says «غير محسوب»', async () => {
  render(
    <ToastProvider>
      <MemoryRouter initialEntries={['/exams/A1']}>
        <Routes>
          <Route path="/exams/:attemptId" element={<RunnerScreen />} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  );
  fireEvent.click(await screen.findByRole('radio', { name: /Ultrasound/ }));
  await waitFor(() => expect(screen.getByRole('radio', { name: /Ultrasound/ }).getAttribute('aria-checked')).toBe('true'));
  fireEvent.click(screen.getByRole('button', { name: 'تحقّق من إجابتي' }));
  await waitFor(() => expect(releaseAnswer).not.toBeNull());
  // let every effect of the «submitted» state run while the POST is still in flight
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  expect(calls.filter((c) => c.url.includes('/items/0/feedback'))).toEqual([]);
  await act(async () => {
    releaseAnswer!();
  });
  expect(await screen.findByText('غير محسوب.')).toBeTruthy();
  expect(screen.getAllByText(UNSCORED).length).toBeGreaterThan(0);
  expect(screen.queryByText('إجابة صحيحة')).toBeNull();
  expect(calls.filter((c) => c.url.includes('/items/0/feedback'))).toEqual([]);
  expect(calls.filter((c) => c.url.includes('/items/0/answer') && c.method === 'POST')).toHaveLength(1);
});
