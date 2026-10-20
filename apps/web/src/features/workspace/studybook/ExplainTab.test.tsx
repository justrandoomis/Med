// «الشرح والسؤال» rail tab against a mocked server: the not-configured state shows the server's reason (never a
// working-looking button), a verified explanation renders through ArtifactContent with its chip, an abstention shows
// its reason and widens the scope only on the owner's explicit click, server errors keep their specific title, the
// selection toolbar's request runs with the selection anchor, and Ask shows its own capability reason.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  FEATURE_KEYS,
  type CapabilitiesResponse,
  type EvidenceView,
  type ExplainResponse,
  type FeatureKey,
  type SourcePageView,
  type StudyArtifactView,
} from '@medlevo/shared';
import { ToastProvider } from '../../../design';
import { setFetchImpl } from '../../../lib/api';
import { capabilitiesStore } from '../../../lib/capabilities';
import type { SourceDocument } from '../data/useSourceDocument';
import { aiRequestStore } from '../model/aiActions';
import { ExplainTab } from '../panels/ExplainTab';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const AI_REASON = 'ميزات الذكاء الاصطناعي غير مفعّلة: لم يُضبط مفتاح مزود على الخادم (ANTHROPIC_API_KEY). باقي الميزات الحتمية تعمل دونه.';

function caps(state: 'available' | 'requires_configuration'): CapabilitiesResponse {
  const features = Object.fromEntries(FEATURE_KEYS.map((k) => [k, { key: k, state: 'available' }])) as CapabilitiesResponse['features'];
  for (const k of ['ai.explain', 'ai.chat', 'ai.summaries', 'ai.figure_explain', 'ai.study_book'] as FeatureKey[]) {
    features[k] = state === 'available' ? { key: k, state } : { key: k, state, reason_ar: AI_REASON };
  }
  return { features, ai: { configured: state === 'available' }, server_time: 0, app_version: 'test' };
}

let seq = 0;
function makeDoc(): { doc: SourceDocument; page: SourcePageView } {
  const id = `L${++seq}`; // the tab remembers its last result per source → a fresh source per test
  const pages = [
    { id: `${id}-P0`, page_index: 0, printed_label: '11', kind: 'page', version_id: `${id}-V1`, has_images: false },
    { id: `${id}-P1`, page_index: 1, printed_label: '12', kind: 'page', version_id: `${id}-V1`, has_images: true },
  ] as unknown as SourcePageView[];
  const doc = {
    detail: { id, title: 'Acute Appendicitis', language: 'en', links: [{ relation: 'reference_for', from_source_id: 'R1', to_source_id: id, other_title: 'Bailey & Love', other_type: 'textbook' }] },
    version: { id: `${id}-V1` },
    pages,
  } as unknown as SourceDocument;
  return { doc, page: pages[1]! };
}

const evidence = (over: Partial<EvidenceView> = {}): EvidenceView => ({
  id: 'E1',
  source_id: 'L1',
  source_title: 'Acute Appendicitis',
  source_type: 'lecture',
  version_id: 'V1',
  version_no: 1,
  page_id: 'P1',
  page_index: 1,
  locator_label_ar: 'ص 12 (الصفحة 2 في الملف)',
  region_id: 'R1',
  region_kind: 'paragraph',
  quote: 'Ultrasound is the first-line imaging test in children.',
  bbox: null,
  extraction_status: 'extracted',
  availability: 'available',
  ...over,
});

function artifact(over: Partial<StudyArtifactView> = {}): StudyArtifactView {
  return {
    id: 'A1',
    lineage_id: 'A1',
    version_no: 1,
    kind: 'explanation',
    title: 'شرح: Ultrasound is the first-line imaging test',
    primary_source_id: 'L1',
    scope: { mode: 'lecture_only', source_ids: ['L1'], version_ids: ['V1'], describe_ar: 'المحاضرة فقط — Acute Appendicitis (النسخة 1)' },
    params: { action: 'explain' },
    status: 'published',
    model: 'claude-opus-5-5',
    rules_version: 'r-1',
    coverage: null,
    is_frozen: false,
    stale_reason: null,
    created_at: 1,
    published_at: 1,
    blocks: [
      {
        id: 'B1',
        block_key: 'b1',
        section_key: null,
        ord: 0,
        kind: 'paragraph',
        content: { v: 1, paragraphs: [{ dir: 'rtl', runs: [{ t: 'الفحص التصويري الأول عند الأطفال هو ', claim: 'C1' }, { t: 'Ultrasound', dir: 'ltr', claim: 'C1' }, { t: '.', claim: 'C1' }] }] },
        table: null,
        source_region_ids: ['R1'],
        status: 'complete',
        verification_status: 'linked',
        meta: null,
      },
    ],
    claims: { C1: { id: 'C1', text: 'الفحص التصويري الأول عند الأطفال هو Ultrasound.', support_type: 'derived', verification_status: 'linked', citations: [{ evidence: evidence(), relation: 'supports' }], issues: [] } },
    removed: [],
    abstain: null,
    anchor: null,
    parent_artifact_id: null,
    job_id: null,
    versions: [],
    ...over,
  };
}

interface Call {
  method: string;
  url: string;
  body: unknown;
}

/** (Round 7 H4) the tab explains through the streaming endpoint: a JSON answer is served as its SSE `final` event */
const EXPLAIN = '/api/studybook/explain/stream';
async function asStream(res: Response): Promise<Response> {
  if (!res.ok) return res;
  const result = await res.json();
  const ev = (e: unknown) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`;
  const body = ev({ type: 'phase', phase: 'retrieving', label_ar: 'يُبحث…' }) + ev({ type: 'final', result, removed: [], had_draft: false });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function server(explain: (body: Record<string, unknown>, n: number) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  let n = 0;
  setFetchImpl(async (url, init) => {
    const method = (init.method ?? 'GET').toUpperCase();
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : null;
    calls.push({ method, url, body });
    if (url.startsWith('/api/studybook/artifacts')) return json({ artifacts: [] });
    if (url.startsWith('/api/studybook/threads')) return json({ threads: [] });
    if (url === EXPLAIN && method === 'POST') return asStream(await explain(body as Record<string, unknown>, ++n));
    return json({ error: { code: 'NOT_FOUND', message: 'غير موجود' } }, 404);
  });
  return calls;
}

function renderTab(doc: SourceDocument, page: SourcePageView) {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <ExplainTab doc={doc} page={page} pageIndex={1} online />
      </ToastProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  capabilitiesStore.reset(caps('available'));
});
afterEach(() => {
  setFetchImpl(null);
  capabilitiesStore.reset(null);
  aiRequestStore.clear();
});

describe('ExplainTab', () => {
  it('without an AI provider: the server’s reason is shown and the actions are disabled (nothing pretends to work)', async () => {
    capabilitiesStore.reset(caps('requires_configuration'));
    const calls = server(() => json({}));
    const { doc, page } = makeDoc();
    renderTab(doc, page);
    expect(screen.getByText('الشرح غير متاح الآن')).toBeTruthy();
    const reason = screen.getAllByText(AI_REASON)[0]!;
    const explain = screen.getByRole('button', { name: 'اشرح' });
    expect(explain).toHaveProperty('disabled', true);
    expect(explain.getAttribute('aria-describedby')).toBe(reason.closest('[id]')!.id);
    expect(screen.getByRole('button', { name: 'بسّط' })).toHaveProperty('disabled', true);
    // the figure action says why too
    expect(screen.getByText(new RegExp(`شرح الشكل: ${AI_REASON.slice(0, 20)}`))).toBeTruthy();
    // the page context and the Source Lock are visible before anything runs
    expect(screen.getByText(/لا يوجد تحديد؛ يُشرح ما في/)).toBeTruthy();
    expect(calls.some((c) => c.url === EXPLAIN)).toBe(false);
  });

  it('explains the page under the visible lock and renders the verified result with its evidence chip', async () => {
    const calls = server(() => json({ artifact: artifact(), cached: false } satisfies ExplainResponse));
    const { doc, page } = makeDoc();
    renderTab(doc, page);
    fireEvent.click(screen.getByRole('button', { name: 'اشرح' }));
    expect(await screen.findByRole('heading', { name: /شرح: Ultrasound/ })).toBeTruthy();
    const req = calls.find((c) => c.url === EXPLAIN)!.body as Record<string, unknown>;
    expect(req).toMatchObject({ action: 'explain', anchor: { source_id: doc.detail.id, page_id: page.id, version_id: page.version_id }, scope: { mode: 'lecture_only', lecture_source_id: doc.detail.id } });
    expect(req.level).toBeTruthy();
    expect(req.style).toBeTruthy();
    // generated label + a real chip (button) for the linked claim
    expect(screen.getByText('محتوى مولَّد من مصادرك')).toBeTruthy();
    expect(screen.getByRole('button', { name: /محاضرة ص12/ })).toBeTruthy();
    // Explain Until Understood is offered for a published explanation
    expect(screen.getByRole('button', { name: 'لم أفهم — اشرح بطريقة أخرى' })).toBeTruthy();
  });

  it('an abstention shows its reason; the scope widens ONLY on the owner’s click, then the request runs again', async () => {
    const wider = { mode: 'lecture_plus_references' as const, lecture_source_id: 'L', reference_source_ids: ['R1'], version_pins: {}, include_my_notes: false };
    const calls = server((_b, n) =>
      n === 1
        ? json({
            artifact: artifact({
              blocks: [],
              claims: {},
              abstain: { reason: 'not_found_in_scope', reason_ar: 'لم أجد هذه المعلومة في المصادر المسموحة ضمن النطاق الحالي.', detail: 'بُحث في 4 صفحات من المحاضرة.', suggest_scope: wider },
            }),
            cached: false,
          })
        : json({ artifact: artifact(), cached: false }),
    );
    const { doc, page } = makeDoc();
    renderTab(doc, page);
    fireEvent.click(screen.getByRole('button', { name: 'اشرح' }));
    expect(await screen.findByText('لم أجد هذه المعلومة في المصادر المسموحة ضمن النطاق الحالي.')).toBeTruthy();
    expect(screen.getByText('بُحث في 4 صفحات من المحاضرة.')).toBeTruthy();
    expect(calls.filter((c) => c.url === EXPLAIN)).toHaveLength(1); // nothing widened by itself
    fireEvent.click(screen.getByRole('button', { name: 'وسّع النطاق' }));
    await screen.findByRole('heading', { name: /شرح: Ultrasound/ });
    const second = calls.filter((c) => c.url === EXPLAIN)[1]!.body as { scope: unknown };
    expect(second.scope).toEqual(wider);
  });

  it('server errors keep their specific title and message (e.g. not configured, out of scope)', async () => {
    server(() => json({ error: { code: 'OUT_OF_SCOPE', message: 'التحديد من مصدر أو نسخة خارج النطاق المقفل (Source Lock).' } }, 409));
    const { doc, page } = makeDoc();
    renderTab(doc, page);
    fireEvent.click(screen.getByRole('button', { name: 'اشرح' }));
    expect(await screen.findByText('خارج نطاق المصادر')).toBeTruthy();
    expect(screen.getByText('التحديد من مصدر أو نسخة خارج النطاق المقفل (Source Lock).')).toBeTruthy();
  });

  it('a request from the selection toolbar runs with the selection anchor (quote) and shows the selection', async () => {
    const calls = server(() => json({ artifact: artifact({ title: 'تبسيط: التحديد' }), cached: false }));
    const { doc, page } = makeDoc();
    act(() => {
      aiRequestStore.request({
        action: 'simplify',
        anchor: { source_id: doc.detail.id, version_id: page.version_id, page_id: page.id, region_ids: [], quote: { exact: 'Ultrasound is the first-line imaging test in children.' } },
        text: 'Ultrasound is the first-line imaging test in children.',
        pageIndex: 1,
        rects: [],
      });
    });
    renderTab(doc, page);
    await screen.findByRole('heading', { name: 'تبسيط: التحديد' });
    const req = calls.find((c) => c.url === EXPLAIN)!.body as { action: string; anchor: { quote: { exact: string } } };
    expect(req.action).toBe('simplify');
    expect(req.anchor.quote.exact).toBe('Ultrasound is the first-line imaging test in children.');
    expect(screen.getByText('التحديد')).toBeTruthy();
    expect(aiRequestStore.get()).toBeNull(); // consumed once
  });

  it('Explain Until Understood re-teaches the explanation’s own passage and action, not whatever is selected now', async () => {
    const { doc, page } = makeDoc();
    const passage = { source_id: doc.detail.id, version_id: page.version_id, page_id: doc.pages[0]!.id, region_ids: ['R9'], quote: { exact: 'Pain starts around the umbilicus.' } };
    const calls = server((_b, n) => json({ artifact: artifact(n === 1 ? { title: 'تبسيط: Pain starts', params: { action: 'simplify' }, anchor: passage } : { id: 'A2', version_no: 2, title: 'تبسيط: Pain starts (2)' }), cached: false }));
    act(() => {
      aiRequestStore.request({ action: 'simplify', anchor: passage, text: passage.quote.exact, pageIndex: 0, rects: [] });
    });
    renderTab(doc, page);
    await screen.findByRole('heading', { name: 'تبسيط: Pain starts' });
    // the owner drops the selection (the tab now targets the current page) and asks for another way
    fireEvent.click(screen.getByRole('button', { name: 'استخدم الصفحة بدل التحديد' }));
    fireEvent.click(screen.getByRole('button', { name: 'لم أفهم — اشرح بطريقة أخرى' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'تشبيه' }));
    await screen.findByRole('heading', { name: 'تبسيط: Pain starts (2)' });
    const retry = calls.filter((c) => c.url === EXPLAIN)[1]!.body as Record<string, unknown>;
    expect(retry).toMatchObject({ action: 'simplify', anchor: passage, retry_of: { artifact_id: 'A1', strategy: 'analogy' } });
  });

  it('Ask: the composer is disabled with the chat capability’s reason when chat is not configured', async () => {
    const c = caps('available');
    c.features['ai.chat'] = { key: 'ai.chat', state: 'requires_configuration', reason_ar: AI_REASON };
    capabilitiesStore.reset(c);
    server(() => json({}));
    const { doc, page } = makeDoc();
    renderTab(doc, page);
    fireEvent.click(screen.getByRole('radio', { name: 'سؤال' }));
    const composer = await screen.findByLabelText('سؤالك عن هذا الموضع');
    expect(composer).toHaveProperty('disabled', true);
    await waitFor(() => expect(screen.getByRole('button', { name: 'اسأل' })).toHaveProperty('disabled', true));
    expect(screen.getAllByText(AI_REASON).length).toBeGreaterThan(0);
  });
});

// ───────── Round 7 H4 item 10 (§30): the streamed draft is labelled unverified, then REPLACED by the verified result ─────────
/** a stream the test writes into, event by event; `aborted` tells whether the tab cancelled the request */
function controlledStream() {
  const enc = new TextEncoder();
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => void (ctrl = c) });
  const state = { aborted: false };
  return {
    state,
    response: new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    push: (e: Record<string, unknown>) => ctrl.enqueue(enc.encode(`event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`)),
    close: () => ctrl.close(),
    fail: (err: unknown) => ctrl.error(err),
  };
}

describe('ExplainTab — streaming (H4)', () => {
  it('shows the draft labelled «مسودة لم تُتحقق بعد» without chips, then the verified result and the removed sentence as removed', async () => {
    const s = controlledStream();
    let headers: Record<string, string> = {};
    setFetchImpl(async (url, init) => {
      if (url.startsWith('/api/studybook/artifacts')) return json({ artifacts: [] });
      if (url.startsWith('/api/studybook/threads')) return json({ threads: [] });
      if (url === EXPLAIN) {
        headers = init.headers as Record<string, string>;
        return s.response;
      }
      return json({ error: { code: 'NOT_FOUND', message: 'غير موجود' } }, 404);
    });
    const { doc, page } = makeDoc();
    renderTab(doc, page);
    fireEvent.click(screen.getByRole('button', { name: 'اشرح' }));
    await waitFor(() => expect(headers['x-medlevo-csrf']).toBe('1'));
    await act(async () => {
      s.push({ type: 'phase', phase: 'generating', label_ar: 'يكتب النموذج مسودة…' });
      s.push({ type: 'draft', attempt: 1, blocks: [{ kind: 'paragraph', sentences: ['Ultrasound is the first-line imaging test.', 'Ultrasound replaces CT in adults (TEST-UNSUPPORTED).'] }], label_ar: 'مسودة لم تُتحقق بعد', note_ar: 'نص لم يُتحقق من أدلته بعد.' });
    });
    const draft = await screen.findByRole('region', { name: 'مسودة لم تُتحقق بعد' });
    expect(draft.getAttribute('aria-busy')).toBe('true');
    expect(draft.textContent).toContain('TEST-UNSUPPORTED');
    expect(draft.textContent).toContain('مسودة لم تُتحقق بعد');
    expect(draft.querySelectorAll('button.ev-chip, [data-claim]').length).toBe(0); // a draft cites nothing
    await act(async () => {
      s.push({ type: 'phase', phase: 'verifying', label_ar: 'يُتحقق من كل جملة طبية مقابل أدلتها…' });
      s.push({
        type: 'final',
        result: { artifact: artifact({ removed: [{ text: 'Ultrasound replaces CT in adults (TEST-UNSUPPORTED).', reason_ar: 'لا يدعمها أي دليل من النطاق.' }] }), cached: false },
        removed: [{ text: 'Ultrasound replaces CT in adults (TEST-UNSUPPORTED).', reason_ar: 'لا يدعمها أي دليل من النطاق.' }],
        had_draft: true,
      });
      s.close();
    });
    expect(await screen.findByRole('heading', { name: /شرح: Ultrasound/ })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'مسودة لم تُتحقق بعد' })).toBeNull();
    const outcome = screen.getByRole('region', { name: 'ما تغيّر عن المسودة' });
    expect(outcome.textContent).toContain('حُذفت منها جملة واحدة');
    const del = outcome.querySelector('del')!;
    expect(del.textContent).toContain('TEST-UNSUPPORTED');
    expect(outcome.textContent).toContain('لا يدعمها أي دليل من النطاق.');
  });

  it('«أوقف» cancels the request; nothing of the draft stays on screen', async () => {
    const s = controlledStream();
    let signal: AbortSignal | undefined;
    setFetchImpl(async (url, init) => {
      if (url.startsWith('/api/studybook/artifacts')) return json({ artifacts: [] });
      if (url.startsWith('/api/studybook/threads')) return json({ threads: [] });
      if (url === EXPLAIN) {
        signal = init.signal ?? undefined;
        signal?.addEventListener('abort', () => s.fail(new DOMException('aborted', 'AbortError')));
        return s.response;
      }
      return json({ error: { code: 'NOT_FOUND', message: 'غير موجود' } }, 404);
    });
    const { doc, page } = makeDoc();
    renderTab(doc, page);
    fireEvent.click(screen.getByRole('button', { name: 'اشرح' }));
    await waitFor(() => expect(signal).toBeTruthy());
    await act(async () => {
      s.push({ type: 'draft', attempt: 1, blocks: [{ kind: 'paragraph', sentences: ['Draft sentence (TEST).'] }], label_ar: 'مسودة لم تُتحقق بعد', note_ar: 'نص لم يُتحقق منه.' });
    });
    expect(await screen.findByText('Draft sentence (TEST).')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'أوقف' }));
    expect(signal!.aborted).toBe(true);
    await waitFor(() => expect(screen.queryByText('Draft sentence (TEST).')).toBeNull());
    // stopping is not an error
    expect(screen.queryByText('تعذّر إكمال الطلب')).toBeNull();
    expect(screen.queryByText(/تعذّر إكمال الشرح/)).toBeNull();
  });

  it('a restart (the first answer failed the structure) clears the draft and says why', async () => {
    const s = controlledStream();
    setFetchImpl(async (url) => {
      if (url.startsWith('/api/studybook/artifacts')) return json({ artifacts: [] });
      if (url.startsWith('/api/studybook/threads')) return json({ threads: [] });
      if (url === EXPLAIN) return s.response;
      return json({ error: { code: 'NOT_FOUND', message: 'غير موجود' } }, 404);
    });
    const { doc, page } = makeDoc();
    renderTab(doc, page);
    fireEvent.click(screen.getByRole('button', { name: 'اشرح' }));
    await act(async () => {
      s.push({ type: 'draft', attempt: 1, blocks: [{ kind: 'paragraph', sentences: ['First attempt (TEST).'] }], label_ar: 'مسودة لم تُتحقق بعد', note_ar: 'x' });
    });
    expect(await screen.findByText('First attempt (TEST).')).toBeTruthy();
    await act(async () => {
      s.push({ type: 'restart', attempt: 2, reason_ar: 'لم تطابق المسودة البنية المطلوبة، فأُلغيت وتُعاد كتابتها مرة واحدة.' });
    });
    await waitFor(() => expect(screen.queryByText('First attempt (TEST).')).toBeNull());
    expect(screen.getByText(/فأُلغيت وتُعاد كتابتها/)).toBeTruthy();
    await act(async () => {
      s.push({ type: 'error', error: { code: 'SCHEMA_REJECTED', message: 'رُفضت نتيجة الذكاء الاصطناعي لأنها لم تطابق البنية المطلوبة.' } });
      s.close();
    });
    expect(await screen.findByText(/رُفضت نتيجة الذكاء الاصطناعي/)).toBeTruthy();
  });
});
