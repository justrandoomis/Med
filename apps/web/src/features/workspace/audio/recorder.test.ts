// Track F4 — in-app recording (§29) with a mocked MediaRecorder / getUserMedia: the microphone is requested only by an
// explicit start, permission errors are explained, the indicator state machine is honest, the recording is stored on
// the device (chunks while recording, the whole recording at stop) and strokes written meanwhile get time links that
// exclude paused time. Uploads / recovery run against a minimal blob table (jsdom Blobs do not survive
// fake-indexeddb's structured clone).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../lib/api';
import type { MedLevoDB } from '../../../lib/localdb';
import { audioLinkAt, getActiveRecording, setActiveRecording } from '../ink/audioLink';
import { classifyMediaError, RecorderController, RECORDER_ERRORS_AR, recordingSupport, type FinishedRecording, type RecorderEnv } from './recorder';
import {
  deviceRecordingsNeedingAttention,
  heldRecordingIds,
  holdRecordingLock,
  kickRecordingUploads,
  recordingBlobId,
  recordingFileName,
  RECOVERY_MIN_AGE_MS,
  recoverInterruptedRecordings,
  retryRecordingUpload,
  saveFinishedRecording,
  saveRecordingChunk,
  type RecordingBlobRecord,
} from './recordings';

class FakeTrack {
  stopped = false;
  stop() {
    this.stopped = true;
  }
}

class FakeRecorder {
  static instances: FakeRecorder[] = [];
  static isTypeSupported = (t: string) => t === 'audio/webm;codecs=opus';
  state: 'inactive' | 'recording' | 'paused' = 'inactive';
  mimeType: string;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  timeslice: number | undefined;
  constructor(
    readonly stream: { getTracks(): FakeTrack[] },
    opts?: { mimeType?: string },
  ) {
    this.mimeType = opts?.mimeType ?? 'audio/webm';
    FakeRecorder.instances.push(this);
  }
  start(timeslice?: number) {
    this.timeslice = timeslice;
    this.state = 'recording';
  }
  /** test helper: the browser hands over a chunk */
  emit(text: string) {
    this.ondataavailable?.({ data: new Blob([text], { type: 'audio/webm' }) });
  }
  pause() {
    this.state = 'paused';
  }
  resume() {
    this.state = 'recording';
  }
  stop() {
    this.emit('-last');
    this.state = 'inactive';
    setTimeout(() => this.onstop?.(), 0);
  }
}

function env(getUserMedia: RecorderEnv['getUserMedia'], extra: Partial<RecorderEnv> = {}): RecorderEnv {
  return { MediaRecorder: FakeRecorder as unknown as RecorderEnv['MediaRecorder'], getUserMedia, isSecureContext: true, ...extra };
}

afterEach(() => {
  FakeRecorder.instances = [];
  setActiveRecording(null);
});

describe('recording support and consent', () => {
  it('says why recording is unavailable (no MediaRecorder / insecure page) without touching the microphone', () => {
    expect(recordingSupport({ isSecureContext: true })).toEqual({ supported: false, reason: RECORDER_ERRORS_AR.unsupported });
    expect(recordingSupport({ isSecureContext: false, MediaRecorder: FakeRecorder as never, getUserMedia: vi.fn() })).toEqual({ supported: false, reason: RECORDER_ERRORS_AR.insecure });
    expect(recordingSupport(env(vi.fn()))).toEqual({ supported: true, reason: null });
  });

  it('never starts by itself: the microphone is requested only by start(), once, audio only', async () => {
    const track = new FakeTrack();
    const gum = vi.fn(async (_c: MediaStreamConstraints) => ({ getTracks: () => [track] }) as unknown as MediaStream);
    const rec = new RecorderController({ env: env(gum) });
    expect(rec.getState()).toEqual({ kind: 'idle' });
    expect(gum).not.toHaveBeenCalled();
    expect(getActiveRecording()).toBeNull();
    await rec.start({ linkedSourceId: 'S1', nodeId: 'N1' });
    expect(gum).toHaveBeenCalledTimes(1);
    expect(gum.mock.calls[0]![0]).toMatchObject({ video: false });
    expect(rec.getState()).toMatchObject({ kind: 'recording', paused: false, mime: 'audio/webm' });
    expect(FakeRecorder.instances[0]!.timeslice).toBeGreaterThan(0);
    // a second click while recording does not open a second microphone
    await rec.start({ linkedSourceId: 'S1', nodeId: 'N1' });
    expect(gum).toHaveBeenCalledTimes(1);
  });

  it('explains permission and device errors; nothing records, nothing is linked', async () => {
    const denied = new RecorderController({ env: env(vi.fn(async () => Promise.reject(Object.assign(new Error('x'), { name: 'NotAllowedError' })))) });
    await denied.start({ linkedSourceId: null, nodeId: null });
    expect(denied.getState()).toEqual({ kind: 'error', code: 'denied', message: RECORDER_ERRORS_AR.denied });
    expect(RECORDER_ERRORS_AR.denied).toMatch(/إعدادات المتصفح/);
    expect(getActiveRecording()).toBeNull();
    expect(FakeRecorder.instances).toHaveLength(0);
    expect(classifyMediaError({ name: 'NotFoundError' })).toBe('no_device');
    expect(classifyMediaError({ name: 'NotReadableError' })).toBe('busy');
    expect(classifyMediaError({ name: 'SecurityError' })).toBe('denied');
    const unsupported = new RecorderController({ env: { isSecureContext: true } });
    await unsupported.start({ linkedSourceId: null, nodeId: null });
    expect(unsupported.getState()).toMatchObject({ kind: 'error', code: 'unsupported' });
    denied.dismiss();
    expect(denied.getState()).toEqual({ kind: 'idle' });
  });

  it('records, links strokes to their moment (pauses excluded), stops the microphone and stores the recording on the device', async () => {
    let now = 1_000_000;
    const track = new FakeTrack();
    const chunks: Array<{ seq: number; size: number }> = [];
    const finished: FinishedRecording[] = [];
    const rec = new RecorderController({
      env: env(vi.fn(async () => ({ getTracks: () => [track] }) as unknown as MediaStream)),
      now: () => now,
      saveChunk: async (_id, seq, chunk) => {
        chunks.push({ seq, size: chunk.size });
      },
      saveFinished: async (r) => {
        finished.push(r);
      },
    });
    await rec.start({ linkedSourceId: 'LECTURE', nodeId: 'FOLDER', title: null });
    const s = rec.getState();
    if (s.kind !== 'recording') throw new Error('not recording');
    const fr = FakeRecorder.instances[0]!;
    fr.emit('chunk-1');
    // a stroke 12.5 s after the start → automatic link at 12 500 ms
    now += 12_500;
    expect(audioLinkAt(now)).toEqual({ recording_id: s.recordingId, offset_ms: 12_500, origin: 'auto' });
    // paused 5 s: no link while paused, and the pause is not counted afterwards
    rec.pause();
    expect(rec.getState()).toMatchObject({ paused: true });
    now += 5_000;
    expect(audioLinkAt(now)).toBeNull();
    rec.resume();
    now += 2_500;
    expect(audioLinkAt(now)).toEqual({ recording_id: s.recordingId, offset_ms: 15_000, origin: 'auto' });
    expect(rec.elapsedMs()).toBe(15_000);
    // strokes written before the recording started get no link
    expect(audioLinkAt(1_000_000 - 60_000)).toBeNull();

    await rec.stop();
    expect(track.stopped).toBe(true);
    expect(getActiveRecording()).toBeNull();
    expect(chunks.map((c) => c.seq)).toEqual([0, 1]);
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ recordingId: s.recordingId, linkedSourceId: 'LECTURE', nodeId: 'FOLDER', mime: 'audio/webm', startedAt: s.startedAt, durationMs: 15_000 });
    expect(await finished[0]!.blob.text()).toBe('chunk-1-last');
    expect(rec.getState()).toEqual({ kind: 'saved', recordingId: s.recordingId, durationMs: 15_000, sizeBytes: 12 });
  });

  it('leaving the screen stops and saves a running recording; a pending permission request is cancelled', async () => {
    const saved: FinishedRecording[] = [];
    const track = new FakeTrack();
    let grant: (s: MediaStream) => void = () => {};
    const gum = vi.fn(() => new Promise<MediaStream>((r) => (grant = r)));
    const rec = new RecorderController({ env: env(gum), saveFinished: async (r) => void saved.push(r) });
    const starting = rec.start({ linkedSourceId: null, nodeId: null });
    expect(rec.getState()).toEqual({ kind: 'requesting' });
    await rec.abandon();
    grant({ getTracks: () => [track] } as unknown as MediaStream);
    await starting;
    expect(rec.getState()).toEqual({ kind: 'idle' });
    expect(track.stopped).toBe(true);
    expect(FakeRecorder.instances).toHaveLength(0);
    // a running one is stopped and saved
    const t2 = new FakeTrack();
    const rec2 = new RecorderController({ env: env(vi.fn(async () => ({ getTracks: () => [t2] }) as unknown as MediaStream)), saveFinished: async (r) => void saved.push(r) });
    await rec2.start({ linkedSourceId: null, nodeId: null });
    await rec2.abandon();
    expect(t2.stopped).toBe(true);
    expect(saved).toHaveLength(1);
    expect(rec2.getState().kind).toBe('saved');
  });

  it('a failed save keeps the error visible (nothing claims to be saved)', async () => {
    const rec = new RecorderController({
      env: env(vi.fn(async () => ({ getTracks: () => [new FakeTrack()] }) as unknown as MediaStream)),
      saveFinished: async () => {
        throw new Error('quota');
      },
    });
    await rec.start({ linkedSourceId: null, nodeId: null });
    await rec.stop();
    expect(rec.getState()).toEqual({ kind: 'error', code: 'save_failed', message: RECORDER_ERRORS_AR.save_failed });
  });

  it('(review) a recording that could not be stored stays in memory: never dropped by «إغلاق» or a new start; retry stores it', async () => {
    let fail = true;
    const stored: FinishedRecording[] = [];
    const gum = vi.fn(async () => ({ getTracks: () => [new FakeTrack()] }) as unknown as MediaStream);
    const released: string[] = [];
    const rec = new RecorderController({
      env: env(gum),
      saveFinished: async (r) => {
        if (fail) throw new Error('quota');
        stored.push(r);
      },
      holdLock: (id) => () => void released.push(id),
    });
    await rec.start({ linkedSourceId: 'S', nodeId: 'N' });
    const s = rec.getState();
    if (s.kind !== 'recording') throw new Error('not recording');
    FakeRecorder.instances[0]!.emit('voice');
    await rec.stop();
    expect(rec.getState()).toMatchObject({ kind: 'error', code: 'save_failed' });
    expect(await rec.unsaved()!.blob.text()).toBe('voice-last');
    // the lock (other tabs must not «recover» it) is kept while the recording is not stored
    expect(released).toEqual([]);
    rec.dismiss();
    expect(rec.getState()).toMatchObject({ kind: 'error', code: 'save_failed' });
    await rec.start({ linkedSourceId: 'S', nodeId: 'N' });
    expect(gum).toHaveBeenCalledTimes(1); // no second recording over the unsaved one
    fail = false;
    await rec.retrySave();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.recordingId).toBe(s.recordingId);
    expect(rec.unsaved()).toBeNull();
    expect(rec.getState()).toMatchObject({ kind: 'saved', recordingId: s.recordingId });
    expect(released).toEqual([s.recordingId]);
  });

  it('(review) the browser stopping the recorder by itself (microphone gone) ends the indicator, stores what was recorded, says why', async () => {
    const saved: FinishedRecording[] = [];
    const track = new FakeTrack();
    const rec = new RecorderController({ env: env(vi.fn(async () => ({ getTracks: () => [track] }) as unknown as MediaStream)), saveFinished: async (r) => void saved.push(r) });
    await rec.start({ linkedSourceId: null, nodeId: null });
    const fr = FakeRecorder.instances[0]!;
    fr.emit('before-unplug');
    // the device went away: the browser stops the recorder and fires «stop» on its own
    fr.state = 'inactive';
    fr.onstop?.();
    await vi.waitFor(() => expect(rec.getState().kind).toBe('error'));
    expect(rec.getState()).toEqual({ kind: 'error', code: 'interrupted', message: RECORDER_ERRORS_AR.interrupted });
    expect(getActiveRecording()).toBeNull();
    expect(track.stopped).toBe(true);
    expect(saved).toHaveLength(1);
    expect(await saved[0]!.blob.text()).toBe('before-unplug');
  });
});

// ───────── device copy + uploads (minimal blob table) ─────────
function stubDb(initial: Array<Record<string, unknown>> = []) {
  const rows = new Map<string, Record<string, unknown>>(initial.map((r) => [r.id as string, { ...r }]));
  const where = (field: string) => ({
    equals: (v: unknown) => {
      const list = () => [...rows.values()].filter((r) => r[field] === v);
      return {
        toArray: async () => list(),
        filter: (fn: (r: Record<string, unknown>) => boolean) => ({ primaryKeys: async () => list().filter(fn).map((r) => r.id as string) }),
      };
    },
  });
  const blobs = {
    where,
    get: async (id: string) => rows.get(id),
    put: async (r: Record<string, unknown>) => {
      rows.set(r.id as string, { ...r });
      return r.id;
    },
    update: async (id: string, patch: Record<string, unknown>) => {
      rows.set(id, { ...rows.get(id)!, ...patch });
      return 1;
    },
    bulkDelete: async (ids: string[]) => {
      for (const id of ids) rows.delete(id);
    },
  };
  return { rows, db: { blobs, transaction: async (_m: string, _t: unknown, fn: () => Promise<void>) => fn() } as unknown as MedLevoDB };
}

describe('recordings on this device first', () => {
  it('chunks are replaced by the whole recording; a page that died before «إيقاف» is recovered from its chunks', async () => {
    const { db, rows } = stubDb();
    const meta = { linkedSourceId: 'S1', nodeId: 'N1', mime: 'audio/webm', startedAt: 5000 };
    await saveRecordingChunk(db, 'R1', 0, new Blob(['a']), meta);
    await saveRecordingChunk(db, 'R1', 1, new Blob(['b']), meta);
    await saveRecordingChunk(db, 'R2', 0, new Blob(['x']), meta);
    await saveFinishedRecording(db, { recordingId: 'R1', blob: new Blob(['ab'], { type: 'audio/webm' }), mime: 'audio/webm', startedAt: 5000, durationMs: 3000, linkedSourceId: 'S1', nodeId: 'N1' });
    expect([...rows.keys()].sort()).toEqual([recordingBlobId('R1'), 'recchunk:R2:000000'].sort());
    expect(rows.get(recordingBlobId('R1'))).toMatchObject({ uploadState: 'pending', durationMs: 3000, linkedSourceId: 'S1' });
    // R2 never stopped (the page died): its chunks become a recording, labelled recovered, duration unknown
    // (no Web Locks here: chunks are recovered once they are older than RECOVERY_MIN_AGE_MS)
    expect(await recoverInterruptedRecordings(db)).toBe(0);
    expect(await recoverInterruptedRecordings(db, null, { now: Date.now() + RECOVERY_MIN_AGE_MS + 1 })).toBe(1);
    expect(rows.get(recordingBlobId('R2'))).toMatchObject({ uploadState: 'pending', recovered: true, durationMs: null });
    expect([...rows.keys()].some((k) => k.startsWith('recchunk:'))).toBe(false);
    // the recording being made right now is never «recovered» under the owner's hands
    await saveRecordingChunk(db, 'LIVE', 0, new Blob(['z']), meta);
    expect(await recoverInterruptedRecordings(db, 'LIVE', { now: Date.now() + RECOVERY_MIN_AGE_MS + 1 })).toBe(0);
  });

  it('(review) a recording still being made in ANOTHER tab (its lock is held) is never «recovered» from its chunks', async () => {
    const { db, rows } = stubDb();
    const meta = { linkedSourceId: 'S1', nodeId: 'N1', mime: 'audio/webm', startedAt: 5000 };
    await saveRecordingChunk(db, 'OTHER-TAB', 0, new Blob(['a']), meta);
    await saveRecordingChunk(db, 'DEAD', 0, new Blob(['b']), meta);
    // a minimal LockManager: the other tab holds its recording's lock until it has stored the recording
    const held = new Map<string, Promise<void>>();
    const locks = {
      request: (name: string, cb: () => Promise<void>) => {
        const p = cb();
        held.set(name, p);
        return p.then(() => void held.delete(name));
      },
      query: async () => ({ held: [...held.keys()].map((name) => ({ name })) }),
    };
    const release = holdRecordingLock('OTHER-TAB', locks);
    const ids = await heldRecordingIds(locks);
    expect([...ids!]).toEqual(['OTHER-TAB']);
    // with the lock list, age does not matter: the dead one is recovered at once, the live one is left alone
    expect(await recoverInterruptedRecordings(db, null, { held: ids })).toBe(1);
    expect(rows.has(recordingBlobId('DEAD'))).toBe(true);
    expect(rows.has(recordingBlobId('OTHER-TAB'))).toBe(false);
    expect(rows.has('recchunk:OTHER-TAB:000000')).toBe(true);
    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(await heldRecordingIds(locks)).toEqual(new Set());
  });

  it('(review) refused / recovered / still-failing recordings are surfaced to the owner, and can be sent again', async () => {
    const rec = (id: string, extra: Partial<RecordingBlobRecord> = {}) =>
      ({ id: recordingBlobId(id), kind: 'audio_recording', recordingId: id, mime: 'audio/webm', size: 2, data: new Blob(['ab']), storedAt: 1, uploadState: 'pending', startedAt: 7000, durationMs: 4000, linkedSourceId: 'S1', nodeId: 'N1', ...extra }) as RecordingBlobRecord;
    const { db, rows } = stubDb([
      rec('FRESH') as never,
      rec('DONE', { uploadState: 'uploaded' }) as never,
      rec('REFUSED', { uploadState: 'rejected', uploadError: 'التسجيل أكبر من حد الرفع.', startedAt: 9000 }) as never,
      rec('RETRYING', { attempts: 2, uploadError: 'لا اتصال' }) as never,
      rec('RECOVERED', { recovered: true, durationMs: null }) as never,
    ]);
    expect((await deviceRecordingsNeedingAttention(db)).map((r) => r.recordingId).sort()).toEqual(['RECOVERED', 'REFUSED', 'RETRYING']);
    const post = vi.fn(async (form: FormData) => ({ recording: { id: form.get('recording_id'), source_id: 'SRC' }, created: true }) as never);
    await retryRecordingUpload('REFUSED', db, { post, online: () => true, now: () => 10 });
    expect(post.mock.calls.map((c) => c[0].get('recording_id'))).toContain('REFUSED');
    expect(rows.get(recordingBlobId('REFUSED'))).toMatchObject({ uploadState: 'uploaded', uploadError: null });
    expect(recordingFileName('X', 'audio/mp4')).toBe('recording-X.m4a');
  });

  it('uploads with the recording id (idempotent), keeps a refused recording with the reason, retries a lost connection later', async () => {
    const rec = (id: string, extra: Partial<RecordingBlobRecord> = {}) =>
      ({ id: recordingBlobId(id), kind: 'audio_recording', recordingId: id, mime: 'audio/webm', size: 2, data: new Blob(['ab']), storedAt: 1, uploadState: 'pending', startedAt: 7000, durationMs: 4000, linkedSourceId: 'S1', nodeId: 'N1', ...extra }) as RecordingBlobRecord;
    const { db, rows } = stubDb([rec('OK') as never, rec('BAD') as never, rec('NET') as never]);
    const post = vi.fn(async (form: FormData) => {
      const id = form.get('recording_id');
      if (id === 'BAD') throw new ApiError({ code: 'UNSUPPORTED_FORMAT', message: 'ليس تسجيلًا صوتيًا مدعومًا.', status: 415 });
      if (id === 'NET') throw new ApiError({ code: 'NETWORK_ERROR', message: 'لا اتصال', status: 0, offline: true });
      return { recording: { id, source_id: 'AUDIO-SRC' }, created: true } as never;
    });
    const res = await kickRecordingUploads(db, { post, online: () => true, now: () => 1000 });
    expect(res).toEqual({ uploaded: 1, rejected: 1, failed: 1 });
    const form = post.mock.calls[0]![0];
    expect(form.get('recording_id')).toBe('OK');
    expect(form.get('started_at')).toBe('7000');
    expect(form.get('duration_ms')).toBe('4000');
    expect(form.get('linked_source_id')).toBe('S1');
    expect(form.get('file')).toBeInstanceOf(Blob);
    expect(rows.get(recordingBlobId('OK'))).toMatchObject({ uploadState: 'uploaded', serverSourceId: 'AUDIO-SRC' });
    expect(rows.get(recordingBlobId('BAD'))).toMatchObject({ uploadState: 'rejected', uploadError: 'ليس تسجيلًا صوتيًا مدعومًا.' });
    // still on the device: nothing is deleted after a refusal
    expect(rows.get(recordingBlobId('BAD'))!.data).toBeInstanceOf(Blob);
    expect(rows.get(recordingBlobId('NET'))).toMatchObject({ uploadState: 'pending', attempts: 1, nextAttemptAt: 3000 });
    expect(await kickRecordingUploads(db, { post, online: () => false, now: () => 9000 })).toEqual({ uploaded: 0, rejected: 0, failed: 0 });
  });
});
