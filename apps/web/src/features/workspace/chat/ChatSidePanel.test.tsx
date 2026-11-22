// (chat side panel, wp/chat-side) The study chat as a full side chat: opened from the reading bar's «المحادثة», a
// labelled region with focus in the composer, Escape closes; the width handle (role="separator") resizes with the arrow
// keys, clamped to 360 px … 65 %, remembered per account; the history slides in as a column (not a modal); on a phone
// the chat is full screen with «الصفحة N» and «اعرض الصفحة» (chat kept), the back gesture closes it; and the page sync
// still moves the reader («ص N» chips) and follows it.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useState } from 'react';
import { FEATURE_KEYS, type CapabilitiesResponse, type ChatMessageView, type ChatThreadView, type SourcePageView } from '@medlevo/shared';
import { ToastProvider } from '../../../design';
import { setFetchImpl } from '../../../lib/api';
import { capabilitiesStore } from '../../../lib/capabilities';
import { userStorage } from '../../../lib/userStorage';
import { TopBar, type TopBarProps } from '../chrome/TopBar';
import type { SourceDocument } from '../data/useSourceDocument';
import { aiRequestStore } from '../model/aiActions';
import { chatWidthFor, decideChat, decidePanelsWithChat, LEFT_PANEL_WIDTH } from '../model/layout';
import { ChatSidePanel } from './ChatSidePanel';
import { CHAT_WIDTH_KEY, useChatPanel } from './useChatPanel';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function caps(): CapabilitiesResponse {
  const features = Object.fromEntries(FEATURE_KEYS.map((k) => [k, { key: k, state: 'available' }])) as CapabilitiesResponse['features'];
  return { features, ai: { configured: true }, server_time: 0, app_version: 'test' };
}

const pages = [0, 1, 2, 3].map((i) => ({ id: `P${i}`, page_index: i, printed_label: String(i + 1), kind: 'page', version_id: 'V1', numbered_version: true, has_images: false })) as unknown as SourcePageView[];
const doc = { detail: { id: 'L1', title: 'Appendicitis', language: 'en', links: [] }, version: { id: 'V1' }, pages, mode: 'text', pdf: null } as unknown as SourceDocument;

const msg = (id: string, role: 'owner' | 'assistant', text: string, pageIdx: number, replyTo: string | null = null) =>
  ({
    id,
    thread_id: 'T1',
    role,
    status: 'final',
    style: 'detailed',
    content: { v: 1, paragraphs: [{ runs: [{ t: text }] }] },
    artifact: null,
    abstain: null,
    reply_to_id: replyTo,
    created_at: 1,
    page_indexes: [pageIdx],
    context: role === 'owner' ? { page_id: `P${pageIdx}` } : null,
  }) as unknown as ChatMessageView;
const thread = { id: 'T1', source_id: 'L1', version_id: 'V1', page_id: null, anchor: null, scope: { mode: 'lecture_only', source_ids: ['L1'], version_ids: ['V1'], describe_ar: 'المحاضرة فقط', hash: 'h' }, style: 'detailed', socratic: false, title: 'شرح المحاضرة', created_at: 1, updated_at: Date.now() - 60_000, message_count: 4, last_message_preview: null, kind: 'chat', source_title: 'Appendicitis' } as ChatThreadView;

function server(withThread: boolean) {
  const messages = [msg('q0', 'owner', 'اشرح الصفحة الأولى', 0), msg('a0', 'assistant', 'Page one explained.', 0, 'q0'), msg('q2', 'owner', 'اشرح الصفحة الثالثة', 2), msg('a2', 'assistant', 'Page three explained.', 2, 'q2')];
  setFetchImpl(async (url) => {
    if (url.startsWith('/api/studybook/chat/prefs')) return json({ prefs: { model: null, effort: null, auto_explain: false, sync_pages: true }, defaults: { model: 'claude-opus-5-5', effort: 'high' }, available_models: ['claude-opus-5-5'] });
    if (url.startsWith('/api/studybook/threads?') || url === '/api/studybook/threads') return json({ threads: withThread ? [thread] : [] });
    if (url === '/api/studybook/threads/T1') return json({ thread, messages });
    return json({ error: { code: 'NOT_FOUND', message: 'غير موجود' } }, 404);
  });
}

function barProps(phone: boolean): TopBarProps {
  return {
    title: 'Appendicitis',
    backTo: '/library',
    phone,
    pages,
    pageIndex: 0,
    onGoToPage: () => undefined,
    view: 'original',
    onView: () => undefined,
    splitReason: null,
    studyBookReason: null,
    searchOpen: false,
    onToggleSearch: () => undefined,
    zoomLabel: '100%',
    fit: true,
    onZoomIn: () => undefined,
    onZoomOut: () => undefined,
    onZoomTo: () => undefined,
    onRotate: () => undefined,
    layout: 'continuous',
    spreadReason: null,
    onLayout: () => undefined,
    flipAnimation: false,
    onFlipAnimation: () => undefined,
    focusMode: false,
    onFocusMode: () => undefined,
    leftOpen: false,
    onToggleLeft: () => undefined,
    railOpen: false,
    onToggleRail: () => undefined,
    saveState: 'synced',
    saveDetail: '',
    back: null,
    onBack: () => undefined,
    inkAvailable: false,
    modeSwitch: null,
  };
}

/** the workspace's wiring of the chat (WorkspaceScreen): the bar's «المحادثة», the reader's page, the panel */
function Harness({ width, onJump }: { width: number; onJump?: (i: number) => void }) {
  const chat = useChatPanel({ width });
  const [page, setPage] = useState(1);
  return (
    <>
      <TopBar {...barProps(width < 768)} pageIndex={page} chatOpen={chat.open} onToggleChat={() => (chat.open ? chat.close() : chat.openChat())} />
      <main aria-label="الكتاب">
        <p data-testid="reader-page">{page}</p>
        <button type="button" onClick={() => setPage(0)}>
          اقرأ الصفحة الأولى
        </button>
      </main>
      {chat.mode !== 'closed' && (
        <ChatSidePanel
          doc={doc}
          pageIndex={page}
          online
          mode={chat.mode}
          width={chat.width}
          handleProps={chat.handleProps}
          phoneView={chat.phoneView}
          onPhoneView={chat.setPhoneView}
          landscape={chat.landscape}
          openKey={chat.openKey}
          onClose={chat.close}
          onJumpToPage={(i) => {
            setPage(i);
            onJump?.(i);
          }}
        />
      )}
    </>
  );
}

function mount(width: number, onJump?: (i: number) => void) {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <Harness width={width} onJump={onJump} />
      </ToastProvider>
    </MemoryRouter>,
  );
}

const panel = () => screen.queryByRole('region', { name: 'المحادثة' });

beforeAll(() => {
  document.documentElement.dir = 'rtl';
});
beforeEach(() => {
  capabilitiesStore.reset(caps());
  userStorage.set(CHAT_WIDTH_KEY, null);
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  setFetchImpl(null);
  capabilitiesStore.reset(null);
  aiRequestStore.clear();
});

describe('chat side panel (desktop / tablet ≥ 900 px)', () => {
  it('«المحادثة» in the reading bar opens a labelled full-height panel with focus in the composer; Escape closes it', async () => {
    server(false);
    mount(1400);
    expect(panel()).toBeNull();
    const open = screen.getByRole('button', { name: 'المحادثة' });
    expect(open.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(open);
    const region = panel()!;
    expect(region).toBeTruthy();
    expect(region.getAttribute('data-mode')).toBe('docked');
    expect(open.getAttribute('aria-pressed')).toBe('true');
    // beside the book, never over it: the panel has its own width; the composer and the header live inside it
    expect(region.style.width).toBe(`${chatWidthFor(1400, null)}px`);
    const composer = within(region).getByLabelText('رسالتك');
    await waitFor(() => expect(document.activeElement).toBe(composer));
    expect(within(region).getByRole('button', { name: 'محادثة جديدة' })).toBeTruthy();
    expect(within(region).getByRole('button', { name: 'أغلق المحادثة' })).toBeTruthy();
    fireEvent.keyDown(composer, { key: 'Escape' });
    expect(panel()).toBeNull();
    expect(open.getAttribute('aria-pressed')).toBe('false');
  });

  it('the resize handle: arrow keys change the width, clamped to 360 px … 65 %, remembered for the account', () => {
    server(false);
    const r = mount(1400);
    fireEvent.click(screen.getByRole('button', { name: 'المحادثة' }));
    const handle = screen.getByRole('separator', { name: 'تغيير عرض المحادثة' });
    const start = chatWidthFor(1400, null);
    expect(start).toBe(588); // ~42 %
    expect(handle.getAttribute('aria-valuenow')).toBe('588');
    expect(handle.getAttribute('aria-valuemin')).toBe('360');
    expect(handle.getAttribute('aria-valuemax')).toBe('910');
    // RTL, the panel on the right: ← widens it (towards the book), → narrows it
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(handle.getAttribute('aria-valuenow')).toBe('612');
    expect(panel()!.style.width).toBe('612px');
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(handle.getAttribute('aria-valuenow')).toBe('564');
    fireEvent.keyDown(handle, { key: 'End' });
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(handle.getAttribute('aria-valuenow')).toBe('910'); // never past 65 %
    fireEvent.keyDown(handle, { key: 'Home' });
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(handle.getAttribute('aria-valuenow')).toBe('360'); // never under 360 px
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(userStorage.get(CHAT_WIDTH_KEY)).toBe('384');
    r.unmount();
    // a new reading session opens at the remembered width
    mount(1400);
    fireEvent.click(screen.getByRole('button', { name: 'المحادثة' }));
    expect(screen.getByRole('separator', { name: 'تغيير عرض المحادثة' }).getAttribute('aria-valuenow')).toBe('384');
  });

  it('the history slides in as a column inside the panel (not a modal) and hides again', async () => {
    server(true);
    mount(1400);
    fireEvent.click(screen.getByRole('button', { name: 'المحادثة' }));
    const region = panel()!;
    await within(region).findByText('Page three explained.');
    const toggle = within(region).getByRole('button', { name: 'المحادثات المحفوظة' });
    fireEvent.click(toggle);
    const history = within(region).getByRole('navigation', { name: 'المحادثات المحفوظة' });
    expect(history.closest('.ch-body__history')).toBeTruthy();
    expect(region.querySelector('.ch')!.getAttribute('data-layout')).toBe('side');
    expect(screen.queryByRole('dialog')).toBeNull();
    // the thread stays beside it
    expect(within(region).getByText('Page three explained.')).toBeTruthy();
    fireEvent.click(within(region).getByRole('button', { name: 'أخفِ المحادثات المحفوظة' }));
    expect(within(region).queryByRole('navigation', { name: 'المحادثات المحفوظة' })).toBeNull();
  });

  it('«اسأل عن التحديد» goes to the side chat: the selection is attached as context, the request consumed once', async () => {
    server(false);
    mount(1400);
    act(() => {
      aiRequestStore.request({ action: 'ask', anchor: { source_id: 'L1', version_id: 'V1', page_id: 'P1', region_ids: [] }, text: 'McBurney point tenderness', pageIndex: 1, rects: [], prefill: 'ما أهمية هذا؟' });
    });
    fireEvent.click(screen.getByRole('button', { name: 'المحادثة' }));
    const region = panel()!;
    const chips = await within(region).findByRole('list', { name: 'السياق المرفق بالرسالة' });
    await waitFor(() => expect(chips.textContent).toContain('التحديد'));
    expect((within(region).getByLabelText('رسالتك') as HTMLTextAreaElement).value).toBe('ما أهمية هذا؟');
    expect(aiRequestStore.get()).toBeNull();
  });

  it('page sync still moves the reader («ص N» chips) and follows the reader', async () => {
    server(true);
    const jump = vi.fn();
    mount(1400, jump);
    fireEvent.click(screen.getByRole('button', { name: 'المحادثة' }));
    const region = panel()!;
    await within(region).findByText('Page three explained.');
    fireEvent.click(within(region).getByRole('button', { name: 'اذهب إلى الصفحة 3' }));
    expect(jump).toHaveBeenCalledWith(2);
    expect(screen.getByTestId('reader-page').textContent).toBe('2');
    // reader → chat: reading another page (after the echo window) scrolls the thread to its turn
    const scrolled = Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>;
    await new Promise((r) => setTimeout(r, 950));
    scrolled.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'اقرأ الصفحة الأولى' }));
    await waitFor(() => expect(scrolled).toHaveBeenCalled());
  });
});

describe('chat on a phone (< 900 px): full screen', () => {
  it('opens full screen with «الصفحة N»; «اعرض الصفحة» shows the reader and keeps the chat; back returns from it', async () => {
    server(false);
    mount(390);
    fireEvent.click(screen.getByRole('button', { name: 'المحادثة' }));
    const region = panel()!;
    expect(region.getAttribute('data-mode')).toBe('full');
    expect(region.className).toContain('wk-chat--full');
    // the compact page bar names the reader's page (printed «2» = index 1)
    const bar = region.querySelector('.wk-chat__pagebar')!;
    expect(bar.querySelector('.wk-chat__page')!.textContent).toMatch(/2/);
    expect(within(region).queryByRole('separator', { name: 'تغيير عرض المحادثة' })).toBeNull();
    fireEvent.change(within(region).getByLabelText('رسالتك'), { target: { value: 'سؤال لم يُرسل' } });
    fireEvent.click(within(region).getByRole('button', { name: 'اعرض الصفحة' }));
    expect(panel()).toBeNull(); // hidden, not unmounted
    const back = screen.getByRole('button', { name: /عُد إلى المحادثة/ });
    fireEvent.click(back);
    expect((within(panel()!).getByLabelText('رسالتك') as HTMLTextAreaElement).value).toBe('سؤال لم يُرسل');
    // the back gesture closes the chat (the reader stays at its page)
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(panel()).toBeNull();
    expect(screen.getByTestId('reader-page').textContent).toBe('1');
  });
});

describe('chat layout decisions', () => {
  it('docked from 900 px, full screen below, side by side only on a phone in landscape', () => {
    expect(decideChat({ width: 1200, open: true, phoneView: 'chat', landscape: false })).toBe('docked');
    expect(decideChat({ width: 899, open: true, phoneView: 'chat', landscape: false })).toBe('full');
    expect(decideChat({ width: 800, open: true, phoneView: 'split', landscape: true })).toBe('split');
    expect(decideChat({ width: 400, open: true, phoneView: 'split', landscape: false })).toBe('full');
    expect(decideChat({ width: 1200, open: false, phoneView: 'chat', landscape: false })).toBe('closed');
  });
  it('the chat takes the rail’s place; the page panel stays only while the book keeps its minimum width', () => {
    const wide = decidePanelsWithChat({ width: 1600, railOpen: false, railWidth: 320, leftOpen: true, last: 'rail', chatWidth: 600 });
    expect(wide).toMatchObject({ rail: 'closed', left: 'docked', canvasWidth: 1600 - 600 - LEFT_PANEL_WIDTH, closed: null });
    const narrow = decidePanelsWithChat({ width: 1000, railOpen: false, railWidth: 320, leftOpen: true, last: 'left', chatWidth: 420 });
    expect(narrow).toMatchObject({ rail: 'closed', left: 'closed', canvasWidth: 580, closed: null, phone: false });
  });
});
