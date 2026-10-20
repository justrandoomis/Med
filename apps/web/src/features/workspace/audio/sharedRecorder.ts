// The app-wide recorder, as seen from OUTSIDE the reader (Round 7 — H3 item 9). The reader creates it (AudioUi
// `getRecorder`); this tiny module only holds the reference, so the app shell can show an unsaved recording on every
// screen without loading the reader's code. It also counts the recording bars on screen: while the reader shows its own
// bar, the app-wide notice stays hidden (one place says it, never two).
import type { RecorderController } from './recorder';

let current: RecorderController | null = null;
let barsOnScreen = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function setSharedRecorder(r: RecorderController | null): void {
  current = r;
  emit();
}

export function peekSharedRecorder(): RecorderController | null {
  return current;
}

export function onSharedRecorderChanged(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** A recording bar is on screen until the returned function is called. */
export function registerRecordingBar(): () => void {
  barsOnScreen++;
  emit();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    barsOnScreen--;
    emit();
  };
}

export function recordingBarsOnScreen(): number {
  return barsOnScreen;
}
