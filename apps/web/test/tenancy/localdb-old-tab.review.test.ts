// P1-T1 step 0 review — two app versions on one device. The service worker updates on prompt (`registerType:
// 'prompt'`), so a tab still running the previous build (Dexie schema v2) can be open while a new tab upgrades the
// database to v3. The old tab must keep working on the upgraded database (Dexie 4 opens a newer installed version
// instead of failing with VersionError), and the outbox ops it writes — without `target` — must be read by the new
// code as vault ops and pushed. Nothing the old tab writes may be lost or misrouted.
import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';
import { newId, type SyncPullResponse, type SyncPushRequest, type SyncOpResult } from '@medlevo/shared';
import { LOCAL_SCHEMA, MedLevoDB, outboxTarget } from '../../src/lib/localdb';
import { SyncEngine, type SyncTransport } from '../../src/lib/sync';

const names: string[] = [];
afterEach(async () => {
  for (const n of names.splice(0)) await Dexie.delete(n);
});

/** The previous build's database class: only the v1 + v2 schema. */
function previousBuild(name: string): Dexie {
  const d = new Dexie(name);
  for (const v of LOCAL_SCHEMA.filter((s) => s.version <= 2)) d.version(v.version).stores(v.stores);
  return d;
}

describe('an old tab (schema v2) next to the upgraded database (v3)', () => {
  it('opens the v3 database, writes its outbox op, and the new code pushes it to the vault', async () => {
    const name = `old-tab-${newId()}`;
    names.push(name);
    const fresh = new MedLevoDB(name);
    await fresh.open();
    expect(fresh.verno).toBe(3);
    fresh.close();

    const old = previousBuild(name);
    await old.open(); // no VersionError
    await old.transaction('rw', old.table('notes'), old.table('outbox'), async () => {
      await old.table('notes').put({ id: 'N-OLD', body: { v: 1, paragraphs: [] }, updatedAt: 1, syncState: 'pending_sync', rev: null });
      await old.table('outbox').add({
        op_id: 'op-old-tab',
        entity_type: 'note',
        entity_id: 'N-OLD',
        op: 'upsert',
        payload: { id: 'N-OLD' },
        client_ts: 1,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: 0,
        sentAt: null,
        lastError: null,
      });
    });
    old.close();

    const db = new MedLevoDB(name);
    await db.open();
    expect(db.verno).toBe(3);
    const op = (await db.outbox.where('op_id').equals('op-old-tab').first())!;
    expect(outboxTarget(op)).toBe('vault');
    const pushed: string[] = [];
    const transport: SyncTransport = {
      async push(req: SyncPushRequest): Promise<SyncOpResult[]> {
        pushed.push(...req.ops.map((o) => o.op_id));
        return req.ops.map((o) => ({ op_id: o.op_id, result: 'applied' }));
      },
      async pull(since: number): Promise<SyncPullResponse> {
        return { changes: [], next_since: since, has_more: false };
      },
    };
    const engine = new SyncEngine({ db, transport, now: () => 10, random: () => 0.5, locks: null, deviceId: 'dev', isOnline: () => true });
    await engine.pushOnce();
    expect(pushed).toEqual(['op-old-tab']);
    // the new tables are still there for the new code
    expect(await db.layers.count()).toBe(0);
    db.close();
  });
});
