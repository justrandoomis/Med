// Track F4 — handwritten written answers (§41): the pad's draft is kept on the device; «حوّل إلى نص» is disabled with
// the server's reason without a vision provider; after reading, the owner must review (and may edit) the text and
// confirm it before it can be saved; the saved answer is the CONFIRMED text with the machine reading and the reading
// id beside it — never the unconfirmed reading.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InkRecognitionView, WrittenQuestionView } from '@medlevo/shared';
import { getDb, kvSet } from '../../lib/localdb';
import { HandwrittenAnswer, type HandwrittenAnswerDeps } from './HandwrittenAnswer';

const view = { question_id: 'Q1', question_version_id: 'QV1', qtype: 'short_answer', stem: { v: 1, paragraphs: [] }, origin_label_ar: '', answer_status: 'not_applicable', has_rubric: true, attempts: [], occurrences: [] } as unknown as WrittenQuestionView;

const reading: InkRecognitionView = {
  id: 'REC9',
  purpose: 'written_answer',
  status: 'recognized',
  status_label_ar: 'قُرئت الكتابة',
  lang_requested: 'en',
  lang_detected: 'en',
  recognized_text: 'Ultrasound first in childern',
  lines: [{ words: [{ text: 'Ultrasound', uncertain: false }, { text: 'first', uncertain: false }, { text: 'in', uncertain: false }, { text: 'childern', uncertain: true }] }],
  uncertain_count: 1,
  corrected_text: null,
  corrected_at: null,
  effective_text: 'Ultrasound first in childern',
  origin: 'recognized',
  origin_label_ar: 'نص مقروء آليًا من خط يدك',
  annotation_ids: [],
  anchor: null,
  bbox: null,
  question_id: 'Q1',
  engine: 'fake',
  job_id: 'J',
  error_ar: null,
  image_url: '/api/annotations/recognitions/REC9/image',
  created_at: 1,
  updated_at: 1,
};

function deps(): HandwrittenAnswerDeps & { recognize: ReturnType<typeof vi.fn>; save: ReturnType<typeof vi.fn> } {
  return {
    render: () => ({ base64: 'iVBORw0KGgo=', dataUrl: 'data:image/png;base64,iVBORw0KGgo=', width: 1200, height: 400 }),
    recognize: vi.fn(async () => ({ ...reading, status: 'queued' as const })),
    wait: vi.fn(async () => reading) as never,
    save: vi.fn(async () => ({ attempt: {} as never })),
  };
}

beforeEach(async () => {
  // jsdom has no 2D canvas (the pad draws in Chromium; E2E covers it)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  await kvSet(getDb(), 'written-pad:Q1', [
    [
      [0.1, 0.1, 0],
      [0.2, 0.15, 20],
    ],
  ]);
});

describe('HandwrittenAnswer', () => {
  it('reads the pad, shows uncertain words, and saves only the text the owner confirmed', async () => {
    const d = deps();
    const onSaved = vi.fn();
    render(<HandwrittenAnswer view={view} online recognition={{ available: true, reason: null }} onSaved={onSaved} deps={d} />);
    const read = await screen.findByRole('button', { name: 'حوّل إلى نص' });
    await waitFor(() => expect((read as HTMLButtonElement).disabled).toBe(false)); // the draft strokes were restored
    fireEvent.click(read);
    await screen.findByText('راجع النص المقروء قبل الحفظ');
    expect(d.recognize).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'written_answer', question_id: 'Q1', strokes: [[[0.1, 0.1, 0], [0.2, 0.15, 20]]], image_png_base64: 'iVBORw0KGgo=' }));
    expect(document.querySelectorAll('mark[data-uncertain]')).toHaveLength(1);
    const save = screen.getByRole('button', { name: 'احفظ الإجابة المؤكَّدة' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true); // not confirmed yet
    const field = screen.getByLabelText('إجابتك كما تريد تقييمها') as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: 'Ultrasound first in children' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'راجعت النص، وهو إجابتي' }));
    expect(save.disabled).toBe(false);
    // editing after confirming asks for confirmation again
    fireEvent.change(field, { target: { value: 'Ultrasound first in children.' } });
    expect(save.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'راجعت النص، وهو إجابتي' }));
    fireEvent.click(save);
    await waitFor(() => expect(d.save).toHaveBeenCalledTimes(1));
    expect(d.save.mock.calls[0]![0]).toMatchObject({
      question_id: 'Q1',
      question_version_id: 'QV1',
      answer_text: 'Ultrasound first in children.',
      recognized_text: 'Ultrasound first in childern',
      recognized_confirmed: true,
      recognition_id: 'REC9',
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('without a vision provider the reading is disabled with the reason (typing stays available elsewhere)', async () => {
    const d = deps();
    const reason = 'قراءة الخط اليدوي تحتاج مزود ذكاء اصطناعي يقرأ الصور (vision) مضبوطًا على الخادم (ANTHROPIC_API_KEY)، وهو غير مضبوط.';
    render(<HandwrittenAnswer view={view} online recognition={{ available: false, reason }} onSaved={() => {}} deps={d} />);
    const read = (await screen.findByRole('button', { name: 'حوّل إلى نص' })) as HTMLButtonElement;
    expect(read.disabled).toBe(true);
    expect(screen.getByText(reason)).toBeTruthy();
    expect(d.recognize).not.toHaveBeenCalled();
  });
});
