// Round 7 — H3 item 3 (§26 Split Study: «محاضرة وأسئلة … محاضرة وشرح … لا تفقد حالة كل جزء عند تغيير أحدهما»): the second
// pane shows the lecture's questions (following the lecture page) or the explanations; switching between them keeps
// each one's state (no refetch, the explanation's draft question kept); «امتحن نفسك» does not offer the explanations.
import { useState as useStateCompat } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { FEATURE_KEYS, EXAM_MODE_HIDDEN_AR, type CapabilitiesResponse, type LectureQuestionsResponse, type SourcePageView } from '@medlevo/shared';
import { ToastProvider } from '../../../design';
import { setFetchImpl } from '../../../lib/api';
import { capabilitiesStore } from '../../../lib/capabilities';
import type { SourceDocument } from '../data/useSourceDocument';
import { arrangementFor } from '../modes/arrangement';
import { SourceNavigationContext, type SourceNavigationApi } from '../nav/SourceNavigation';
import { SplitSidePane, type SplitSideKind } from './SplitSidePane';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const AI_REASON = 'ميزات الذكاء الاصطناعي غير مفعّلة: لم يُضبط مفتاح مزود على الخادم (ANTHROPIC_API_KEY).';
function caps(): CapabilitiesResponse {
  const features = Object.fromEntries(FEATURE_KEYS.map((k) => [k, { key: k, state: 'available' }])) as CapabilitiesResponse['features'];
  for (const k of ['ai.explain', 'ai.chat', 'ai.summaries', 'ai.figure_explain'] as const) features[k] = { key: k, state: 'requires_configuration', reason_ar: AI_REASON } as CapabilitiesResponse['features'][typeof k];
  return { features, ai: { configured: false }, server_time: 0, app_version: 'test' };
}
const pages = [
  { id: 'P0', page_index: 0, printed_label: '11', kind: 'page', version_id: 'V1' },
  { id: 'P1', page_index: 1, printed_label: '12', kind: 'page', version_id: 'V1' },
] as unknown as SourcePageView[];
const doc = { detail: { id: 'L1', title: 'Acute Appendicitis', source_type: 'lecture', language: 'en', links: [] }, version: { id: 'V1', version_no: 1 }, pages } as unknown as SourceDocument;
const lecture: LectureQuestionsResponse = {
  lecture: { source_id: 'L1', title: 'Acute Appendicitis', version_id: 'V1' },
  matching: { state: 'done', message_ar: null, job: null },
  items: [
    {
      question_id: 'Q1',
      origin_label_ar: 'سؤال من مصدر الأسئلة — Bank — ص 1 — رقم السؤال 1',
      stem_preview: 'Which sign suggests appendicitis?',
      qtype: 'sba',
      has_negation: false,
      answer_status: 'source_key',
      status: 'ready',
      scorable: true,
      on_this_page: true,
      occurrence: null,
      original: { source_id: 'QS', version_id: 'QV', page_id: 'QP0', page_index: 0, bbox: null, region_id: 'R1' },
      link: { id: 'l1', question_id: 'Q1', lecture_source_id: 'L1', lecture_title: 'Acute Appendicitis', relation: 'directly_covered', score: 0.8, reason: 'مذكور في ص 12.', matched_terms: [], lecture_pages: [{ page_id: 'P1', page_index: 1, label_ar: 'ص 12' }], answerable_from_lecture: true, origin: 'auto', status: 'suggested', decision_reason: null },
    },
  ],
};
const nav: SourceNavigationApi = { openSourceLocation: vi.fn(async () => ({ ok: true as const })), goBack: () => false, canGoBack: false, backLabel: null, clearHighlight: () => undefined };

let questionCalls = 0;
beforeEach(() => {
  questionCalls = 0;
  capabilitiesStore.reset(caps());
  setFetchImpl(async (url) => {
    if (url.startsWith('/api/questions/for-lecture/L1')) {
      questionCalls++;
      return json(lecture);
    }
    return json({ error: { code: 'NOT_FOUND', message: 'غير موجود' } }, 404);
  });
});
afterEach(() => {
  setFetchImpl(null);
  capabilitiesStore.reset(null);
});

function Harness({ initial = 'questions' as SplitSideKind, exam = false }) {
  const [kind, setKind] = useStateCompat<SplitSideKind>(initial);
  return (
    <MemoryRouter>
      <ToastProvider>
        <SourceNavigationContext.Provider value={nav}>
          <SplitSidePane
            kind={kind}
            onKind={setKind}
            doc={doc}
            page={pages[1]!}
            pageIndex={1}
            online
            onGoToPage={() => undefined}
            arrangement={arrangementFor(exam ? 'exam' : 'learn')}
            explainHiddenReason={exam ? EXAM_MODE_HIDDEN_AR : null}
            onClose={() => undefined}
          />
        </SourceNavigationContext.Provider>
      </ToastProvider>
    </MemoryRouter>
  );
}
describe('H3 item 3 — the lecture next to its questions or the explanations', () => {
  it('shows the questions linked to the lecture page; switching to the explanations and back keeps both panes as they were', async () => {
    render(<Harness />);
    const pane = screen.getByRole('region', { name: /بجانب المحاضرة: الأسئلة المرتبطة/ });
    expect(await within(pane).findByText(/Which sign suggests appendicitis\?/)).toBeTruthy();
    expect(questionCalls).toBe(1);
    // to the explanations: the AI paths say why they are not available here (no key), honestly
    fireEvent.click(within(pane).getByRole('radio', { name: 'الشرح والسؤال' }));
    const explain = await screen.findByRole('region', { name: /بجانب المحاضرة: الشرح والسؤال/ });
    await waitFor(() => expect(explain.textContent).toContain('ANTHROPIC_API_KEY'));
    // back to the questions: still there, not fetched again (its state was kept, hidden)
    fireEvent.click(within(explain).getByRole('radio', { name: 'الأسئلة المرتبطة' }));
    expect(await screen.findByText(/Which sign suggests appendicitis\?/)).toBeTruthy();
    expect(questionCalls).toBe(1);
  });

  it('«امتحن نفسك»: the explanations are not offered beside the lecture (the reason is given)', async () => {
    render(<Harness exam />);
    const pane = screen.getByRole('region', { name: /بجانب المحاضرة/ });
    const explainOption = within(pane).getByRole('radio', { name: 'الشرح والسؤال' });
    expect(explainOption.hasAttribute('disabled') || explainOption.getAttribute('aria-disabled') === 'true').toBe(true);
    expect(await within(pane).findByText(/Which sign suggests appendicitis\?/)).toBeTruthy();
    // no link reason in Exam mode (the same arrangement as the rail)
    expect(screen.queryByText('لماذا رُبط بهذه المحاضرة؟')).toBeNull();
  });
});
