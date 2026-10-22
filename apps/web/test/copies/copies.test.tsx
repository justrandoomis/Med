// P1-T5 step 2 — study copies in the web app: the official lecture page with «ابدأ الدراسة» (PRD AOS-2.17–2.19, 4.1),
// the reader's copy bar (my copy's subject / version / official state, «انقل ملاحظاتي تلقائيًا», «موجودة رسميًا» →
// «اربط بالمحاضرة الرسمية», 19H.3) and federated search (scope chips, the subject label of an official hit, where a hit
// opens). Every screen shows what the server answers; the client never decides access.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, MemoryRouter, RouterProvider, useLocation } from 'react-router-dom';
import type { DocumentCopyView, OfficialLectureDetail, OfficialLinkCandidate, SearchResponse, SearchResult } from '@medlevo/shared';
import { ToastProvider } from '../../src/design';
import { setFetchImpl } from '../../src/lib/api';
import { routes as lecturesRoutes } from '../../src/features/lectures/routes';
import { StudyCopyBar } from '../../src/features/workspace/copies/StudyCopyBar';
import { ResultItem, resultHref } from '../../src/features/search/SearchScreen';

vi.mock('../../src/lib/capabilities', () => ({ useCapabilities: () => ({ feature: () => ({ available: false, reason: 'غير متاح' }) }) }));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const NOT_FOUND = { error: { code: 'NOT_FOUND', message: 'هذه المحاضرة غير موجودة.' } };

function lecture(over: Partial<OfficialLectureDetail> = {}): OfficialLectureDetail {
  return {
    id: 'L1',
    space_id: 'SPA',
    subject: { id: 'S1', kind: 'subject', title: 'التشريح' },
    title: 'Renal anatomy',
    lecture_no: 4,
    lecture_no_origin: 'moderator',
    held_on: null,
    status: 'published',
    head_version: { id: 'V2', version_no: 2, page_count: 40, processing_status: 'ready' },
    uploaded_by: { id: 'u_m', display_name: 'المشرف', avatar_url: null },
    approved: null,
    counts: { explanations: 0 },
    updated_at: 1,
    versions: [
      { id: 'V2', version_no: 2, kind: 'upload', status: 'published', file_name: 'b.pdf', page_count: 40, processing_status: 'ready', published_at: Date.UTC(2026, 9, 2), published_by: null, change_note: 'تصحيح الشكل 3', previous_version_id: 'V1', page_map_status: 'ready' },
      { id: 'V1', version_no: 1, kind: 'upload', status: 'superseded', file_name: 'a.pdf', page_count: 40, processing_status: 'ready', published_at: Date.UTC(2026, 9, 1), published_by: null, change_note: null, previous_version_id: null, page_map_status: null },
    ],
    withdrawn: null,
    ...over,
  } as OfficialLectureDetail;
}

function copy(over: Partial<DocumentCopyView> = {}): DocumentCopyView {
  return {
    id: 'C1',
    mode: 'personal',
    source_id: 'SRC1',
    document_key: 'source:SRC1',
    lecture: { space_id: 'SPA', lecture_id: 'L1', subject: { id: 'S1', kind: 'subject', title: 'التشريح' }, title: 'Renal anatomy', version_id: 'V2', version_no: 2 },
    publication: null,
    personal_layer_id: 'LAY',
    copied_layer_id: null,
    collab_doc_id: null,
    update_policy: 'preview',
    reanchor_policy: 'preview',
    pending_version_no: null,
    newer_official_version: null,
    official: { status: 'published', withdrawn: null, file_removed: false, note_ar: null },
    created_at: 1,
    updated_at: 1,
    ...over,
  };
}

const CANDIDATE: OfficialLinkCandidate = {
  space_id: 'SPA',
  subject: { id: 'S1', kind: 'subject', title: 'التشريح' },
  lecture_id: 'L1',
  title: 'Renal anatomy',
  version_id: 'V2',
  version_no: 2,
  basis: 'fingerprints',
  matched_pages: 38,
  total_pages: 40,
  basis_ar: ['تطابق 38 صفحة من 40'],
};

interface Call {
  method: string;
  url: string;
  body: unknown;
}
function serve(handler: (method: string, path: string, body: unknown, url: string) => Response | undefined): Call[] {
  const calls: Call[] = [];
  setFetchImpl(async (url, init) => {
    const method = (init.method ?? 'GET').toUpperCase();
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : init.body;
    calls.push({ method, url, body });
    return handler(method, url.split('?')[0]!, body, url) ?? json({ error: { code: 'NOT_FOUND', message: 'غير موجود' } }, 404);
  });
  return calls;
}

function Where() {
  const loc = useLocation();
  return <p data-testid="where">{`${loc.pathname}${loc.search}`}</p>;
}

function renderLecturePage(path = '/subjects/SPA/lectures/L1') {
  const router = createMemoryRouter(
    [
      ...lecturesRoutes.shell!,
      { path: 'study/:sourceId', element: <Where /> },
    ],
    { initialEntries: [path] },
  );
  render(
    <ToastProvider>
      <RouterProvider router={router} />
    </ToastProvider>,
  );
  return router;
}

afterEach(() => {
  setFetchImpl(null);
});

describe('the official lecture page', () => {
  it('a member who does not study it yet: «ابدأ الدراسة» creates the copy with ONE client id and opens the reader at the page', async () => {
    let started = 0;
    const calls = serve((method, path) => {
      if (path === '/api/spaces/SPA/lectures/L1') return json(lecture());
      if (path === '/api/copies' && method === 'GET') return json({ copies: [] });
      if (path === '/api/copies' && method === 'POST') {
        started++;
        // the first answer is lost on the way back (a flaky network): the retry reuses the same id
        if (started === 1) return json({ error: { code: 'INTERNAL', message: 'تعذّر الحفظ الآن. حاول مرة أخرى.' } }, 500);
        return json({ copy: copy(), created: true, job_id: null });
      }
      if (path === '/api/copies/C1' && method === 'PATCH') return json(copy({ reanchor_policy: 'auto' }));
      return undefined;
    });
    const router = renderLecturePage('/subjects/SPA/lectures/L1?page=7');
    expect(await screen.findByRole('heading', { level: 1, name: 'Renal anatomy' })).toBeTruthy();
    expect(screen.getByText('التشريح')).toBeTruthy();
    expect(screen.getByText('الإصدار 2 · 40 صفحة')).toBeTruthy();
    // published versions with the current one marked, in the «الرسمي» tab; «الشروحات» exists since step 3 (publications)
    expect(screen.getByText('تصحيح الشكل 3')).toBeTruthy();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['الرسمي', 'الشروحات']);
    expect(screen.getByRole('tab', { name: 'الرسمي' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'ابدأ الدراسة' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/موادي من القنوات/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /انقل ملاحظاتي تلقائيًا/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'ابدأ الدراسة' }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain('تعذّر الحفظ الآن');
    fireEvent.click(within(dialog).getByRole('button', { name: 'ابدأ الدراسة' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/study/SRC1'));
    expect(router.state.location.search).toBe('?page=7');
    const posts = calls.filter((c) => c.method === 'POST' && c.url === '/api/copies').map((c) => c.body as { id: string; mode: string; space_id: string; lecture_id: string });
    expect(posts).toHaveLength(2);
    expect(posts[0]!.id).toBe(posts[1]!.id);
    expect(posts[0]).toMatchObject({ mode: 'personal', space_id: 'SPA', lecture_id: 'L1' });
    // the «auto» preference is the copy's real reanchor_policy, saved on the server
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ reanchor_policy: 'auto' });
  });

  it('a student who already studies it gets «افتح نسختي» (no second copy)', async () => {
    const calls = serve((method, path) => {
      if (path === '/api/spaces/SPA/lectures/L1') return json(lecture());
      if (path === '/api/copies' && method === 'GET') return json({ copies: [copy()] });
      return undefined;
    });
    renderLecturePage();
    const open = await screen.findByRole('link', { name: 'افتح نسختي' });
    expect(open.getAttribute('href')).toBe('/study/SRC1');
    expect(screen.queryByRole('button', { name: 'ابدأ الدراسة' })).toBeNull();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('a withdrawn lecture says why, keeps the copy, and offers no «ابدأ الدراسة»', async () => {
    serve((method, path) => {
      if (path === '/api/spaces/SPA/lectures/L1') return json(lecture({ status: 'withdrawn', withdrawn: { reason: 'error', note_ar: 'أُعيد رفعها بعد التصحيح.', at: 1 } }));
      if (path === '/api/copies') return json({ copies: [copy()] });
      return undefined;
    });
    renderLecturePage();
    expect((await screen.findByRole('note')).textContent).toContain('أُعيد رفعها بعد التصحيح. نسختك وملاحظاتك عليها باقية في مكتبتك.');
    expect(screen.queryByRole('button', { name: 'ابدأ الدراسة' })).toBeNull();
    expect(screen.getByRole('link', { name: 'افتح نسختي' })).toBeTruthy();
  });

  it('a lecture the viewer may not see shows the server’s «not found» message, nothing else', async () => {
    serve((method, path) => (path === '/api/spaces/SPA/lectures/L1' ? json(NOT_FOUND, 404) : path === '/api/copies' ? json({ copies: [] }) : undefined));
    renderLecturePage();
    expect(await screen.findByText('هذه المحاضرة غير موجودة.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'ابدأ الدراسة' })).toBeNull();
  });
});

describe('review P1-T5 s2', () => {
  it('R-H: offline, «ابدأ الدراسة» is disabled AND says why (no silent dead control)', async () => {
    serve((method, path) => (path === '/api/spaces/SPA/lectures/L1' ? json(lecture()) : path === '/api/copies' ? json({ copies: [] }) : undefined));
    renderLecturePage();
    expect(await screen.findByRole('heading', { level: 1, name: 'Renal anatomy' })).toBeTruthy();
    const spy = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    try {
      fireEvent(window, new Event('offline'));
      const button = await screen.findByRole('button', { name: 'ابدأ الدراسة' });
      await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(true));
      const reason = screen.getAllByRole('status').find((n) => n.textContent?.includes('بدء الدراسة يحتاج الخادم'));
      expect(reason).toBeTruthy();
      expect(button.getAttribute('aria-describedby')).toBe(reason!.id);
    } finally {
      spy.mockRestore();
      fireEvent(window, new Event('online'));
    }
  });

  it('R-C → C2 (X8 c): after a link, what could not be copied waits in the review list of the official copy, one tap away', async () => {
    serve((method, path) => {
      if (path === '/api/copies' && method === 'GET') return json({ copies: [] });
      if (path === '/api/copies/link-candidates') return json({ source_id: 'SRC1', candidates: [CANDIDATE] });
      if (path === '/api/copies/link' && method === 'POST')
        return json({ copy: copy({ id: 'C9', source_id: 'OFFICIAL_SRC' }), job_id: null, summary: { total: 2, copied: 1, needs_review: 1, kept: 0, summary_ar: 'نُسخ عنصر واحد إلى النسخة الرسمية.', note_pages: { total: 1, copied: 1, items: 2 } } });
      return undefined;
    });
    render(
      <ToastProvider>
        <MemoryRouter initialEntries={['/study/SRC1']}>
          <StudyCopyBar sourceId="SRC1" sourceType="lecture" online />
          <Where />
        </MemoryRouter>
      </ToastProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'اربط بالنسخة الرسمية…' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'اربط وانسخ ملاحظاتي' }));
    expect(await screen.findByText(/تجده في «ملاحظاتي ← إعادة ربط» في النسخة الرسمية/)).toBeTruthy();
    expect(screen.getByText(/ينتظر مراجعتك \(تغيّرت صفحته\)/)).toBeTruthy();
    expect(screen.getByText(/من 1 صفحة ملاحظات مضافة نُسخت بما عليها/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'راجع ما لم يُنسخ' }));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/study/OFFICIAL_SRC?panel=review'));
  });
});

describe('the reader’s copy bar', () => {
  const renderBar = (sourceType: 'lecture' | 'course_reference' = 'lecture', online = true) =>
    render(
      <ToastProvider>
        <MemoryRouter initialEntries={['/study/SRC1']}>
          <StudyCopyBar sourceId="SRC1" sourceType={sourceType} online={online} />
          <Where />
        </MemoryRouter>
      </ToastProvider>,
    );

  it('my copy: subject and version, «انقل ملاحظاتي تلقائيًا» saved on the server, the lecture page link', async () => {
    const calls = serve((method, path) => {
      if (path === '/api/copies' && method === 'GET') return json({ copies: [copy()] });
      if (path === '/api/copies/C1' && method === 'PATCH') return json(copy({ reanchor_policy: 'auto' }));
      return undefined;
    });
    renderBar();
    expect(await screen.findByText('نسختي · التشريح · الإصدار 2')).toBeTruthy();
    const sw = screen.getByRole('switch', { name: /انقل ملاحظاتي تلقائيًا/ });
    expect(sw.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(sw);
    await waitFor(() => expect(screen.getByRole('switch', { name: /انقل ملاحظاتي تلقائيًا/ }).getAttribute('aria-checked')).toBe('true'));
    expect(calls.find((c) => c.method === 'PATCH')).toMatchObject({ url: '/api/copies/C1', body: { reanchor_policy: 'auto' } });
    expect(screen.getByRole('link', { name: 'صفحة المحاضرة' }).getAttribute('href')).toBe('/subjects/SPA/lectures/L1');
    // a copy never asks for link candidates
    expect(calls.some((c) => c.url.startsWith('/api/copies/link-candidates'))).toBe(false);
  });

  it('a withdrawn official lecture is said in words; no switch that would do nothing', async () => {
    serve((method, path) =>
      path === '/api/copies'
        ? json({ copies: [copy({ official: { status: 'withdrawn', withdrawn: { reason: 'other', note_ar: 'x', at: 1 }, file_removed: false, note_ar: 'سحب المشرف هذه المحاضرة؛ نسختك وملاحظاتك باقية.' } })] })
        : undefined,
    );
    renderBar();
    expect(await screen.findByText('سُحبت المحاضرة الرسمية')).toBeTruthy();
    expect(screen.getByText('سحب المشرف هذه المحاضرة؛ نسختك وملاحظاتك باقية.')).toBeTruthy();
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('a private lecture that exists officially: «موجودة رسميًا» → link: the items are COPIED, the private file stays', async () => {
    const calls = serve((method, path) => {
      if (path === '/api/copies' && method === 'GET') return json({ copies: [] });
      if (path === '/api/copies/link-candidates') return json({ source_id: 'SRC1', candidates: [CANDIDATE] });
      if (path === '/api/copies/link' && method === 'POST')
        return json({ copy: copy({ id: 'C9', source_id: 'OFFICIAL_SRC' }), job_id: null, summary: { total: 5, copied: 3, needs_review: 1, kept: 1, summary_ar: 'نُسخ 3 من 5 عناصر.' } });
      return undefined;
    });
    renderBar('lecture');
    expect(await screen.findByText('موجودة رسميًا في التشريح')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'اربط بالنسخة الرسمية…' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/يبقى ملفك الخاص وكل ما كتبته عليه كما هو/)).toBeTruthy();
    expect(within(dialog).getByText('تطابق 38 صفحة من 40')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'اربط وانسخ ملاحظاتي' }));
    expect(await screen.findByText('نُسخ 3 من 5 عناصر.')).toBeTruthy();
    const post = calls.find((c) => c.url === '/api/copies/link')!.body as Record<string, string>;
    expect(post).toMatchObject({ source_id: 'SRC1', space_id: 'SPA', lecture_id: 'L1', to_version_id: 'V2' });
    expect(post.id).toMatch(/^[0-9A-Z]{26}$/);
    fireEvent.click(screen.getByRole('button', { name: 'افتح النسخة الرسمية' }));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/study/OFFICIAL_SRC'));
  });

  it('nothing to say (no copy, no official twin, not a lecture) or offline: no bar at all', async () => {
    const calls = serve((method, path) => (path === '/api/copies' ? json({ copies: [] }) : path === '/api/copies/link-candidates' ? json({ source_id: 'SRC1', candidates: [] }) : undefined));
    const { container, unmount } = renderBar('course_reference');
    await waitFor(() => expect(calls.length).toBe(1));
    expect(container.querySelector('.cp-bar')).toBeNull();
    expect(calls.some((c) => c.url.startsWith('/api/copies/link-candidates'))).toBe(false); // only lectures are matched
    unmount();
    const before = calls.length;
    const off = renderBar('lecture', false);
    expect(off.container.querySelector('.cp-bar')).toBeNull();
    expect(calls.length).toBe(before);
  });
});

describe('federated search in the web', () => {
  const hit = (inLibrary: boolean): SearchResult =>
    ({
      type: 'chunks',
      id: 'CH1',
      title: 'Renal anatomy › Blood supply',
      snippet: { text: 'the renal artery arises', highlights: [] },
      location: { source_id: 'SRC1', version_id: 'V2', page_id: 'P8', page_index: 7, page_label_ar: 'ص 8', region_id: 'R1' },
      origin: 'source',
      source_type: 'lecture',
      source_title: 'Renal anatomy',
      is_evidence: false,
      db: { kind: 'space', space_id: 'SPA', subject: { id: 'S1', kind: 'subject', title: 'التشريح' }, lecture_id: 'L1', in_library: inLibrary },
    }) as SearchResult;

  it('an official hit is labelled with its subject; it opens the reader only when I study the lecture, else the lecture page', () => {
    expect(resultHref(hit(true))).toMatch(/^\/study\/SRC1\?v=V2&page=7/);
    expect(resultHref(hit(false))).toBe('/subjects/SPA/lectures/L1?page=7');
    render(
      <MemoryRouter>
        <ul>
          <ResultItem r={hit(false)} />
        </ul>
      </MemoryRouter>,
    );
    expect(screen.getByText('رسمي · التشريح')).toBeTruthy();
    expect(screen.getByRole('link').getAttribute('href')).toBe('/subjects/SPA/lectures/L1?page=7');
  });

  it('the scope chips send `scope`; «موادي الرسمية» is kept in the URL', async () => {
    const { SearchScreen } = await import('../../src/features/search/SearchScreen');
    const response: SearchResponse = { query: 'renal', mode: 'keyword', results: [hit(false)], next_cursor: null, exact_rejected: 0, expansions: [], notices_ar: [], searched_types: ['chunks'], searched: { scope: 'all', vault: true, spaces: 1, spaces_truncated: 0 } } as SearchResponse;
    const calls = serve((method, path) => (path === '/api/search' ? json(response) : path === '/api/library/tree' ? json({ nodes: [] }) : undefined));
    const router = createMemoryRouter([{ path: '/search', element: <SearchScreen /> }], { initialEntries: ['/search?q=renal'] });
    render(
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>,
    );
    expect(await screen.findByText('رسمي · التشريح')).toBeTruthy();
    expect(calls.find((c) => c.url.startsWith('/api/search'))!.url).toContain('scope=all');
    fireEvent.click(screen.getByRole('radio', { name: 'موادي الرسمية' }));
    await waitFor(() => expect(router.state.location.search).toContain('scope=subjects'));
    await waitFor(() => expect(calls.filter((c) => c.url.startsWith('/api/search')).at(-1)!.url).toContain('scope=subjects'));
  });
});

describe('copies.css', () => {
  const css = readFileSync(join(__dirname, '..', '..', 'src', 'features', 'copies', 'copies.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  it('colours only from tokens; logical properties only; 44 px targets', () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/\b(rgb|rgba|hsl|hsla)\(/);
    expect(css).not.toMatch(/(?:^|[\s;{])(?:margin|padding|border)-(?:left|right)\b/);
    expect(css).not.toMatch(/(?:^|[\s;{])(?:left|right)\s*:/);
    expect(css).toMatch(/\.cp-candidate\s*\{[^}]*min-block-size:\s*44px/);
    expect(css).toMatch(/\.cp-bar \.ml-btn\s*\{[^}]*min-block-size:\s*44px/);
    expect(css).toMatch(/\.cp-lecture__actions \.ml-btn\s*\{[^}]*min-block-size:\s*44px/);
    // every cp-* class the screens use has a rule
    const used = new Set<string>();
    for (const f of ['copies/StartStudyingDialog.tsx', 'copies/LinkToOfficialDialog.tsx', 'workspace/copies/StudyCopyBar.tsx', 'lectures/LectureScreen.tsx']) {
      for (const m of readFileSync(join(__dirname, '..', '..', 'src', 'features', f), 'utf8').matchAll(/\b(cp-[a-z]+(?:__[a-z-]+)?(?:--[a-z]+)?)\b/g)) used.add(m[1]!);
    }
    expect([...used].filter((c) => !new RegExp(`\\.${c}(?![A-Za-z0-9_-])`).test(css))).toEqual([]);
  });
});
