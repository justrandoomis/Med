// Adversarial review of track C3 (AOS-4.7 / ADR-0003 Q26) — «امسح بيانات هذا الجهاز عند الخروج» and «جهاز مشترك».
//
//   R1  the clearing sign-out deleted, without counting them, writing that exists ONLY on this device: a lecture
//       recording not uploaded yet (or refused by the server and kept here with its reason, or interrupted and still in
//       chunks), a picture inserted on a page and not uploaded, an answer typed in a case («الحالات») or a written /
//       handwritten exam answer not saved yet. Each is now counted and stops the clearing like an unsent outbox op.
//   R2  «a device registered as shared ALWAYS clears» was decided by the screen only: pressing «تسجيل الخروج» before
//       the device list had arrived (or when that request failed) signed out of a shared device keeping everything.
//       The sign-out now asks the server itself, and falls back to what this device last knew.
import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { DevicesResponse, DeviceView } from '@medlevo/shared';
import { ToastProvider } from '../../src/design';
import { setFetchImpl } from '../../src/lib/api';
import { MedLevoDB, resetSharedDb } from '../../src/lib/localdb';
import { setStorageAccount } from '../../src/lib/userStorage';

const syncNow = vi.fn(async () => undefined);
const stop = vi.fn();
vi.mock('../../src/lib/sync', async (orig) => ({ ...(await orig<typeof import('../../src/lib/sync')>()), getSyncEngine: () => ({ syncNow, stop }) }));

const { afterClear, unsentOnThisDevice, unsentAr, signOutThisDevice } = await import('../../src/lib/signOut');
const { LogoutGroup } = await import('../../src/features/settings/SecuritySection');

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const blob = (s = 'bytes') => new Blob([s], { type: 'application/octet-stream' });
const device = (shared: boolean): DeviceView => ({ device_id: 'd1', device_uid: 'U1', label: null, platform: 'web', has_key: false, shared_device: shared, first_seen_at: 1, last_seen_at: 1, revoked_at: null, current: true });

async function openDb(name = 'medlevo:u1'): Promise<MedLevoDB> {
  const db = new MedLevoDB(name);
  await db.open();
  await db.kv.put({ key: 'probe', value: 1, updatedAt: 1 });
  return db;
}

let went: string[] = [];
beforeEach(async () => {
  went = [];
  afterClear.go = (p: string) => void went.push(p);
  localStorage.clear();
  sessionStorage.clear();
  resetSharedDb();
  for (const n of ['medlevo:u1', 'medlevo']) await Dexie.delete(n);
  setStorageAccount({ userId: 'u1', legacy: false });
  syncNow.mockClear();
  stop.mockClear();
});
afterEach(() => {
  setFetchImpl(null);
  resetSharedDb();
  setStorageAccount(null);
});

describe('R1 — what exists only on this device is counted before clearing', () => {
  it('a recording not uploaded, a refused one, an interrupted one, a picture not uploaded: counted; uploaded ones and caches are not', async () => {
    const db = await openDb();
    const at = { sourceId: null, versionId: null, mime: 'audio/webm', size: 5, data: blob(), storedAt: 1 };
    await db.blobs.bulkPut([
      { id: 'rec:r1', kind: 'audio_recording', recordingId: 'r1', uploadState: 'pending', startedAt: 1, durationMs: 1000, linkedSourceId: null, nodeId: null, ...at },
      { id: 'rec:r2', kind: 'audio_recording', recordingId: 'r2', uploadState: 'rejected', uploadError: 'نوع غير مدعوم', startedAt: 1, durationMs: 1000, linkedSourceId: null, nodeId: null, ...at },
      { id: 'rec:r3', kind: 'audio_recording', recordingId: 'r3', uploadState: 'uploaded', startedAt: 1, durationMs: 1000, linkedSourceId: null, nodeId: null, ...at },
      // an interrupted recording: chunks only (two chunks of one recording = one recording)
      { id: 'recchunk:r4:000000', kind: 'audio_recording_chunk', recordingId: 'r4', seq: 0, startedAt: 1, linkedSourceId: null, nodeId: null, ...at },
      { id: 'recchunk:r4:000001', kind: 'audio_recording_chunk', recordingId: 'r4', seq: 1, startedAt: 1, linkedSourceId: null, nodeId: null, ...at },
      { id: 'annimg:k1', kind: 'annotation_image', imageKey: 'k1', uploadState: 'pending', ...at, mime: 'image/png' },
      { id: 'annimg:k2', kind: 'annotation_image', imageKey: 'k2', uploadState: 'uploaded', ...at, mime: 'image/png' },
      // a downloaded copy of a server file (a cache): nothing to lose
      { id: 'card:img', kind: 'flashcard_image', ...at, mime: 'image/png' },
    ] as never[]);
    const u = await unsentOnThisDevice(db);
    expect(u.uploads).toBe(4);
    expect(u.total).toBe(4);
    expect(unsentAr(u)).toContain('4');
    db.close();
  });

  it('an answer typed in a case, a written exam answer and a handwritten answer not saved yet: counted as drafts; emptied ones are not', async () => {
    const db = await openDb();
    localStorage.setItem('u1:medlevo.cases.draft.att1', 'إجابتي عن الحالة');
    await db.kv.bulkPut([
      { key: 'exams.written.draft.q1', value: 'إجابة مكتوبة لم تُحفظ', updatedAt: 1 },
      { key: 'exams.written.draft.q2', value: '', updatedAt: 1 },
      { key: 'written-pad:q3', value: [{ points: [[0, 0, 0.5]] }], updatedAt: 1 },
      { key: 'written-pad:q4', value: [], updatedAt: 1 },
    ]);
    const u = await unsentOnThisDevice(db);
    expect(u.drafts).toBe(3);
    expect(u.total).toBe(3);
    db.close();
  });

  it('the kinds and keys counted are the ones the features write (no drift)', async () => {
    const { LOCAL_ONLY_BLOB_KINDS } = await import('../../src/lib/signOut');
    const images = await import('../../src/features/workspace/ink/images');
    const recordings = await import('../../src/features/workspace/audio/recordings');
    expect(LOCAL_ONLY_BLOB_KINDS).toEqual({ image: images.IMAGE_BLOB_KIND, recording: recordings.RECORDING_BLOB_KIND, recordingChunk: recordings.RECORDING_CHUNK_KIND });
    // a written answer saved as a draft by the exam screen's own function is counted
    const { saveWrittenDraft } = await import('../../src/features/exams/local');
    const db = await openDb();
    await saveWrittenDraft(db, 'q9', 'جواب');
    expect((await unsentOnThisDevice(db)).drafts).toBe(1);
    await saveWrittenDraft(db, 'q9', '');
    expect((await unsentOnThisDevice(db)).drafts).toBe(0);
    db.close();
  });

  it('a clearing sign-out with only a recording waiting stops and asks; nothing is deleted', async () => {
    let logoutCalls = 0;
    setFetchImpl(async (url, init) => {
      if (url.startsWith('/api/auth/logout') && init?.method === 'POST') {
        logoutCalls++;
        return json({ ok: true });
      }
      if (url.startsWith('/api/accounts/me/devices')) return json({ devices: [device(false)] } satisfies DevicesResponse);
      return json({ error: { code: 'NOT_FOUND', message: 'غير موجود' } }, 404);
    });
    const db = await openDb();
    await db.blobs.put({ id: 'rec:r1', kind: 'audio_recording', recordingId: 'r1', uploadState: 'pending', startedAt: 1, durationMs: 1000, linkedSourceId: null, nodeId: null, sourceId: null, versionId: null, mime: 'audio/webm', size: 5, data: blob(), storedAt: 1 } as never);
    db.close();
    const r = await signOutThisDevice({ clear: true });
    expect(r.kind).toBe('unsent');
    expect(logoutCalls).toBe(0);
    expect(await Dexie.exists('medlevo:u1')).toBe(true);
  });
});

function show() {
  render(
    <ToastProvider>
      <MemoryRouter initialEntries={['/settings']}>
        <Routes>
          <Route path="/settings" element={<LogoutGroup />} />
          <Route path="/login" element={<h1>تسجيل الدخول</h1>} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  );
}

describe('R2 — a shared device always clears, whatever the screen had loaded', () => {
  it('«تسجيل الخروج» pressed before the device list arrived: the shared device is still cleared', async () => {
    let devicesCalls = 0;
    let releaseFirst: (() => void) | null = null;
    setFetchImpl(async (url, init) => {
      if (url.startsWith('/api/auth/logout') && init?.method === 'POST') return json({ ok: true });
      if (url.startsWith('/api/accounts/me/devices')) {
        devicesCalls++;
        // the screen's own request hangs (a slow network); later ones answer
        if (devicesCalls === 1) await new Promise<void>((res) => (releaseFirst = res));
        return json({ devices: [device(true)] } satisfies DevicesResponse);
      }
      return json({ error: { code: 'NOT_FOUND', message: 'غير موجود' } }, 404);
    });
    (await openDb()).close();
    show();
    const box = (await screen.findByRole('checkbox', { name: /امسح بيانات هذا الجهاز عند الخروج/ })) as HTMLInputElement;
    expect(box.checked).toBe(false); // the screen does not know yet
    fireEvent.click(screen.getByRole('button', { name: 'تسجيل الخروج' }));
    await waitFor(() => expect(went).toEqual(['/login']));
    expect(await Dexie.exists('medlevo:u1')).toBe(false);
    (releaseFirst as (() => void) | null)?.();
  });

  it('the device list cannot be read at sign-out: what this device last knew (shared) decides — it clears', async () => {
    let failDevices = false;
    setFetchImpl(async (url, init) => {
      if (url.startsWith('/api/auth/logout') && init?.method === 'POST') return json({ ok: true });
      if (url.startsWith('/api/accounts/me/devices')) {
        if (failDevices) return json({ error: { code: 'INTERNAL', message: 'خطأ' } }, 500);
        return json({ devices: [device(true)] } satisfies DevicesResponse);
      }
      return json({ error: { code: 'NOT_FOUND', message: 'غير موجود' } }, 404);
    });
    (await openDb()).close();
    const { currentDeviceIsShared } = await import('../../src/lib/signOut');
    expect(await currentDeviceIsShared()).toBe(true); // learnt once (the screen read it)
    failDevices = true;
    const r = await signOutThisDevice({ clear: false });
    expect(r).toEqual({ kind: 'signed_out', cleared: true });
    expect(await Dexie.exists('medlevo:u1')).toBe(false);
  });

  it('a device that is NOT shared and no option ticked: signing out keeps the data (unchanged default)', async () => {
    setFetchImpl(async (url, init) => {
      if (url.startsWith('/api/auth/logout') && init?.method === 'POST') return json({ ok: true });
      if (url.startsWith('/api/accounts/me/devices')) return json({ devices: [device(false)] } satisfies DevicesResponse);
      return json({ error: { code: 'NOT_FOUND', message: 'غير موجود' } }, 404);
    });
    (await openDb()).close();
    const r = await signOutThisDevice({ clear: false });
    expect(r).toEqual({ kind: 'signed_out', cleared: false });
    expect(await Dexie.exists('medlevo:u1')).toBe(true);
  });
});

describe('R9 — another open tab of the same account leaves when this device is cleared', () => {
  it('a clearing sign-out tells the other tabs of THIS account to leave (full load to the sign-in page); another account’s tab stays', async () => {
    setFetchImpl(async (url, init) => {
      if (url.startsWith('/api/auth/logout') && init?.method === 'POST') return json({ ok: true });
      if (url.startsWith('/api/accounts/me/devices')) return json({ devices: [device(false)] } satisfies DevicesResponse);
      return json({ error: { code: 'NOT_FOUND', message: 'غير موجود' } }, 404);
    });
    (await openDb()).close();
    const { listenForAccountClear } = await import('../../src/lib/signOut');
    // «the other tab»: same account, its own channel end
    const stop = listenForAccountClear();
    try {
      const r = await signOutThisDevice({ clear: true });
      expect(r).toEqual({ kind: 'signed_out', cleared: true });
      await waitFor(() => expect(went).toEqual(['/login']));
      // a message about another account is ignored
      went = [];
      const other = new BroadcastChannel('medlevo-account');
      other.postMessage({ type: 'cleared', userId: 'someone-else' });
      await new Promise((res) => setTimeout(res, 50));
      other.close();
      expect(went).toEqual([]);
    } finally {
      stop();
    }
  });
});
