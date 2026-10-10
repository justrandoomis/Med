// G2 / AC-05 regression (web): a question in the rail is always answered under the Source Lock the rail SHOWS.
// Found by the G2 acceptance review: after «وسّع النطاق» in a chat answer, the conversation continued in the WIDER
// thread while the rail's lock still read «المحاضرة فقط»; and after the owner narrowed the lock back to «المحاضرة
// فقط» in the picker, the next question was still sent to the wider thread — answered from the out-of-scope
// reference although «Lecture Only» was selected. Now: widening in the chat moves the rail's lock with it (an
// explicit owner action), a changed lock starts a new conversation, and the open thread shows its own lock.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  FEATURE_KEYS,
  type CapabilitiesResponse,
  type ChatMessageView,
  type ChatThreadView,
  type SourcePageView,
  type SourceScope,
  type StudyArtifactView,
} from '@medlevo/shared';
import { ToastProvider } from '../../../design';
import { setFetchImpl } from '../../../lib/api';
import { capabilitiesStore } from '../../../lib/capabilities';
import type { SourceDocument } from '../data/useSourceDocument';
import { aiRequestStore } from '../model/aiActions';
import { ExplainTab } from '../panels/ExplainTab';
import { threadMatchesScope } from '../../studybook/model';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function caps(): CapabilitiesResponse {
  const features = Object.fromEntries(FEATURE_KEYS.map((k) => [k, { key: k, state: 'available' }])) as CapabilitiesResponse['features'];
  return { features, ai: { configured: true }, server_time: 0, app_version: 'test' };
}

const L = 'G2L';
const R = 'G2R';
const pages = [{ id: 'G2P0', page_index: 0, printed_label: '11', kind: 'page', version_id: 'G2V', has_images: false }] as unknown as SourcePageView[];
const doc = {
  detail: { id: L, title: 'Acute Appendicitis', language: 'en', links: [{ relation: 'reference_for', from_source_id: R, to_source_id: L, other_title: 'Cholecystitis reference', other_type: 'course_reference' }] },
  version: { id: 'G2V' },
  pages,
} as unknown as SourceDocument;

const WIDER: SourceScope = { mode: 'lecture_plus_references', lecture_source_id: L, reference_source_ids: [R], version_pins: { [L]: 'G2V' }, include_my_notes: false };

function artifactFor(scope: SourceScope, abstain: boolean): StudyArtifactView {
  const wide = scope.mode !== 'lecture_only';
  return {
    id: `A-${Math.random().toString(36).slice(2)}`,
    lineage_id: 'x',
    version_no: 1,
    kind: 'chat_answer',
    title: 'سؤال: Murphy',
    primary_source_id: L,
    scope: { mode: scope.mode, source_ids: wide ? [L, R] : [L], version_ids: wide ? ['G2V', 'G2RV'] : ['G2V'], describe_ar: wide ? 'المحاضرة + المراجع' : 'المحاضرة فقط' },
    params: {},
    status: 'published',
    model: 'fake',
    rules_version: 'r',
    coverage: null,
    is_frozen: false,
    stale_reason: null,
    created_at: 1,
    published_at: 1,
    blocks: abstain ? [] : [{ id: 'B1', block_key: 'b1', section_key: null, ord: 0, kind: 'paragraph', content: { v: 1, paragraphs: [{ runs: [{ t: 'Answer from the reference.' }] }] }, table: null, source_region_ids: [], status: 'complete', verification_status: 'linked', meta: null }],
    claims: {},
    removed: [],
    abstain: abstain ? { reason: 'not_found_in_scope', reason_ar: 'لم أجد هذه المعلومة في المصادر المسموحة ضمن النطاق الحالي.', suggest_scope: WIDER } : null,
    anchor: null,
    parent_artifact_id: null,
    job_id: null,
    versions: [],
  } as unknown as StudyArtifactView;
}

interface Call {
  method: string;
  url: string;
  body: Record<string, unknown> | null;
}

function server() {
  const calls: Call[] = [];
  const threads = new Map<string, { view: ChatThreadView; scope: SourceScope; messages: ChatMessageView[] }>();
  let n = 0;
  setFetchImpl(async (url, init) => {
    const method = (init.method ?? 'GET').toUpperCase();
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({ method, url, body });
    if (url.startsWith('/api/studybook/artifacts')) return json({ artifacts: [] });
    if (url === '/api/evidence/scope/resolve') {
      const s = body as unknown as SourceScope;
      const wide = s.mode !== 'lecture_only';
      return json({
        scope: { mode: s.mode, sourceIds: wide ? [L, R] : [L], versionIds: ['G2V'], versionBySource: {}, allowExternal: false, includeMyNotes: false, hash: s.mode, describeAr: s.mode },
        sources: [{ source_id: L, title: 'Acute Appendicitis', source_type: 'lecture', version_id: 'G2V', version_no: 1, origin: 'lecture', pinned: false, frozen: false, newer_version_exists: false, processing_status: 'ready', low_assurance: false }],
        excluded: [],
      });
    }
    if (url === '/api/studybook/threads' && method === 'POST') {
      const scope = body!.scope as SourceScope;
      const id = `T${++n}`;
      const wide = scope.mode !== 'lecture_only';
      const view = {
        id,
        source_id: L,
        version_id: 'G2V',
        page_id: 'G2P0',
        anchor: null,
        scope: { mode: scope.mode, source_ids: wide ? [L, R] : [L], version_ids: ['G2V'], describe_ar: wide ? 'المحاضرة + المراجع — Acute Appendicitis؛ Cholecystitis reference' : 'المحاضرة فقط — Acute Appendicitis', hash: scope.mode },
        style: 'detailed',
        socratic: false,
        title: 'محادثة حول هذه الصفحة',
        created_at: n,
        updated_at: n,
        message_count: 0,
        last_message_preview: null,
      } as ChatThreadView;
      threads.set(id, { view, scope, messages: [] });
      return json({ thread: view, messages: [] });
    }
    if (url.startsWith('/api/studybook/threads?') || url === '/api/studybook/threads') return json({ threads: [...threads.values()].map((t) => t.view) });
    const msg = /^\/api\/studybook\/threads\/([^/]+)\/messages$/.exec(url);
    if (msg && method === 'POST') {
      const t = threads.get(msg[1]!)!;
      const narrow = t.scope.mode === 'lecture_only';
      const owner: ChatMessageView = { id: `${msg[1]}-q${t.messages.length}`, thread_id: t.view.id, role: 'owner', status: 'final', style: 'detailed', content: { v: 1, paragraphs: [{ runs: [{ t: String(body!.text) }] }] }, artifact: null, abstain: null, reply_to_id: null, created_at: 1 } as unknown as ChatMessageView;
      const art = artifactFor(t.scope, narrow);
      const answer: ChatMessageView = { id: `${msg[1]}-a${t.messages.length}`, thread_id: t.view.id, role: 'assistant', status: narrow ? 'abstained' : 'final', style: 'detailed', content: { v: 1, paragraphs: [] }, artifact: art, abstain: art.abstain, reply_to_id: owner.id, created_at: 2 } as unknown as ChatMessageView;
      t.messages.push(owner, answer);
      return json({ owner_message: owner, answer });
    }
    const one = /^\/api\/studybook\/threads\/([^/?]+)$/.exec(url);
    if (one) {
      const t = threads.get(one[1]!)!;
      return json({ thread: t.view, messages: t.messages });
    }
    return json({ error: { code: 'NOT_FOUND', message: 'غير موجود' } }, 404);
  });
  return { calls, threads };
}

const railLock = () => document.querySelector('.sb-scope .ev-scope-badge')!.textContent ?? '';
const asks = (calls: Call[]) => calls.filter((c) => c.method === 'POST' && /\/messages$/.test(c.url));
const created = (calls: Call[]) => calls.filter((c) => c.method === 'POST' && c.url === '/api/studybook/threads').map((c) => (c.body!.scope as SourceScope).mode);

async function askQuestion(text: string) {
  fireEvent.change(screen.getByLabelText('سؤالك عن هذا الموضع'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'اسأل' }));
}

beforeEach(() => capabilitiesStore.reset(caps()));
afterEach(() => {
  setFetchImpl(null);
  capabilitiesStore.reset(null);
  aiRequestStore.clear();
});

describe('G2 AC-05 — the rail chat follows the visible Source Lock', () => {
  it('widening from an abstention moves the rail lock; narrowing it back starts a new Lecture Only conversation', async () => {
    const { calls } = server();
    render(
      <MemoryRouter>
        <ToastProvider>
          <ExplainTab doc={doc} page={pages[0]!} pageIndex={0} online />
        </ToastProvider>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('radio', { name: 'سؤال' }));
    expect(railLock()).toContain('المحاضرة فقط');

    // 1) Lecture Only: the answer is not in the lecture → abstention with an explicit wider-scope action
    await askQuestion("What is Murphy's sign?");
    expect(await screen.findByText('لم أجد هذه المعلومة في المصادر المسموحة ضمن النطاق الحالي.')).toBeTruthy();
    expect(created(calls)).toEqual(['lecture_only']);

    // 2) the owner widens explicitly → a NEW wider thread, and the rail lock now says so
    fireEvent.click(screen.getByRole('button', { name: 'وسّع النطاق' }));
    expect(await screen.findByText('Answer from the reference.')).toBeTruthy();
    expect(created(calls)).toEqual(['lecture_only', 'lecture_plus_references']);
    await waitFor(() => expect(railLock()).toContain('المحاضرة + المراجع'));
    // the open conversation shows its own lock
    const head = document.querySelector('.sb-messages .sb-row') as HTMLElement;
    expect(head.querySelector('.ev-scope-badge')?.textContent).toContain('المحاضرة + المراجع');

    // 3) the owner narrows the lock back to «المحاضرة فقط» in the picker
    fireEvent.click(screen.getByRole('button', { name: 'غيّر النطاق' }));
    fireEvent.click(screen.getByRole('radio', { name: /المحاضرة فقط/ }));
    const apply = screen.getByRole('button', { name: 'طبّق النطاق' });
    await waitFor(() => expect(apply).toHaveProperty('disabled', false), { timeout: 3000 });
    fireEvent.click(apply);
    await waitFor(() => expect(railLock()).toContain('المحاضرة فقط'));

    // 4) the next question is asked in a NEW Lecture Only thread — never in the wider one
    const asked = asks(calls).length;
    await askQuestion("And how is Murphy's sign elicited?");
    await waitFor(() => expect(asks(calls).length).toBe(asked + 1));
    expect(created(calls)).toEqual(['lecture_only', 'lecture_plus_references', 'lecture_only']);
    expect(asks(calls).at(-1)!.url).toBe('/api/studybook/threads/T3/messages');
  });

  it('threadMatchesScope: mode, lecture, chosen references and «ملاحظاتي» must all match', () => {
    const view = (mode: SourceScope['mode'], ids: string[]) => ({ scope: { mode, source_ids: ids, version_ids: [], describe_ar: '', hash: '' } }) as unknown as ChatThreadView;
    const lectureOnly: SourceScope = { mode: 'lecture_only', lecture_source_id: L, reference_source_ids: [], version_pins: {}, include_my_notes: false };
    expect(threadMatchesScope(view('lecture_only', [L]), lectureOnly)).toBe(true);
    expect(threadMatchesScope(view('lecture_plus_references', [L, R]), lectureOnly)).toBe(false);
    expect(threadMatchesScope(view('lecture_only', ['OTHER']), lectureOnly)).toBe(false);
    expect(threadMatchesScope(view('lecture_only', [L, 'NOTES']), lectureOnly)).toBe(false);
    expect(threadMatchesScope(view('lecture_only', [L, 'NOTES']), { ...lectureOnly, include_my_notes: true })).toBe(true);
    expect(threadMatchesScope(view('lecture_plus_references', [L, R]), WIDER)).toBe(true);
    expect(threadMatchesScope(view('lecture_plus_references', [L]), WIDER)).toBe(false);
    // «المحاضرة + المراجع» without an explicit list = the lecture's linked references (resolved by the server)
    expect(threadMatchesScope(view('lecture_plus_references', [L, R]), { ...WIDER, reference_source_ids: [] })).toBe(true);
  });
});
