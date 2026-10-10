// The Question Sheet with a mocked server and IndexedDB (fake-indexeddb): keyboard answering (digits, Arabic
// letters, arrows), local-first autosave (Dexie row + outbox upsert with the full state), no pause when the fixed
// policy forbids it, pause / resume hides the question, the active-time clock, resume after reload from the local
// copy, and the practice hint flow (hint → deeper hint → check → feedback; hints_used recorded; the checked answer
// is an append-only question attempt). Anti-shortcut keeps «اعرض الحل» disabled until an answer is chosen.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { EXAM_ITEM_ORIGIN_LABELS_AR, type AttemptFeedbackView, type ExamSessionView, type HintView, type RichText } from '@medlevo/shared';
import { ToastProvider } from '../../design';
import { setFetchImpl } from '../../lib/api';
import { getDb } from '../../lib/localdb';
import type { LocalExamAttemptRow } from './local';
import { RunnerScreen } from './RunnerScreen';

const rt = (t: string, dir: 'ltr' | 'rtl' = 'ltr'): RichText => ({ v: 1, paragraphs: [{ dir, runs: [{ t }] }] });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function sessionFor(mode: 'practice' | 'exam', policy: Partial<ExamSessionView['exam']['policy']> = {}): ExamSessionView {
  const practice = mode === 'practice';
  return {
    exam: {
      id: 'E1',
      title: 'Surgery practice',
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
      item_count: 2,
      scored_count: 2,
      build: null,
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
          { id: 'o3', display_label: 'C', text: rt("Kehr's point") },
        ],
        has_negation: false,
        negation_terms: [],
        media: [],
        scored: true,
        origin_type: 'source',
        origin_label_ar: EXAM_ITEM_ORIGIN_LABELS_AR.source,
      },
      {
        index: 1,
        question_id: 'Q2',
        question_version_id: 'V2',
        qtype: 'sba',
        stem: rt('ما هو الفحص الأولي المفضل عند الشك بحصى المرارة؟', 'rtl'),
        options: [
          { id: 'p1', display_label: 'أ', text: rt('Ultrasound') },
          { id: 'p2', display_label: 'ب', text: rt('CT abdomen') },
          { id: 'p3', display_label: 'ج', text: rt('MRCP') },
        ],
        has_negation: false,
        negation_terms: [],
        media: [],
        scored: true,
        origin_type: 'generated',
        origin_label_ar: EXAM_ITEM_ORIGIN_LABELS_AR.generated,
      },
    ],
    media_expires_at: null,
    unscored_reasons: {},
  };
}

const hint = (level: 1 | 2): HintView => ({
  level,
  title_ar: level === 1 ? 'التلميح الأول: أين تبحث' : 'التلميح الثاني: الكلمات المفتاحية في السؤال',
  text_ar: level === 1 ? 'ارجع إلى محاضرة «Acute Appendicitis» — ص 11.' : 'الكلمات المميزة أدناه تحدد المطلوب.',
  pages: [],
  stem: level === 2 ? { v: 1, paragraphs: [{ dir: 'ltr', runs: [{ t: 'Which point is ' }, { t: 'classically', marks: ['b'] }, { t: ' tender?' }] }] } : null,
  clues: level === 2 ? [{ text: 'classically', why_ar: '«classically»: يحدد الإجابة النموذجية.' }] : [],
});

const feedback = (hintsUsed: number): AttemptFeedbackView => ({
  is_correct: true,
  scored: true,
  correct_option_ids: ['o2'],
  answer_status: 'source_key',
  explanation: rt('Pain migrates to the right iliac fossa (McBurney point).'),
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
    confidence: 'confident',
    hints_used: hintsUsed,
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
  mastery_signal: hintsUsed > 0 ? 'correct_after_hint' : 'correct_confident_independent',
  mistake_reason_ar: null,
  claims: {},
  lecture_links: [],
  newer_version_note_ar: null,
  learning_objective: null,
  difficulty_est: null,
});

let calls: Array<{ url: string; method: string; body: unknown }> = [];
function mockServer(session: ExamSessionView) {
  calls = [];
  setFetchImpl(async (url, init) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method: String(init.method ?? 'GET'), body });
    if (url.endsWith('/api/exams/attempts/A1')) return json(session);
    if (url.includes('/items/0/hint')) return json({ hint: hint((body as { level: 1 | 2 }).level) });
    if (url.includes('/items/0/answer')) return json(feedback((body as { hints_used: number }).hints_used));
    if (url.includes('/api/sync/push')) return json({ results: [], server_seq: 0 });
    if (url.includes('/api/sync/pull')) return json({ changes: [], next_since: 0, has_more: false });
    return json({ error: { code: 'NOT_FOUND', message: 'غير موجود' } }, 404);
  });
}

function renderRunner() {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={['/exams/A1']}>
        <Routes>
          <Route path="/exams/:attemptId" element={<RunnerScreen />} />
          <Route path="/exams/:attemptId/results" element={<p>results page</p>} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  );
}

const outboxFor = async (type: string) => (await getDb().outbox.toArray()).filter((o) => o.entity_type === type);

beforeEach(async () => {
  const db = getDb();
  await Promise.all([db.outbox.clear(), db.examAttempts.clear(), db.questionAttempts.clear(), db.kv.clear()]);
});
afterEach(() => {
  setFetchImpl(null);
});

describe('exam runner (assessed)', () => {
  it('keyboard answering is saved locally first with a full-state outbox upsert; no pause, no hints, no solution', async () => {
    mockServer(sessionFor('exam'));
    renderRunner();
    expect(await screen.findByText('السؤال 1 من 2')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /إيقاف مؤقت/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /تلميح/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /اعرض الحل/ })).toBeNull();

    // the keyboard listener is (re)attached in a passive effect after the question is painted: flush effects first,
    // or a key pressed in that window reaches the listener of the loading render (flaky under a loaded machine)
    await act(async () => {});
    fireEvent.keyDown(window, { key: '2' });
    await waitFor(() => expect(screen.getByRole('radio', { name: /McBurney/ }).getAttribute('aria-checked')).toBe('true'));
    await waitFor(async () => {
      const ops = await outboxFor('exam_attempt');
      expect(ops).toHaveLength(1);
      expect((ops[0]!.payload as { answers: Record<string, { selected_option_ids: string[] }> }).answers['0']!.selected_option_ids).toEqual(['o2']);
    });
    const row = (await getDb().examAttempts.get('A1')) as LocalExamAttemptRow;
    expect(row.state.answers['0']!.selected_option_ids).toEqual(['o2']);
    // confidence after answering
    fireEvent.click(screen.getByRole('button', { name: 'واثق' }));
    await waitFor(async () => expect(((await getDb().examAttempts.get('A1')) as LocalExamAttemptRow).state.answers['0']!.confidence).toBe('confident'));

    // RTL: ArrowLeft goes to the next question; Arabic letter keys pick Arabic-labelled options
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(await screen.findByText('السؤال 2 من 2')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'ج' });
    await waitFor(() => expect(screen.getByRole('radio', { name: /MRCP/ }).getAttribute('aria-checked')).toBe('true'));
    // the navigator states answered / current in words
    expect(screen.getByRole('button', { name: 'السؤال 2، مُجاب، الحالي' })).toBeTruthy();
    // no answer / feedback calls during an exam
    expect(calls.some((c) => c.url.includes('/answer') || c.url.includes('/feedback') || c.url.includes('/hint'))).toBe(false);
  });

  it('during the attempt a generated item is visibly generated; a source item shows no origin (I1 #5)', async () => {
    mockServer(sessionFor('exam'));
    renderRunner();
    expect(await screen.findByText('السؤال 1 من 2')).toBeTruthy();
    expect(screen.queryByText(/سؤال مولد بواسطة MedLevo/)).toBeNull();
    expect(screen.queryByText(EXAM_ITEM_ORIGIN_LABELS_AR.source)).toBeNull();
    // flush the passive effect that attaches the keyboard listener before pressing a key (see the keyboard test above)
    await act(async () => {});
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(await screen.findByText('السؤال 2 من 2', {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByText(EXAM_ITEM_ORIGIN_LABELS_AR.generated).textContent).toContain('سؤال مولد بواسطة MedLevo');
  });

  it('resumes after a reload from the local copy (unsynced answers are never lost)', async () => {
    mockServer(sessionFor('exam'));
    const db = getDb();
    const st = sessionFor('exam').attempt;
    await db.examAttempts.put({
      id: 'A1',
      examId: 'E1',
      status: 'in_progress',
      startedAt: 1,
      updatedAt: 5,
      syncState: 'pending_sync',
      state: {
        status: 'in_progress',
        elapsed_ms: 42_000,
        current_index: 1,
        answers: { '0': { attempt_id: 'qa1', selected_option_ids: ['o3'], confidence: 'unsure', at: 5, time_ms: 3000, hints_used: 0, solution_viewed_before_answer: false, submitted: false } },
        flagged: [0],
        timer: { ...st.timer, item_ms: { '0': 30_000 } },
        finished_at: null,
      },
    } as LocalExamAttemptRow);
    renderRunner();
    expect(await screen.findByText('السؤال 2 من 2')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'السؤال 1، مُجاب، مُعلَّم للمراجعة' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /السؤال 1،/ }));
    await waitFor(() => expect(screen.getByRole('radio', { name: /Kehr/ }).getAttribute('aria-checked')).toBe('true'));
  });
});

describe('practice runner', () => {
  it('pause hides the question and stops the clock; resume shows it again; the clock counts active time', async () => {
    mockServer(sessionFor('practice'));
    renderRunner();
    expect(await screen.findByText('السؤال 1 من 2')).toBeTruthy();
    expect(await screen.findByText('00:01', {}, { timeout: 3000 })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'إيقاف مؤقت' }));
    expect(await screen.findByText(/الاختبار متوقف مؤقتًا/)).toBeTruthy();
    expect(screen.queryByRole('radio', { name: /McBurney/ })).toBeNull();
    await waitFor(async () => {
      const ops = await outboxFor('exam_attempt');
      expect((ops.at(-1)!.payload as { status: string }).status).toBe('paused');
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'استئناف' })[0]!);
    expect(await screen.findByRole('radio', { name: /McBurney/ })).toBeTruthy();
  });

  it('hint → deeper hint → check: hints are recorded, the feedback shows, the attempt is appended locally', async () => {
    mockServer(sessionFor('practice'));
    renderRunner();
    expect(await screen.findByText('السؤال 1 من 2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'تلميح' }));
    expect(await screen.findByText('التلميح الأول: أين تبحث')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'تلميح أعمق' }));
    expect(await screen.findByText('التلميح الثاني: الكلمات المفتاحية في السؤال')).toBeTruthy();
    expect(document.body.textContent).toContain('«classically»: يحدد الإجابة النموذجية.');
    expect(calls.filter((c) => c.url.includes('/hint')).map((c) => (c.body as { level: number }).level)).toEqual([1, 2]);

    fireEvent.click(screen.getByRole('radio', { name: /McBurney/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'تحقّق من إجابتي' }));
    expect(await screen.findByText('إجابة صحيحة')).toBeTruthy();
    expect(screen.getByText(/صحيحة بعد تلميح/)).toBeTruthy();
    expect(screen.getByText(/Pain migrates to the right iliac fossa/)).toBeTruthy();
    const answerCall = calls.find((c) => c.url.includes('/items/0/answer'))!;
    expect(answerCall.body).toMatchObject({ selected_option_ids: ['o2'], hints_used: 2 });
    await waitFor(async () => {
      const ops = await outboxFor('question_attempt');
      expect(ops).toHaveLength(1);
      expect(ops[0]).toMatchObject({ op: 'append' });
      expect(ops[0]!.payload).toMatchObject({ question_id: 'Q1', question_version_id: 'V1', exam_attempt_id: 'A1', exam_item_index: 0, hints_used: 2, selected_option_ids: ['o2'] });
    });
    // the checked answer is locked
    const opt = screen.getByRole('radio', { name: /Murphy/ });
    expect(opt.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(opt);
    expect(screen.getByRole('radio', { name: /McBurney/ }).getAttribute('aria-checked')).toBe('true');
    // the key is marked in words in the feedback
    const fb = screen.getByRole('region', { name: 'التصحيح والشرح' });
    expect(within(fb).getAllByText('الإجابة الصحيحة').length).toBeGreaterThan(0);
  });

  it('Anti-shortcut: «اعرض الحل» is disabled with the reason until an answer is chosen', async () => {
    mockServer(sessionFor('practice', { anti_shortcut: true }));
    renderRunner();
    expect(await screen.findByText('السؤال 1 من 2')).toBeTruthy();
    const btn = screen.getByRole('button', { name: 'اعرض الحل' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(screen.getByText(/وضع منع الاختصار مفعّل/)).toBeTruthy();
    await act(async () => {
      fireEvent.keyDown(window, { key: '1' });
    });
    await waitFor(() => expect((screen.getByRole('button', { name: 'اعرض الحل' }) as HTMLButtonElement).disabled).toBe(false));
  });
});
