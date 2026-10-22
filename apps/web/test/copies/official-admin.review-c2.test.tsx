// Review of Phase 1 completion track C2 — «ارفع عدة محاضرات» when a file's upload fails (review R4; failed before the
// fix). The draft was already created; the result told the moderator to upload the file again from «أضف محاضرة رسمية»
// «بالعنوان نفسه» — which creates a SECOND draft with that title (that form only reuses a draft it created itself) and
// leaves the empty one behind. Now the failed row offers «أعد المحاولة», which uploads the file into the SAME draft
// (no second lecture), and the count of uploaded files follows.
import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import type { ChannelNodeView } from '@medlevo/shared';
import { ToastProvider } from '../../src/design';
import { setFetchImpl } from '../../src/lib/api';
import { OfficialContentSection } from '../../src/features/lectures/admin/OfficialContentSection';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const NODE = {
  id: 's1',
  kind: 'subject',
  title: 'التشريح',
  parent_id: 'uni',
  title_en: null,
  ordinal: null,
  starts_on: null,
  ends_on: null,
  has_space: true,
  space_id: 'sp_s1',
  join_policy: 'approval',
  status: 'active',
  viewer: { membership: null, roles: ['subject_moderator'], inherited_from: null, course_follow: null },
} as unknown as ChannelNodeView;

interface Call {
  method: string;
  url: string;
}

function serve(failFirstUploadOf: string) {
  const calls: Call[] = [];
  let created = 0;
  let failed = false;
  setFetchImpl(async (url, init) => {
    const method = (init.method ?? 'GET').toUpperCase();
    calls.push({ method, url });
    const path = url.split('?')[0]!;
    if (path === '/api/channels/tree') return json({ nodes: [NODE], truncated: false });
    if (path === '/api/accounts/me') return json({ is_platform_admin: false });
    if (path === '/api/spaces/sp_s1/lectures' && method === 'GET') return json({ items: [], next_cursor: null });
    if (path === '/api/spaces/sp_s1/lectures' && method === 'POST') {
      created++;
      const title = (JSON.parse(String(init.body)) as { title: string }).title;
      return json({ id: `Lnew${created}`, title, status: 'draft', versions: [] });
    }
    const up = /^\/api\/spaces\/sp_s1\/lectures\/([^/]+)\/upload$/.exec(path);
    if (up) {
      if (up[1] === failFirstUploadOf && !failed) {
        failed = true;
        return json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'انقطع الاتصال أثناء الرفع.' } }, 503);
      }
      return json({ version_id: `v_${up[1]}`, job_id: 'j' });
    }
    if (path === '/api/spaces/sp_s1/subject/corrections') return json({ corrections: [] });
    if (path === '/api/spaces/sp_s1/subject/review') return json({ items: [] });
    return json({ error: { code: 'NOT_FOUND', message: 'غير موجود' } }, 404);
  });
  return calls;
}

function mount() {
  const router = createMemoryRouter([{ path: '/admin/:section', element: <OfficialContentSection /> }], { initialEntries: ['/admin/official'] });
  return render(
    <ToastProvider>
      <RouterProvider router={router} />
    </ToastProvider>,
  );
}
afterEach(() => setFetchImpl(null));

const pdf = (name: string) => new File([new Uint8Array([37, 80, 68, 70])], name, { type: 'application/pdf' });

describe('«ارفع عدة محاضرات» — a failed file is retried into the same draft', () => {
  it('the failed row offers «أعد المحاولة», which uploads into the draft already made (no second lecture)', async () => {
    const calls = serve('Lnew1');
    mount();
    const bulk = await screen.findByRole('region', { name: 'ارفع عدة محاضرات' });
    fireEvent.change(within(bulk).getByLabelText(/ملفات المحاضرات/), { target: { files: [pdf('Lecture 1 renal.pdf'), pdf('Lecture 2 lungs.pdf')] } });
    fireEvent.click(within(bulk).getByRole('button', { name: 'ارفع محاضرتين' }));
    await within(bulk).findByText('رُفعت 1 من 2. الأرقام والتواريخ تُقرأ من الملفات وتنتظر مراجعتك.');
    const results = within(bulk).getByRole('list', { name: 'نتيجة الرفع' });
    const failedRow = within(results).getAllByRole('listitem')[0]!;
    expect(failedRow.textContent).toContain('لم يُرفع');
    // never the advice that makes a second draft with the same title
    expect(failedRow.textContent).not.toContain('بالعنوان نفسه');
    fireEvent.click(within(failedRow).getByRole('button', { name: /أعد المحاولة/ }));
    await within(bulk).findByText('رُفعت 2 من 2. الأرقام والتواريخ تُقرأ من الملفات وتنتظر مراجعتك.');
    expect(calls.filter((c) => c.method === 'POST' && c.url === '/api/spaces/sp_s1/lectures')).toHaveLength(2);
    const uploads = calls.filter((c) => /\/upload$/.test(c.url)).map((c) => c.url);
    expect(uploads).toEqual(['/api/spaces/sp_s1/lectures/Lnew1/upload', '/api/spaces/sp_s1/lectures/Lnew2/upload', '/api/spaces/sp_s1/lectures/Lnew1/upload']);
    await waitFor(() => expect(within(results).getAllByRole('listitem')[0]!.textContent).toContain('رُفع'));
    expect(within(results).queryByRole('button', { name: /أعد المحاولة/ })).toBeNull();
  });
});
