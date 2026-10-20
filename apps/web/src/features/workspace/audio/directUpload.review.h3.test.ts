// Independent review of Round 7 — H3 item 9. When the device refused the FINISHED recording but had stored its chunks
// while it was being made, the direct upload put the recording on the server — and left the chunks behind. The next
// start «recovered» them as an interrupted recording («استُعيد بعد انقطاع»), listed it as needing the owner's attention
// and uploaded it a second time, on a device whose storage was already full. Once the server has the recording, its
// chunks on this device are dropped.
import { beforeEach, describe, expect, it } from 'vitest';
import { newId } from '@medlevo/shared';
import { MedLevoDB } from '../../../lib/localdb';
import { deviceRecordingsNeedingAttention, localRecording, RECORDING_CHUNK_KIND, recoverInterruptedRecordings, saveRecordingChunk, uploadRecordingDirect } from './recordings';

let db: MedLevoDB;
beforeEach(async () => {
  db = new MedLevoDB(`rec-h3r-${newId()}`);
  await db.open();
});

describe('H3 review — a recording uploaded directly leaves no chunks to «recover»', () => {
  it('after the direct upload, a later recovery pass finds nothing (and nothing needs the owner\'s attention)', async () => {
    const id = newId();
    const meta = { linkedSourceId: 'S1', nodeId: null, mime: 'audio/webm', startedAt: 1_800_000_000_000 };
    await saveRecordingChunk(db, id, 0, new Blob(['voi']), meta);
    await saveRecordingChunk(db, id, 1, new Blob(['ce']), meta);
    const posted: FormData[] = [];
    await uploadRecordingDirect(
      { recordingId: id, blob: new Blob(['voice']), mime: 'audio/webm', startedAt: meta.startedAt, durationMs: 1200, linkedSourceId: 'S1', nodeId: null },
      async (form) => {
        posted.push(form);
        return { recording: { id } } as never;
      },
      db,
    );
    expect(posted).toHaveLength(1);
    // the chunks are gone (fake-indexeddb keeps no Blob type, so the recovery pass itself is exercised in a browser:
    // with the chunks left, it assembled them into a «recovered» recording)
    expect(await db.blobs.where('kind').equals(RECORDING_CHUNK_KIND).count()).toBe(0);
    expect(await recoverInterruptedRecordings(db, null, { held: new Set(), now: Date.now() + 3_600_000 })).toBe(0);
    expect(await localRecording(id, db)).toBeNull();
    expect(await deviceRecordingsNeedingAttention(db)).toEqual([]);
  });

  it('a failed direct upload keeps the chunks (they are the device\'s last copy if the page dies)', async () => {
    const id = newId();
    const meta = { linkedSourceId: null, nodeId: null, mime: 'audio/webm', startedAt: 1_800_000_000_000 };
    await saveRecordingChunk(db, id, 0, new Blob(['voice']), meta);
    await expect(
      uploadRecordingDirect(
        { recordingId: id, blob: new Blob(['voice']), mime: 'audio/webm', startedAt: meta.startedAt, durationMs: 1200, linkedSourceId: null, nodeId: null },
        async () => {
          throw new Error('offline');
        },
        db,
      ),
    ).rejects.toThrow('offline');
    expect(await db.blobs.count()).toBe(1);
  });
});
