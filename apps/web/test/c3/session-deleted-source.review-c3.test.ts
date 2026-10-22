// Adversarial review of track C3, R4 (AOS-19J.1 «the study session across devices»): a lecture deleted on ONE device
// kept coming back on the other as «تابع الدراسة». The server's list leaves deleted sources out, but this device's own
// session row stayed in its database — the purge's «deleted» sync change (entity null) was ignored by the session
// applier, and a source in the trash sends nothing at all — so Home merged it back in under «مصدر على هذا الجهاز» and
// opened a lecture that no longer exists.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '@medlevo/shared';
import { MedLevoDB } from '../../src/lib/localdb';
import { mergeContinue } from '../../src/features/home/HomeScreen';
import { __test, type WorkspaceSessionRow } from '../../src/features/workspace/data/local';

let db: MedLevoDB;
beforeEach(async () => {
  db = new MedLevoDB(`review-c3-${newId()}`);
  await db.open();
});
afterEach(async () => {
  db.close();
  await db.delete();
});

const row = (id: string, sourceId: string): WorkspaceSessionRow => ({ id, sourceId, versionId: 'V1', mode: 'learn', view: 'original', location: { page_index: 2 }, rev: 3, updatedAt: 50, syncState: 'synced' });

describe('a session of a lecture deleted on another device', () => {
  it('the purge announced it gone (entity null): this device forgets its own copy of the session', async () => {
    await db.studySessions.put(row('SESS', 'GONE'));
    await __test.sessionApplier({ seq: 9, entity_type: 'study_session', entity_id: 'SESS', entity: null }, { db, source: 'pull', localOps: [] });
    expect(await db.studySessions.get('SESS')).toBeUndefined();
  });

  it('…but a place this device has not sent yet is kept (nothing local is dropped while it waits)', async () => {
    await db.studySessions.put(row('SESS', 'GONE'));
    const waiting = { seq: 1, op_id: 'o1', entity_type: 'study_session', entity_id: 'SESS', op: 'upsert' as const, payload: {}, client_ts: 1, status: 'pending' as const, attempts: 0, nextAttemptAt: 0 };
    await __test.sessionApplier({ seq: 9, entity_type: 'study_session', entity_id: 'SESS', entity: null }, { db, source: 'pull', localOps: [waiting] });
    expect(await db.studySessions.get('SESS')).toBeDefined();
  });

  it('Home: with the library just read from the server, a local session of a lecture the server no longer lists is not offered', () => {
    const server = [{ source_id: 'A', title: 'A', version_id: null, page_label_ar: 'ص 2', mode: 'learn' as const, updated_at: 10 }];
    const local = [
      { source_id: 'A', title: 'A', version_id: null, page_label_ar: null, mode: 'learn' as const, updated_at: 5 },
      // deleted on the other device (in the trash, or purged): not in the library, not in the server's list
      { source_id: 'GONE', title: 'مصدر على هذا الجهاز', version_id: null, page_label_ar: 'ص 3', mode: 'learn' as const, updated_at: 99 },
      // studied on this device only so far (not synced yet) — a lecture the library does list
      { source_id: 'B', title: 'B', version_id: null, page_label_ar: null, mode: 'learn' as const, updated_at: 40 },
    ];
    const merged = mergeContinue(server, local, { liveSources: new Set(['A', 'B']) });
    expect(merged.map((m) => m.source_id)).toEqual(['B', 'A']);
    // offline / the library not read from the server yet: nothing is dropped (this device cannot know)
    expect(mergeContinue(server, local).map((m) => m.source_id)).toEqual(['GONE', 'B', 'A']);
  });
});
