// «تسجيل لم يُحفظ» on every screen (Round 7 — H3 item 9). A recording whose save to this device failed while the owner
// LEFT THE READER used to live only in the page's memory with nothing on screen about it: the reader's recording bar
// (retry / download / discard) and its «leave the page?» guard went away with the reader. This notice is mounted at the
// root of the app: while the app-wide recorder holds an unsaved recording and no recording bar is on screen, it shows
// the same controls and asks before the page closes. The recorder keeps retrying by itself meanwhile (a direct upload
// when online, the device save on a backoff), so the notice also goes away by itself once it is safe.
import { useEffect, useSyncExternalStore } from 'react';
import { Mic } from 'lucide-react';
import { UnsavedRecordingControls, useRecorderState } from './unsavedControls';
import type { RecorderController } from './recorder';
import { onSharedRecorderChanged, peekSharedRecorder, recordingBarsOnScreen } from './sharedRecorder';
import '../handwriting/handwriting.css';

const snapshot = () => `${recordingBarsOnScreen()}`;

export function UnsavedRecordingNotice() {
  // re-render when the recorder appears or a recording bar mounts / unmounts
  useSyncExternalStore(onSharedRecorderChanged, snapshot, snapshot);
  const recorder = peekSharedRecorder();
  if (!recorder) return null;
  return <Notice recorder={recorder} barOnScreen={recordingBarsOnScreen() > 0} />;
}

function Notice({ recorder, barOnScreen }: { recorder: RecorderController; barOnScreen: boolean }) {
  const state = useRecorderState(recorder);
  const unsaved = state.kind === 'error' && state.code === 'save_failed' && !!recorder.unsaved();
  // closing the page while the recording exists only in memory asks first (the reader's bar does the same)
  useEffect(() => {
    if (!unsaved || barOnScreen) return;
    const guard = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [unsaved, barOnScreen]);
  if (!unsaved || barOnScreen || state.kind !== 'error') return null;
  return (
    <div className="hw-dock hw-dock--global">
      <div className="hw-recbar" role="region" aria-label="تسجيل لم يُحفظ" dir="rtl" data-state="error">
        <Mic size={16} aria-hidden="true" />
        <UnsavedRecordingControls recorder={recorder} message={state.message} />
      </div>
    </div>
  );
}
