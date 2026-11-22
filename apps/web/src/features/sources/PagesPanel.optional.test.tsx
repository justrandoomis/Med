// «يحتاج مراجعة» is not an error: doubtful OCR text is an OPTIONAL review with one-tap «اعتمد كما هو» / «اعتمد الكل», and
// a picture slide is «صورة» (TEST FIXTURE data only).
import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SourcePageView, SourceVersionView } from '@medlevo/shared';
import { ToastProvider } from '../../design';
import { setFetchImpl } from '../../lib/api';
import { PagesPanel, pageTextLabel } from './PagesPanel';

afterEach(() => setFetchImpl(null));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const version = { id: 'V1', version_no: 1, is_frozen: false, format: 'pdf', pagination: 'slides' } as unknown as SourceVersionView;
const page = (i: number, over: Partial<SourcePageView>): SourcePageView =>
  ({
    id: `P${i}`,
    version_id: 'V1',
    page_index: i,
    printed_label: null,
    printed_label_origin: null,
    kind: 'slide',
    width: 720,
    height: 540,
    unit: 'pt',
    rotation: 0,
    text_status: 'ocr',
    ocr_confidence: 0.55,
    has_images: true,
    processing_status: 'ready',
    error_code: null,
    error_detail_ar: null,
    thumbnail_file_id: null,
    render_file_id: null,
    section_key: null,
    ...over,
  }) as SourcePageView;

describe('optional review in the pages panel', () => {
  it('labels: a picture page is «صورة»', () => {
    expect(pageTextLabel({ text_status: 'no_text_found', picture_page: true })).toBe('صورة');
    expect(pageTextLabel({ text_status: 'ocr', picture_page: true })).toBe('صورة مع تعليق قصير');
    expect(pageTextLabel({ text_status: 'digital', picture_page: false })).toBe('نص رقمي');
  });

  it('a page with doubtful OCR is ready with an optional review; «اعتمد الكل» accepts the version', async () => {
    const posts: Array<{ url: string; body: unknown }> = [];
    let accepted = false;
    setFetchImpl(async (input, init) => {
      const url = String(input);
      if (init?.method === 'POST') {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        accepted = true;
        return json({ accepted: 2, skipped: 0, pages_ready: 2, open_left: 0 });
      }
      if (url.includes('/versions/V1/pages'))
        return json({
          version,
          pages: [
            page(0, { processing_status: accepted ? 'ready' : 'needs_review', optional_review: accepted ? 0 : 2, error_detail_ar: null }),
            page(1, { text_status: 'no_text_found', picture_page: true, optional_review: 0 }),
          ],
        });
      if (url.includes('/processing')) return json({ version_id: 'V1', status: 'needs_review', summary: null, job: null });
      return json({});
    });
    render(
      <ToastProvider>
        <PagesPanel sourceId="S1" versions={[version]} activeVersionId="V1" readOnly={false} />
      </ToastProvider>,
    );
    expect(await screen.findByText('جاهزة — مراجعة اختيارية')).toBeTruthy();
    expect(screen.queryByText('تحتاج مراجعة')).toBeNull();
    expect(screen.getByText('صورة')).toBeTruthy();
    expect(screen.getByRole('button', { name: /اعتمد كما هو/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'اعتمد الكل' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.url).toContain('/control/review/processing/accept');
    expect(posts[0]!.body).toEqual({ version_id: 'V1' });
  });
});
