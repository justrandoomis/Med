// Download Manager client (spec §47, AC-23) — track D1.
//
// What a download stores (explicitly, in IndexedDB — never implied by the HTTP cache or the service worker):
//   * files  → `blobs` with id `file:<file_id>` (the reader opens the display PDF from there: workspace/reader/pdfDoc.ts)
//   * data   → `apiCache` with key `offline:<normalized GET path>`: the exact answers the app's own GET requests
//              receive, served by the offline transport below when the server cannot be reached
//   * record → `offlineSources` (one downloaded version per source) with what it holds and its real size
// The owner's writing (notes, ink, attempts, reviews) is NOT part of a download: it lives in the entity tables and
// the outbox, syncs on its own and is never removed here. Removing a download only drops the copies of server
// content. Eviction policy: nothing is ever evicted automatically by the app; the browser may evict a non-persistent
// origin under storage pressure, which is why the owner can ask for persistent storage (on their action only).
// A downloaded copy is a cache, not a backup.
import { liveQuery } from 'dexie';
import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  normalizeOfflinePath,
  type OfflineBundleResponse,
  type OfflineDataRole,
  type OfflineFileEntry,
  type OfflineManifestResponse,
} from '@medlevo/shared';
import { api, ApiError, setFetchImpl } from './api';
import { getDb, kvGet, kvSet, requestPersistentStorage, storageEstimate, type MedLevoDB, type OfflineSourceRecord } from './localdb';
import { SERVER_RESTORE_NOTICE_KEY } from './sync';

export const OFFLINE_KEY_PREFIX = 'offline:';
export const blobKeyFor = (fileId: string) => `file:${fileId}`;
export const apiKeyFor = (path: string) => `${OFFLINE_KEY_PREFIX}${normalizeOfflinePath(path)}`;

/** The stored record of one downloaded source version (extends the core row; extra fields are allowed). */
export interface OfflineDownload extends OfflineSourceRecord {
  versionNo: number;
  sourceType: string;
  format: string;
  contentHash: string;
  includeSolutions: boolean;
  fileIds: string[];
  apiKeys: string[];
  fileBytes: number;
  dataBytes: number;
  solutionBytes: number;
  contents: OfflineManifestResponse['contents'];
  notIncluded: string[];
}

export type DownloadPhase = 'manifest' | 'space' | 'files' | 'data' | 'seed' | 'done';
export interface DownloadProgress {
  phase: DownloadPhase;
  /** real byte counts (files + data) */
  bytesDone: number;
  bytesTotal: number;
  filesDone: number;
  filesTotal: number;
}

export class OfflineError extends Error {
  constructor(
    readonly code: 'QUOTA' | 'HASH_MISMATCH' | 'NETWORK' | 'SERVER' | 'ABORTED',
    message: string,
  ) {
    super(message);
    this.name = 'OfflineError';
  }
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** SHA-256 of downloaded bytes. WebCrypto exists only in secure contexts (https / localhost): a server reached over
 *  plain http on a LAN has no `crypto.subtle`, so a small pure-JS implementation is used there. */
export async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const subtle = typeof crypto !== 'undefined' ? crypto.subtle : undefined;
  if (subtle) {
    const d = await subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return sha256Fallback(new Uint8Array(buf));
}

const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** Pure-JS SHA-256 (FIPS 180-4) for insecure contexts. */
export function sha256Fallback(data: Uint8Array): string {
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const bitLen = data.length * 8;
  const padded = new Uint8Array(((data.length + 9 + 63) >> 6) << 6);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000));
  view.setUint32(padded.length - 4, bitLen >>> 0);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K256[i]! + w[i]!) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0]! + a) >>> 0;
    h[1] = (h[1]! + b) >>> 0;
    h[2] = (h[2]! + c) >>> 0;
    h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0;
    h[5] = (h[5]! + f) >>> 0;
    h[6] = (h[6]! + g) >>> 0;
    h[7] = (h[7]! + hh) >>> 0;
  }
  return Array.from(h, (x) => x.toString(16).padStart(8, '0')).join('');
}

function query(versionId: string | null | undefined, includeSolutions: boolean): string {
  const q = new URLSearchParams();
  if (versionId) q.set('version', versionId);
  q.set('include_solutions', includeSolutions ? '1' : '0');
  return q.toString();
}

export function fetchOfflineManifest(sourceId: string, opts: { versionId?: string | null; includeSolutions?: boolean; signal?: AbortSignal } = {}): Promise<OfflineManifestResponse> {
  return api.get<OfflineManifestResponse>(`/data/offline/${encodeURIComponent(sourceId)}/manifest?${query(opts.versionId, opts.includeSolutions ?? true)}`, {
    signal: opts.signal,
    timeoutMs: 120_000,
  });
}

/** Real usage / quota from the browser (an estimate the BROWSER gives) + persistence state. */
export async function storageInfo(): Promise<{ usage: number; quota: number; persisted: boolean | null } | null> {
  const est = await storageEstimate();
  let persisted: boolean | null = null;
  try {
    persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : null;
  } catch {
    persisted = null;
  }
  return est ? { ...est, persisted } : null;
}

/** Ask the browser to keep this site's data under storage pressure — ONLY call from an owner action. */
export function requestPersistence(): Promise<boolean | null> {
  return requestPersistentStorage();
}

export interface DownloadOptions {
  versionId?: string | null;
  includeSolutions?: boolean;
  onProgress?: (p: DownloadProgress) => void;
  signal?: AbortSignal;
  db?: MedLevoDB;
  /** file transport (tests) */
  fetchFile?: FetchLike;
  /** writes the bundle's owner data into the local tables (notes / ink), see features/offline/download.ts */
  seed?: (bundle: OfflineBundleResponse) => Promise<void>;
  /** require free space for this many times the download size (default 1.2) */
  headroom?: number;
}

async function referencedElsewhere(db: MedLevoDB, sourceId: string): Promise<{ files: Set<string>; keys: Set<string> }> {
  const others = (await db.offlineSources.toArray()) as OfflineDownload[];
  const files = new Set<string>();
  const keys = new Set<string>();
  for (const r of others) {
    if (r.sourceId === sourceId) continue;
    for (const f of r.fileIds ?? []) files.add(f);
    for (const k of r.apiKeys ?? []) keys.add(k);
  }
  return { files, keys };
}

/**
 * Downloads one source version for offline study. Files are verified against their sha256 before they are kept.
 * The `offlineSources` record is written LAST, so an interrupted download never looks complete.
 */
export async function downloadSource(sourceId: string, opts: DownloadOptions = {}): Promise<OfflineDownload> {
  const db = opts.db ?? getDb();
  const includeSolutions = opts.includeSolutions ?? true;
  const fetchFile: FetchLike = opts.fetchFile ?? ((input, init) => fetch(input, init));
  const report = (p: DownloadProgress) => opts.onProgress?.(p);
  const aborted = () => {
    if (opts.signal?.aborted) throw new OfflineError('ABORTED', 'أُوقف التنزيل. لم يُعدَّ المصدر محمّلًا.');
  };

  report({ phase: 'manifest', bytesDone: 0, bytesTotal: 0, filesDone: 0, filesTotal: 0 });
  const manifest = await fetchOfflineManifest(sourceId, { versionId: opts.versionId, includeSolutions, signal: opts.signal });
  const files = manifest.entries.filter((e): e is OfflineFileEntry => e.kind === 'file');
  const total = manifest.totals.bytes;

  // space: never start a download the browser says will not fit
  report({ phase: 'space', bytesDone: 0, bytesTotal: total, filesDone: 0, filesTotal: files.length });
  const est = await storageEstimate();
  if (est && est.quota > 0) {
    const free = est.quota - est.usage;
    if (free < total * (opts.headroom ?? 1.2)) {
      throw new OfflineError('QUOTA', `المساحة المتاحة لهذا الموقع في المتصفح لا تكفي لهذا التنزيل (يحتاج نحو ${formatBytes(total)}، والمتاح ${formatBytes(Math.max(0, free))} حسب تقدير المتصفح).`);
    }
  }

  const written: { blobs: string[]; keys: string[] } = { blobs: [], keys: [] };
  let bytesDone = 0;
  let filesDone = 0;
  try {
    for (const f of files) {
      aborted();
      const key = blobKeyFor(f.file_id);
      const existing = (await db.blobs.get(key)) as (OfflineBlob | undefined) ?? undefined;
      if (!(existing && existing.sha256 === f.sha256 && existing.size === f.size)) {
        let res: Response;
        try {
          res = await fetchFile(f.url, { method: 'GET', credentials: 'same-origin', signal: opts.signal, cache: 'no-store' });
        } catch {
          aborted();
          throw new OfflineError('NETWORK', 'انقطع الاتصال أثناء التنزيل. لم يُعدَّ المصدر محمّلًا؛ أعد المحاولة عند عودة الاتصال.');
        }
        if (!res.ok) throw new OfflineError('SERVER', `تعذّر تنزيل ملف من الخادم (رمز ${res.status}).`);
        const buf = await res.arrayBuffer();
        const hash = await sha256Hex(buf);
        if (hash !== f.sha256 || buf.byteLength !== f.size) {
          throw new OfflineError('HASH_MISMATCH', 'وصل ملف لا تطابق بصمته (sha256) ما في الخادم؛ لم يُحفظ. أعد المحاولة.');
        }
        const rec: OfflineBlob = { id: key, sourceId, versionId: manifest.version.id, kind: f.role, mime: f.mime, size: f.size, data: new Blob([buf], { type: f.mime }), storedAt: Date.now(), sha256: f.sha256 };
        await db.blobs.put(rec);
        written.blobs.push(key);
      }
      bytesDone += f.size;
      filesDone++;
      report({ phase: 'files', bytesDone, bytesTotal: total, filesDone, filesTotal: files.length });
    }

    aborted();
    report({ phase: 'data', bytesDone, bytesTotal: total, filesDone, filesTotal: files.length });
    const bundle = await api.get<OfflineBundleResponse>(`/data/offline/${encodeURIComponent(sourceId)}/bundle?${query(manifest.version.id, includeSolutions)}`, {
      signal: opts.signal,
      timeoutMs: 180_000,
    });
    const storedAt = Date.now();
    await db.transaction('rw', db.apiCache, async () => {
      for (const e of bundle.entries) {
        const key = apiKeyFor(e.path);
        await db.apiCache.put({ key, value: e.body, storedAt, etag: e.sha256 });
        written.keys.push(key);
      }
    });
    bytesDone = total;
    report({ phase: 'seed', bytesDone, bytesTotal: total, filesDone, filesTotal: files.length });
    if (opts.seed) await opts.seed(bundle);

    const record: OfflineDownload = {
      sourceId,
      versionId: manifest.version.id,
      versionNo: manifest.version.version_no,
      title: manifest.source.title,
      sourceType: manifest.source.source_type,
      format: manifest.source.format,
      sizeBytes: total,
      pageCount: manifest.contents.pages,
      downloadedAt: storedAt,
      parts: partsOf(manifest),
      contentHash: bundle.content_hash,
      includeSolutions,
      fileIds: files.map((f) => f.file_id),
      apiKeys: bundle.entries.map((e) => apiKeyFor(e.path)),
      fileBytes: manifest.totals.file_bytes,
      dataBytes: manifest.totals.data_bytes,
      solutionBytes: manifest.totals.solution_bytes,
      contents: manifest.contents,
      notIncluded: manifest.not_included_ar,
    };
    // a previous download of another version of this source: drop what only it used
    const previous = (await db.offlineSources.get(sourceId)) as OfflineDownload | undefined;
    await db.offlineSources.put(record);
    if (previous) await dropUnreferenced(db, sourceId, previous, record);
    report({ phase: 'done', bytesDone, bytesTotal: total, filesDone, filesTotal: files.length });
    return record;
  } catch (e) {
    // undo what this attempt wrote that no complete download references
    const keep = await referencedElsewhere(db, '\u0000');
    const own = (await db.offlineSources.get(sourceId)) as OfflineDownload | undefined;
    for (const k of written.blobs) {
      const fid = k.slice(5);
      if (!keep.files.has(fid) && !(own?.fileIds ?? []).includes(fid)) await db.blobs.delete(k);
    }
    for (const k of written.keys) if (!keep.keys.has(k) && !(own?.apiKeys ?? []).includes(k)) await db.apiCache.delete(k);
    if (e instanceof OfflineError) throw e;
    if (e instanceof ApiError) throw new OfflineError(e.offline ? 'NETWORK' : 'SERVER', e.message);
    if (opts.signal?.aborted) throw new OfflineError('ABORTED', 'أُوقف التنزيل. لم يُعدَّ المصدر محمّلًا.');
    throw e;
  }
}

interface OfflineBlob {
  id: string;
  sourceId?: string | null;
  versionId?: string | null;
  kind: string;
  mime: string;
  size: number;
  data: Blob;
  storedAt: number;
  sha256?: string;
}

function partsOf(m: OfflineManifestResponse): string[] {
  const parts: string[] = [];
  if (m.contents.has_display_pdf) parts.push('pdf');
  if (m.contents.page_images) parts.push('page_images');
  parts.push('pages');
  if (m.contents.annotations || m.contents.notes) parts.push('my_writing');
  if (m.contents.study_book) parts.push('study_book');
  if (m.contents.questions.linked) parts.push(m.contents.questions.with_solutions ? 'questions_with_solutions' : 'questions');
  if (m.contents.flashcards) parts.push('flashcards');
  return parts;
}

async function dropUnreferenced(db: MedLevoDB, sourceId: string, old: OfflineDownload, now: OfflineDownload | null): Promise<void> {
  const others = await referencedElsewhere(db, sourceId);
  const keepFiles = new Set([...others.files, ...(now?.fileIds ?? [])]);
  const keepKeys = new Set([...others.keys, ...(now?.apiKeys ?? [])]);
  await db.transaction('rw', [db.blobs, db.apiCache], async () => {
    for (const f of old.fileIds ?? []) if (!keepFiles.has(f)) await db.blobs.delete(blobKeyFor(f));
    for (const k of old.apiKeys ?? []) if (!keepKeys.has(k)) await db.apiCache.delete(k);
  });
}

/**
 * Removes a download: its files and stored answers (when no other download uses them). The owner's notes, ink,
 * attempts, reviews and every unsynced write stay untouched — they are not part of a download.
 */
export async function removeDownload(sourceId: string, db: MedLevoDB = getDb()): Promise<boolean> {
  const rec = (await db.offlineSources.get(sourceId)) as OfflineDownload | undefined;
  if (!rec) return false;
  await db.offlineSources.delete(sourceId);
  await dropUnreferenced(db, sourceId, rec, null);
  return true;
}

export async function listDownloads(db: MedLevoDB = getDb()): Promise<OfflineDownload[]> {
  const rows = (await db.offlineSources.toArray()) as OfflineDownload[];
  return rows.sort((a, b) => b.downloadedAt - a.downloadedAt);
}

/** Live list of downloads (all tabs). */
export function useDownloads(db: MedLevoDB = getDb()): OfflineDownload[] | null {
  const [rows, setRows] = useState<OfflineDownload[] | null>(null);
  useEffect(() => {
    const sub = liveQuery(() => listDownloads(db)).subscribe({ next: setRows, error: () => setRows([]) });
    return () => sub.unsubscribe();
  }, [db]);
  return rows;
}

// One shared live query for the per-row «on this device» state (a library list can show hundreds of rows).
let sharedRows: OfflineDownload[] | null = null;
let sharedSub: { unsubscribe(): void } | null = null;
const sharedListeners = new Set<() => void>();

function subscribeShared(cb: () => void): () => void {
  sharedListeners.add(cb);
  if (!sharedSub) {
    const notify = (rows: OfflineDownload[]) => {
      sharedRows = rows;
      for (const l of sharedListeners) l();
    };
    sharedSub = liveQuery(() => listDownloads()).subscribe({ next: notify, error: () => notify([]) });
  }
  return () => {
    sharedListeners.delete(cb);
    if (sharedListeners.size === 0 && sharedSub) {
      sharedSub.unsubscribe();
      sharedSub = null;
      sharedRows = null;
    }
  };
}

/** The download record of one source on this device: `undefined` while loading, `null` when not downloaded. */
export function useDownloadRecord(sourceId: string): OfflineDownload | null | undefined {
  return useSyncExternalStore(
    subscribeShared,
    () => (sharedRows === null ? undefined : (sharedRows.find((r) => r.sourceId === sourceId) ?? null)),
    () => undefined,
  );
}

/** Compares a download with the server's current content (needs a connection). */
export async function checkForUpdate(rec: OfflineDownload): Promise<'current' | 'changed' | 'version_changed'> {
  const m = await fetchOfflineManifest(rec.sourceId, { includeSolutions: rec.includeSolutions });
  if (m.version.id !== rec.versionId) return 'version_changed';
  return m.content_hash === rec.contentHash ? 'current' : 'changed';
}

/** Owner-visible count of local writes not yet confirmed by the server (never removed by the Download Manager). */
export async function unsyncedCount(db: MedLevoDB = getDb()): Promise<number> {
  return db.outbox.where('status').anyOf('pending', 'conflict', 'rejected').filter((o) => !o.acknowledgedAt || o.status === 'pending').count();
}

// ───────────────────────────── offline transport ─────────────────────────────
export const OFFLINE_COPY_HEADER = 'x-medlevo-offline-copy';

function isApiGet(input: string, init: RequestInit): boolean {
  const method = (init.method ?? 'GET').toUpperCase();
  if (method !== 'GET') return false;
  try {
    const u = new URL(input, 'http://local.invalid');
    return u.pathname.startsWith('/api/') && (u.origin === 'http://local.invalid' || (typeof location !== 'undefined' && u.origin === location.origin));
  } catch {
    return false;
  }
}

async function offlineCopy(db: MedLevoDB, input: string): Promise<Response | null> {
  try {
    const row = await db.apiCache.get(apiKeyFor(input));
    if (!row) return null;
    return new Response(JSON.stringify(row.value), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8', [OFFLINE_COPY_HEADER]: String(row.storedAt) },
    });
  } catch {
    return null;
  }
}

/**
 * The stored answer of one downloaded GET (`/api/...` path, any query order), read straight from IndexedDB without
 * touching the network. `null` when no download holds it — the caller must then say that it is not on this device.
 */
export async function readOfflineAnswer<T>(path: string, db: MedLevoDB = getDb()): Promise<{ value: T; storedAt: number } | null> {
  try {
    const row = await db.apiCache.get(apiKeyFor(path));
    return row ? { value: row.value as T, storedAt: row.storedAt } : null;
  } catch {
    return null;
  }
}

/** A downloaded file (display PDF, page image…) as a Blob, or null when it is not on this device. */
export async function readOfflineFile(fileId: string, db: MedLevoDB = getDb()): Promise<Blob | null> {
  try {
    const rec = (await db.blobs.get(blobKeyFor(fileId))) ?? (await db.blobs.get(fileId));
    return rec?.data ?? null;
  } catch {
    return null;
  }
}

/**
 * `src` for an `<img>` of a stored file (page image, thumbnail). Image requests never pass through the API transport,
 * so a downloaded file is shown from IndexedDB through an object URL (revoked when the component unmounts or the file
 * changes); otherwise the authenticated file route is used. `null` while the local lookup runs (a few ms).
 */
export function useFileSrc(fileId: string | null | undefined, db?: MedLevoDB): string | null {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!fileId) {
      setSrc(null);
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    setSrc(null);
    void readOfflineFile(fileId, db ?? getDb()).then((blob) => {
      if (cancelled) return;
      if (blob && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      } else {
        setSrc(`/api/files/${encodeURIComponent(fileId)}`);
      }
    });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [fileId, db]);
  return src;
}

/**
 * Wraps a fetch: GET /api requests that cannot reach the server (offline, network error, 502/503/504 from a proxy)
 * are answered from the explicitly downloaded copy when one exists. Everything else is untouched — in particular
 * nothing is ever written to the cache here, and mutations always go to the network.
 */
export function offlineAwareFetch(base: FetchLike, dbFn: () => MedLevoDB = getDb): FetchLike {
  return async (input, init) => {
    if (!isApiGet(input, init)) return base(input, init);
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      const hit = await offlineCopy(dbFn(), input);
      if (hit) return hit;
    }
    let res: Response;
    try {
      res = await base(input, init);
    } catch (err) {
      if (init.signal?.aborted) throw err; // the caller cancelled or timed out
      const hit = await offlineCopy(dbFn(), input);
      if (hit) return hit;
      throw err;
    }
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      const hit = await offlineCopy(dbFn(), input);
      if (hit) return hit;
    }
    return res;
  };
}

let transportInstalled = false;
/** Installs the offline transport for lib/api.ts (once, at app start). */
export function installOfflineTransport(): void {
  if (transportInstalled || typeof window === 'undefined') return;
  transportInstalled = true;
  setFetchImpl(offlineAwareFetch((input, init) => fetch(input, init)));
}

// ───────────────────────────── server restore notice ─────────────────────────────
export interface ServerRestoreNotice {
  at: number;
  resent: number;
  previous_epoch: string | null;
  epoch: string;
}

/** Set by the sync engine when the server's data was restored from a backup (track D1). */
export function useServerRestoreNotice(db: MedLevoDB = getDb()): ServerRestoreNotice | null {
  const [notice, setNotice] = useState<ServerRestoreNotice | null>(null);
  useEffect(() => {
    const sub = liveQuery(() => kvGet<ServerRestoreNotice | null>(db, SERVER_RESTORE_NOTICE_KEY)).subscribe({
      next: (v) => setNotice(v ?? null),
      error: () => setNotice(null),
    });
    return () => sub.unsubscribe();
  }, [db]);
  return notice;
}

export function dismissServerRestoreNotice(db: MedLevoDB = getDb()): Promise<void> {
  return kvSet(db, SERVER_RESTORE_NOTICE_KEY, null);
}

// ───────────────────────────── formatting ─────────────────────────────
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? Math.round(v) : v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

export const DATA_ROLE_LABELS_AR: Record<OfflineDataRole, string> = {
  source_detail: 'بيانات المصدر وإصداراته',
  pages: 'قائمة الصفحات وأرقامها',
  page_regions: 'نص الصفحات ومناطقها (للبحث والتحديد)',
  annotations: 'كتاباتك وتمييزاتك على الصفحات',
  notes: 'ملاحظاتك',
  needs_reanchor: 'ما يحتاج إعادة ربط',
  latest_session: 'آخر موضع قراءة',
  reading_progress: 'الصفحات التي عُرضت',
  study_book_status: 'حالة كتاب الدراسة',
  study_book: 'كتاب الدراسة مع أدلته',
  lecture_questions: 'الأسئلة المرتبطة بالمحاضرة',
  question_detail: 'تفاصيل الأسئلة مع حلولها',
  learning: 'البطاقات وسجل مراجعتها',
};
