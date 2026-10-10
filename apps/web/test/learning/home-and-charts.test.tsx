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
import { HomeScreen, localSessionPageLabel, mergeContinue } from '../../src/features/home/HomeScreen';
import { apiKeyFor } from '../../src/lib/offline';
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

  it('merges a newer local session into the server list: this device\'s page wins; the server label stays only when the device has no page', () => {
    const merged = mergeContinue(
      [
        { source_id: 'A', title: 'A', version_id: null, page_label_ar: 'ص 2', mode: 'learn', updated_at: 10 },
        { source_id: 'C', title: 'C', version_id: null, page_label_ar: 'ص 5', mode: 'learn', updated_at: 10 },
        { source_id: 'D', title: 'D', version_id: null, page_label_ar: 'ص 7', mode: 'learn', updated_at: 90 },
      ],
      [
        { source_id: 'A', title: 'A?', version_id: null, page_label_ar: null, mode: 'learn', updated_at: 50 },
        { source_id: 'B', title: 'B', version_id: null, page_label_ar: null, mode: 'learn', updated_at: 20 },
        // I1 #8: this device read further in C after the server's copy → C shows this device's page and mode
        { source_id: 'C', title: 'C?', version_id: 'VC', page_label_ar: 'ص 9 (الصفحة 11 في الملف)', mode: 'review', updated_at: 60 },
        // an OLDER local session never replaces the server's newer place
        { source_id: 'D', title: 'D', version_id: null, page_label_ar: 'ص 1', mode: 'learn', updated_at: 40 },
      ],
    );
    expect(merged.map((m) => [m.source_id, m.updated_at, m.page_label_ar, m.mode])).toEqual([
      ['D', 90, 'ص 7', 'learn'],
      ['C', 60, 'ص 9 (الصفحة 11 في الملف)', 'review'],
      ['A', 50, 'ص 2', 'learn'],
      ['B', 20, null, 'learn'],
    ]);
    expect(merged.find((m) => m.source_id === 'C')!.title).toBe('C');
  });

  it('a newer session on this device is shown at THIS device\'s page — from the downloaded page list, else by file position (I1 #8)', async () => {
    // Regression: Home kept the server's (older) page label when this device's session was newer.
    const db = getDb();
    const now = Date.now();
    await db.studySessions.put({ id: 'SS-A', sourceId: 'S1', versionId: 'V1', mode: 'learn', view: 'original', location: { page_index: 13 }, updatedAt: now, syncState: 'pending_sync' });
    await db.studySessions.put({ id: 'SS-B', sourceId: 'S2', versionId: 'V2', mode: 'review', view: 'original', location: { page_index: 6, page_id: 'P2-6' }, updatedAt: now - 1000, syncState: 'pending_sync' });
    // S2 is downloaded on this device: its page list names page 6 «شريحة 7»
    await db.apiCache.put({ key: apiKeyFor('/api/sources/S2/versions/V2/pages'), value: { version: { id: 'V2' }, pages: [{ id: 'P2-6', page_index: 6, printed_label: '7', kind: 'slide' }] }, storedAt: now });
    setFetchImpl(routeFetch({ '/learning/home': home, '/library/tree': { nodes: [], sources: [] }, '/learning/srs-config': srsConfigFixture(), '/questions/Q1': { question: { id: 'Q1', current: { stem: richTextFromPlain('x') } } } }).fn as never);
    render(
      <MemoryRouter>
        <ToastProvider>
          <HomeScreen />
        </ToastProvider>
      </MemoryRouter>,
    );
    // the server said «ص 3» for S1 an hour ago; this device is at the 14th page of the file now
    const first = await screen.findByRole('link', { name: /Acute Appendicitis.*افتح من حيث توقفت/ });
    await waitFor(() => expect(first.textContent).toContain('الصفحة 14 في الملف'));
    expect(first.textContent).not.toContain('ص 3');
    const shock = screen.getByRole('link', { name: /Shock/ });
    await waitFor(() => expect(shock.textContent).toContain('شريحة 7'));
    expect(shock.textContent).not.toContain('شريحة 4');
    expect(await localSessionPageLabel({ sourceId: 'S9', versionId: 'V9', location: {} })).toBeNull();
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
