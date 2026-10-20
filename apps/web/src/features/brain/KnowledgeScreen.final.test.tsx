// Round 7 final critic sweep («knowledge», 390 / 1280 px): every concept row of «خريطة معرفتي» read «0 من 1 صفحات يُذكر
// فيها» and «0 محاولة على 1 سؤال» — Arabic counted nouns must agree with their number (Arabic-first, §22).
import { afterEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { StudentConceptView, StudentKnowledgeResponse } from '@medlevo/shared';
import { setFetchImpl } from '../../lib/api';
import { KnowledgeScreen } from './KnowledgeScreen';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
afterEach(() => setFetchImpl(null));

function item(id: string, name: string, reading: StudentConceptView['reading'], practice: StudentConceptView['practice']): StudentConceptView {
  return {
    concept_id: id,
    name,
    concept_status: 'suggested',
    state: 'not_started',
    state_label_ar: 'لم تبدأ بعد',
    mastery_estimate: null,
    mastery_sample: 0,
    mastery_basis_ar: 'لا يُقدَّر الإتقان قبل 3 إجابات محسوبة على أسئلته (لديك 0).',
    reasons_ar: [],
    reading,
    practice,
    weakness: null,
    prerequisites: [],
    lectures: [],
    next_step_ar: '',
  };
}

describe('Student Knowledge Map counts (Round 7 final)', () => {
  it('reading and practice counts agree with their numbers', async () => {
    const data: StudentKnowledgeResponse = {
      scope: { kind: 'all', id: null, title: null },
      items: [
        item('A', 'Alvarado score', { pages_total: 1, pages_viewed: 0 }, { questions: 1, question_attempts: 0, scored_attempts: 0, cards: 0, card_reviews: 0 }),
        item('B', 'Anorexia', { pages_total: 2, pages_viewed: 1 }, { questions: 2, question_attempts: 2, scored_attempts: 2, cards: 1, card_reviews: 3 }),
        item('C', 'McBurney', { pages_total: 12, pages_viewed: 5 }, { questions: 14, question_attempts: 11, scored_attempts: 11, cards: 2, card_reviews: 1 }),
      ],
      counts: { not_started: 3, read: 0, practicing: 0, needs_work: 0, developing: 0, strong: 0 },
      estimate_note_ar: 'الإتقان هنا تقدير.',
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
    const row = async (name: string) => (await screen.findByRole('link', { name })).closest('li')!;
    const a = await row('Alvarado score');
    expect(a.textContent).toContain('0 من صفحة واحدة يُذكر فيها');
    expect(a.textContent).toContain('0 محاولات على سؤال واحد');
    const b = await row('Anorexia');
    expect(b.textContent).toContain('1 من صفحتين يُذكر فيها');
    expect(b.textContent).toContain('محاولتان على سؤالين · 3 مراجعات لبطاقة واحدة');
    const c = await row('McBurney');
    expect(c.textContent).toContain('5 من 12 صفحة يُذكر فيها');
    expect(c.textContent).toContain('11 محاولة على 14 سؤالًا · مراجعة واحدة لبطاقتين');
    for (const r of [a, b, c]) expect(r.textContent).not.toMatch(/من 1 صفحات|على 1 سؤال|من 2 صفحات|على 2 سؤال/);
  });
});
