// Round 7 H4 item 10 (web, chat): the answer being written streams below the conversation as a draft labelled
// «مسودة لم تُتحقق بعد» (outside the polite live region, so it is not read out word by word); the kept answer is the
// verified one, with the sentences verification removed from the draft shown as removed; «أوقف» cancels.
import { afterEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ChatMessageView, ChatThreadView, SourcePageView, SourceScope, StudyArtifactView } from '@medlevo/shared';
import { ToastProvider } from '../../../design';
import { setFetchImpl } from '../../../lib/api';
import { ChatPanel } from './ChatPanel';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
afterEach(() => setFetchImpl(null));

const page = { id: 'P1', page_index: 0, printed_label: '11', kind: 'page', version_id: 'V1' } as unknown as SourcePageView;
const scope: SourceScope = { mode: 'lecture_only', lecture_source_id: 'L1', reference_source_ids: [], version_pins: {}, include_my_notes: false } as SourceScope;
const thread = {
  id: 'T1',
  source_id: 'L1',
  version_id: 'V1',
  page_id: 'P1',
  anchor: null,
  scope: { mode: 'lecture_only', source_ids: ['L1'], version_ids: ['V1'], describe_ar: 'المحاضرة فقط', hash: 'lecture_only' },
  style: 'detailed',
  socratic: false,
  title: 'محادثة',
  created_at: 1,
  updated_at: 1,
  message_count: 0,
  last_message_preview: null,
} as unknown as ChatThreadView;
const art = {
  id: 'A1', lineage_id: 'A1', version_no: 1, kind: 'chat_answer', title: 'سؤال', primary_source_id: 'L1',
  scope: { mode: 'lecture_only', source_ids: ['L1'], version_ids: ['V1'], describe_ar: 'المحاضرة فقط' },
  params: {}, status: 'published', model: 'm', rules_version: 'r', coverage: null, is_frozen: false, stale_reason: null, created_at: 1, published_at: 1,
  blocks: [{ id: 'B1', block_key: 'b', section_key: null, ord: 0, kind: 'paragraph', content: { v: 1, paragraphs: [{ dir: 'ltr', runs: [{ t: 'Verified answer (TEST).' }] }] }, table: null, source_region_ids: [], status: 'complete', verification_status: 'not_applicable', meta: null }],
  claims: {}, removed: [{ text: 'Removed draft sentence (TEST).', reason_ar: 'لم تجتز التحقق.' }], abstain: null, anchor: null, parent_artifact_id: null, job_id: null, versions: [],
} as unknown as StudyArtifactView;

function stream() {
  const enc = new TextEncoder();
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => void (ctrl = c) });
  return {
    response: new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    push: (e: Record<string, unknown>) => ctrl.enqueue(enc.encode(`event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`)),
    close: () => ctrl.close(),
    fail: (err: unknown) => ctrl.error(err),
  };
}

function mount() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <ChatPanel sourceId="L1" page={page} anchor={null} anchorText={null} scope={scope} style="detailed" gate={{ available: true, state: 'available', reason: null }} online focusKey={0} />
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe('ChatPanel — streaming (H4)', () => {
  it('draft below the conversation, then the verified answer with the removed sentence shown as removed', async () => {
    const s = stream();
    const owner = { id: 'Q1', thread_id: 'T1', role: 'owner', status: 'final', style: 'detailed', content: { v: 1, paragraphs: [{ runs: [{ t: 'سؤال؟' }] }] }, artifact: null, abstain: null, reply_to_id: null, created_at: 1 } as unknown as ChatMessageView;
    const answer = { id: 'M1', thread_id: 'T1', role: 'assistant', status: 'final', style: 'detailed', content: { v: 1, paragraphs: [] }, artifact: art, abstain: null, reply_to_id: 'Q1', created_at: 2 } as unknown as ChatMessageView;
    let done = false;
    setFetchImpl(async (url, init) => {
      const method = (init.method ?? 'GET').toUpperCase();
      if (url === '/api/studybook/threads' && method === 'POST') return json({ thread, messages: [] });
      if (url.startsWith('/api/studybook/threads?')) return json({ threads: [] });
      if (url === '/api/studybook/threads/T1/messages/stream') return s.response;
      if (url === '/api/studybook/threads/T1') return json({ thread, messages: done ? [owner, answer] : [] });
      return json({ error: { code: 'NOT_FOUND', message: 'غير موجود' } }, 404);
    });
    mount();
    fireEvent.change(screen.getByLabelText('سؤالك عن هذا الموضع'), { target: { value: 'سؤال؟' } });
    fireEvent.click(screen.getByRole('button', { name: 'اسأل' }));
    await act(async () => {
      s.push({ type: 'draft', attempt: 1, blocks: [{ kind: 'paragraph', sentences: ['Verified answer (TEST).', 'Removed draft sentence (TEST).'] }], label_ar: 'مسودة لم تُتحقق بعد', note_ar: 'نص لم يُتحقق منه.' });
    });
    const draft = await screen.findByRole('region', { name: 'مسودة لم تُتحقق بعد' });
    expect(draft.closest('[aria-live]')).toBeNull();
    expect(draft.textContent).toContain('Removed draft sentence (TEST).');
    done = true;
    await act(async () => {
      s.push({ type: 'final', result: { owner_message: owner, answer }, removed: art.removed, had_draft: true });
      s.close();
    });
    await waitFor(() => expect(screen.queryByRole('region', { name: 'مسودة لم تُتحقق بعد' })).toBeNull());
    expect(await screen.findByText('Verified answer (TEST).')).toBeTruthy();
    const outcome = screen.getByRole('region', { name: 'ما تغيّر عن المسودة' });
    expect(outcome.querySelector('del')!.textContent).toContain('Removed draft sentence (TEST).');
  });

  it('«أوقف» cancels: the request is aborted and the draft disappears', async () => {
    const s = stream();
    let signal: AbortSignal | undefined;
    setFetchImpl(async (url, init) => {
      const method = (init.method ?? 'GET').toUpperCase();
      if (url === '/api/studybook/threads' && method === 'POST') return json({ thread, messages: [] });
      if (url.startsWith('/api/studybook/threads?')) return json({ threads: [] });
      if (url === '/api/studybook/threads/T1/messages/stream') {
        signal = init.signal ?? undefined;
        signal?.addEventListener('abort', () => s.fail(new DOMException('aborted', 'AbortError')));
        return s.response;
      }
      if (url === '/api/studybook/threads/T1') return json({ thread, messages: [] });
      return json({ error: { code: 'NOT_FOUND', message: 'غير موجود' } }, 404);
    });
    mount();
    fireEvent.change(screen.getByLabelText('سؤالك عن هذا الموضع'), { target: { value: 'سؤال؟' } });
    fireEvent.click(screen.getByRole('button', { name: 'اسأل' }));
    await act(async () => {
      s.push({ type: 'draft', attempt: 1, blocks: [{ kind: 'paragraph', sentences: ['Draft (TEST).'] }], label_ar: 'مسودة لم تُتحقق بعد', note_ar: 'x' });
    });
    expect(await screen.findByText('Draft (TEST).')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'أوقف' }));
    expect(signal!.aborted).toBe(true);
    await waitFor(() => expect(screen.queryByText('Draft (TEST).')).toBeNull());
    expect(await screen.findByText('أوقفتَ الإجابة؛ لم يُحفظ منها شيء.')).toBeTruthy();
  });
});
