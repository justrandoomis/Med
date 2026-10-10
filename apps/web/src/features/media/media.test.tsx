// Media web: time codes and overlay geometry, transcript filtering (Arabic normalization), the Image Quiz against a
// mocked server (neutral image with no answer anywhere in the DOM before answering, per-mask checks, self-mark,
// reveal only after finishing), and the recording screen (recording disabled with the reason; a typed segment is
// sent with its times; the original text stays visible beside a correction).
import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ImageDetailView, ImageQuizView, ImageSummaryView, TranscriptResponse, TranscriptSegmentView } from '@medlevo/shared';
import { ToastProvider } from '../../design';
import { setFetchImpl } from '../../lib/api';
import { AudioScreen } from './AudioScreen';
import { ImageDetail } from './ImageDetail';
import { ImageQuiz } from './ImageQuiz';
import { filterSegments, fitRect, formatMs, formatMsPrecise, parseTimecode, rectFromPoints } from './model';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
afterEach(() => setFetchImpl(null));

describe('media model', () => {
  it('time codes', () => {
    expect(formatMs(725_000)).toBe('12:05');
    expect(formatMs(3_723_000)).toBe('1:02:03');
    expect(parseTimecode('12:05')).toBe(725_000);
    expect(parseTimecode('١٢:٠٥')).toBe(725_000); // Arabic-Indic digits
    expect(parseTimecode('1:02:03')).toBe(3_723_000);
    expect(parseTimecode('75')).toBe(75_000);
    expect(parseTimecode('12:75')).toBeNull();
  });
  it('overlay geometry stays normalized inside the image, whatever the drag direction', () => {
    expect(rectFromPoints({ x: 0.8, y: 0.9 }, { x: 0.2, y: 0.1 })).toEqual({ type: 'rect', x: 0.2, y: 0.1, w: 0.6, h: 0.8 });
    expect(fitRect({ x: 0.9, y: 0.9, w: 0.3, h: 0.3 })).toEqual({ type: 'rect', x: 0.7, y: 0.7, w: 0.3, h: 0.3 });
  });
  it('filters transcript segments with Arabic normalization', () => {
    const seg = (id: string, t: string) => ({ id, display_text: t }) as TranscriptSegmentView;
    expect(filterSegments([seg('a', 'يبدأ الألم حول السرة'), seg('b', 'McBurney point')], 'الالم').map((s) => s.id)).toEqual(['a']);
  });
});

const image: ImageSummaryView = {
  id: 'IMG1',
  file_url: '/api/files/FILE1',
  origin: 'source',
  origin_badge: 'source_photo',
  origin_label_ar: 'صورة من المصدر',
  origin_note_ar: null,
  image_kind: 'radiology',
  image_kind_label_ar: 'أشعة (Radiology)',
  kind_origin: 'processing',
  title: null,
  caption: 'Figure 2: Chest X-ray showing a right pneumothorax',
  source: { id: 'S1', title: 'Chest atlas', source_type: 'image_atlas', deleted: false },
  page: { id: 'P1', page_index: 1, label_ar: 'ص 12' },
  version_id: 'V1',
  region_id: 'R1',
  modality: null,
  anatomic_region: null,
  age_group: null,
  topic: null,
  overlay_count: 1,
  quiz_ready_masks: 1,
  created_at: 1,
};

describe('image quiz', () => {
  it('nothing reveals the answer before answering; checks, self-mark and the reveal after finishing', async () => {
    let quiz: ImageQuizView = {
      id: 'QZ1',
      status: 'in_progress',
      image_url: '/api/media/quiz/QZ1/image',
      masks_rendered: 'server',
      masks: [{ key: 'm1', shape: { type: 'rect', x: 0.5, y: 0.5, w: 0.2, h: 0.2 }, answered: false }],
      prompt_ar: 'اكتب ما تخفيه كل منطقة مرقّمة.',
      answers: [],
      excluded: [{ reason_ar: 'التسمية غير مؤكدة، ولا تصبح جوابًا ثابتًا في الاختبار (AC-08).' }],
      created_at: 1,
    };
    const calls: Array<{ url: string; body: Record<string, unknown> | undefined }> = [];
    setFetchImpl(async (url, init) => {
      const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      calls.push({ url, body });
      if (url.endsWith('/api/media/quiz/QZ1')) return json(quiz);
      if (url.endsWith('/answer')) {
        const result = body!.self_mark_correct ? 'self_marked_correct' : 'incorrect';
        quiz = { ...quiz, masks: [{ ...quiz.masks[0]!, answered: true }], answers: [{ key: 'm1', result, answer: 'Haemothorax', expected: 'Pneumothorax' }] };
        return json({ key: 'm1', result, expected: 'Pneumothorax', quiz });
      }
      if (url.endsWith('/finish')) {
        quiz = { ...quiz, status: 'finished' };
        return json({ quiz, reveal: { image, labels: [{ key: 'm1', label: 'Pneumothorax', certainty_label_ar: 'حددتها بنفسك' }] } });
      }
      return json({}, 404);
    });
    const { container } = render(
      <ToastProvider>
        <MemoryRouter initialEntries={['/media/quiz/QZ1']}>
          <Routes>
            <Route path="/media/quiz/:quizId" element={<ImageQuiz />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>,
    );
    const img = await screen.findByAltText('صورة السؤال');
    expect(img.getAttribute('src')).toBe('/api/media/quiz/QZ1/image');
    for (const leak of ['Pneumothorax', 'pneumothorax', 'Figure 2', 'Chest', 'FILE1', 'IMG1']) expect(container.innerHTML).not.toContain(leak);
    expect(screen.getByText(/غير مؤكدة/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('المنطقة 1'), { target: { value: 'Haemothorax' } });
    fireEvent.click(screen.getByRole('button', { name: 'تحقّق' }));
    await screen.findByText('لم تطابق');
    expect(screen.getByText('Pneumothorax')).toBeTruthy(); // revealed for this mask only after answering
    fireEvent.click(screen.getByRole('button', { name: /كانت إجابتي صحيحة/ }));
    await screen.findByText('صحيحة بحكمك');
    expect(calls.filter((c) => c.url.endsWith('/answer'))[1]!.body).toMatchObject({ key: 'm1', self_mark_correct: true });

    fireEvent.click(screen.getByRole('button', { name: /أنهِ واكشف المصدر/ }));
    await screen.findByText('الصورة ومصدرها');
    expect(screen.getByText(/Chest X-ray showing a right pneumothorax/)).toBeTruthy();
  });
});

describe('recording screen', () => {
  it('recording is disabled with the reason; segments keep the original beside a correction; a new segment is sent with its times', async () => {
    const seg: TranscriptSegmentView = {
      id: 'SEG1',
      audio_id: 'AU1',
      start_ms: 1000,
      end_ms: 4000,
      text: 'pain begins around the umbilicus',
      corrected_text: 'Pain begins around the umbilicus (periumbilical).',
      display_text: 'Pain begins around the umbilicus (periumbilical).',
      origin: 'imported_vtt',
      origin_label_ar: 'مستورد من ملف ترجمة VTT',
      speaker: null,
      confidence: null,
      rev: 2,
      revisions: 2,
      links: [
        { id: 'L1', from_type: 'transcript_segment', from_id: 'SEG1', source_id: 'S1', source_title: 'Appendicitis', version_id: 'V1', page_id: 'P1', page_index: 1, page_label_ar: 'ص 12', region_id: null, region_preview: null, origin: 'auto', origin_label_ar: 'ربط تلقائي — قابل للتعديل، تحقق منه', confirmed: false, created_at: 1 },
      ],
      deleted: false,
      created_at: 1,
      updated_at: 2,
    };
    const data: TranscriptResponse = {
      audio: { id: 'AU1', source_id: 'S9', source_title: 'Lecture 3 recording', source_type: 'lecture_audio', version_id: 'V9', mime: 'audio/mpeg', size: 10, duration_ms: null, duration_origin: null, stream_url: '/api/media/audio/AU1/stream', segments: 1, corrected_segments: 1, links: 1, created_at: 1 },
      segments: [seg],
      imports: [],
      notes_ar: ['التفريغ الآلي غير متاح'],
    };
    const calls: Array<{ url: string; body: Record<string, unknown> | undefined }> = [];
    setFetchImpl(async (url, init) => {
      const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      calls.push({ url, body });
      if (url.includes('/api/media/audio/AU1/transcript')) return json(data);
      if (url.endsWith('/api/media/status'))
        return json({ recording: { state: 'not_implemented', reason_ar: 'التسجيل داخل التطبيق غير مبني في هذا الإصدار، لذلك لا يُشغَّل الميكروفون أبدًا.' }, transcription: { state: 'requires_configuration', reason_ar: 'التفريغ الآلي غير متاح' } });
      if (url.endsWith('/segments')) return json({ ...seg, id: 'SEG2' });
      return json({}, 404);
    });
    render(
      <ToastProvider>
        <MemoryRouter initialEntries={['/media/audio/AU1']}>
          <Routes>
            <Route path="/media/audio/:audioId" element={<AudioScreen />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>,
    );
    expect(await screen.findByText('Pain begins around the umbilicus (periumbilical).')).toBeTruthy();
    expect(screen.getByText('pain begins around the umbilicus')).toBeTruthy(); // original kept (in a disclosure)
    expect(screen.getByText('ربط تلقائي — قابل للتعديل، تحقق منه')).toBeTruthy();
    const rec = screen.getByRole('button', { name: 'سجّل' });
    expect((rec as HTMLButtonElement).disabled).toBe(true);
    await screen.findByText(/لا يُشغَّل الميكروفون/);
    fireEvent.change(screen.getByLabelText('النص كما سمعته'), { target: { value: 'ثم ينتقل الألم' } });
    fireEvent.change(screen.getAllByLabelText('من').at(-1)!, { target: { value: '0:05' } });
    fireEvent.change(screen.getAllByLabelText('إلى').at(-1)!, { target: { value: '0:09' } });
    fireEvent.click(screen.getByRole('button', { name: 'احفظ المقطع' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/segments'))).toBe(true));
    expect(calls.find((c) => c.url.endsWith('/segments'))!.body).toEqual({ start_ms: 5000, end_ms: 9000, text: 'ثم ينتقل الألم' });
  });

  // review regression: the edit form showed whole seconds, so correcting the text of an imported cue re-timed it
  // (12.345 s → 12 s) — and a cue shorter than a second inside one second could not be corrected at all
  it('correcting the text of an imported cue sends the correction only; its exact times are kept', async () => {
    const seg: TranscriptSegmentView = {
      id: 'SEG3',
      audio_id: 'AU1',
      start_ms: 12_345,
      end_ms: 12_800,
      text: 'appendix sitis',
      corrected_text: null,
      display_text: 'appendix sitis',
      origin: 'imported_vtt',
      origin_label_ar: 'مستورد من ملف ترجمة VTT',
      speaker: null,
      confidence: null,
      rev: 1,
      revisions: 1,
      links: [],
      deleted: false,
      created_at: 1,
      updated_at: 1,
    };
    const data: TranscriptResponse = {
      audio: { id: 'AU1', source_id: 'S9', source_title: 'Lecture 3 recording', source_type: 'lecture_audio', version_id: 'V9', mime: 'audio/mpeg', size: 10, duration_ms: null, duration_origin: null, stream_url: '/api/media/audio/AU1/stream', segments: 1, corrected_segments: 0, links: 0, created_at: 1 },
      segments: [seg],
      imports: [],
      notes_ar: [],
    };
    const calls: Array<{ url: string; method: string; body: Record<string, unknown> | undefined }> = [];
    setFetchImpl(async (url, init) => {
      const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      calls.push({ url, method: String(init.method ?? 'GET'), body });
      if (url.includes('/api/media/audio/AU1/transcript')) return json(data);
      if (url.endsWith('/api/media/status')) return json({ recording: { state: 'not_implemented', reason_ar: 'x' }, transcription: { state: 'requires_configuration', reason_ar: 'y' } });
      if (url.endsWith('/api/media/segments/SEG3')) return json({ ...seg, corrected_text: 'appendicitis', display_text: 'appendicitis', rev: 2 });
      return json({}, 404);
    });
    expect(formatMsPrecise(12_345)).toBe('0:12.345');
    expect(parseTimecode(formatMsPrecise(12_340))).toBe(12_340);
    render(
      <ToastProvider>
        <MemoryRouter initialEntries={['/media/audio/AU1']}>
          <Routes>
            <Route path="/media/audio/:audioId" element={<AudioScreen />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'صحّح' }));
    fireEvent.change(screen.getByLabelText('النص (يُحفظ تصحيحًا بجانب الأصل)'), { target: { value: 'appendicitis' } });
    fireEvent.click(screen.getByRole('button', { name: 'احفظ' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/api/media/segments/SEG3'))).toBe(true));
    expect(calls.find((c) => c.url.endsWith('/api/media/segments/SEG3'))!.body).toEqual({ base_rev: 1, corrected_text: 'appendicitis' });
  });
});

// review regression: a new overlay could only be drawn with a pointer drag (no keyboard path)
describe('image detail', () => {
  it('a mask can be added without a pointer: placed at the centre, positioned by numbers, saved with its certainty', async () => {
    const detail: ImageDetailView = { ...image, overlays: [], caption_region_id: null, match_status: 'unverified', notes_ar: [], overlay_count: 0, quiz_ready_masks: 0 };
    const calls: Array<{ url: string; method: string; body: Record<string, unknown> | undefined }> = [];
    setFetchImpl(async (url, init) => {
      const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      calls.push({ url, method: String(init.method ?? 'GET'), body });
      if (url.endsWith('/api/media/images/IMG1')) return json(detail);
      if (url.endsWith('/api/media/images/IMG1/overlays')) return json({});
      return json({}, 404);
    });
    render(
      <ToastProvider>
        <MemoryRouter initialEntries={['/media/images/IMG1']}>
          <Routes>
            <Route path="/media/images/:imageId" element={<ImageDetail />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>,
    );
    fireEvent.click(await screen.findByRole('radio', { name: 'قناع' }));
    fireEvent.click(screen.getByRole('button', { name: /أضفها في وسط الصورة/ }));
    fireEvent.change(screen.getByLabelText('ما يخفيه القناع (الجواب)'), { target: { value: 'Pneumothorax' } });
    fireEvent.change(screen.getByLabelText('من اليسار'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'احفظ الطبقة' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/overlays') && c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.url.endsWith('/overlays'))!.body).toMatchObject({ kind: 'occlusion_mask', label: 'Pneumothorax', certainty: 'owner', shape: { type: 'rect', x: 0.1, y: 0.4, w: 0.2, h: 0.2 } });
  });
});
