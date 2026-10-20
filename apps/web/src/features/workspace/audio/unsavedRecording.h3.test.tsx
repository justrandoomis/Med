// Round 7 — H3 item 9: a recording whose save to the device failed while the owner LEFT THE READER lived only in this
// page's memory: the save-failed bar (retry / download / discard) and its «leave the page?» guard were part of the
// reader, so they disappeared with it, nothing retried by itself, and closing the tab lost the recording without a
// word. Now (with a failing storage mock):
//  * the recorder keeps a retry path of its own: it uploads the recording straight to the server when online (the
//    server keeps it — not only in memory), and otherwise retries the device save on a backoff;
//  * an app-wide notice shows the unsaved recording on every screen (retry / download a copy / give up after a
//    confirmation) and guards closing the page while it exists.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecordingBar } from './AudioUi';
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
  pause() {}
  resume() {}
  stop() {
    this.ondataavailable?.({ data: new Blob(['voice']) });
    this.state = 'inactive';
    setTimeout(() => this.onstop?.(), 0);
  }
}
const env: RecorderEnv = { MediaRecorder: FakeRecorder as never, getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] }) as unknown as MediaStream), isSecureContext: true };
/** a device whose storage refuses every write (quota exceeded / blocked) */
const failingStorage = vi.fn(async (_r: FinishedRecording): Promise<void> => {
  throw new DOMException('QuotaExceededError', 'QuotaExceededError');
});

afterEach(() => {
  setSharedRecorder(null);
  vi.useRealTimers();
  failingStorage.mockClear();
});

describe('H3 item 9 — a recording the device could not store', () => {
  it('online: it is uploaded straight to the server (never left only in memory) and the owner is told where it is', async () => {
    const uploaded: FinishedRecording[] = [];
    const rec = new RecorderController({ env, saveFinished: failingStorage, uploadDirect: async (r) => void uploaded.push(r), online: () => true });
    await rec.start({ linkedSourceId: 'S1', nodeId: 'N1' });
    await rec.abandon(); // the owner left the reader while recording
    await waitFor(() => expect(rec.getState()).toMatchObject({ kind: 'saved', where: 'server' }));
    expect(failingStorage).toHaveBeenCalled();
    expect(uploaded).toHaveLength(1);
    expect(await uploaded[0]!.blob.text()).toBe('voice');
    expect(uploaded[0]).toMatchObject({ linkedSourceId: 'S1', nodeId: 'N1' });
    expect(rec.unsaved()).toBeNull();
  });

  it('offline: the device save is retried on a backoff until storage works again — the recording is kept meanwhile', async () => {
    vi.useFakeTimers();
    let fail = 2;
    const stored: FinishedRecording[] = [];
    const rec = new RecorderController({
      env,
      saveFinished: async (r) => {
        if (fail-- > 0) throw new Error('quota');
        stored.push(r);
      },
      uploadDirect: async () => {
        throw new Error('offline');
      },
      online: () => false,
      retryDelaysMs: [1000, 5000],
    });
    await rec.start({ linkedSourceId: null, nodeId: null });
    const stopping = rec.stop();
    await vi.advanceTimersByTimeAsync(10);
    await stopping;
    expect(rec.getState()).toMatchObject({ kind: 'error', code: 'save_failed' });
    expect(rec.unsaved()).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1000); // first automatic retry: still failing
    expect(rec.getState()).toMatchObject({ kind: 'error', code: 'save_failed' });
    await vi.advanceTimersByTimeAsync(5000); // second: storage works again
    expect(stored).toHaveLength(1);
    expect(rec.getState()).toMatchObject({ kind: 'saved' });
    expect((rec.getState() as { where?: string }).where).toBeUndefined(); // on this device
    expect(rec.unsaved()).toBeNull();
  });

  it('after leaving the reader, an app-wide notice shows it (retry / download / give up) and guards closing the page', async () => {
    const rec = new RecorderController({ env, saveFinished: failingStorage, online: () => false, retryDelaysMs: [60_000] });
    setSharedRecorder(rec);
    // the reader with its recording bar, and the app-wide notice (mounted at the root of the app)
    const reader = render(<RecordingBar recorder={rec} />);
    render(<UnsavedRecordingNotice />);
    await act(async () => rec.start({ linkedSourceId: 'S1', nodeId: null }));
    // the reader is the one showing the recorder: no duplicate notice while it is on screen
    expect(screen.queryByRole('region', { name: 'تسجيل لم يُحفظ' })).toBeNull();
    // the owner leaves the reader: it unmounts and its host stops the recording (abandon); the device refuses it
    reader.unmount();
    await act(async () => rec.abandon());
    const notice = await screen.findByRole('region', { name: 'تسجيل لم يُحفظ' });
    expect(notice.textContent).toMatch(/تعذّر حفظ التسجيل على هذا الجهاز/);
    expect(screen.getByRole('button', { name: 'أعد محاولة الحفظ' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'نزّل نسخة' })).toBeTruthy();
    // closing the page asks first
    const ev = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    // giving it up needs a confirmation; cancelling keeps it
    fireEvent.click(screen.getByRole('button', { name: 'تخلَّ عنه' }));
    fireEvent.click(await screen.findByRole('button', { name: 'إلغاء' }));
    expect(rec.unsaved()).not.toBeNull();
    // storage works again: «أعد محاولة الحفظ» stores it and the notice goes away
    failingStorage.mockImplementationOnce(async () => undefined);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'أعد محاولة الحفظ' }));
    });
    await waitFor(() => expect(rec.unsaved()).toBeNull());
    expect(rec.getState()).toMatchObject({ kind: 'saved' });
    expect((rec.getState() as { where?: string }).where).toBeUndefined(); // on this device
    const after = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });
});
