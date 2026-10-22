// P1-T5 step 3 — course-only explanations in the web app (PRD AOS-2.8 / 5.27 Phase 1 parts, 5.12, 4.14, 21.16, Q14,
// Q25; Scenario 2): the lecture page's «الشروحات» tab, «انشر شرحك» (own layers only, one idempotency key per dialog),
// the publication page (student label, completeness as numbers, built-on version, versions with change notes, previews,
// hidden / withdrawn said in words), «ابدأ الدراسة بهذا الشرح» (follow or fork, auto updates, carry my notes), «أبلغ»,
// the author's republish / withdraw, and the reader's copy bar for a followed copy (update preview → «طبّق التحديث» /
// «تخطَّ هذا الإصدار», «طبّق تحديثات الشرح تلقائيًا», `?copy=` makes that copy's layer the active one).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, MemoryRouter, RouterProvider, useLocation } from 'react-router-dom';
import { endSentenceAr, upstreamSummaryAr, type AnnotationDTO, type DocumentCopyView, type LayerView, type OfficialLectureDetail, type PublicationCard, type PublicationView, type UpstreamPreview } from '@medlevo/shared';
import { ToastProvider } from '../../src/design';
import { setFetchImpl } from '../../src/lib/api';
import { routes as lecturesRoutes } from '../../src/features/lectures/routes';
import { changeMarks, pagePreviews } from '../../src/features/lectures/publicationPreview';
import { marksCaptionAr } from '../../src/features/lectures/PagePreviewFrame';
import { publishableLayers } from '../../src/features/lectures/PublishDialog';
import { StudyCopyBar } from '../../src/features/workspace/copies/StudyCopyBar';
import { LayerViewContext, type LayerViewContextValue } from '../../src/features/workspace/ink/layers/LayerViewProvider';

const syncNow = vi.fn(async () => undefined);
vi.mock('../../src/lib/sync', async (orig) => ({ ...(await orig<typeof import('../../src/lib/sync')>()), getSyncEngine: () => ({ syncNow }) }));
vi.mock('../../src/lib/capabilities', () => ({ useCapabilities: () => ({ feature: () => ({ available: false, reason: 'غير متاح' }) }) }));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const NOT_FOUND = { error: { code: 'NOT_FOUND', message: 'هذا الشرح غير موجود.' } };
const HASAN = { id: 'u_h', display_name: 'حسن', avatar_url: null };
const SUBJECT = { id: 'S1', kind: 'subject' as const, title: 'التشريح' };

function lecture(): OfficialLectureDetail {
  return {
    id: 'L1',
    space_id: 'SPA',
    subject: SUBJECT,
    title: 'Renal anatomy',
    lecture_no: 4,
    lecture_no_origin: 'moderator',
    held_on: null,
    status: 'published',
    head_version: { id: 'V1', version_no: 1, page_count: 40, processing_status: 'ready' },
    uploaded_by: { id: 'u_m', display_name: 'المشرف', avatar_url: null },
    approved: null,
    counts: { explanations: 1 },
    updated_at: 1,
    versions: [{ id: 'V1', version_no: 1, kind: 'upload', status: 'published', file_name: 'a.pdf', page_count: 40, processing_status: 'ready', published_at: Date.UTC(2026, 9, 1), published_by: null, change_note: null, previous_version_id: null, page_map_status: null }],
    withdrawn: null,
  } as OfficialLectureDetail;
}

function pub(over: Partial<PublicationView> = {}, viewer: Partial<PublicationView['viewer']> = {}): PublicationView {
  return {
    id: 'PUB1',
    space_id: 'SPA',
    lecture: { id: 'L1', title: 'Renal anatomy' },
    subject: SUBJECT,
    author: HASAN,
    kind: 'explanation',
    title: 'شرح حسن',
    summary: 'الشرايين الكلوية بالرسم',
    visibility: 'course',
    status: 'active',
    hidden: null,
    head_version_no: 2,
    versions: [
      { no: 1, created_at: Date.UTC(2026, 9, 3), change_note: null, lecture_version_id: 'V1', lecture_version_no: 1, item_count: 6 },
      { no: 2, created_at: Date.UTC(2026, 9, 5), change_note: 'أضفت مخطط الكلية', lecture_version_id: 'V1', lecture_version_no: 1, item_count: 11 },
    ],
    completeness: { pages_covered: 3, pages_total: 40 },
    origin_label_ar: 'شرح طالب — ليس مصدرًا',
    viewer: { copy: null, can_edit: false, source_layer_ids: null, can_report: true, ...viewer },
    snapshot: null,
    published_at: Date.UTC(2026, 9, 3),
    updated_at: Date.UTC(2026, 9, 5),
    ...over,
  };
}

const CARD: PublicationCard = { id: 'PUB1', title: 'شرح حسن', author: HASAN, kind: 'explanation', head_version_no: 2, completeness: { pages_covered: 3, pages_total: 40 }, label_ar: 'شرح طالب — ليس مصدرًا', updated_at: Date.UTC(2026, 9, 5) };

function copy(over: Partial<DocumentCopyView> = {}): DocumentCopyView {
  return {
    id: 'C1',
    mode: 'personal',
    source_id: 'SRC1',
    document_key: 'source:SRC1',
    lecture: { space_id: 'SPA', lecture_id: 'L1', subject: SUBJECT, title: 'Renal anatomy', version_id: 'V1', version_no: 1 },
    publication: null,
    personal_layer_id: 'LAY_DEF',
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

function followed(over: Partial<DocumentCopyView> = {}, p: Partial<NonNullable<DocumentCopyView['publication']>> = {}): DocumentCopyView {
  return copy({
    id: 'C2',
    mode: 'followed',
    personal_layer_id: 'LAY_C2',
    copied_layer_id: 'LAY_F',
    publication: { id: 'PUB1', space_id: 'SPA', title: 'شرح حسن', author: HASAN, applied_version_no: 1, head_version_no: 2, status: 'active', status_note_ar: null, built_on_version_no: 1, pending_built_on_version_no: 1, ...p },
    pending_version_no: 2,
    ...over,
  });
}

function layer(over: Partial<LayerView>): LayerView {
  return { id: 'X', document_key: 'source:SRC1', kind: 'personal', title: 'ملاحظاتي', writable: true, frozen: false, visible: true, locked: false, color: null, sort_order: 0, item_count: 4, is_default: false, access: 'write', origin: null, rev: 1, ...over };
}

const PREVIEW: UpstreamPreview = {
  publication_id: 'PUB1',
  from_version_no: 1,
  to_version_no: 2,
  change_note: 'أضفت مخطط الكلية',
  counts: { added: 6, removed: 1, changed: 1 },
  pages: [{ page: { page_id: 'P3', page_index: 2, label_ar: 'ص 3', thumbnail: true }, added: 6, removed: 1, changed: 1 }],
  personal_items_affected: 0,
  summary_ar: 'أضاف 6 عناصر في صفحة واحدة، حذف 1، عدّل 1',
};

interface Call {
  method: string;
  url: string;
  body: unknown;
  headers: Record<string, string>;
}
function serve(handler: (method: string, path: string, body: unknown, url: string) => Response | undefined): Call[] {
  const calls: Call[] = [];
  setFetchImpl(async (url, init) => {
    const method = (init.method ?? 'GET').toUpperCase();
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : init.body;
    calls.push({ method, url, body, headers: { ...((init.headers as Record<string, string> | undefined) ?? {}) } });
    return handler(method, url.split('?')[0]!, body, url) ?? json({ error: { code: 'NOT_FOUND', message: 'غير موجود' } }, 404);
  });
  return calls;
}

function Where() {
  const loc = useLocation();
  return <p data-testid="where">{`${loc.pathname}${loc.search}`}</p>;
}

function renderAt(path: string) {
  const router = createMemoryRouter([...lecturesRoutes.shell!, { path: 'study/:sourceId', element: <Where /> }], { initialEntries: [path] });
  render(
    <ToastProvider>
      <RouterProvider router={router} />
    </ToastProvider>,
  );
  return router;
}

afterEach(() => {
  setFetchImpl(null);
  syncNow.mockClear();
});

describe('the lecture page’s «الشروحات» tab', () => {
  it('lists the explanations with the student label and numbers; «?tab=explanations» opens it; a card opens the publication page', async () => {
    serve((method, path) => {
      if (path === '/api/spaces/SPA/lectures/L1') return json(lecture());
      if (path === '/api/copies') return json({ copies: [] });
      if (path === '/api/spaces/SPA/lectures/L1/publications') return json({ items: [CARD], next_cursor: null });
      return undefined;
    });
    renderAt('/subjects/SPA/lectures/L1?tab=explanations');
    expect((await screen.findByRole('tab', { name: 'الشروحات' })).getAttribute('aria-selected')).toBe('true');
    expect((await screen.findByRole('note')).textContent).toContain('شروحات الطلاب ليست مصدرًا رسميًا');
    const card = await screen.findByRole('link', { name: /شرح حسن/ });
    expect(card.getAttribute('href')).toBe('/subjects/SPA/publications/PUB1');
    expect(within(card).getByText('شرح طالب — ليس مصدرًا')).toBeTruthy();
    expect(within(card).getByText('الإصدار 2')).toBeTruthy();
    expect(within(card).getByText('ص 3 من 40')).toBeTruthy();
    // a viewer who does not study the lecture is told how to publish; no button that cannot work
    expect(screen.queryByRole('button', { name: 'انشر شرحك' })).toBeNull();
    expect(screen.getByText(/ابدأ دراسة المحاضرة واكتب على نسختك/)).toBeTruthy();
  });

  it('«انشر شرحك»: only the author’s own layers with writing; one idempotency key across a retry; then the publication page', async () => {
    let posts = 0;
    const calls = serve((method, path) => {
      if (path === '/api/spaces/SPA/lectures/L1') return json(lecture());
      if (path === '/api/copies') return json({ copies: [copy()] });
      if (path === '/api/spaces/SPA/lectures/L1/publications') return json({ items: [], next_cursor: null });
      if (path === '/api/annotations/layers')
        return json({
          document_key: 'source:SRC1',
          layers: [
            layer({ id: 'LAY_DEF', is_default: true, item_count: 3 }),
            layer({ id: 'LAY_EXP', kind: 'explanation', title: 'شرحي', item_count: 12 }),
            layer({ id: 'LAY_EMPTY', kind: 'answers', title: 'إجاباتي', item_count: 0 }),
            layer({ id: 'LAY_F', kind: 'followed', title: 'شرح زينب', writable: false, access: 'read_only', item_count: 9 }),
          ],
        });
      if (path === '/api/spaces/SPA/publications' && method === 'POST') {
        posts++;
        if (posts === 1) return json({ error: { code: 'INTERNAL', message: 'تعذّر النشر الآن. حاول مرة أخرى.' } }, 500);
        return json(pub({ id: 'PUB9', head_version_no: 1 }));
      }
      if (path === '/api/spaces/SPA/publications/PUB9') return json(pub({ id: 'PUB9', head_version_no: 1 }, { can_edit: true, can_report: false }));
      return undefined;
    });
    const router = renderAt('/subjects/SPA/lectures/L1?tab=explanations');
    expect(await screen.findByText('لا توجد شروحات منشورة لهذه المحاضرة بعد.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'انشر شرحك' }));
    const dialog = await screen.findByRole('dialog');
    // «شرحي» (an explanation layer) is preselected; the followed layer and the empty one are not offered
    expect((await within(dialog).findByRole('checkbox', { name: /شرحي/ }) as HTMLInputElement).checked).toBe(true);
    expect((within(dialog).getByRole('checkbox', { name: /ملاحظاتي/ }) as HTMLInputElement).checked).toBe(false);
    expect(within(dialog).queryByRole('checkbox', { name: /شرح زينب/ })).toBeNull();
    expect(within(dialog).queryByRole('checkbox', { name: /إجاباتي/ })).toBeNull();
    expect(within(dialog).getByText(/لا تنشر اسم مريض/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'انشر' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe('اكتب عنوانًا للشرح.');
    fireEvent.change(within(dialog).getByRole('textbox', { name: /عنوان الشرح/ }), { target: { value: 'شرح الأوعية الكلوية' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'انشر' }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain('تعذّر النشر الآن');
    fireEvent.click(within(dialog).getByRole('button', { name: 'انشر' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/subjects/SPA/publications/PUB9'));
    const sent = calls.filter((c) => c.method === 'POST' && c.url === '/api/spaces/SPA/publications');
    expect(sent).toHaveLength(2);
    expect(sent[0]!.headers['idempotency-key']).toMatch(/^[0-9A-Z]{26}$/);
    expect(sent[1]!.headers['idempotency-key']).toBe(sent[0]!.headers['idempotency-key']);
    expect(sent[0]!.body).toEqual({ lecture_id: 'L1', layer_ids: ['LAY_EXP'], title: 'شرح الأوعية الكلوية', summary: null, kind: 'explanation', visibility: 'course' });
    expect(calls.find((c) => c.url.startsWith('/api/annotations/layers'))!.url).toContain('document_key=source%3ASRC1');
  });
});

describe('the publication page', () => {
  it('a classmate: label, author, numbers, built-on version, versions, last change, previews; «ابدأ الدراسة بهذا الشرح» follows with auto updates and carries my notes', async () => {
    const items: AnnotationDTO[] = [
      { id: 'a1', kind: 'ink', anchor: { type: 'page', source_id: 'SRCX', version_id: 'V1', page_id: 'P3', page_index: 2, space: 'page_norm' }, data: { v: 1, points: [[0.1, 0.1, 0], [0.2, 0.3, 10]], style: { tool: 'pen', color: '#000', width: 2 }, bbox: { x: 0.1, y: 0.1, w: 0.1, h: 0.2 }, pressure_available: false, tilt_available: false } } as unknown as AnnotationDTO,
    ];
    let started = 0;
    const calls = serve((method, path) => {
      if (path === '/api/spaces/SPA/publications/PUB1') return json(pub());
      if (path === '/api/copies' && method === 'GET') return json({ copies: [copy()] });
      if (path === '/api/spaces/SPA/publications/PUB1/versions/2/items') return json({ publication_id: 'PUB1', version_no: 2, items, notes: [], note_pages: [], redacted: false });
      if (path === '/api/spaces/SPA/publications/PUB1/diff') return json({ ...PREVIEW });
      if (path === '/api/copies' && method === 'POST') {
        started++;
        return json({ copy: followed({ pending_version_no: null }, { applied_version_no: 2 }), created: true, job_id: null });
      }
      if (path === '/api/copies/C2' && method === 'PATCH') return json(followed({ update_policy: 'auto', pending_version_no: null }, { applied_version_no: 2 }));
      return undefined;
    });
    const router = renderAt('/subjects/SPA/publications/PUB1');
    expect(await screen.findByRole('heading', { level: 1, name: 'شرح حسن' })).toBeTruthy();
    expect(screen.getByText('شرح طالب — ليس مصدرًا')).toBeTruthy();
    expect(screen.getByText('بقلم حسن')).toBeTruthy();
    expect(screen.getByText('ص 3 من 40')).toBeTruthy();
    expect(screen.getAllByText('مبني على الإصدار 1 من المحاضرة').length).toBeGreaterThan(0);
    expect(screen.getByText('أضفت مخطط الكلية')).toBeTruthy();
    expect(await screen.findByText('أضاف 6 عناصر في صفحة واحدة، حذف 1، عدّل 1')).toBeTruthy();
    expect(await screen.findByText(/^ص 3 · /)).toBeTruthy();
    expect(document.querySelector('.pb-preview svg path')?.getAttribute('d')).toBe('M0.1 0.1 L0.2 0.3');
    expect(screen.getByRole('link', { name: 'المحاضرة: Renal anatomy' }).getAttribute('href')).toBe('/subjects/SPA/lectures/L1');
    // not the author: no republish / withdraw
    expect(screen.queryByRole('button', { name: 'انشر إصدارًا جديدًا' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'اسحب الشرح' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'ابدأ الدراسة بهذا الشرح' }));
    const dialog = await screen.findByRole('dialog');
    expect((within(dialog).getByRole('radio', { name: /تابِع الشرح/ }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /طبّق التحديثات تلقائيًا/ }));
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /انسخ ملاحظاتي من نسختي إليها/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'ابدأ الدراسة' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/study/SRC1'));
    expect(router.state.location.search).toBe('?copy=C2');
    expect(started).toBe(1);
    const post = calls.find((c) => c.method === 'POST' && c.url === '/api/copies')!.body as Record<string, unknown>;
    expect(post).toMatchObject({ space_id: 'SPA', lecture_id: 'L1', mode: 'followed', publication_id: 'PUB1', carry_personal_from_copy_id: 'C1' });
    expect(calls.find((c) => c.method === 'PATCH')).toMatchObject({ url: '/api/copies/C2', body: { update_policy: 'auto' } });
    // the followed layer's rows are pulled at once
    expect(syncNow).toHaveBeenCalledWith({ pull: true });
  });

  it('a fork takes the current version; no auto option for it', async () => {
    const calls = serve((method, path) => {
      if (path === '/api/spaces/SPA/publications/PUB1') return json(pub());
      if (path === '/api/copies' && method === 'GET') return json({ copies: [] });
      if (path.endsWith('/items')) return json({ publication_id: 'PUB1', version_no: 2, items: [], notes: [], note_pages: [], redacted: false });
      if (path.endsWith('/diff')) return json(PREVIEW);
      if (path === '/api/copies' && method === 'POST') return json({ copy: copy({ id: 'C3', mode: 'independent_fork', copied_layer_id: 'LAY_K' }), created: true, job_id: null });
      return undefined;
    });
    renderAt('/subjects/SPA/publications/PUB1');
    fireEvent.click(await screen.findByRole('button', { name: 'ابدأ الدراسة بهذا الشرح' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('radio', { name: /نسخة مستقلة/ }));
    expect(within(dialog).queryByRole('checkbox', { name: /طبّق التحديثات تلقائيًا/ })).toBeNull();
    // no personal copy: nothing to carry
    expect(within(dialog).queryByRole('checkbox', { name: /انسخ ملاحظاتي/ })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'ابدأ الدراسة' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === '/api/copies')).toBe(true));
    const body = calls.find((c) => c.method === 'POST' && c.url === '/api/copies')!.body as Record<string, unknown>;
    expect(body).toMatchObject({ mode: 'independent_fork', publication_id: 'PUB1' });
    expect(body).not.toHaveProperty('carry_personal_from_copy_id');
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('a holder of a followed copy: «افتح نسختي» and «تحديث متاح» → preview → «طبّق التحديث»', async () => {
    const calls = serve((method, path) => {
      if (path === '/api/spaces/SPA/publications/PUB1') return json(pub({}, { copy: 'followed' }));
      if (path === '/api/copies' && method === 'GET') return json({ copies: [copy(), followed()] });
      if (path.endsWith('/items')) return json({ publication_id: 'PUB1', version_no: 2, items: [], notes: [], note_pages: [], redacted: false });
      if (path.endsWith('/diff')) return json(PREVIEW);
      if (path === '/api/copies/C2/upstream') return json(PREVIEW);
      if (path === '/api/copies/C2/upstream/apply') return json({ copy: followed({ pending_version_no: null }, { applied_version_no: 2 }), skipped: false, applied: { upserted: 7, tombstoned: 1 } });
      return undefined;
    });
    renderAt('/subjects/SPA/publications/PUB1');
    expect((await screen.findByRole('link', { name: 'افتح نسختي' })).getAttribute('href')).toBe('/study/SRC1?copy=C2');
    expect(screen.queryByRole('button', { name: 'ابدأ الدراسة بهذا الشرح' })).toBeNull();
    expect(screen.getByText('تحديث متاح من حسن: الإصدار 2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'اعرض التغييرات' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('حسن: أضاف 6 عناصر في صفحة واحدة، حذف 1، عدّل 1')).toBeTruthy();
    expect(within(dialog).getByText('ص 3: أُضيف 6، حُذف 1، عُدّل 1')).toBeTruthy();
    expect(within(dialog).getByText(/ملاحظاتك الشخصية: لا يتغيّر منها أي عنصر/)).toBeTruthy();
    // nothing was applied by looking
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'طبّق التحديث' }));
    await waitFor(() => expect(screen.queryByText('تحديث متاح من حسن: الإصدار 2')).toBeNull());
    expect(calls.find((c) => c.url === '/api/copies/C2/upstream/apply')!.body).toEqual({ version_no: 2 });
    expect(syncNow).toHaveBeenCalledWith({ pull: true });
  });

  it('hidden by a moderator: the reason in words, no follow / fork / report', async () => {
    serve((method, path) => {
      if (path === '/api/spaces/SPA/publications/PUB1') return json(pub({ status: 'hidden_by_moderator', hidden: { reason_ar: 'يحتوي اسم مريض', at: 1 } }, { copy: 'followed', can_report: false }));
      if (path === '/api/copies') return json({ copies: [followed({ pending_version_no: null }, { status: 'hidden_by_moderator', status_note_ar: 'x' })] });
      if (path.endsWith('/items')) return json({ publication_id: 'PUB1', version_no: 2, items: [], notes: [], note_pages: [], redacted: false });
      return undefined;
    });
    renderAt('/subjects/SPA/publications/PUB1');
    expect((await screen.findByRole('note')).textContent).toBe('أخفى المشرف هذا الشرح: يحتوي اسم مريض. ما عندك باقٍ كما هو، ولا تصل تحديثاته حتى يُعاد إظهاره.');
    expect(screen.getByText('أخفاه المشرف')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'ابدأ الدراسة بهذا الشرح' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'أبلغ' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'اعرض التغييرات' })).toBeNull();
  });

  it('review R3-B: a holder of a hidden explanation previews the version they have, never one published after it', async () => {
    // the server lists the versions this holder may read (version 1); the live head is 2
    const calls = serve((method, path) => {
      if (path === '/api/spaces/SPA/publications/PUB1')
        return json(pub({ status: 'hidden_by_moderator', hidden: { reason_ar: 'يحتوي اسم مريض', at: 1 }, versions: [pub().versions[0]!] }, { copy: 'followed', can_report: false }));
      if (path === '/api/copies') return json({ copies: [followed({ pending_version_no: null }, { status: 'hidden_by_moderator', status_note_ar: 'x' })] });
      if (path.endsWith('/versions/1/items')) return json({ publication_id: 'PUB1', version_no: 1, items: [], notes: [], note_pages: [], redacted: false });
      return undefined;
    });
    renderAt('/subjects/SPA/publications/PUB1');
    await screen.findByRole('note');
    await waitFor(() => expect(calls.some((c) => c.url.includes('/versions/1/items'))).toBe(true));
    expect(calls.some((c) => c.url.includes('/versions/2/items'))).toBe(false);
    expect(calls.some((c) => c.url.includes('/diff'))).toBe(false);
    expect(screen.getAllByText('الإصدار 1').length).toBeGreaterThan(0);
    expect(screen.queryByText('الإصدار 2')).toBeNull();
  });

  it('not a member (or a missing explanation): the server’s «not found», nothing else', async () => {
    serve((method, path) => (path === '/api/spaces/SPA/publications/PUB1' ? json(NOT_FOUND, 404) : undefined));
    renderAt('/subjects/SPA/publications/PUB1');
    expect(await screen.findByText('هذا الشرح غير موجود.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'ابدأ الدراسة بهذا الشرح' })).toBeNull();
  });

  it('«أبلغ» sends a report to the subject’s moderation (the publication target), with the reason chosen', async () => {
    const calls = serve((method, path) => {
      if (path === '/api/spaces/SPA/publications/PUB1') return json(pub());
      if (path === '/api/copies') return json({ copies: [] });
      if (path.endsWith('/items')) return json({ publication_id: 'PUB1', version_no: 2, items: [], notes: [], note_pages: [], redacted: false });
      if (path.endsWith('/diff')) return json(PREVIEW);
      if (path === '/api/moderation/reports' && method === 'POST') return json({ id: 'R1' });
      return undefined;
    });
    renderAt('/subjects/SPA/publications/PUB1');
    fireEvent.click(await screen.findByRole('button', { name: 'أبلغ' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'أرسل البلاغ' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe('اختر سبب البلاغ.');
    fireEvent.click(within(dialog).getByRole('radio', { name: 'يحتوي معرّفات مريض' }));
    fireEvent.change(within(dialog).getByRole('textbox', { name: /تفاصيل/ }), { target: { value: 'اسم المريض في ص 3' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'أرسل البلاغ' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls.find((c) => c.url === '/api/moderation/reports')!.body).toEqual({ target: { db: 'system', type: 'publication', id: 'PUB1' }, reason: 'patient_identifiers', note: 'اسم المريض في ص 3' });
  });

  it('the author: what the snapshot left out and why; «انشر إصدارًا جديدًا» starts from the head’s layers; «اسحب الشرح» says what happens to copies', async () => {
    let current = pub({ snapshot: { items: 11, skipped: [{ reason_ar: 'الصور والإشارات المرجعية والروابط تبقى في مكتبتك.', items: 2 }] } }, { can_edit: true, can_report: false, source_layer_ids: ['LAY_EXP'] });
    const calls = serve((method, path) => {
      if (path === '/api/spaces/SPA/publications/PUB1') return json(current);
      if (path === '/api/copies' && method === 'GET') return json({ copies: [copy()] });
      if (path.endsWith('/items')) return json({ publication_id: 'PUB1', version_no: current.head_version_no, items: [], notes: [], note_pages: [], redacted: false });
      if (path.endsWith('/diff')) return json(PREVIEW);
      if (path === '/api/annotations/layers') return json({ document_key: 'source:SRC1', layers: [layer({ id: 'LAY_DEF', is_default: true }), layer({ id: 'LAY_EXP', kind: 'explanation', title: 'شرحي', item_count: 14 })] });
      if (path === '/api/spaces/SPA/publications/PUB1/versions' && method === 'POST') {
        current = { ...current, head_version_no: 3, versions: [...current.versions, { no: 3, created_at: 2, change_note: 'صححت السهم', lecture_version_id: 'V1', lecture_version_no: 1, item_count: 14 }] };
        return json(current);
      }
      if (path === '/api/spaces/SPA/publications/PUB1/withdraw' && method === 'POST') {
        current = { ...current, status: 'withdrawn' };
        return json(current);
      }
      return undefined;
    });
    renderAt('/subjects/SPA/publications/PUB1');
    expect(await screen.findByText('لم يُنشر عنصران: الصور والإشارات المرجعية والروابط تبقى في مكتبتك.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'ابدأ الدراسة بهذا الشرح' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'أبلغ' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'انشر إصدارًا جديدًا' }));
    const dialog = await screen.findByRole('dialog');
    expect((await within(dialog).findByRole('checkbox', { name: /شرحي/ }) as HTMLInputElement).checked).toBe(true);
    fireEvent.change(within(dialog).getByRole('textbox', { name: /ما الذي تغيّر/ }), { target: { value: 'صححت السهم' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'انشر الإصدار' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls.find((c) => c.url === '/api/spaces/SPA/publications/PUB1/versions')!.body).toEqual({ layer_ids: ['LAY_EXP'], change_note: 'صححت السهم' });
    expect(await screen.findByText('صححت السهم')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'اسحب الشرح' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(within(confirm).getByText(/من أخذ نسخة مستقلة تبقى له/)).toBeTruthy();
    fireEvent.click(within(confirm).getByRole('button', { name: 'اسحب الشرح' }));
    expect(await screen.findByText(/سحب صاحبه هذا الشرح/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'انشر إصدارًا جديدًا' })).toBeNull();
  });
});

describe('the reader’s copy bar with a followed explanation', () => {
  function renderBar(path: string, view: Partial<LayerViewContextValue> = {}) {
    const ctx = { layers: [], hidden: new Set<string>(), activeId: 'LAY_DEF', setVisible: vi.fn(), setActive: vi.fn(), documentKey: 'source:SRC1', session: {}, ...view } as unknown as LayerViewContextValue;
    render(
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <LayerViewContext.Provider value={ctx}>
            <StudyCopyBar sourceId="SRC1" sourceType="lecture" online />
          </LayerViewContext.Provider>
          <Where />
        </MemoryRouter>
      </ToastProvider>,
    );
    return ctx;
  }

  it('says whose explanation, which version, what it is built on; previews an update and can skip it; the auto switch is the copy’s real update_policy', async () => {
    const calls = serve((method, path) => {
      if (path === '/api/copies' && method === 'GET') return json({ copies: [copy(), followed()] });
      if (path === '/api/copies/C2/upstream') return json(PREVIEW);
      if (path === '/api/copies/C2/upstream/apply') return json({ copy: followed({ pending_version_no: null }), skipped: true, applied: null });
      if (path === '/api/copies/C2' && method === 'PATCH') return json(followed({ update_policy: 'auto', pending_version_no: null }));
      return undefined;
    });
    renderBar('/study/SRC1');
    expect(await screen.findByText('متابَعة: شرح حسن · حسن · الإصدار 1')).toBeTruthy();
    expect(screen.getByText('نسختي · التشريح · الإصدار 1')).toBeTruthy();
    expect(screen.getByText('الشرح مبني على الإصدار 1 من المحاضرة')).toBeTruthy();
    expect(screen.getByText('تحديث متاح من حسن: الإصدار 2')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'صفحة الشرح' }).getAttribute('href')).toBe('/subjects/SPA/publications/PUB1');
    fireEvent.click(screen.getByRole('button', { name: 'اعرض التغييرات' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText(/أضاف 6 عناصر/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'تخطَّ هذا الإصدار' }));
    await waitFor(() => expect(screen.queryByText('تحديث متاح من حسن: الإصدار 2')).toBeNull());
    expect(calls.find((c) => c.url === '/api/copies/C2/upstream/apply')!.body).toEqual({ version_no: 2, skip: true });
    expect(syncNow).not.toHaveBeenCalled();
    const sw = screen.getByRole('switch', { name: 'طبّق تحديثات الشرح تلقائيًا' });
    expect(sw.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(sw);
    await waitFor(() => expect(screen.getByRole('switch', { name: 'طبّق تحديثات الشرح تلقائيًا' }).getAttribute('aria-checked')).toBe('true'));
    expect(calls.find((c) => c.method === 'PATCH')).toMatchObject({ url: '/api/copies/C2', body: { update_policy: 'auto' } });
  });

  it('a withdrawn explanation: why updates stopped, no update control, no auto switch', async () => {
    serve((method, path) =>
      path === '/api/copies' ? json({ copies: [followed({ pending_version_no: 2 }, { status: 'withdrawn', status_note_ar: 'توقف التحديث — لم يعد الشرح منشورًا. ما عندك باقٍ كما هو.' })] }) : undefined,
    );
    renderBar('/study/SRC1');
    expect(await screen.findByText('توقف التحديث — لم يعد الشرح منشورًا. ما عندك باقٍ كما هو.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'اعرض التغييرات' })).toBeNull();
    expect(screen.queryByRole('switch', { name: 'طبّق تحديثات الشرح تلقائيًا' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'صفحة الشرح' })).toBeNull();
  });

  it('`?copy=` makes that copy’s own layer the one new writing goes to (once its layer has synced)', async () => {
    serve((method, path) => (path === '/api/copies' ? json({ copies: [copy(), followed()] }) : undefined));
    const ctx = renderBar('/study/SRC1?copy=C2', { layers: [{ id: 'LAY_DEF' }, { id: 'LAY_C2' }, { id: 'LAY_F' }] as unknown as LayerViewContextValue['layers'] });
    await screen.findByText('متابَعة: شرح حسن · حسن · الإصدار 1');
    await waitFor(() => expect(ctx.setActive).toHaveBeenCalledWith('LAY_C2'));
    expect(ctx.setActive).toHaveBeenCalledTimes(1);
  });
});

describe('pure helpers', () => {
  it('the update summary reads as Arabic (the object of «أضاف» is accusative) and a moderator’s reason ends once', () => {
    expect(upstreamSummaryAr({ added: 6, removed: 1, changed: 1 }, 1)).toBe('أضاف 6 عناصر في صفحة واحدة، حذف 1، عدّل 1');
    expect(upstreamSummaryAr({ added: 2, removed: 0, changed: 0 }, 2)).toBe('أضاف عنصرين في صفحتين');
    expect(upstreamSummaryAr({ added: 1, removed: 1, changed: 0 }, 1)).toBe('أضاف عنصرًا واحدًا في صفحة واحدة، حذف 1');
    expect(upstreamSummaryAr({ added: 0, removed: 0, changed: 0 }, 0)).toBe('لا تغييرات');
    expect(endSentenceAr('معلومة خاطئة في الصفحة 1.')).toBe('معلومة خاطئة في الصفحة 1.');
    expect(endSentenceAr('يحتوي اسم مريض')).toBe('يحتوي اسم مريض.');
  });

  it('previews group the items of a version by official page, newest layout first by page order', () => {
    const at = (page: string, index: number, kind: string, data: unknown): AnnotationDTO =>
      ({ id: `${page}${kind}`, kind, anchor: { type: 'page', source_id: 's', version_id: 'v', page_id: page, page_index: index, space: 'page_norm' }, data, deleted_at: null }) as unknown as AnnotationDTO;
    const out = pagePreviews([
      at('P9', 8, 'text', { box: { x: 0.5, y: 0.5, w: 0.2, h: 0.1 } }),
      at('P2', 1, 'ink', { points: [[0, 0, 0], [1.4, -0.2, 5]] }),
      at('P2', 1, 'shape', { from: [0.5, 0.5], to: [0.25, 0.25] }),
      { ...at('P2', 1, 'ink', { points: [] }), deleted_at: 5 },
      { id: 'np', kind: 'ink', anchor: { type: 'note_page', note_page_id: 'NP', space: 'page_norm' }, data: {} } as unknown as AnnotationDTO,
    ]);
    expect(out.map((p) => [p.pageId, p.items])).toEqual([
      ['P2', 2],
      ['P9', 1],
    ]);
    expect(out[0]!.paths).toEqual(['M0 0 L1 0']);
    expect(out[0]!.boxes).toEqual([{ x: 0.25, y: 0.25, w: 0.25, h: 0.25 }]);
  });

  it('the update preview marks what is added, changed and removed on a page (stable ids), and names the lines in words', () => {
    const ink = (id: string, x: number): AnnotationDTO =>
      ({ id, kind: 'ink', anchor: { type: 'page', source_id: 's', version_id: 'v', page_id: 'P1', page_index: 0, space: 'page_norm' }, data: { points: [[x, 0.2, 0], [x + 0.1, 0.25, 5]], bbox: { x, y: 0.2, w: 0.1, h: 0.05 } }, deleted_at: null }) as unknown as AnnotationDTO;
    const marks = changeMarks([ink('keep', 0.1), ink('moved', 0.3), ink('gone', 0.5)], [ink('keep', 0.1), ink('moved', 0.6), ink('new', 0.8)]);
    expect(marks.map((m) => m.kind).sort()).toEqual(['added', 'changed', 'removed']);
    const changed = marks.find((m) => m.kind === 'changed')!;
    expect(changed.box.x).toBeCloseTo(0.59);
    expect(marksCaptionAr(marks)).toBe('أُضيف 1 (خط متصل) · عُدّل 1 (خط متقطع) · حُذف 1 (خط منقّط)');
  });

  it('only the author’s own writable layers with writing can be published (a republish keeps its layers even if emptied)', () => {
    const ls = [
      layer({ id: 'a', kind: 'personal', item_count: 2 }),
      layer({ id: 'b', kind: 'followed', access: 'read_only', item_count: 5 }),
      layer({ id: 'c', kind: 'forked', item_count: 5 }),
      layer({ id: 'd', kind: 'explanation', item_count: 0 }),
      layer({ id: 'e', kind: 'answers', locked: true, access: 'write', item_count: 1 }),
    ];
    expect(publishableLayers(ls).map((l) => l.id)).toEqual(['a', 'e']);
    expect(publishableLayers(ls, ['d']).map((l) => l.id)).toEqual(['a', 'd', 'e']);
  });
});

describe('publications.css', () => {
  const css = readFileSync(join(__dirname, '..', '..', 'src', 'features', 'lectures', 'publications.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  it('colours only from tokens; logical properties only; 44 px targets; every pb-* class the screens use has a rule', () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/\b(rgb|rgba|hsl|hsla)\(/);
    expect(css).not.toMatch(/(?:^|[\s;{])(?:margin|padding|border)-(?:left|right)\b/);
    expect(css).not.toMatch(/(?:^|[\s;{])(?:left|right)\s*:/);
    expect(css).toMatch(/\.pb-card\s*\{[^}]*min-block-size:\s*44px/);
    expect(css).toMatch(/\.pb-choice\s*\{[^}]*min-block-size:\s*44px/);
    expect(css).toMatch(/\.pb-tab__actions \.ml-btn,\s*\.pb-update \.ml-btn\s*\{[^}]*min-block-size:\s*44px/);
    expect(css).toMatch(/:root\[data-eink='on'\]/);
    const used = new Set<string>();
    for (const f of [
      'lectures/PublicationsTab.tsx',
      'lectures/PublicationScreen.tsx',
      'lectures/PublishDialog.tsx',
      'lectures/ReportDialog.tsx',
      'lectures/PagePreviewFrame.tsx',
      'copies/StartFromExplanationDialog.tsx',
      'copies/UpdatePreviewDialog.tsx',
      'workspace/copies/StudyCopyBar.tsx',
    ]) {
      for (const m of readFileSync(join(__dirname, '..', '..', 'src', 'features', f), 'utf8').matchAll(/\b(pb-[a-z]+(?:__[a-z-]+)?(?:--[a-z]+)?)\b/g)) used.add(m[1]!);
    }
    expect(used.size).toBeGreaterThan(15);
    expect([...used].filter((c) => !new RegExp(`\\.${c}(?![A-Za-z0-9_-])`).test(css))).toEqual([]);
  });
});
