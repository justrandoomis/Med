// Integration (I1 #1): the Study Book view offline. After a REAL download (lib/offline.ts stores the server's own GET
// answers in IndexedDB), the workspace's Study Book pane reads the downloaded book without the network, marks it as
// the copy on this device and offers no action that needs the server. A source that was not downloaded — or whose
// Study Book was built on another version — says so plainly instead of showing anything else.
// Regression: before the fix useStudyBook returned «offline» as soon as the browser was offline, without looking.
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, renderHook, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  FEATURE_KEYS,
  normalizeOfflinePath,
  type CapabilitiesResponse,
  type OfflineBundleResponse,
  type OfflineManifestResponse,
  type StudyBookStatusResponse,
  type StudyBookView,
} from '@medlevo/shared';
import { ToastProvider } from '../../../design';
import { setFetchImpl } from '../../../lib/api';
import { capabilitiesStore } from '../../../lib/capabilities';
import { downloadSource, removeDownload } from '../../../lib/offline';
import type { SourceDocument } from '../data/useSourceDocument';
import { StudyBookPane } from './StudyBookPane';
import { STUDY_BOOK_NOT_DOWNLOADED_AR, STUDY_BOOK_OTHER_VERSION_AR, useStudyBookAvailability } from './useStudyBook';

const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const PDF = new TextEncoder().encode('%PDF-1.7 lecture bytes');

const doc = (id: string) =>
  ({
    detail: { id, title: 'Acute Appendicitis', language: 'en', links: [] },
    version: { id: 'V1' },
    pages: [0, 1, 2].map((i) => ({ id: `P${i}`, page_index: i, printed_label: String(10 + i), kind: 'page', version_id: 'V1', has_images: false })),
  }) as unknown as SourceDocument;

function bookView(sourceId: string): StudyBookView {
  return {
    artifact: {
      id: `SB-${sourceId}`,
      lineage_id: `SB-${sourceId}`,
      version_no: 1,
      kind: 'study_book',
      title: 'كتاب الدراسة: Acute Appendicitis',
      primary_source_id: sourceId,
      scope: { mode: 'lecture_only', source_ids: [sourceId], version_ids: ['V1'], describe_ar: 'المحاضرة فقط' },
      params: {},
      status: 'published',
      model: 'test-model',
      rules_version: 'r-1',
      coverage: { sections_total: 1, sections_covered: 1, pages_total: 3, pages_covered: 1 },
      is_frozen: false,
      stale_reason: null,
      created_at: 1,
      published_at: 2,
      blocks: [
        {
          id: 'B1',
          block_key: 'bk-intro',
          section_key: 's1',
          ord: 0,
          kind: 'paragraph',
          content: { v: 1, paragraphs: [{ dir: 'rtl', runs: [{ t: 'فقرة من كتاب الدراسة المحمّل.', claim: 'C1' }] }] },
          table: null,
          source_region_ids: ['R1'],
          status: 'complete',
          verification_status: 'linked',
          meta: { page_indexes: [1] },
        },
      ],
      claims: { C1: { id: 'C1', text: 'x', support_type: 'derived', verification_status: 'linked', citations: [], issues: [] } },
      removed: [],
      abstain: null,
      anchor: null,
      parent_artifact_id: null,
      job_id: null,
      versions: [],
    },
    sections: [{ section_key: 's1', ord: 0, title: 'Definition', status: 'complete', status_label_ar: 'مكتمل', block_count: 1, page_indexes: [1], page_labels_ar: ['ص 11'], detail_ar: null }],
    job: null,
    progress: { sections_total: 1, sections_complete: 1, sections_abstained: 0, sections_failed: 0 },
    twin: [{ block_key: 'bk-intro', section_key: 's1', page_indexes: [1] }],
    reanchor: [],
    newer_version_id: null,
  } as unknown as StudyBookView;
}

/** A download as the server builds it (data/offline.ts): the status always; the book only for this version. */
function download(sourceId: string, withBook: boolean): { manifest: OfflineManifestResponse; bundle: OfflineBundleResponse } {
  const status: StudyBookStatusResponse = { book: bookView(sourceId), can_generate: { available: true, reason_ar: null } };
  const data: Array<{ path: string; role: 'study_book_status' | 'study_book'; body: unknown }> = [
    { path: `/api/studybook/books?source_id=${sourceId}`, role: 'study_book_status', body: status },
  ];
  if (withBook) data.push({ path: `/api/studybook/books/SB-${sourceId}`, role: 'study_book', body: bookView(sourceId) });
  const raws = data.map((d) => JSON.stringify(d.body));
  const dataBytes = raws.reduce((n, r) => n + r.length, 0);
  return {
    manifest: {
      format: 'medlevo-offline-1',
      source: { id: sourceId, title: 'Acute Appendicitis', source_type: 'lecture', format: 'pdf' },
      version: { id: 'V1', version_no: 1, is_active: true, page_count: 3, processing_status: 'ready' },
      include_solutions: true,
      generated_at: 1,
      content_hash: 'H',
      entries: [
        { kind: 'file', role: 'display_pdf', file_id: `F-${sourceId}`, url: `/api/files/F-${sourceId}`, mime: 'application/pdf', size: PDF.length, sha256: sha(PDF), page_id: null, page_index: null },
        ...data.map((d, i) => ({ kind: 'data' as const, role: d.role, path: normalizeOfflinePath(d.path), size: raws[i]!.length, contains_solutions: false, sha256: sha(raws[i]!) })),
      ],
      totals: { bytes: PDF.length + dataBytes, file_bytes: PDF.length, data_bytes: dataBytes, files: 1, data: data.length, solution_bytes: 0 },
      contents: { pages: 3, page_images: 0, has_display_pdf: true, annotations: 0, notes: 0, note_pages: 0, study_book: null, questions: { linked: 0, with_solutions: 0 }, flashcards: 0, review_events: 0 },
      not_included_ar: [],
    },
    bundle: {
      format: 'medlevo-offline-1',
      source_id: sourceId,
      version_id: 'V1',
      content_hash: 'H',
      generated_at: 1,
      entries: data.map((d, i) => ({ path: normalizeOfflinePath(d.path), role: d.role, contains_solutions: false, sha256: sha(raws[i]!), body: d.body })),
    },
  };
}

async function realDownload(sourceId: string, withBook: boolean) {
  const { manifest, bundle } = download(sourceId, withBook);
  setFetchImpl(async (url) => new Response(JSON.stringify(url.includes('/manifest') ? manifest : bundle), { status: 200, headers: { 'content-type': 'application/json' } }));
  await downloadSource(sourceId, { fetchFile: vi.fn(async () => new Response(PDF as BodyInit, { status: 200 })) });
}

function setOnline(on: boolean) {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => on });
}

function caps(): CapabilitiesResponse {
  const features = Object.fromEntries(FEATURE_KEYS.map((k) => [k, { key: k, state: 'available' }])) as CapabilitiesResponse['features'];
  return { features, ai: { configured: true }, server_time: 0, app_version: 'test' };
}

function mount(sourceId: string, online: boolean) {
  render(
    <MemoryRouter>
      <ToastProvider>
        <StudyBookPane doc={doc(sourceId)} pageIndex={1} jumpKey={0} onOpenPage={vi.fn()} online={online} />
      </ToastProvider>
    </MemoryRouter>,
  );
}

let network: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  capabilitiesStore.reset(caps());
  await realDownload('LEC', true);
  await realDownload('OLD', false);
  // from here on the server cannot be reached: every request fails at the network level
  network = vi.fn(async () => {
    throw new TypeError('Failed to fetch');
  });
  setFetchImpl(network as unknown as Parameters<typeof setFetchImpl>[0]);
});

afterEach(async () => {
  setOnline(true);
  setFetchImpl(null);
  capabilitiesStore.reset(null);
  await removeDownload('LEC');
  await removeDownload('OLD');
});

describe('Study Book view offline (I1 #1)', () => {
  it('offline: the downloaded book is read from this device, marked as such, with no server action offered', async () => {
    setOnline(false);
    mount('LEC', false);
    expect(await screen.findByText('فقرة من كتاب الدراسة المحمّل.')).toBeTruthy();
    expect(screen.getByTestId('sb-offline-copy').textContent).toContain('تقرأ النسخة المحمّلة على هذا الجهاز');
    expect(screen.queryByRole('button', { name: 'ثبّت هذه النسخة' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'أنشئ نسخة جديدة' })).toBeNull();
    // the Study Book itself never touched the network
    expect(network.mock.calls.filter(([u]) => String(u).includes('/studybook/'))).toHaveLength(0);
  });

  it('offline: a source that was not downloaded says so (no substitute content)', async () => {
    setOnline(false);
    mount('NOPE', false);
    expect(await screen.findByText(STUDY_BOOK_NOT_DOWNLOADED_AR)).toBeTruthy();
    expect(screen.queryByText('فقرة من كتاب الدراسة المحمّل.')).toBeNull();
  });

  it('offline: a Study Book built on another version was not downloaded with this one, and the view says so', async () => {
    setOnline(false);
    mount('OLD', false);
    expect(await screen.findByText(STUDY_BOOK_OTHER_VERSION_AR)).toBeTruthy();
    expect(screen.queryByText('فقرة من كتاب الدراسة المحمّل.')).toBeNull();
  });

  it('browser online but the server unreachable: the downloaded copy is shown instead of an error', async () => {
    setOnline(true);
    mount('LEC', true);
    expect(await screen.findByText('فقرة من كتاب الدراسة المحمّل.')).toBeTruthy();
    expect(screen.getByTestId('sb-offline-copy')).toBeTruthy();
  });

  it('the «كتاب الدراسة» view switch is enabled offline only for a downloaded book', async () => {
    setOnline(false);
    const yes = renderHook(() => useStudyBookAvailability('LEC', false));
    await waitFor(() => expect(yes.result.current).toMatchObject({ hasBook: true, reason: null }));
    const no = renderHook(() => useStudyBookAvailability('NOPE', false));
    await waitFor(() => expect(no.result.current).toMatchObject({ hasBook: false, reason: STUDY_BOOK_NOT_DOWNLOADED_AR }));
  });
});
