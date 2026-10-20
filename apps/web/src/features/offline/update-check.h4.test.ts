// Round 7 H4 item 7 (§47): «تغيّر المحتوى» must mean the SOURCE content changed — not that the owner wrote a note or
// read a page. The manifest carries `source_hash` (the source's pages, regions, Study Book, questions, files) apart from
// `owner_hash` (annotations, notes, session, reading progress, cards); before H4 one hash covered both, so the
// owner's own writing made every download say «تغيّر المحتوى على الخادم».
import { afterEach, describe, expect, it } from 'vitest';
import type { OfflineManifestResponse } from '@medlevo/shared';
import { setFetchImpl } from '../../lib/api';
import { checkForUpdate, type OfflineDownload } from '../../lib/offline';

afterEach(() => setFetchImpl(null));

const rec = (over: Partial<OfflineDownload> = {}): OfflineDownload =>
  ({
    sourceId: 'S1',
    versionId: 'V1',
    versionNo: 1,
    title: 'TEST',
    sourceType: 'lecture',
    format: 'pdf',
    sizeBytes: 1,
    pageCount: 1,
    downloadedAt: 1,
    parts: [],
    contentHash: 'ALL-1',
    sourceHash: 'SRC-1',
    ownerHash: 'OWN-1',
    includeSolutions: true,
    fileIds: [],
    apiKeys: [],
    fileBytes: 0,
    dataBytes: 0,
    solutionBytes: 0,
    contents: { pages: 1, page_images: 0, has_display_pdf: true, annotations: 0, notes: 0, note_pages: 0, study_book: null, questions: { linked: 0, with_solutions: 0 }, flashcards: 0, review_events: 0 },
    notIncluded: [],
    ...over,
  }) as OfflineDownload;

function serveManifest(m: Partial<OfflineManifestResponse>) {
  setFetchImpl(async () => new Response(JSON.stringify({ version: { id: 'V1' }, ...m }), { status: 200, headers: { 'content-type': 'application/json' } }));
}

describe('checkForUpdate (H4)', () => {
  it('only the owner’s writing / reading changed → «owner_changed», never «changed»', async () => {
    serveManifest({ content_hash: 'ALL-2', source_hash: 'SRC-1', owner_hash: 'OWN-2' });
    expect(await checkForUpdate(rec())).toBe('owner_changed');
  });
  it('the source content changed → «changed»', async () => {
    serveManifest({ content_hash: 'ALL-2', source_hash: 'SRC-2', owner_hash: 'OWN-1' });
    expect(await checkForUpdate(rec())).toBe('changed');
  });
  it('nothing changed → «current»; another version → «version_changed»', async () => {
    serveManifest({ content_hash: 'ALL-1', source_hash: 'SRC-1', owner_hash: 'OWN-1' });
    expect(await checkForUpdate(rec())).toBe('current');
    setFetchImpl(async () => new Response(JSON.stringify({ version: { id: 'V2' }, content_hash: 'X', source_hash: 'X', owner_hash: 'X' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    expect(await checkForUpdate(rec())).toBe('version_changed');
  });
  it('a download stored before H4 (no source hash) keeps the old comparison', async () => {
    serveManifest({ content_hash: 'ALL-1', source_hash: 'SRC-9', owner_hash: 'OWN-9' });
    expect(await checkForUpdate(rec({ sourceHash: undefined, ownerHash: undefined }))).toBe('current');
    serveManifest({ content_hash: 'ALL-2', source_hash: 'SRC-9', owner_hash: 'OWN-9' });
    expect(await checkForUpdate(rec({ sourceHash: undefined, ownerHash: undefined }))).toBe('changed');
  });
});
