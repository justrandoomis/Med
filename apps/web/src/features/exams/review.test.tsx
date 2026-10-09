// Regression tests from the independent review of track C4 (web):
//  * practice: the confidence of a checked answer is shown read-only (it was editable after seeing the correction,
//    changing only this device's copy — the recorded attempt kept the old value);
//  * a timed attempt whose fixed policy forbids pausing keeps counting while the tab is hidden (a hidden tab was an
//    implicit pause); a pausable practice still stops the clock;
//  * generated questions in an exam are announced as generated in the runner header;
//  * Anti-shortcut: the chosen answer is sent to the server before «اعرض الحل» (the server checks its own copy);
//  * the results page of an attempt that is still running says so (it claimed «you finished on this device»).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { AttemptFeedbackView, ExamBuildReport, ExamSessionView, RichText } from '@medlevo/shared';
import { ToastProvider } from '../../design';
import { setFetchImpl } from '../../lib/api';
import { getDb } from '../../lib/localdb';
import type { LocalExamAttemptRow } from './local';
import { ResultsScreen } from './ResultsScreen';
import { RunnerScreen } from './RunnerScreen';

const rt = (t: string, dir: 'ltr' | 'rtl' = 'ltr'): RichText => ({ v: 1, paragraphs: [{ dir, runs: [{ t }] }] });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function sessionFor(mode: 'practice' | 'exam', policy: Partial<ExamSessionView['exam']['policy']> = {}, build: ExamBuildReport | null = null): ExamSessionView {
  const practice = mode === 'practice';
  return {
    exam: {
      id: 'E1',
      title: 'Surgery set',
      mode,
      mode_label_ar: practice ? 'تدريب' : 'امتحان',
      policy: {
        pause_allowed: practice,
        hints: practice ? 'progressive' : 'off',
        show_solution: practice ? 'after_each' : 'at_end',
        shuffle_options: false,
        per_question_seconds: null,
        total_seconds: null,
        anti_shortcut: false,
        ...policy,
      },
      created_at: 1,
      is_generated_simulation: false,
      item_count: 1,
      scored_count: 1,
      build,
    },
    attempt: { id: 'A1', exam_id: 'E1', status: 'in_progress', started_at: 1, finished_at: null, elapsed_ms: 0, current_index: 0, answers: {}, flagged: [], timer: { item_ms: {}, pauses: 0, paused_at: null }, rev: 1, updated_at: 1 },
    items: [
      {
        index: 0,
        question_id: 'Q1',
        question_version_id: 'V1',
        qtype: 'sba',
        stem: rt('Which point is classically tender in acute appendicitis?'),
        options: [
          { id: 'o1', display_label: 'A', text: rt("Murphy's point") },
          { id: 'o2', display_label: 'B', text: rt("McBurney's point") },
        ],
        has_negation: false,
        negation_terms: [],
        media: [],
        scored: true,
      },
    ],
    media_expires_at: null,
    unscored_reasons: {},
  };
}

const feedback: AttemptFeedbackView = {
  is_correct: true,
  scored: true,
  correct_option_ids: ['o2'],
  answer_status: 'source_key',
  explanation: null,
  distractor_explanations: null,
  occurrences: [],
  suggested_mistake_type: null,
  question_id: 'Q1',
  question_version_id: 'V1',
  attempt: {
    id: 'X',
    question_id: 'Q1',
    question_version_id: 'V1',
    exam_attempt_id: 'A1',
    exam_item_index: 0,
    selected_option_ids: ['o2'],
    is_correct: true,
    scored: true,
    unscored_reason_ar: null,
    confidence: 'guess',
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
  origin_label_ar: 'سؤال من مصدر الأسئلة — Surgery Bank — ص 1 — رقم السؤال 1',
  answer_status_label_ar: 'مفتاح المصدر',
  options: sessionFor('practice').items[0]!.options,
  stem: rt('Which point is classically tender in acute appendicitis?'),
  negation_terms: [],
  unscored_reason_ar: null,
  mastery_signal: 'correct_guess',
  mistake_reason_ar: null,
  claims: {},
  lecture_links: [],
  newer_version_note_ar: null,
  learning_objective: null,
  difficulty_est: null,
};

let calls: Array<{ url: string; method: string; body: unknown }> = [];
function mockServer(session: ExamSessionView, extra: (url: string) => Response | null = () => null) {
  calls = [];
  setFetchImpl(async (url, init) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method: String(init.method ?? 'GET'), body });
    const x = extra(url);
    if (x) return x;
    if (url.endsWith('/api/exams/attempts/A1')) return json(session);
    if (url.includes('/items/0/answer')) return json(feedback);
    if (url.includes('/items/0/solution')) return json({ ...feedback, attempt: null });
    if (url.includes('/api/sync/push')) return json({ results: [], server_seq: 0 });
    if (url.includes('/api/sync/pull')) return json({ changes: [], next_since: 0, has_more: false });
    return json({ error: { code: 'NOT_FOUND', message: 'غير موجود' } }, 404);
  });
}

function renderAt(path: string) {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/exams/:attemptId" element={<RunnerScreen />} />
          <Route path="/exams/:attemptId/results" element={<ResultsScreen />} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  );
}

let hidden = false;
beforeEach(async () => {
  const db = getDb();
  await Promise.all([db.outbox.clear(), db.examAttempts.clear(), db.questionAttempts.clear(), db.kv.clear()]);
  hidden = false;
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
});
afterEach(() => {
  setFetchImpl(null);
  hidden = false;
});

describe('review fixes — runner', () => {
  it('practice: after «تحقّق» the confidence is shown read-only (never re-labelled after the correction)', async () => {
    mockServer(sessionFor('practice'));
    renderAt('/exams/A1');
    expect(await screen.findByText('السؤال 1 من 1')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: /McBurney/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'تخمين' }));
    fireEvent.click(await screen.findByRole('button', { name: 'تحقّق من إجابتي' }));
    expect(await screen.findByText('إجابة صحيحة')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'واثق' })).toBeNull();
    expect(screen.getByText('مدى ثقتك المسجّل مع إجابتك: تخمين')).toBeTruthy();
    const row = (await getDb().examAttempts.get('A1')) as LocalExamAttemptRow;
    expect(row.state.answers['0']!.confidence).toBe('guess');
  });

  it('a pausable practice: a hidden tab stops the clock (control)', async () => {
    mockServer(sessionFor('practice'));
    hidden = true;
    renderAt('/exams/A1');
    expect(await screen.findByText('السؤال 1 من 1')).toBeTruthy();
    expect(screen.queryByText(/لا إيقاف مؤقت في هذا الاختبار/)).toBeNull();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1600));
    });
    expect(screen.getByText('00:00')).toBeTruthy();
  });

  it('no pause allowed by the fixed policy: a hidden tab keeps the clock running', async () => {
    mockServer(sessionFor('exam', { total_seconds: 600, pause_allowed: false }));
    hidden = true;
    renderAt('/exams/A1');
    expect(await screen.findByText('السؤال 1 من 1')).toBeTruthy();
    expect(screen.getByText(/لا إيقاف مؤقت في هذا الاختبار/)).toBeTruthy();
    expect(await screen.findByText('09:59', {}, { timeout: 3000 })).toBeTruthy();
  });

  it('generated questions in the set are labelled as generated in the runner', async () => {
    const build: ExamBuildReport = {
      requested: 1,
      matched: 1,
      scorable: 1,
      unscorable: 0,
      duplicates_removed: 0,
      selected: 1,
      selected_scored: 1,
      selected_unscored: 0,
      by_origin: { source: 0, generated: 1, owner: 0 },
      my_mistakes: 0,
      exclusions: [],
      notes_ar: [],
    };
    mockServer(sessionFor('exam', {}, build));
    renderAt('/exams/A1');
    expect(await screen.findByText(/أسئلة مولدة بواسطة MedLevo من المصادر المحددة في هذه المجموعة: سؤال واحد/)).toBeTruthy();
  });

  it('Anti-shortcut: the chosen answer reaches the server before the solution is requested', async () => {
    mockServer(sessionFor('practice', { anti_shortcut: true }));
    renderAt('/exams/A1');
    expect(await screen.findByText('السؤال 1 من 1')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: /McBurney/ }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'اعرض الحل' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'اعرض الحل' }));
    await waitFor(() => expect(calls.some((c) => c.url.includes('/items/0/solution'))).toBe(true));
    const sol = calls.findIndex((c) => c.url.includes('/items/0/solution'));
    const pushBefore = calls.slice(0, sol).find((c) => c.url.includes('/api/sync/push'));
    expect(pushBefore).toBeTruthy();
    const ops = (pushBefore!.body as { ops: Array<{ entity_type: string; payload: { answers: Record<string, { selected_option_ids: string[] }> } }> }).ops;
    expect(ops.find((o) => o.entity_type === 'exam_attempt')!.payload.answers['0']!.selected_option_ids).toEqual(['o2']);
  });
});

describe('review fixes — results', () => {
  it('an attempt still running says so instead of «finished on this device»', async () => {
    mockServer(sessionFor('exam'), (url) => (url.includes('/result') ? json({ error: { code: 'CONFLICT', message: 'النتيجة تظهر بعد إنهاء الاختبار' } }, 409) : null));
    await getDb().examAttempts.put({
      id: 'A1',
      examId: 'E1',
      status: 'in_progress',
      startedAt: 1,
      updatedAt: 5,
      syncState: 'pending_sync',
      state: { status: 'in_progress', elapsed_ms: 1000, current_index: 0, answers: {}, flagged: [], timer: { item_ms: {}, pauses: 0, paused_at: null }, finished_at: null },
    } as LocalExamAttemptRow);
    renderAt('/exams/A1/results');
    expect(await screen.findByText('المحاولة لم تنتهِ بعد')).toBeTruthy();
    expect(screen.queryByText(/أنهيت المحاولة على هذا الجهاز/)).toBeNull();
    expect(screen.getByRole('link', { name: 'أكمل الاختبار' }).getAttribute('href')).toBe('/exams/A1');
  });
});
