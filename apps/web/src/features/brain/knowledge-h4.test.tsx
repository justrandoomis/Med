// Round 7 H4 items 2 + 3 (web): algorithms / flowcharts read from the lectures (steps with links to their places,
// certainty in words, a flowchart figure without a reviewed reading shows labels and NO arrows), and relations stated in
// prose (the exact sentence, «موضع الجملة», OCR marked).
import { afterEach, describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ConceptRelationView, KnowledgeAlgorithmListResponse, KnowledgeAlgorithmView } from '@medlevo/shared';
import { ToastProvider } from '../../design';
import { setFetchImpl } from '../../lib/api';
import { AlgorithmCard, AlgorithmList } from './AlgorithmList';
import { RelationRow } from './ConceptsScreen';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
afterEach(() => setFetchImpl(null));

const base = {
  source_id: 'S1',
  source_title: 'Appendix (TEST)',
  version_id: 'V1',
  section: null,
  concept: { id: 'C1', name: 'Acute appendicitis' },
  location: { source_id: 'S1', source_title: 'Appendix (TEST)', version_id: 'V1', page_id: 'P1', page_index: 0, page_label_ar: 'ص 3', region_id: 'R1' },
  notes_ar: [],
} satisfies Partial<KnowledgeAlgorithmView>;

const steps: KnowledgeAlgorithmView = {
  ...base,
  id: 'A1',
  kind: 'numbered_steps',
  kind_label_ar: 'خطوات مرقّمة',
  title: 'Management of acute appendicitis',
  certainty: 'stated',
  certainty_label_ar: 'مذكورة في نص المحاضرة كما طُبعت',
  ordered: true,
  nodes: [
    { key: 's1', text: 'Resuscitate with IV fluids', kind: 'step', region_id: 'R1', href: '/study/S1?v=V1&page_id=P1&region=R1' },
    { key: 's2', text: 'Arrange appendicectomy', kind: 'step', region_id: 'R2', href: null },
  ],
  edges: [{ from: 's1', to: 's2', label: null }],
};
const rules: KnowledgeAlgorithmView = {
  ...base,
  id: 'A2',
  kind: 'conditional',
  kind_label_ar: 'قواعد «إذا … فـ…»',
  title: 'Imaging',
  certainty: 'uncertain',
  certainty_label_ar: 'غير مؤكدة — مقروءة آليًا (OCR) وقد تكون فيها أخطاء',
  ordered: false,
  nodes: [
    { key: 'c1', text: 'the patient is pregnant', kind: 'condition', region_id: 'R3', href: '/study/S1?region=R3' },
    { key: 'a1', text: 'request ultrasound', kind: 'action', region_id: 'R3', href: '/study/S1?region=R3' },
    { key: 'e1', text: 'request CT abdomen', kind: 'action', region_id: 'R3', href: '/study/S1?region=R3' },
  ],
  edges: [
    { from: 'c1', to: 'a1', label: null },
    { from: 'c1', to: 'e1', label: 'Otherwise' },
  ],
  notes_ar: ['النص مقروء آليًا (OCR) وقد تكون فيه أخطاء؛ قارنه بالصفحة الأصلية.'],
};
const figure: KnowledgeAlgorithmView = {
  ...base,
  id: 'A3',
  kind: 'flowchart_figure',
  kind_label_ar: 'مخطط في شكل',
  title: 'Figure 1: Management pathway',
  certainty: 'uncertain',
  certainty_label_ar: 'غير مؤكدة — مقروءة آليًا (OCR) وقد تكون فيها أخطاء',
  ordered: false,
  nodes: [
    { key: 'n1', text: 'Alvarado score', kind: 'label', region_id: 'D1', href: '/study/S1?region=D1' },
    { key: 'n2', text: 'Surgical review', kind: 'label', region_id: 'D1', href: '/study/S1?region=D1' },
  ],
  edges: [],
  notes_ar: ['هذه تسميات الشكل كما قرأها OCR فقط: الأسهم واتجاهها غير مقروءة.'],
};

describe('AlgorithmCard', () => {
  it('numbered steps: an ordered list of the printed steps, each linked to its place (a vanished place is plain text)', () => {
    render(
      <MemoryRouter>
        <AlgorithmCard a={steps} />
      </MemoryRouter>,
    );
    const list = screen.getByRole('list');
    expect(list.tagName).toBe('OL');
    expect(within(list).getByRole('link', { name: 'Resuscitate with IV fluids' }).getAttribute('href')).toBe('/study/S1?v=V1&page_id=P1&region=R1');
    expect(within(list).queryByRole('link', { name: 'Arrange appendicectomy' })).toBeNull();
    expect(screen.getByText('مذكورة في نص المحاضرة كما طُبعت')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Acute appendicitis' }).getAttribute('href')).toBe('/concepts/C1');
  });

  it('rules: «إذا» + condition, the printed branch word; OCR certainty in words with its note', () => {
    render(
      <MemoryRouter>
        <AlgorithmCard a={rules} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: 'the patient is pregnant' })).toBeTruthy();
    expect(screen.getByText('Otherwise')).toBeTruthy();
    expect(screen.getByText(/غير مؤكدة — مقروءة آليًا/)).toBeTruthy();
    expect(screen.getByText(/قارنه بالصفحة الأصلية/)).toBeTruthy();
  });

  it('a flowchart figure without a reviewed reading: labels only, no arrows drawn, the reason stated', () => {
    render(
      <MemoryRouter>
        <AlgorithmCard a={figure} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('list', { name: 'تسميات الشكل' })).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'الأسهم المؤكدة' })).toBeNull();
    expect(screen.getByText(/الأسهم واتجاهها غير مقروءة/)).toBeTruthy();
  });

  it('AlgorithmList: loads by filter and says plainly when there is none', async () => {
    const urls: string[] = [];
    setFetchImpl(async (url) => {
      urls.push(url);
      const body: KnowledgeAlgorithmListResponse = { items: [], notes_ar: [] };
      return json(body);
    });
    render(
      <MemoryRouter>
        <AlgorithmList filter={{ conceptId: 'C1' }} emptyText="لا خوارزمية هنا." />
      </MemoryRouter>,
    );
    expect(await screen.findByText('لا خوارزمية هنا.')).toBeTruthy();
    expect(urls).toContain('/api/brain/algorithms?concept_id=C1');
  });
});

describe('a relation stated in prose (RelationRow)', () => {
  it('shows the exact sentence, «موضع الجملة», the stated support label and an OCR warning when uncertain', () => {
    const r: ConceptRelationView = {
      id: 'REL1',
      from: { id: 'C2', name: 'Gallstones', status: 'suggested' },
      to: { id: 'C3', name: 'Acute pancreatitis', status: 'suggested' },
      relation: 'causes',
      relation_label_ar: 'يسبب',
      support: 'stated',
      support_label_ar: 'مذكورة في النص',
      origin: 'auto',
      status: 'suggested',
      reasons: [
        {
          kind: 'stated_in_text',
          text_ar: 'مذكورة نصًا في «Pancreas (TEST)» (ص 1): «Gallstones» يسبب «Acute pancreatitis».',
          pattern: 'en.x_causes_y',
          uncertain: true,
          from: { source_id: 'S9', source_title: 'Pancreas (TEST)', version_id: 'V9', page_id: 'P9', page_index: 0, page_label_ar: 'ص 1', region_id: 'R9', quote: 'Gallstones can cause acute pancreatitis.' },
        },
      ],
      note: null,
      course_node_id: 'K',
      updated_at: 1,
    };
    render(
      <ToastProvider>
        <MemoryRouter>
          <ul>
            <RelationRow relation={r} />
          </ul>
        </MemoryRouter>
      </ToastProvider>,
    );
    expect(screen.getByText('Gallstones can cause acute pancreatitis.').tagName).toBe('BLOCKQUOTE');
    expect(screen.getByRole('link', { name: 'موضع الجملة' }).getAttribute('href')).toBe('/study/S9?page_id=P9&region=R9');
    expect(screen.getByText('مذكورة في النص')).toBeTruthy();
    expect(screen.getByText(/جملة مقروءة آليًا \(OCR\)/)).toBeTruthy();
  });
});
