// Control Center screens against a mocked server: the review desk (original next to the structured data, the
// specific reason, each action's effect shown before it is applied, correction → outcome + history), items owned
// by another screen, the queue filters, the impact preview → apply with its token, and the sync conflict actions
// on a real (fake-indexeddb) outbox.
import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { newId, type ImpactPreviewResponse, type ResolveReviewResponse, type ReviewItemDetail, type ReviewQueueListResponse } from '@medlevo/shared';
import { ToastProvider } from '../../design';
import { setFetchImpl } from '../../lib/api';
import { MedLevoDB, type OutboxRecord } from '../../lib/localdb';
import { SyncEngine, type SyncTransport } from '../../lib/sync';
import { ImpactReview } from './ImpactReview';
import { ReviewItemScreen } from './ReviewItemScreen';
import { ReviewQueueScreen } from './ReviewQueueScreen';
import { SyncScreen } from './SyncScreen';
import { describeSyncIssue, payloadPreview, statusLine } from './model';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => setFetchImpl(null));

const ORIGINAL_TEXT = 'التهاب الزائدة عادةS يبدأ بألم حول السرة';
const CORRECTED = 'التهاب الزائدة عادةً يبدأ بألم حول السرة';

function detail(over: Partial<ReviewItemDetail> = {}): ReviewItemDetail {
  return {
    id: 'R1',
    kind: 'ocr_error',
    kind_label_ar: 'نص مقروء قد يكون خاطئًا',
    status: 'open',
    status_label_ar: 'بانتظار مراجعتك',
    entity_type: 'source_region',
    entity_id: 'REG1',
    origin: 'processing',
    source_id: 'S1',
    source_title: 'Acute Appendicitis',
    source_type: 'lecture',
    reason: 'حرف لاتيني «S» ملتصق بكلمة عربية (غالبًا تنوين قرأه الخط كحرف).',
    location_label_ar: 'ص 11 (الصفحة 1 في الملف)',
    handled_in: 'control',
    link: null,
    created_at: Date.UTC(2026, 9, 9, 10),
    resolved_at: null,
    original: {
      source_id: 'S1',
      source_title: 'Acute Appendicitis',
      source_type: 'lecture',
      version_id: 'V1',
      version_no: 1,
      is_active_version: true,
      page_id: 'P1',
      page_index: 0,
      page_label_ar: 'ص 11 (الصفحة 1 في الملف)',
      page_kind: 'image',
      bbox: { x: 0.1, y: 0.2, w: 0.5, h: 0.05 },
      render: { kind: 'image', file_id: 'F1' },
      open_link: { href: '/study/S1?v=V1&page=0&page_id=P1&region=REG1', label_ar: 'افتح في مساحة الدراسة' },
    },
    structured: {
      type: 'region',
      region: { id: 'REG1', kind: 'paragraph', kind_label_ar: 'فقرة', text: ORIGINAL_TEXT, text_origin: 'digital', text_origin_label_ar: 'نص رقمي من الملف', confidence: null, status: 'needs_review', status_label_ar: 'يحتاج مراجعة' },
    },
    actions: [
      { action: 'accept', label_ar: 'قبول كما هو', effect_ar: 'النص المستخرج صحيح: لا يتغير النص.', input: 'none' },
      { action: 'correct', label_ar: 'تصحيح النص', effect_ar: 'يحل نصك محل النص المستخرج، ويُحفظ النص السابق في سجل التصحيحات.', input: 'text' },
      { action: 'reject', label_ar: 'استبعاد النص', effect_ar: 'يُستبعد النص من البحث دون حذفه.', input: 'none' },
      { action: 'dismiss', label_ar: 'أغلقه دون تغيير', effect_ar: 'يُغلق هذا العنصر. لا يتغير شيء.', input: 'none' },
    ],
    actions_note_ar: null,
    resolution: null,
    corrections: [],
    ...over,
  };
}

function mountItem(path = '/control/review/R1') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ToastProvider>
        <Routes>
          <Route path="/control/review/:itemId" element={<ReviewItemScreen />} />
        </Routes>
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe('review desk: original next to the structured data', () => {
  it('shows the original page region, the extracted text, the specific reason and every action with its effect', async () => {
    setFetchImpl(async (url) => (url.startsWith('/api/control/review/R1') ? json(detail()) : json({}, 404)));
    mountItem();
    expect(await screen.findByRole('heading', { level: 1, name: 'نص مقروء قد يكون خاطئًا' })).toBeTruthy();
    const orig = screen.getByRole('region', { name: 'الأصل' });
    const struct = screen.getByRole('region', { name: 'النسخة المنظمة' });
    // the original: the stored page image of THAT page (alt names the page), and a way to the full page
    expect(within(orig).getByRole('img', { name: /ص 11 \(الصفحة 1 في الملف\)/ })).toBeTruthy();
    expect(within(orig).getByRole('button', { name: 'الصفحة كاملة' })).toBeTruthy();
    expect(within(orig).getByRole('link', { name: /افتح في مساحة الدراسة/ }).getAttribute('href')).toBe('/study/S1?v=V1&page=0&page_id=P1&region=REG1');
    // the structured side: the text as extracted, its origin and status (never by colour alone)
    // (mixed Arabic/Latin text is rendered as isolated runs: compare the logical text content)
    expect(struct.textContent).toContain(ORIGINAL_TEXT);
    expect(within(struct).getByText('نص رقمي من الملف')).toBeTruthy();
    expect(within(struct).getByText('يحتاج مراجعة')).toBeTruthy();
    expect(document.body.textContent).toContain('حرف لاتيني «S» ملتصق');
    // each action states what it does BEFORE it is applied; nothing is applied until confirmed
    const radios = screen.getAllByRole('radio');
    expect(radios.map((r) => (r.closest('label') as HTMLElement).textContent)).toEqual([
      expect.stringContaining('قبول كما هو'),
      expect.stringContaining('سجل التصحيحات'),
      expect.stringContaining('دون حذفه'),
      expect.stringContaining('لا يتغير شيء'),
    ]);
    const submit = screen.getByRole('button', { name: 'اختر قرارًا أولًا' });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
  });

  it('correcting sends the owner text, shows what happened, the alert, and the kept previous text', async () => {
    const posts: unknown[] = [];
    const resolved: ResolveReviewResponse = {
      effects_ar: ['حُفظ النص الذي كتبته. النص السابق محفوظ في سجل التصحيحات ولم يُحذف.', 'أُنشئ تنبيه تغيّر محتوى للعناصر التي تعتمد على هذه الصفحة. لم يُعَد توليد أي شيء تلقائيًا.'],
      alert: { id: 'AL1', summary: 'صُحّح النص', counts: { still_valid: 0, needs_regeneration: 1, needs_review: 1 } },
      item: detail({
        status: 'corrected',
        status_label_ar: 'صحّحته',
        actions: [],
        resolution: { action: 'correct', by: 'owner', note: null, at: Date.UTC(2026, 9, 9, 11), effects_ar: [], alert_id: 'AL1' },
        structured: { type: 'region', region: { ...(detail().structured as { region: object }).region, text: CORRECTED, text_origin: 'owner', text_origin_label_ar: 'كتبته أو صحّحته بنفسك', status: 'owner_reviewed', status_label_ar: 'راجعته شخصيًا' } as never },
        corrections: [
          { id: 'C1', region_id: 'REG1', page_id: 'P1', action: 'correct', action_label_ar: 'صحّحت النص', before_text: ORIGINAL_TEXT, after_text: CORRECTED, before_origin: 'digital', after_origin: 'owner', before_status: 'needs_review', after_status: 'owner_reviewed', alert_id: 'AL1', note: null, created_at: Date.UTC(2026, 9, 9, 11) },
        ],
      }),
    };
    setFetchImpl(async (url, init) => {
      if (url.startsWith('/api/control/review/R1/resolve')) {
        posts.push(JSON.parse(String(init.body)));
        return json(resolved);
      }
      if (url.startsWith('/api/control/review/R1')) return json(detail());
      return json({}, 404);
    });
    mountItem();
    await screen.findByRole('heading', { level: 1 });
    fireEvent.click(screen.getByRole('radio', { name: /تصحيح النص/ }));
    const editor = screen.getByRole('textbox', { name: /النص الصحيح كما في الأصل/ }) as HTMLTextAreaElement;
    expect(editor.value).toBe(ORIGINAL_TEXT); // starts from what was extracted
    fireEvent.change(editor, { target: { value: CORRECTED } });
    fireEvent.click(screen.getByRole('button', { name: 'طبّق: تصحيح النص' }));
    expect(await screen.findByText('حُفظ قرارك')).toBeTruthy();
    expect(posts).toEqual([{ action: 'correct', text: CORRECTED }]);
    expect(screen.getByRole('link', { name: /اعرض تنبيه تغيّر المحتوى/ }).getAttribute('href')).toBe('/control/alerts');
    expect(screen.getByText(/لم يُعَد توليد أي شيء تلقائيًا/)).toBeTruthy();
    // the previous text is shown in the correction history, next to the new one
    const hist = screen.getByRole('region', { name: 'سجل التصحيحات' });
    expect(hist.textContent).toContain(ORIGINAL_TEXT);
    expect(hist.textContent).toContain(CORRECTED);
    expect(screen.queryAllByRole('radio')).toHaveLength(0); // resolved: no more actions
  });

  it('a refused correction keeps the owner text and shows the server reason', async () => {
    setFetchImpl(async (url) => {
      if (url.startsWith('/api/control/review/R1/resolve'))
        return json({ error: { code: 'VALIDATION_FAILED', message: 'لم يتغير النص. إن كان النص المستخرج صحيحًا فاختر «قبول كما هو».', details: { issues: [{ path: 'text', message: 'النص مطابق للنص المستخرج.' }] } } }, 400);
      return json(detail());
    });
    mountItem();
    await screen.findByRole('heading', { level: 1 });
    fireEvent.click(screen.getByRole('radio', { name: /تصحيح النص/ }));
    fireEvent.click(screen.getByRole('button', { name: 'طبّق: تصحيح النص' }));
    expect(await screen.findByText(/فاختر «قبول كما هو»/)).toBeTruthy();
    expect(screen.getByText('النص مطابق للنص المستخرج.')).toBeTruthy();
    expect((screen.getByRole('textbox', { name: /النص الصحيح/ }) as HTMLTextAreaElement).value).toBe(ORIGINAL_TEXT);
  });

  it('an item owned by the questions screen links there and offers only «close» here', async () => {
    setFetchImpl(async () =>
      json(
        detail({
          kind: 'conflicting_key',
          kind_label_ar: 'مفتاح إجابة متعارض',
          entity_type: 'question',
          handled_in: 'questions',
          link: { href: '/questions/Q1/review', label_ar: 'افتح السؤال للمراجعة جنبًا إلى جنب' },
          structured: { type: 'question', question_id: 'Q1', stem_preview: 'Which of the following is NOT a sign of appendicitis?' },
          actions: [{ action: 'dismiss', label_ar: 'أغلقه دون تغيير', effect_ar: 'يُغلق هذا العنصر.', input: 'none' }],
          actions_note_ar: 'قرارات الأسئلة تُتخذ في شاشة مراجعة السؤال جنبًا إلى جنب مع الصفحة الأصلية.',
        }),
      ),
    );
    mountItem();
    expect(await screen.findByRole('link', { name: 'افتح السؤال للمراجعة جنبًا إلى جنب' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'افتح السؤال للمراجعة جنبًا إلى جنب' }).getAttribute('href')).toBe('/questions/Q1/review');
    expect(screen.getAllByRole('radio')).toHaveLength(1);
    expect(document.body.textContent).toContain('NOT a sign of appendicitis');
  });
});

describe('review queue list', () => {
  it('lists items with kind, specific reason and location; filters go to the server', async () => {
    const urls: string[] = [];
    const list: ReviewQueueListResponse = {
      items: [{ ...detail(), original: undefined, structured: undefined, actions: undefined } as never],
      counts: { open: 1, open_by_kind: { ocr_error: 1 }, by_status: { open: 1, accepted: 0, corrected: 0, rejected: 0, dismissed: 0 } },
      sources: [{ id: 'S1', title: 'Acute Appendicitis', open: 1 }],
      next_cursor: null,
    };
    setFetchImpl(async (url) => {
      urls.push(url);
      return json(list);
    });
    render(
      <MemoryRouter initialEntries={['/control/review']}>
        <ReviewQueueScreen />
      </MemoryRouter>,
    );
    const link = await screen.findByRole('link', { name: /نص مقروء قد يكون خاطئًا/ });
    expect(link.getAttribute('href')).toBe('/control/review/R1');
    expect(link.textContent).toContain('حرف لاتيني «S»');
    expect(within(link).getByText('ص 11 (الصفحة 1 في الملف)')).toBeTruthy();
    expect(screen.getByText(/عنصر واحد بانتظار قرارك/)).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox', { name: 'النوع' }), { target: { value: 'ocr_error' } });
    await waitFor(() => expect(urls.some((u) => u.includes('kind=ocr_error'))).toBe(true));
  });
});

describe('impact preview → apply', () => {
  const preview: ImpactPreviewResponse = {
    change_ar: ['مستوى الشرح الافتراضي: medium ← detailed'],
    affected: [{ id: 'A1', title: 'شرح: ص 11', kind: 'explanation', kind_label_ar: 'شرح', status: 'published', source_id: 'S1', source_title: 'Acute Appendicitis', frozen: false, reason_ar: 'صُنع بقواعد يتغير فيها: مستوى الشرح.' }],
    affected_count: 1,
    unaffected_count: 2,
    not_comparable_count: 0,
    may_differ_count: 0,
    regenerates_automatically: false,
    effects_ar: ['لن يُعاد توليد أي شيء تلقائيًا.'],
    can_apply: true,
    apply_note_ar: 'يُطبَّق التغيير فقط عند تأكيدك.',
    confirm_token: 'TOKEN-1',
  };

  it('shows the impact first and applies with the preview token; a stale token asks for a new preview', async () => {
    const bodies: unknown[] = [];
    let applyStatus = 409;
    setFetchImpl(async (url, init) => {
      if (url.startsWith('/api/control/impact/preview')) return json(preview);
      if (url.startsWith('/api/control/impact/apply')) {
        bodies.push(JSON.parse(String(init.body)));
        return applyStatus === 409
          ? json({ error: { code: 'CONFLICT', message: 'تغيّرت الإعدادات أو القواعد منذ المعاينة. اعرض الأثر من جديد ثم أكّد.', details: { reason: 'preview_stale' } } }, 409)
          : json({ applied: true, effects_ar: ['طُبّق التغيير.'], preview });
      }
      if (url.startsWith('/api/settings')) return json({ settings: {} });
      return json({}, 404);
    });
    const applied: string[][] = [];
    render(<ImpactReview change={{ kind: 'settings', patch: { explanation_level: 'detailed' } }} onApplied={(e) => applied.push(e)} onCancel={() => undefined} />);
    expect(await screen.findByText(/محتوى مخزّن واحد لن يُعاد استخدامه/)).toBeTruthy();
    expect(document.body.textContent).toContain('شرح: ص 11');
    expect(screen.getByText('لن يُعاد توليد أي شيء تلقائيًا.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'طبّق التغيير' }));
    expect(await screen.findByText(/اعرض الأثر من جديد/)).toBeTruthy();
    expect(bodies[0]).toEqual({ change: { kind: 'settings', patch: { explanation_level: 'detailed' } }, confirm_token: 'TOKEN-1' });
    expect(applied).toHaveLength(0);
    applyStatus = 200;
    fireEvent.click(screen.getByRole('button', { name: 'احسب الأثر من جديد' }));
    await screen.findByText(/محتوى مخزّن واحد/);
    await waitFor(() => expect((screen.getByRole('button', { name: 'طبّق التغيير' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'طبّق التغيير' }));
    await waitFor(() => expect(applied).toEqual([['طُبّق التغيير.']]));
  });
});

describe('sync conflicts and rejections (lib/sync.ts outbox)', () => {
  class NoopTransport implements SyncTransport {
    async push() {
      return [];
    }
    async pull(since: number) {
      return { changes: [], next_since: since, has_more: false };
    }
  }

  function op(over: Partial<OutboxRecord>): OutboxRecord {
    return {
      op_id: newId(),
      entity_type: 'note',
      entity_id: newId(),
      op: 'upsert',
      base_rev: 2,
      payload: { title: 'تشخيص الزائدة', body: { v: 1, paragraphs: [{ dir: 'rtl', runs: [{ t: 'علامة McBurney مهمة' }] }] } },
      client_ts: Date.UTC(2026, 9, 9, 9),
      status: 'conflict',
      attempts: 1,
      nextAttemptAt: 0,
      result: 'conflict_kept_both',
      ...over,
    };
  }

  it('explains each problem and what «keep both» / «send again» do; acting never deletes anything', async () => {
    const db = new MedLevoDB(`cc-sync-${newId()}`);
    await db.open();
    const conflict = op({});
    const rejected = op({ entity_type: 'annotation', status: 'rejected', result: 'rejected', resultDetail: 'الصفحة لم تعد موجودة في هذه النسخة.', payload: { kind: 'highlight', data: { text: 'abdominal pain' } } });
    await db.outbox.bulkAdd([conflict, rejected]);
    const engine = new SyncEngine({ db, transport: new NoopTransport(), locks: null, isOnline: () => true });
    render(
      <MemoryRouter>
        <ToastProvider>
          <SyncScreen engine={engine} />
        </ToastProvider>
      </MemoryRouter>,
    );
    const list = await screen.findByRole('list', { name: 'مشكلات المزامنة على هذا الجهاز' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    const c = items.find((li) => li.textContent?.includes('تعارض'))!;
    expect(c.textContent).toContain('احتفظ الخادم بالنسختين');
    expect(c.textContent).toContain('تشخيص الزائدة');
    expect(c.textContent).toContain('تبقى النسختان كما هما');
    const r = items.find((li) => li.textContent?.includes('رفضه الخادم'))!;
    expect(r.textContent).toContain('الصفحة لم تعد موجودة في هذه النسخة.');
    expect(r.textContent).toContain('abdominal pain');

    // keep both copies = acknowledge only
    fireEvent.click(within(c).getByRole('button', { name: 'اطّلعت — أبقِ النسختين' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('لا يُحذف شيء');
    fireEvent.click(within(dialog).getByRole('button', { name: 'تأكيد' }));
    await waitFor(async () => expect((await db.outbox.where('op_id').equals(conflict.op_id).first())?.acknowledgedAt).toBeTruthy());
    expect(await db.outbox.count()).toBe(2); // nothing deleted
    expect(await screen.findByText('أُغلق التنبيه. النسختان باقيتان كما هما.')).toBeTruthy();

    // send again = a NEW op with the same payload, the old one kept and marked superseded
    const rItem = (await screen.findAllByRole('listitem')).find((li) => li.textContent?.includes('رفضه الخادم'))!;
    fireEvent.click(within(rItem).getByRole('button', { name: 'أعد الإرسال' }));
    const d2 = await screen.findByRole('alertdialog');
    expect(d2.textContent).toContain('لا يطبّق العملية الواحدة مرتين');
    fireEvent.click(within(d2).getByRole('button', { name: 'أعد الإرسال' }));
    await waitFor(async () => expect(await db.outbox.count()).toBe(3));
    const old = await db.outbox.where('op_id').equals(rejected.op_id).first();
    expect(old?.supersededBy).toBeTruthy();
    const fresh = await db.outbox.where('op_id').equals(old!.supersededBy!).first();
    expect(fresh).toMatchObject({ status: 'pending', retryOf: rejected.op_id, entity_id: rejected.entity_id, payload: rejected.payload });
    await waitFor(() => expect(screen.queryByRole('list', { name: 'مشكلات المزامنة على هذا الجهاز' })).toBeNull());
    expect(screen.getByText('لا تعارضات ولا تغييرات مرفوضة')).toBeTruthy();
    db.close();
  });
});

describe('model', () => {
  it('describes sync problems in words and previews payloads safely', () => {
    const v = describeSyncIssue({ op_id: 'o', entity_type: 'flashcard', entity_id: 'e', op: 'append', payload: null, client_ts: 1, status: 'rejected', attempts: 1, nextAttemptAt: 0, result: 'rejected', resultDetail: { message: 'سبب من الخادم' } });
    expect(v).toMatchObject({ kind: 'rejected', entityLabel: 'بطاقة', opLabel: 'إضافة', serverReason: 'سبب من الخادم', preview: null, canRetry: true });
    expect(payloadPreview({ entity_type: 'note', payload: { body: { v: 1, paragraphs: [{ dir: 'rtl', runs: [{ t: 'نص '.repeat(100) }] }] } } })!.length).toBeLessThanOrEqual(140);
    expect(payloadPreview({ entity_type: 'note', payload: 'not an object' })).toBeNull();
  });

  it('a change the server refused because it kept its NEWER copy is explained as such, without a futile re-send (review fix)', () => {
    // study_session / note_page / exam_attempt: rejected WITH the server copy → outbox status 'conflict', result 'rejected'
    const base = { op_id: 'o', entity_type: 'study_session', entity_id: 'e', op: 'upsert' as const, base_rev: 3, payload: null, client_ts: 1, attempts: 1, nextAttemptAt: 0 };
    const refused = describeSyncIssue({ ...base, status: 'conflict', result: 'rejected', resultDetail: 'حُفظ موضع دراسة أحدث لهذا المصدر من جهاز آخر؛ لم يُكتب فوقه.' });
    expect(refused.kind).toBe('conflict');
    expect(refused.happened).toContain('نسخة أحدث');
    expect(refused.acknowledgeEffect).toContain('نسخة الخادم الأحدث تبقى على الخادم');
    expect(refused.acknowledgeEffect).not.toContain('النسختان');
    // the same old base can only be refused again: no «send again» for it
    expect(refused.canRetry).toBe(false);
    // the server SAVED both copies: «keep both» and a re-send that may add a third copy, said so
    const keptBoth = describeSyncIssue({ ...base, entity_type: 'note', status: 'conflict', result: 'conflict_kept_both' });
    expect(keptBoth.acknowledgeEffect).toContain('تبقى النسختان');
    expect(keptBoth.canRetry).toBe(true);
    expect(keptBoth.retryEffect).toContain('نسخة ثالثة');
  });

  it('status lines use real counts only', () => {
    const o = { review: { open: 0, open_by_kind: {} }, alerts: { open: 2 }, processing: { active: 1, failed: 0, attention: 0 }, ai: { configured: false, provider: null, spent_usd: 0, monthly_usd: 10, estimated: true as const }, generated_at: 1 };
    expect(statusLine('review', o, null)).toBe('لا شيء ينتظر مراجعتك.');
    expect(statusLine('alerts', o, null)).toBe('تنبيهان جديدان عن تغيّر المحتوى.');
    expect(statusLine('processing', o, null)).toBe('مهمة واحدة جارية.');
    expect(statusLine('intelligence', o, null)).toContain('غير مهيأ');
    expect(statusLine('sync', null, { conflicts: 1, errors: 0, pending: 0 })).toBe('عنصر واحد بانتظار قرارك على هذا الجهاز.');
    expect(statusLine('review', null, null)).toBeNull();
  });
});
