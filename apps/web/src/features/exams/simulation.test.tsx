// «محاكاة مولدة» screen (§37, §40, track F3): the plan from the owner's Exam DNA is shown without AI — every share with
// its denominator, the sample's limits and the label «ليست نسخة متوقعة من الامتحان القادم»; generation is disabled with
// the server's reason when no provider exists; a finished simulation links to its exam (every item generated).
import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SIMULATION_LABEL_AR, SIMULATION_NOTICE_AR, type SimulationPlanView, type SimulationRunView } from '@medlevo/shared';
import { setFetchImpl } from '../../lib/api';
import { SimulationScreen } from './SimulationScreen';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const plan = (over: Partial<SimulationPlanView> = {}): SimulationPlanView => ({
  request: { count: 6, difficulty: 'hard', course_node_id: null, minutes: null },
  buckets: [
    { lecture_source_id: 'L1', lecture_title: 'Acute Appendicitis', count: 4, share: { unique: 6, denominator: 9 }, item_types: ['diagnosis', 'management'], topic: 'Alvarado score', reason_ar: '' },
    { lecture_source_id: 'L2', lecture_title: 'Gallstones', count: 1, share: { unique: 3, denominator: 9 }, item_types: ['diagnosis'], topic: 'Gallstones', reason_ar: '' },
    { lecture_source_id: 'L2', lecture_title: 'Gallstones', count: 1, share: { unique: 3, denominator: 9 }, item_types: ['investigation'], topic: 'Gallstones', reason_ar: '' },
  ],
  sample: { files: 2, unique_questions: 9, occurrences: 11, date_range: '2022–2024' },
  item_types: [{ item_type: 'diagnosis', count: 5, denominator: 9 }],
  warnings_ar: ['العينة صغيرة (أقل من 30 سؤالًا فريدًا).'],
  excluded: [{ lecture_source_id: 'L3', title: 'Hernia', reason_ar: 'لا توجد نسخة معالجة لهذه المحاضرة.' }],
  counting_note_ar: 'يُعد السؤال المكرر مرة واحدة.',
  notice_ar: SIMULATION_NOTICE_AR,
  can_generate: { available: false, reason_ar: 'المحاكاة المولدة تتطلب مزود ذكاء اصطناعي (ANTHROPIC_API_KEY).' },
  ...over,
});

const sim = (over: Partial<SimulationRunView> = {}): SimulationRunView => ({
  id: 'S1',
  status: 'completed',
  status_label_ar: 'اكتملت المحاكاة',
  label_ar: SIMULATION_LABEL_AR,
  notice_ar: SIMULATION_NOTICE_AR,
  plan: plan(),
  parts: [{ bucket_index: 0, lecture_source_id: 'L1', lecture_title: 'Acute Appendicitis', requested: 4, run_id: 'G1', status: 'completed', status_label_ar: 'اكتمل', published: 4 }],
  exam: { exam_id: 'E1', attempt_id: 'A1', items: 4, generated_items: 4 },
  summary_ar: 'نُشر 4 أسئلة من 6.',
  job: null,
  created_at: 1,
  updated_at: 1,
  ...over,
});

function serve(p: SimulationPlanView, list: SimulationRunView[] = []) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  setFetchImpl(async (url, init) => {
    const method = (init.method ?? 'GET').toUpperCase();
    calls.push({ method, url, body: typeof init.body === 'string' ? JSON.parse(init.body) : null });
    if (url === '/api/exams/simulations/preview') return json({ plan: p });
    if (url === '/api/exams/simulations' && method === 'POST') return json({ simulation: sim({ status: 'queued', status_label_ar: 'في الانتظار', exam: null, parts: [] }) });
    if (url === '/api/exams/simulations') return json({ simulations: list });
    if (url.startsWith('/api/library')) return json({ nodes: [], sources: [] });
    return json({ error: { code: 'NOT_FOUND', message: 'غير موجود' } }, 404);
  });
  return calls;
}

afterEach(() => setFetchImpl(null));

function renderScreen() {
  return render(
    <MemoryRouter initialEntries={['/exams/simulate']}>
      <SimulationScreen />
    </MemoryRouter>,
  );
}

describe('SimulationScreen', () => {
  it('shows the DNA plan with denominators and limits, labelled «not the expected exam»; generation disabled with the reason', async () => {
    const calls = serve(plan());
    renderScreen();
    expect(screen.getByRole('heading', { level: 1, name: SIMULATION_LABEL_AR })).toBeTruthy();
    expect(screen.getAllByText(new RegExp('ليست نسخة متوقعة من الامتحان القادم')).length).toBeGreaterThan(0);
    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row');
    expect(rows[1]!.textContent).toContain('6 من 9');
    expect(rows[1]!.textContent).toContain('4');
    // a lecture split into parts by item type is still ONE row (its parts summed)
    expect(rows).toHaveLength(3);
    expect(rows[2]!.textContent).toContain('3 من 9');
    expect(rows[2]!.textContent).toContain('2');
    expect(rows[2]!.textContent).toContain('التشخيص، الفحوصات');
    expect(screen.getByText('العينة صغيرة (أقل من 30 سؤالًا فريدًا).')).toBeTruthy();
    expect(screen.getByText(/محاضرات من العينة لم تدخل الخطة \(1\)/)).toBeTruthy();
    const go = screen.getByRole('button', { name: 'ولّد المحاكاة وتحقق منها' });
    expect(go).toHaveProperty('disabled', true);
    const why = screen.getByText(/المحاكاة المولدة تتطلب مزود ذكاء اصطناعي/);
    expect(go.getAttribute('aria-describedby')).toBe(why.id);
    expect(calls.find((c) => c.url === '/api/exams/simulations/preview')!.body).toMatchObject({ count: 6, difficulty: 'hard' });
    expect(calls.some((c) => c.url === '/api/exams/simulations' && c.method === 'POST')).toBe(false);
  });

  it('with a provider: starts the simulation; a finished one links to its exam where every item is generated', async () => {
    const calls = serve(plan({ can_generate: { available: true, reason_ar: null } }), [sim()]);
    renderScreen();
    const go = await screen.findByRole('button', { name: 'ولّد المحاكاة وتحقق منها' });
    await waitFor(() => expect(go).toHaveProperty('disabled', false));
    // an earlier simulation is listed and can be opened
    fireEvent.click(await screen.findByRole('button', { name: `${SIMULATION_LABEL_AR} — اكتملت المحاكاة` }));
    expect(screen.getByRole('link', { name: 'ابدأ المحاكاة' }).getAttribute('href')).toBe('/exams/A1');
    expect(screen.getByText('4 أسئلة، المولد منها 4 — كلها مولدة ومتحقق منها.')).toBeTruthy();
    fireEvent.click(go);
    await waitFor(() => expect(calls.some((c) => c.url === '/api/exams/simulations' && c.method === 'POST')).toBe(true));
    expect(await screen.findByText('في الانتظار')).toBeTruthy();
  });
});
