// Adversarial review of track C3, R7 (AOS-1.38 «two accounts in one browser: nothing of A ever goes out under B's
// session»): the sync engine stops at A's sign-out, but the picture and recording uploaders started for A keep their
// timers and A's database. When B signs in on the same page, the page reloads only after the sign-in answer and an
// auth round-trip; a tick (the minute timer, or an «online» event) in that window posted A's waiting picture or
// recording with B's cookie — into B's vault. An uploader now acts only while the page belongs to the account it was
// started for.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setFetchImpl } from '../../src/lib/api';
import type { MedLevoDB } from '../../src/lib/localdb';
import { setStorageAccount } from '../../src/lib/userStorage';
import { startImageUploader } from '../../src/features/workspace/ink/images';
import { startRecordingUploader } from '../../src/features/workspace/audio/recordings';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// an in-memory `blobs` table (fake-indexeddb does not keep a Blob a Blob — see test/ink/notebook-tools.test.tsx)
type Row = Record<string, unknown> & { id: string; kind: string };
const rows = new Map<string, Row>();
const db = {
  blobs: {
    where: () => ({
      equals: (kind: string) => {
        const of = () => [...rows.values()].filter((r) => r.kind === kind);
        return { toArray: async () => of(), filter: (fn: (r: Row) => boolean) => ({ primaryKeys: async () => of().filter(fn).map((r) => r.id) }) };
      },
    }),
    get: async (id: string) => rows.get(id),
    update: async (id: string, patch: Record<string, unknown>) => {
      rows.set(id, { ...rows.get(id)!, ...patch });
      return 1;
    },
    bulkDelete: async (ids: string[]) => ids.forEach((id) => rows.delete(id)),
  },
} as unknown as MedLevoDB;
let posted: string[] = [];
beforeAll(() => {
  setFetchImpl(async (url, init) => {
    if ((init?.method ?? 'GET') === 'POST') posted.push(url);
    return json({ ok: true, recording: { id: 'r', source_id: 'S9' } });
  });
});
afterAll(() => {
  setFetchImpl(null);
  setStorageAccount(null);
});

const blob = () => new Blob(['x'], { type: 'image/png' });
const settle = () => new Promise((r) => setTimeout(r, 60));
const later = () => Date.now() + 3_600_000;

describe('uploaders belong to the account they were started for', () => {
  it('a picture waiting in A’s database is never posted once B has signed in on the page; back on A it goes', async () => {
    posted = [];
    setStorageAccount({ userId: 'userA', legacy: false });
    rows.set('annimg:k1', { id: 'annimg:k1', kind: 'annotation_image', imageKey: 'k1', uploadState: 'pending', sourceId: null, versionId: null, mime: 'image/png', size: 1, data: blob(), storedAt: 1, nextAttemptAt: later() });
    startImageUploader(db); // started for A (the picture is not due yet: nothing goes out now)
    await settle();
    expect(posted).toEqual([]);
    rows.set('annimg:k1', { ...rows.get('annimg:k1')!, nextAttemptAt: 0 });
    // B signs in on this page (activateAccount switched the page's account; the reload has not happened yet)
    setStorageAccount({ userId: 'userB', legacy: false });
    window.dispatchEvent(new Event('online'));
    await settle();
    expect(posted).toEqual([]);
    // control: while the page is A's, the uploader does its job
    setStorageAccount({ userId: 'userA', legacy: false });
    window.dispatchEvent(new Event('online'));
    await settle();
    expect(posted).toContain('/api/annotations/images');
  });

  it('a recording waiting in A’s database is never posted once B has signed in on the page; back on A it goes', async () => {
    posted = [];
    setStorageAccount({ userId: 'userA', legacy: false });
    rows.set('rec:r1', { id: 'rec:r1', kind: 'audio_recording', recordingId: 'r1', uploadState: 'pending', startedAt: 1, durationMs: 1000, linkedSourceId: null, nodeId: null, sourceId: null, versionId: null, mime: 'audio/webm', size: 1, data: blob(), storedAt: 1, nextAttemptAt: later() });
    startRecordingUploader(db);
    await settle();
    expect(posted.filter((u) => u.includes('/media/recordings'))).toEqual([]);
    rows.set('rec:r1', { ...rows.get('rec:r1')!, nextAttemptAt: 0 });
    setStorageAccount({ userId: 'userB', legacy: false });
    window.dispatchEvent(new Event('online'));
    await settle();
    expect(posted.filter((u) => u.includes('/media/recordings'))).toEqual([]);
    setStorageAccount({ userId: 'userA', legacy: false });
    window.dispatchEvent(new Event('online'));
    await settle();
    expect(posted).toContain('/api/media/recordings');
  });
});
