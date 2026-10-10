// Download Manager client (lib/offline.ts) with fake-indexeddb: download (hash-verified, record written last, real
// byte progress), quota refusal, removal that never touches the owner's writing, shared files, the offline
// transport (served only when the server cannot be reached, never for mutations), owner-writing seeding, SHA-256.
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newId, normalizeOfflinePath, type OfflineBundleResponse, type OfflineManifestResponse } from '@medlevo/shared';
import { setFetchImpl } from '../../lib/api';
import { MedLevoDB } from '../../lib/localdb';
import {
  apiKeyFor,
  blobKeyFor,
  downloadSource,
  listDownloads,
  offlineAwareFetch,
  OFFLINE_COPY_HEADER,
  OfflineError,
  removeDownload,
  sha256Fallback,
  sha256Hex,
  unsyncedCount,
  type DownloadProgress,
} from '../../lib/offline';
import { writeAndEnqueue } from '../../lib/sync';
import { seedOwnerWriting } from './download';

const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const PDF = new TextEncoder().encode('%PDF-1.7 test fixture bytes for the offline download');

let db: MedLevoDB;
beforeEach(async () => {
  db = new MedLevoDB(`offline-test-${newId()}`);
  await db.open();
});
afterEach(() => {
  setFetchImpl(null);
  vi.unstubAllGlobals();
});

function manifestFor(sourceId: string, opts: { fileId?: string; pdf?: Uint8Array; data?: Record<string, unknown> } = {}): { manifest: OfflineManifestResponse; bundle: OfflineBundleResponse } {
  const fileId = opts.fileId ?? 'FILE1';
  const pdf = opts.pdf ?? PDF;
  const data = opts.data ?? {
    [`/api/sources/${sourceId}`]: { id: sourceId, title: 'محاضرة الزائدة' },
    [`/api/annotations/source/${sourceId}?version_id=V1`]: {
      source_id: sourceId,
      version_ids: ['V1'],
      annotations: [
        {
          id: 'ANN1',
          kind: 'ink',
          tool: 'pen',
          anchor: { type: 'page', source_id: sourceId, version_id: 'V1', page_id: 'P1', page_index: 0, space: 'page_norm' },
          data: { v: 1, points: [] },
          layer: 'ink',
          z: 0,
          locked: false,
          anchor_status: 'ok',
          previous_anchor: null,
          input: null,
          device_id: null,
          rev: 2,
          created_at: 1,
          updated_at: 1,
          deleted_at: null,
        },
      ],
      notes: [],
      note_pages: [],
    },
    [`/api/annotations/notes?source_id=${sourceId}`]: {
      notes: [{ id: 'NOTE1', node_id: null, title: null, body: { v: 1, paragraphs: [{ dir: 'rtl', runs: [{ t: 'من الخادم' }] }] }, anchor: null, origin: 'owner', ai_record: null, rev: 3, conflict_of_id: null, device_id: null, created_at: 1, updated_at: 1, deleted_at: null }],
    },
  };
  const entries = Object.entries(data).map(([path, body]) => {
    const raw = JSON.stringify(body);
    return { kind: 'data' as const, role: path.includes('/annotations/source') ? ('annotations' as const) : path.includes('/notes') ? ('notes' as const) : ('source_detail' as const), path: normalizeOfflinePath(path), size: raw.length, contains_solutions: false, sha256: sha(raw) };
  });
  const dataBytes = entries.reduce((a, e) => a + e.size, 0);
  const manifest: OfflineManifestResponse = {
    format: 'medlevo-offline-1',
    source: { id: sourceId, title: 'محاضرة الزائدة', source_type: 'lecture', format: 'pdf' },
    version: { id: 'V1', version_no: 1, is_active: true, page_count: 1, processing_status: 'ready' },
    include_solutions: true,
    generated_at: 1,
    content_hash: 'H1',
    entries: [{ kind: 'file', role: 'display_pdf', file_id: fileId, url: `/api/files/${fileId}`, mime: 'application/pdf', size: pdf.length, sha256: sha(pdf), page_id: null, page_index: null }, ...entries],
    totals: { bytes: pdf.length + dataBytes, file_bytes: pdf.length, data_bytes: dataBytes, files: 1, data: entries.length, solution_bytes: 0 },
    contents: { pages: 1, page_images: 0, has_display_pdf: true, annotations: 1, notes: 1, note_pages: 0, study_book: null, questions: { linked: 0, with_solutions: 0 }, flashcards: 0, review_events: 0 },
    not_included_ar: ['الذكاء الاصطناعي يحتاج اتصالًا.'],
  };
  const bundle: OfflineBundleResponse = {
    format: 'medlevo-offline-1',
    source_id: sourceId,
    version_id: 'V1',
    content_hash: 'H1',
    generated_at: 1,
    entries: entries.map((e) => ({ path: e.path, role: e.role, contains_solutions: false, sha256: e.sha256, body: data[Object.keys(data).find((k) => normalizeOfflinePath(k) === e.path)!] })),
  };
  return { manifest, bundle };
}

function serve(sources: Record<string, { manifest: OfflineManifestResponse; bundle: OfflineBundleResponse }>) {
  setFetchImpl(async (url) => {
    const m = /\/api\/data\/offline\/([^/]+)\/(manifest|bundle)/.exec(url);
    if (!m) return new Response('{}', { status: 404 });
    const s = sources[m[1]!]!;
    return new Response(JSON.stringify(m[2] === 'manifest' ? s.manifest : s.bundle), { status: 200, headers: { 'content-type': 'application/json' } });
  });
}

const fileFetch = (bytes: Record<string, Uint8Array>) => vi.fn(async (url: string) => {
  const id = url.split('/').pop()!;
  return new Response(bytes[id] as BodyInit, { status: 200 });
});

describe('downloadSource', () => {
  it('stores the hash-verified file, every data answer and the record (last), with real byte progress', async () => {
    const s = manifestFor('S1');
    serve({ S1: s });
    const progress: DownloadProgress[] = [];
    const rec = await downloadSource('S1', { db, fetchFile: fileFetch({ FILE1: PDF }), onProgress: (p) => progress.push(p), seed: (b) => seedOwnerWriting(b, db).then(() => undefined) });
    expect(rec).toMatchObject({ sourceId: 'S1', versionId: 'V1', versionNo: 1, sizeBytes: s.manifest.totals.bytes, includeSolutions: true, contentHash: 'H1' });
    const blob = await db.blobs.get(blobKeyFor('FILE1'));
    expect(blob).toMatchObject({ id: 'file:FILE1', kind: 'display_pdf', size: PDF.length, sha256: sha(PDF), sourceId: 'S1' });
    for (const e of s.bundle.entries) expect((await db.apiCache.get(apiKeyFor(e.path)))?.value).toEqual(e.body);
    expect(progress.map((p) => p.phase)).toEqual(['manifest', 'space', 'files', 'data', 'seed', 'done']);
    const files = progress.find((p) => p.phase === 'files')!;
    expect(files).toMatchObject({ bytesDone: PDF.length, bytesTotal: s.manifest.totals.bytes, filesDone: 1, filesTotal: 1 });
    // owner writing seeded for the reader offline
    expect(await db.annotations.get('ANN1')).toMatchObject({ id: 'ANN1', rev: 2 });
    expect(await db.notes.get('NOTE1')).toMatchObject({ id: 'NOTE1', rev: 3 });
    expect((await listDownloads(db)).map((d) => d.sourceId)).toEqual(['S1']);
  });

  it('a file whose sha256 does not match is refused: nothing kept, no record', async () => {
    const s = manifestFor('S1');
    serve({ S1: s });
    await expect(downloadSource('S1', { db, fetchFile: fileFetch({ FILE1: new TextEncoder().encode('tampered bytes') }) })).rejects.toMatchObject({ code: 'HASH_MISMATCH' });
    expect(await db.blobs.count()).toBe(0);
    expect(await db.offlineSources.count()).toBe(0);
    expect(await db.apiCache.count()).toBe(0);
  });

  it('refuses when the browser says the download will not fit (no partial download)', async () => {
    serve({ S1: manifestFor('S1') });
    vi.stubGlobal('navigator', { ...navigator, storage: { estimate: async () => ({ usage: 990, quota: 1000 }) } });
    const err = await downloadSource('S1', { db, fetchFile: fileFetch({ FILE1: PDF }) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OfflineError);
    expect((err as OfflineError).code).toBe('QUOTA');
    expect((err as OfflineError).message).toContain('تقدير المتصفح');
    expect(await db.offlineSources.count()).toBe(0);
  });

  it('a network failure midway leaves no record and removes what this attempt wrote', async () => {
    const s = manifestFor('S1');
    serve({ S1: s });
    let calls = 0;
    setFetchImpl(async (url) => {
      calls++;
      if (url.includes('/bundle')) throw new TypeError('Failed to fetch');
      return new Response(JSON.stringify(s.manifest), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    await expect(downloadSource('S1', { db, fetchFile: fileFetch({ FILE1: PDF }) })).rejects.toMatchObject({ code: 'NETWORK' });
    expect(calls).toBe(2);
    expect(await db.offlineSources.count()).toBe(0);
    expect(await db.blobs.count()).toBe(0);
  });
});

describe('removeDownload', () => {
  it('drops the copies (keeping a file another download shares) and never the owner\'s writing or unsynced ops', async () => {
    const a = manifestFor('S1', { fileId: 'SHARED' });
    const b = manifestFor('S2', { fileId: 'SHARED', data: { '/api/sources/S2': { id: 'S2' } } });
    serve({ S1: a, S2: b });
    const ff = fileFetch({ SHARED: PDF });
    await downloadSource('S1', { db, fetchFile: ff, seed: (x) => seedOwnerWriting(x, db).then(() => undefined) });
    await downloadSource('S2', { db, fetchFile: ff });
    expect(ff).toHaveBeenCalledTimes(1); // the shared file was not downloaded twice
    // an unsynced local note written while offline
    await writeAndEnqueue(db, db.notes, { id: 'LOCAL', updatedAt: 1, syncState: 'saved_locally', body: { v: 1, paragraphs: [] } }, { entity_type: 'note', op: 'upsert' });
    expect(await unsyncedCount(db)).toBe(1);
    await removeDownload('S1', db);
    expect(await db.offlineSources.get('S1')).toBeUndefined();
    expect(await db.blobs.get(blobKeyFor('SHARED'))).toBeTruthy(); // still used by S2
    expect(await db.apiCache.get(apiKeyFor('/api/sources/S1'))).toBeUndefined();
    expect(await db.apiCache.get(apiKeyFor('/api/sources/S2'))).toBeTruthy();
    expect(await db.notes.get('LOCAL')).toBeTruthy();
    expect(await db.notes.get('NOTE1')).toBeTruthy();
    expect(await db.annotations.get('ANN1')).toBeTruthy();
    expect(await unsyncedCount(db)).toBe(1);
    await removeDownload('S2', db);
    expect(await db.blobs.count()).toBe(0);
    expect(await db.apiCache.count()).toBe(0);
  });
});

describe('offline transport', () => {
  async function cached(path: string, value: unknown) {
    await db.apiCache.put({ key: apiKeyFor(path), value, storedAt: 1234 });
  }

  it('serves the downloaded answer when the network fails, the device is offline, or a proxy answers 503', async () => {
    await cached('/api/sources/S1/versions/V1/pages', { pages: [1] });
    await cached('/api/annotations/source/S1?version_id=V1', { annotations: [] });
    const failing = offlineAwareFetch(async () => {
      throw new TypeError('Failed to fetch');
    }, () => db);
    const r1 = await failing('/api/sources/S1/versions/V1/pages', { method: 'GET' });
    expect(r1.headers.get(OFFLINE_COPY_HEADER)).toBe('1234');
    expect(await r1.json()).toEqual({ pages: [1] });
    // query parameter order does not matter
    const r2 = await failing('/api/annotations/source/S1?version_id=V1', { method: 'GET' });
    expect(await r2.json()).toEqual({ annotations: [] });
    const proxy = offlineAwareFetch(async () => new Response('bad gateway', { status: 503 }), () => db);
    expect(await (await proxy('/api/sources/S1/versions/V1/pages', { method: 'GET' })).json()).toEqual({ pages: [1] });
    vi.stubGlobal('navigator', { ...navigator, onLine: false });
    const base = vi.fn(async () => new Response('{}', { status: 200 }));
    const offline = offlineAwareFetch(base, () => db);
    expect(await (await offline('/api/sources/S1/versions/V1/pages', { method: 'GET' })).json()).toEqual({ pages: [1] });
    expect(base).not.toHaveBeenCalled();
  });

  it('never answers mutations, unknown paths or a caller-cancelled request from the copy; online answers win', async () => {
    await cached('/api/sources/S1', { id: 'S1' });
    const err = new TypeError('Failed to fetch');
    const f = offlineAwareFetch(async () => {
      throw err;
    }, () => db);
    await expect(f('/api/sources/S1', { method: 'POST' })).rejects.toBe(err);
    await expect(f('/api/sources/OTHER', { method: 'GET' })).rejects.toBe(err);
    const ac = new AbortController();
    ac.abort();
    await expect(f('/api/sources/S1', { method: 'GET', signal: ac.signal })).rejects.toBe(err);
    const online = offlineAwareFetch(async () => new Response(JSON.stringify({ id: 'S1', fresh: true }), { status: 200 }), () => db);
    expect(await (await online('/api/sources/S1', { method: 'GET' })).json()).toEqual({ id: 'S1', fresh: true });
    // a real 404 from the server is the answer (the copy is not a substitute for a deleted source)
    const gone = offlineAwareFetch(async () => new Response('{}', { status: 404 }), () => db);
    expect((await gone('/api/sources/S1', { method: 'GET' })).status).toBe(404);
  });
});

describe('seeding and hashing', () => {
  it('seeding never overwrites a note with an unsent local edit or a newer local revision', async () => {
    await writeAndEnqueue(db, db.notes, { id: 'NOTE1', updatedAt: 5, syncState: 'saved_locally', rev: 3, body: { v: 1, paragraphs: [{ dir: 'rtl', runs: [{ t: 'نسختي المحلية' }] }] } }, { entity_type: 'note', op: 'upsert', base_rev: 3 });
    await seedOwnerWriting(manifestFor('S1').bundle, db);
    const n = await db.notes.get('NOTE1');
    expect(JSON.stringify(n?.body)).toContain('نسختي المحلية');
  });

  it('the pure-JS SHA-256 used on insecure origins matches WebCrypto', async () => {
    for (const s of ['', 'abc', 'x'.repeat(55), 'y'.repeat(56), 'z'.repeat(1000), 'مرحبا ×10⁹/L']) {
      const bytes = new TextEncoder().encode(s);
      expect(sha256Fallback(bytes)).toBe(sha(bytes));
      expect(await sha256Hex(bytes.buffer as ArrayBuffer)).toBe(sha(bytes));
    }
  });
});
