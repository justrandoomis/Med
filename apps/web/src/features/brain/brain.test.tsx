// Course Brain web (track F2): map layout + keyboard model, the knowledge graph's accessibility (one tab stop, arrow
// keys RTL-aware, Enter selects with a live details panel, Escape clears, text twin with the same content), the concept
// correction view (decisions sent to the server), the Student Knowledge Map (states in words, estimate labelled, inferred
// prerequisites) and the coverage map (denominators, statuses in words).
import { afterEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { BrainConceptListResponse, ConceptRelationListResponse, CoverageResponse, KnowledgeMapResponse, StudentKnowledgeResponse, TopicDetailResponse } from '@medlevo/shared';
import { ToastProvider } from '../../design';
import { setFetchImpl } from '../../lib/api';
import { ConceptsScreen } from './ConceptsScreen';
import { CoverageView } from './CoverageView';
import { KnowledgeGraph } from './KnowledgeGraph';
import { KnowledgeScreen } from './KnowledgeScreen';
import { coverageLines, extractionCut, layoutMap, masteryText, moveFocus, nodeAccessibleName, prerequisiteLabel } from './model';
import { TopicScreen } from './TopicsScreen';
import { ActionButton, WEAKNESS_KIND_AR } from '../weakness/parts';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
afterEach(() => setFetchImpl(null));

const MAP: KnowledgeMapResponse = {
  course: { id: 'C', title: 'Course' },
  lecture_id: null,
  nodes: [
    { id: 'lecture:L1', type: 'lecture', label: 'Lecture 1 (TEST)', sublabel: 'محاضرة', status: 'extracted', href: '/study/L1', order: 0 },
    { id: 'lecture:L2', type: 'lecture', label: 'Lecture 2 (TEST)', sublabel: 'محاضرة', status: 'extracted', href: '/study/L2', order: 1 },
    { id: 'concept:A', type: 'concept', label: 'Sepsis', sublabel: 'مقبول — له تعريف في المحاضرة', status: 'accepted', href: '/concepts/A', order: 0 },
    { id: 'concept:B', type: 'concept', label: 'Septic shock', sublabel: 'مقترح', status: 'suggested', href: '/concepts/B', order: 1 },
    { id: 'concept:C', type: 'concept', label: 'Lactate', sublabel: 'مقترح', status: 'suggested', href: '/concepts/C', order: 2 },
    { id: 'question:Q1', type: 'question', label: 'Which finding defines septic shock?', sublabel: 'سؤال من المصادر', status: 'source', href: '/questions/Q1', order: 0 },
  ],
  edges: [
    { id: 'm1', from: 'lecture:L1', to: 'concept:A', kind: 'mentions', support: 'stated', relation: null, status: null, label_ar: 'مذكور في ص 1', pages: [{ page_id: 'P1', label_ar: 'ص 1' }] },
    { id: 'm2', from: 'lecture:L2', to: 'concept:B', kind: 'mentions', support: 'stated', relation: null, status: null, label_ar: 'مذكور في ص 1', pages: [{ page_id: 'P2', label_ar: 'ص 1' }] },
    { id: 'm3', from: 'lecture:L2', to: 'concept:C', kind: 'mentions', support: 'stated', relation: null, status: null, label_ar: 'مذكور في ص 2', pages: [{ page_id: 'P3', label_ar: 'ص 2' }] },
    { id: 'q1', from: 'question:Q1', to: 'concept:B', kind: 'covers', support: 'matched', relation: null, status: 'source', label_ar: 'اسم المفهوم في نص السؤال', pages: [] },
    { id: 'r1', from: 'concept:A', to: 'concept:B', kind: 'relation', support: 'inferred', relation: 'prerequisite', status: 'suggested', label_ar: 'متطلب سابق لـ (مستنتجة) — مقترحة', pages: [] },
  ],
  truncated: { concepts: { shown: 3, total: 3 }, questions: { shown: 1, total: 1 } },
  notes_ar: ['الخريطة إعادة تنظيم تعليمية لمحتوى المحاضرات، وليست صورة من المصدر.'],
};

describe('map model', () => {
  it('lays nodes out in three ordered columns (lectures, concepts, questions)', () => {
    const l = layoutMap(MAP);
    expect(l.columns.map((c) => c.map((n) => n.id))).toEqual([['lecture:L1', 'lecture:L2'], ['concept:A', 'concept:B', 'concept:C'], ['question:Q1']]);
    expect(l.rows).toBe(3);
    expect(l.heightPx).toBe(3 * 56);
  });
  it('moves inside a column and to the LINKED node of the adjacent column', () => {
    const l = layoutMap(MAP);
    expect(moveFocus(l, MAP.edges, 'lecture:L1', 'down')).toBe('lecture:L2');
    expect(moveFocus(l, MAP.edges, 'lecture:L1', 'up')).toBe('lecture:L1');
    // from lecture 2 (row 1) the nearest LINKED concept is B (row 1), never the unlinked A
    expect(moveFocus(l, MAP.edges, 'lecture:L2', 'next')).toBe('concept:B');
    expect(moveFocus(l, MAP.edges, 'concept:C', 'next')).toBe('question:Q1');
    expect(moveFocus(l, MAP.edges, 'question:Q1', 'prev')).toBe('concept:B');
    expect(moveFocus(l, MAP.edges, 'question:Q1', 'next')).toBe('question:Q1');
    expect(moveFocus(l, MAP.edges, 'concept:A', 'last')).toBe('concept:C');
  });
  it('names nodes with type, label, sub-label and link count; mastery never a bare number', () => {
    expect(nodeAccessibleName(MAP.nodes[2]!, 2)).toBe('مفهوم: Sepsis — مقبول — له تعريف في المحاضرة — رابطان');
    expect(masteryText(null, 2)).toBe('لا تقدير بعد (2 إجابات محسوبة)');
    expect(masteryText(0.8, 3)).toBe('تقدير: 80% (من 3 إجابات)');
    expect(coverageLines({ total: 4, with_source_questions: 2, with_generated_questions: 1, attempted: 1, uncovered: 1 }, { plural: 'صفحات' }).map((x) => [x.value, x.denominator])).toEqual([
      [2, 4],
      [1, 4],
      [1, 4],
      [1, 4],
    ]);
  });
});

function renderGraph(view: 'map' | 'list' = 'map') {
  return render(
    <div dir="rtl">
      <MemoryRouter>
        <KnowledgeGraph data={MAP} initialView={view} />
      </MemoryRouter>
    </div>,
  );
}

describe('KnowledgeGraph accessibility', () => {
  it('is a labelled group of real buttons with ONE tab stop and keyboard instructions', () => {
    renderGraph();
    const group = screen.getByRole('group', { name: 'خريطة المعرفة: محاضرتان، 3 مفاهيم، سؤال واحد' });
    expect(group.getAttribute('aria-describedby')).toBe('kb-map-help');
    expect(document.getElementById('kb-map-help')!.textContent).toContain('↑ و↓ داخل العمود');
    const buttons = within(group).getAllByRole('button');
    expect(buttons).toHaveLength(6);
    expect(buttons.filter((b) => b.tabIndex === 0)).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'مفهوم: Sepsis — مقبول — له تعريف في المحاضرة — رابطان' })).toBeTruthy();
  });

  it('arrow keys move focus (RTL: ArrowLeft = next column), Enter selects and the live panel lists the links, Escape clears', async () => {
    renderGraph();
    const l1 = screen.getByRole('button', { name: /^محاضرة: Lecture 1/ });
    act(() => l1.focus());
    fireEvent.keyDown(l1, { key: 'ArrowDown' });
    const l2 = screen.getByRole('button', { name: /^محاضرة: Lecture 2/ });
    await waitFor(() => expect(document.activeElement).toBe(l2));
    expect(l2.tabIndex).toBe(0);
    fireEvent.keyDown(l2, { key: 'ArrowLeft' }); // RTL: the next column is on the left
    const b = screen.getByRole('button', { name: /^مفهوم: Septic shock/ });
    await waitFor(() => expect(document.activeElement).toBe(b));
    fireEvent.click(b); // Enter / Space on a button = click
    expect(b.getAttribute('aria-pressed')).toBe('true');
    const panel = screen.getByRole('region', { name: 'تفاصيل العنصر المختار' });
    expect(panel.getAttribute('aria-live')).toBe('polite');
    expect(within(panel).getByText('Septic shock')).toBeTruthy();
    // its links: the lecture page (reader link), the question with its basis, the inferred relation in words
    expect(within(panel).getByRole('link', { name: 'ص 1' }).getAttribute('href')).toBe('/study/L2?page_id=P2');
    expect(within(panel).getByText('اسم المفهوم في نص السؤال')).toBeTruthy();
    expect(panel.textContent).toContain('(مستنتجة)');
    // «go to» moves the selection inside the map
    fireEvent.click(within(panel).getByRole('button', { name: 'انتقل في الخريطة إلى مفهوم: Sepsis' }));
    const a = screen.getByRole('button', { name: /^مفهوم: Sepsis/ });
    await waitFor(() => expect(a.getAttribute('aria-pressed')).toBe('true'));
    fireEvent.keyDown(a, { key: 'Escape' });
    expect(a.getAttribute('aria-pressed')).toBe('false');
    expect(within(panel).getByText(/اختر عنصرًا في الخريطة/)).toBeTruthy();
  });

  it('the text twin carries the same concepts, pages, questions and the inferred label', () => {
    renderGraph('list');
    expect(screen.queryByRole('group', { name: /خريطة المعرفة/ })).toBeNull();
    expect(screen.getByRole('heading', { name: /Lecture 1 \(TEST\)/ })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Sepsis' }).getAttribute('href')).toBe('/concepts/A');
    expect(screen.getAllByRole('link', { name: 'ص 2' })[0]!.getAttribute('href')).toBe('/study/L2?page_id=P3');
    expect(screen.getByText(/متطلب سابق لـ \(مستنتجة\)/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Which finding defines septic shock?' })).toBeTruthy();
    // the view switch is a labelled radio group
    fireEvent.click(screen.getByRole('radio', { name: 'الخريطة' }));
    expect(screen.getByRole('group', { name: /خريطة المعرفة/ })).toBeTruthy();
  });
});

describe('concept correction view', () => {
  it('lists concepts with roles and sends accept / reject / rename decisions; relations say «مستنتجة» and can be rejected', async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const list: BrainConceptListResponse = {
      items: [
        { id: 'A', name: 'الإنتان', name_en: 'Sepsis', name_ar: 'الإنتان', kind: null, origin: 'auto', status: 'suggested', name_origin: 'auto', aliases: [], roles: ['definition', 'heading'], has_definition: true, mention_count: 2, lecture_ids: ['L1'], owner_note: null, updated_at: 1 },
      ],
      counts: { suggested: 1, accepted: 0, rejected: 2, merged: 0 },
      notes_ar: ['قراراتك تبقى كما هي عند إعادة الاستخراج.'],
    };
    const rel: ConceptRelationListResponse = {
      items: [
        {
          id: 'R1',
          from: { id: 'A', name: 'الإنتان', status: 'suggested' },
          to: { id: 'B', name: 'Septic shock', status: 'suggested' },
          relation: 'prerequisite',
          relation_label_ar: 'متطلب سابق لـ',
          support: 'inferred',
          support_label_ar: 'مستنتجة — ليست نصًا من المحاضرة',
          origin: 'auto',
          status: 'suggested',
          reasons: [{ kind: 'defined_earlier_used_later', text_ar: '«الإنتان» معرَّف في «Lecture 1» ويُستخدم بعدها.', from: { source_id: 'L1', source_title: 'Lecture 1', version_id: 'V1', page_id: 'P1', page_index: 0, page_label_ar: 'ص 1', region_id: 'R', quote: 'Sepsis is defined as …' } }],
          note: null,
          course_node_id: 'C',
          updated_at: 1,
        },
      ],
      notes_ar: [],
    };
    setFetchImpl(async (url, init) => {
      const method = String(init.method ?? 'GET');
      calls.push({ url, method, body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (url.startsWith('/api/brain/concepts?') && method === 'GET') return json(list);
      if (url.startsWith('/api/brain/relations') && method === 'GET') return json(rel);
      if (url.startsWith('/api/brain/concepts/A') && method === 'PATCH') return json({ concept: { ...list.items[0], status: 'rejected' } });
      if (url.startsWith('/api/brain/relations/R1') && method === 'PATCH') return json({ relation: { ...rel.items[0], status: 'rejected' } });
      return json({ error: { code: 'NOT_FOUND', message: 'غير موجود' } }, 404);
    });
    render(
      <ToastProvider>
        <MemoryRouter initialEntries={['/concepts?course=C']}>
          <Routes>
            <Route path="/concepts" element={<ConceptsScreen />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>,
    );
    await screen.findByRole('link', { name: /Sepsis/ });
    expect(screen.getByText(/تعريف، عنوان/)).toBeTruthy();
    expect(screen.getByText(/مقترحة 1 · مقبولة 0 · مرفوضة 2/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'ارفض المفهوم الإنتان' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH' && c.url === '/api/brain/concepts/A' && (c.body as { status: string }).status === 'rejected')).toBe(true));
    // relations: inferred label in words + reasons + location links, reject sends the decision
    expect(await screen.findByText('مستنتجة — ليست نصًا من المحاضرة')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'موضع التعريف' }).getAttribute('href')).toBe('/study/L1?page_id=P1&region=R');
    fireEvent.click(screen.getByRole('button', { name: 'ارفض العلاقة: الإنتان متطلب سابق لـ Septic shock' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH' && c.url === '/api/brain/relations/R1')).toBe(true));
    // rename dialog sends both names
    fireEvent.click(screen.getByRole('button', { name: 'أعد تسمية الإنتان' }));
    const dlg = await screen.findByRole('dialog', { name: 'إعادة تسمية المفهوم' });
    fireEvent.change(within(dlg).getByLabelText('الاسم الإنجليزي'), { target: { value: 'Sepsis (owner)' } });
    fireEvent.click(within(dlg).getByRole('button', { name: 'احفظ' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH' && (c.body as { name_en?: string }).name_en === 'Sepsis (owner)')).toBe(true));
  });
});

describe('Student Knowledge Map', () => {
  it('states are words + icon, the estimate is labelled, inferred prerequisites say so, reasons are one tap away', async () => {
    const data: StudentKnowledgeResponse = {
      scope: { kind: 'all', id: null, title: null },
      items: [
        {
          concept_id: 'B',
          name: 'Septic shock',
          concept_status: 'suggested',
          state: 'practicing',
          state_label_ar: 'تتدرب عليه (لا تقدير بعد)',
          mastery_estimate: null,
          mastery_sample: 1,
          mastery_basis_ar: 'لا يُقدَّر الإتقان قبل 3 إجابات محسوبة على أسئلته (لديك 1).',
          reasons_ar: ['قرأت 1 من 2 صفحات يُذكر فيها.'],
          reading: { pages_total: 2, pages_viewed: 1 },
          practice: { questions: 2, question_attempts: 1, scored_attempts: 1, cards: 0, card_reviews: 0 },
          weakness: null,
          prerequisites: [{ concept_id: 'A', name: 'الإنتان', state: 'not_started', state_label_ar: 'لم تبدأ بعد', support: 'inferred', relation_status: 'suggested', relation_id: 'R1' }],
          lectures: [{ source_id: 'L2', title: 'Lecture 2', page_ids: ['P2'], first_page_label_ar: 'ص 1' }],
          next_step_ar: 'أجب عن 2 أسئلة محسوبة أخرى ليظهر تقدير الإتقان.',
        },
      ],
      counts: { not_started: 0, read: 0, practicing: 1, needs_work: 0, developing: 0, strong: 0 },
      estimate_note_ar: 'الإتقان هنا تقدير من إجاباتك على الأسئلة المرتبطة بكل مفهوم، وليس قياسًا يقينيًا.',
      notes_ar: [],
    };
    setFetchImpl(async (url) => (url.startsWith('/api/brain/knowledge') ? json(data) : url.startsWith('/api/library/tree') ? json({ nodes: [], sources: [] }) : json({}, 404)));
    render(
      <MemoryRouter initialEntries={['/knowledge']}>
        <Routes>
          <Route path="/knowledge" element={<KnowledgeScreen />} />
        </Routes>
      </MemoryRouter>,
    );
    const item = (await screen.findByRole('link', { name: 'Septic shock' })).closest('li')!;
    expect(within(item).getByText('تتدرب عليه (لا تقدير بعد)')).toBeTruthy();
    expect(within(item).getByText('لا تقدير بعد (إجابة محسوبة واحدة)')).toBeTruthy();
    expect(within(item).getByText('(علاقة مستنتجة — مقترحة لم تقررها)')).toBeTruthy();
    expect(within(item).getByText('لم تبدأ بعد')).toBeTruthy();
    expect(within(item).getByText('لماذا هذه الحالة؟')).toBeTruthy();
    expect(within(item).getByRole('link', { name: 'افتح ص 1' }).getAttribute('href')).toBe('/study/L2?page_id=P2');
    expect(screen.getByText(/ليس قياسًا يقينيًا/)).toBeTruthy();
  });
});

describe('Question Coverage Map', () => {
  it('shows every count with its denominator and statuses in words; source and generated kept apart', async () => {
    const cov: CoverageResponse = {
      scope: { kind: 'course', id: 'C', title: 'Course' },
      lectures: [
        {
          source_id: 'L1',
          title: 'Lecture 1',
          version_id: 'V1',
          pages: [
            { page_id: 'P1', page_index: 0, label_ar: 'ص 11', source_question_ids: ['Q1'], generated_question_ids: [], attempted_question_ids: ['Q1'], status: 'source' },
            { page_id: 'P2', page_index: 1, label_ar: 'ص 12', source_question_ids: [], generated_question_ids: ['G1'], attempted_question_ids: [], status: 'generated_only' },
            { page_id: 'P3', page_index: 2, label_ar: 'ص 13', source_question_ids: [], generated_question_ids: [], attempted_question_ids: [], status: 'uncovered' },
          ],
          concepts: [{ concept_id: 'A', name: 'Alvarado score', status_concept: 'accepted', page_ids: ['P1'], source_question_ids: ['Q1'], generated_question_ids: [], attempted_question_ids: ['Q1'], status: 'source', basis_ar: 'الأساس: اسم المفهوم في نص السؤال.' }],
          totals: {
            pages: { total: 3, with_source_questions: 1, with_generated_questions: 1, attempted: 1, uncovered: 1 },
            concepts: { total: 1, with_source_questions: 1, with_generated_questions: 0, attempted: 1, uncovered: 0 },
            questions: { source: 1, generated: 1, attempted_source: 1, attempted_generated: 0 },
          },
        },
      ],
      totals: { pages: { total: 3, with_source_questions: 1, with_generated_questions: 1, attempted: 1, uncovered: 1 }, concepts: { total: 1, with_source_questions: 1, with_generated_questions: 0, attempted: 1, uncovered: 0 } },
      notes_ar: ['تغطية أسئلة المصادر منفصلة عن تغطية الأسئلة المولدة.'],
    };
    setFetchImpl(async (url) => (url.startsWith('/api/brain/coverage') ? json(cov) : json({}, 404)));
    render(
      <MemoryRouter>
        <CoverageView courseNodeId="C" />
      </MemoryRouter>,
    );
    expect(await screen.findByText('الصفحات (المقام: 3 صفحات)')).toBeTruthy();
    expect(screen.getAllByText('1 من 3').length).toBeGreaterThanOrEqual(3);
    expect(screen.getAllByText('لها أسئلة من المصادر').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('أسئلة مولدة فقط')).toBeTruthy();
    expect(screen.getByText('بلا أسئلة')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'ص 12' }).getAttribute('href')).toBe('/study/L1?page_id=P2');
    expect(screen.getByText(/أسئلة من المصادر: 1 \(حاولت 1\) · أسئلة مولدة: 1 \(حاولت 0\)/)).toBeTruthy();
  });
});

describe('topic page', () => {
  it('suggested links show why; accept / reject send the decision; the library filter link is there', async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const detail: TopicDetailResponse = {
      topic: { id: 'T', title: 'Alvarado score', title_ar: null, parent_topic_id: null, created_at: 1, updated_at: 1 },
      links: [
        { id: 'K1', topic_id: 'T', entity_type: 'question', entity_id: 'Q1', origin: 'auto', status: 'suggested', created_at: 1, label: 'Which is NOT part of the Alvarado score?', sublabel: 'سؤال من المصادر', href: '/questions/Q1', reason_ar: 'اسم الموضوع مذكور في نص السؤال.' },
        { id: 'K2', topic_id: 'T', entity_type: 'source', entity_id: 'S1', origin: 'owner', status: 'accepted', created_at: 1, label: 'Appendicitis', sublabel: null, href: '/sources/S1', reason_ar: null },
      ],
      children: [],
      counts: { accepted: 1, suggested: 1, rejected: 0 },
    };
    setFetchImpl(async (url, init) => {
      const method = String(init.method ?? 'GET');
      calls.push({ url, method, body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (url === '/api/brain/topics/T') return json(detail);
      if (url === '/api/brain/topics') return json({ topics: [] });
      if (url.startsWith('/api/library/topic-links/')) return json({ link: {} });
      return json({}, 404);
    });
    render(
      <ToastProvider>
        <MemoryRouter initialEntries={['/library/topics/T']}>
          <Routes>
            <Route path="/library/topics/:topicId" element={<TopicScreen />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>,
    );
    expect(await screen.findByText('لماذا: اسم الموضوع مذكور في نص السؤال.')).toBeTruthy();
    expect(screen.getByRole('link', { name: /اعرض المكتبة مصفّاة بهذا الموضوع/ }).getAttribute('href')).toBe('/library?topic=T');
    fireEvent.click(screen.getByRole('button', { name: 'ارفض الاقتراح: Which is NOT part of the Alvarado score?' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/library/topic-links/K1' && c.method === 'PATCH' && (c.body as { status: string }).status === 'rejected')).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'أزل الرابط: Appendicitis' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/library/topic-links/K2' && c.method === 'DELETE')).toBe(true));
  });
});

describe('topic page — link a place in a source', () => {
  it('choose source, page, then a region by its text; page furniture is not offered; the link is sent as source_region', async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const detail: TopicDetailResponse = {
      topic: { id: 'T', title: 'Appendicitis', title_ar: null, parent_topic_id: null, created_at: 1, updated_at: 1 },
      links: [],
      children: [],
      counts: { accepted: 0, suggested: 0, rejected: 0 },
    };
    setFetchImpl(async (url, init) => {
      const method = String(init.method ?? 'GET');
      calls.push({ url, method, body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (url === '/api/brain/topics/T') return json(detail);
      if (url === '/api/brain/topics') return json({ topics: [] });
      if (url === '/api/library/tree') return json({ nodes: [], sources: [{ id: 'S1', title: 'Acute abdomen (TEST)', deleted_at: null, active_version_id: 'V1' }] });
      if (url === '/api/sources/S1/versions/V1/pages') {
        return json({ version: {}, pages: [{ id: 'P1', version_id: 'V1', page_index: 13, printed_label: '12', kind: 'page', numbered_version: false, processing_status: 'ready' }] });
      }
      if (url === '/api/sources/pages/P1/regions') {
        return json({
          page: {},
          regions: [
            { id: 'R0', kind: 'header', text: 'Surgery course — running header' },
            { id: 'R1', kind: 'paragraph', text: 'Appendicitis is inflammation of the vermiform appendix.' },
          ],
        });
      }
      if (url === '/api/library/topics/T/links') return json({ link: {} });
      return json({}, 404);
    });
    render(
      <ToastProvider>
        <MemoryRouter initialEntries={['/library/topics/T']}>
          <Routes>
            <Route path="/library/topics/:topicId" element={<TopicScreen />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'اربط موضعًا من مصدر' }));
    const dialog = await screen.findByRole('dialog');
    const list = await within(dialog).findByRole('list', { name: 'مواضع ص 12 (الصفحة 14 في الملف)' });
    expect(within(list).queryByText(/running header/)).toBeNull();
    fireEvent.click(within(list).getByRole('button', { name: /اربط الموضع: Appendicitis is inflammation/ }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === '/api/library/topics/T/links' && c.method === 'POST' && JSON.stringify(c.body) === JSON.stringify({ entity_type: 'source_region', entity_id: 'R1' }))).toBe(true),
    );
  });
});

describe('Weakness Center — case / OSCE / viva signals (track F2)', () => {
  it('a case weakness has its own kind label and the retry action opens the case', async () => {
    setFetchImpl(async () => json({}, 503));
    expect(WEAKNESS_KIND_AR.case).toBe('حالة / OSCE / شفهي');
    render(
      <ToastProvider>
        <MemoryRouter>
          <ActionButton action={{ kind: 'retry_case', label_ar: 'أعد محاولة «Station 3 (TEST)»', ref: { case_id: 'CASE 1' } }} back="/weakness" />
        </MemoryRouter>
      </ToastProvider>,
    );
    const link = await screen.findByRole('link', { name: 'أعد محاولة «Station 3 (TEST)»' });
    expect(link.getAttribute('href')).toBe('/cases/CASE%201');
  });
});

describe('review F2 — honest labels and robustness', () => {
  it('an inferred prerequisite stays «مستنتجة» but is never called «مقترحة» once accepted; owner relations say so', () => {
    expect(prerequisiteLabel({ support: 'inferred', relation_status: 'suggested' })).toBe('(علاقة مستنتجة — مقترحة لم تقررها)');
    expect(prerequisiteLabel({ support: 'inferred', relation_status: 'accepted' })).toBe('(علاقة مستنتجة — قبلتها)');
    expect(prerequisiteLabel({ support: 'stated', relation_status: 'accepted' })).toBe('(علاقة أقررتها)');
  });

  it('a capped extraction is recognised (the course page pill says «مستخرج جزئيًا»)', () => {
    expect(extractionCut({ mentions: 1500, mentions_found: 1640 })).toBe(true);
    expect(extractionCut({ mentions: 12, mentions_found: 12 })).toBe(false);
    expect(extractionCut({ mentions: 12 })).toBe(false);
  });

  it('the text twin says what backs each question → concept link, like the details panel', () => {
    renderGraph('list');
    const questions = screen.getByRole('heading', { name: 'الأسئلة' }).closest('section')!;
    expect(within(questions).getByText(/Septic shock \(اسم المفهوم في نص السؤال\)/)).toBeTruthy();
  });

  it('coverage: a lecture chosen before a refresh that is no longer there falls back to the whole course (no crash)', async () => {
    const lecture = (id: string, title: string): CoverageResponse['lectures'][number] => ({
      source_id: id,
      title,
      version_id: `V${id}`,
      pages: [{ page_id: `P${id}`, page_index: 0, label_ar: 'ص 1', source_question_ids: [], generated_question_ids: [], attempted_question_ids: [], status: 'uncovered' }],
      concepts: [],
      totals: {
        pages: { total: 1, with_source_questions: 0, with_generated_questions: 0, attempted: 0, uncovered: 1 },
        concepts: { total: 0, with_source_questions: 0, with_generated_questions: 0, attempted: 0, uncovered: 0 },
        questions: { source: 0, generated: 0, attempted_source: 0, attempted_generated: 0 },
      },
    });
    const cov = (lectures: CoverageResponse['lectures']): CoverageResponse => ({
      scope: { kind: 'course', id: 'C', title: 'Course' },
      lectures,
      totals: { pages: { total: lectures.length, with_source_questions: 0, with_generated_questions: 0, attempted: 0, uncovered: lectures.length }, concepts: { total: 0, with_source_questions: 0, with_generated_questions: 0, attempted: 0, uncovered: 0 } },
      notes_ar: [],
    });
    setFetchImpl(async (url) => (url === '/api/brain/coverage?course_node_id=C' ? json(cov([lecture('L1', 'Lecture one'), lecture('L2', 'Lecture two')])) : url === '/api/brain/coverage?course_node_id=C2' ? json(cov([lecture('L9', 'Lecture nine')])) : json({}, 404)));
    const view = render(
      <MemoryRouter>
        <CoverageView courseNodeId="C" />
      </MemoryRouter>,
    );
    fireEvent.change(await screen.findByLabelText('المحاضرة'), { target: { value: 'L2' } });
    expect(await screen.findByRole('heading', { name: 'Lecture two' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Lecture one' })).toBeNull();
    view.rerender(
      <MemoryRouter>
        <CoverageView courseNodeId="C2" />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { name: 'Lecture nine' })).toBeTruthy();
    expect((screen.getByLabelText('المحاضرة') as HTMLSelectElement).value).toBe('all');
  });
});
