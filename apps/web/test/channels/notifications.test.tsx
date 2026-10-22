// P1-T4 step 3 — «التنبيهات» (IA §4.9; PRD AOS-18.13, 21.31): one inbox grouped by day, unread said in TEXT (not only a
// dot), «علّم كمقروء» per row and for all, each row opens its target, preferences per kind (in-app), push honestly
// gated with the server's reason. The bell in the top bar shows the unread count as text.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import type { NotificationPrefsResponse, NotificationView } from '@medlevo/shared';
import { ToastProvider } from '../../src/design';
import { setFetchImpl } from '../../src/lib/api';
import { setOwnerTimeZone } from '../../src/lib/time';
import { NotificationsScreen } from '../../src/features/notifications/NotificationsScreen';
import { NotificationBell } from '../../src/features/notifications/NotificationBell';
import { setUnreadCount } from '../../src/features/notifications/api';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const NOW = Date.now();
const DAY = 86_400_000;

function note(id: string, over: Partial<NotificationView>): NotificationView {
  return {
    id,
    kind: 'join_decided',
    payload: { node_title: 'Anatomy', decision: 'approved' },
    actor: null,
    target: null,
    text_ar: `نص ${id}`,
    link: null,
    created_at: NOW,
    read_at: null,
    ...over,
  } as NotificationView;
}

const PREFS: NotificationPrefsResponse = {
  prefs: [
    { kind: 'join_decided', label_ar: 'قرار طلب انضمامي', in_app: true, push: false },
    { kind: 'official_lecture_new', label_ar: 'محاضرة رسمية جديدة في مادة أتابعها', in_app: true, push: false },
  ],
  push: { available: false, reason_ar: 'الإشعارات خارج التطبيق غير مفعّلة على هذا الخادم بعد.' },
};

let calls: Array<{ method: string; url: string; body: unknown }> = [];
function serve(items: NotificationView[], unread = items.filter((i) => !i.read_at).length) {
  calls = [];
  setFetchImpl(async (url, init) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    if (url.startsWith('/api/notifications/prefs')) return json(method === 'PUT' ? PREFS : PREFS);
    if (url.startsWith('/api/notifications/read')) return json({ updated: 1, unread_count: Math.max(0, unread - 1) });
    if (url.startsWith('/api/notifications')) return json({ items, next_cursor: null, unread_count: unread });
    return json({}, 404);
  });
}

function show(el = <NotificationsScreen />) {
  const router = createMemoryRouter(
    [
      { path: '/notifications', element: el },
      { path: '/subjects/:id', element: <h1>صفحة المادة</h1> },
    ],
    { initialEntries: ['/notifications'] },
  );
  render(
    <ToastProvider>
      <RouterProvider router={router} />
    </ToastProvider>,
  );
  return router;
}

beforeEach(() => setOwnerTimeZone('Asia/Baghdad'));
afterEach(() => {
  setFetchImpl(null);
  setUnreadCount(null);
});

describe('«التنبيهات» inbox', () => {
  it('groups by day, says «غير مقروء» in text, and opens a row’s target (marking it read)', async () => {
    serve([note('n1', { text_ar: 'قُبل طلب انضمامك إلى Anatomy', link: '/subjects/anat' }), note('n2', { created_at: NOW - 3 * DAY, read_at: NOW - 2 * DAY, text_ar: 'دعوة للانضمام' })]);
    const router = show();
    await screen.findByRole('heading', { level: 1, name: 'التنبيهات' });
    const today = screen.getByRole('region', { name: 'اليوم' });
    const row = within(today).getByRole('listitem');
    expect(within(row).getByText('غير مقروء')).toBeTruthy();
    expect(screen.queryAllByText('غير مقروء')).toHaveLength(1);
    // an older day has its own heading
    expect(within(document.querySelector<HTMLElement>('.nt-days')!).getAllByRole('region')).toHaveLength(2);
    fireEvent.click(within(row).getByRole('link', { name: /قُبل طلب انضمامك/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/subjects/anat'));
    expect(calls.find((c) => c.url.startsWith('/api/notifications/read'))?.body).toEqual({ ids: ['n1'] });
  });

  it('marks one or all as read; «علّم الكل كمقروء» is disabled with its reason when nothing is unread', async () => {
    serve([note('n1', {})]);
    show();
    const markOne = await screen.findByRole('button', { name: 'علّم كمقروء' });
    fireEvent.click(markOne);
    await waitFor(() => expect(calls.some((c) => c.url.startsWith('/api/notifications/read') && JSON.stringify(c.body) === '{"ids":["n1"]}')).toBe(true));
    await waitFor(() => expect(screen.queryByText('غير مقروء')).toBeNull());
    const all = screen.getByRole('button', { name: 'علّم الكل كمقروء' });
    expect((all as HTMLButtonElement).disabled).toBe(true);
    expect(all.getAttribute('aria-describedby')).toBeTruthy();
    expect(document.getElementById(all.getAttribute('aria-describedby')!)?.textContent).toMatch(/لا توجد تنبيهات غير مقروءة/);
  });

  it('shows the honest empty state, the push reason from the server, and in-app preferences per kind', async () => {
    serve([]);
    show();
    expect(await screen.findByText('لا توجد تنبيهات بعد')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /تفضيلات التنبيهات/ }));
    expect(await screen.findByText(/غير مفعّلة على هذا الخادم/)).toBeTruthy();
    const sw = screen.getByRole('switch', { name: /محاضرة رسمية جديدة/ });
    fireEvent.click(sw);
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ prefs: [{ kind: 'official_lecture_new', channel: 'in_app', enabled: false }] }),
    );
  });
});

describe('the bell', () => {
  it('shows the unread count as text with an accessible name, nothing when there is none', async () => {
    serve([note('n1', {}), note('n2', {})]);
    const router = createMemoryRouter([{ path: '/', element: <NotificationBell /> }], { initialEntries: ['/'] });
    render(<RouterProvider router={router} />);
    const bell = await screen.findByRole('link', { name: 'التنبيهات، 2 غير مقروءة' });
    expect(bell.textContent).toBe('2');
    expect(bell.getAttribute('href')).toBe('/notifications');
  });
});
