// Component behaviour of the Question Vault UI with a mocked server: the workspace rail tab (page-first order,
// origin jump, honest disabled «تدرّب»), the detail screen (negation emphasis, key origin, original-page link)
// and the review screen (blocking checks need an explicit acknowledgment).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, MemoryRouter, RouterProvider } from 'react-router-dom';
import type { CapabilitiesResponse, FeatureKey, LectureQuestionsResponse, QuestionDetailResponse, RichText } from '@medlevo/shared';
import { FEATURE_KEYS } from '@medlevo/shared';
import { ToastProvider } from '../../design';
import { setFetchImpl } from '../../lib/api';
import { capabilitiesStore } from '../../lib/capabilities';
import { SourceNavigationContext, type OpenSourceLocationRequest, type SourceNavigationApi } from '../workspace/nav/SourceNavigation';
import { QuestionsTab } from '../workspace/panels/QuestionsTab';
import type { SourceDocument } from '../workspace/data/useSourceDocument';
import { QuestionDetailScreen } from './QuestionDetailScreen';
import { ReviewScreen } from './ReviewScreen';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const rt = (t: string, marks?: Array<'b' | 'em'>): RichText => ({ v: 1, paragraphs: [{ dir: 'ltr', runs: [{ t, ...(marks ? { marks } : {}) }] }] });

function caps(overrides: Partial<Record<FeatureKey, { state: string; reason_ar?: string }>>): CapabilitiesResponse {
  const features = Object.fromEntries(FEATURE_KEYS.map((k) => [k, { key: k, state: 'available' }])) as CapabilitiesResponse['features'];
  for (const [k, v] of Object.entries(overrides)) features[k as FeatureKey] = { key: k as FeatureKey, ...(v as { state: 'available' }) };
  return { features, ai: { configured: false }, server_time: 0, app_version: 'test' };
}

beforeEach(() => {
  capabilitiesStore.reset(caps({ exams: { state: 'not_implemented', reason_ar: 'التدريب والامتحانات لم تُبنَ بعد.' } }));
});
afterEach(() => {
  setFetchImpl(null);
  capabilitiesStore.reset(null);
});

const lectureResponse: LectureQuestionsResponse = {
  lecture: { source_id: 'L1', title: 'Appendicitis', version_id: 'LV1' },
  matching: { state: 'done', message_ar: null, job: null },
  items: [
    item('Q2', false, 'directly_covered', 'Which point is classically tender in acute appendicitis?'),
    item('Q1', true, 'directly_covered', 'Which of the following is NOT typically part of the Alvarado score?'),
    item('Q3', false, 'course_related_only', 'ما هو الفحص الأولي المفضل عند الشك بحصى المرارة؟'),
  ],
};

function item(id: string, onPage: boolean, relation: 'directly_covered' | 'course_related_only', stem: string): LectureQuestionsResponse['items'][number] {
  return {
    question_id: id,
    origin_label_ar: `سؤال من مصدر الأسئلة — Bank — ص 1 — رقم السؤال ${id.slice(1)}`,
    stem_preview: stem,
    qtype: 'sba',
    has_negation: stem.includes('NOT'),
    answer_status: 'source_key',
    status: 'ready',
    scorable: true,
    on_this_page: onPage,
    occurrence: null,
    original: { source_id: 'QS', version_id: 'QV', page_id: 'QP0', page_index: 0, bbox: { x: 0.1, y: 0.2, w: 0.5, h: 0.03 }, region_id: 'R1' },
    link: {
      id: `link-${id}`,
      question_id: id,
      lecture_source_id: 'L1',
      lecture_title: 'Appendicitis',
      relation,
      score: 0.8,
      reason: 'الإجابة مذكورة في المحاضرة (ص 13).',
      matched_terms: ['Alvarado score'],
      lecture_pages: [{ page_id: 'P2', page_index: 2, label_ar: 'ص 13' }],
      answerable_from_lecture: relation === 'directly_covered',
      origin: 'auto',
      status: 'suggested',
      decision_reason: null,
    },
  };
}

const doc = {
  detail: { id: 'L1', title: 'Appendicitis' },
  pages: [
    { id: 'P0', page_index: 0 },
    { id: 'P1', page_index: 1 },
    { id: 'P2', page_index: 2 },
  ],
} as unknown as SourceDocument;

describe('workspace «الأسئلة» tab', () => {
  it('lists this page first, keeps course-only links collapsed, jumps to the original and disables «تدرّب» with the reason', async () => {
    const urls: string[] = [];
    setFetchImpl(async (url) => {
      urls.push(url);
      return json(lectureResponse);
    });
    const open = vi.fn(async (_req: OpenSourceLocationRequest) => ({ ok: true as const }));
    const nav: SourceNavigationApi = { openSourceLocation: open, goBack: () => false, canGoBack: false, backLabel: null, clearHighlight: () => undefined };
    const goTo = vi.fn();
    render(
      <MemoryRouter>
        <SourceNavigationContext.Provider value={nav}>
          <QuestionsTab doc={doc} page={doc.pages[2]!} pageIndex={2} onGoToPage={goTo} online />
        </SourceNavigationContext.Provider>
      </MemoryRouter>,
    );
    await screen.findByText('في هذه الصفحة (1)');
    expect(urls[0]).toContain('/api/questions/for-lecture/L1');
    expect(urls[0]).toContain('page_id=P2');
    const groups = screen.getAllByRole('region');
    expect(within(groups[0]!).getByText(/NOT typically part/)).toBeTruthy();
    expect(screen.getByText('مرتبطة بالكورس فقط (1)')).toBeTruthy();
    // «تدرّب» is disabled and the reason is visible and linked
    const practice = screen.getAllByRole('button', { name: 'تدرّب' })[0]!;
    expect(practice).toHaveProperty('disabled', true);
    const why = screen.getByText(/التدريب والامتحانات لم تُبنَ بعد/);
    expect(practice.getAttribute('aria-describedby')).toBe(why.id);
    // the origin label opens the question's own page, highlighted
    fireEvent.click(screen.getAllByRole('button', { name: /افتح الأصل/ })[0]!);
    await waitFor(() => expect(open).toHaveBeenCalled());
    expect(open.mock.calls[0]![0]).toMatchObject({ sourceId: 'QS', versionId: 'QV', pageId: 'QP0', regionId: 'R1', bbox: { x: 0.1, y: 0.2, w: 0.5, h: 0.03 } });
    // a lecture page of the reason moves the reader
    fireEvent.click(screen.getAllByRole('button', { name: 'ص 13' })[0]!);
    expect(goTo).toHaveBeenCalledWith(2);
  });

  it('shows the honest state when no question source exists in the course', async () => {
    setFetchImpl(async () => json({ ...lectureResponse, items: [], matching: { state: 'no_question_sources', message_ar: 'لا توجد مصادر أسئلة في كورس هذه المحاضرة بعد.', job: null } }));
    const nav = { openSourceLocation: vi.fn(), goBack: () => false, canGoBack: false, backLabel: null, clearHighlight: () => undefined } as unknown as SourceNavigationApi;
    render(
      <MemoryRouter>
        <SourceNavigationContext.Provider value={nav}>
          <QuestionsTab doc={doc} page={doc.pages[0]!} pageIndex={0} onGoToPage={() => undefined} online />
        </SourceNavigationContext.Provider>
      </MemoryRouter>,
    );
    expect(await screen.findByText('لا توجد مصادر أسئلة في كورس هذه المحاضرة بعد.')).toBeTruthy();
  });
});

function detailFixture(): QuestionDetailResponse {
  const version = {
    id: 'V1',
    question_id: 'Q1',
    version_no: 1,
    kind: 'raw_extraction' as const,
    derived_from_version_id: null,
    lang: 'en',
    qtype: 'sba' as const,
    item_type: 'recall',
    stem: { v: 1 as const, paragraphs: [{ dir: 'ltr' as const, runs: [{ t: 'Which of the following is ' }, { t: 'NOT', marks: ['b' as const, 'em' as const] }, { t: ' part of the score?' }] }] },
    stem_raw: '2. Which of the following is NOT part of the score?',
    has_negation: true,
    negation_terms: ['NOT'],
    shuffle_allowed: true,
    extraction_status: 'needs_review' as const,
    answer_status: 'source_key' as const,
    correct_option_ids: ['op2'],
    key_details: null,
    explanation: null,
    distractor_explanations: null,
    learning_objective: null,
    difficulty_est: null,
    owner_reviewed_fields: [],
    validation: {
      publishable: false,
      issues: [{ check: 'numbers_units_preserved' as const, passed: false, severity: 'blocker' as const, reason_ar: 'الأرقام أو الوحدات لا تطابق النص الأصلي.' }],
    },
    created_by: 'extraction' as const,
    model: null,
    created_at: 0,
    options: [
      { id: 'op1', option_key: 'o1', source_label: 'A', ord: 0, text: rt('Anorexia'), raw_text: 'A. Anorexia', region_id: null, pinned_position: false },
      { id: 'op2', option_key: 'o2', source_label: 'B', ord: 1, text: rt('Serum amylase'), raw_text: 'B. Serum amylase', region_id: null, pinned_position: false },
    ],
  };
  return {
    question: {
      id: 'Q1',
      origin_type: 'source',
      origin_label_ar: 'سؤال من مصدر الأسئلة — Bank — ص 1 — رقم السؤال 2 (Section A)',
      status: 'needs_review',
      course_node_id: null,
      current: version,
      occurrences: [
        {
          id: 'OC1',
          source_id: 'QS',
          source_title: 'Bank',
          source_type: 'question_source',
          source_version_id: 'QV',
          section_key: 'A',
          section_title: 'Section A',
          printed_number: '2',
          pages: [{ page_id: 'QP0', page_index: 0, label_ar: 'ص 1' }],
          region_ids: ['R1'],
          origin_label_ar: 'سؤال من مصدر الأسئلة — Bank — ص 1 — رقم السؤال 2 (Section A)',
        },
      ],
      lecture_links: [],
      duplicates: [],
      attempts_summary: { total: 0, correct: 0, last_at: null },
      created_at: 0,
      updated_at: 0,
    },
    versions: [{ ...version, attempts: 0, note: null }],
    key_entries: [],
    review_items: [],
    attempts_by_version: {},
    occurrence_boxes: { OC1: [{ page_id: 'QP0', page_index: 0, region_id: 'R1', bbox: { x: 0.1, y: 0.2, w: 0.5, h: 0.03 } }] },
    scorable: false,
    unscorable_reason_ar: 'فحص مانع لم يُجتز.',
  };
}

function renderAt(path: string, routes: Array<{ path: string; element: React.ReactNode }>) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <ToastProvider>
      <RouterProvider router={router} />
    </ToastProvider>,
  );
  return router;
}

describe('question detail', () => {
  it('emphasizes the negation, marks the answer with its origin and links the original page with the region', async () => {
    setFetchImpl(async () => json(detailFixture()));
    renderAt('/questions/Q1', [{ path: '/questions/:questionId', element: <QuestionDetailScreen /> }]);
    const nots = await screen.findAllByText('NOT');
    // the stem run carries em+b marks (the pill repeats the term as text)
    expect(nots.some((el) => el.closest('em') !== null && el.closest('.qv-stem') !== null)).toBe(true);
    expect(screen.getByText(/الإجابة — حسب مفتاح المصدر/)).toBeTruthy();
    const link = screen.getByRole('link', { name: /افتح الصفحة الأصلية/ });
    expect(decodeURIComponent(link.getAttribute('href')!)).toContain('/study/QS?v=QV&page=0&page_id=QP0&bbox=0.1,0.2,0.5,0.03&region=R1');
    expect(screen.getAllByText('التدريب والامتحانات لم تُبنَ بعد.').length).toBeGreaterThan(0);
  });
});

describe('side-by-side review', () => {
  it('a blocking check refuses «accept» until the owner explicitly acknowledges it', async () => {
    const bodies: unknown[] = [];
    setFetchImpl(async (url, init) => {
      if (url.includes('/original')) return json({ error: { code: 'NOT_FOUND', message: 'لا يوجد موضع.' } }, 404);
      if (url.endsWith('/review') && init.method === 'POST') {
        const body = JSON.parse(init.body as string);
        bodies.push(body);
        if (!body.acknowledge_blockers) {
          return json(
            { error: { code: 'CONFLICT', message: 'لا يُعتمد السؤال تلقائيًا.', details: { blockers: [{ check: 'numbers_units_preserved', reason_ar: 'الوحدة تغيرت.' }] } } },
            409,
          );
        }
        return json({ question: detailFixture().question, new_version_id: null, impact: null, validation: null });
      }
      return json(detailFixture());
    });
    const router = renderAt('/questions/Q1/review', [
      { path: '/questions/:questionId/review', element: <ReviewScreen /> },
      { path: '/questions/:questionId', element: <p>detail</p> },
    ]);
    const accept = await screen.findByRole('button', { name: 'قبول كما هو' });
    await act(async () => {
      fireEvent.click(accept);
    });
    expect(await screen.findByText(/الوحدة تغيرت/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'قبول كما هو' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByLabelText('قارنتُ النص بالأصل وأعتمده رغم ذلك'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'قبول كما هو' }));
    });
    await waitFor(() => expect(router.state.location.pathname).toBe('/questions/Q1'));
    expect(bodies[1]).toMatchObject({ decision: 'accept', acknowledge_blockers: true });
    expect((bodies[1] as { reviewed_fields: string[] }).reviewed_fields).toEqual(expect.arrayContaining(['stem', 'options']));
  });
});
