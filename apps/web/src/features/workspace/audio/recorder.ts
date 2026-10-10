// In-app recording (§29, track F4). The microphone is used ONLY after an explicit owner action («سجّل ملاحظة صوتية»),
// a visible indicator with a stop control is shown the whole time (RecordingBar), and nothing is ever started
// automatically (no autostart on load, on reload, on a gesture or a timer). Chunks are written to IndexedDB while
// recording (a crash keeps what was recorded); on stop the recording is stored on this device first and then uploaded
// as a «ملاحظة صوتية» (my_audio_note) source. While it runs, strokes get automatic time links (ink/audioLink.ts).
import { newId } from '@medlevo/shared';
import { setActiveRecording, type ActiveRecording } from '../ink/audioLink';

export type RecorderErrorCode = 'unsupported' | 'insecure' | 'denied' | 'no_device' | 'busy' | 'failed' | 'interrupted' | 'save_failed';

export type RecorderState =
  | { kind: 'idle' }
  | { kind: 'requesting' }
  | { kind: 'recording'; recordingId: string; startedAt: number; paused: boolean; mime: string }
  | { kind: 'saving'; recordingId: string }
  | { kind: 'saved'; recordingId: string; durationMs: number; sizeBytes: number }
  | { kind: 'error'; code: RecorderErrorCode; message: string };

export const RECORDER_ERRORS_AR: Record<RecorderErrorCode, string> = {
  unsupported: 'هذا المتصفح لا يدعم التسجيل داخل الصفحات (MediaRecorder). ارفع تسجيلك كملف صوتي من صفحة الرفع بدلًا من ذلك.',
  insecure: 'التسجيل يحتاج اتصالًا آمنًا (HTTPS) بالخادم؛ المتصفح يمنع الميكروفون في الصفحات غير الآمنة.',
  denied: 'لم يُسمح باستخدام الميكروفون. اسمح به لهذا الموقع من إعدادات المتصفح (رمز القفل بجانب العنوان) ثم أعد المحاولة. لم يُسجَّل شيء.',
  no_device: 'لم يُعثر على ميكروفون متصل بهذا الجهاز. وصّل ميكروفونًا ثم أعد المحاولة.',
  busy: 'الميكروفون مشغول أو تعذّر تشغيله (ربما يستخدمه تطبيق آخر). أغلق التطبيق الآخر ثم أعد المحاولة.',
  failed: 'توقف التسجيل بسبب خطأ في المتصفح. ما سُجّل حتى الآن محفوظ على هذا الجهاز.',
  interrupted: 'توقف التسجيل لأن المتصفح أوقف الميكروفون (فُصل، أو سُحب الإذن، أو استخدمه النظام). ما سُجّل حتى الآن محفوظ على هذا الجهاز.',
  save_failed:
    'تعذّر حفظ التسجيل على هذا الجهاز (مساحة التخزين ممتلئة أو محجوبة). التسجيل ما زال في ذاكرة هذه الصفحة: أعد محاولة الحفظ، أو نزّل نسخة منه، ولا تغلق الصفحة قبل ذلك.',
};

/** Audio formats in the order we prefer them (all are content-sniffed by the server). */
export const PREFERRED_MIMES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4'];

type MediaRecorderCtor = {
  new (stream: MediaStream, options?: MediaRecorderOptions): MediaRecorder;
  isTypeSupported?(type: string): boolean;
};

export interface RecorderEnv {
  MediaRecorder?: MediaRecorderCtor;
  getUserMedia?: (c: MediaStreamConstraints) => Promise<MediaStream>;
  isSecureContext?: boolean;
}

function defaultEnv(): RecorderEnv {
  const g = globalThis as unknown as { MediaRecorder?: MediaRecorderCtor; navigator?: Navigator; isSecureContext?: boolean };
  const md = g.navigator?.mediaDevices;
  return {
    MediaRecorder: g.MediaRecorder,
    getUserMedia: md?.getUserMedia ? (c) => md.getUserMedia(c) : undefined,
    isSecureContext: g.isSecureContext,
  };
}

/** Can this browser record here? (checked before offering the action, never by starting the microphone) */
export function recordingSupport(env: RecorderEnv = defaultEnv()): { supported: boolean; reason: string | null } {
  if (env.isSecureContext === false) return { supported: false, reason: RECORDER_ERRORS_AR.insecure };
  if (!env.MediaRecorder || !env.getUserMedia) return { supported: false, reason: RECORDER_ERRORS_AR.unsupported };
  return { supported: true, reason: null };
}

export function pickMime(Ctor: MediaRecorderCtor | undefined): string | null {
  if (!Ctor?.isTypeSupported) return null;
  for (const m of PREFERRED_MIMES) {
    try {
      if (Ctor.isTypeSupported(m)) return m;
    } catch {
      // ignore
    }
  }
  return null;
}

/** getUserMedia errors → a specific, honest Arabic reason. */
export function classifyMediaError(e: unknown): RecorderErrorCode {
  const name = (e as { name?: string } | null)?.name ?? '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') return 'denied';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') return 'no_device';
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') return 'busy';
  return 'failed';
}

export interface RecordingMeta {
  linkedSourceId: string | null;
  nodeId: string | null;
  title?: string | null;
}

export interface FinishedRecording extends RecordingMeta {
  recordingId: string;
  blob: Blob;
  mime: string;
  startedAt: number;
  durationMs: number;
}

export interface RecorderDeps {
  env?: RecorderEnv;
  now?: () => number;
  /** keep a chunk on this device while recording (crash safety) */
  saveChunk?: (recordingId: string, seq: number, chunk: Blob, meta: RecordingMeta & { mime: string; startedAt: number }) => Promise<void>;
  /** store the finished recording on this device (then it is uploaded) */
  saveFinished?: (r: FinishedRecording) => Promise<void>;
  /** ms between chunks */
  timesliceMs?: number;
  /**
   * marks the recording as «being made» for other tabs from its start until it is stored on this device (returns the
   * release); without it another tab could «recover» its chunks while it still runs
   */
  holdLock?: (recordingId: string) => () => void;
}

export class RecorderController {
  private state: RecorderState = { kind: 'idle' };
  private listeners = new Set<() => void>();
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private seq = 0;
  private meta: RecordingMeta | null = null;
  private pauses: Array<{ from: number; to: number | null }> = [];
  private stopping: Promise<void> | null = null;
  private chunkWrites: Promise<void> = Promise.resolve();
  private cancelRequest = false;
  /** a finished recording that could not be stored on this device (kept in memory until saved, downloaded or discarded) */
  private unsavedRec: FinishedRecording | null = null;
  private releaseLock: (() => void) | null = null;

  constructor(private readonly deps: RecorderDeps = {}) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  getState = (): RecorderState => this.state;

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private set(s: RecorderState): void {
    this.state = s;
    this.listeners.forEach((l) => l());
  }

  /** total paused time before `at` */
  private pausedBefore(at: number): number {
    let total = 0;
    for (const p of this.pauses) {
      if (p.from >= at) continue;
      total += Math.min(p.to ?? at, at) - p.from;
    }
    return total;
  }

  elapsedMs(): number {
    const s = this.state;
    if (s.kind !== 'recording') return 0;
    const t = this.now();
    return Math.max(0, t - s.startedAt - this.pausedBefore(t));
  }

  /** Starts recording. MUST only be called from an explicit owner action (a click on «سجّل»). */
  async start(meta: RecordingMeta): Promise<void> {
    if (this.state.kind === 'recording' || this.state.kind === 'requesting' || this.state.kind === 'saving') return;
    // a recording that could not be stored yet is never dropped by starting another one
    if (this.unsavedRec) return;
    const env = this.deps.env ?? defaultEnv();
    const support = recordingSupport(env);
    if (!support.supported) {
      this.set({ kind: 'error', code: env.isSecureContext === false ? 'insecure' : 'unsupported', message: support.reason! });
      return;
    }
    this.set({ kind: 'requesting' });
    this.cancelRequest = false;
    let stream: MediaStream;
    try {
      stream = await env.getUserMedia!({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
    } catch (e) {
      const code = classifyMediaError(e);
      this.set({ kind: 'error', code, message: RECORDER_ERRORS_AR[code] });
      return;
    }
    // the owner left the screen while the browser was asking: never record without the indicator on screen
    if (this.cancelRequest) {
      stream.getTracks().forEach((t) => t.stop());
      this.cancelRequest = false;
      this.set({ kind: 'idle' });
      return;
    }
    const mime = pickMime(env.MediaRecorder);
    let rec: MediaRecorder;
    try {
      rec = mime ? new env.MediaRecorder!(stream, { mimeType: mime, audioBitsPerSecond: 64_000 }) : new env.MediaRecorder!(stream);
    } catch {
      stream.getTracks().forEach((t) => t.stop());
      this.set({ kind: 'error', code: 'unsupported', message: RECORDER_ERRORS_AR.unsupported });
      return;
    }
    const recordingId = newId();
    this.recorder = rec;
    this.stream = stream;
    this.chunks = [];
    this.seq = 0;
    this.meta = meta;
    this.pauses = [];
    const actualMime = (rec.mimeType || mime || 'audio/webm').split(';')[0]!;
    let startedAt = this.now();
    rec.ondataavailable = (ev: BlobEvent) => {
      if (!ev.data || ev.data.size === 0) return;
      this.chunks.push(ev.data);
      const seq = this.seq++;
      if (this.deps.saveChunk) {
        const save = this.deps.saveChunk;
        this.chunkWrites = this.chunkWrites.then(() => save(recordingId, seq, ev.data, { ...meta, mime: actualMime, startedAt }).catch(() => undefined));
      }
    };
    rec.onerror = () => {
      void this.stop('failed');
    };
    // the browser stopped the recorder by itself (microphone unplugged, permission revoked, the OS took the device):
    // the indicator must not keep saying «يُسجَّل الآن» — what was recorded is stored and the owner is told why
    rec.onstop = () => {
      if (this.recorder === rec && !this.stopping && this.state.kind === 'recording') void this.stop('interrupted');
    };
    // the link clock starts when the recorder really starts (not when permission was asked)
    const active: ActiveRecording = {
      recordingId,
      get startedAt() {
        return startedAt;
      },
      pausedBefore: (at) => this.pausedBefore(at),
      isPaused: () => this.state.kind === 'recording' && this.state.paused,
    };
    try {
      rec.start(this.deps.timesliceMs ?? 4000);
    } catch {
      stream.getTracks().forEach((t) => t.stop());
      this.set({ kind: 'error', code: 'failed', message: RECORDER_ERRORS_AR.failed });
      return;
    }
    startedAt = this.now();
    this.releaseLock = this.deps.holdLock?.(recordingId) ?? null;
    setActiveRecording(active);
    this.set({ kind: 'recording', recordingId, startedAt, paused: false, mime: actualMime });
  }

  pause(): void {
    const s = this.state;
    if (s.kind !== 'recording' || s.paused || !this.recorder || typeof this.recorder.pause !== 'function') return;
    try {
      this.recorder.pause();
    } catch {
      return;
    }
    this.pauses.push({ from: this.now(), to: null });
    this.set({ ...s, paused: true });
  }

  resume(): void {
    const s = this.state;
    if (s.kind !== 'recording' || !s.paused || !this.recorder) return;
    try {
      this.recorder.resume();
    } catch {
      return;
    }
    const last = this.pauses[this.pauses.length - 1];
    if (last && last.to === null) last.to = this.now();
    this.set({ ...s, paused: false });
  }

  canPause(): boolean {
    return !!this.recorder && typeof this.recorder.pause === 'function';
  }

  /** Stops, releases the microphone and stores the recording on this device (then it is uploaded). */
  stop(reason: 'owner' | 'failed' | 'interrupted' = 'owner'): Promise<void> {
    if (this.stopping) return this.stopping;
    const s = this.state;
    const rec = this.recorder;
    if (s.kind !== 'recording' || !rec) return Promise.resolve();
    this.stopping = (async () => {
      const stoppedAt = this.now();
      const last = this.pauses[this.pauses.length - 1];
      if (last && last.to === null) last.to = stoppedAt;
      const durationMs = Math.max(0, stoppedAt - s.startedAt - this.pausedBefore(stoppedAt));
      setActiveRecording(null);
      this.set({ kind: 'saving', recordingId: s.recordingId });
      await new Promise<void>((resolve) => {
        const done = () => resolve();
        rec.onstop = done;
        try {
          if (rec.state === 'inactive') done();
          else rec.stop();
        } catch {
          done();
        }
        setTimeout(done, 3000); // a recorder that never fires «stop» must not keep the microphone or the data
      });
      this.stream?.getTracks().forEach((t) => t.stop());
      this.stream = null;
      this.recorder = null;
      await this.chunkWrites;
      const blob = new Blob(this.chunks, { type: s.mime });
      const meta = this.meta ?? { linkedSourceId: null, nodeId: null };
      this.chunks = [];
      if (blob.size === 0) {
        this.unlock();
        this.set({ kind: 'error', code: 'failed', message: 'لم يُلتقط أي صوت؛ لم يُحفظ تسجيل فارغ.' });
        return;
      }
      this.unsavedRec = { ...meta, recordingId: s.recordingId, blob, mime: s.mime, startedAt: s.startedAt, durationMs };
      await this.persist(reason);
    })().finally(() => {
      this.stopping = null;
    });
    return this.stopping;
  }

  /** Stores the finished recording on this device; on failure it stays in memory (retry / download / discard). */
  private async persist(reason: 'owner' | 'failed' | 'interrupted'): Promise<void> {
    const r = this.unsavedRec;
    if (!r) return;
    try {
      await this.deps.saveFinished?.(r);
      this.unsavedRec = null;
      this.unlock();
      this.set(reason === 'owner' ? { kind: 'saved', recordingId: r.recordingId, durationMs: r.durationMs, sizeBytes: r.blob.size } : { kind: 'error', code: reason, message: RECORDER_ERRORS_AR[reason] });
    } catch {
      this.set({ kind: 'error', code: 'save_failed', message: RECORDER_ERRORS_AR.save_failed });
    }
  }

  private unlock(): void {
    this.releaseLock?.();
    this.releaseLock = null;
  }

  /** The recording that could not be stored on this device (null when there is none). */
  unsaved(): FinishedRecording | null {
    return this.unsavedRec;
  }

  /** Try again to store the recording that could not be stored. */
  retrySave(): Promise<void> {
    if (!this.unsavedRec || this.state.kind !== 'error' || this.state.code !== 'save_failed') return Promise.resolve();
    this.set({ kind: 'saving', recordingId: this.unsavedRec.recordingId });
    return this.persist('owner');
  }

  /** The owner explicitly gave up the recording that could not be stored (after downloading it, or on purpose). */
  discardUnsaved(): void {
    this.unsavedRec = null;
    this.unlock();
    if (this.state.kind === 'error') this.set({ kind: 'idle' });
  }

  /**
   * The screen showing the indicator is going away: a running recording is stopped and SAVED (never left running
   * without its indicator and stop control); a pending permission request is cancelled.
   */
  abandon(): Promise<void> {
    if (this.state.kind === 'requesting') {
      this.cancelRequest = true;
      return Promise.resolve();
    }
    return this.stop();
  }

  /** back to idle after a saved / error state (the owner dismissed the message) — never drops an unsaved recording */
  dismiss(): void {
    if (this.unsavedRec) return;
    if (this.state.kind === 'saved' || this.state.kind === 'error') this.set({ kind: 'idle' });
  }

  isRecording(): boolean {
    return this.state.kind === 'recording' || this.state.kind === 'requesting';
  }
}
