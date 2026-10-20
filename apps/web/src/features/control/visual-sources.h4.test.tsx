// Round 7 H4 item 9 (web): the Control Center screen of the visual-source registry (§32) — the list with each entry's
// place (LTR-isolated) and the owner's licence note, enable / disable, add with the server's field errors, delete
// after a stated impact, and the plain statement that nothing is fetched (server switch off / no provider).
import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { VisualSourceListResponse, VisualSourceView } from '@medlevo/shared';
import { ToastProvider } from '../../design';
import { setFetchImpl } from '../../lib/api';
import { SECTIONS } from './model';
import { VisualSourcesScreen } from './VisualSourcesScreen';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
afterEach(() => setFetchImpl(null));

const entry = (over: Partial<VisualSourceView> = {}): VisualSourceView => ({
  id: 'V1',
  name: 'Atlas (TEST)',
  domain: 'atlas.example-med.org',
  path_prefix: '/cases/',
  kind: 'atlas',
  kind_label_ar: 'أطلس صور',
  licence_note: 'CC BY-NC-SA',
  enabled: true,
  note: null,
  created_at: 1,
  updated_at: 1,
  ...over,
});
const list = (items: VisualSourceView[]): VisualSourceListResponse => ({
  items,
  fetch: { server_allows: false, provider_available: false, state: 'disabled', reason_ar: 'الجلب من الإنترنت معطّل على الخادم (MEDLEVO_ALLOW_EXTERNAL_FETCH)، ولا يوجد مزود بحث عن الصور.' },
  notes_ar: ['صور مصادرك تُعرض أولًا دائمًا.'],
});
const mount = () =>
  render(
    <MemoryRouter>
      <ToastProvider>
        <VisualSourcesScreen />
      </ToastProvider>
    </MemoryRouter>,
  );

describe('المصادر البصرية المسموح بها (H4)', () => {
  it('is a Control Center section', () => {
    expect(SECTIONS.find((s) => s.key === 'visual_sources')).toMatchObject({ href: '/control/visual-sources' });
  });

  it('lists entries with place and licence note; says plainly that fetching is off; toggles an entry', async () => {
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    setFetchImpl(async (url, init) => {
      calls.push({ method: init?.method ?? 'GET', url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url === '/api/media/visual-sources' && (init?.method ?? 'GET') === 'GET') return json(list([entry()]));
      if (url === '/api/media/visual-sources/V1' && init?.method === 'PATCH') return json({ item: entry({ enabled: false }) });
      return json({}, 404);
    });
    mount();
    expect(await screen.findByText('Atlas (TEST)')).toBeTruthy();
    expect(screen.getByText('atlas.example-med.org/cases/').closest('bdi, [dir="ltr"]')).toBeTruthy();
    expect(screen.getByText(/CC BY-NC-SA/)).toBeTruthy();
    expect(screen.getByText('معطّل على الخادم')).toBeTruthy();
    expect(screen.getByText(/MEDLEVO_ALLOW_EXTERNAL_FETCH/)).toBeTruthy();
    fireEvent.click(screen.getByRole('switch', { name: 'يُقبل منه' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH' && (c.body as { enabled: boolean }).enabled === false)).toBe(true));
    expect(await screen.findByText('معطّل')).toBeTruthy();
  });

  it('adds an entry; a server field error is shown on its field', async () => {
    let posted = 0;
    setFetchImpl(async (url, init) => {
      if (url === '/api/media/visual-sources' && (init?.method ?? 'GET') === 'GET') return json(list([]));
      if (url === '/api/media/visual-sources' && init?.method === 'POST') {
        posted++;
        const b = JSON.parse(String(init.body)) as { domain: string; name: string };
        if (b.domain === '10.0.0.1')
          return json({ error: { code: 'VALIDATION_FAILED', message: 'تحقق من الحقول.', details: { issues: [{ path: 'domain', message: 'اكتب اسم نطاق وليس عنوان IP.' }] } } }, 400);
        return json({ item: entry({ id: 'V2', name: b.name, domain: 'openimages-test.org', path_prefix: null, licence_note: null }) }, 201);
      }
      return json({}, 404);
    });
    mount();
    expect(await screen.findByText(/لا مصادر بصرية في سجلك بعد/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/^الاسم/), { target: { value: 'Open images (TEST)' } });
    fireEvent.change(screen.getByLabelText(/^النطاق/), { target: { value: '10.0.0.1' } });
    fireEvent.click(screen.getByRole('button', { name: 'أضف' }));
    expect(await screen.findByText('اكتب اسم نطاق وليس عنوان IP.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/^النطاق/), { target: { value: 'openimages-test.org' } });
    fireEvent.click(screen.getByRole('button', { name: 'أضف' }));
    const item = await screen.findByText('Open images (TEST)', { selector: 'h3' });
    expect(within(item.closest('li')!).getByText('openimages-test.org')).toBeTruthy();
    expect(posted).toBe(2);
  });

  it('delete states its impact first and removes the entry', async () => {
    let deleted = false;
    setFetchImpl(async (url, init) => {
      if (url === '/api/media/visual-sources' && (init?.method ?? 'GET') === 'GET') return json(list([entry()]));
      if (url === '/api/media/visual-sources/V1' && init?.method === 'DELETE') {
        deleted = true;
        return json({ ok: true });
      }
      return json({}, 404);
    });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'احذف «Atlas (TEST)»' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/لن تُقبل بعد الآن صور خارجية من هذا الموقع/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'احذف من السجل' }));
    await waitFor(() => expect(deleted).toBe(true));
    await waitFor(() => expect(screen.queryByText('Atlas (TEST)', { selector: 'h3' })).toBeNull());
  });
});
