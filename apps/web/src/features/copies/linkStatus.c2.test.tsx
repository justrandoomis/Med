// Phase 1 completion C2 — «the library offers the link» (AOS-19H.3) and «رسمي» on library rows (19I.2): one batched
// request for the visible rows; an official copy says «رسمي · المادة», a linked private lecture «مرتبطة بالنسخة الرسمية»
// with what still waits for review, a private lecture with an official twin «موجودة رسميًا في …» and its row menu offers
// «اربط بالمحاضرة الرسمية…». Offline nothing is asked and nothing is claimed.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OfficialLinkCandidate, OfficialLinkStatus } from '@medlevo/shared';
import { Menu, ToastProvider } from '../../design';
import { api } from '../../lib/api';
import { OfficialRowBadge, resetLinkStatusCache, useLinkToOfficialAction } from './linkStatus';

const status = (o: Partial<OfficialLinkStatus> & { source_id: string }): OfficialLinkStatus => ({ official: null, linked: null, candidate: null, ...o });
const CANDIDATE: OfficialLinkCandidate = {
  space_id: 'SPA',
  subject: { id: 'SUBJ', kind: 'subject', title: 'التشريح' },
  lecture_id: 'L1',
  title: 'الدورة القلبية',
  version_id: 'V1',
  version_no: 1,
  basis: 'sha256',
  matched_pages: 6,
  total_pages: 6,
  basis_ar: ['هذه المحاضرة موجودة رسميًا في مادة التشريح.'],
};

let gets: Array<{ path: string; query: unknown }>;
beforeEach(() => {
  resetLinkStatusCache();
  gets = [];
  vi.spyOn(api, 'get').mockImplementation(async (path: string, opts?: { query?: Record<string, unknown> }) => {
    gets.push({ path, query: opts?.query });
    if (path === '/copies/link-status')
      return {
        statuses: [
          status({ source_id: 'STUB', official: { space_id: 'SPA', lecture_id: 'L1', subject_title: 'التشريح' } }),
          status({ source_id: 'LINKED', linked: { stub_source_id: 'STUB', space_id: 'SPA', lecture_id: 'L1', subject_title: 'التشريح', pending: 2 } }),
          status({ source_id: 'TWIN', candidate: { space_id: 'SPA', lecture_id: 'L1', title: 'الدورة القلبية', subject_title: 'التشريح' } }),
          status({ source_id: 'PLAIN' }),
        ],
      };
    if (path === '/copies/link-candidates') return { source_id: 'TWIN', candidates: [CANDIDATE] };
    throw new Error(`unexpected ${path}`);
  });
});
afterEach(() => {
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
});

describe('library rows', () => {
  it('one request for the visible rows; each row says what it is', async () => {
    render(
      <ul>
        {['STUB', 'LINKED', 'TWIN', 'PLAIN'].map((id) => (
          <li key={id} data-testid={id}>
            <OfficialRowBadge sourceId={id} />
          </li>
        ))}
      </ul>,
    );
    expect(await screen.findByText('رسمي · التشريح')).toBeTruthy();
    expect(screen.getByText('مرتبطة بالنسخة الرسمية · 2 تنتظر المراجعة')).toBeTruthy();
    expect(screen.getByText('موجودة رسميًا في التشريح')).toBeTruthy();
    expect(screen.getByTestId('PLAIN').textContent).toBe('');
    expect(gets).toEqual([{ path: '/copies/link-status', query: { source_ids: 'STUB,LINKED,TWIN,PLAIN' } }]);
  });

  it('offline: nothing is asked and nothing is claimed', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    render(<OfficialRowBadge sourceId="TWIN" />);
    await act(async () => undefined);
    expect(gets).toEqual([]);
    expect(screen.queryByText(/موجودة رسميًا/)).toBeNull();
  });
});

function MenuHost({ sourceId }: { sourceId: string }) {
  const a = useLinkToOfficialAction(sourceId);
  return (
    <>
      <Menu trigger={<button type="button">خيارات</button>}>{a.item ?? <span>لا شيء</span>}</Menu>
      {a.dialog}
    </>
  );
}

describe('the row menu offers the link', () => {
  it('«اربط بالمحاضرة الرسمية…» opens the link dialog with the official twin', async () => {
    render(
      <MemoryRouter>
        <ToastProvider>
          <MenuHost sourceId="TWIN" />
        </ToastProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(gets.some((g) => g.path === '/copies/link-status')).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'خيارات' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'اربط بالمحاضرة الرسمية…' }));
    const dialog = await screen.findByRole('dialog', { name: 'اربط بالمحاضرة الرسمية' });
    expect(dialog.textContent).toContain('الدورة القلبية');
    expect(gets.at(-1)).toEqual({ path: '/copies/link-candidates', query: { source_id: 'TWIN' } });
  });

  it('(E2E regression) the result stays on screen after linking, although the row is no longer «موجودة رسميًا»', async () => {
    let linked = false;
    vi.mocked(api.get).mockImplementation(async (path: string, opts?: { query?: Record<string, unknown> }) => {
      gets.push({ path, query: opts?.query });
      if (path === '/copies/link-status')
        return { statuses: [linked ? status({ source_id: 'TWIN', linked: { stub_source_id: 'STUB', space_id: 'SPA', lecture_id: 'L1', subject_title: 'التشريح', pending: 1 } }) : status({ source_id: 'TWIN', candidate: { space_id: 'SPA', lecture_id: 'L1', title: 'الدورة القلبية', subject_title: 'التشريح' } })] };
      if (path === '/copies/link-candidates') return { source_id: 'TWIN', candidates: [CANDIDATE] };
      throw new Error(`unexpected ${path}`);
    });
    vi.spyOn(api, 'post').mockImplementation(async (path: string) => {
      if (path !== '/copies/link') throw new Error(`unexpected ${path}`);
      linked = true;
      return {
        copy: { id: 'C1', source_id: 'STUB', mode: 'personal' },
        job_id: null,
        summary: { total: 3, copied: 2, needs_review: 1, kept: 0, summary_ar: 'نُسخ عنصران، وعنصر واحد ينتظر مراجعتك.', note_pages: { total: 0, copied: 0, items: 0 } },
      };
    });
    render(
      <MemoryRouter>
        <ToastProvider>
          <MenuHost sourceId="TWIN" />
        </ToastProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(gets.some((g) => g.path === '/copies/link-status')).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'خيارات' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'اربط بالمحاضرة الرسمية…' }));
    const dialog = await screen.findByRole('dialog', { name: 'اربط بالمحاضرة الرسمية' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'اربط وانسخ ملاحظاتي' }));
    const done = await screen.findByRole('dialog', { name: 'رُبطت المحاضرة بنسختها الرسمية' });
    // the row's cached status is dropped (it is «linked» now): the result must not vanish with the menu item
    await act(async () => new Promise((r) => setTimeout(r, 50)));
    expect(screen.getByRole('dialog', { name: 'رُبطت المحاضرة بنسختها الرسمية' })).toBe(done);
    expect(within(done).getByRole('button', { name: 'راجع ما لم يُنسخ' })).toBeTruthy();
  });

  it('a row without an official twin has no such item', async () => {
    render(
      <MemoryRouter>
        <ToastProvider>
          <MenuHost sourceId="PLAIN" />
        </ToastProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(gets.some((g) => g.path === '/copies/link-status')).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'خيارات' }));
    expect(screen.queryByRole('menuitem', { name: 'اربط بالمحاضرة الرسمية…' })).toBeNull();
  });
});
