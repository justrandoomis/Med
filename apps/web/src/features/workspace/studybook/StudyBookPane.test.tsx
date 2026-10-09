// Study Book pane against a mocked server: generation is refused with the server's reason when it cannot run,
// the lock is shown before generating, progress is real section counts (never a %), finished sections render with
// chips while the rest is pending, vanished note anchors are listed (never moved), and Lecture Twin «open in the
// lecture» uses the workspace page index.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { FEATURE_KEYS, type CapabilitiesResponse, type StudyBookStatusResponse, type StudyBookView } from '@medlevo/shared';
import { ToastProvider } from '../../../design';
import { setFetchImpl } from '../../../lib/api';
import { capabilitiesStore } from '../../../lib/capabilities';
import type { SourceDocument } from '../data/useSourceDocument';
import { StudyBookPane } from './StudyBookPane';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const doc = {
  detail: { id: 'L1', title: 'Acute Appendicitis', language: 'en', links: [] },
  version: { id: 'V1' },
  // the file starts at page_index 0; the workspace indexes pages by array position
  pages: [0, 1, 2, 3].map((i) => ({ id: `P${i}`, page_index: i, printed_label: String(10 + i), kind: 'page', version_id: 'V1', has_images: false })),
} as unknown as SourceDocument;

function book(over: Partial<StudyBookView['artifact']> = {}, extra: Partial<StudyBookView> = {}): StudyBookView {
  return {
    artifact: {
      id: 'SB2',
      lineage_id: 'SB1',
      version_no: 2,
      kind: 'study_book',
      title: 'كتاب الدراسة: Acute Appendicitis',
      primary_source_id: 'L1',
      scope: { mode: 'lecture_only', source_ids: ['L1'], version_ids: ['V1'], describe_ar: 'المحاضرة فقط' },
      params: {},
      status: 'generating',
      model: 'claude-opus-5-5',
      rules_version: 'r-1',
      coverage: { sections_total: 3, sections_covered: 1, pages_total: 4, pages_covered: 1 },
      is_frozen: false,
      stale_reason: null,
      created_at: 1,
      published_at: null,
      blocks: [
        {
          id: 'B1',
          block_key: 'bk-intro',
          section_key: 's1',
          ord: 0,
          kind: 'paragraph',
          content: { v: 1, paragraphs: [{ dir: 'rtl', runs: [{ t: 'التهاب الزائدة الدودية حالة شائعة.', claim: 'C1' }] }] },
          table: null,
          source_region_ids: ['R1'],
          status: 'complete',
          verification_status: 'needs_review',
          meta: { page_indexes: [2] },
        },
      ],
      claims: { C1: { id: 'C1', text: 'x', support_type: 'derived', verification_status: 'needs_review', citations: [], issues: [{ check: 'entailment', reason_ar: 'لم يُجرَ التحقق المستقل' }] } },
      removed: [],
      abstain: null,
      anchor: null,
      parent_artifact_id: 'SB1',
      job_id: 'J1',
      versions: [],
      ...over,
    },
    sections: [
      { section_key: 's1', ord: 0, title: 'Definition', status: 'complete', status_label_ar: 'مكتمل', block_count: 1, page_indexes: [2], page_labels_ar: ['ص 12'], detail_ar: null },
      { section_key: 's2', ord: 1, title: 'Investigations', status: 'generating', status_label_ar: 'قيد التوليد', block_count: 0, page_indexes: [3], page_labels_ar: ['ص 13'], detail_ar: null },
      { section_key: 's3', ord: 2, title: 'Management', status: 'pending', status_label_ar: 'في الانتظار', block_count: 0, page_indexes: [], page_labels_ar: [], detail_ar: null },
    ],
    job: null,
    progress: { sections_total: 3, sections_complete: 1, sections_abstained: 0, sections_failed: 0 },
    twin: [{ block_key: 'bk-intro', section_key: 's1', page_indexes: [2] }],
    reanchor: [{ target_kind: 'note', target_id: 'N1', block_key: 'bk-old', previous_version_no: 1, status: 'needs_reanchor', reason_ar: 'ملاحظة على فقرة من النسخة 1 لم تعد موجودة' }],
    newer_version_id: null,
    ...extra,
  };
}

function caps(): CapabilitiesResponse {
  const features = Object.fromEntries(FEATURE_KEYS.map((k) => [k, { key: k, state: 'available' }])) as CapabilitiesResponse['features'];
  return { features, ai: { configured: true }, server_time: 0, app_version: 'test' };
}

function mount(onOpenPage = vi.fn()) {
  render(
    <MemoryRouter>
      <ToastProvider>
        <StudyBookPane doc={doc} pageIndex={2} jumpKey={0} onOpenPage={onOpenPage} online />
      </ToastProvider>
    </MemoryRouter>,
  );
  return onOpenPage;
}

beforeEach(() => capabilitiesStore.reset(caps()));
afterEach(() => {
  setFetchImpl(null);
  capabilitiesStore.reset(null);
});

describe('StudyBookPane', () => {
  it('cannot generate → the server’s reason is shown next to the disabled button', async () => {
    const status: StudyBookStatusResponse = { book: null, can_generate: { available: false, reason_ar: 'تتطلب ضبط مزود ذكاء اصطناعي على الخادم (ANTHROPIC_API_KEY).' } };
    setFetchImpl(async () => json(status));
    mount();
    const btn = await screen.findByRole('button', { name: /أنشئ كتاب الدراسة/ });
    expect(btn).toHaveProperty('disabled', true);
    const reason = screen.getByText('تتطلب ضبط مزود ذكاء اصطناعي على الخادم (ANTHROPIC_API_KEY).');
    expect(btn.getAttribute('aria-describedby')).toBe(reason.id);
    // the Source Lock is visible before generating
    expect(screen.getByText('نطاق المصادر لهذا الكتاب')).toBeTruthy();
  });

  it('generates under the shown lock; progress is real section counts; finished sections render, unfinished are listed', async () => {
    const posts: unknown[] = [];
    let created = false;
    setFetchImpl(async (url, init) => {
      if (url.startsWith('/api/studybook/books?') && !created) return json({ book: null, can_generate: { available: true, reason_ar: null } } satisfies StudyBookStatusResponse);
      if (url.startsWith('/api/studybook/books?')) return json({ book: book(), can_generate: { available: true, reason_ar: null } });
      if (url === '/api/studybook/books' && init.method === 'POST') {
        created = true;
        posts.push(JSON.parse(String(init.body)));
        return json({ book: book(), cached: false });
      }
      return json({ error: { code: 'NOT_FOUND', message: 'x' } }, 404);
    });
    const onOpen = mount();
    fireEvent.click(await screen.findByRole('button', { name: /أنشئ كتاب الدراسة/ }));
    expect(await screen.findByText(/يُولَّد كتاب الدراسة قسمًا قسمًا: 1 من 3 أقسام/)).toBeTruthy();
    expect(posts[0]).toMatchObject({ source_id: 'L1', scope: { mode: 'lecture_only', lecture_source_id: 'L1' } });
    expect(document.body.textContent).not.toMatch(/\d+\s?%/);
    const toc = screen.getByRole('navigation', { name: 'أقسام كتاب الدراسة' });
    expect(within(toc).getByText('مكتمل')).toBeTruthy();
    expect(within(toc).getByText('قيد التوليد')).toBeTruthy();
    expect(within(toc).getByText('في الانتظار')).toBeTruthy();
    // the finished section is readable (unverified claims marked), the generating one has no content
    expect(screen.getByText('التهاب الزائدة الدودية حالة شائعة.')).toBeTruthy();
    // Lecture Twin: the book opened at the block of the lecture page (page_index 2 → «bk-intro»)
    expect(document.querySelector<HTMLElement>('.sb-book__body')?.dataset.twinTarget).toBe('bk-intro');
    // vanished anchors are listed, never moved
    expect(screen.getByText('ملاحظات تحتاج إعادة ربط (1)')).toBeTruthy();
    // Lecture Twin: «ص 13» opens the lecture at the workspace index of page_index 3
    fireEvent.click(within(toc).getByRole('button', { name: /افتح ص 13 في المحاضرة/ }));
    expect(onOpen).toHaveBeenCalledWith(3);
    // stopping is offered while generating
    expect(screen.getByRole('button', { name: 'أوقف التوليد' })).toBeTruthy();
  });

  it('a stale book says the source changed and shows the change alerts; freeze is explicit', async () => {
    const freezes: unknown[] = [];
    setFetchImpl(async (url, init) => {
      if (url.startsWith('/api/studybook/books?')) return json({ book: book({ status: 'stale', stale_reason: 'تغيّرت نسخة المصدر بعد إنشاء هذا الكتاب.', published_at: 2 }), can_generate: { available: true, reason_ar: null } });
      if (url.startsWith('/api/evidence/alerts')) return json({ alerts: [] });
      if (url.endsWith('/freeze')) {
        freezes.push(JSON.parse(String(init.body)));
        return json(book({ status: 'stale', is_frozen: true }));
      }
      return json({ error: { code: 'NOT_FOUND', message: 'x' } }, 404);
    });
    mount();
    expect(await screen.findByText('تغيّرت نسخة المصدر بعد إنشاء هذا الكتاب.')).toBeTruthy();
    expect(screen.getByText('ما الذي تغيّر في المصدر؟')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'ثبّت هذه النسخة' }));
    await waitFor(() => expect(freezes).toEqual([{ frozen: true }]));
    expect(await screen.findByRole('button', { name: 'ألغِ التثبيت' })).toBeTruthy();
  });
});
