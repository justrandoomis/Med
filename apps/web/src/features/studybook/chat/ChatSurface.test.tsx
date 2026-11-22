// The Claude-style study chat against a mocked server: Enter / Shift+Enter, the streamed UNVERIFIED draft replaced by
// the checked answer, stop, markdown, «ص N» chips moving the reader, page sync both ways without a feedback loop,
// the model + effort picker (remembered on the server), the saved-conversation history, and auto-explain.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ChatMessageView, ChatPrefsResponse, ChatThreadView, SourceScope, StudyArtifactView } from '@medlevo/shared';
import { ToastProvider } from '../../../design';
import { setFetchImpl } from '../../../lib/api';
import { ChatSurface, type ChatSurfaceProps } from './ChatSurface';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const SCOPE: SourceScope = { mode: 'lecture_only', lecture_source_id: 'L1', reference_source_ids: [], version_pins: {}, include_my_notes: false };
const PAGES = [0, 1, 2, 3].map((i) => ({ id: `P${i}`, version_id: 'V1' }));
const GATE = { available: true, state: 'available' as const, reason: null };
const NOW = new Date(2026, 10, 22, 15, 0, 0).getTime();

function artifact(text: string): StudyArtifactView {
  return {
    id: `A-${text.length}`,
    lineage_id: 'x',
    version_no: 1,
    kind: 'chat_answer',
    title: 'سؤال',
    primary_source_id: 'L1',
    scope: { mode: 'lecture_only', source_ids: ['L1'], version_ids: ['V1'], describe_ar: 'المحاضرة فقط' },
    params: {},
    status: 'published',
    model: 'claude-sonnet-5-5',
    rules_version: 'r',
    coverage: null,
    is_frozen: false,
    stale_reason: null,
    created_at: 1,
    published_at: 1,
    blocks: [{ id: 'B1', block_key: 'b1', section_key: null, ord: 0, kind: 'paragraph', content: { v: 1, paragraphs: [{ runs: [{ t: text }] }] }, table: null, source_region_ids: [], status: 'complete', verification_status: 'linked', meta: null }],
    claims: {},
    removed: [],
    abstain: null,
    anchor: null,
    parent_artifact_id: null,
    job_id: null,
    versions: [],
  } as unknown as StudyArtifactView;
}

const owner = (id: string, text: string, pages: number[]): ChatMessageView =>
  ({ id, thread_id: 'T1', role: 'owner', status: 'final', style: 'detailed', content: { v: 1, paragraphs: [{ runs: [{ t: text }] }] }, artifact: null, abstain: null, reply_to_id: null, created_at: 1, page_indexes: pages, context: pages.length ? { page_id: `P${pages[0]}` } : null }) as unknown as ChatMessageView;
const answer = (id: string, replyTo: string, text: string, pages: number[]): ChatMessageView =>
  ({ id, thread_id: 'T1', role: 'assistant', status: 'final', style: 'detailed', content: { v: 1, paragraphs: [{ runs: [{ t: text }] }] }, artifact: artifact(text), abstain: null, reply_to_id: replyTo, created_at: 2, page_indexes: pages, model: 'claude-sonnet-5-5', usage: { input_tokens: 10, output_tokens: 5, cost_usd: 0.0012 } }) as unknown as ChatMessageView;

const threadView = (id: string, title: string, updated_at = NOW - 60_000): ChatThreadView =>
  ({ id, source_id: 'L1', version_id: 'V1', page_id: null, anchor: null, scope: { mode: 'lecture_only', source_ids: ['L1'], version_ids: ['V1'], describe_ar: 'المحاضرة فقط', hash: 'h' }, style: 'detailed', socratic: false, title, created_at: 1, updated_at, message_count: 2, last_message_preview: null, kind: 'chat', source_title: 'Appendicitis' }) as ChatThreadView;

interface Call {
  method: string;
  url: string;
  body: Record<string, unknown> | null;
}

interface ServerOpts {
  prefs?: Partial<ChatPrefsResponse['prefs']>;
  threads?: ChatThreadView[];
  messages?: Record<string, ChatMessageView[]>;
  /** the stream answer: either a fixed final, or a controlled stream */
  stream?: (body: Record<string, unknown>, signal: AbortSignal | null | undefined) => Response;
}

function server(o: ServerOpts = {}) {
  const calls: Call[] = [];
  const threads = new Map<string, { view: ChatThreadView; messages: ChatMessageView[] }>();
  for (const t of o.threads ?? []) threads.set(t.id, { view: t, messages: o.messages?.[t.id] ?? [] });
  let n = 0;
  setFetchImpl(async (url, init) => {
    const method = (init.method ?? 'GET').toUpperCase();
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({ method, url, body });
    if (url.startsWith('/api/studybook/chat/prefs')) {
      const prefs = { model: null, effort: null, auto_explain: false, sync_pages: true, ...o.prefs, ...(method === 'PUT' ? body : {}) };
      return json({ prefs, defaults: { model: 'claude-opus-5-5', effort: 'high' }, available_models: ['claude-opus-5-5', 'claude-sonnet-5-5'] } satisfies ChatPrefsResponse);
    }
    if (url === '/api/studybook/threads' && method === 'POST') {
      const id = `TN${++n}`;
      const view = threadView(id, 'محادثة جديدة', NOW);
      threads.set(id, { view, messages: [] });
      return json({ thread: view, messages: [] });
    }
    if (url.startsWith('/api/studybook/threads?') || url === '/api/studybook/threads') return json({ threads: [...threads.values()].map((t) => t.view) });
    const msg = /^\/api\/studybook\/threads\/([^/]+)\/messages\/stream$/.exec(url);
    if (msg && method === 'POST') {
      const t = threads.get(msg[1]!)!;
      if (o.stream) return o.stream(body!, init.signal);
      const q = owner(`${t.view.id}-q${t.messages.length}`, String(body!.text), [1]);
      const ans = answer(`${t.view.id}-a${t.messages.length}`, q.id, 'Ultrasound is first-line in children.', [2]);
      t.messages.push(q, ans);
      return sse([{ type: 'final', result: { owner_message: q, answer: ans }, removed: [], had_draft: false }]);
    }
    const one = /^\/api\/studybook\/threads\/([^/?]+)$/.exec(url);
    if (one) {
      const t = threads.get(one[1]!);
      if (!t) return json({ error: { code: 'NOT_FOUND', message: 'غير موجود' } }, 404);
      if (method === 'PATCH') {
        t.view = { ...t.view, title: String(body!.title) };
        return json({ thread: t.view });
      }
      if (method === 'DELETE') {
        threads.delete(one[1]!);
        return json({ deleted: true });
      }
      return json({ thread: t.view, messages: t.messages });
    }
    return json({ error: { code: 'NOT_FOUND', message: 'غير موجود' } }, 404);
  });
  return { calls, threads };
}

function sse(events: unknown[]): Response {
  return new Response(events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function controlled(signal: AbortSignal | null | undefined) {
  const enc = new TextEncoder();
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const state = { aborted: false };
  const body = new ReadableStream<Uint8Array>({ start: (c) => void (ctrl = c) });
  signal?.addEventListener('abort', () => {
    state.aborted = true;
    try {
      ctrl.error(new DOMException('aborted', 'AbortError'));
    } catch {
      /* closed */
    }
  });
  return {
    state,
    response: new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    push: (e: Record<string, unknown>) => ctrl.enqueue(enc.encode(`event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`)),
    close: () => ctrl.close(),
  };
}

function mount(props: Partial<ChatSurfaceProps> = {}) {
  const base: ChatSurfaceProps = { sourceId: 'L1', sourceTitle: 'Appendicitis', pages: PAGES, visiblePage: 1, scope: SCOPE, gate: GATE, online: true, ...props };
  const ui = (p: ChatSurfaceProps) => (
    <MemoryRouter>
      <ToastProvider>
        <ChatSurface {...p} />
      </ToastProvider>
    </MemoryRouter>
  );
  const r = render(ui(base));
  return { ...r, update: (more: Partial<ChatSurfaceProps>) => r.rerender(ui({ ...base, ...props, ...more })) };
}

/** the chat's polite live region (announcements, never the streamed text) */
const liveRegion = () => document.querySelector('.ch > [aria-live="polite"]')?.textContent ?? '';

const scrolled = vi.fn();
beforeEach(() => {
  scrolled.mockReset();
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled((this as HTMLElement).dataset.turnId);
  } as typeof Element.prototype.scrollIntoView;
});
afterEach(() => setFetchImpl(null));

describe('ChatSurface — sending and streaming', () => {
  it('Enter sends (Shift+Enter does not); the draft streams labelled unverified, then ONLY the checked answer stays; the body carries page context + model/effort', async () => {
    let live: ReturnType<typeof controlled> | null = null;
    const { calls, threads } = server({
      prefs: { model: 'claude-sonnet-5-5', effort: 'low' },
      stream: (_b, signal) => {
        live = controlled(signal);
        return live.response;
      },
    });
    mount();
    const box = await screen.findByLabelText('رسالتك');
    await waitFor(() => expect(screen.getByRole('button', { name: /النموذج ومستوى التفكير: Sonnet 5.5 · منخفض/ })).toBeTruthy());
    fireEvent.change(box, { target: { value: 'لماذا نبدأ بالأمواج فوق الصوتية؟' } });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(calls.some((c) => c.url.endsWith('/messages/stream'))).toBe(false);
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(live).not.toBeNull());
    const req = calls.find((c) => c.url.endsWith('/messages/stream'))!.body!;
    expect(req).toMatchObject({ text: 'لماذا نبدأ بالأمواج فوق الصوتية؟', model: 'claude-sonnet-5-5', effort: 'low', context: { page_id: 'P1' } });
    expect(calls.find((c) => c.method === 'POST' && c.url === '/api/studybook/threads')!.body).toMatchObject({ scope: SCOPE, anchor: null });

    act(() => {
      live!.push({ type: 'phase', phase: 'generating', label_ar: 'يكتب النموذج مسودة…' });
      live!.push({ type: 'draft', attempt: 1, blocks: [{ kind: 'paragraph', sentences: ['Ultrasound is **first-line** in children.', 'It is always diagnostic.'] }], label_ar: 'مسودة لم تُتحقق بعد', note_ar: 'ملاحظة' });
    });
    expect(await screen.findByText('مسودة لم تُتحقق بعد')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'أوقف الإجابة' })).toBeTruthy();
    // markdown in the draft (bold), still inside the unverified section
    const draft = document.querySelector('.sb-draft') as HTMLElement;
    expect(within(draft).getByText('first-line').closest('strong')).toBeTruthy();

    const t = [...threads.values()][0]!;
    const q = owner('q1', 'لماذا نبدأ بالأمواج فوق الصوتية؟', [1]);
    const ans = answer('a1', 'q1', 'Ultrasound is first-line in children.', [1]);
    t.messages.push(q, ans);
    act(() => {
      live!.push({ type: 'final', result: { owner_message: q, answer: ans }, removed: [{ text: 'It is always diagnostic.', reason_ar: 'غير مدعومة' }], had_draft: true });
      live!.close();
    });
    expect(await screen.findByText('Ultrasound is first-line in children.')).toBeTruthy();
    expect(screen.queryByText('مسودة لم تُتحقق بعد')).toBeNull();
    // what verification removed is listed as removed — never silently dropped
    expect(screen.getByText('It is always diagnostic.').closest('del')).toBeTruthy();
    await waitFor(() => expect(liveRegion()).toContain('اكتملت الإجابة بعد التحقق'));
    expect(screen.getByText(/Sonnet 5.5 · ≈ 0.0012\$/)).toBeTruthy();
  });

  it('«أوقف الإجابة» aborts the stream; nothing of the draft stays on screen', async () => {
    let live: ReturnType<typeof controlled> | null = null;
    server({
      stream: (_b, signal) => {
        live = controlled(signal);
        return live.response;
      },
    });
    mount();
    fireEvent.change(await screen.findByLabelText('رسالتك'), { target: { value: 'اشرح' } });
    fireEvent.click(screen.getByRole('button', { name: 'أرسل' }));
    await waitFor(() => expect(live).not.toBeNull());
    act(() => live!.push({ type: 'draft', attempt: 1, blocks: [{ kind: 'paragraph', sentences: ['partial draft text'] }], label_ar: 'مسودة لم تُتحقق بعد', note_ar: '' }));
    expect(await screen.findByText('partial draft text')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'أوقف الإجابة' }));
    await waitFor(() => expect(live!.state.aborted).toBe(true));
    await waitFor(() => expect(screen.queryByText('partial draft text')).toBeNull());
    await waitFor(() => expect(liveRegion()).toContain('أوقفتَ الإجابة'));
  });

  it('renders the owner’s markdown safely: lists, bold, tables, code — and never HTML', async () => {
    const q = owner('q1', '**مهم:**\n- أول\n- second\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n<img src=x onerror=alert(1)> `CT`', [1]);
    server({ threads: [threadView('T1', 'محادثة')], messages: { T1: [q, answer('a1', 'q1', 'ok', [1])] } });
    mount();
    const bubble = (await screen.findByText('مهم:')).closest('.ch-bubble') as HTMLElement;
    expect(bubble.querySelector('strong')?.textContent).toBe('مهم:');
    expect([...bubble.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['أول', 'second']);
    expect(bubble.querySelector('table td')?.textContent).toBe('1');
    expect(bubble.querySelector('img')).toBeNull();
    expect(bubble.querySelector('code')?.textContent).toBe('CT');
    expect(bubble.querySelector('bdi[dir="ltr"]')).toBeTruthy();
  });
});

describe('ChatSurface — reader ↔ chat page sync', () => {
  const messages = { T1: [owner('q0', 'اشرح الصفحة الأولى', [0]), answer('a0', 'q0', 'Page one explained.', [0]), owner('q2', 'اشرح الصفحة الثالثة', [2]), answer('a2', 'q2', 'Page three explained.', [2])] };

  it('«ص 3» chips and «صفحة» dividers move the reader; the reader’s echo does not scroll the chat back; a later page change does', async () => {
    let t = NOW;
    const now = () => t;
    server({ threads: [threadView('T1', 'شرح المحاضرة')], messages });
    const jump = vi.fn();
    const { update } = mount({ onJumpToPage: jump, visiblePage: 1, now });
    expect(await screen.findByText('Page three explained.')).toBeTruthy();
    expect(screen.getAllByRole('separator', { name: /صفحة/ }).map((s) => s.getAttribute('aria-label'))).toEqual(['صفحة 1', 'صفحة 3']);
    fireEvent.click(screen.getByRole('button', { name: 'اذهب إلى الصفحة 3' }));
    expect(jump).toHaveBeenCalledWith(2);
    // the reader reports the page the chat sent it to — not followed back into the chat
    scrolled.mockClear();
    update({ visiblePage: 2 });
    expect(scrolled).not.toHaveBeenCalled();
    // the person reads page 1 a moment later → the chat scrolls to page 1's explanation
    t += 2000;
    update({ visiblePage: 0 });
    await waitFor(() => expect(scrolled).toHaveBeenCalledWith('q0'));
    expect(jump).toHaveBeenCalledTimes(1);
    // «مزامنة الصفحات» off → the chat no longer follows
    fireEvent.click(screen.getByRole('switch', { name: /مزامنة الصفحات/ }));
    scrolled.mockClear();
    t += 2000;
    update({ visiblePage: 2 });
    expect(scrolled).not.toHaveBeenCalled();
  });

  it('an answer about another page moves the reader there once', async () => {
    server({ threads: [threadView('T1', 'شرح')], messages: { T1: [] } });
    const jump = vi.fn();
    mount({ onJumpToPage: jump, visiblePage: 0 });
    fireEvent.change(await screen.findByLabelText('رسالتك'), { target: { value: 'لخّص' } });
    fireEvent.click(screen.getByRole('button', { name: 'أرسل' }));
    await screen.findByText('Ultrasound is first-line in children.');
    // the server's answer explains page index 2
    expect(jump).toHaveBeenCalledWith(2);
    expect(jump).toHaveBeenCalledTimes(1);
  });

  it('«اشرح هذه الصفحة تلقائيًا» asks for a page at rest once, with that page attached', async () => {
    const { calls } = server({ prefs: { auto_explain: true } });
    const { update } = mount({ onJumpToPage: vi.fn(), visiblePage: 3 });
    await waitFor(() => expect(calls.filter((c) => c.url.endsWith('/messages/stream'))).toHaveLength(1), { timeout: 4000 });
    expect(calls.find((c) => c.url.endsWith('/messages/stream'))!.body).toMatchObject({ text: 'اشرح هذه الصفحة', kind: 'explain', context: { page_id: 'P3' } });
    await screen.findByText('Ultrasound is first-line in children.');
    update({ visiblePage: 3 });
    await new Promise((r) => setTimeout(r, 1800));
    expect(calls.filter((c) => c.url.endsWith('/messages/stream'))).toHaveLength(1);
  }, 10_000);
});

describe('ChatSurface — copy, regenerate, edit the last question', () => {
  it('regenerate re-asks the last question in place; edit puts it in the composer and replaces that turn', async () => {
    const { calls } = server({ threads: [threadView('T1', 'محادثة')], messages: { T1: [owner('q1', 'ما الفحص الأول؟', [1]), answer('a1', 'q1', 'الجواب الأول', [1])] } });
    mount();
    await screen.findByText('الجواب الأول');
    fireEvent.click(screen.getByRole('button', { name: 'أعد توليد الإجابة' }));
    await waitFor(() => expect(calls.filter((c) => c.url.endsWith('/messages/stream'))).toHaveLength(1));
    expect(calls.find((c) => c.url.endsWith('/messages/stream'))!.body).toMatchObject({ text: 'ما الفحص الأول؟', replace_from: 'q1', context: { page_id: 'P1' } });
    await screen.findByText('Ultrasound is first-line in children.');
    // the mocked thread now has two turns; edit the last one
    fireEvent.click(screen.getByRole('button', { name: 'عدّل السؤال' }));
    const box = screen.getByLabelText('رسالتك') as HTMLTextAreaElement;
    expect(box.value).toBe('ما الفحص الأول؟');
    expect(screen.getByText(/تعدّل آخر سؤال/)).toBeTruthy();
    fireEvent.change(box, { target: { value: 'وعند البالغين؟' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(calls.filter((c) => c.url.endsWith('/messages/stream'))).toHaveLength(2));
    const second = calls.filter((c) => c.url.endsWith('/messages/stream'))[1]!.body!;
    expect(second).toMatchObject({ text: 'وعند البالغين؟' });
    expect(typeof second.replace_from).toBe('string');
  });
});

describe('ChatSurface — model + effort, history', () => {
  it('the picker offers the allow-listed models (unavailable ones disabled) and efforts; the choice is remembered on the server', async () => {
    const { calls } = server();
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /النموذج ومستوى التفكير/ }));
    const dialog = await screen.findByRole('dialog', { name: 'النموذج ومستوى التفكير' });
    expect(within(dialog).getByRole('radio', { name: /Haiku 5.5/ })).toHaveProperty('disabled', true);
    fireEvent.click(within(dialog).getByRole('radio', { name: /Sonnet 5.5/ }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT' && c.body?.model === 'claude-sonnet-5-5')).toBe(true));
    fireEvent.click(within(dialog).getByRole('radio', { name: /^أقصى/ }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT' && c.body?.effort === 'max' && c.body?.model === 'claude-sonnet-5-5')).toBe(true));
    expect(screen.getByRole('button', { name: /النموذج ومستوى التفكير: Sonnet 5.5 · أقصى/ })).toBeTruthy();
  });

  it('history: grouped by day, opens, renames and deletes a saved conversation', async () => {
    const { calls } = server({
      threads: [threadView('T1', 'الأشعة عند الأطفال', NOW - 3600_000), threadView('T2', 'علامة ماك بيرني', NOW - 26 * 3600_000)],
      messages: { T1: [owner('q1', 'سؤال 1', [1]), answer('a1', 'q1', 'جواب الأول', [1])], T2: [owner('q2', 'سؤال 2', [0]), answer('a2', 'q2', 'جواب الثاني', [0])] },
    });
    mount({ now: () => NOW });
    // the lecture's latest conversation is continued
    expect(await screen.findByText('جواب الأول')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'المحادثات المحفوظة' }));
    const nav = await screen.findByRole('navigation', { name: 'المحادثات المحفوظة' });
    expect(within(nav).getAllByRole('heading').map((h) => h.textContent)).toEqual(['اليوم', 'أمس']);
    fireEvent.click(within(nav).getByRole('button', { name: 'علامة ماك بيرني' }));
    expect(await screen.findByText('جواب الثاني')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'المحادثات المحفوظة' }));
    fireEvent.click(await screen.findByRole('button', { name: 'أعد تسمية «الأشعة عند الأطفال»' }));
    const field = screen.getByLabelText('اسم المحادثة');
    fireEvent.change(field, { target: { value: 'تصوير الزائدة' } });
    fireEvent.click(screen.getByRole('button', { name: 'احفظ' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH' && c.url === '/api/studybook/threads/T1' && c.body?.title === 'تصوير الزائدة')).toBe(true));
    expect(await screen.findByRole('button', { name: 'تصوير الزائدة' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'احذف «تصوير الزائدة»' }));
    fireEvent.click(await screen.findByRole('button', { name: 'احذف' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/studybook/threads/T1')).toBe(true));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'تصوير الزائدة' })).toBeNull());
  });
});
