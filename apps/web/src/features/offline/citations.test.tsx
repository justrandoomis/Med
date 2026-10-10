// A citation offline (AC-23, track D1 × evidence): after the Download Manager stores a lecture (a REAL download record
// written by lib/offline.ts), a citation chip to that lecture's version stays openable while offline, and a chip to a
// page of a source that was NOT downloaded says so — no substitute page. Uses the evidence feature's own CitationChip.
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { normalizeOfflinePath, type EvidenceView, type OfflineBundleResponse, type OfflineManifestResponse } from '@medlevo/shared';
import { setFetchImpl } from '../../lib/api';
import { getDb } from '../../lib/localdb';
import { downloadSource, removeDownload } from '../../lib/offline';
import { CitationChip } from '../evidence/CitationChip';

const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const PDF = new TextEncoder().encode('%PDF-1.7 lecture bytes');

function lectureDownload(): { manifest: OfflineManifestResponse; bundle: OfflineBundleResponse } {
  const body = { id: 'LEC', title: 'Acute Appendicitis' };
  const raw = JSON.stringify(body);
  const path = normalizeOfflinePath('/api/sources/LEC');
  return {
    manifest: {
      format: 'medlevo-offline-1',
      source: { id: 'LEC', title: 'Acute Appendicitis', source_type: 'lecture', format: 'pdf' },
      version: { id: 'V1', version_no: 1, is_active: true, page_count: 4, processing_status: 'ready' },
      include_solutions: true,
      generated_at: 1,
      content_hash: 'H',
      entries: [
        { kind: 'file', role: 'display_pdf', file_id: 'F1', url: '/api/files/F1', mime: 'application/pdf', size: PDF.length, sha256: sha(PDF), page_id: null, page_index: null },
        { kind: 'data', role: 'source_detail', path, size: raw.length, contains_solutions: false, sha256: sha(raw) },
      ],
      totals: { bytes: PDF.length + raw.length, file_bytes: PDF.length, data_bytes: raw.length, files: 1, data: 1, solution_bytes: 0 },
      contents: { pages: 4, page_images: 0, has_display_pdf: true, annotations: 0, notes: 0, note_pages: 0, study_book: null, questions: { linked: 0, with_solutions: 0 }, flashcards: 0, review_events: 0 },
      not_included_ar: [],
    },
    bundle: { format: 'medlevo-offline-1', source_id: 'LEC', version_id: 'V1', content_hash: 'H', generated_at: 1, entries: [{ path, role: 'source_detail', contains_solutions: false, sha256: sha(raw), body }] },
  };
}

const evidence = (over: Partial<EvidenceView>): EvidenceView => ({
  id: 'E1',
  source_id: 'LEC',
  source_title: 'Acute Appendicitis',
  source_type: 'lecture',
  version_id: 'V1',
  version_no: 1,
  page_id: 'P3',
  page_index: 2,
  locator_label_ar: 'ص 13 (الصفحة 3 في الملف)',
  region_id: null,
  region_kind: 'paragraph',
  quote: 'Rebound tenderness at McBurney point.',
  bbox: null,
  extraction_status: 'extracted',
  availability: 'available',
  ...over,
});

function setOnline(on: boolean) {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => on });
  window.dispatchEvent(new Event(on ? 'online' : 'offline'));
}

function renderChips() {
  const ctx = { support_type: 'directly_stated' as const, verification_status: 'linked' as const, relation: 'supports' as const };
  return render(
    <MemoryRouter>
      <CitationChip evidence={evidence({})} context={ctx} />
      <CitationChip evidence={evidence({ id: 'E2', source_id: 'REF', source_title: 'Cholecystitis', source_type: 'course_reference', version_id: 'RV1', page_id: 'RP2', page_index: 1, locator_label_ar: 'ص 2' })} context={ctx} />
    </MemoryRouter>,
  );
}

const chip = (name: RegExp) => screen.getByRole('button', { name });

beforeEach(async () => {
  const { manifest, bundle } = lectureDownload();
  setFetchImpl(async (url) => new Response(JSON.stringify(url.includes('/manifest') ? manifest : bundle), { status: 200, headers: { 'content-type': 'application/json' } }));
  await downloadSource('LEC', { fetchFile: vi.fn(async () => new Response(PDF as BodyInit, { status: 200 })) });
  setFetchImpl(null);
});

afterEach(async () => {
  setOnline(true);
  await removeDownload('LEC');
});

describe('citations offline after a real download', () => {
  it('online: both citations can be opened', () => {
    setOnline(true);
    renderChips();
    expect(chip(/فتح المصدر: .*ص 13/).getAttribute('data-available')).toBe('true');
    expect(chip(/فتح المصدر: .*ص 2/).getAttribute('data-available')).toBe('true');
  });

  it('offline: the downloaded lecture opens; a page of a non-downloaded source says it is not on this device', async () => {
    expect(await getDb().offlineSources.get('LEC')).toMatchObject({ sourceId: 'LEC', versionId: 'V1' });
    renderChips();
    act(() => setOnline(false));
    await waitFor(() => expect(chip(/ص 2/).getAttribute('data-available')).toBe('false'));
    await waitFor(() => expect(chip(/ص 13/).getAttribute('data-available')).toBe('true'));
    fireEvent.click(chip(/ص 2/));
    const peek = screen.getByRole('dialog');
    expect(peek.textContent).toContain('هذه الصفحة غير محمّلة على هذا الجهاز');
    expect((screen.getByRole('button', { name: 'افتح المصدر' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('offline: a citation to ANOTHER version of the downloaded source is not treated as downloaded', async () => {
    const ctx = { support_type: 'directly_stated' as const, verification_status: 'linked' as const, relation: 'supports' as const };
    render(
      <MemoryRouter>
        <CitationChip evidence={evidence({ version_id: 'V0', version_no: 0, locator_label_ar: 'ص 9' })} context={ctx} />
      </MemoryRouter>,
    );
    act(() => setOnline(false));
    await waitFor(() => expect(chip(/ص 9/).getAttribute('data-available')).toBe('false'));
  });
});
