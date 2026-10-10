// Track F3 (web) against a mocked server: the study-mode switch, the rail arranged by the mode (Exam hides the
// explanations and the source inspector, link reasons and the question's original page), the «حالات» section, the
// Create MCQ panel (capability reason / published / review queue / abstained), the mode persisted with the session
// (IndexedDB + outbox), and the figure reading (vision) that stays «غير مؤكدة» until the owner confirms it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  FEATURE_KEYS,
  type CapabilitiesResponse,
  type CaseSummaryView,
  type FeatureKey,
  type FigureReadingView,
  type GenerationRunView,
  type LectureQuestionsResponse,
  type SourcePageView,
} from '@medlevo/shared';
import { ToastProvider } from '../../../design';
import { setFetchImpl } from '../../../lib/api';
import { capabilitiesStore } from '../../../lib/capabilities';
import { getDb } from '../../../lib/localdb';
import type { SourceDocument } from '../data/useSourceDocument';
import type { WorkspaceSessionRow } from '../data/local';
import { SourceNavigationContext, type SourceNavigationApi } from '../nav/SourceNavigation';
import { CreateMcqPanel } from '../panels/CreateMcqPanel';
import { FigureReadingPanel } from '../panels/FigureReadingPanel';
import { StudyRail, type StudyRailProps } from '../panels/StudyRail';
import { useStudySession } from '../session/useStudySession';
import { StudyModeSwitch } from './StudyModeSwitch';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const AI_REASON = 'ميزات الذكاء الاصطناعي غير مفعّلة: لم يُضبط مفتاح مزود على الخادم (ANTHROPIC_API_KEY).';

function caps(overrides: Partial<Record<FeatureKey, { state: string; reason_ar?: string }>> = {}): CapabilitiesResponse {
  const features = Object.fromEntries(FEATURE_KEYS.map((k) => [k, { key: k, state: 'available' }])) as CapabilitiesResponse['features'];
  for (const [k, v] of Object.entries(overrides)) features[k as FeatureKey] = { key: k as FeatureKey, ...(v as { state: 'available' }) };
  return { features, ai: { configured: true }, server_time: 0, app_version: 'test' };
}

const pages = [
  { id: 'P0', page_index: 0, printed_label: '11', kind: 'page', version_id: 'V1' },
  { id: 'P1', page_index: 1, printed_label: '12', kind: 'page', version_id: 'V1' },
  { id: 'P2', page_index: 2, printed_label: '13', kind: 'page', version_id: 'V1' },
] as unknown as SourcePageView[];
const doc = {
  detail: { id: 'L1', title: 'Acute Appendicitis', source_type: 'lecture', language: 'en', links: [] },
  version: { id: 'V1', version_no: 1 },
  pages,
} as unknown as SourceDocument;

function item(id: string, onPage: boolean): LectureQuestionsResponse['items'][number] {
  return {
    question_id: id,
    origin_label_ar: `سؤال من مصدر الأسئلة — Bank — ص 1 — رقم السؤال ${id.slice(1)}`,
    stem_preview: `Stem of ${id}?`,
    qtype: 'sba',
    has_negation: false,
    answer_status: 'source_key',
    status: 'ready',
    scorable: true,
    on_this_page: onPage,
    occurrence: null,
    original: { source_id: 'QS', version_id: 'QV', page_id: 'QP0', page_index: 0, bbox: null, region_id: 'R1' },
    link: {
      id: `link-${id}`,
      question_id: id,
      lecture_source_id: 'L1',
      lecture_title: 'Acute Appendicitis',
      relation: 'directly_covered',
      score: 0.8,
      reason: 'الإجابة مذكورة في المحاضرة (ص 13).',
      matched_terms: [],
      lecture_pages: [{ page_id: 'P2', page_index: 2, label_ar: 'ص 13' }],
      answerable_from_lecture: true,
      origin: 'auto',
      status: 'suggested',
      decision_reason: null,
    },
  };
}
const lecture: LectureQuestionsResponse = {
  lecture: { source_id: 'L1', title: 'Acute Appendicitis', version_id: 'V1' },
  matching: { state: 'done', message_ar: null, job: null },
  items: [item('Q1', true), item('Q2', false)],
};

const kase = (over: Partial<CaseSummaryView> = {}): CaseSummaryView => ({
  id: 'C1',
  title: 'RIF pain in a 19-year-old',
  kind: 'case',
  kind_label_ar: 'حالة سريرية',
  station_type: null,
  origin: 'owner',
  origin_label_ar: 'كتبتها بنفسك',
  status: 'needs_review',
  status_label_ar: 'تحتاج مراجعة',
  status_reasons_ar: ['خطوة التشخيص بلا دليل مرتبط.'],
  version_no: 1,
  scope_describe_ar: null,
  attempts: 0,
  last_attempt: null,
  generation: null,
  created_at: 1,
  updated_at: 1,
  ...over,
});

const nav: SourceNavigationApi = { openSourceLocation: vi.fn(async () => ({ ok: true as const })), goBack: () => false, canGoBack: false, backLabel: null, clearHighlight: () => undefined };

function server(extra?: (url: string, method: string, body: unknown) => Response | null) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  setFetchImpl(async (url, init) => {
    const method = (init.method ?? 'GET').toUpperCase();
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : null;
    calls.push({ url, method, body });
    const r = extra?.(url, method, body);
    if (r) return r;
    if (url.startsWith('/api/questions/for-lecture/L1')) return json(lecture);
    if (url.startsWith('/api/cases?')) return json({ cases: [kase()], capabilities: {} });
    return json({ error: { code: 'NOT_FOUND', message: 'غير موجود' } }, 404);
  });
  return calls;
}

function rail(over: Partial<StudyRailProps>) {
  const props: StudyRailProps = {
    doc,
    page: pages[2]!,
    pageIndex: 2,
    tab: 'questions',
    onTab: () => undefined,
    mineTab: 'notes' as StudyRailProps['mineTab'],
    onMineTab: () => undefined,
    draft: null,
    onDraftConsumed: () => undefined,
    anchorFor: () => null,
    onGoToPage: () => undefined,
    onOpenSplit: () => undefined,
    splitReason: null,
    online: true,
    ...over,
  };
  return render(
    <MemoryRouter>
      <ToastProvider>
        <SourceNavigationContext.Provider value={nav}>
          <StudyRail {...props} />
        </SourceNavigationContext.Provider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => capabilitiesStore.reset(caps()));
afterEach(() => {
  setFetchImpl(null);
  capabilitiesStore.reset(null);
});

describe('study-mode switch', () => {
  it('names the current mode in the trigger and in words in the menu, and reports the chosen mode', () => {
    const onChange = vi.fn();
    render(<StudyModeSwitch mode="learn" onChange={onChange} />);
    const trigger = screen.getByRole('button', { name: 'وضع الدراسة: تعلّم' });
    fireEvent.click(trigger);
    const menu = screen.getByRole('menu', { name: 'وضع الدراسة' });
    const items = within(menu).getAllByRole('menuitem');
    expect(items).toHaveLength(5);
    expect(items[0]!.textContent).toContain('الحالي');
    expect(items[4]!.textContent).toContain('امتحن نفسك');
    fireEvent.click(items[4]!);
    expect(onChange).toHaveBeenCalledWith('exam');
  });
});

describe('the rail arranged by the study mode', () => {
  it('Learn: five sections in Learn order; questions show the link reason and the original page', async () => {
    server();
    rail({ mode: 'learn', tab: 'questions' });
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent);
    expect(tabs).toEqual(['الشرح والسؤال', 'المصادر', 'الأسئلة', 'حالات', 'ملاحظاتي']);
    expect(screen.getByText('وضع الدراسة: تعلّم')).toBeTruthy();
    await screen.findByText('في هذه الصفحة (1)');
    expect(screen.getAllByText('لماذا رُبط بهذه المحاضرة؟').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: /افتح الأصل/ }).length).toBeGreaterThan(0);
    // density «page»: the other pages stay one click away
    expect(screen.getByText('في صفحات أخرى من المحاضرة (1)').closest('summary')).toBeTruthy();
    const practice = screen.getAllByRole('link', { name: 'تدرّب' })[0]!;
    expect(practice.getAttribute('href')).toBe('/practice?source_id=L1&question_id=Q1');
  });

  it('Exam: explanations and sources are hidden with the reason; no link reason, no original page; an assessed exam starts', async () => {
    server();
    rail({ mode: 'exam', tab: 'explain' }); // a hidden section requested → the mode's default
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent);
    expect(tabs).toEqual(['الأسئلة', 'حالات', 'ملاحظاتي']);
    expect(screen.getByRole('note').textContent).toContain('مخفي الآن: «الشرح والسؤال» و«المصادر»');
    expect(screen.getByRole('tab', { name: 'الأسئلة' }).getAttribute('aria-selected')).toBe('true');
    await screen.findByText(/Stem of Q1/);
    expect(screen.queryByText('لماذا رُبط بهذه المحاضرة؟')).toBeNull();
    expect(screen.queryByRole('button', { name: /افتح الأصل/ })).toBeNull();
    expect(screen.queryByRole('link', { name: 'التفاصيل' })).toBeNull();
    const start = screen.getAllByRole('link', { name: 'امتحن نفسك' })[0]!;
    expect(start.getAttribute('href')).toBe('/practice?source_id=L1&question_id=Q1&mode=exam');
    // density «all»: every linked question is open
    expect(screen.queryByText('في صفحات أخرى من المحاضرة (1)')?.closest('summary') ?? null).toBeNull();
  });

  it('«حالات» lists the lecture’s cases with origin and status; Exam mode never shows the reasons (solution)', async () => {
    const calls = server();
    const { unmount } = rail({ mode: 'learn', tab: 'cases' });
    await screen.findByText('RIF pain in a 19-year-old');
    expect(calls.find((c) => c.url.startsWith('/api/cases'))!.url).toContain('source_id=L1');
    expect(screen.getByText('كتبتها بنفسك')).toBeTruthy();
    expect(screen.getByText('تحتاج مراجعة')).toBeTruthy();
    expect(screen.getByText('خطوة التشخيص بلا دليل مرتبط.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'افتح الحالة' }).getAttribute('href')).toBe('/cases/C1');
    unmount();
    server();
    rail({ mode: 'exam', tab: 'cases' });
    await screen.findByText('RIF pain in a 19-year-old');
    expect(screen.queryByText('خطوة التشخيص بلا دليل مرتبط.')).toBeNull();
    expect(screen.getByRole('link', { name: 'ابدأ الحالة' })).toBeTruthy();
  });

  it('«حالات» with no case of this lecture says so (and how to add one)', async () => {
    server((url) => (url.startsWith('/api/cases?') ? json({ cases: [], capabilities: {} }) : null));
    rail({ mode: 'practice', tab: 'cases' });
    expect(await screen.findByText('لا توجد حالات لهذه المحاضرة بعد')).toBeTruthy();
    expect(screen.getByRole('link', { name: /حالة جديدة/ })).toBeTruthy();
  });
});

const mcqRequest = { id: 'M1', source_id: 'L1', version_id: 'V1', page_id: 'P2', pageIndex: 2, text: 'McBurney point tenderness is classic.', rects: [] };
const run = (over: Partial<GenerationRunView>): GenerationRunView => ({
  id: 'G1',
  status: 'completed',
  status_label_ar: 'اكتمل',
  request: { lecture_source_id: 'L1', count: 1, difficulty: 'hard', item_types: [], language: 'en' },
  scope_describe_ar: 'المحاضرة فقط — Acute Appendicitis',
  job: null,
  abstain: null,
  candidates: [],
  summary_ar: 'نُشر سؤال واحد بعد التحقق.',
  created_at: 1,
  ...over,
});

function renderMcq() {
  return render(
    <MemoryRouter>
      <CreateMcqPanel request={mcqRequest} pageLabel="ص 13" onClose={() => undefined} />
    </MemoryRouter>,
  );
}

describe('Create MCQ from a selection', () => {
  it('without an AI provider: the capability reason is shown and the action is disabled', () => {
    capabilitiesStore.reset(caps({ 'ai.generate_questions': { state: 'requires_configuration', reason_ar: AI_REASON } }));
    const calls = server();
    renderMcq();
    const btn = screen.getByRole('button', { name: 'أنشئ السؤال' });
    expect(btn).toHaveProperty('disabled', true);
    const why = screen.getByText(AI_REASON);
    expect(btn.getAttribute('aria-describedby')).toBe(why.closest('[id]')!.id);
    fireEvent.click(btn);
    expect(calls.some((c) => c.url === '/api/exams/generate')).toBe(false);
  });

  it('sends the selection as the generation anchor (origin «selection») and shows a published question as generated', async () => {
    const calls = server((url, method) =>
      url === '/api/exams/generate' && method === 'POST'
        ? json({
            run: run({
              candidates: [{ id: 'c1', ord: 0, status: 'published', rounds: 1, question_id: 'GQ1', stem_preview: 'A 19-year-old with RIF pain…', learning_objective: null, concepts: [], difficulty_est: 'hard', issues: [] }],
            }),
          })
        : null,
    );
    renderMcq();
    fireEvent.click(screen.getByRole('button', { name: 'أنشئ السؤال' }));
    await screen.findByText('A 19-year-old with RIF pain…');
    const body = calls.find((c) => c.url === '/api/exams/generate')!.body as Record<string, unknown>;
    expect(body).toMatchObject({ lecture_source_id: 'L1', count: 1, origin: 'selection', anchor: { page_id: 'P2', region_ids: [], quote: mcqRequest.text } });
    expect(screen.getByText(/سؤال مولد/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'افتح السؤال' }).getAttribute('href')).toBe('/questions/GQ1');
    expect(screen.getByRole('link', { name: 'تدرّب عليه' }).getAttribute('href')).toBe('/practice?question_id=GQ1');
  });

  it('a candidate that failed validation is «لم يُنشر» with its checks; an abstention shows its suggestion', async () => {
    server((url, method) =>
      url === '/api/exams/generate' && method === 'POST'
        ? json({
            run: run({
              status: 'needs_review',
              status_label_ar: 'في قائمة المراجعة',
              summary_ar: 'لم يُنشر أي سؤال.',
              candidates: [
                { id: 'c1', ord: 0, status: 'needs_review', rounds: 3, question_id: null, stem_preview: 'Draft stem', learning_objective: null, concepts: [], difficulty_est: null, issues: [{ check: 'evidence', reason_ar: 'تفسير الخيار C بلا دليل.', by: 'evidence' }] },
              ],
            }),
          })
        : null,
    );
    const { unmount } = renderMcq();
    fireEvent.click(screen.getByRole('button', { name: 'أنشئ السؤال' }));
    expect(await screen.findByText('لم يُنشر: ينتظر مراجعتك في قائمة المراجعة ولن يدخل أي اختبار.')).toBeTruthy();
    expect(screen.getByText('تفسير الخيار C بلا دليل.')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'افتح السؤال' })).toBeNull();
    unmount();
    server((url, method) =>
      url === '/api/exams/generate' && method === 'POST'
        ? json({ run: run({ status: 'abstained', status_label_ar: 'امتنع', summary_ar: 'الأدلة لا تكفي.', abstain: { reason: 'insufficient_evidence', reason_ar: 'الأدلة لا تكفي', detail: '', suggestion_ar: 'اختر صعوبة أقل أو صفحات أكثر.' } }) })
        : null,
    );
    renderMcq();
    fireEvent.click(screen.getByRole('button', { name: 'أنشئ السؤال' }));
    expect(await screen.findByText('اختر صعوبة أقل أو صفحات أكثر.')).toBeTruthy();
  });
});

describe('study mode persistence', () => {
  it('a mode switch is written at once to the session row and the outbox, and restored when the reader reopens', async () => {
    setFetchImpl(async () => json({ error: { code: 'OFFLINE', message: 'offline' } }, 503));
    const db = getDb();
    await db.studySessions.clear();
    await db.outbox.clear();
    const opts = { sourceId: 'S-mode', versionIds: ['V1'], activeVersionId: 'V1', url: {}, online: false };
    const first = renderHook(() => useStudySession(opts));
    await waitFor(() => expect(first.result.current.decision).not.toBeNull());
    expect(first.result.current.mode).toBe('learn');
    act(() => first.result.current.setMode('exam', { location: { page_index: 3 }, versionId: 'V1' }));
    expect(first.result.current.mode).toBe('exam');
    const id = first.result.current.sessionId!;
    await waitFor(async () => expect(((await db.studySessions.get(id)) as WorkspaceSessionRow | undefined)?.mode).toBe('exam'));
    const ops = await db.outbox.where('[entity_type+entity_id]').equals(['study_session', id]).toArray();
    expect(ops.at(-1)!.payload).toMatchObject({ mode: 'exam', location: { page_index: 3 } });
    // an unknown mode is ignored
    act(() => first.result.current.setMode('cram' as never));
    expect(first.result.current.mode).toBe('exam');
    first.unmount();
    const again = renderHook(() => useStudySession(opts));
    await waitFor(() => expect(again.result.current.decision).not.toBeNull());
    expect(again.result.current.sessionId).toBe(id);
    expect(again.result.current.mode).toBe('exam');
    again.unmount();
  });

  it('a mode switch saves the view in use (a split view is not reset to «original») — F3 review', async () => {
    setFetchImpl(async () => json({ error: { code: 'OFFLINE', message: 'offline' } }, 503));
    const db = getDb();
    await db.studySessions.clear();
    await db.outbox.clear();
    const opts = { sourceId: 'S-mode-view', versionIds: ['V1'], activeVersionId: 'V1', url: {}, online: false };
    const h = renderHook(() => useStudySession(opts));
    await waitFor(() => expect(h.result.current.decision).not.toBeNull());
    act(() => h.result.current.setMode('practice', { location: { page_index: 2 }, versionId: 'V1', view: 'split' }));
    const id = h.result.current.sessionId!;
    await waitFor(async () => expect(((await db.studySessions.get(id)) as WorkspaceSessionRow | undefined)?.mode).toBe('practice'));
    expect(((await db.studySessions.get(id)) as WorkspaceSessionRow).view).toBe('split');
    h.unmount();
  });
});

const reading = (over: Partial<FigureReadingView> = {}): FigureReadingView => ({
  id: 'FR1',
  figure_region_id: 'R-fig',
  diagram_region_id: 'R-dia',
  page_id: 'P1',
  version_id: 'V1',
  source_id: 'L1',
  status: 'uncertain',
  status_label_ar: 'غير مؤكدة — تنتظر مراجعتك',
  label_ar: 'قراءة بصرية مشتقة',
  structure: {
    type: 'diagram',
    nodes: [
      { id: 'n1', label: 'RIF pain', certainty: 'read' },
      { id: 'n2', label: 'Alvarad0', certainty: 'uncertain' },
    ],
    edges: [{ from: 'n1', to: 'n2', certainty: 'uncertain' }],
    understanding: 'structure_read',
  },
  direction: 'top_down',
  direction_label_ar: 'من الأعلى إلى الأسفل',
  reviewed_structure: null,
  counts: { nodes: 2, edges: 1, uncertain: 2 },
  usable_as_fixed_answer: false,
  notes_ar: [],
  model: 'test-vision',
  job: null,
  error_ar: null,
  created_at: 1,
  reviewed_at: null,
  ...over,
});

describe('figure reading (vision step, AC-08)', () => {
  it('without a vision provider: the reason is shown and nothing is requested', async () => {
    const calls = server((url) =>
      url === '/api/processing/figures/R-fig/readings' ? json({ figure_region_id: 'R-fig', readings: [], can_analyze: { available: false, reason_ar: 'قراءة بنية الأشكال تحتاج مزود رؤية (ANTHROPIC_API_KEY).' } }) : null,
    );
    render(<FigureReadingPanel regionId="R-fig" online />);
    const btn = await screen.findByRole('button', { name: 'اقرأ بنية الشكل' });
    expect(btn).toHaveProperty('disabled', true);
    expect(screen.getByText('قراءة بنية الأشكال تحتاج مزود رؤية (ANTHROPIC_API_KEY).')).toBeTruthy();
    expect(screen.getByText(/لم يُقرأ هذا الشكل بعد/)).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('an uncertain reading says so in words and is never a fixed answer; confirming keeps only the relations the owner ticked', async () => {
    let current = reading();
    const calls = server((url, method, body) => {
      if (url === '/api/processing/figures/R-fig/readings') return json({ figure_region_id: 'R-fig', readings: [current], can_analyze: { available: true, reason_ar: null } });
      if (url === '/api/processing/figure-readings/FR1/review' && method === 'POST') {
        const b = body as { nodes: Array<{ id: string; label: string }>; edges: unknown[] };
        current = reading({
          status: 'owner_reviewed',
          status_label_ar: 'راجعتها وأكدتها',
          usable_as_fixed_answer: true,
          reviewed_structure: { type: 'diagram', nodes: b.nodes.map((n) => ({ ...n, certainty: 'read' as const })), edges: [], understanding: 'structure_read' },
        });
        return json({ reading: current });
      }
      return null;
    });
    render(<FigureReadingPanel regionId="R-fig" online />);
    expect(await screen.findByText('غير مؤكدة — تنتظر مراجعتك')).toBeTruthy();
    expect(screen.getByText(/لا تُعتمد إجابةً امتحانية ولا دليلًا ثابتًا/)).toBeTruthy();
    expect(screen.getByText(/من «RIF pain» إلى «Alvarad0»/)).toBeTruthy();
    expect(screen.getAllByText('(غير مؤكد)').length).toBe(2);
    fireEvent.click(screen.getByRole('button', { name: 'راجع القراءة' }));
    // the uncertain relation starts unticked
    const rel = screen.getByRole('checkbox', { name: /من «RIF pain» إلى «Alvarad0»/ });
    expect((rel as HTMLInputElement).checked).toBe(false);
    fireEvent.change(screen.getByLabelText('n2 — غير مؤكد'), { target: { value: 'Alvarado score' } });
    fireEvent.click(screen.getByRole('button', { name: 'أكّد القراءة كما راجعتها' }));
    await screen.findByText('راجعتها وأكدتها');
    const review = calls.find((c) => c.url.endsWith('/review'))!.body;
    expect(review).toEqual({ decision: 'confirm', nodes: [{ id: 'n1', label: 'RIF pain' }, { id: 'n2', label: 'Alvarado score' }], edges: [] });
    expect(screen.getByText(/أكدتَ هذه القراءة/)).toBeTruthy();
    expect(screen.getByText('Alvarado score')).toBeTruthy();
  });
});
