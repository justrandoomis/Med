// Phase 1 completion, track C2 — «المحتوى الرسمي» (IA §4.10):
//   * AOS-2.3 / 18.3 (bulk): «ارفع عدة محاضرات» — several files at once, one draft per file named from the file, uploaded
//     one after the other with an honest per-file result; the duplicate answer of the server (AOS-3.6) is shown as given;
//   * AOS-3.18 / 3.11: the subject's review queue (moderators only): every proposal is marked as machine-made, with its
//     reasons and what accepting does; accept / reject are the server's decisions; a contributor has no queue;
//   * AOS-19I.5: a lecture number read from the file is marked so in the list.
import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import type { ChannelNodeView, ChannelRole, OfficialLectureDetail, SubjectReviewItem } from '@medlevo/shared';
import { ToastProvider } from '../../src/design';
import { setFetchImpl } from '../../src/lib/api';
import { OfficialContentSection } from '../../src/features/lectures/admin/OfficialContentSection';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const user = (id: string, name: string) => ({ id, display_name: name, avatar_url: null });

function node(roles: ChannelRole[]): ChannelNodeView {
  return {
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
    viewer: { membership: null, roles, inherited_from: null, course_follow: null },
  } as ChannelNodeView;
}

const DETECTED: OfficialLectureDetail = {
  id: 'L21',
  space_id: 'sp_s1',
  subject: { id: 's1', kind: 'subject', title: 'التشريح' },
  title: 'Cardiac cycle',
  lecture_no: 21,
  lecture_no_origin: 'detected',
  held_on: null,
  status: 'draft',
  head_version: null,
  uploaded_by: user('u_m', 'مشرف المادة'),
  approved: null,
  counts: { explanations: 0 },
  updated_at: 1,
  versions: [{ id: 'v1', version_no: 1, kind: 'upload', status: 'draft', file_name: 'Lecture 21.pdf', page_count: 12, processing_status: 'ready', published_at: null, published_by: null, change_note: null, previous_version_id: null, page_map_status: null, uploaded_by: user('u_m', 'مشرف المادة') }],
  withdrawn: null,
};

const REVIEW: SubjectReviewItem[] = [
  {
    suggestion: { id: 'sg1', source_id: 'src9', source_title: 'L9 histology', version_id: 'v9', field: 'lecture_no', value: { field: 'lecture_no', lecture_no: 9 }, certainty: 'uncertain', status: 'open', reasons_ar: ['«L9» في اسم الملف'], effect_ar: 'يصبح رقم المحاضرة 9.', created_at: 1, decided_at: null },
    lecture: { id: 'L9', title: 'Histology of the kidney', status: 'draft', lecture_no: null },
    target_lecture: null,
  },
  {
    suggestion: {
      id: 'sg2',
      source_id: 'src5',
      source_title: 'Lecture 5 re-export',
      version_id: 'v5b',
      field: 'new_version_of',
      value: { field: 'new_version_of', source_id: 'srcA', version_id: 'vA', title: 'Lecture 5 — Abdomen', matched_pages: 5, total_pages: 6 },
      certainty: 'uncertain',
      status: 'open',
      reasons_ar: ['تطابق 5 صفحات من 6'],
      effect_ar: 'يصبح الملف إصدارًا جديدًا من «Lecture 5 — Abdomen».',
      created_at: 1,
      decided_at: null,
    } as SubjectReviewItem['suggestion'],
    lecture: { id: 'L5b', title: 'Lecture 5 (re-exported)', status: 'draft', lecture_no: null },
    target_lecture: { id: 'L5', title: 'Lecture 5 — Abdomen', status: 'published', head_version_no: 1 },
  },
];

interface Call {
  method: string;
  url: string;
  body: unknown;
}
function serve(opts: { roles: ChannelRole[]; lectures?: OfficialLectureDetail[]; duplicateFor?: string }) {
  const calls: Call[] = [];
  let created = 0;
  let review = [...REVIEW];
  setFetchImpl(async (url, init) => {
    const method = (init.method ?? 'GET').toUpperCase();
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : init.body;
    calls.push({ method, url, body });
    const path = url.split('?')[0]!;
    if (path === '/api/channels/tree') return json({ nodes: [node(opts.roles)], truncated: false });
    if (path === '/api/accounts/me') return json({ is_platform_admin: false });
    if (path === '/api/spaces/sp_s1/lectures' && method === 'GET') return json({ items: opts.lectures ?? [], next_cursor: null });
    if (path === '/api/spaces/sp_s1/lectures' && method === 'POST') {
      created++;
      return json({ ...DETECTED, id: `Lnew${created}`, title: (body as { title: string }).title, lecture_no: null, lecture_no_origin: null, versions: [] });
    }
    const m = /^\/api\/spaces\/sp_s1\/lectures\/([^/]+)$/.exec(path);
    if (m) return json((opts.lectures ?? []).find((l) => l.id === m[1]) ?? DETECTED);
    const up = /^\/api\/spaces\/sp_s1\/lectures\/([^/]+)\/upload$/.exec(path);
    if (up) {
      if (up[1] === opts.duplicateFor) return json({ version_id: `v_${up[1]}`, job_id: 'j', duplicate_of: { lecture_id: 'L5', title: 'Lecture 5 — Abdomen', version_no: 1 }, duplicate_note_ar: 'هذا الملف مطابق للإصدار 1 من «Lecture 5 — Abdomen».' });
      return json({ version_id: `v_${up[1]}`, job_id: 'j' });
    }
    if (path === '/api/spaces/sp_s1/subject/corrections') return json({ corrections: [] });
    if (path === '/api/spaces/sp_s1/subject/review') return json({ items: review });
    const d = /^\/api\/spaces\/sp_s1\/subject\/review\/([^/]+)\/decide$/.exec(path);
    if (d) {
      const item = review.find((i) => i.suggestion.id === d[1])!;
      review = review.filter((i) => i.suggestion.id !== d[1]);
      const accept = (body as { action: string }).action === 'accept';
      return json({ item: { ...item, suggestion: { ...item.suggestion, status: accept ? 'accepted' : 'rejected' } }, result_ar: accept ? 'أصبح الملف الإصدار 2 من «Lecture 5 — Abdomen» (مسودة).' : 'رُفض الاقتراح.' });
    }
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

describe('AOS-2.3 / 18.3 — «ارفع عدة محاضرات»: one draft per file, an honest result per file', () => {
  it('three files make three drafts named from their files; a duplicate answer is shown as the server gave it', async () => {
    const calls = serve({ roles: ['subject_moderator'], duplicateFor: 'Lnew2' });
    mount();
    const bulk = await screen.findByRole('region', { name: 'ارفع عدة محاضرات' });
    const input = within(bulk).getByLabelText(/ملفات المحاضرات/);
    fireEvent.change(input, { target: { files: [pdf('Lecture 23 renal.pdf'), pdf('Lecture 21 cardiac.pdf'), pdf('Lecture 22 lungs.pptx')] } });
    expect(within(bulk).getByText('3 ملفات مختارة')).toBeTruthy();
    fireEvent.click(within(bulk).getByRole('button', { name: 'ارفع 3 محاضرات' }));
    const results = await within(bulk).findByRole('list', { name: 'نتيجة الرفع' });
    await waitFor(() => expect(within(results).getAllByRole('listitem')).toHaveLength(3));
    const posts = calls.filter((c) => c.method === 'POST' && c.url === '/api/spaces/sp_s1/lectures').map((c) => (c.body as { title: string }).title);
    expect(posts).toEqual(['Lecture 23 renal', 'Lecture 21 cardiac', 'Lecture 22 lungs']);
    expect(calls.filter((c) => /\/upload$/.test(c.url))).toHaveLength(3);
    const rows = within(results).getAllByRole('listitem');
    expect(rows[0]!.textContent).toContain('Lecture 23 renal');
    expect(rows[0]!.textContent).toContain('رُفع');
    expect(rows[1]!.textContent).toContain('هذا الملف مطابق للإصدار 1 من «Lecture 5 — Abdomen».');
    expect(within(bulk).getByText('رُفعت 3 من 3. الأرقام والتواريخ تُقرأ من الملفات وتنتظر مراجعتك.')).toBeTruthy();
  });
});

describe('AOS-3.18 / 3.11 / 19I.5 — the subject\'s review queue', () => {
  it('a Subject Moderator sees the proposals marked as machine-made, with reasons and effect; accepting reports the server\'s result', async () => {
    const calls = serve({ roles: ['subject_moderator'], lectures: [DETECTED] });
    mount();
    const queue = await screen.findByRole('region', { name: 'مراجعة ما اقترحه التحليل' });
    const items = await within(queue).findAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain('اقتراح آلي — غير مؤكد');
    expect(items[0]!.textContent).toContain('رقم المحاضرة: 9');
    expect(items[0]!.textContent).toContain('«L9» في اسم الملف');
    expect(items[1]!.textContent).toContain('إصدار جديد من «Lecture 5 — Abdomen»');
    expect(items[1]!.textContent).toContain('يصبح الملف إصدارًا جديدًا من «Lecture 5 — Abdomen».');
    fireEvent.click(within(items[1]!).getByRole('button', { name: 'اقبل' }));
    expect(await screen.findByText('أصبح الملف الإصدار 2 من «Lecture 5 — Abdomen» (مسودة).')).toBeTruthy();
    expect(calls.find((c) => c.method === 'POST' && c.url === '/api/spaces/sp_s1/subject/review/sg2/decide')?.body).toEqual({ action: 'accept' });
    await waitFor(() => expect(within(queue).getAllByRole('listitem')).toHaveLength(1));
    // the list marks the number that was read from the file
    expect(await screen.findByText(/رقم مقروء آليًا من الملف/)).toBeTruthy();
  });

  it('a Contributor has no review queue and never asks for one', async () => {
    const calls = serve({ roles: ['contributor'] });
    mount();
    await screen.findByRole('region', { name: 'ارفع عدة محاضرات' });
    expect(screen.queryByRole('region', { name: 'مراجعة ما اقترحه التحليل' })).toBeNull();
    expect(calls.some((c) => c.url.includes('/subject/review'))).toBe(false);
  });
});
