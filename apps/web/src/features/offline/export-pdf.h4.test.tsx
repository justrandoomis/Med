// Round 7 H4 item 8 (web): «الملف الأصلي مع كتابتي (PDF مسطح)» shows what will be drawn — and what will not, with the
// reason — BEFORE the file is built, then downloads the server's flattened PDF; «PDF» as a format appears only when
// the server lists it (LibreOffice present) and goes to the same export URL with format=pdf.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { AnnotatedPdfSummary, ExportFormatsResponse } from '@medlevo/shared';
import { ToastProvider } from '../../design';
import { setFetchImpl } from '../../lib/api';
import { ExportPanel } from './ExportPanel';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const mount = () =>
  render(
    <MemoryRouter>
      <ToastProvider>
        <ExportPanel />
      </ToastProvider>
    </MemoryRouter>,
  );
afterEach(() => {
  setFetchImpl(null);
  vi.unstubAllGlobals();
});

const formats = (pdf: boolean): ExportFormatsResponse => ({
  formats: [
    { format: 'md', label_ar: 'Markdown', note_ar: 'نص منظم.' },
    { format: 'docx', label_ar: 'Word (DOCX)', note_ar: 'Word.' },
    ...(pdf ? [{ format: 'pdf' as const, label_ar: 'PDF (من Word على الخادم)', note_ar: 'نسخة Word نفسها محوَّلة إلى PDF على الخادم.' }] : []),
  ],
  pdf_note_ar: pdf ? 'PDF على الخادم.' : 'PDF عبر الطباعة من المتصفح لأن LibreOffice غير مثبّت.',
  other: [],
});
const summary: AnnotatedPdfSummary = {
  source_id: 'S1',
  version_id: 'V1',
  title: 'Acute Appendicitis',
  available: true,
  reason_ar: null,
  pages: 4,
  drawn: { strokes: 3, highlighter_strokes: 1, shapes: 1, text_highlights: 0, images: 0, pages_with_writing: 2 },
  skipped: [{ kind: 'needs_reanchor', count: 1, reason_ar: 'كتابة تحتاج إعادة ربط بموضعها بعد تغيّر الصفحة — مكانها غير مؤكد، فلم تُرسم.' }],
  notes_ar: ['هذه صورة للكتابة وليست حبرًا قابلًا لإعادة التحرير.'],
};
const sources = [
  { id: 'S1', title: 'Acute Appendicitis', source_type: 'lecture', format: 'pdf', deleted_at: null },
  { id: 'S2', title: 'Scan', source_type: 'lecture', format: 'image', deleted_at: null },
];

describe('ExportPanel: the original PDF with my writing (H4)', () => {
  it('summarises what will and will not be drawn, then downloads the flattened PDF', async () => {
    const fetched: string[] = [];
    setFetchImpl(async (url) => {
      if (url === '/api/data/export/formats') return json(formats(false));
      if (url === '/api/library/tree') return json({ nodes: [], sources });
      if (url === '/api/data/export/source/S1/annotated-pdf/summary') return json(summary);
      return json({}, 404);
    });
    vi.stubGlobal('fetch', async (url: string) => {
      fetched.push(url);
      return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), { status: 200, headers: { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="x.pdf"' } });
    });
    const blobs: Blob[] = [];
    URL.createObjectURL = vi.fn((b: Blob) => {
      blobs.push(b);
      return 'blob:1';
    }) as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn();
    mount();
    await screen.findByText(/PDF عبر الطباعة/);
    fireEvent.change(screen.getByLabelText('ما الذي تصدّره'), { target: { value: 'annotated' } });
    // only sources that can carry a PDF are offered
    const picker = screen.getByLabelText('المصدر') as HTMLSelectElement;
    expect([...picker.options].map((o) => o.value)).toEqual(['', 'S1']);
    fireEvent.change(picker, { target: { value: 'S1' } });
    expect(await screen.findByText('سيُرسم على 2 صفحات: 3 ضربة قلم، 1 ضربة قلم تظليل، 1 شكل.')).toBeTruthy();
    expect(screen.getByText(/1 — كتابة تحتاج إعادة ربط/)).toBeTruthy();
    expect(screen.getByText(/ليست حبرًا قابلًا لإعادة التحرير/)).toBeTruthy();
    // no format choice and no browser-print button for the flattened PDF
    expect(screen.queryByRole('radio', { name: 'Markdown' })).toBeNull();
    expect(screen.queryByRole('button', { name: /افتح نسخة الطباعة/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /نزّل الملف/ }));
    await waitFor(() => expect(fetched).toEqual(['/api/data/export/source/S1/annotated-pdf']));
    expect(blobs).toHaveLength(1);
  });

  it('a source without an original PDF says why, from the server', async () => {
    setFetchImpl(async (url) => {
      if (url === '/api/data/export/formats') return json(formats(false));
      if (url === '/api/library/tree') return json({ nodes: [], sources: [{ ...sources[0], format: null }] });
      if (url === '/api/data/export/source/S1/annotated-pdf/summary') return json({ ...summary, available: false, reason_ar: 'لهذا المصدر لا يوجد ملف PDF أصلي يُرسم عليه.' });
      return json({}, 404);
    });
    mount();
    await screen.findByText(/PDF عبر الطباعة/);
    fireEvent.change(screen.getByLabelText('ما الذي تصدّره'), { target: { value: 'annotated' } });
    fireEvent.change(screen.getByLabelText('المصدر'), { target: { value: 'S1' } });
    expect(await screen.findByText('لهذا المصدر لا يوجد ملف PDF أصلي يُرسم عليه.')).toBeTruthy();
  });

  it('«PDF» is a format only when the server lists it; it goes to format=pdf', async () => {
    const fetched: string[] = [];
    setFetchImpl(async (url) => {
      if (url === '/api/data/export/formats') return json(formats(true));
      if (url === '/api/library/tree') return json({ nodes: [], sources });
      return json({}, 404);
    });
    vi.stubGlobal('fetch', async (url: string) => {
      fetched.push(url);
      return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), { status: 200, headers: { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="n.pdf"' } });
    });
    URL.createObjectURL = vi.fn(() => 'blob:1') as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn();
    mount();
    await screen.findByText('PDF على الخادم.');
    fireEvent.change(screen.getByLabelText('ما الذي تصدّره'), { target: { value: 'notes' } });
    fireEvent.click(screen.getByRole('radio', { name: 'PDF (من Word على الخادم)' }));
    expect(screen.getByText(/محوَّلة إلى PDF على الخادم/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /نزّل الملف/ }));
    await waitFor(() => expect(fetched).toEqual(['/api/data/export/notes?format=pdf']));
  });
});
