// «صور من الويب» against a mocked server: the honest disabled state (reason + how to enable, no search box), results
// with their attribution and the web label, the lightbox, «أضف إلى ملاحظاتي» (a reference card that keeps the credit),
// suggestions from the figure descriptions, and the embeddable <WebImageStrip>.
import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { FigureDescriptionContent, WebImageRefView, WebImageResult, WebImageSearchResponse, WebImageStatusResponse } from '@medlevo/shared';
import { setFetchImpl } from '../../../lib/api';
import { queryFromFigure } from './api';
import { WebImagesPanel } from './WebImagesPanel';
import { WebImageStrip } from './WebImages';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const LABEL = 'صورة من الويب — ليست من محاضرتك';
const result = (over: Partial<WebImageResult> = {}): WebImageResult => ({
  id: 'W1',
  provider: 'wikimedia',
  provider_label_ar: 'ويكيميديا كومنز',
  title: 'Colon adenocarcinoma H&E',
  caption: 'Micrograph of colorectal adenocarcinoma.',
  author: 'Nephron',
  license: 'CC BY-SA 4.0',
  license_url: 'https://creativecommons.org/licenses/by-sa/4.0',
  usage: 'free_licence',
  page_url: 'https://commons.wikimedia.org/wiki/File:Colon.jpg',
  image_url: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Colon.jpg',
  thumb: '/api/media/web-images/thumb?u=t1&s=sig1',
  large: '/api/media/web-images/thumb?u=l1&s=sig2',
  width: 800,
  height: 600,
  score: 0.9,
  token: 'signed-token-1234567890',
  ...over,
});
const available: WebImageStatusResponse = {
  state: 'available',
  reason_ar: 'صور من الويب تعمل.',
  providers: [
    { provider: 'openi', label_ar: 'Open-i', state: 'available' },
    { provider: 'wikimedia', label_ar: 'ويكيميديا كومنز', state: 'available' },
    { provider: 'google', label_ar: 'بحث Google', state: 'requires_configuration', reason_ar: 'يحتاج مفتاح Google: اضبط GOOGLE_CSE_KEY و GOOGLE_CSE_ID.' },
  ],
  label_ar: LABEL,
  how_to_enable_ar: [],
};
const searchResponse = (items: WebImageResult[]): WebImageSearchResponse => ({
  query: 'ورم حبيبي',
  query_en: 'granuloma',
  translated: [{ ar: 'ورم حبيبي', en: 'granuloma' }],
  untranslated: [],
  items,
  providers: [],
  label_ar: LABEL,
  notes_ar: ['صور للمقارنة فقط.'],
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

afterEach(() => setFetchImpl(null));

describe('WebImagesPanel', () => {
  it('disabled on the server: the reason and how to enable it, no search box, nothing searched', async () => {
    const calls = server((url) =>
      url === '/api/media/web-images/status'
        ? json({ ...available, state: 'requires_configuration', reason_ar: 'الجلب من الإنترنت معطّل على الخادم (MEDLEVO_ALLOW_EXTERNAL_FETCH).', how_to_enable_ar: ['MEDLEVO_ALLOW_EXTERNAL_FETCH=true ثم أعد التشغيل.'] })
        : url.startsWith('/api/media/web-images/refs')
          ? json({ items: [] })
          : null,
    );
    render(<WebImagesPanel online suggestions={['granuloma histology']} sourceId="S1" />);
    expect(await screen.findByText(/معطّل على الخادم/)).toBeTruthy();
    expect(screen.getByText(/ثم أعد التشغيل/)).toBeTruthy();
    expect(screen.queryByRole('search')).toBeNull();
    expect(screen.queryByRole('button', { name: /ابحث/ })).toBeNull();
    expect(calls.some((c) => c.url.endsWith('/search'))).toBe(false);
  });

  it('results carry their attribution and the web label; the lightbox enlarges; «أضف إلى ملاحظاتي» keeps a reference card', async () => {
    const item = result();
    let pinned: WebImageRefView[] = [];
    const calls = server((url, method, body) => {
      if (url === '/api/media/web-images/status') return json(available);
      if (url.startsWith('/api/media/web-images/refs') && method === 'GET') return json({ items: pinned });
      if (url === '/api/media/web-images/search') return json(searchResponse([item, result({ id: 'W2', provider: 'openi', provider_label_ar: 'Open-i', usage: 'linked_preview', license: 'CC BY (ترخيص المقال)', license_url: null, author: 'Smith A et al.', image_url: 'https://openi.nlm.nih.gov/imgs/512/x.png', title: 'Granuloma figure', token: 'signed-token-0987654321' })]));
      if (url === '/api/media/web-images/refs' && method === 'POST') {
        const b = body as { result: WebImageResult; source_id: string; page_id: string };
        const ref: WebImageRefView = { ...b.result, query: 'ورم حبيبي', source_id: b.source_id, version_id: null, page_id: b.page_id, note: null, label_ar: LABEL, created_at: 1 };
        pinned = [ref];
        return json({ item: ref }, 201);
      }
      return null;
    });
    render(<WebImagesPanel online sourceId="S1" pageId="P3" />);
    expect(await screen.findByText(/يحتاج مفتاح Google/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('ابحث عن صورة مرجعية'), { target: { value: 'ورم حبيبي' } });
    fireEvent.click(screen.getByRole('button', { name: 'ابحث' }));
    const grid = await screen.findByRole('list', { name: 'نتائج صور من الويب' });
    expect(calls.find((c) => c.url.endsWith('/search'))!.body).toEqual({ query: 'ورم حبيبي' });
    expect(screen.getByText(/بحثتُ عن/)).toBeTruthy();
    expect(screen.getAllByText(new RegExp(LABEL)).length).toBeGreaterThan(0);
    const cards = within(grid).getAllByRole('listitem');
    expect(cards).toHaveLength(2);
    const first = within(cards[0]!);
    expect(first.getByText('ويكيميديا كومنز')).toBeTruthy();
    expect(first.getByText('Nephron')).toBeTruthy();
    const lic = first.getByRole('link', { name: 'CC BY-SA 4.0' });
    expect(lic.getAttribute('href')).toBe('https://creativecommons.org/licenses/by-sa/4.0');
    const orig = first.getByRole('link', { name: /الصفحة الأصلية/ });
    expect(orig.getAttribute('href')).toBe(item.page_url);
    expect(orig.getAttribute('rel')).toBe('noopener noreferrer');
    // the picture comes through the server's proxy, never from the third party directly
    const img = first.getByRole('img', { name: item.title });
    expect(img.getAttribute('src')).toBe(item.thumb);
    expect(img.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(within(cards[1]!).getByText('CC BY (ترخيص المقال)')).toBeTruthy();

    fireEvent.click(first.getByRole('button', { name: `كبّر الصورة: ${item.title}` }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('img', { name: item.title }).getAttribute('src')).toBe(item.large);
    expect(within(dialog).getByText(item.caption!)).toBeTruthy();
    expect(within(dialog).getByText(/ترخيص حر/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'أضف إلى ملاحظاتي' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/media/web-images/refs' && c.method === 'POST')).toBe(true));
    const pin = calls.find((c) => c.url === '/api/media/web-images/refs' && c.method === 'POST')!.body as { result: WebImageResult; source_id: string; page_id: string; query: string };
    expect(pin).toMatchObject({ source_id: 'S1', page_id: 'P3', query: 'ورم حبيبي' });
    expect(pin.result).toMatchObject({ token: item.token, author: 'Nephron', license: 'CC BY-SA 4.0', page_url: item.page_url });
    expect(await within(dialog).findByRole('button', { name: 'في ملاحظاتك' })).toHaveProperty('disabled', true);
    const refs = screen.getByRole('list', { name: 'صور الويب في ملاحظاتي' });
    expect(within(refs).getByText('Nephron')).toBeTruthy();
    expect(within(refs).getByRole('button', { name: 'أزل من ملاحظاتي' })).toBeTruthy();
  });

  it('suggestions from the page’s figure descriptions search only when picked', async () => {
    const calls = server((url) => (url === '/api/media/web-images/status' ? json(available) : url.startsWith('/api/media/web-images/refs') ? json({ items: [] }) : url.endsWith('/search') ? json(searchResponse([result()])) : null));
    render(<WebImagesPanel online suggestions={['Colorectal adenocarcinoma histology', 'Colorectal adenocarcinoma histology']} />);
    const btn = await screen.findByRole('button', { name: 'ابحث: Colorectal adenocarcinoma histology' });
    expect(screen.getAllByRole('button', { name: /^ابحث: / })).toHaveLength(1);
    expect(calls.some((c) => c.url.endsWith('/search'))).toBe(false);
    fireEvent.click(btn);
    await screen.findByRole('list', { name: 'نتائج صور من الويب' });
    expect(calls.find((c) => c.url.endsWith('/search'))!.body).toEqual({ query: 'Colorectal adenocarcinoma histology' });
  });
});

describe('<WebImageStrip> (embeddable)', () => {
  it('searches its query, shows the label and the credit, enlarges on tap', async () => {
    const calls = server((url) => (url.endsWith('/search') ? json(searchResponse([result()])) : null));
    render(<WebImageStrip query="granuloma histology" max={4} />);
    const strip = await screen.findByRole('region', { name: 'صور من الويب' });
    expect(calls[0]!.body).toEqual({ query: 'granuloma histology', limit: 4 });
    expect(within(strip).getByText(new RegExp(LABEL))).toBeTruthy();
    expect(within(strip).getByText(/CC BY-SA 4.0/)).toBeTruthy();
    fireEvent.click(within(strip).getByRole('button', { name: /كبّر الصورة/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('link', { name: /الصفحة الأصلية/ }).getAttribute('href')).toBe('https://commons.wikimedia.org/wiki/File:Colon.jpg');
  });
});

describe('queryFromFigure', () => {
  const c = (over: Partial<FigureDescriptionContent>): FigureDescriptionContent => ({ image_type: 'histology', stain: null, magnification: null, findings: [], labels: [], graph: null, diagnosis: null, caption_ar: '', caption_en: '', ...over });
  it('diagnosis first with the picture type as a hint, else the English caption', () => {
    expect(queryFromFigure(c({ diagnosis: { text: 'Colorectal adenocarcinoma', basis: 'suggestion', quote: null } }))).toBe('Colorectal adenocarcinoma histology');
    expect(queryFromFigure(c({ image_type: 'radiology', caption_en: 'Chest X-ray showing right pneumothorax with collapse.' }))).toBe('Chest X-ray showing right pneumothorax with collapse radiograph');
    expect(queryFromFigure(c({ caption_en: 'Histology of caseating granuloma' }))).toBe('Histology of caseating granuloma');
    expect(queryFromFigure(c({}))).toBeNull();
    expect(queryFromFigure(null)).toBeNull();
  });
});
