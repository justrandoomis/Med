// Cases web: authoring drafts (round-trip through the shared schema), the case runner against a mocked server
// (only revealed facts / decision labels shown, a choice is an event with a client id, a failed request keeps the
// choice and is re-sent with the SAME id, OSCE text stays on the device until the server has it, viva answers carry
// the pending question), and the report (estimate wording, met / not met in words, owner override as an event).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { caseDefinitionInputSchema, type CaseDetailView, type CaseReportView, type CaseRunView, type CaseDefinition } from '@medlevo/shared';
import { ToastProvider } from '../../design';
import { setFetchImpl } from '../../lib/api';
import { CaseEditor } from './CaseEditor';
import { CaseReport } from './CaseReport';
import { CaseRunner } from './CaseRunner';
import { draftFromDefinition, draftProblems, emptyDraft, pointsAr, splitPhrases, toInput } from './model';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const honesty = { can_assess_ar: ['قراراتك في كل مرحلة'], cannot_assess_ar: ['لا تقيس المحاكاة تنفيذ الفحص الجسدي الفعلي'] };
const caseHeader = (kind: CaseRunView['case']['kind'] = 'case'): CaseRunView['case'] => ({
  id: 'C1',
  title: 'Right iliac fossa pain',
  kind,
  kind_label_ar: kind === 'osce' ? 'محطة OSCE' : kind === 'viva' ? 'امتحان شفهي (Viva)' : 'حالة سريرية تدريجية',
  origin: 'owner',
  origin_label_ar: 'كتبتها بنفسك',
  summary: 'Ahmad, 24 years, abdominal pain since yesterday',
  objectives: [],
  authored_note_ar: 'تفاصيل المريض والسيناريو بيانات تعليمية مؤلفة',
  osce: kind === 'osce' ? { station_type: 'history_taking', station_label_ar: 'أخذ القصة المرضية (History Taking)', candidate_instructions: 'خذ القصة المرضية.', roles: ['patient'], minutes: 8 } : null,
});

function runView(over: Partial<CaseRunView> = {}): CaseRunView {
  return {
    attempt: { id: 'A1', case_id: 'C1', case_version_no: 1, status: 'in_progress', feedback: 'immediate', judge: 'deterministic', mode: 'text', started_at: 1, finished_at: null, last_seq: 0 },
    case: caseHeader(),
    facts: [{ id: 'f_temp', label: 'الحرارة', value: '37.8 °C', kind: 'vital', kind_label_ar: 'العلامات الحيوية', revealed_by_ar: 'معروضة منذ البداية' }],
    stage: {
      id: 's_dx',
      type: 'diagnosis',
      type_label_ar: 'التشخيص (Diagnosis)',
      title: 'التشخيص',
      prompt: 'ما التشخيص الأرجح؟',
      select: 'one',
      decisions: [
        { id: 'd_app', label: 'Acute appendicitis', chosen: false },
        { id: 'd_chole', label: 'Acute cholecystitis', chosen: false },
      ],
      can_advance: false,
      is_last: false,
    },
    history: [],
    viva: null,
    can_finish: true,
    finished: false,
    claims: {},
    honesty,
    voice: { available: false, reason_ar: 'الوضع الصوتي غير متاح: لا يوجد مزود لتحويل الكلام إلى نص.' },
    ...over,
  };
}

let calls: Array<{ url: string; method: string; body: Record<string, unknown> | undefined }> = [];
let failNext = false;

function mockServer(initial: CaseRunView, onEvent: (body: Record<string, unknown>) => CaseRunView) {
  calls = [];
  setFetchImpl(async (url, init) => {
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ url, method: String(init.method ?? 'GET'), body });
    if (url.endsWith('/api/cases/attempts/A1') && (init.method ?? 'GET') === 'GET') return json(initial);
    if (url.endsWith('/api/cases/attempts/A1/events')) {
      if (failNext) {
        failNext = false;
        throw new TypeError('Failed to fetch');
      }
      return json({ result: 'applied', run: onEvent(body!) });
    }
    return json({ error: { code: 'NOT_FOUND', message: 'غير موجود' } }, 404);
  });
}

function renderAt(path: string) {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/cases/run/:attemptId" element={<CaseRunner />} />
          <Route path="/cases/report/:attemptId" element={<CaseReport />} />
          <Route path="/cases/:caseId/edit" element={<CaseEditor />} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  );
}

beforeEach(() => {
  failNext = false;
  window.localStorage.clear();
});
afterEach(() => setFetchImpl(null));

describe('authoring model', () => {
  it('starter drafts of every kind become valid inputs once filled', () => {
    for (const kind of ['case', 'osce', 'viva'] as const) {
      const d = emptyDraft(kind);
      expect(draftProblems(d).length).toBeGreaterThan(0); // title etc. missing — said before sending
      d.title = 'T';
      if (kind === 'case') d.stages.forEach((s) => (s.title = 'S'));
      if (kind === 'osce') {
        d.osce!.candidate_instructions = 'خذ القصة';
        d.checklist[0]!.text = 'سأل عن الألم';
        d.checklist[0]!.match = ['الألم'];
      }
      if (kind === 'viva') {
        d.viva!.questions[0]!.prompt = 'Q';
        d.viva!.questions[0]!.points[0]!.text = 'P';
        d.viva!.questions[0]!.points[0]!.match = ['x'];
      }
      expect(draftProblems(d)).toEqual([]);
      expect(caseDefinitionInputSchema.safeParse(toInput(d)).success).toBe(true);
    }
  });

  it('a stored definition round-trips into an editable draft keeping evidence ids', () => {
    const def: CaseDefinition = {
      schema_version: 1,
      kind: 'case',
      title: 'T',
      summary: '',
      language: 'ar',
      objectives: [],
      facts: [],
      stages: [{ id: 's1', type: 'review', title: 'R', prompt: '', reveal_fact_ids: [], select: 'none', decisions: [], next_stage_id: null, teaching_points: [{ text: 'A claim', medical: true, claim_id: 'cl1', evidence_ids: ['ev1'], status: 'needs_review', reason_ar: null }] }],
      start_stage_id: 's1',
      checklist: [],
      osce: null,
      viva: null,
    };
    const input = toInput(draftFromDefinition(def));
    expect(input.stages![0]!.teaching_points).toEqual([{ text: 'A claim', evidence_ids: ['ev1'], medical: true }]);
  });

  it('phrases split on Arabic and Latin commas; Arabic counting', () => {
    expect(splitPhrases('غثيان، nausea,  vomiting\nقيء')).toEqual(['غثيان', 'nausea', 'vomiting', 'قيء']);
    expect([pointsAr(1), pointsAr(2), pointsAr(3), pointsAr(11)]).toEqual(['نقطة واحدة', 'نقطتان', '3 نقاط', '11 نقطة']);
  });
});

describe('case runner', () => {
  it('shows revealed facts with the authored label and decision labels only; a confirmed choice is an event', async () => {
    mockServer(runView(), (b) =>
      runView({
        attempt: { ...runView().attempt, last_seq: 1 },
        stage: { ...runView().stage!, id: 's_mx', type: 'management', type_label_ar: 'التدبير (Management)', title: 'التدبير', prompt: 'الخطوة التالية؟', decisions: [{ id: 'd_sx', label: 'Surgical review', chosen: false }] },
        history: [
          {
            event_id: String(b.event_id),
            seq: 1,
            type: 'choose',
            at: 2,
            stage_title: 'التشخيص',
            label: 'Acute appendicitis',
            original_text: null,
            revised: false,
            feedback: { appropriateness: 'appropriate', appropriateness_label_ar: 'قرار مناسب', consequence: null, explanation: [{ text: 'Pain migrates to the RIF.', medical: true, claim_id: null, evidence_ids: [], status: 'no_evidence', reason_ar: null }] },
            revealed_fact_ids: [],
            patient_responses: [],
            no_response_ar: null,
            matched_items: [],
          },
        ],
      }),
    );
    renderAt('/cases/run/A1');
    expect(await screen.findByText('ملف المريض')).toBeTruthy();
    expect(screen.getByText('بيانات تعليمية مؤلفة')).toBeTruthy();
    expect(screen.getByText('37.8 °C')).toBeTruthy();
    expect(screen.queryByText(/قرار مناسب/)).toBeNull(); // nothing judged before choosing
    const confirm = screen.getByRole('button', { name: 'أكّد القرار' });
    expect((confirm as HTMLButtonElement).disabled || confirm.getAttribute('aria-disabled') === 'true').toBe(true);
    fireEvent.click(screen.getByLabelText('Acute appendicitis'));
    fireEvent.click(screen.getByRole('button', { name: 'أكّد القرار' }));
    await screen.findByRole('heading', { name: 'التدبير' });
    const ev = calls.find((c) => c.url.endsWith('/events'))!;
    expect(ev.body).toMatchObject({ type: 'choose', stage_id: 's_dx', decision_id: 'd_app' });
    expect(typeof ev.body!.event_id).toBe('string');
    expect(screen.getByText('قرار مناسب')).toBeTruthy();
    expect(screen.getByText('بلا دليل من مصادرك')).toBeTruthy(); // unlinked sentence marked in words
    expect(screen.getByText(/ما تقيّمه هذه المحاكاة/)).toBeTruthy();
  });

  it('a failed request keeps the choice and is re-sent with the same event id', async () => {
    mockServer(runView(), () => runView({ stage: { ...runView().stage!, decisions: runView().stage!.decisions.map((d) => ({ ...d, chosen: d.id === 'd_chole' })), is_last: true } }));
    renderAt('/cases/run/A1');
    fireEvent.click(await screen.findByLabelText('Acute cholecystitis'));
    failNext = true;
    fireEvent.click(screen.getByRole('button', { name: 'أكّد القرار' }));
    const alert = await screen.findByText('لم تُسجَّل الخطوة بعد');
    expect(alert).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'أعد الإرسال' }));
    await waitFor(() => expect(calls.filter((c) => c.url.endsWith('/events')).length).toBe(2));
    const [first, second] = calls.filter((c) => c.url.endsWith('/events'));
    expect(second!.body!.event_id).toBe(first!.body!.event_id);
    await waitFor(() => expect(screen.queryByText('لم تُسجَّل الخطوة بعد')).toBeNull());
  });

  it('OSCE text: the typed question stays on this device until sent; the patient answers only defined facts', async () => {
    const osce = runView({ case: caseHeader('osce'), stage: null, facts: [] });
    mockServer(osce, (b) =>
      runView({
        case: caseHeader('osce'),
        stage: null,
        facts: [{ id: 'f_onset', label: 'بداية الألم', value: 'بدأ الألم أمس حول السرة', kind: 'history', kind_label_ar: 'من القصة المرضية', revealed_by_ar: 'جواب المريض على سؤالك' }],
        history: [
          { event_id: String(b.event_id), seq: 1, type: 'utterance', at: 2, stage_title: null, label: String(b.text), original_text: null, revised: false, feedback: null, revealed_fact_ids: ['f_onset'], patient_responses: [{ fact_id: 'f_onset', text: 'بدأ الألم أمس حول السرة' }], no_response_ar: null, matched_items: ['Asked about onset'] },
        ],
      }),
    );
    renderAt('/cases/run/A1');
    const box = await screen.findByLabelText('سؤالك أو خطوتك');
    fireEvent.change(box, { target: { value: 'متى بدأ الألم؟' } });
    expect(window.localStorage.getItem('medlevo.cases.draft.A1')).toBe('متى بدأ الألم؟');
    expect(screen.getByText(/الوضع الصوتي غير متاح/)).toBeTruthy();
    failNext = true;
    fireEvent.click(screen.getByRole('button', { name: 'أرسل' }));
    await screen.findByText('لم تُسجَّل الخطوة بعد');
    expect((screen.getByLabelText('سؤالك أو خطوتك') as HTMLTextAreaElement).value).toBe('متى بدأ الألم؟'); // not lost
    fireEvent.click(screen.getByRole('button', { name: 'أرسل' }));
    const log = await screen.findByRole('list', { name: 'جواب المريض' });
    expect(within(log).getAllByText('بدأ الألم أمس حول السرة').length).toBeGreaterThan(0);
    expect(window.localStorage.getItem('medlevo.cases.draft.A1')).toBeNull();
  });

  // review regression: after «أعد الإرسال» succeeded the text stayed in the field, inviting a second (duplicate) send
  it('a re-sent OSCE question clears the field once the server has it (same event id, never sent twice)', async () => {
    const osce = runView({ case: caseHeader('osce'), stage: null, facts: [] });
    mockServer(osce, (b) =>
      runView({
        case: caseHeader('osce'),
        stage: null,
        facts: [],
        history: [{ event_id: String(b.event_id), seq: 1, type: 'utterance', at: 2, stage_title: null, label: String(b.text), original_text: null, revised: false, feedback: null, revealed_fact_ids: [], patient_responses: [], no_response_ar: 'لا تتوفر', matched_items: [] }],
      }),
    );
    renderAt('/cases/run/A1');
    fireEvent.change(await screen.findByLabelText('سؤالك أو خطوتك'), { target: { value: 'هل تدخن؟' } });
    failNext = true;
    fireEvent.click(screen.getByRole('button', { name: 'أرسل' }));
    await screen.findByText('لم تُسجَّل الخطوة بعد');
    fireEvent.click(screen.getByRole('button', { name: 'أعد الإرسال' }));
    await waitFor(() => expect((screen.getByLabelText('سؤالك أو خطوتك') as HTMLTextAreaElement).value).toBe(''));
    const sent = calls.filter((c) => c.url.endsWith('/events'));
    expect(sent).toHaveLength(2);
    expect(sent[1]!.body!.event_id).toBe(sent[0]!.body!.event_id);
    expect(window.localStorage.getItem('medlevo.cases.draft.A1')).toBeNull();
  });

  it('viva: the answer carries the pending question', async () => {
    const viva = runView({ case: caseHeader('viva'), stage: null, facts: [], viva: { current: { question_id: 'q1', follow_up_id: 'f_us', prompt: 'And in children?', index: 1, total: 2, is_follow_up: true }, answered: 1, total_questions: 2 } });
    mockServer(viva, () => runView({ case: caseHeader('viva'), stage: null, facts: [], viva: { current: null, answered: 2, total_questions: 2 } }));
    renderAt('/cases/run/A1');
    expect(await screen.findByText('سؤال متابعة')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('إجابتك'), { target: { value: 'Ultrasound' } });
    fireEvent.click(screen.getByRole('button', { name: 'أرسل الإجابة' }));
    await screen.findByText('أجبت عن كل الأسئلة');
    expect(calls.find((c) => c.url.endsWith('/events'))!.body).toMatchObject({ type: 'viva_answer', question_id: 'q1', follow_up_id: 'f_us', text: 'Ultrasound' });
  });
});

describe('report', () => {
  const report = (): CaseReportView => ({
    attempt: { ...runView().attempt, status: 'completed', finished_at: 5 },
    case: caseHeader(),
    checklist: [
      { id: 'c1', text: 'Examined the RIF', category: 'examination', category_label_ar: 'الفحص', points: 2, critical: false, auto_met: true, auto_reason_ar: 'تحقق باختيارك', override: null, met: true, rationale: [], evidence_note_ar: 'بند بلا دليل من مصادرك' },
      { id: 'c2', text: 'Reached the diagnosis', category: 'diagnosis', category_label_ar: 'التشخيص', points: 2, critical: true, auto_met: false, auto_reason_ar: 'لم تختر', override: null, met: false, rationale: [], evidence_note_ar: null },
    ],
    score: { got: 2, max: 4, label_ar: 'تقدير من بنود قائمة هذه الحالة فقط — ليس حكمًا على كفاءتك السريرية' },
    decisions: [],
    missed_appropriate: [],
    order_check: null,
    viva: null,
    review_plan: [],
    teaching_points: [],
    honesty,
    notes_ar: [],
    claims: {},
  });
  it('states the estimate, met / not met in words, and sends the owner override as an event', async () => {
    calls = [];
    setFetchImpl(async (url, init) => {
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method: String(init.method ?? 'GET'), body });
      if (url.endsWith('/report')) return json(report());
      if (url.endsWith('/events')) return json({ result: 'applied', run: runView() });
      return json({}, 404);
    });
    renderAt('/cases/report/A1');
    expect(await screen.findByText(/ليس حكمًا على كفاءتك السريرية/)).toBeTruthy();
    expect(screen.getByText('تحقق')).toBeTruthy();
    expect(screen.getByText('لم يتحقق')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: /صحّح الحكم/ })[1]!);
    fireEvent.change(screen.getByLabelText(/سبب حكمك/), { target: { value: 'وصلت بعد إعادة النظر' } });
    fireEvent.click(screen.getByRole('button', { name: 'أراه متحققًا' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/events'))).toBe(true));
    expect(calls.find((c) => c.url.endsWith('/events'))!.body).toMatchObject({ type: 'override_item', item_id: 'c2', met: true, note: 'وصلت بعد إعادة النظر' });
  });
});

// review regression: a local editor draft based on an older version (the case was saved elsewhere, or a save was
// refused with 409) was silently ignored on reload and then overwritten by the next keystroke — the owner's writing lost
describe('editor', () => {
  const definition = (title: string): CaseDefinition => ({
    schema_version: 1,
    kind: 'case',
    title,
    summary: '',
    language: 'ar',
    objectives: [],
    facts: [],
    stages: [{ id: 's1', type: 'review', title: 'R', prompt: '', reveal_fact_ids: [], select: 'none', decisions: [], next_stage_id: null, teaching_points: [] }],
    start_stage_id: 's1',
    checklist: [],
    osce: null,
    viva: null,
  });
  it('keeps a draft written on an older version and lets the owner restore it on top of the current version', async () => {
    const key = 'medlevo.cases.editor.C1';
    const mine = draftFromDefinition(definition('My long unsaved edit'));
    window.localStorage.setItem(key, JSON.stringify({ base: 2, draft: mine }));
    calls = [];
    const detail = { id: 'C1', kind: 'case', title: 'Saved elsewhere', version_no: 3, scope: null, definition: definition('Saved elsewhere') } as unknown as CaseDetailView;
    setFetchImpl(async (url, init) => {
      const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      calls.push({ url, method: String(init.method ?? 'GET'), body });
      if (url.endsWith('/api/cases/C1') && (init.method ?? 'GET') === 'GET') return json(detail);
      if (url.includes('/api/library/tree')) return json({ nodes: [], sources: [] });
      if (url.endsWith('/api/cases/C1') && init.method === 'PUT') return json({ ...detail, version_no: 4 });
      return json({ error: { code: 'NOT_FOUND', message: 'غير موجود' } }, 404);
    });
    renderAt('/cases/C1/edit');
    expect(await screen.findByText(/مسودة لم تُحفظ كتبتها على النسخة 2/)).toBeTruthy();
    const title = screen.getByDisplayValue('Saved elsewhere') as HTMLInputElement; // the current version is loaded
    // typing on the current version does not overwrite the set-aside draft
    fireEvent.change(title, { target: { value: 'Saved elsewhere!' } });
    await new Promise((r) => setTimeout(r, 450));
    expect(JSON.parse(window.localStorage.getItem(`${key}.stale`)!).draft.title).toBe('My long unsaved edit');
    fireEvent.click(screen.getByRole('button', { name: 'استعد مسودتي' }));
    expect(screen.getByDisplayValue('My long unsaved edit')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'احفظ' })[0]!);
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')!.body).toMatchObject({ base_version_no: 3, definition: { title: 'My long unsaved edit' } });
  });
});
