// Automatic figure descriptions in «المصادر» against a mocked server: the derived label and the unconfirmed-diagnosis
// flag, confirm / correct, «صف كل الصور» (disabled with the reason and the consent link without consent; real progress
// while running), and the image flashcard actions (one card with labels hidden; drafts for the lecture to accept).
import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { FigureDescriptionsResponse, FigureDescriptionView, FlashcardView } from '@medlevo/shared';
import { setFetchImpl } from '../../../lib/api';
import { FigureDescribeBar, FigureDescriptionCard, useFigureDescriptions } from './FigureDescriptionPanel';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const desc = (over: Partial<FigureDescriptionView> = {}): FigureDescriptionView => ({
  id: 'D1',
  version_id: 'V1',
  source_id: 'S1',
  page_id: 'P1',
  page_label_ar: 'شريحة 3',
  region_id: 'R-fig',
  image_asset_id: 'IMG1',
  target: 'figure',
  image_url: '/api/files/F1',
  status: 'described',
  status_label_ar: 'وُصفت آليًا',
  reason_ar: null,
  content: {
    image_type: 'histology',
    stain: 'H&E',
    magnification: '×40',
    findings: ['Irregular malignant glands'],
    labels: [{ text: 'Malignant glands', points_to: 'the glands' }],
    graph: null,
    diagnosis: { text: 'Colorectal adenocarcinoma', basis: 'suggestion', quote: null },
    caption_ar: 'شريحة نسيجية لسرطانة غدية',
    caption_en: 'Histology of colorectal adenocarcinoma',
  },
  machine: null,
  owner_status: null,
  label_ar: 'وصف آلي — راجعه',
  owner_reviewed: false,
  model: 'claude-haiku-5-5',
  described_at: 1,
  reviewed_at: null,
  cards: 0,
  ...over,
});

const listResponse = (over: Partial<FigureDescriptionsResponse> = {}): FigureDescriptionsResponse => ({
  version_id: 'V1',
  source_id: 'S1',
  items: [desc()],
  candidates: 3,
  run: null,
  can_describe: { available: true, reason_ar: null, consent_required: false },
  max_images: 60,
  counts: { described: 1, pending: 2, failed: 0, skipped: 0, reviewed: 0, draft_cards: 0 },
  notice_ar: 'وصف مشتق قرأه نموذج رؤية من صورة المحاضرة؛ ليس نص المصدر وقد يخطئ.',
  ...over,
});

function server(handler: (url: string, method: string, body: unknown) => Response | null) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  setFetchImpl(async (url, init) => {
    const method = (init.method ?? 'GET').toUpperCase();
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : null;
    calls.push({ url, method, body });
    return handler(url, method, body) ?? json({ error: { code: 'NOT_FOUND', message: 'غير موجود' } }, 404);
  });
  return calls;
}

function Bar() {
  const f = useFigureDescriptions('V1', true);
  return <FigureDescribeBar versionId="V1" data={f.data} error={f.error} reload={f.reload} online />;
}

afterEach(() => setFetchImpl(null));

describe('figure description card', () => {
  it('is labelled derived, flags an unconfirmed diagnosis, and confirming sends the owner’s decision', async () => {
    let current = desc();
    const calls = server((url, method) => {
      if (url === '/api/processing/figure-descriptions/D1/review' && method === 'POST') {
        current = desc({ owner_status: 'confirmed', owner_reviewed: true, label_ar: 'وصف راجعته بنفسك' });
        return json({ description: current });
      }
      return null;
    });
    const changed: FigureDescriptionView[] = [];
    const { rerender } = render(<FigureDescriptionCard description={current} sourceId="S1" canDescribe onChanged={(d) => changed.push(d)} onRedescribe={async () => undefined} />);
    expect(screen.getByText('وصف آلي — راجعه')).toBeTruthy();
    expect(screen.getByText('اقتراح — غير مؤكد')).toBeTruthy();
    expect(screen.getByText('Histology of colorectal adenocarcinoma')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'أكّد الوصف' }));
    await waitFor(() => expect(changed).toHaveLength(1));
    expect(calls.find((c) => c.url.endsWith('/review'))!.body).toEqual({ decision: 'confirm' });
    rerender(<FigureDescriptionCard description={changed[0]!} sourceId="S1" canDescribe onChanged={(d) => changed.push(d)} onRedescribe={async () => undefined} />);
    expect(screen.getByText('أكدتَ الوصف')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'أكّد الوصف' })).toBeNull();
  });

  it('the owner’s correction is sent as edited fields (findings one per line, diagnosis as the owner’s)', async () => {
    const calls = server((url) => (url.endsWith('/review') ? json({ description: desc({ owner_status: 'edited', owner_reviewed: true }) }) : null));
    render(<FigureDescriptionCard description={desc()} sourceId="S1" canDescribe onChanged={() => undefined} onRedescribe={async () => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'صحّح الوصف' }));
    fireEvent.change(screen.getByLabelText('الموجودات (سطر لكل موجودة)'), { target: { value: 'Malignant glands\n Desmoplasia \n' } });
    fireEvent.change(screen.getByLabelText('التشخيص أو الموضوع (اتركه فارغًا إن لم تكن متأكدًا)'), { target: { value: 'Adenocarcinoma' } });
    fireEvent.click(screen.getByRole('button', { name: 'احفظ تصحيحي' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/review'))).toBe(true));
    expect(calls.find((c) => c.url.endsWith('/review'))!.body).toEqual({
      decision: 'edit',
      content: { caption_ar: 'شريحة نسيجية لسرطانة غدية', caption_en: 'Histology of colorectal adenocarcinoma', findings: ['Malignant glands', 'Desmoplasia'], diagnosis: { text: 'Adenocarcinoma' } },
    });
  });

  it('«اصنع بطاقة من الصورة» with the labels hidden', async () => {
    const calls = server((url, method) => (url === '/api/learning/cards/from-figure' && method === 'POST' ? json({ cards: [{ id: 'C1' }], created: true, duplicates: [], notes_ar: [] }) : null));
    render(<FigureDescriptionCard description={desc()} sourceId="S1" canDescribe onChanged={() => undefined} onRedescribe={async () => undefined} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'أخفِ التسميات والأسهم في وجه البطاقة' }));
    fireEvent.click(screen.getByRole('button', { name: 'اصنع بطاقة من الصورة' }));
    expect(await screen.findByText(/صُنعت بطاقة من الصورة/)).toBeTruthy();
    expect(calls.find((c) => c.url === '/api/learning/cards/from-figure')!.body).toEqual({ description_id: 'D1', hide_labels: true });
  });
});

describe('«صف كل الصور»', () => {
  it('without consent: disabled, the reason and the way to enable it are shown, nothing is requested', async () => {
    const calls = server((url) =>
      url === '/api/processing/versions/V1/figure-descriptions'
        ? json(listResponse({ items: [], counts: { described: 0, pending: 0, failed: 0, skipped: 0, reviewed: 0, draft_cards: 0 }, can_describe: { available: false, reason_ar: 'تحتاج موافقتك على معالجة الذكاء الاصطناعي.', consent_required: true } }))
        : null,
    );
    render(
      <MemoryRouter>
        <Bar />
      </MemoryRouter>,
    );
    const btn = await screen.findByRole('button', { name: 'صف كل الصور' });
    expect(btn).toHaveProperty('disabled', true);
    expect(screen.getByText(/تحتاج موافقتك على معالجة الذكاء الاصطناعي/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'فعّل الموافقة من صفحة الخصوصية' }).getAttribute('href')).toBe('/me/privacy');
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('starts a run and shows real progress; «بطاقات من كل صور المحاضرة» makes drafts to accept', async () => {
    let state = listResponse();
    let drafts: FlashcardView[] = [];
    const draft = { id: 'C9', back: { v: 1, paragraphs: [{ dir: 'rtl', runs: [{ t: '(وصف آلي — راجعه)' }] }, { dir: 'rtl', runs: [{ t: 'شريحة نسيجية' }] }] } } as unknown as FlashcardView;
    const calls = server((url, method) => {
      if (url === '/api/processing/versions/V1/figure-descriptions') return json(state);
      if (url === '/api/processing/versions/V1/figure-descriptions/describe' && method === 'POST') {
        state = listResponse({ run: { id: 'RUN1', status: 'running', status_label_ar: 'تُوصف الصور', trigger: 'owner', reason_ar: null, done: 1, total: 3, job: null, created_at: 1 } });
        return json({ run: state.run });
      }
      if (url === '/api/learning/cards/from-figures' && method === 'POST') {
        drafts = [draft];
        return json({ cards: drafts, created: true, duplicates: [], notes_ar: ['أُنشئت بطاقة واحدة كمسودة موقوفة؛ راجعها.'] });
      }
      if (url === '/api/learning/cards/figure-drafts?version_id=V1') return json({ items: drafts });
      if (url === '/api/learning/cards/C9/draft' && method === 'POST') {
        drafts = [];
        return json({ card: { ...draft, suspended: false } });
      }
      return null;
    });
    render(
      <MemoryRouter>
        <Bar />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'صف كل الصور' }));
    const bar = await screen.findByRole('progressbar', { name: 'تقدّم وصف الصور' });
    expect(bar.getAttribute('aria-valuetext')).toBe('وُصفت 1 من 3');
    expect(calls.find((c) => c.url.endsWith('/describe'))!.body).toEqual({ force: true });
    fireEvent.click(screen.getByRole('button', { name: 'بطاقات من كل صور المحاضرة' }));
    expect(await screen.findByText(/كمسودة موقوفة/)).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'اقبلها' }));
    expect(await screen.findByText('لا توجد مسودات تنتظر مراجعتك.')).toBeTruthy();
    expect(calls.find((c) => c.url === '/api/learning/cards/C9/draft')!.body).toEqual({ decision: 'accept' });
  });
});
