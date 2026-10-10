// Recordings on this device first (§29, §47, track F4): a finished recording is stored in IndexedDB (`blobs`, id
// `rec:<recordingId>`) before anything goes to the network, then uploaded to POST /api/media/recordings (idempotent by
// the recording id; retried with backoff while the app is open). Chunks written during the recording
// (`recchunk:<id>:<seq>`) are assembled into a recording again if the page died before «إيقاف» (nothing recorded is
// lost). A refusal of the bytes themselves (type / size) is kept on the device with the server's reason.
import type { RecordingResponse, RecordingView } from '@medlevo/shared';
import { api, isApiError } from '../../../lib/api';
import { peekDeviceId } from '../../../lib/deviceId';
import { getDb, type BlobRecord, type MedLevoDB } from '../../../lib/localdb';
import type { FinishedRecording, RecordingMeta } from './recorder';

export const RECORDING_BLOB_KIND = 'audio_recording';
export const RECORDING_CHUNK_KIND = 'audio_recording_chunk';
export const recordingBlobId = (id: string) => `rec:${id}`;
const chunkId = (id: string, seq: number) => `recchunk:${id}:${String(seq).padStart(6, '0')}`;

export type RecordingUploadState = 'pending' | 'uploaded' | 'rejected';

export interface RecordingBlobRecord extends BlobRecord {
  recordingId: string;
  uploadState: RecordingUploadState;
  uploadError?: string | null;
  attempts?: number;
  nextAttemptAt?: number;
  startedAt: number;
  durationMs: number | null;
  linkedSourceId: string | null;
  nodeId: string | null;
  title?: string | null;
  /** the my_audio_note source on the server, once uploaded */
  serverSourceId?: string | null;
  /** assembled from chunks after an interrupted session (duration unknown) */
  recovered?: boolean;
  /** the owner asked to send it again: it stays listed until it reaches the server (or fails again) */
  ownerRetry?: boolean;
}

interface ChunkRecord extends BlobRecord {
  recordingId: string;
  seq: number;
  startedAt: number;
  linkedSourceId: string | null;
  nodeId: string | null;
  title?: string | null;
}

const BACKOFF_MS = [2_000, 10_000, 30_000, 120_000, 600_000];
/** only these answers judge the bytes themselves; anything else is retried */
const FINAL_UPLOAD_STATUSES = new Set([400, 413, 415, 422]);

export async function saveRecordingChunk(db: MedLevoDB, recordingId: string, seq: number, chunk: Blob, meta: RecordingMeta & { mime: string; startedAt: number }): Promise<void> {
  const rec: ChunkRecord = {
    id: chunkId(recordingId, seq),
    kind: RECORDING_CHUNK_KIND,
    sourceId: meta.linkedSourceId,
    mime: meta.mime,
    size: chunk.size,
    data: chunk,
    storedAt: Date.now(),
    recordingId,
    seq,
    startedAt: meta.startedAt,
    linkedSourceId: meta.linkedSourceId,
    nodeId: meta.nodeId,
    title: meta.title ?? null,
  };
  await db.blobs.put(rec);
}

/** The finished recording on this device (chunks are dropped only after the whole recording is stored). */
export async function saveFinishedRecording(db: MedLevoDB, r: FinishedRecording): Promise<void> {
  const rec: RecordingBlobRecord = {
    id: recordingBlobId(r.recordingId),
    kind: RECORDING_BLOB_KIND,
    sourceId: r.linkedSourceId,
    mime: r.mime,
    size: r.blob.size,
    data: r.blob,
    storedAt: Date.now(),
    recordingId: r.recordingId,
    uploadState: 'pending',
    startedAt: r.startedAt,
    durationMs: r.durationMs,
    linkedSourceId: r.linkedSourceId,
    nodeId: r.nodeId,
    title: r.title ?? null,
  };
  await db.transaction('rw', db.blobs, async () => {
    await db.blobs.put(rec);
    const chunks = await db.blobs.where('kind').equals(RECORDING_CHUNK_KIND).filter((c) => (c as ChunkRecord).recordingId === r.recordingId).primaryKeys();
    await db.blobs.bulkDelete(chunks);
  });
  notify();
}

// ───────── which recordings are still being made (in this tab or another one) ─────────
const LOCK_PREFIX = 'medlevo-recording:';
/** without the Web Locks API, chunks younger than this may belong to a recording still running in another tab */
export const RECOVERY_MIN_AGE_MS = 2 * 60_000;

type LockManagerLike = {
  request(name: string, cb: () => Promise<void>): Promise<unknown>;
  query?(): Promise<{ held?: Array<{ name?: string }> }>;
};
function lockManager(): LockManagerLike | null {
  const l = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator?.locks;
  return l && typeof l.request === 'function' ? l : null;
}

/**
 * Held by the tab that records, from the start until the recording is stored on the device (or given up): another tab
 * opening the reader must never «recover» a recording that is still being made (its chunks would be uploaded as a
 * truncated recording under the same id, and the full one would then be taken for a retry of it).
 */
export function holdRecordingLock(recordingId: string, locks: LockManagerLike | null = lockManager()): () => void {
  if (!locks) return () => undefined;
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  void locks.request(LOCK_PREFIX + recordingId, () => held).catch(() => undefined);
  return release;
}

/** Recording ids whose lock is held right now (null when this browser cannot tell). */
export async function heldRecordingIds(locks: LockManagerLike | null = lockManager()): Promise<Set<string> | null> {
  if (!locks?.query) return null;
  try {
    const q = await locks.query();
    return new Set((q.held ?? []).map((l) => l.name ?? '').filter((n) => n.startsWith(LOCK_PREFIX)).map((n) => n.slice(LOCK_PREFIX.length)));
  } catch {
    return null;
  }
}

/**
 * Recordings whose page died before «إيقاف»: their chunks become a recording again (never silently lost). A recording
 * still being made — the active one here, one whose lock another tab holds, or (when locks cannot be queried) one with
 * a chunk written in the last minutes — is left alone; a later pass recovers it if it really was interrupted.
 */
export async function recoverInterruptedRecordings(
  db: MedLevoDB = getDb(),
  activeId: string | null = null,
  opts: { held?: Set<string> | null; now?: number } = {},
): Promise<number> {
  const chunks = (await db.blobs.where('kind').equals(RECORDING_CHUNK_KIND).toArray()) as ChunkRecord[];
  const held = opts.held !== undefined ? opts.held : await heldRecordingIds();
  const now = opts.now ?? Date.now();
  const byId = new Map<string, ChunkRecord[]>();
  for (const c of chunks) {
    if (c.recordingId === activeId || held?.has(c.recordingId)) continue;
    const list = byId.get(c.recordingId) ?? [];
    list.push(c);
    byId.set(c.recordingId, list);
  }
  let n = 0;
  for (const [recordingId, list] of byId) {
    if (!held && Math.max(...list.map((c) => c.storedAt ?? 0)) > now - RECOVERY_MIN_AGE_MS) continue;
    if (await db.blobs.get(recordingBlobId(recordingId))) {
      await db.blobs.bulkDelete(list.map((c) => c.id));
      continue;
    }
    list.sort((a, b) => a.seq - b.seq);
    const parts = list.map((c) => c.data).filter((d): d is Blob => d instanceof Blob);
    if (parts.length === 0) continue;
    const first = list[0]!;
    const blob = new Blob(parts, { type: first.mime });
    await saveFinishedRecording(db, { recordingId, blob, mime: first.mime, startedAt: first.startedAt, durationMs: 0, linkedSourceId: first.linkedSourceId, nodeId: first.nodeId, title: first.title ?? null });
    await db.blobs.update(recordingBlobId(recordingId), { recovered: true, durationMs: null } as Partial<RecordingBlobRecord>);
    n++;
  }
  return n;
}

const listeners = new Set<() => void>();
function notify() {
  listeners.forEach((l) => l());
}
export function onRecordingsChanged(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export async function localRecording(recordingId: string, db: MedLevoDB = getDb()): Promise<RecordingBlobRecord | null> {
  try {
    return ((await db.blobs.get(recordingBlobId(recordingId))) as RecordingBlobRecord | undefined) ?? null;
  } catch {
    return null;
  }
}

/**
 * Recordings on this device that have not reached the server and need the owner's eye: refused by the server (kept
 * here with its reason), recovered after an interrupted session, or still waiting after a failed attempt. A fresh
 * recording that is being uploaded right now is not listed (the recording bar already says it is on its way).
 */
export async function deviceRecordingsNeedingAttention(db: MedLevoDB = getDb()): Promise<RecordingBlobRecord[]> {
  const rows = (await db.blobs.where('kind').equals(RECORDING_BLOB_KIND).toArray()) as RecordingBlobRecord[];
  return rows
    .filter((r) => r.uploadState === 'rejected' || (r.uploadState === 'pending' && ((r.attempts ?? 0) > 0 || r.recovered || r.ownerRetry)))
    .sort((a, b) => b.startedAt - a.startedAt);
}

/** The owner asks to try the upload again now (a refused one too, e.g. after raising the server's upload limit). */
export async function retryRecordingUpload(recordingId: string, db: MedLevoDB = getDb(), deps: RecordingUploadDeps = {}): Promise<void> {
  await db.blobs.update(recordingBlobId(recordingId), { uploadState: 'pending', attempts: 0, nextAttemptAt: 0, uploadError: null, ownerRetry: true } as Partial<RecordingBlobRecord>);
  notify();
  await kickRecordingUploads(db, deps);
}

/** File name for a downloaded copy of a recording («recording-<id>.webm»). */
export function recordingFileName(recordingId: string, mime: string): string {
  const ext = mime.includes('ogg') ? 'ogg' : mime.includes('mp4') ? 'm4a' : mime.includes('wav') ? 'wav' : mime.includes('mpeg') ? 'mp3' : 'webm';
  return `recording-${recordingId}.${ext}`;
}

/** Hands the owner a copy of a recording as a file (the device copy is never the only way out). */
export function downloadRecording(blob: Blob, fileName: string, doc: Document = document): boolean {
  if (typeof URL.createObjectURL !== 'function') return false;
  const url = URL.createObjectURL(blob);
  const a = doc.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  doc.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return true;
}

export interface RecordingUploadDeps {
  post?: (form: FormData) => Promise<RecordingResponse>;
  now?: () => number;
  online?: () => boolean;
}

let running: Promise<{ uploaded: number; rejected: number; failed: number }> | null = null;

/** Upload every due pending recording once. Concurrent calls share one run. */
export function kickRecordingUploads(db: MedLevoDB = getDb(), deps: RecordingUploadDeps = {}): Promise<{ uploaded: number; rejected: number; failed: number }> {
  if (running) return running;
  running = (async () => {
    const out = { uploaded: 0, rejected: 0, failed: 0 };
    const online = deps.online ?? (() => typeof navigator === 'undefined' || navigator.onLine !== false);
    if (!online()) return out;
    const now = deps.now ?? Date.now;
    const post = deps.post ?? ((form: FormData) => api.post<RecordingResponse>('/media/recordings', form, { timeoutMs: 300_000, skipAuthRedirect: true }));
    const pending = ((await db.blobs.where('kind').equals(RECORDING_BLOB_KIND).toArray()) as RecordingBlobRecord[]).filter((r) => r.uploadState === 'pending');
    for (const rec of pending) {
      if ((rec.nextAttemptAt ?? 0) > now()) continue;
      if (!(rec.data instanceof Blob)) {
        await db.blobs.update(rec.id, { uploadState: 'rejected', uploadError: 'لم يعد التسجيل محفوظًا كاملًا على هذا الجهاز.' } as Partial<RecordingBlobRecord>);
        out.rejected++;
        continue;
      }
      const form = new FormData();
      form.append('recording_id', rec.recordingId);
      form.append('started_at', String(Math.round(rec.startedAt)));
      if (rec.durationMs) form.append('duration_ms', String(Math.round(rec.durationMs)));
      if (rec.linkedSourceId) form.append('linked_source_id', rec.linkedSourceId);
      if (rec.nodeId) form.append('node_id', rec.nodeId);
      if (rec.title) form.append('title', rec.title);
      const device = peekDeviceId();
      if (device) form.append('device_id', device.slice(0, 64));
      form.append('file', rec.data, recordingFileName(rec.recordingId, rec.mime));
      try {
        const res = await post(form);
        await db.blobs.update(rec.id, { uploadState: 'uploaded', uploadError: null, serverSourceId: res.recording.source_id } as Partial<RecordingBlobRecord>);
        out.uploaded++;
      } catch (e) {
        const status = isApiError(e) ? e.status : 0;
        if (isApiError(e) && !e.offline && FINAL_UPLOAD_STATUSES.has(status)) {
          await db.blobs.update(rec.id, { uploadState: 'rejected', uploadError: e.message } as Partial<RecordingBlobRecord>);
          out.rejected++;
        } else {
          const attempts = (rec.attempts ?? 0) + 1;
          await db.blobs.update(rec.id, { attempts, nextAttemptAt: now() + BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)]!, uploadError: isApiError(e) ? e.message : null } as Partial<RecordingBlobRecord>);
          out.failed++;
          if (isApiError(e) && (e.offline || status === 401)) break;
        }
      }
    }
    return out;
  })().finally(() => {
    running = null;
    notify();
  });
  return running;
}

let started = false;
/** Recover interrupted recordings, then upload pending ones — on start, when online and every minute. */
export function startRecordingUploader(db: MedLevoDB = getDb(), activeId: () => string | null = () => null): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  const kick = () =>
    void recoverInterruptedRecordings(db, activeId())
      .catch(() => 0)
      .then(() => kickRecordingUploads(db));
  kick();
  window.addEventListener('online', kick);
  window.setInterval(kick, 60_000);
}

export interface PlaybackSource {
  url: string;
  /** a device copy (object URL) — revoke when done */
  local: boolean;
  title: string | null;
}

/** Where to play a recording: the device copy when this device recorded it, else the server's stream. */
export async function playbackSource(recordingId: string, deps: { db?: MedLevoDB; fetchView?: (id: string) => Promise<RecordingView> } = {}): Promise<PlaybackSource> {
  const local = await localRecording(recordingId, deps.db ?? getDb());
  if (local?.data instanceof Blob && typeof URL.createObjectURL === 'function') {
    return { url: URL.createObjectURL(local.data), local: true, title: local.title ?? null };
  }
  const fetchView = deps.fetchView ?? ((id: string) => api.get<{ recording: RecordingView }>(`/media/recordings/${encodeURIComponent(id)}`).then((r) => r.recording));
  const view = await fetchView(recordingId);
  if (!view.stream_url) throw new Error('التسجيل موجود على الخادم لكن ملفه الصوتي غير متاح بعد.');
  return { url: view.stream_url, local: false, title: view.title };
}
