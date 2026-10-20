// Controls for a recording this device could not store (Round 7 — H3 item 9), shared by the reader's recording bar and
// the app-wide «تسجيل لم يُحفظ» notice. Kept in a small module so the app shell does not load the reader's code.
import { useState, useSyncExternalStore } from 'react';
import { Download, RotateCcw, Trash2 } from 'lucide-react';
import { Button, ConfirmDialog } from '../../../design';
import { RECORDER_AUTO_RETRY_AR, type RecorderController, type RecorderState } from './recorder';
import { downloadRecording, recordingFileName } from './recordings';

export function useRecorderState(rec: RecorderController): RecorderState {
  return useSyncExternalStore(rec.subscribe, rec.getState, rec.getState);
}

/**
 * Retry / download a copy / give up (after a confirmation) for a recording that could not be stored on this device.
 * Shared by the reader's recording bar and the app-wide notice (UnsavedRecordingNotice, H3 item 9).
 */
export function UnsavedRecordingControls({ recorder, message }: { recorder: RecorderController; message: string }) {
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  return (
    <>
      <span role="alert" className="hw-recbar__msg">
        {message} {RECORDER_AUTO_RETRY_AR}
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
  );
}

