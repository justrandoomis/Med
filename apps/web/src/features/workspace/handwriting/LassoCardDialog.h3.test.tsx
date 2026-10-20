// Round 7 — H3 item 4 (§28/§29 «حوّل المحدد إلى بطاقة … أو سؤال»): the lasso menu offered «تحويل إلى نص» and «اسأل عن
// المحدد» only — nothing turned a selection into a flashcard or a question. Now:
//  * «سؤال وجواب»: the front is filled from the reading of exactly these strokes when one exists (a derived reading,
//    labelled); without a vision provider the control says why (requires_configuration) and the owner types the front.
//    The card is saved on this device (origin owner, the source kept) and synced later.
//  * «إخفاء في صورة»: the server cuts the page area under the selection; the owner names the masks → occlusion cards.
//  * a question the owner writes is saved in the Question Vault, linked to this lecture (origin owner).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { CardCreateResponse, FlashcardView, InkData, InkRecognitionView, OcclusionCreateRequest, PageCropRequest, QuickAddTextRequest } from '@medlevo/shared';
import { ToastProvider } from '../../../design';
import { getDb } from '../../../lib/localdb';
import { makeInkItem, type InkItem } from '../ink/model';
import { LassoCardDialog, OCCLUSION_NEEDS_SOURCE_AR, QUESTION_NEEDS_SERVER_AR, type LassoCardDeps, type LassoTarget } from './LassoCardDialog';

const anchor = { type: 'page' as const, source_id: 'S1', version_id: 'V1', page_id: 'P1', page_index: 0, space: 'page_norm' as const };
const pen = { tool: 'pen' as const, color: 'ink-black', width: 0.0025 };
const stroke = (id: string): InkItem =>
  makeInkItem({ id, anchor, now: 1, z: 1, style: pen as InkData['style'], points: [[0.2, 0.2, 0], [0.4, 0.25, 16]], pressureAvailable: false, tiltAvailable: false, pointerType: 'mouse' });
const target = (mode: 'card' | 'question', over: Partial<LassoTarget> = {}): LassoTarget => ({ mode, targetKey: 'source_page:P1', anchor, items: [stroke('A1'), stroke('A2')], bbox: { x: 0.2, y: 0.2, w: 0.3, h: 0.1 }, ar: 842 / 595, ...over });
const AI_REASON = 'ميزات الذكاء الاصطناعي غير مفعّلة: لم يُضبط مفتاح مزود على الخادم (ANTHROPIC_API_KEY).';

const reading = (over: Partial<InkRecognitionView> = {}): InkRecognitionView =>
  ({
    id: 'REC1', purpose: 'page_ink', status: 'recognized', status_label_ar: 'قُرئت الكتابة', recognized_text: 'Rovsing sign', corrected_text: null, effective_text: 'Rovsing sign',
    origin: 'recognized', annotation_ids: ['A1', 'A2'], error_ar: null, lines: [], uncertain_count: 0, ...over,
  }) as InkRecognitionView;

function show(t: LassoTarget, opts: { recognition?: boolean; online?: boolean; deps?: LassoCardDeps; onReadFirst?: () => void } = {}) {
  const onClose = vi.fn();
  render(
    <MemoryRouter>
      <ToastProvider>
        <LassoCardDialog
          target={t}
          onClose={onClose}
          recognition={opts.recognition === false ? { available: false, reason: AI_REASON } : { available: true, reason: null }}
          online={opts.online ?? true}
          onReadFirst={opts.onReadFirst ?? (() => undefined)}
          deps={opts.deps}
        />
      </ToastProvider>
    </MemoryRouter>,
  );
  return { dialog: screen.getByRole('dialog'), onClose };
}

beforeEach(async () => {
  await getDb().open();
  await Promise.all([getDb().flashcards.clear(), getDb().outbox.clear()]);
});
afterEach(() => vi.restoreAllMocks());

describe('H3 item 4 — a card from the lasso selection', () => {
  it('no vision provider: «املأ من الخط المقروء» says why; the typed card is saved on this device as the owner\'s, with its source', async () => {
    const recognitions = vi.fn(async () => [reading()]);
    const { dialog } = show(target('card'), { recognition: false, deps: { recognitions } });
    const fill = within(dialog).getByRole('button', { name: 'املأ الوجه من الخط المقروء' });
    expect(fill.hasAttribute('disabled')).toBe(true);
    expect(within(dialog).getByText(AI_REASON)).toBeTruthy();
    expect(recognitions).not.toHaveBeenCalled(); // nothing is asked of a reader that is not configured
    fireEvent.change(within(dialog).getByLabelText('وجه البطاقة'), { target: { value: 'ما علامة Rovsing؟' } });
    fireEvent.change(within(dialog).getByLabelText('ظهر البطاقة'), { target: { value: 'ألم في الحفرة الحرقفية اليمنى عند ضغط اليسرى' } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'احفظ البطاقة' }));
    });
    expect(await within(dialog).findByText('حُفظت البطاقة.')).toBeTruthy();
    const cards = await getDb().flashcards.toArray();
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ kind: 'basic', origin: 'owner', sourceId: 'S1', sourceVersionId: 'V1', syncState: 'pending_sync' });
    expect(JSON.stringify(cards[0]!.front)).toContain('Rovsing');
    expect(await getDb().outbox.count()).toBe(1); // synced later
    expect(within(dialog).getByRole('link', { name: 'افتح البطاقة' }).getAttribute('href')).toBe(`/review/cards/${cards[0]!.id}`);
  });

  it('a reading of exactly these strokes fills the front (labelled as a derived reading)', async () => {
    const { dialog } = show(target('card'), { deps: { recognitions: async () => [reading({ annotation_ids: ['A1'] }), reading({ id: 'REC2', corrected_text: 'Rovsing sign +', effective_text: 'Rovsing sign +', origin: 'owner_corrected' })] } });
    const fill = within(dialog).getByRole('button', { name: 'املأ الوجه من الخط المقروء' });
    await waitFor(() => expect(fill.hasAttribute('disabled')).toBe(false));
    expect(within(dialog).getByText('صحّحته بنفسك')).toBeTruthy();
    fireEvent.click(fill);
    expect((within(dialog).getByLabelText('وجه البطاقة') as HTMLTextAreaElement).value).toBe('Rovsing sign +');
  });

  it('no reading yet: says so and offers to read the strokes first («تحويل إلى نص»)', async () => {
    const onReadFirst = vi.fn();
    const { dialog } = show(target('card'), { deps: { recognitions: async () => [] }, onReadFirst });
    expect(await within(dialog).findByText('لم تُقرأ هذه الكتابة بعد.')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'اقرأها الآن…' }));
    expect(onReadFirst).toHaveBeenCalledTimes(1);
  });

  it('«إخفاء في صورة»: the server cuts the page area under the selection; named masks become occlusion cards', async () => {
    const crops: PageCropRequest[] = [];
    const made: OcclusionCreateRequest[] = [];
    const deps: LassoCardDeps = {
      recognitions: async () => [],
      crop: async (req) => {
        crops.push(req);
        return { created: true, crop: { image_asset_id: 'IMG1', file_id: 'F1', url: '/api/files/F1', width: 800, height: 400, source_id: 'S1', version_id: 'V1', page_id: 'P1', page_index: 0, bbox: req.bbox } };
      },
      occlusion: async (body) => {
        made.push(body);
        return { created: true, cards: [{ id: 'C1', kind: 'image_occlusion', origin: 'owner' } as unknown as FlashcardView], duplicates: [], notes_ar: [] } as CardCreateResponse;
      },
    };
    const { dialog } = show(target('card'), { deps });
    fireEvent.click(within(dialog).getByRole('radio', { name: 'إخفاء في صورة' }));
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'اقطع الصورة من الصفحة' }));
    });
    expect(crops).toEqual([{ id: expect.any(String), page_id: 'P1', bbox: { x: 0.2, y: 0.2, w: 0.3, h: 0.1 } }]);
    expect(within(dialog).getByText(/صورة من الصفحة 1 في المصدر/)).toBeTruthy();
    const create = within(dialog).getByRole('button', { name: 'أنشئ البطاقة' });
    expect(create.hasAttribute('disabled')).toBe(true); // no mask yet
    fireEvent.click(within(dialog).getByRole('button', { name: /أضف منطقة/ }));
    fireEvent.change(within(dialog).getByLabelText(/اسم المنطقة 1/), { target: { value: 'الزائدة' } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'أنشئ البطاقة' }));
    });
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ image_asset_id: 'IMG1', masks: [{ label: 'الزائدة' }] });
    expect(await within(dialog).findByText('حُفظت البطاقة.')).toBeTruthy();
  });

  it('«إخفاء في صورة» needs a source page and the server: the reasons are given', () => {
    const note = { type: 'note_page' as const, note_page_id: 'NP1', space: 'page_norm' as const };
    const { dialog } = show(target('card', { anchor: note, targetKey: 'note_page:NP1' }), { deps: { recognitions: async () => [] } });
    expect(within(dialog).getByRole('radio', { name: 'إخفاء في صورة' }).hasAttribute('disabled')).toBe(true);
    expect(within(dialog).getByText(new RegExp(OCCLUSION_NEEDS_SOURCE_AR.slice(0, 20)))).toBeTruthy();
  });
});

describe('H3 item 4 — a question from the lasso selection', () => {
  it('the owner\'s question (with the owner\'s key) is saved in the vault and linked to this lecture; offline it says why', async () => {
    const sent: QuickAddTextRequest[] = [];
    const deps: LassoCardDeps = {
      recognitions: async () => [reading()],
      quickAdd: async (body) => {
        sent.push(body);
        return { mode: 'text', question_id: 'Q1', source_id: null, version_id: 'QV1', job_id: null, message_ar: 'أُضيف السؤال إلى خزنتك (خياران، مع مفتاح حددته بنفسك).' };
      },
    };
    const { dialog } = show(target('question'), { deps });
    const fill = within(dialog).getByRole('button', { name: 'املأ السؤال من الخط المقروء' });
    await waitFor(() => expect(fill.hasAttribute('disabled')).toBe(false));
    fireEvent.click(fill);
    const text = within(dialog).getByLabelText('نص السؤال وخياراته') as HTMLTextAreaElement;
    expect(text.value).toBe('Rovsing sign');
    fireEvent.change(text, { target: { value: 'Rovsing sign suggests?\nA. Appendicitis\nB. Cholecystitis' } });
    fireEvent.change(within(dialog).getByLabelText(/مفتاح الإجابة/), { target: { value: 'A' } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'احفظ السؤال في الخزنة' }));
    });
    expect(sent).toEqual([{ text: 'Rovsing sign suggests?\nA. Appendicitis\nB. Cholecystitis', lecture_source_id: 'S1', key_label: 'A' }]);
    expect(await within(dialog).findByText(/أُضيف السؤال إلى خزنتك/)).toBeTruthy();
    expect(within(dialog).getByRole('link', { name: 'افتح السؤال' }).getAttribute('href')).toBe('/questions/Q1');
  });

  it('offline: nothing is sent; the reason is shown', () => {
    const quickAdd = vi.fn();
    const { dialog } = show(target('question'), { online: false, deps: { quickAdd } });
    fireEvent.change(within(dialog).getByLabelText('نص السؤال وخياراته'), { target: { value: 'سؤال' } });
    expect(within(dialog).getByRole('button', { name: 'احفظ السؤال في الخزنة' }).hasAttribute('disabled')).toBe(true);
    expect(within(dialog).getByText(QUESTION_NEEDS_SERVER_AR)).toBeTruthy();
    expect(quickAdd).not.toHaveBeenCalled();
  });
});
