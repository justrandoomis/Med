// Track F4 — the recording indicator (§29): nothing is shown and nothing records until the owner starts; while
// recording, a visible «يُسجَّل الآن» (not colour alone) with the time and «إيقاف التسجيل»; permission errors are
// explained; the player plays a stroke's moment and says whether the link is automatic or manual; the link editor
// validates the time.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioLinkDialog, DeviceRecordingsNotice, RecordingBar, RecordingPlayer } from './AudioUi';
import type { RecordingBlobRecord } from './recordings';
import { RecorderController, RECORDER_ERRORS_AR, type RecorderEnv } from './recorder';

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
    this.ondataavailable?.({ data: new Blob(['abc']) });
    this.state = 'inactive';
    setTimeout(() => this.onstop?.(), 0);
  }
}

afterEach(() => vi.useRealTimers());

describe('RecordingBar', () => {
  it('is invisible until the owner starts; then shows the indicator, the time and the stop control', async () => {
    const track = { stop: vi.fn() };
    const gum = vi.fn(async () => ({ getTracks: () => [track] }) as unknown as MediaStream);
    const saved = vi.fn(async () => undefined);
    const env: RecorderEnv = { MediaRecorder: FakeRecorder as never, getUserMedia: gum, isSecureContext: true };
    const rec = new RecorderController({ env, saveFinished: saved });
    render(<RecordingBar recorder={rec} />);
    expect(screen.queryByRole('region', { name: 'التسجيل الصوتي' })).toBeNull();
    expect(gum).not.toHaveBeenCalled();
    await act(async () => rec.start({ linkedSourceId: 'S1', nodeId: 'N1' }));
    const bar = screen.getByRole('region', { name: 'التسجيل الصوتي' });
    expect(bar.textContent).toContain('يُسجَّل الآن');
    expect(bar.querySelector('.hw-recbar__dot')).toBeTruthy();
    expect(screen.getByText(/بدأ التسجيل/)).toBeTruthy(); // announced to assistive technology
    fireEvent.click(screen.getByRole('button', { name: 'إيقاف مؤقت' }));
    expect(bar.textContent).toContain('التسجيل متوقف مؤقتًا');
    fireEvent.click(screen.getByRole('button', { name: 'استئناف التسجيل' }));
    fireEvent.click(screen.getByRole('button', { name: 'إيقاف التسجيل' }));
    await waitFor(() => expect(screen.getByText(/حُفظ التسجيل/)).toBeTruthy());
    expect(track.stop).toHaveBeenCalled();
    expect(saved).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'إغلاق' }));
    expect(screen.queryByRole('region', { name: 'التسجيل الصوتي' })).toBeNull();
  });

  it('a refused microphone is explained (and nothing records)', async () => {
    const env: RecorderEnv = { MediaRecorder: FakeRecorder as never, getUserMedia: vi.fn(async () => Promise.reject(Object.assign(new Error('no'), { name: 'NotAllowedError' }))), isSecureContext: true };
    const rec = new RecorderController({ env });
    render(<RecordingBar recorder={rec} />);
    await act(async () => rec.start({ linkedSourceId: null, nodeId: null }));
    expect(screen.getAllByText(RECORDER_ERRORS_AR.denied).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'إيقاف التسجيل' })).toBeNull();
  });
});

describe('(review) recordings that did not reach the server are never invisible', () => {
  it('a recording that could not be stored offers retry and a download, and no close button that would drop it', async () => {
    let fail = true;
    const saved = vi.fn(async () => {
      if (fail) throw new Error('quota');
    });
    const env: RecorderEnv = { MediaRecorder: FakeRecorder as never, getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] }) as unknown as MediaStream), isSecureContext: true };
    const rec = new RecorderController({ env, saveFinished: saved });
    render(<RecordingBar recorder={rec} />);
    await act(async () => rec.start({ linkedSourceId: null, nodeId: null }));
    fireEvent.click(screen.getByRole('button', { name: 'إيقاف التسجيل' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'أعد محاولة الحفظ' })).toBeTruthy());
    expect(screen.getByRole('button', { name: 'نزّل نسخة' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'إغلاق' })).toBeNull();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'أعد محاولة الحفظ' }));
    await waitFor(() => expect(screen.getByText(/حُفظ التسجيل/)).toBeTruthy());
    expect(saved).toHaveBeenCalledTimes(2);
  });

  it('lists refused / waiting recordings on this device with the reason, a download and «أعد محاولة الرفع»', async () => {
    const rows = [
      { id: 'rec:A', kind: 'audio_recording', recordingId: 'A', mime: 'audio/webm', size: 3, data: new Blob(['abc']), storedAt: 1, uploadState: 'rejected', uploadError: 'التسجيل أكبر من حد الرفع على الخادم.', startedAt: Date.UTC(2026, 9, 10, 9, 5), durationMs: 65_000, linkedSourceId: null, nodeId: null, title: 'ملاحظة صوتية — 10/10 12:05' },
    ] as unknown as RecordingBlobRecord[];
    const retry = vi.fn(async () => undefined);
    const download = vi.fn(() => true);
    render(<DeviceRecordingsNotice load={async () => rows} retry={retry} download={download} />);
    const notice = await screen.findByRole('region', { name: 'تسجيلات على هذا الجهاز' });
    expect(notice.textContent).toContain('تسجيل واحد لم يقبله الخادم، وهو محفوظ على هذا الجهاز.');
    fireEvent.click(screen.getByRole('button', { name: 'عرض' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('رفضه الخادم: التسجيل أكبر من حد الرفع على الخادم.');
    expect(dialog.textContent).toContain('1:05');
    fireEvent.click(screen.getByRole('button', { name: 'نزّل نسخة' }));
    expect(download).toHaveBeenCalledWith(rows[0]!.data, 'recording-A.webm');
    fireEvent.click(screen.getByRole('button', { name: 'أعد محاولة الرفع' }));
    expect(retry).toHaveBeenCalledWith('A');
  });

  it('shows nothing when every recording reached the server', async () => {
    const load = vi.fn(async () => []);
    const { container } = render(<DeviceRecordingsNotice load={load} />);
    await waitFor(() => expect(load).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });
});

describe('RecordingPlayer and the link editor', () => {
  it('plays a stroke moment and labels the link', async () => {
    const resolve = vi.fn(async () => ({ url: '/api/media/audio/AU1/stream', local: false, title: 'ملاحظة صوتية — 10/10' }));
    render(<RecordingPlayer request={{ link: { recording_id: 'REC1', offset_ms: 65_000, origin: 'auto' }, nonce: 1 }} onClose={() => {}} resolve={resolve} />);
    const region = screen.getByRole('region', { name: 'تشغيل التسجيل' });
    await waitFor(() => expect(region.querySelector('audio')).toBeTruthy());
    expect(resolve).toHaveBeenCalledWith('REC1');
    expect(region.textContent).toContain('1:05');
    expect(region.textContent).toContain('رابط زمني تلقائي');
    const audio = region.querySelector('audio') as HTMLAudioElement;
    const play = vi.spyOn(audio, 'play').mockResolvedValue(undefined);
    fireEvent(audio, new Event('loadedmetadata'));
    expect(audio.currentTime).toBe(65);
    expect(play).toHaveBeenCalled();
  });

  it('says when the recording is not on this device nor on the server yet', async () => {
    render(<RecordingPlayer request={{ link: { recording_id: 'GONE', offset_ms: 0, origin: 'manual' }, nonce: 1 }} onClose={() => {}} resolve={async () => Promise.reject(new Error('التسجيل غير موجود على الخادم (لم يُرفع بعد، أو مصدره في سلة المحذوفات).'))} />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText(/رابط زمني عدّلته بنفسك/)).toBeTruthy();
  });

  it('the editor accepts m:ss and refuses nonsense; removing is a separate action', () => {
    const onSave = vi.fn();
    const onRemove = vi.fn();
    render(<AudioLinkDialog link={{ recording_id: 'R', offset_ms: 65_000, origin: 'auto' }} open onClose={() => {}} onSave={onSave} onRemove={onRemove} />);
    const field = screen.getByLabelText(/اللحظة في التسجيل/) as HTMLInputElement;
    expect(field.value).toBe('1:05');
    fireEvent.change(field, { target: { value: 'abc' } });
    fireEvent.click(screen.getByRole('button', { name: 'احفظ الوقت' }));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText(/دقائق:ثوانٍ/, { selector: '.ml-field__error, [role="alert"], p, span' })).toBeTruthy();
    fireEvent.change(field, { target: { value: '0:42' } });
    fireEvent.click(screen.getByRole('button', { name: 'احفظ الوقت' }));
    expect(onSave).toHaveBeenCalledWith(42_000);
    fireEvent.click(screen.getByRole('button', { name: 'أزل الرابط' }));
    expect(onRemove).toHaveBeenCalled();
  });
});
