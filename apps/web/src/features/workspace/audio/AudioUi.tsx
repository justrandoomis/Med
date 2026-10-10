// In-app recording UI (track F4, §29): the indicator + stop control shown the whole time a recording runs, the
// player that plays a stroke's moment, and the dialog that edits a stroke's time link (→ «يدوي»).
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Download, Mic, Pause, Play, RotateCcw, Square, Trash2, X } from 'lucide-react';
import type { InkAudioLink } from '@medlevo/shared';
import { AUDIO_LINK_ORIGIN_LABELS_AR } from '@medlevo/shared';
import { Button, ConfirmDialog, Dialog, IconButton, TextField } from '../../../design';
import { errorMessage } from '../../../lib/api';
import { getDb } from '../../../lib/localdb';
import { formatOffset, parseOffset } from '../ink/audioLink';
import { RecorderController, type RecorderState } from './recorder';
import {
  deviceRecordingsNeedingAttention,
  downloadRecording,
  holdRecordingLock,
  kickRecordingUploads,
  onRecordingsChanged,
  playbackSource,
  recordingFileName,
  retryRecordingUpload,
  saveFinishedRecording,
  saveRecordingChunk,
  startRecordingUploader,
  type RecordingBlobRecord,
} from './recordings';
import '../handwriting/handwriting.css';

let shared: RecorderController | null = null;

/** The app-wide recorder (one microphone, one recording at a time). */
export function getRecorder(): RecorderController {
  if (!shared) {
    const db = getDb();
    shared = new RecorderController({
      saveChunk: (id, seq, chunk, meta) => saveRecordingChunk(db, id, seq, chunk, meta),
      saveFinished: async (r) => {
        await saveFinishedRecording(db, r);
        void kickRecordingUploads(db);
      },
      holdLock: (id) => holdRecordingLock(id),
    });
    startRecordingUploader(db, () => {
      const s = shared?.getState();
      return s && (s.kind === 'recording' || s.kind === 'saving') ? s.recordingId : null;
    });
  }
  return shared;
}

/** test hook */
export function __setRecorderForTests(r: RecorderController | null): void {
  shared = r;
}

export function useRecorderState(rec: RecorderController): RecorderState {
  return useSyncExternalStore(rec.subscribe, rec.getState, rec.getState);
}

/** Ticks every second while recording (the time shown on the indicator). */
function useElapsed(rec: RecorderController, state: RecorderState): number {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (state.kind !== 'recording' || state.paused) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [state]);
  return rec.elapsedMs();
}

/**
 * Visible for the whole recording: a red dot AND the words «يُسجَّل الآن» (status is never colour alone), the time,
 * pause / resume, and «إيقاف التسجيل». Leaving the page while recording asks first.
 */
export function RecordingBar({ recorder }: { recorder: RecorderController }) {
  const state = useRecorderState(recorder);
  const elapsed = useElapsed(recorder, state);
  const [announce, setAnnounce] = useState('');
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const prev = useRef(state.kind);
  useEffect(() => {
    if (prev.current !== state.kind) {
      if (state.kind === 'recording') setAnnounce('بدأ التسجيل. زر «إيقاف التسجيل» في أسفل الشاشة.');
      if (state.kind === 'saved') setAnnounce('توقف التسجيل وحُفظ على هذا الجهاز.');
      if (state.kind === 'error') setAnnounce(state.message);
      prev.current = state.kind;
    }
  }, [state]);
  // leaving the page while recording, saving, or holding a recording that could not be stored asks first
  const unsavedOnly = state.kind === 'error' && state.code === 'save_failed';
  useEffect(() => {
    if (state.kind !== 'recording' && state.kind !== 'saving' && !unsavedOnly) return;
    const guard = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [state.kind, unsavedOnly]);

  const live = (
    <p className="ml-visually-hidden" role="status" aria-live="polite">
      {announce}
    </p>
  );
  if (state.kind === 'idle') return live;
  return (
    <>
      {live}
      <div className="hw-recbar" role="region" aria-label="التسجيل الصوتي" dir="rtl" data-state={state.kind}>
        {state.kind === 'requesting' && <span className="hw-recbar__label">بانتظار إذنك باستخدام الميكروفون…</span>}
        {state.kind === 'recording' && (
          <>
            <span className="hw-recbar__dot" data-live={state.paused ? undefined : ''} aria-hidden="true" />
            <span className="hw-recbar__label">{state.paused ? 'التسجيل متوقف مؤقتًا' : 'يُسجَّل الآن'}</span>
            <bdi dir="ltr" className="hw-recbar__time" aria-label={`المدة ${formatOffset(elapsed)}`}>
              {formatOffset(elapsed)}
            </bdi>
            {recorder.canPause() &&
              (state.paused ? (
                <IconButton label="استئناف التسجيل" icon={<Play size={18} />} onClick={() => recorder.resume()} />
              ) : (
                <IconButton label="إيقاف مؤقت" icon={<Pause size={18} />} onClick={() => recorder.pause()} />
              ))}
            <Button variant="destructive" icon={<Square size={16} />} onClick={() => void recorder.stop()}>
              إيقاف التسجيل
            </Button>
          </>
        )}
        {state.kind === 'saving' && <span className="hw-recbar__label">يُحفظ التسجيل على هذا الجهاز…</span>}
        {state.kind === 'saved' && (
          <>
            <Mic size={16} aria-hidden="true" />
            <span className="hw-recbar__msg">
              حُفظ التسجيل (<bdi dir="ltr">{formatOffset(state.durationMs)}</bdi>) على هذا الجهاز، ويُرفع «ملاحظةً صوتية» عند الاتصال.
            </span>
            <IconButton label="إغلاق" icon={<X size={18} />} onClick={() => recorder.dismiss()} />
          </>
        )}
        {state.kind === 'error' && state.code === 'save_failed' && recorder.unsaved() && (
          // the recording exists only in this page's memory: it is never dropped by closing a message
          <>
            <span role="alert" className="hw-recbar__msg">
              {state.message}
            </span>
            <Button size="sm" variant="primary" icon={<RotateCcw size={16} />} onClick={() => void recorder.retrySave()}>
              أعد محاولة الحفظ
            </Button>
            <Button
              size="sm"
              variant="secondary"
              icon={<Download size={16} />}
              onClick={() => {
                const r = recorder.unsaved();
                if (r) downloadRecording(r.blob, recordingFileName(r.recordingId, r.mime));
              }}
            >
              نزّل نسخة
            </Button>
            <Button size="sm" variant="plain" icon={<Trash2 size={16} />} onClick={() => setConfirmDiscard(true)}>
              تخلَّ عنه
            </Button>
            <ConfirmDialog
              open={confirmDiscard}
              title="التخلي عن التسجيل"
              impact="لم يُحفظ هذا التسجيل على الجهاز ولا على الخادم: سيُفقد نهائيًا إن لم تنزّل نسخة منه أولًا."
              confirmLabel="تخلَّ عن التسجيل"
              destructive
              onConfirm={() => {
                recorder.discardUnsaved();
                setConfirmDiscard(false);
              }}
              onCancel={() => setConfirmDiscard(false)}
            />
          </>
        )}
        {state.kind === 'error' && !(state.code === 'save_failed' && recorder.unsaved()) && (
          <>
            <span role="alert" className="hw-recbar__msg">
              {state.message}
            </span>
            <IconButton label="إغلاق" icon={<X size={18} />} onClick={() => recorder.dismiss()} />
          </>
        )}
      </div>
    </>
  );
}

const UPLOAD_STATE_AR = (r: RecordingBlobRecord): string =>
  r.uploadState === 'rejected'
    ? `رفضه الخادم${r.uploadError ? `: ${r.uploadError}` : '.'}`
    : `لم يُرفع بعد${r.uploadError ? ` (آخر محاولة: ${r.uploadError})` : ' (سيُعاد رفعه تلقائيًا عند الاتصال)'}.`;

/**
 * Recordings on THIS device that did not reach the server (refused with a reason, recovered after an interrupted
 * session, or still failing to upload): the owner sees them, can download a copy and try again — a recording is never
 * left invisible on the device, where the browser might evict it.
 */
export function DeviceRecordingsNotice({
  load = deviceRecordingsNeedingAttention,
  retry = retryRecordingUpload,
  download = downloadRecording,
}: {
  load?: () => Promise<RecordingBlobRecord[]>;
  retry?: (recordingId: string) => Promise<void>;
  download?: (blob: Blob, name: string) => boolean;
}) {
  const [items, setItems] = useState<RecordingBlobRecord[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const refresh = () =>
      void load()
        .then((l) => alive && setItems(l))
        .catch(() => undefined);
    refresh();
    const off = onRecordingsChanged(refresh);
    return () => {
      alive = false;
      off();
    };
  }, [load]);
  if (items.length === 0) return null;
  const refused = items.filter((r) => r.uploadState === 'rejected').length;
  const summary =
    refused > 0
      ? refused === 1
        ? 'تسجيل واحد لم يقبله الخادم، وهو محفوظ على هذا الجهاز.'
        : `${refused} تسجيلات لم يقبلها الخادم، وهي محفوظة على هذا الجهاز.`
      : items.length === 1
        ? 'تسجيل واحد على هذا الجهاز لم يصل إلى الخادم بعد.'
        : `${items.length} تسجيلات على هذا الجهاز لم تصل إلى الخادم بعد.`;
  return (
    <section className="hw-recbar hw-devrec" data-state="device" aria-label="تسجيلات على هذا الجهاز" dir="rtl">
      <Mic size={16} aria-hidden="true" />
      <span className="hw-recbar__msg">{summary}</span>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        عرض
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="تسجيلات على هذا الجهاز لم تصل إلى الخادم" size="md" description="تبقى على هذا الجهاز حتى تُرفع. نزّل نسخة منها لتحتفظ بها في مكان آخر.">
        <ul className="hw-devrec__list">
          {items.map((r) => (
            <li key={r.id} className="hw-devrec__item">
              <strong>{r.title || 'ملاحظة صوتية'}</strong>
              <span className="hw-muted">
                <bdi dir="ltr">{new Date(r.startedAt).toLocaleString('en-GB', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}</bdi>
                {r.durationMs ? (
                  <>
                    {' — '}
                    <bdi dir="ltr">{formatOffset(r.durationMs)}</bdi>
                  </>
                ) : null}
                {r.recovered ? ' — استُعيد بعد انقطاع الصفحة (المدة غير معروفة)' : ''}
              </span>
              <p className={r.uploadState === 'rejected' ? 'hw-reason' : 'hw-muted'}>{UPLOAD_STATE_AR(r)}</p>
              <div className="hw-actions">
                <Button size="sm" variant="secondary" icon={<Download size={16} />} disabled={!(r.data instanceof Blob)} onClick={() => r.data instanceof Blob && download(r.data, recordingFileName(r.recordingId, r.mime))}>
                  نزّل نسخة
                </Button>
                <Button
                  size="sm"
                  variant="plain"
                  icon={<RotateCcw size={16} />}
                  loading={busy === r.recordingId}
                  onClick={() => {
                    setBusy(r.recordingId);
                    void retry(r.recordingId)
                      .catch(() => undefined)
                      .finally(() => setBusy(null));
                  }}
                >
                  أعد محاولة الرفع
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </Dialog>
    </section>
  );
}

export interface PlayRequest {
  link: InkAudioLink;
  /** bump to replay the same moment */
  nonce: number;
}

/** Plays a recording from a stroke's moment (the device copy when this device recorded it, else the server's). */
export function RecordingPlayer({ request, onClose, resolve = playbackSource }: { request: PlayRequest | null; onClose: () => void; resolve?: typeof playbackSource }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [src, setSrc] = useState<{ url: string; local: boolean; title: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setError(null);
    setSrc(null);
    if (!request) return;
    let alive = true;
    let objectUrl: string | null = null;
    resolve(request.link.recording_id)
      .then((s) => {
        if (s.local) objectUrl = s.url;
        if (alive) setSrc(s);
        else if (objectUrl) URL.revokeObjectURL(objectUrl);
      })
      .catch((e) => alive && setError(errorMessage(e, 'تعذّر العثور على التسجيل (ربما لم يُرفع من الجهاز الذي سجّله بعد).')));
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [request, resolve]);

  const seek = () => {
    const el = audio.current;
    if (!el || !request) return;
    try {
      el.currentTime = request.link.offset_ms / 1000;
    } catch {
      // some recordings (no index) cannot seek until fully loaded; playing from the start is still honest
    }
    void el.play().catch(() => undefined);
  };

  if (!request) return null;
  return (
    <section className="hw-player" aria-label="تشغيل التسجيل" dir="rtl">
      <div className="hw-player__head">
        <strong>
          {src?.title ?? 'تسجيل'} — من <bdi dir="ltr">{formatOffset(request.link.offset_ms)}</bdi>
        </strong>
        <IconButton label="إغلاق المشغّل" icon={<X size={18} />} onClick={onClose} />
      </div>
      <p className="hw-muted">{AUDIO_LINK_ORIGIN_LABELS_AR[request.link.origin]}</p>
      {error && (
        <p className="hw-reason" role="alert">
          {error}
        </p>
      )}
      {src && (
        // the owner's own voice note: no captions exist (automatic transcription is not configured)
        <audio ref={audio} src={src.url} controls preload="metadata" onLoadedMetadata={seek} aria-label="مشغّل التسجيل" />
      )}
      {src && !src.local && <p className="hw-muted">يُشغَّل من الخادم.</p>}
    </section>
  );
}

/** Change a stroke's moment (it becomes «يدوي») or remove the link. */
export function AudioLinkDialog({
  link,
  open,
  onClose,
  onSave,
  onRemove,
}: {
  link: InkAudioLink | null;
  open: boolean;
  onClose: () => void;
  onSave: (offsetMs: number) => void;
  onRemove: () => void;
}) {
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (open && link) {
      setText(formatOffset(link.offset_ms));
      setErr(null);
    }
  }, [open, link]);
  if (!link) return null;
  const save = () => {
    const ms = parseOffset(text);
    if (ms === null) {
      setErr('اكتب الوقت بالشكل دقائق:ثوانٍ، مثل 1:05.');
      return;
    }
    onSave(ms);
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="الرابط الزمني للكتابة"
      size="sm"
      description={AUDIO_LINK_ORIGIN_LABELS_AR[link.origin]}
      footer={
        <>
          <Button variant="primary" onClick={save}>
            احفظ الوقت
          </Button>
          <Button variant="destructive" onClick={onRemove}>
            أزل الرابط
          </Button>
          <Button variant="plain" onClick={onClose}>
            إلغاء
          </Button>
        </>
      }
    >
      <TextField
        label="اللحظة في التسجيل (دقائق:ثوانٍ)"
        hint="بعد التعديل يُوسم الرابط «يدوي». الكتابة نفسها لا تتغير."
        value={text}
        onChange={(e) => setText(e.target.value)}
        error={err ?? undefined}
        dir="ltr"
        inputMode="numeric"
      />
    </Dialog>
  );
}
