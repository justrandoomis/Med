// Round 7 H4 item 1 (§05): cases, explanations and past attempts on the topic page («محاولاتي السابقة» with how each
// belongs to the topic; link a case by hand) and the «الموضوعات» control on those items (link, accept a suggestion,
// remove — the item itself is never changed).
import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { TopicDetailResponse, TopicLinkView } from '@medlevo/shared';
import { ToastProvider } from '../../design';
import { setFetchImpl } from '../../lib/api';
import { TopicLinksControl } from './TopicLinksControl';
import { TopicScreen } from './TopicsScreen';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
afterEach(() => setFetchImpl(null));

const DETAIL: TopicDetailResponse = {
  topic: { id: 'T', title: 'Appendicitis', title_ar: 'التهاب الزائدة', parent_topic_id: null, created_at: 1, updated_at: 1 },
  links: [
    { id: 'K1', topic_id: 'T', entity_type: 'clinical_case', entity_id: 'C1', origin: 'auto', status: 'suggested', created_at: 1, label: 'RIF pain (TEST)', sublabel: 'حالة سريرية تدريجية · كتبتها بنفسك', href: '/cases/C1', reason_ar: 'اسم الموضوع في عنوان الحالة.' },
    { id: 'K2', topic_id: 'T', entity_type: 'artifact', entity_id: 'A1', origin: 'owner', status: 'accepted', created_at: 1, label: 'شرح: الألم المهاجر', sublabel: 'شرح مولّد · 2026-10-20', href: '/explanations/A1', reason_ar: null },
  ],
  children: [],
  counts: { accepted: 1, suggested: 1, rejected: 0 },
  attempts: {
    total: 2,
    items: [
      { kind: 'exam_attempt', id: 'X1', label: 'تدريب الحفرة الحرقفية', sublabel: '2026-10-20 · مكتملة · صحيحة 1 من 2 مُقيَّمة', href: '/exams/X1/results', at: 2, via: 'linked', via_ar: 'ربطتها بالموضوع' },
      { kind: 'question_attempt', id: 'QA1', label: 'Which sign…', sublabel: '2026-10-19 · غير مُقيَّمة (لا مفتاح مؤكد)', href: '/questions/Q1', at: 1, via: 'question', via_ar: 'محاولة على سؤال مرتبط بالموضوع' },
    ],
  },
};

describe('topic page — cases, explanations, past attempts (H4)', () => {
  it('groups the generated explanation under its own label, lists past attempts with how they belong, and links a case by hand', async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    setFetchImpl(async (url, init) => {
      const method = String(init.method ?? 'GET');
      calls.push({ url, method, body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (url === '/api/brain/topics/T') return json(DETAIL);
      if (url === '/api/brain/topics') return json({ topics: [] });
      if (url === '/api/cases') return json({ cases: [{ id: 'C2', title: 'OSCE station (TEST)', kind: 'osce' }], capabilities: {} });
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
    expect(await screen.findByText('لماذا: اسم الموضوع في عنوان الحالة.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'شرح أو ملخص مولّد' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'شرح: الألم المهاجر' }).getAttribute('href')).toBe('/explanations/A1');
    const attempts = screen.getByRole('heading', { name: 'محاولاتي السابقة (2)' }).closest('section')!;
    expect(within(attempts).getByRole('link', { name: 'تدريب الحفرة الحرقفية' }).getAttribute('href')).toBe('/exams/X1/results');
    expect(within(attempts).getByText('ربطتها بالموضوع')).toBeTruthy();
    expect(within(attempts).getByText('محاولة على سؤال مرتبط بالموضوع')).toBeTruthy();
    expect(within(attempts).getByText(/غير مُقيَّمة/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'اربط حالة' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'اربط الحالة: OSCE station (TEST)' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === '/api/library/topics/T/links' && c.method === 'POST' && JSON.stringify(c.body) === JSON.stringify({ entity_type: 'clinical_case', entity_id: 'C2' }))).toBe(true),
    );
  });

  it('an empty attempts history says so in words', async () => {
    setFetchImpl(async (url) => {
      if (url === '/api/brain/topics/T') return json({ ...DETAIL, links: [], attempts: { items: [], total: 0 } });
      if (url === '/api/brain/topics') return json({ topics: [] });
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
    expect(await screen.findByText(/لا محاولات بعد على أسئلة هذا الموضوع/)).toBeTruthy();
  });
});

describe('«الموضوعات» on an item (TopicLinksControl)', () => {
  const link = (over: Partial<TopicLinkView>): TopicLinkView => ({ id: 'L1', topic_id: 'T1', topic_title: 'Appendicitis', topic_title_ar: null, entity_type: 'clinical_case', entity_id: 'C1', origin: 'owner', status: 'accepted', created_at: 1, ...over });

  it('shows linked topics and suggestions (marked), links to another topic, accepts, and removes', async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    setFetchImpl(async (url, init) => {
      const method = String(init.method ?? 'GET');
      calls.push({ url, method, body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (url === '/api/library/topic-links?entity_type=clinical_case&entity_id=C1') {
        return json({ links: [link({}), link({ id: 'L2', topic_id: 'T2', topic_title: 'Acute abdomen', origin: 'auto', status: 'suggested' }), link({ id: 'L3', topic_id: 'T3', topic_title: 'Rejected one', status: 'rejected' })] });
      }
      if (url === '/api/library/topics') return json({ topics: [{ id: 'T1', title: 'Appendicitis', title_ar: null }, { id: 'T2', title: 'Acute abdomen', title_ar: null }, { id: 'T4', title: 'Surgery', title_ar: 'الجراحة' }] });
      return json({ link: {}, ok: true });
    });
    render(
      <ToastProvider>
        <MemoryRouter>
          <TopicLinksControl entityType="clinical_case" entityId="C1" itemLabel="الحالة «RIF»" />
        </MemoryRouter>
      </ToastProvider>,
    );
    const list = await screen.findByRole('list', { name: 'موضوعات الحالة «RIF»' });
    expect(within(list).getByRole('link', { name: 'Appendicitis' }).getAttribute('href')).toBe('/library/topics/T1');
    expect(within(list).getByText('اقتراح — لم تقرره بعد')).toBeTruthy();
    expect(within(list).queryByText('Rejected one')).toBeNull();
    // accept the suggestion
    fireEvent.click(within(list).getByRole('button', { name: 'اقبل ربط الحالة «RIF» بموضوع Acute abdomen' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/library/topic-links/L2' && c.method === 'PATCH' && (c.body as { status: string }).status === 'accepted')).toBe(true));
    // remove an accepted owner link
    fireEvent.click(within(list).getByRole('button', { name: 'أزل ربط الحالة «RIF» بموضوع Appendicitis' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/library/topic-links/L1' && c.method === 'DELETE')).toBe(true));
    // link to a new topic: only topics not yet accepted are offered
    fireEvent.click(screen.getByRole('button', { name: 'اربط بموضوع' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).queryByRole('menuitem', { name: 'Appendicitis' })).toBeNull();
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'الجراحة' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === '/api/library/topics/T4/links' && c.method === 'POST' && JSON.stringify(c.body) === JSON.stringify({ entity_type: 'clinical_case', entity_id: 'C1' }))).toBe(true),
    );
  });

  it('no topics yet → a link to create one; no links → says so', async () => {
    setFetchImpl(async (url) => {
      if (url.startsWith('/api/library/topic-links')) return json({ links: [] });
      if (url === '/api/library/topics') return json({ topics: [] });
      return json({}, 404);
    });
    render(
      <ToastProvider>
        <MemoryRouter>
          <TopicLinksControl entityType="exam_attempt" entityId="X1" itemLabel="المحاولة" />
        </MemoryRouter>
      </ToastProvider>,
    );
    expect(await screen.findByText('غير مرتبط بموضوع بعد.')).toBeTruthy();
    expect((await screen.findByRole('link', { name: 'أنشئ موضوعًا أولًا' })).getAttribute('href')).toBe('/library/topics');
  });
});
