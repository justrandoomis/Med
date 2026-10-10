// Track F4 — handwriting recognition in the web: the picture sent to the reader holds only the selected writing
// (cropped, normalized, highlighters left out); the dialog shows uncertain words as uncertain (not by colour alone),
// saves corrections beside the machine reading, disables reading with the server's reason when no vision provider
// exists, and «اسأل عن المحدد» hands a composed question to the chat composer without sending anything.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AskContextResponse, InkData, InkRecognitionView, SourcePageView } from '@medlevo/shared';
import { ToastProvider } from '../../../design';
import { setFetchImpl } from '../../../lib/api';
import { makeInkItem, makeShapeItem, type InkItem } from '../ink/model';
import { ChatPanel } from '../studybook/ChatPanel';
import { matchingRecognition, RecognitionDialog, writingIds, type RecognitionDialogDeps, type RecognitionTarget } from './RecognitionDialog';
import { planPixels, planRaster, writingPolylines } from './raster';
import { lineDir, RecognizedLines } from './RecognizedText';

const anchor = { type: 'page' as const, source_id: 'S1', version_id: 'V1', page_id: 'P1', page_index: 0, space: 'page_norm' as const };
const pen = { tool: 'pen' as const, color: 'ink-black', width: 0.0025 };

function stroke(id: string, pts: Array<[number, number]>, style: InkData['style'] = pen): InkItem {
  return makeInkItem({ id, anchor, now: 1, z: 1, style, points: pts.map(([x, y], i) => [x, y, i * 16]), pressureAvailable: false, tiltAvailable: false, pointerType: 'mouse' });
}

function view(over: Partial<InkRecognitionView> = {}): InkRecognitionView {
  return {
    id: 'REC1',
    purpose: 'page_ink',
    status: 'recognized',
    status_label_ar: 'قُرئت الكتابة',
    lang_requested: 'mixed',
    lang_detected: 'mixed',
    recognized_text: 'ليش؟ Rebound',
    lines: [{ words: [{ text: 'ليش؟', uncertain: false }, { text: 'Rebound', uncertain: true, alternatives: ['Rebind'] }] }],
    uncertain_count: 1,
    corrected_text: null,
    corrected_at: null,
    effective_text: 'ليش؟ Rebound',
    origin: 'recognized',
    origin_label_ar: 'نص مقروء آليًا من خط يدك — نتيجة مشتقة قد تحتوي أخطاء، والحبر الأصلي محفوظ كما كتبته',
    annotation_ids: ['A1', 'A2'],
    anchor: null,
    bbox: null,
    question_id: null,
    engine: 'fake',
    job_id: 'J1',
    error_ar: null,
    image_url: '/api/annotations/recognitions/REC1/image',
    created_at: 1,
    updated_at: 1,
    ...over,
  };
}

afterEach(() => setFetchImpl(null));

describe('the picture sent to the reader', () => {
  it('holds only pen writing (highlighters left out, shapes as outlines), cropped and normalized', () => {
    const a = stroke('A1', [
      [0.5, 0.2],
      [0.6, 0.21],
    ]);
    const hl = stroke('H1', [
      [0.1, 0.9],
      [0.9, 0.9],
    ], { tool: 'highlighter', color: 'hl-yellow', width: 0.02 });
    const shape = makeShapeItem({ id: 'SH', anchor, now: 1, z: 2, shape: 'line', from: [0.5, 0.25], to: [0.6, 0.25], style: pen });
    const lines = writingPolylines([a, hl, shape], 842 / 595);
    expect(lines).toHaveLength(2); // the highlighter is not writing
    const plan = planRaster(lines)!;
    // a short word stays a small picture (not a whole page), within limits
    expect(plan.width).toBeLessThanOrEqual(1568);
    expect(plan.width).toBeGreaterThan(300);
    expect(plan.height).toBeGreaterThanOrEqual(32);
    expect(plan.lineWidth).toBeGreaterThanOrEqual(2);
    expect(plan.lineWidth).toBeLessThanOrEqual(10);
    // every point is inside the picture with its padding
    for (const l of planPixels(plan)) for (const [x, y] of l) {
      expect(x).toBeGreaterThanOrEqual(15);
      expect(x).toBeLessThanOrEqual(plan.width - 15);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(plan.height);
    }
    // a whole-page selection is scaled down to the long edge
    const big = planRaster([[[0, 0], [1, 1.4]]])!;
    expect(Math.max(big.width, big.height)).toBeLessThanOrEqual(1568);
    expect(planRaster([])).toBeNull();
  });

  it('an earlier reading is reused only for exactly the same strokes', () => {
    expect(writingIds([stroke('A1', [[0.1, 0.1]]), stroke('A2', [[0.2, 0.2]])])).toEqual(['A1', 'A2']);
    expect(matchingRecognition([view()], ['A2', 'A1'])?.id).toBe('REC1');
    expect(matchingRecognition([view()], ['A1'])).toBeNull();
    expect(matchingRecognition([view({ purpose: 'written_answer' })], ['A1', 'A2'])).toBeNull();
  });
});

describe('uncertain words', () => {
  it('are marked by a dotted underline AND a «؟» AND a spoken label — never colour alone', () => {
    const { container } = render(<RecognizedLines lines={view().lines} />);
    const marks = container.querySelectorAll('mark[data-uncertain]');
    expect(marks).toHaveLength(1);
    expect(marks[0]!.textContent).toContain('Rebound');
    expect(marks[0]!.textContent).toContain('؟');
    expect(marks[0]!.textContent).toContain('كلمة غير مؤكدة');
    expect(marks[0]!.getAttribute('title')).toContain('Rebind');
    // each word keeps its own direction
    expect(container.querySelector('bdi[dir="ltr"]')!.textContent).toBe('Rebound');
    expect(lineDir({ words: [{ text: 'ليش', uncertain: false }] })).toBe('rtl');
  });
});

const target = (mode: 'convert' | 'ask' = 'convert'): RecognitionTarget => ({
  mode,
  targetKey: 'source_page:P1',
  anchor,
  items: [stroke('A1', [[0.85, 0.22], [0.88, 0.23]]), stroke('A2', [[0.86, 0.24], [0.9, 0.25]])],
  bbox: { x: 0.84, y: 0.21, w: 0.08, h: 0.05 },
  ar: 842 / 595,
});

function deps(over: Partial<NonNullable<RecognitionDialogDeps['api']>> = {}): RecognitionDialogDeps & { api: NonNullable<RecognitionDialogDeps['api']> } {
  const api = {
    list: vi.fn(async () => [] as InkRecognitionView[]),
    create: vi.fn(async () => view({ status: 'queued', status_label_ar: 'في انتظار القراءة', lines: [], recognized_text: '', effective_text: '' })),
    get: vi.fn(async () => view()),
    correct: vi.fn(async (_id: string, t: string | null) => view(t === null ? {} : { corrected_text: t, effective_text: t, origin: 'owner_corrected', origin_label_ar: 'صحّحتَ هذه القراءة بنفسك' })),
    retry: vi.fn(async () => view()),
    remove: vi.fn(async () => ({ ok: true as const })),
    askContext: vi.fn(async (): Promise<AskContextResponse> => ({
      handwriting: { text: 'ليش؟', origin: 'recognized', uncertain_count: 0 },
      paragraph: { region_id: 'R1', text: 'Rebound tenderness indicates peritoneal irritation.', relation: 'beside' },
      anchor: { source_id: 'S1', version_id: 'V1', page_id: 'P1', region_ids: ['R1'], quote: { exact: 'Rebound tenderness indicates peritoneal irritation.' } },
      question_ar: 'كتبتُ بخط يدي «ليش؟» بجانب هذه الفقرة:\n«Rebound tenderness indicates peritoneal irritation.»\nأجبني عمّا كتبتُه.',
      notes_ar: ['لا يُرسل شيء تلقائيًا: راجع السؤال وعدّله ثم أرسله بنفسك.'],
    })),
    ...over,
  };
  return {
    api: api as never,
    render: () => ({ base64: 'iVBORw0KGgo=', dataUrl: 'data:image/png;base64,iVBORw0KGgo=', width: 400, height: 120 }),
    wait: vi.fn(async (id: string) => (api.get as (id: string) => Promise<InkRecognitionView>)(id)) as never,
    syncNow: vi.fn(async () => undefined),
  };
}

describe('«تحويل إلى نص»', () => {
  it('shows the exact picture, reads it, marks uncertain words, and saves a correction beside the machine reading', async () => {
    const d = deps();
    render(
      <ToastProvider>
        <RecognitionDialog target={target()} onClose={() => {}} recognition={{ available: true, reason: null }} chat={{ available: true, reason: null }} online onAsk={() => {}} deps={d} />
      </ToastProvider>,
    );
    expect(screen.getByRole('img', { name: /الكتابة المحددة كما تُرسل/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'اقرأ الخط' }));
    await waitFor(() => expect(d.api.create).toHaveBeenCalledTimes(1));
    const req = (d.api.create as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(req).toMatchObject({ purpose: 'page_ink', lang: 'mixed', annotation_ids: ['A1', 'A2'], anchor: { type: 'page', page_id: 'P1' }, image_png_base64: 'iVBORw0KGgo=' });
    expect(d.syncNow).toHaveBeenCalled(); // pending writing is pushed first
    await screen.findByText('مقروء آليًا');
    expect(screen.getByText(/كلمة واحدة غير مؤكدة/)).toBeTruthy();
    expect(document.querySelectorAll('mark[data-uncertain]')).toHaveLength(1);
    const field = screen.getByLabelText('صحّح النص إن لزم') as HTMLTextAreaElement;
    expect(field.value).toBe('ليش؟ Rebound');
    fireEvent.change(field, { target: { value: 'ليش؟ Rebound tenderness' } });
    fireEvent.click(screen.getByRole('button', { name: 'احفظ التصحيح' }));
    await waitFor(() => expect(d.api.correct).toHaveBeenCalledWith('REC1', 'ليش؟ Rebound tenderness'));
    await screen.findByText('صحّحته بنفسك');
    expect(screen.getByText(/الحبر لم يتغير/)).toBeTruthy();
  });

  it('without a vision provider: reading is disabled with the server reason; an earlier reading of the same strokes is shown', async () => {
    const reason = 'قراءة الخط اليدوي تحتاج مزود ذكاء اصطناعي يقرأ الصور (vision) مضبوطًا على الخادم (ANTHROPIC_API_KEY)، وهو غير مضبوط.';
    const d = deps();
    render(<RecognitionDialog target={target()} onClose={() => {}} recognition={{ available: false, reason }} chat={{ available: false, reason: 'x' }} online onAsk={() => {}} deps={d} />);
    const btn = screen.getByRole('button', { name: 'اقرأ الخط' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(screen.getByText(reason)).toBeTruthy();
    expect(d.api.create).not.toHaveBeenCalled();

    const again = deps({ list: vi.fn(async () => [view()]) });
    render(<RecognitionDialog target={target()} onClose={() => {}} recognition={{ available: false, reason }} chat={{ available: false, reason: 'x' }} online onAsk={() => {}} deps={again} />);
    await screen.findByText('مقروء آليًا');
  });

  it('an abstention says why and the owner can type what it says', async () => {
    const d = deps({ get: vi.fn(async () => view({ status: 'unreadable', recognized_text: '', effective_text: '', lines: [], uncertain_count: 0, error_ar: 'تعذّرت قراءة الكتابة: الخطوط متداخلة' })) });
    render(<RecognitionDialog target={target()} onClose={() => {}} recognition={{ available: true, reason: null }} chat={{ available: true, reason: null }} online onAsk={() => {}} deps={d} />);
    fireEvent.click(screen.getByRole('button', { name: 'اقرأ الخط' }));
    await screen.findByText('تعذّرت القراءة');
    expect(screen.getByText(/الخطوط متداخلة/)).toBeTruthy();
    expect(screen.getByLabelText('اكتب ما كتبته بخط يدك')).toBeTruthy();
  });
});

describe('«اسأل عن المحدد»', () => {
  it('composes the handwriting + the paragraph next to it and hands it to the chat composer (nothing is sent)', async () => {
    const onAsk = vi.fn();
    const d = deps({ list: vi.fn(async () => [view()]) });
    render(<RecognitionDialog target={target('ask')} onClose={() => {}} recognition={{ available: true, reason: null }} chat={{ available: false, reason: 'المحادثة تتطلب ضبط مزود ذكاء اصطناعي.' }} online onAsk={onAsk} deps={d} />);
    await screen.findByText('مقروء آليًا');
    fireEvent.click(screen.getByRole('button', { name: 'جهّز السؤال مع الفقرة المجاورة' }));
    await waitFor(() => expect(d.api.askContext).toHaveBeenCalledWith({ anchor: { type: 'page', source_id: 'S1', version_id: 'V1', page_id: 'P1', page_index: 0 }, bbox: target().bbox, recognition_id: 'REC1', typed_text: null }));
    const q = (await screen.findByLabelText('سؤالك (يمكنك تعديله)')) as HTMLTextAreaElement;
    expect(q.value).toContain('«ليش؟»');
    expect(q.value).toContain('Rebound tenderness');
    // the chat's own state is shown honestly (requires configuration here)
    expect(screen.getByText(/المحادثة تتطلب ضبط مزود/)).toBeTruthy();
    fireEvent.change(q, { target: { value: `${q.value} باختصار` } });
    fireEvent.click(screen.getByRole('button', { name: 'ضع السؤال في لوحة الدراسة' }));
    expect(onAsk).toHaveBeenCalledWith({
      anchor: { source_id: 'S1', version_id: 'V1', page_id: 'P1', region_ids: ['R1'], quote: { exact: 'Rebound tenderness indicates peritoneal irritation.' } },
      text: 'Rebound tenderness indicates peritoneal irritation.',
      question: expect.stringContaining('باختصار'),
      pageIndex: 0,
    });
  });

  it('(review) «رجوع» from the composed question returns to the reading (no second reading offered)', async () => {
    const d = deps({ list: vi.fn(async () => [view()]) });
    render(<RecognitionDialog target={target('ask')} onClose={() => {}} recognition={{ available: true, reason: null }} chat={{ available: true, reason: null }} online onAsk={() => {}} deps={d} />);
    await screen.findByText('مقروء آليًا');
    fireEvent.click(screen.getByRole('button', { name: 'جهّز السؤال مع الفقرة المجاورة' }));
    await screen.findByLabelText('سؤالك (يمكنك تعديله)');
    fireEvent.click(screen.getByRole('button', { name: 'رجوع' }));
    await screen.findByText('مقروء آليًا');
    expect(screen.queryByRole('button', { name: 'اقرأ الخط' })).toBeNull();
    expect((screen.getByLabelText('صحّح النص إن لزم') as HTMLTextAreaElement).value).toBe('ليش؟ Rebound');
  });

  it('when nothing can read the writing, the owner types it (typed_text is sent instead of a reading)', async () => {
    const d = deps();
    render(<RecognitionDialog target={target('ask')} onClose={() => {}} recognition={{ available: false, reason: 'لا يوجد مزود رؤية.' }} chat={{ available: true, reason: null }} online onAsk={() => {}} deps={d} />);
    const btn = screen.getByRole('button', { name: 'جهّز السؤال مع الفقرة المجاورة' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('ما الذي كتبته بخط يدك؟'), { target: { value: 'why?' } });
    fireEvent.click(btn);
    await waitFor(() => expect(d.api.askContext).toHaveBeenCalledWith(expect.objectContaining({ recognition_id: null, typed_text: 'why?' })));
  });

  it('the chat composer receives the composed question with the focus hand-over; no message is posted', async () => {
    const calls: string[] = [];
    setFetchImpl(async (input) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ threads: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const page = { id: 'P1', version_id: 'V1', page_index: 0 } as unknown as SourcePageView;
    render(
      <ToastProvider>
        <ChatPanel
          sourceId="S1"
          page={page}
          anchor={{ source_id: 'S1', version_id: 'V1', page_id: 'P1', region_ids: ['R1'] }}
          anchorText="Rebound tenderness"
          scope={{ mode: 'lecture_only', lecture_source_id: 'S1', reference_source_ids: [], version_pins: {}, include_my_notes: false }}
          style="detailed"
          gate={{ available: true, reason: null, state: 'available' } as never}
          online
          focusKey={1}
          prefill="كتبتُ بخط يدي «ليش؟» بجانب هذه الفقرة"
        />
      </ToastProvider>,
    );
    const composer = (await screen.findAllByRole('textbox')).find((el) => (el as HTMLTextAreaElement).value.includes('ليش؟')) as HTMLTextAreaElement;
    expect(composer).toBeTruthy();
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls.some((u) => u.includes('/messages'))).toBe(false);
  });

  it('(review) the composed question joins an unsent draft in the composer instead of erasing it', async () => {
    setFetchImpl(async () => new Response(JSON.stringify({ threads: [] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const page = { id: 'P1', version_id: 'V1', page_index: 0 } as unknown as SourcePageView;
    const props = {
      sourceId: 'S1',
      page,
      anchor: { source_id: 'S1', version_id: 'V1', page_id: 'P1', region_ids: ['R1'] },
      anchorText: 'Rebound tenderness',
      scope: { mode: 'lecture_only', lecture_source_id: 'S1', reference_source_ids: [], version_pins: {}, include_my_notes: false },
      style: 'detailed',
      gate: { available: true, reason: null, state: 'available' },
      online: true,
    } as never as Parameters<typeof ChatPanel>[0];
    const r = render(
      <ToastProvider>
        <ChatPanel {...props} focusKey={0} />
      </ToastProvider>,
    );
    const composer = (await screen.findByLabelText('سؤالك عن هذا الموضع')) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: 'مسودتي غير المرسلة' } });
    r.rerender(
      <ToastProvider>
        <ChatPanel {...props} focusKey={1} prefill="كتبتُ بخط يدي «ليش؟»" />
      </ToastProvider>,
    );
    await waitFor(() => expect(composer.value).toContain('«ليش؟»'));
    expect(composer.value).toContain('مسودتي غير المرسلة');
  });
});
