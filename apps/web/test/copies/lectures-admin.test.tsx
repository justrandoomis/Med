// P1-T5 step 1 — the «إدارة القنوات» sections «المحتوى الرسمي» and «الملفات المكررة» (IA §4.10; PRD AOS-18.3, 18.4,
// 18.9, 18.10, 18.11; Q5). The screens show what the server answers: a Subject Moderator approves, publishes (after a
// preview of the page changes and of how many students hold a copy — never a count under 5) and withdraws; a
// Contributor adds lectures that wait; nobody sees a control the server would refuse them. Registered through
// P1-T4's section registry; the area that hosts `/admin/:section` is P1-T4's (its step 3).
import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import type { ChannelNodeView, ChannelRole, OfficialCorrectionView, OfficialLectureDetail, OfficialVersionView, SubjectDuplicatesResponse } from '@medlevo/shared';
import { ToastProvider } from '../../src/design';
import { setFetchImpl } from '../../src/lib/api';
import { adminSections, visibleAdminSections } from '../../src/features/admin/sections';
import { routes as lecturesRoutes } from '../../src/features/lectures/routes';
import { OfficialContentSection } from '../../src/features/lectures/admin/OfficialContentSection';
import { DuplicatesSection } from '../../src/features/lectures/admin/DuplicatesSection';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const user = (id: string, name: string) => ({ id, display_name: name, avatar_url: null });

function node(id: string, title: string, roles: ChannelRole[], spaceId: string | null = `sp_${id}`): ChannelNodeView {
  return {
    id,
    kind: 'subject',
    title,
    parent_id: 'uni',
    title_en: null,
    ordinal: null,
    starts_on: null,
    ends_on: null,
    has_space: true,
    space_id: spaceId,
    join_policy: 'approval',
    status: 'active',
    viewer: { membership: null, roles, inherited_from: null, course_follow: null },
  } as ChannelNodeView;
}

function version(over: Partial<OfficialVersionView> = {}): OfficialVersionView {
  return {
    id: 'v1',
    version_no: 1,
    kind: 'upload',
    status: 'draft',
    file_name: 'lecture1.pdf',
    page_count: 12,
    processing_status: 'ready',
    published_at: null,
    published_by: null,
    change_note: null,
    previous_version_id: null,
    page_map_status: null,
    ...over,
  };
}

function lecture(over: Partial<OfficialLectureDetail> = {}): OfficialLectureDetail {
  return {
    id: 'L1',
    space_id: 'sp_s1',
    subject: { id: 's1', kind: 'subject', title: 'التشريح' },
    title: 'الجهاز الهضمي',
    lecture_no: 3,
    lecture_no_origin: 'moderator',
    held_on: null,
    status: 'in_review',
    head_version: null,
    uploaded_by: user('u_c', 'مساهمة المادة'),
    approved: null,
    counts: { explanations: 0 },
    updated_at: 1,
    versions: [version()],
    withdrawn: null,
    ...over,
  };
}

const PUBLISHED = lecture({
  id: 'L2',
  title: 'القلب',
  lecture_no: 1,
  status: 'published',
  head_version: { id: 'v9', version_no: 1, page_count: 20, processing_status: 'ready' },
  uploaded_by: user('u_m', 'مشرف المادة'),
  versions: [version({ id: 'v9', status: 'published', published_at: Date.UTC(2026, 9, 1) })],
});

const CORRECTION: OfficialCorrectionView = {
  id: 'c1',
  lecture: { id: 'L2', title: 'القلب' },
  version: { id: 'v9', version_no: 1 },
  items: [{ region_id: 'r1', page_index: 4, before: 'Mitral valve has 3 cusps', after: 'Mitral valve has 2 cusps' }],
  note: 'خطأ في عدد الشرفات',
  proposed_by: user('u_c', 'مساهمة المادة'),
  status: 'open',
  result_version_id: null,
  decided_by: null,
  decided_at: null,
  decision_note: null,
  failure_reason_ar: null,
  created_at: 1,
};

interface Call {
  method: string;
  url: string;
  body: unknown;
}

function serve(opts: { nodes: ChannelNodeView[]; platformAdmin?: boolean; lectures?: OfficialLectureDetail[]; corrections?: OfficialCorrectionView[]; duplicates?: SubjectDuplicatesResponse; uploadFailures?: number }) {
  const calls: Call[] = [];
  let failures = opts.uploadFailures ?? 0;
  const lectures = opts.lectures ?? [];
  setFetchImpl(async (url, init) => {
    const method = (init.method ?? 'GET').toUpperCase();
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : init.body;
    calls.push({ method, url, body });
    const path = url.split('?')[0]!;
    if (path === '/api/channels/tree') return json({ nodes: opts.nodes, truncated: false });
    if (path === '/api/accounts/me') return json({ is_platform_admin: !!opts.platformAdmin });
    let m = /^\/api\/spaces\/([^/]+)\/lectures$/.exec(path);
    if (m && method === 'GET') return json({ items: lectures, next_cursor: null });
    if (m && method === 'POST') return json(lecture({ id: 'Lnew', title: (body as { title: string }).title, status: 'draft', versions: [] }));
    m = /^\/api\/spaces\/([^/]+)\/lectures\/([^/]+)$/.exec(path);
    if (m) {
      const l = lectures.find((x) => x.id === m![2]);
      return l ? json(l) : json({ error: { code: 'NOT_FOUND', message: 'غير موجود' } }, 404);
    }
    if (/\/versions\/[^/]+\/publish$/.test(path)) {
      const b = body as { preview?: boolean };
      if (b.preview) return json({ lecture_id: 'L1', version: { id: 'v1', version_no: 1, page_count: 12 }, previous: null, changes: null, holders: { value: null, label_ar: 'أقل من 5' } });
      return json({ head_version_id: 'v1', page_map_job_id: null, holders: { value: 0, label_ar: '0' } });
    }
    if (/\/lectures\/[^/]+\/approve$/.test(path)) return json(lectures[0]);
    if (/\/lectures\/[^/]+\/upload$/.test(path)) {
      if (failures > 0) {
        failures--;
        return json({ error: { code: 'UNSUPPORTED_FORMAT', message: 'نوع الملف غير مدعوم.' } }, 415);
      }
      return json({ version_id: 'vnew', job_id: 'j1' });
    }
    if (/\/lectures\/[^/]+\/withdraw$/.test(path)) return json({ ...lectures[0], status: 'withdrawn' });
    if (/\/subject\/corrections$/.test(path)) return json({ corrections: opts.corrections ?? [] });
    if (/\/corrections\/[^/]+\/decide$/.test(path)) return json({ ...CORRECTION, status: 'queued' });
    if (/\/subject\/duplicates$/.test(path)) return json(opts.duplicates ?? { groups: [], checked: { versions: 0, fingerprinted: 0 } });
    return json({ error: { code: 'NOT_FOUND', message: 'غير موجود' } }, 404);
  });
  return calls;
}

function mount(el: React.ReactElement, path = '/admin/official') {
  const router = createMemoryRouter([{ path: '/admin/:section', element: el }], { initialEntries: [path] });
  return render(
    <ToastProvider>
      <RouterProvider router={router} />
    </ToastProvider>,
  );
}

afterEach(() => setFetchImpl(null));

describe('registration through P1-T4’s section registry', () => {
  it('registers «المحتوى الرسمي» and «الملفات المكررة» (not «الملفات والمواعيد», whose screen is not built); the admin sections add no route of their own', async () => {
    // step 2 added the official lecture page, step 3 the publication page (test/copies/wave2-step0-routes.test.ts); the
    // sections live at /admin/:section
    expect(lecturesRoutes.shell?.map((r) => r.path)).toEqual(['subjects/:spaceId/lectures/:lectureId', 'subjects/:spaceId/publications/:publicationId']);
    const mine = adminSections().filter((s) => s.owner === 'P1-T5');
    expect(mine.map((s) => [s.id, s.path, s.title_ar])).toEqual([
      ['official', '/admin/official', 'المحتوى الرسمي'],
      ['duplicates', '/admin/duplicates', 'الملفات المكررة'],
    ]);
    for (const s of mine) expect(typeof (await s.lazy()).Component).toBe('function');
    // the menu: a contributor sees the official content only; a Subject Moderator both; an Assistant neither (Q5)
    const ids = (roles: ChannelRole[]) => visibleAdminSections({ roles, isPlatformAdmin: false }).filter((s) => s.owner === 'P1-T5').map((s) => s.id);
    expect(ids(['contributor'])).toEqual(['official']);
    expect(ids(['subject_moderator'])).toEqual(['official', 'duplicates']);
    expect(ids(['assistant'])).toEqual([]);
  });
});

describe('«المحتوى الرسمي»', () => {
  it('a Subject Moderator approves, previews and publishes a contributor’s version (holders under 5 never shown as a number)', async () => {
    const calls = serve({ nodes: [node('s1', 'التشريح', ['subject_moderator'])], lectures: [lecture(), PUBLISHED] });
    mount(<OfficialContentSection />);
    await screen.findByRole('heading', { level: 1, name: 'المحتوى الرسمي' });
    expect(await screen.findByText('التشريح')).toBeTruthy(); // «نطاقك: التشريح»
    const waiting = await screen.findByRole('region', { name: 'بانتظار الموافقة أو النشر' });
    expect(waiting.textContent).toContain('المحاضرة 3 — الجهاز الهضمي');
    expect(within(waiting).getByText('بانتظار موافقة المشرف')).toBeTruthy();

    fireEvent.click(within(waiting).getByRole('button', { name: 'وافق' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === '/api/spaces/sp_s1/lectures/L1/approve')).toBe(true));

    fireEvent.click(within(waiting).getByRole('button', { name: /انشر الإصدار 1/ }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/هذا أول إصدار رسمي للمحاضرة/)).toBeTruthy();
    expect(within(dialog).getByText(/أقل من 5/)).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText(/ملاحظة التغيير/), { target: { value: 'النسخة النهائية' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'انشر للطلاب' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST' && c.url === '/api/spaces/sp_s1/lectures/L1/versions/v1/publish' && !(c.body as { preview?: boolean }).preview)?.body).toEqual({ change_note: 'النسخة النهائية' }),
    );
    expect(calls.find((c) => (c.body as { preview?: boolean } | null)?.preview)?.body).toEqual({ preview: true });
  });

  it('a moderator’s own draft needs no approval: no «وافق», only publish', async () => {
    serve({ nodes: [node('s1', 'التشريح', ['subject_moderator'])], lectures: [lecture({ status: 'draft', uploaded_by: user('u_m', 'مشرف المادة') })] });
    mount(<OfficialContentSection />);
    expect(await screen.findByRole('button', { name: /انشر الإصدار 1/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'وافق' })).toBeNull();
  });

  it('publishing waits for the file’s processing: the button is disabled and says why', async () => {
    serve({ nodes: [node('s1', 'التشريح', ['subject_moderator'])], lectures: [lecture({ versions: [version({ processing_status: 'processing' })] })] });
    mount(<OfficialContentSection />);
    const btn = await screen.findByRole('button', { name: /انشر الإصدار 1/ });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    expect(btn.getAttribute('aria-describedby')).toBe('wait-L1');
    expect(screen.getByText('يُتاح النشر بعد انتهاء معالجة الملف.')).toBeTruthy();
  });

  it('a Contributor adds a lecture with its file; no approve / publish / withdraw control and no corrections queue', async () => {
    const own = lecture({ status: 'in_review' });
    const calls = serve({ nodes: [node('s1', 'التشريح', ['contributor'])], lectures: [own, PUBLISHED] });
    mount(<OfficialContentSection />);
    await screen.findByRole('region', { name: 'مسوداتي' });
    expect(screen.queryByRole('button', { name: 'وافق' })).toBeNull();
    expect(screen.queryByRole('button', { name: /انشر الإصدار/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'اسحب' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'تصحيحات مقترحة' })).toBeNull();
    expect(calls.some((c) => c.url.includes('/subject/corrections'))).toBe(false);
    expect(screen.getByText(/ملفك يصل إلى مشرف المادة/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/عنوان المحاضرة/), { target: { value: 'الكبد' } });
    fireEvent.change(screen.getByLabelText(/رقم المحاضرة/), { target: { value: '4a' } });
    const file = new File([new Uint8Array([37, 80, 68, 70])], 'liver.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByLabelText(/ملف المحاضرة/), { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: 'أضف وارفع الملف' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === '/api/spaces/sp_s1/lectures/Lnew/upload')).toBe(true));
    expect(calls.find((c) => c.method === 'POST' && c.url === '/api/spaces/sp_s1/lectures')?.body).toEqual({ title: 'الكبد', lecture_no: 4, held_on: null });
    const up = calls.find((c) => c.url.endsWith('/upload'))!;
    expect(up.body).toBeInstanceOf(FormData);
    expect(((up.body as FormData).get('file') as File).name).toBe('liver.pdf');
  });

  it('review R12: a file refused after the draft was created is re-sent into the SAME draft (no second lecture)', async () => {
    const calls = serve({ nodes: [node('s1', 'التشريح', ['subject_moderator'])], lectures: [], uploadFailures: 1 });
    const uploads = () => calls.filter((c) => c.url === '/api/spaces/sp_s1/lectures/Lnew/upload').length;
    mount(<OfficialContentSection />);
    fireEvent.change(await screen.findByLabelText(/عنوان المحاضرة/), { target: { value: 'الكلية' } });
    fireEvent.change(screen.getByLabelText(/ملف المحاضرة/), { target: { files: [new File([new Uint8Array([1, 2, 3])], 'kidney.bin')] } });
    fireEvent.click(screen.getByRole('button', { name: 'أضف وارفع الملف' }));
    expect(await screen.findByText(/أُضيفت المسودة «الكلية» لكن رفع الملف لم يكتمل/)).toBeTruthy();
    expect(screen.getByText(/نوع الملف غير مدعوم/)).toBeTruthy();
    // the same form again: the file goes into the draft already created
    fireEvent.change(screen.getByLabelText(/ملف المحاضرة/), { target: { files: [new File([new Uint8Array([37, 80, 68, 70])], 'kidney.pdf', { type: 'application/pdf' })] } });
    fireEvent.click(screen.getByRole('button', { name: 'ارفع الملف إلى المسودة' }));
    await waitFor(() => expect(uploads()).toBe(2));
    expect(calls.filter((c) => c.method === 'POST' && c.url === '/api/spaces/sp_s1/lectures')).toHaveLength(1);
    expect(await screen.findByRole('button', { name: 'أضف مسودة' })).toBeTruthy(); // the form is clear again
  });

  it('review R1: withdrawing a draft that was never published says students never saw it', async () => {
    serve({ nodes: [node('s1', 'التشريح', ['subject_moderator'])], lectures: [lecture()] });
    mount(<OfficialContentSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'اسحب' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/لم تُنشر هذه المحاضرة؛ لا يراها الطلاب/)).toBeTruthy();
  });

  it('a rights takedown asks for the typed word «حذف» and states that students’ notes stay', async () => {
    const calls = serve({ nodes: [node('s1', 'التشريح', ['subject_moderator'])], lectures: [PUBLISHED] });
    mount(<OfficialContentSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'اسحب' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.change(within(dialog).getByLabelText('السبب'), { target: { value: 'rights_takedown' } });
    expect(within(dialog).getByText(/تبقى ملاحظات الطلاب وحبرهم في نسخهم/)).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText(/ما يراه الطلاب/), { target: { value: 'بطلب دار النشر' } });
    const confirm = within(dialog).getByRole('button', { name: 'اسحب واحذف الملفات' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    const typed = within(dialog).getAllByRole('textbox').at(-1)!;
    fireEvent.change(typed, { target: { value: 'حذف' } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(calls.find((c) => c.url === '/api/spaces/sp_s1/lectures/L2/withdraw')?.body).toEqual({ reason: 'rights_takedown', note_ar: 'بطلب دار النشر' }));
  });

  it('a withdrawal without a reason for students is not sent', async () => {
    const calls = serve({ nodes: [node('s1', 'التشريح', ['subject_moderator'])], lectures: [PUBLISHED] });
    mount(<OfficialContentSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'اسحب' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'اسحب المحاضرة' }));
    expect(await within(dialog).findByText('اكتب سطرًا يشرح السبب للطلاب.')).toBeTruthy();
    expect(calls.some((c) => c.url.endsWith('/withdraw'))).toBe(false);
  });

  it('a moderator accepts a contributor’s correction (a new official version is created by the server)', async () => {
    const calls = serve({ nodes: [node('s1', 'التشريح', ['subject_moderator'])], lectures: [PUBLISHED], corrections: [CORRECTION] });
    mount(<OfficialContentSection />);
    const region = await screen.findByRole('region', { name: 'تصحيحات مقترحة' });
    expect(await within(region).findByText('Mitral valve has 2 cusps')).toBeTruthy();
    expect(within(region).getByText(/صفحة 5/)).toBeTruthy();
    fireEvent.click(within(region).getByRole('button', { name: 'اقبل وانشر إصدارًا مصححًا' }));
    await waitFor(() => expect(calls.find((c) => c.url === '/api/spaces/sp_s1/lectures/L2/corrections/c1/decide')?.body).toEqual({ decision: 'accept' }));
    expect(calls.find((c) => c.url.includes('/subject/corrections'))?.url).toContain('status=open');
  });

  it('several subjects: a chooser; an Assistant-only subject and a subject without a bindable space are not listed', async () => {
    serve({
      nodes: [node('s1', 'التشريح', ['subject_moderator']), node('s2', 'الفسلجة', ['contributor']), node('s3', 'الكيمياء', ['assistant']), node('s4', 'الأحياء', ['subject_moderator'], null)],
      lectures: [],
    });
    mount(<OfficialContentSection />);
    const select = (await screen.findByLabelText('المادة')) as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(['التشريح', 'الفسلجة']);
  });

  it('no subject with an official role: an explanation, no form', async () => {
    serve({ nodes: [node('s3', 'الكيمياء', ['assistant'])] });
    mount(<OfficialContentSection />);
    expect(await screen.findByText('لا توجد مادة تدير محتواها الرسمي')).toBeTruthy();
    expect(screen.queryByLabelText(/عنوان المحاضرة/)).toBeNull();
  });

  it('structure: one h1, named regions, every button named, RTL root, no inline colours (axe-core is not installed)', async () => {
    serve({ nodes: [node('s1', 'التشريح', ['subject_moderator'])], lectures: [lecture(), PUBLISHED], corrections: [CORRECTION] });
    const { container } = mount(<OfficialContentSection />);
    await screen.findByRole('region', { name: 'تصحيحات مقترحة' });
    expect(container.querySelectorAll('h1')).toHaveLength(1);
    expect(container.querySelector('.lec-admin')?.getAttribute('dir')).toBe('rtl');
    for (const b of screen.getAllByRole('button')) expect((b.textContent ?? b.getAttribute('aria-label') ?? '').trim()).not.toBe('');
    for (const input of container.querySelectorAll('input, textarea, select')) {
      const id = input.getAttribute('id');
      const labelled = (id && container.querySelector(`label[for="${id}"]`)) || input.closest('label') || input.getAttribute('aria-label');
      expect(labelled, `unlabelled ${input.outerHTML}`).toBeTruthy();
    }
    expect(container.querySelector('[style*="color"]')).toBeNull();
  });
});

describe('«الملفات المكررة»', () => {
  const DUPS: SubjectDuplicatesResponse = {
    groups: [
      {
        kind: 'identical',
        similarity: 1,
        basis_ar: 'الملفات نفسها بايتًا ببايت',
        items: [
          { type: 'lecture', id: 'L1', title: 'القلب', status: 'published', version: { id: 'v1', version_no: 1, file_name: 'heart.pdf', page_count: 20 } },
          { type: 'attachment', id: 'A1', title: 'ملخص القلب', status: 'draft', version: { id: 'v2', version_no: 1, file_name: 'heart (1).pdf', page_count: 20 } },
        ],
      },
      {
        kind: 'near',
        similarity: 0.75,
        basis_ar: '15 من 20 صفحة متطابقة النص',
        items: [
          { type: 'lecture', id: 'L2', title: 'الصمامات', status: 'published', version: { id: 'v3', version_no: 2, file_name: 'valves.pdf', page_count: 20 } },
          { type: 'lecture', id: 'L3', title: 'الصمامات (قديم)', status: 'withdrawn', version: { id: 'v4', version_no: 1, file_name: 'valves-old.pdf', page_count: 18 } },
        ],
      },
    ],
    checked: { versions: 6, fingerprinted: 5 },
  };

  it('lists identical and near-duplicate groups of the subject with an honest coverage line', async () => {
    const calls = serve({ nodes: [node('s1', 'التشريح', ['subject_moderator'])], duplicates: DUPS });
    mount(<DuplicatesSection />, '/admin/duplicates');
    await screen.findByRole('heading', { level: 1, name: 'الملفات المكررة' });
    const identical = await screen.findByRole('region', { name: 'ملفات متطابقة' });
    expect(within(identical).getByText('ملخص القلب')).toBeTruthy();
    expect(within(identical).getByText(/مرفق · الإصدار 1 · مسودة/)).toBeTruthy();
    const near = screen.getByRole('region', { name: 'ملفات متشابهة' });
    expect(within(near).getByText('متشابهة 75٪')).toBeTruthy();
    expect(within(near).getByText(/60٪/)).toBeTruthy();
    expect(document.querySelector('.lec-admin__coverage')?.textContent).toMatch(/قورن 6 ملفًا في هذه المادة فقط؛ 1 منها لم تكتمل بصمات صفحاتها/);
    expect(calls.filter((c) => c.url.startsWith('/api/spaces/')).map((c) => c.url)).toEqual(['/api/spaces/sp_s1/subject/duplicates']);
  });

  it('a Contributor-only viewer has no subject here (the server answers 403 to them anyway)', async () => {
    const calls = serve({ nodes: [node('s2', 'الفسلجة', ['contributor'])] });
    mount(<DuplicatesSection />, '/admin/duplicates');
    expect(await screen.findByText('لا توجد مادة تدير محتواها الرسمي')).toBeTruthy();
    expect(calls.some((c) => c.url.includes('/subject/duplicates'))).toBe(false);
  });

  it('no duplicates: says so, with the coverage line', async () => {
    serve({ nodes: [node('s1', 'التشريح', ['admin'])], duplicates: { groups: [], checked: { versions: 3, fingerprinted: 3 } } });
    mount(<DuplicatesSection />, '/admin/duplicates');
    expect(await screen.findByText('لا توجد ملفات مكررة')).toBeTruthy();
    expect(document.querySelector('.lec-admin__coverage')?.textContent).toBe('قورن 3 ملفًا في هذه المادة فقط.');
  });
});
