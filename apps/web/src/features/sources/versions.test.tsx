// P1-T3 web: lecture identity suggestions and the version compare screen (labelled TEST FIXTURE data only).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { emptyChangeCounts, type CompareRow, type ImportSuggestionView, type VersionCompareResponse } from '@medlevo/shared';
import { ToastProvider } from '../../design';
import { setFetchImpl } from '../../lib/api';
import { CompareScreen } from './CompareScreen';
import { SuggestionCard } from './SuggestionCard';
import { compareHref, countsSummary, needsReview, suggestionStatusAr, suggestionValueAr } from './versionsModel';

afterEach(() => setFetchImpl(null));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const proposal: ImportSuggestionView = {
  id: 'sg1',
  source_id: 'up',
  source_title: 'Abdomen lec5 final (1)',
  version_id: 'v2',
  field: 'new_version_of',
  value: { field: 'new_version_of', source_id: 'lec5', version_id: 'v1', title: 'TEST FIXTURE Lecture 5', matched_pages: 39, total_pages: 40, ratio: 0.975, inserted: 2, removed: 0, changed: 1 },
  certainty: 'uncertain',
  status: 'open',
  reasons_ar: ['تتطابق 39 من 40 صفحة (98%) بالنص أو بصورة الصفحة.'],
  effect_ar: 'يُضاف هذا الملف كإصدار جديد من «TEST FIXTURE Lecture 5».',
  created_at: 1,
  decided_at: null,
};

const page = (id: string, i: number) => ({ page_id: id, page_index: i, label_ar: `ص ${i + 1}`, excerpt: `TEST FIXTURE text ${i + 1}`, thumbnail: true });
const row = (over: Partial<CompareRow>): CompareRow => ({
  key: Math.random().toString(36),
  change: 'unchanged',
  from: null,
  to: null,
  status: 'safe',
  method: 'identical',
  layout_safe: true,
  text_score: 1,
  image_distance: null,
  decided_by: 'auto',
  diff: null,
  ...over,
});

const compare: VersionCompareResponse = {
  state: 'ready',
  reason_ar: null,
  from: { source_id: 'lec5', source_title: 'TEST FIXTURE Lecture 5', version_id: 'v1', version_no: 1, file_name: 'Abdomen Lecture 5.pdf', page_count: 3 },
  to: { source_id: 'up', source_title: 'Abdomen lec5 final (1)', version_id: 'v2', version_no: 1, file_name: 'Abdomen lec5 final (1).pdf', page_count: 4 },
  algo: 'pm1:j0.85:d6:low0.3|fp1',
  rows: [
    row({ from: page('o1', 0), to: page('n1', 0) }),
    row({ change: 'inserted', status: null, method: null, to: page('n2', 1), layout_safe: false }),
    row({ change: 'changed', status: 'uncertain', method: 'text_similarity', text_score: 0.1, layout_safe: false, from: page('o2', 1), to: page('n3', 2), diff: { removed: ['fascia'], added: ['ultrasound'] } }),
    row({ from: page('o3', 2), to: page('n4', 3) }),
  ],
  counts: { ...emptyChangeCounts(), unchanged: 2, inserted: 1, changed: 1 },
  job_id: null,
  proposal,
};

describe('versions model', () => {
  it('summaries and labels carry words, not colours alone', () => {
    expect(countsSummary(compare.counts)).toBe('لم تتغير: 2 · تغيّرت: 1 · صفحة جديدة: 1');
    expect(suggestionValueAr(proposal)).toBe('39 من 40 صفحة متطابقة · جديدة: 2 · تغيّرت: 1');
    expect(compareHref('lec5', 'v1', 'v2')).toBe('/sources/lec5/compare?from=v1&to=v2');
    expect(needsReview(compare.rows[2]!)).toBe(true);
    expect(needsReview(compare.rows[0]!)).toBe(false);
    expect(suggestionStatusAr({ ...proposal, field: 'lecture_no', value: { field: 'lecture_no', lecture_no: 5 } })).toBe('غير مؤكد — بانتظار تأكيدك');
  });
});

describe('SuggestionCard', () => {
  it('shows reasons and the effect before deciding; accept posts the decision', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    setFetchImpl(async (url, init) => {
      calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
      return json({ suggestion: { ...proposal, status: 'accepted' }, result_ar: 'أُضيف الملف كإصدار 2.', new_version: { source_id: 'lec5', version_id: 'v9', version_no: 2, upload_trashed: true } });
    });
    const onDecided = vi.fn();
    render(
      <MemoryRouter>
        <ToastProvider>
          <ul>
            <SuggestionCard suggestion={proposal} onDecided={onDecided} />
          </ul>
        </ToastProvider>
      </MemoryRouter>,
    );
    expect(screen.getByText('إصدار جديد من «TEST FIXTURE Lecture 5»؟')).toBeTruthy();
    expect(screen.getByText(/تتطابق 39 من 40 صفحة \(98%\)/)).toBeTruthy();
    expect(screen.getByText(/إن أكّدت: يُضاف هذا الملف كإصدار جديد/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /قارن الصفحات قبل التأكيد/ }).getAttribute('href')).toBe('/sources/lec5/compare?from=v1&to=v2');
    fireEvent.click(screen.getByRole('button', { name: 'نعم، أضفه كإصدار جديد' }));
    await waitFor(() => expect(onDecided).toHaveBeenCalled());
    expect(calls[0]).toEqual({ url: '/api/versions/suggestions/sg1/decide', body: { action: 'accept' } });
  });

  it('a decided suggestion has no actions', () => {
    render(
      <MemoryRouter>
        <ToastProvider>
          <ul>
            <SuggestionCard suggestion={{ ...proposal, status: 'rejected' }} />
          </ul>
        </ToastProvider>
      </MemoryRouter>,
    );
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('رفضته')).toBeTruthy();
  });
});

describe('CompareScreen', () => {
  const mount = () =>
    render(
      <MemoryRouter initialEntries={['/sources/up/compare?from=v1&to=v2']}>
        <ToastProvider>
          <Routes>
            <Route path="/sources/:sourceId/compare" element={<CompareScreen />} />
          </Routes>
        </ToastProvider>
      </MemoryRouter>,
    );

  it('rows in the new order with inserted pages marked; an uncertain page asks the owner', async () => {
    const posts: Array<{ url: string; body: unknown }> = [];
    setFetchImpl(async (url, init) => {
      if (init.method === 'POST') {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        return json(compare);
      }
      return json(compare);
    });
    mount();
    await screen.findByRole('heading', { level: 1, name: 'مقارنة نسختين' });
    const list = screen.getByRole('list', { name: 'الصفحات' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(4);
    expect(within(items[1]!).getByText('صفحة جديدة')).toBeTruthy();
    expect(within(items[1]!).getByText('لا مقابل في النسخة السابقة')).toBeTruthy();
    expect(within(items[2]!).getByText('تغيّرت')).toBeTruthy();
    expect(within(items[2]!).getByText('تحتاج تأكيدك')).toBeTruthy();
    expect(within(items[2]!).getByText('ultrasound')).toBeTruthy();
    expect(screen.getAllByRole('status').some((el) => (el.textContent ?? '').includes('تحتاج تأكيدك: 1'))).toBe(true);
    // page images have Arabic alternative text
    expect(within(items[0]!).getByAltText('صورة ص 1 من النسخة السابقة').getAttribute('src')).toBe('/api/versions/pages/o1/thumbnail');
    fireEvent.click(within(items[2]!).getByRole('button', { name: 'نفس الصفحة' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ url: '/api/versions/maps/decide', body: { from_version_id: 'v1', to_version_id: 'v2', from_page_id: 'o2', action: 'confirm' } });
    // the open proposal is on the screen with its confirm action
    expect(screen.getByRole('button', { name: 'نعم، أضفه كإصدار جديد' })).toBeTruthy();
  });

  it('pending analysis is said, not faked', async () => {
    setFetchImpl(async () => json({ ...compare, state: 'pending', rows: [], reason_ar: 'يجري تحليل صفحات النسختين.', proposal: null }));
    mount();
    expect(await screen.findByText('يجري تحليل صفحات النسختين.')).toBeTruthy();
    expect(screen.getByText('يجري التحليل')).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'الصفحات' })).toBeNull();
  });
});

describe('ImportSuggestions (upload screen)', () => {
  it('an answer without suggestions (an older server, or no identity yet) shows nothing and never throws', async () => {
    const { ImportSuggestions } = await import('../upload/ImportSuggestions');
    let calls = 0;
    setFetchImpl(async () => {
      calls++;
      return json({ summary: { stage: 'done' }, job: null });
    });
    const { container, unmount } = render(
      <MemoryRouter>
        <ToastProvider>
          <ImportSuggestions sourceId="S1" processed />
        </ToastProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(calls).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 20));
    expect(container.querySelector('.ml-upload__suggestions')).toBeNull();
    unmount();
  });
});

// ── reviewer regressions (P1-T3 review) ──
import type { SourceDetail, SourceIdentityResponse } from '@medlevo/shared';
import { IdentityPanel } from './IdentityPanel';

describe('IdentityPanel (review)', () => {
  const identity: SourceIdentityResponse = {
    identity: { source_id: 's1', title: 'TEST FIXTURE Lecture', original_file_name: 'lecture.pdf', lecture_no: null, lecture_no_origin: null, held_on: null, held_on_origin: null, is_stub: false },
    suggestions: [
      {
        id: 'sd',
        source_id: 's1',
        source_title: 'TEST FIXTURE Lecture',
        version_id: 'v1',
        field: 'held_on',
        value: { field: 'held_on', held_on: '2026-04-03' },
        certainty: 'uncertain',
        status: 'open',
        reasons_ar: ['«03/04/2026» في الصفحات الأولى', 'قد يكون اليوم والشهر متبادلين.'],
        effect_ar: 'يُحفظ تاريخ المحاضرة 2026-04-03 كقرار منك.',
        created_at: 1,
        decided_at: null,
      },
    ],
    analysis: { version_id: 'v1', state: 'ready', job_id: null, reason_ar: null },
  };
  const detail = { id: 's1', title: 'TEST FIXTURE Lecture', format: 'pdf', current_version_id: 'v1', frozen_version_id: null, node_id: null } as unknown as SourceDetail;

  it('saving only the number sends only the number (an open date suggestion is not silently answered); Arabic-Indic digits are accepted', async () => {
    const patches: unknown[] = [];
    setFetchImpl(async (url, init) => {
      if (init.method === 'PATCH') {
        patches.push(JSON.parse(String(init.body)));
        return json(identity.identity);
      }
      if (url.includes('/toc')) return json({ version_id: 'v1', toc_page_indexes: [], entries: [] });
      return json(identity);
    });
    render(
      <MemoryRouter>
        <ToastProvider>
          <IdentityPanel detail={detail} readOnly={false} />
        </ToastProvider>
      </MemoryRouter>,
    );
    const input = await screen.findByLabelText('رقم المحاضرة');
    fireEvent.change(input, { target: { value: '٥' } });
    fireEvent.click(screen.getByRole('button', { name: 'احفظ' }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({ lecture_no: 5 });
  });
});

describe('SuggestionCard (review)', () => {
  it('a stored value the latest analysis is unsure of says so, and can be removed', () => {
    render(
      <MemoryRouter>
        <ToastProvider>
          <ul>
            <SuggestionCard suggestion={{ ...proposal, field: 'lecture_no', value: { field: 'lecture_no', lecture_no: 5 }, status: 'applied', certainty: 'uncertain', reasons_ar: ['«l 5» في اسم الملف'] }} />
          </ul>
        </ToastProvider>
      </MemoryRouter>,
    );
    expect(screen.getByText(/التحليل الأخير غير متأكد منه/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'ليس صحيحًا' })).toBeTruthy();
  });
});

describe('CompareScreen (review)', () => {
  it('the breadcrumb names the source it links to (a proposal compares two sources)', async () => {
    setFetchImpl(async () => json(compare));
    render(
      <MemoryRouter initialEntries={['/sources/lec5/compare?from=v1&to=v2']}>
        <ToastProvider>
          <Routes>
            <Route path="/sources/:sourceId/compare" element={<CompareScreen />} />
          </Routes>
        </ToastProvider>
      </MemoryRouter>,
    );
    await screen.findByRole('heading', { level: 1, name: 'مقارنة نسختين' });
    const crumb = screen.getAllByRole('link').find((a) => a.getAttribute('href') === '/sources/lec5')!;
    expect(crumb.textContent).toContain('TEST FIXTURE Lecture 5'); // was the upload's title «Abdomen lec5 final (1)»
  });
});

// ── LectureOrderScreen (AOS-3.5 web part; added by the reviewer — the screen had no test) ──
import { LectureOrderScreen } from './LectureOrderScreen';

describe('LectureOrderScreen (review)', () => {
  it('shows the computed order without changing anything; switching to «حسب التاريخ» asks again; applying is explicit', async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const view = (mode: 'number' | 'date') => ({
      node_id: 'n1',
      mode,
      node_sort_mode: 'manual',
      missing_key: 1,
      items: [
        { source_id: 's1', title: 'TEST FIXTURE Lecture 1', lecture_no: 1, held_on: '2026-10-01', sort_order: 2, created_at: 1, position: 1 },
        { source_id: 's2', title: 'TEST FIXTURE Lecture 2', lecture_no: 2, held_on: null, sort_order: 1, created_at: 1, position: 2 },
      ],
    });
    setFetchImpl(async (url, init) => {
      calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : null });
      return json(view(url.includes('mode=date') ? 'date' : 'number'));
    });
    render(
      <MemoryRouter initialEntries={['/lectures/order/n1']}>
        <ToastProvider>
          <Routes>
            <Route path="/lectures/order/:nodeId" element={<LectureOrderScreen />} />
          </Routes>
        </ToastProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByText('TEST FIXTURE Lecture 1')).toBeTruthy();
    expect(screen.getByText(/1 بلا رقم محاضرة/)).toBeTruthy();
    expect(calls.every((c) => c.method === 'GET')).toBe(true); // looking changes nothing
    fireEvent.click(screen.getByRole('radio', { name: 'حسب التاريخ' }));
    await waitFor(() => expect(calls.some((c) => c.url.includes('mode=date'))).toBe(true));
    fireEvent.click(await screen.findByRole('button', { name: 'اعتمد هذا الترتيب للمجلد' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({ url: '/api/versions/order/apply', body: { node_id: 'n1', mode: 'date' } });
  });
});

describe('CompareScreen (review): a decision whose page is gone', () => {
  it('says so instead of «أكّدت أنها ليست نفسها», and offers to undo it', async () => {
    const stale = { ...compare, proposal: null, rows: [row({ change: 'removed', status: 'none', method: 'owner', decided_by: 'owner', layout_safe: false, from: page('o9', 0), to: null })] };
    setFetchImpl(async () => json(stale));
    render(
      <MemoryRouter initialEntries={['/sources/up/compare?from=v1&to=v2']}>
        <ToastProvider>
          <Routes>
            <Route path="/sources/:sourceId/compare" element={<CompareScreen />} />
          </Routes>
        </ToastProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByText('قرارك يشير إلى صفحة لم تعد موجودة')).toBeTruthy();
    expect(screen.queryByText('أكّدت أنها ليست نفسها')).toBeNull();
    expect(screen.getByRole('button', { name: 'تراجع عن قراري' })).toBeTruthy();
  });
});
