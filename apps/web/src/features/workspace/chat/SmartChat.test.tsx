// «المحادثة الذكية» (wp/smart-rail): the rail's first section is the study chat with its skills. Each chip calls the
// EXISTING capability (exams/generate, cases/generate, learning figure cards, studybook/compare, questions/for-lecture,
// the Source Lock), the result is appended to the conversation as a card (POST /threads/:id/cards) and rendered from
// its own module: an MCQ is answered (right / wrong, explanation, evidence page chips, «بانتظار مراجعتك» for what did
// not pass the checks), a case is revealed step by step, figure cards are added to the reviews, the linked questions and
// the sources are listed. Without an AI provider every AI chip is disabled with the server's reason and the chat says
// «الشرح غير متاح الآن». The «/» menu works from the keyboard.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { FEATURE_KEYS, type CapabilitiesResponse, type ChatMessageView, type ChatThreadView, type FeatureKey, type SourcePageView } from '@medlevo/shared';
import { ToastProvider } from '../../../design';
import { setFetchImpl } from '../../../lib/api';
import { capabilitiesStore } from '../../../lib/capabilities';
import type { SourceDocument } from '../data/useSourceDocument';
import { StudyRail } from '../panels/StudyRail';
import { SmartChat } from './SmartChat';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const AI_REASON = 'ميزات الذكاء الاصطناعي غير مفعّلة: لم يُضبط مفتاح مزود على الخادم (ANTHROPIC_API_KEY).';

function caps(overrides: Partial<Record<FeatureKey, { state: string; reason_ar?: string }>> = {}): CapabilitiesResponse {
  const features = Object.fromEntries(FEATURE_KEYS.map((k) => [k, { key: k, state: 'available' }])) as CapabilitiesResponse['features'];
  for (const [k, v] of Object.entries(overrides)) features[k as FeatureKey] = { key: k as FeatureKey, ...(v as { state: 'available' }) };
  return { features, ai: { configured: true }, server_time: 0, app_version: 'test' };
}

const pages = [0, 1, 2].map((i) => ({ id: `P${i}`, page_index: i, printed_label: String(11 + i), kind: 'page', version_id: 'V1', has_images: i === 2 })) as unknown as SourcePageView[];
const doc = {
  detail: { id: 'L1', title: 'Acute Appendicitis', source_type: 'lecture', language: 'en', links: [] },
  version: { id: 'V1', version_no: 1 },
  pages,
} as unknown as SourceDocument;

const rt = (t: string) => ({ v: 1, paragraphs: [{ runs: [{ t }] }] });
const thread: ChatThreadView = {
  id: 'T1',
  source_id: 'L1',
  version_id: 'V1',
  page_id: null,
  anchor: null,
  scope: { mode: 'lecture_only', source_ids: ['L1'], version_ids: ['V1'], describe_ar: 'المحاضرة فقط — Acute Appendicitis', hash: 'h' },
  style: 'detailed',
  socratic: false,
  title: null,
  created_at: 1,
  updated_at: 1,
  message_count: 0,
  last_message_preview: null,
  kind: 'chat',
  source_title: 'Acute Appendicitis',
};

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

/** A small stateful server: one conversation, cards appended to it, each module answering its own route. */
function server(extra?: (c: Call) => Response | null) {
  const calls: Call[] = [];
  const messages: ChatMessageView[] = [];
  let created = false;
  setFetchImpl(async (url, init) => {
    const method = (init.method ?? 'GET').toUpperCase();
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    const c = { url, method, body };
    calls.push(c);
    const r = extra?.(c);
    if (r) return r;
    if (url.startsWith('/api/studybook/chat/prefs')) return json({ prefs: { model: null, effort: null, auto_explain: false, sync_pages: true }, defaults: { model: null, effort: 'high' }, available_models: [] });
    if (url.startsWith('/api/studybook/threads?')) return json({ threads: created ? [thread] : [] });
    if (url === '/api/studybook/threads' && method === 'POST') {
      created = true;
      return json({ thread, messages: [] });
    }
    if (url === '/api/studybook/threads/T1/cards' && method === 'POST') {
      const owner = { id: `O${messages.length}`, thread_id: 'T1', role: 'owner', status: 'final', style: 'detailed', content: rt(String(body!.text)), artifact: null, abstain: null, reply_to_id: null, created_at: messages.length, page_indexes: [2] } as unknown as ChatMessageView;
      const answer = { id: `A${messages.length}`, thread_id: 'T1', role: 'assistant', status: 'final', style: 'detailed', content: rt('بطاقة'), artifact: null, abstain: null, reply_to_id: owner.id, created_at: messages.length + 1, page_indexes: [2], attachment: body!.attachment } as unknown as ChatMessageView;
      messages.push(owner, answer);
      return json({ owner_message: owner, answer });
    }
    if (url === '/api/studybook/threads/T1') return json({ thread, messages });
    if (url.startsWith('/api/processing/versions/V1/figure-descriptions'))
      return json({ version_id: 'V1', source_id: 'L1', items: [{ id: 'D1', version_id: 'V1', source_id: 'L1', page_id: 'P2', target: 'figure', content: { summary: 'CT' }, status: 'described' }], candidates: 1, run: null, can_describe: { available: true, reason_ar: null, consent_required: false }, max_images: 10, counts: {}, notice_ar: '' });
    return json({ error: { code: 'NOT_FOUND', message: 'غير موجود' } }, 404);
  });
  return calls;
}

const run = (over: Record<string, unknown> = {}) => ({
  id: 'G1',
  status: 'completed',
  status_label_ar: 'اكتمل',
  request: { lecture_source_id: 'L1', count: 3, difficulty: 'hard' },
  scope_describe_ar: 'المحاضرة فقط',
  job: null,
  abstain: null,
  candidates: [
    { id: 'C1', ord: 0, status: 'published', rounds: 1, question_id: 'Q1', stem_preview: 'Which sign…', learning_objective: null, concepts: [], difficulty_est: null, issues: [] },
    { id: 'C2', ord: 1, status: 'needs_review', rounds: 3, question_id: null, stem_preview: 'Draft…', learning_objective: null, concepts: [], difficulty_est: null, issues: [{ check: 'key', reason_ar: 'المفتاح غير مدعوم', by: 'validator' }] },
  ],
  summary_ar: 'نُشر سؤال واحد بعد التحقق؛ وسؤال ينتظر مراجعتك.',
  created_at: 1,
  ...over,
});

const session = {
  exam: { id: 'E1' },
  attempt: { id: 'A1-attempt', answers: {} },
  items: [{ index: 0, question_id: 'Q1', question_version_id: 'QV1', qtype: 'sba', stem: rt('Which sign is classic for appendicitis?'), options: [{ id: 'O1', display_label: 'A', text: rt('McBurney point tenderness') }, { id: 'O2', display_label: 'B', text: rt('Murphy sign') }], has_negation: false, negation_terms: [], media: [], scored: true, origin_type: 'generated', origin_label_ar: 'مولد' }],
  media_expires_at: null,
  unscored_reasons: {},
};

function renderChat(over: Partial<Parameters<typeof SmartChat>[0]> = {}) {
  const onJump = vi.fn();
  const onTool = vi.fn();
  const utils = render(
    <MemoryRouter>
      <ToastProvider>
        <SmartChat doc={doc} pageIndex={2} online layout="rail" onJumpToPage={onJump} onOpenTool={onTool} {...over} />
      </ToastProvider>
    </MemoryRouter>,
  );
  return { ...utils, onJump, onTool };
}

const chip = (name: string) => within(screen.getByRole('group', { name: 'مهارات المحادثة' })).getByRole('button', { name });
const card = (type: string) => document.querySelector<HTMLElement>(`.ch-card[data-card="${type}"]`);
const findCard = (type: string) =>
  waitFor(() => {
    const el = card(type);
    if (!el) throw new Error(`no ${type} card yet`);
    return el;
  });

beforeEach(() => capabilitiesStore.reset(caps()));
afterEach(() => {
  setFetchImpl(null);
  capabilitiesStore.reset(null);
});

describe('the two-section rail', () => {
  it('«المحادثة الذكية» and «ملاحظاتي» only; the chat is the first section, with its skills and composer', async () => {
    server();
    render(
      <MemoryRouter>
        <ToastProvider>
          <StudyRail
            doc={doc}
            page={pages[2]!}
            pageIndex={2}
            tab="chat"
            onTab={() => undefined}
            mineTab={'notes' as never}
            onMineTab={() => undefined}
            draft={null}
            onDraftConsumed={() => undefined}
            anchorFor={() => null}
            onGoToPage={() => undefined}
            onOpenSplit={() => undefined}
            splitReason={null}
            online
            onOpenChat={() => undefined}
          />
        </ToastProvider>
      </MemoryRouter>,
    );
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['المحادثة الذكية', 'ملاحظاتي']);
    const panel = screen.getByRole('tabpanel', { name: 'المحادثة الذكية' });
    expect(within(panel).getByRole('textbox', { name: 'رسالتك' })).toBeTruthy();
    expect(within(panel).getByRole('group', { name: 'مهارات المحادثة' })).toBeTruthy();
    expect(panel.querySelector('.sb-scope .ev-scope-badge')!.textContent).toContain('المحاضرة فقط');
    // the full side chat is one tap away
    expect(within(panel).getByRole('button', { name: 'افتح المحادثة بجانب الصفحة' })).toBeTruthy();
    for (const name of ['اشرح الصفحة', 'لخّص', 'اسألني MCQ', 'حالة سريرية', 'قارن', 'بطاقات', 'سؤال من الصورة', 'اشرح الشكل', 'أسئلة المحاضرة', 'المصادر']) expect(chip(name)).toBeTruthy();
  });
});

describe('skills → existing capabilities → cards in the conversation', () => {
  it('«اسألني MCQ»: count + difficulty → exams/generate on this page; the published question is answered in the card, the other waits for review', async () => {
    const calls = server((c) => {
      if (c.url === '/api/exams/generate' && c.method === 'POST') return json({ run: run() });
      if (c.url === '/api/exams/generate/G1') return json({ run: run() });
      if (c.url === '/api/exams' && c.method === 'POST') return json({ session, created: true });
      if (c.url === '/api/exams/attempts/A1-attempt/items/0/answer')
        return json({ is_correct: true, scored: true, correct_option_ids: ['O1'], answer_status: 'source_key', explanation: rt('McBurney point tenderness is the classic sign.'), distractor_explanations: null, occurrences: [], suggested_mistake_type: null, question_id: 'Q1', question_version_id: 'QV1', attempt: { selected_option_ids: ['O1'] }, origin_type: 'generated', origin_label_ar: '', answer_status_label_ar: '', options: [], stem: rt(''), negation_terms: [], unscored_reason_ar: null, mastery_signal: null, mistake_reason_ar: null, claims: {}, lecture_links: [{ lecture_source_id: 'L1', lecture_title: 'x', relation_label_ar: '', pages: [{ page_id: 'P1', label_ar: 'ص 12' }] }], newer_version_note_ar: null, learning_objective: null, difficulty_est: null });
      return null;
    });
    const { onJump } = renderChat();
    fireEvent.click(chip('اسألني MCQ'));
    const form = screen.getByRole('form', { name: 'اسألني MCQ' });
    fireEvent.click(within(form).getByRole('radio', { name: '1' }));
    fireEvent.click(within(form).getByRole('button', { name: 'ابدأ' }));
    await waitFor(() => expect(card('mcq')).toBeTruthy(), { timeout: 4000 });
    const gen = calls.find((c) => c.url === '/api/exams/generate' && c.method === 'POST')!;
    expect(gen.body).toMatchObject({ lecture_source_id: 'L1', page_ids: ['P2'], count: 1, difficulty: 'hard' });
    const appended = calls.find((c) => c.url === '/api/studybook/threads/T1/cards')!;
    expect(appended.body).toMatchObject({ skill: 'mcq', attachment: { type: 'mcq', run_id: 'G1', question_ids: ['Q1'], pending_ids: ['C2'] }, context: { page_id: 'P2' } });
    // the card: a practice attempt over the published question (idempotent on the card's message id)
    const box = card('mcq')!;
    const option = await within(box).findByRole('button', { name: /McBurney point tenderness/ });
    expect(calls.find((c) => c.url === '/api/exams' && c.method === 'POST')!.body).toMatchObject({ mode: 'practice', question_ids: ['Q1'], attempt_id: 'A0' });
    fireEvent.click(option);
    expect(await within(box).findByText('إجابة صحيحة')).toBeTruthy();
    expect(within(box).getByText('McBurney point tenderness is the classic sign.')).toBeTruthy();
    fireEvent.click(within(box).getByRole('button', { name: 'اذهب إلى الصفحة 12' }));
    expect(onJump).toHaveBeenCalledWith(1);
    // what did not pass the independent checks is never shown as a question here
    expect(within(box).getByText('بانتظار مراجعتك')).toBeTruthy();
    expect(within(box).getByRole('link', { name: 'راجعه' }).getAttribute('href')).toBe('/questions/review');
    expect(within(box).getByRole('button', { name: 'سؤال آخر' })).toBeTruthy();
  });

  it('«حالة سريرية»: cases/generate for this page; a ready case is revealed step by step — presentation → questions → answers', async () => {
    const detail = {
      id: 'K1',
      title: 'RIF pain',
      kind: 'case',
      origin: 'generated',
      status: 'ready',
      status_label_ar: 'جاهزة',
      status_reasons_ar: [],
      generation: { status: 'done', status_label_ar: 'اكتمل', job_id: null, message_ar: null, removed: [], model: null },
      definition: {
        schema_version: 1,
        kind: 'case',
        title: 'RIF pain',
        summary: 'A 19-year-old with RIF pain.',
        language: 'en',
        objectives: [],
        facts: [{ id: 'F1', label: 'Temp', value: '38.2', kind: 'vital', reveal: 'start' }],
        stages: [{ id: 'S1', type: 'diagnosis', title: 'Diagnosis', prompt: 'What is the most likely diagnosis?', reveal_fact_ids: [], select: 'one', decisions: [{ id: 'X1', label: 'Acute appendicitis', appropriateness: 'appropriate', reveal_fact_ids: [], consequence: '', explanation: [{ text: 'Classic migration of pain.', medical: true, claim_id: null, evidence_ids: [], status: 'linked', reason_ar: null }], next_stage_id: null }], next_stage_id: null, teaching_points: [] }],
        start_stage_id: 'S1',
        checklist: [],
        osce: null,
        viva: null,
      },
    };
    const calls = server((c) => {
      if (c.url === '/api/cases/generate') return json({ case: { id: 'K1', status_label_ar: 'قيد التوليد', generation: { status: 'queued', status_label_ar: 'في الانتظار' } } });
      if (c.url === '/api/cases/K1') return json(detail);
      return null;
    });
    renderChat();
    fireEvent.click(chip('حالة سريرية'));
    await waitFor(() => expect(card('case')).toBeTruthy());
    expect(calls.find((c) => c.url === '/api/cases/generate')!.body).toMatchObject({ lecture_source_id: 'L1', kind: 'case', page_ids: ['P2'] });
    const box = card('case')!;
    expect(await within(box).findByText('A 19-year-old with RIF pain.')).toBeTruthy();
    expect(within(box).queryByText('What is the most likely diagnosis?')).toBeNull();
    fireEvent.click(within(box).getByRole('button', { name: 'اعرض الأسئلة' }));
    expect(within(box).getByText('What is the most likely diagnosis?')).toBeTruthy();
    expect(within(box).queryByText('Acute appendicitis')).toBeNull();
    fireEvent.click(within(box).getByRole('button', { name: 'اعرض الإجابات' }));
    expect(within(box).getByText('Acute appendicitis')).toBeTruthy();
    expect(within(box).getByRole('link', { name: 'افتح الحالة كاملة' }).getAttribute('href')).toBe('/cases/K1');
  });

  it('a generated case that is not ready is never played in the chat («بانتظار مراجعتك»)', async () => {
    server((c) => {
      if (c.url === '/api/cases/generate') return json({ case: { id: 'K2', status_label_ar: 'تحتاج مراجعة', generation: null } });
      if (c.url === '/api/cases/K2') return json({ id: 'K2', title: 'x', origin: 'generated', status: 'needs_review', status_reasons_ar: ['خطوة التشخيص بلا دليل مرتبط.'], generation: { status: 'done' }, definition: { facts: [], stages: [] } });
      return null;
    });
    renderChat();
    fireEvent.click(chip('حالة سريرية'));
    const box = await findCard('case');
    expect(await within(box).findByText('بانتظار مراجعتك')).toBeTruthy();
    expect(within(box).getByText('خطوة التشخيص بلا دليل مرتبط.')).toBeTruthy();
    expect(within(box).queryByRole('button', { name: 'اعرض الأسئلة' })).toBeNull();
  });

  it('«بطاقات»: figure-card drafts of the lecture → preview → «أضف إلى مراجعاتي» accepts each draft', async () => {
    const flash = (id: string, draft: boolean) => ({ id, kind: 'basic', front: rt(`Front ${id}`), back: rt(`Back ${id}`), origin_ref: draft ? { draft: true } : {}, deleted_at: null });
    const calls = server((c) => {
      if (c.url === '/api/learning/cards/from-figures') return json({ cards: [flash('F1', true)], created: true, duplicates: [], notes_ar: ['أُنشئت بطاقة واحدة كمسودة موقوفة.'] });
      if (c.url.startsWith('/api/learning/cards/figure-drafts')) return json({ items: [flash('F1', true)] });
      if (c.url === '/api/learning/cards/F1') return json({ card: flash('F1', true), events: [], siblings: [] });
      if (c.url === '/api/learning/cards/F1/draft') return json({ card: flash('F1', false) });
      return null;
    });
    renderChat();
    // the skill needs the lecture's described figures (loaded from the processing module)
    await waitFor(() => expect(chip('بطاقات').hasAttribute('disabled')).toBe(false));
    fireEvent.click(chip('بطاقات'));
    const box = await findCard('cards');
    expect(await within(box).findByText('Front F1')).toBeTruthy();
    expect(within(box).getByText('أُنشئت بطاقة واحدة كمسودة موقوفة.')).toBeTruthy();
    fireEvent.click(within(box).getByRole('button', { name: 'أضف إلى مراجعاتي' }));
    expect(await within(box).findByText('في مراجعاتك')).toBeTruthy();
    expect(calls.find((c) => c.url === '/api/learning/cards/F1/draft')!.body).toEqual({ decision: 'accept' });
    expect(within(box).getByRole('link', { name: 'افتح مراجعاتي' })).toBeTruthy();
  });

  it('«قارن»: two terms → the evidence-checked compare; the card references the checked artifact', async () => {
    const calls = server((c) => (c.url === '/api/studybook/compare' ? json({ artifact: { id: 'ART1', kind: 'comparison', blocks: [], claims: {} }, cached: false }) : null));
    renderChat();
    fireEvent.click(chip('قارن'));
    const form = screen.getByRole('form', { name: 'قارن' });
    fireEvent.change(within(form).getByLabelText('الطرف الأول'), { target: { value: 'Ultrasound' } });
    fireEvent.change(within(form).getByLabelText('الطرف الثاني'), { target: { value: 'CT abdomen' } });
    fireEvent.click(within(form).getByRole('button', { name: 'قارن في جدول' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/studybook/threads/T1/cards')).toBe(true));
    expect(calls.find((c) => c.url === '/api/studybook/compare')!.body).toMatchObject({ items: ['Ultrasound', 'CT abdomen'], scope: { mode: 'lecture_only', lecture_source_id: 'L1' } });
    expect(calls.find((c) => c.url === '/api/studybook/threads/T1/cards')!.body).toMatchObject({ skill: 'compare', attachment: { type: 'compare', items: ['Ultrasound', 'CT abdomen'] }, artifact_id: 'ART1', text: 'قارن: Ultrasound / CT abdomen' });
  });

  it('«أسئلة المحاضرة»: the vault questions linked to this page, a compact list opening the question screen', async () => {
    const lecture = { lecture: { source_id: 'L1', title: 'x', version_id: 'V1' }, items: [{ question_id: 'Q7', origin_label_ar: 'سؤال من مصدر الأسئلة', stem_preview: 'Stem of Q7?', on_this_page: true, link: {} }], matching: { state: 'done', message_ar: null, job: null } };
    const calls = server((c) => (c.url.startsWith('/api/questions/for-lecture/L1') ? json(lecture) : null));
    const { onTool } = renderChat();
    fireEvent.click(chip('أسئلة المحاضرة'));
    const box = await findCard('questions');
    const link = await within(box).findByRole('link', { name: /Stem of Q7\?/ });
    expect(link.getAttribute('href')).toBe('/questions/Q7');
    expect(calls.find((c) => c.url === '/api/studybook/threads/T1/cards')!.body).toMatchObject({ attachment: { type: 'questions', ids: ['Q7'], page_id: 'P2' } });
    fireEvent.click(within(box).getByRole('button', { name: 'كل أسئلة المحاضرة' }));
    expect(onTool).toHaveBeenCalledWith('questions');
  });

  it('«المصادر»: the conversation’s Source Lock and the lecture’s sources; the figures / web pictures are one tap away', async () => {
    server();
    const { onTool } = renderChat();
    fireEvent.click(chip('المصادر'));
    const box = await findCard('sources');
    expect(box.querySelector('.ev-scope-badge')).toBeTruthy();
    expect(within(box).getByText('Acute Appendicitis')).toBeTruthy();
    fireEvent.click(within(box).getByRole('button', { name: 'الصفحة وأشكالها وصور الويب' }));
    expect(onTool).toHaveBeenCalledWith('sources');
  });
});

describe('honesty: what cannot run says why', () => {
  it('without an AI provider: «الشرح غير متاح الآن» with the reason; every AI chip disabled with the server reason; the rest still works', async () => {
    const off = { state: 'requires_configuration', reason_ar: AI_REASON };
    capabilitiesStore.reset(caps({ 'ai.chat': off, 'ai.generate_questions': off, 'ai.cases': off, 'ai.summaries': off, 'ai.figure_explain': off }));
    server();
    renderChat();
    expect(screen.getByText('الشرح غير متاح الآن')).toBeTruthy();
    const reasons = await screen.findByRole('list', { name: 'مهارات غير متاحة الآن' });
    expect(reasons.textContent).toContain(AI_REASON);
    for (const name of ['اشرح الصفحة', 'لخّص', 'اسألني MCQ', 'حالة سريرية', 'قارن', 'سؤال من الصورة', 'اشرح الشكل']) {
      const b = chip(name);
      expect(b.hasAttribute('disabled')).toBe(true);
      expect(document.getElementById(b.getAttribute('aria-describedby')!)!.textContent).toContain(AI_REASON);
    }
    expect(chip('المصادر').hasAttribute('disabled')).toBe(false);
    expect(chip('أسئلة المحاضرة').hasAttribute('disabled')).toBe(false);
  });

  it('«سؤال من الصورة» needs a described figure on this page (the reason is said on a page without one)', async () => {
    server();
    renderChat({ pageIndex: 0 });
    await waitFor(() => expect(chip('بطاقات').hasAttribute('disabled')).toBe(false)); // the descriptions loaded
    expect(chip('سؤال من الصورة').hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('list', { name: 'مهارات غير متاحة الآن' }).textContent).toContain('لا توجد في هذه الصفحة صورة موصوفة');
  });
});

describe('the «/» command menu', () => {
  it('«/» lists the skills; arrows move, Escape closes, Enter runs the active one', async () => {
    server();
    renderChat();
    const box = screen.getByRole('textbox', { name: 'رسالتك' });
    fireEvent.change(box, { target: { value: '/' } });
    const menu = screen.getByRole('listbox', { name: 'المهارات' });
    expect(within(menu).getAllByRole('option')).toHaveLength(10);
    expect(box.getAttribute('aria-activedescendant')).toContain('explain_page');
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(box.getAttribute('aria-activedescendant')).toContain('summarize');
    fireEvent.keyDown(box, { key: 'ArrowUp' });
    fireEvent.keyDown(box, { key: 'ArrowUp' });
    expect(box.getAttribute('aria-activedescendant')).toContain('sources'); // wraps
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(screen.queryByRole('listbox', { name: 'المهارات' })).toBeNull();
    // a typed command filters, Enter runs it (and clears the text)
    fireEvent.change(box, { target: { value: '/مصا' } });
    expect(within(screen.getByRole('listbox', { name: 'المهارات' })).getAllByRole('option').map((o) => o.textContent)).toEqual([expect.stringContaining('المصادر')]);
    fireEvent.keyDown(box, { key: 'Enter' });
    expect((box as HTMLTextAreaElement).value).toBe('');
    await waitFor(() => expect(card('sources')).toBeTruthy());
  });

  it('a skill with choices opens its form from the menu («/mcq» → the MCQ form)', () => {
    server();
    renderChat();
    const box = screen.getByRole('textbox', { name: 'رسالتك' });
    fireEvent.change(box, { target: { value: '/mcq' } });
    fireEvent.keyDown(box, { key: 'Tab' });
    expect(screen.getByRole('form', { name: 'اسألني MCQ' })).toBeTruthy();
  });
});
