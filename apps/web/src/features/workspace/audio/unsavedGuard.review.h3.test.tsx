// Independent review of Round 7 — H3 item 9. The app-wide «leave the page?» guard only ran while the recorder showed the
// save-failed message. While the recording that the device refused was being UPLOADED directly (online; a long
// recording on a phone takes a while — the upload may run for minutes) the recorder says «saving», the recording is
// still only in this page's memory, and closing the tab lost it without a question. The same during the owner's
// «أعد محاولة الحفظ». The guard now holds whenever the recorder holds a recording that is stored nowhere yet.
import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecorderController, type FinishedRecording, type RecorderEnv } from './recorder';
import { setSharedRecorder } from './sharedRecorder';
import { UnsavedRecordingNotice } from './UnsavedRecordingNotice';

class FakeRecorder {
  state = 'inactive';
  mimeType = 'audio/webm';
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  start() {
    this.state = 'recording';
  }
  stop() {
    this.ondataavailable?.({ data: new Blob(['voice']) });
    this.state = 'inactive';
    setTimeout(() => this.onstop?.(), 0);
  }
}
const env: RecorderEnv = { MediaRecorder: FakeRecorder as never, getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] }) as unknown as MediaStream), isSecureContext: true };
const failingStorage = async (_r: FinishedRecording): Promise<void> => {
  throw new DOMException('QuotaExceededError', 'QuotaExceededError');
};
const closing = () => {
  const ev = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(ev);
  return ev.defaultPrevented;
};

afterEach(() => setSharedRecorder(null));

describe('H3 review — closing the page while the refused recording is still on its way to the server', () => {
  it('asks first while the direct upload runs, and stops asking once the server has it', async () => {
    let finish: () => void = () => undefined;
    const uploading = new Promise<void>((r) => (finish = r));
    const rec = new RecorderController({ env, saveFinished: failingStorage, uploadDirect: () => uploading, online: () => true });
    setSharedRecorder(rec);
    render(<UnsavedRecordingNotice />);
    await act(async () => rec.start({ linkedSourceId: 'S1', nodeId: null }));
    // the owner left the reader while recording: abandon() stops it; the device refuses it; the upload starts
    let stopped: Promise<void> = Promise.resolve();
    await act(async () => {
      stopped = rec.abandon();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(rec.getState().kind).toBe('saving');
    expect(rec.unsaved()).not.toBeNull();
    expect(closing()).toBe(true);
    await act(async () => {
      finish();
      await stopped;
    });
    expect(rec.getState()).toMatchObject({ kind: 'saved', where: 'server' });
    expect(closing()).toBe(false);
  });
});
