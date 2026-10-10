// G4 / AC-14, AC-15 — the answer check on the question detail screen: honestly disabled (with the server's reason)
// without an AI provider; when a check found a conflict, the conflict is shown with its evidence chips next to the
// printed key (which stays), and asking again posts to /answer-check and reloads.
import { afterEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { FEATURE_KEYS, type AnswerCheckView, type CapabilitiesResponse, type ClaimView, type EvidenceView, type FeatureKey, type QuestionDetailResponse, type RichText } from '@medlevo/shared';
import { ToastProvider } from '../../design';
import { setFetchImpl } from '../../lib/api';
import { capabilitiesStore } from '../../lib/capabilities';
import { QuestionDetailScreen } from './QuestionDetailScreen';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const rt = (t: string): RichText => ({ v: 1, paragraphs: [{ dir: 'ltr', runs: [{ t }] }] });

function caps(overrides: Partial<Record<FeatureKey, { state: string; reason_ar?: string }>>): CapabilitiesResponse {
  const features = Object.fromEntries(FEATURE_KEYS.map((k) => [k, { key: k, state: 'available' }])) as CapabilitiesResponse['features'];
  for (const [k, v] of Object.entries(overrides)) features[k as FeatureKey] = { key: k as FeatureKey, ...(v as { state: 'available' }) };
  return { features, ai: { configured: false }, server_time: 0, app_version: 'test' };
}

afterEach(() => {
  setFetchImpl(null);
  capabilitiesStore.reset(null);
});

const evidence: EvidenceView = {
  id: 'EV1',
  source_id: 'L1',
  source_title: 'Acute Appendicitis',
  source_type: 'lecture',
  version_id: 'LV1',
  version_no: 1,
  page_id: 'LP0',
  page_index: 0,
  locator_label_ar: 'ص 11',
  region_id: 'LR1',
  region_kind: 'paragraph',
  quote: "Pain usually begins in the periumbilical region and later migrates to the right iliac fossa (McBurney's point).",
  bbox: null,
  extraction_status: 'checks_passed',
  availability: 'available',
};
const claim: ClaimView = { id: 'C1', text: "Pain later migrates to the right iliac fossa (McBurney's point).", support_type: 'directly_stated', verification_status: 'linked', citations: [{ evidence, relation: 'supports' }], issues: [] };

function detail(check: AnswerCheckView | null, opts: { links?: boolean } = {}): QuestionDetailResponse {
  const conflict = check?.outcome === 'conflicts';
  const version = {
    id: 'V2',
    question_id: 'Q1',
    version_no: 2,
    kind: 'structured' as const,
    derived_from_version_id: 'V1',
    lang: 'en',
    qtype: 'sba' as const,
    item_type: null,
    stem: rt('In acute appendicitis, to which point does the pain classically migrate?'),
    stem_raw: null,
    has_negation: false,
    negation_terms: [],
    shuffle_allowed: true,
    extraction_status: 'checks_passed' as const,
    answer_status: conflict ? ('conflicting_key' as const) : ('source_key' as const),
    correct_option_ids: conflict ? null : ['op1'],
    key_details: check ? { conflict_ar: conflict ? check.reason_ar : undefined, answer_check: check } : null,
    explanation: null,
    distractor_explanations: null,
    learning_objective: null,
    difficulty_est: null,
    owner_reviewed_fields: [],
    validation: null,
    created_by: 'generation' as const,
    model: null,
    created_at: 0,
    options: [
      { id: 'op1', option_key: 'o1', source_label: 'A', ord: 0, text: rt("Murphy's point"), raw_text: null, region_id: null, pinned_position: false },
      { id: 'op2', option_key: 'o2', source_label: 'B', ord: 1, text: rt("McBurney's point"), raw_text: null, region_id: null, pinned_position: false },
    ],
  };
  return {
    question: {
      id: 'Q1',
      origin_type: 'source',
      origin_label_ar: 'سؤال من مصدر الأسئلة — G4 key check bank — ص 1 — رقم السؤال 1',
      status: 'ready',
      course_node_id: null,
      current: version,
      occurrences: [],
      lecture_links:
        opts.links === false
          ? []
          : [
              {
                id: 'LK1',
                question_id: 'Q1',
                lecture_source_id: 'L1',
                lecture_title: 'Acute Appendicitis',
                relation: 'strongly_related',
                score: 0.5,
                reason: 'مصطلحات السؤال مذكورة في المحاضرة.',
                matched_terms: [],
                lecture_pages: [],
                answerable_from_lecture: false,
                origin: 'auto',
                status: 'suggested',
                decision_reason: null,
              },
            ],
      duplicates: [],
      attempts_summary: { total: 1, correct: 1, last_at: null },
      created_at: 0,
      updated_at: 0,
    },
    versions: [{ ...version, attempts: 0, note: null }],
    key_entries: [],
    review_items: [],
    attempts_by_version: {},
    occurrence_boxes: {},
    scorable: !conflict,
    unscorable_reason_ar: conflict ? 'مفاتيح متعارضة' : null,
    answer_check_claims: check ? { C1: claim } : {},
  } as QuestionDetailResponse;
}

function renderDetail() {
  const router = createMemoryRouter([{ path: '/questions/:questionId', element: <QuestionDetailScreen /> }], { initialEntries: ['/questions/Q1'] });
  render(
    <ToastProvider>
      <RouterProvider router={router} />
    </ToastProvider>,
  );
}

const conflictCheck: AnswerCheckView = {
  outcome: 'conflicts',
  chosen_option_key: 'o2',
  key_option_keys: ['o1'],
  key_status: 'source_key',
  claim_ids: ['C1'],
  evidence_ids: ['EV1'],
  lecture_source_id: 'L1',
  scope_describe_ar: 'المحاضرة فقط: Acute Appendicitis',
  reason_ar: 'مفتاح المصدر يختار A لكن الأدلة المختارة تشير إلى B. لم يُصحَّح المفتاح ولا نتائج محاولاتك السابقة تلقائيًا؛ راجع الأدلة ثم حدد المفتاح بنفسك إن أردت.',
  model: 'scripted',
  checked_at: 0,
};

describe('G4 — answer check on the question detail screen', () => {
  it('without an AI provider: the button is disabled and the server\'s reason is shown and linked (no dead button)', async () => {
    capabilitiesStore.reset(caps({ 'ai.answer_check': { state: 'requires_configuration', reason_ar: 'تتطلب ضبط مزود ذكاء اصطناعي على الخادم (ANTHROPIC_API_KEY).' } }));
    setFetchImpl(async () => json(detail(null)));
    renderDetail();
    const btn = await screen.findByRole('button', { name: 'تحقق من الإجابة بالأدلة' });
    expect(btn).toHaveProperty('disabled', true);
    const why = screen.getByText(/ANTHROPIC_API_KEY/);
    expect(btn.getAttribute('aria-describedby')).toBe(why.id);
  });

  it('no linked lecture: disabled with a specific reason even when AI is available', async () => {
    capabilitiesStore.reset(caps({}));
    setFetchImpl(async () => json(detail(null, { links: false })));
    renderDetail();
    const btn = await screen.findByRole('button', { name: 'تحقق من الإجابة بالأدلة' });
    expect(btn).toHaveProperty('disabled', true);
    expect(screen.getByText(/لا توجد محاضرة مرتبطة بهذا السؤال/)).toBeTruthy();
  });

  it('a conflict is shown as a conflict, with the verified support and its evidence chip; asking again posts and reloads', async () => {
    capabilitiesStore.reset(caps({}));
    const calls: Array<{ url: string; method: string }> = [];
    setFetchImpl(async (url, init) => {
      calls.push({ url, method: init.method ?? 'GET' });
      if (url.endsWith('/answer-check')) return json({ check: conflictCheck, question: detail(conflictCheck).question, new_version_id: null, impact: null, claims: { C1: claim } });
      return json(detail(conflictCheck));
    });
    renderDetail();
    expect(await screen.findByText('تعارض بين المفتاح والأدلة')).toBeTruthy();
    // shown in the key section (as the conflict) and in the check result — MixedText isolates the Latin letters
    expect(document.body.textContent).toContain('مفتاح المصدر يختار A لكن الأدلة المختارة تشير إلى B');
    expect(screen.getAllByRole('note').some((n) => n.textContent?.includes('الأدلة المختارة تشير إلى B'))).toBe(true);
    expect(screen.getByRole('list', { name: 'أدلة التعليل' }).textContent).toContain('later migrates to the right iliac fossa');
    expect(screen.getByRole('list', { name: 'أدلة التعليل' }).textContent).toContain('ص11');
    const btn = screen.getByRole('button', { name: 'تحقق من الإجابة بالأدلة' });
    expect(btn).toHaveProperty('disabled', false);
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(calls.some((c) => c.url.endsWith('/api/questions/Q1/answer-check') && c.method === 'POST')).toBe(true);
    expect(calls.filter((c) => c.url.endsWith('/api/questions/Q1') && c.method === 'GET').length).toBeGreaterThanOrEqual(2);
  });
});
