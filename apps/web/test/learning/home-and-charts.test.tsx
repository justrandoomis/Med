// Home order (§45: Continue Studying FIRST, then today's plan, cards, exam, weakness, important questions) and
// accessible charts (dataviz: every bar has its value + denominator as text, bars are decorative, a table twin exists;
// the Mistake Genome says it is an estimate and its types are editable).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { richTextFromPlain } from '@medlevo/shared';
import type { HomeDetail, MistakeGenomeView } from '@medlevo/shared';
import { ToastProvider } from '../../src/design';
import { setFetchImpl } from '../../src/lib/api';
import { getDb } from '../../src/lib/localdb';
import { HomeScreen, mergeContinue } from '../../src/features/home/HomeScreen';
import { BarList } from '../../src/features/review/components/BarList';
import { GenomeSection } from '../../src/features/weakness/parts';
import { clearDb, routeFetch, srsConfigFixture } from './helpers';

beforeEach(async () => {
  await clearDb();
});
afterEach(() => setFetchImpl(null));

const home: HomeDetail = {
  continue: [
    { source_id: 'S1', title: 'Acute Appendicitis', version_id: 'V1', page_label_ar: 'ص 3', mode: 'learn', updated_at: Date.now() - 3_600_000 },
    { source_id: 'S2', title: 'Shock', version_id: 'V2', page_label_ar: 'شريحة 4', mode: 'review', updated_at: Date.now() - 86_400_000 },
  ],
  today: [{ id: 'T1', plan_id: 'P1', day: '2026-10-10', kind: 'learn', title_ar: 'تعلّم «Acute Appendicitis» — ص 1–8', ref: { source_id: 'S1', page_from: 1, page_to: 8 }, minutes: 32, status: 'todo', moved_from_day: null }],
  due_cards: 3,
  new_cards_available: 2,
  exam: { title: 'Surgery final', date: '2026-11-01', days_left: 22 },
  top_weakness: {
    id: 'W1',
    label: 'Appendicitis',
    concept_id: null,
    topic_id: null,
    source_ids: ['S1'],
    signals: [],
    score: 0.6,
    reasons_ar: ['أخطأت في 2 من 3 أسئلة محسوبة.'],
    status: 'active',
    suggested_actions: [],
    updated_at: 1,
  },
  important_questions: [{ question_id: 'Q1', reason_ar: 'ظهر في ملفّين من مصادر أسئلتك (مؤشر أهمية داخل أرشيفك، وليس احتمال ظهوره).' }],
  day: '2026-10-10',
  timezone: 'Asia/Baghdad',
  due_today: 4,
  plan_id: 'P1',
  generated_at: Date.now(),
};

describe('Home', () => {
  it('starts with Continue Studying (the book left open), then the plan, cards, exam, weakness, questions', async () => {
    const question = { question: { id: 'Q1', current: { stem: richTextFromPlain('Which point is classically tender in acute appendicitis?') } } };
    setFetchImpl(routeFetch({ '/learning/home': home, '/library/tree': { nodes: [], sources: [] }, '/learning/srs-config': srsConfigFixture(), '/questions/Q1': question }).fn as never);
    render(
      <MemoryRouter>
        <ToastProvider>
          <HomeScreen />
        </ToastProvider>
      </MemoryRouter>,
    );
    await screen.findByText('Acute Appendicitis');
    await screen.findByText('خطة اليوم');
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent?.trim());
    expect(headings[0]).toBe('تابع الدراسة');
    expect(headings.slice(1)).toEqual(['خطة اليوم', 'البطاقات', 'الامتحان', 'أبرز ما يحتاج انتباهك', 'أسئلة مهمة']);
    const open = screen.getByRole('link', { name: /Acute Appendicitis.*افتح من حيث توقفت/ });
    expect(open.getAttribute('href')).toBe('/study/S1');
    // the important question keeps its reason (an indicator, not a probability)
    expect(screen.getByText(/وليس احتمال ظهوره/)).toBeTruthy();
    // …and is named by its stem (a link to the question), not by a bare «open»
    const q = await screen.findByRole('link', { name: /classically tender in acute appendicitis/ });
    expect(q.getAttribute('href')).toContain('Q1');
  });

  it('offline: Continue Studying still comes first, from this device\'s sessions', async () => {
    const db = getDb();
    await db.studySessions.put({ id: 'SS1', sourceId: 'S9', versionId: 'V9', mode: 'learn', view: 'original', location: {}, updatedAt: Date.now(), syncState: 'synced' });
    setFetchImpl((() => Promise.reject(new TypeError('Failed to fetch'))) as never);
    render(
      <MemoryRouter>
        <ToastProvider>
          <HomeScreen />
        </ToastProvider>
      </MemoryRouter>,
    );
    const link = await screen.findByRole('link', { name: /افتح من حيث توقفت/ });
    expect(link.getAttribute('href')).toBe('/study/S9');
    expect(screen.getAllByRole('heading', { level: 2 })[0]!.textContent).toBe('تابع الدراسة');
  });

  it('merges a newer local session into the server list without losing the server label', () => {
    const merged = mergeContinue(
      [{ source_id: 'A', title: 'A', version_id: null, page_label_ar: 'ص 2', mode: 'learn', updated_at: 10 }],
      [
        { source_id: 'A', title: 'A?', version_id: null, page_label_ar: null, mode: 'learn', updated_at: 50 },
        { source_id: 'B', title: 'B', version_id: null, page_label_ar: null, mode: 'learn', updated_at: 20 },
      ],
    );
    expect(merged.map((m) => [m.source_id, m.updated_at, m.page_label_ar])).toEqual([
      ['A', 50, 'ص 2'],
      ['B', 20, null],
    ]);
  });
});

describe('charts have text alternatives', () => {
  const data = [
    { key: 'a', label: 'Appendicitis', labelText: 'Appendicitis', value: 3, denominator: 9, note: 'ظهر 4 مرات' },
    { key: 'b', label: 'Shock', labelText: 'Shock', value: 0, denominator: 9 },
  ];
  it('each bar is described in text with its denominator; the bars are decorative', () => {
    render(<BarList caption="المفاهيم الأكثر تكرارًا" valueHeader="أسئلة فريدة" data={data} />);
    const fig = screen.getByRole('figure', { name: 'المفاهيم الأكثر تكرارًا' });
    const rows = within(fig).getAllByRole('listitem');
    expect(rows.map((r) => r.textContent)).toEqual(['Appendicitisظهر 4 مرات3 من 9', 'Shock0 من 9']);
    for (const bar of fig.querySelectorAll('.lw-bars__track')) expect(bar.getAttribute('aria-hidden')).toBe('true');
  });
  it('a table view holds the same numbers with headers', () => {
    render(<BarList caption="المفاهيم" valueHeader="أسئلة فريدة" data={data} />);
    fireEvent.click(screen.getByRole('button', { name: 'اعرض كجدول' }));
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['البند', 'أسئلة فريدة', 'المقام', 'ملاحظة']);
    expect(within(table).getByRole('rowheader', { name: 'Appendicitis' })).toBeTruthy();
    expect(within(table).getAllByRole('cell').map((c) => c.textContent)).toEqual(['3', '9', 'ظهر 4 مرات', '0', '9', '—']);
    expect(screen.getByRole('button', { name: 'اعرض كمخطط' }).getAttribute('aria-pressed')).toBe('true');
  });
  it('Mistake Genome: estimate note, denominator in the caption, editable types with labels', async () => {
    const genome: MistakeGenomeView = {
      estimate_note_ar: 'تصنيف تقديري قابل للتعديل، وليس تشخيصًا نفسيًا.',
      denominator: 5,
      unclassified: 1,
      distribution: [
        { type: 'knowledge_gap', label_ar: 'نقص معرفة', count: 3, by_owner: 1, by_auto: 2 },
        { type: 'misread', label_ar: 'خطأ قراءة', count: 1, by_owner: 0, by_auto: 1 },
        { type: 'time_pressure', label_ar: 'ضغط الوقت', count: 0, by_owner: 0, by_auto: 0 },
      ],
      recent: [{ attempt_id: 'A1', question_id: 'Q1', stem_preview: 'A 30-year-old man…', answered_at: Date.now(), mistake_type: 'knowledge_gap', mistake_origin: 'auto', auto_mistake_type: 'knowledge_gap', auto_reason_ar: 'لم تختر الإجابة الصحيحة بثقة.' }],
    };
    const net = routeFetch({ 'PATCH /learning/mistakes/A1': { attempt: {} } });
    setFetchImpl(net.fn as never);
    let changed = 0;
    render(
      <MemoryRouter>
        <ToastProvider>
          <GenomeSection genome={genome} onChanged={() => changed++} />
        </ToastProvider>
      </MemoryRouter>,
    );
    expect(screen.getByText(genome.estimate_note_ar)).toBeTruthy();
    const fig = screen.getByRole('figure', { name: 'أنواع الأخطاء في الإجابات الخاطئة المحسوبة (5)' });
    expect(screen.getByText('3 من 5')).toBeTruthy();
    expect(within(fig).queryByText('ضغط الوقت')).toBeNull(); // zero rows are not drawn
    expect(within(fig).getAllByRole('listitem')).toHaveLength(2);
    const select = screen.getByLabelText('نوع الخطأ') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'misread' } });
    await waitFor(() => expect(changed).toBe(1));
    expect(net.calls.find((c) => c.method === 'PATCH')?.body).toEqual({ mistake_type: 'misread' });
  });
});
