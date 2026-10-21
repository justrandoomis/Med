// P1-T1 step 3 — one local database per account (ADR-0003 §3.7 and §5 step 8; ARCHITECTURE_DELTA §4.5, §8.7):
//   * getDb() follows the page's account: `medlevo:<id>`; the legacy `medlevo` before the sign-in state is known and
//     for user #1 once it claimed it (zero copy: the R1-a database is used where it is, with its outbox);
//   * only user #1 (owns_legacy_device_data) claims; another account on the owner's device never opens the legacy
//     database, so the owner's queued writes are never pushed under its session; a claim made by one account (or a
//     legacy database marked by another) is never taken over;
//   * when the page's account changes, the previous account's sync engine stops and its outbox stays in its own database
//     (pushed again only when that account signs in); the new engine pushes only the new account's ops — with the
//     version and account headers;
//   * activateAccount asks for a reload when the page had already opened another account's data.
import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId, type SyncPushRequest } from '@medlevo/shared';
import { setFetchImpl } from '../../src/lib/api';
import { activateAccount } from '../../src/lib/auth';
import { claimLegacyLocalData, currentLocalDbName, getDb, kvGet, LEGACY_OWNER_KV, LOCAL_DB_NAME, MedLevoDB, openedLocalDbName, resetSharedDb, type NoteRow } from '../../src/lib/localdb';
import { getSyncEngine, writeAndEnqueue } from '../../src/lib/sync';
import { legacyClaimHolder, setStorageAccount } from '../../src/lib/userStorage';

const OWNER = '01JOWNERAAAAAAAAAAAAAAAAAA';
const B = '01JBBBBBBBBBBBBBBBBBBBBBBB';
const C = '01JCCCCCCCCCCCCCCCCCCCCCCC';

function note(text: string): NoteRow {
  return { id: newId(), updatedAt: Date.now(), syncState: 'pending_sync', body: { v: 1, paragraphs: [{ dir: 'rtl', runs: [{ t: text }] }] }, rev: null };
}

/** an R1-a device: the legacy database with a note and its op still in the outbox */
async function legacyDeviceWithOutbox(): Promise<string> {
  const legacy = new MedLevoDB(LOCAL_DB_NAME);
  await legacy.open();
  const n = note('كتبتها قبل الترقية ولم تُرسل');
  await writeAndEnqueue(legacy, legacy.notes, n, { entity_type: 'note', op: 'upsert' });
  legacy.close();
  return n.id;
}

beforeEach(async () => {
  localStorage.clear();
  setStorageAccount(null);
  resetSharedDb();
  for (const name of await Dexie.getDatabaseNames()) await Dexie.delete(name);
});
afterEach(() => {
  getSyncEngine().stop();
  setFetchImpl(null);
  setStorageAccount(null);
});

describe('the database name follows the account', () => {
  it('legacy before sign-in; medlevo:<id> for an account; the legacy name for user #1 with its claim', () => {
    expect(currentLocalDbName()).toBe(LOCAL_DB_NAME);
    setStorageAccount({ userId: B, legacy: false });
    expect(getDb().name).toBe(`medlevo:${B}`);
    setStorageAccount({ userId: OWNER, legacy: true });
    expect(getDb().name).toBe('medlevo');
    expect(openedLocalDbName()).toBe('medlevo');
  });
});

describe('the legacy claim (ADR-0003 §5 step 8)', () => {
  it('user #1 claims the R1-a database in place (marked, recorded) — its unsent outbox is still there', async () => {
    const noteId = await legacyDeviceWithOutbox();
    expect(await claimLegacyLocalData(OWNER)).toBe(true);
    expect(legacyClaimHolder()).toBe(OWNER);
    const db = new MedLevoDB(LOCAL_DB_NAME);
    expect(await kvGet(db, LEGACY_OWNER_KV)).toBe(OWNER);
    expect(await db.outbox.where('entity_id').equals(noteId).count()).toBe(1);
    db.close();
    // idempotent for the same account; refused to anyone else afterwards
    expect(await claimLegacyLocalData(OWNER)).toBe(true);
    expect(await claimLegacyLocalData(C)).toBe(false);
  });

  it('a legacy database marked by another account (a deployment set up again) is not claimed', async () => {
    await legacyDeviceWithOutbox();
    const db = new MedLevoDB(LOCAL_DB_NAME);
    await db.kv.put({ key: LEGACY_OWNER_KV, value: 'SOMEONE_ELSE', updatedAt: 1 });
    db.close();
    expect(await claimLegacyLocalData(OWNER)).toBe(false);
    expect(legacyClaimHolder()).toBeNull();
  });

  it('activateAccount: user #1 opens the legacy data; another account gets its own database and never claims', async () => {
    const noteId = await legacyDeviceWithOutbox();
    expect(await activateAccount({ id: B, username: 'b', display_name: 'b', is_platform_admin: false, owns_legacy_device_data: false })).toBe('activated');
    expect(getDb().name).toBe(`medlevo:${B}`);
    expect(legacyClaimHolder()).toBeNull();
    const legacy = new MedLevoDB(LOCAL_DB_NAME);
    expect(await kvGet(legacy, LEGACY_OWNER_KV)).toBeUndefined();
    expect(await legacy.outbox.where('entity_id').equals(noteId).count()).toBe(1);
    legacy.close();
    // the page now holds B's database: signing in as the owner in this page reloads it
    expect(await activateAccount({ id: OWNER, username: 'o', display_name: 'o', is_platform_admin: true, owns_legacy_device_data: true })).toBe('reload');
  });

  it('activateAccount asks for a reload when the page had opened the legacy database before another account signs in', async () => {
    getDb(); // pre-sign-in screens opened the legacy database
    expect(openedLocalDbName()).toBe(LOCAL_DB_NAME);
    expect(await activateAccount({ id: B, username: 'b', display_name: 'b', is_platform_admin: false })).toBe('reload');
  });
});

describe('outboxes never cross accounts (ARCHITECTURE_DELTA §8.7)', () => {
  it('another account on the owner device: the owner’s queued op is never pushed; the account’s own op is, with its headers', async () => {
    const ownerNote = await legacyDeviceWithOutbox();
    const pushes: Array<{ body: SyncPushRequest; headers: Record<string, string> }> = [];
    setFetchImpl(async (url, init) => {
      if (url.startsWith('/api/sync/push')) {
        const body = JSON.parse(String(init.body)) as SyncPushRequest;
        pushes.push({ body, headers: init.headers as Record<string, string> });
        return new Response(JSON.stringify({ results: body.ops.map((o) => ({ op_id: o.op_id, result: 'applied' })), server_seq: 1 }), { status: 200 });
      }
      return new Response(JSON.stringify({ changes: [], next_since: 0, has_more: false }), { status: 200 });
    });
    await activateAccount({ id: B, username: 'b', display_name: 'b', is_platform_admin: false, owns_legacy_device_data: false });
    const mine = note('ملاحظة الحساب الثاني');
    await writeAndEnqueue(getDb(), getDb().notes, mine, { entity_type: 'note', op: 'upsert' });
    await getSyncEngine().pushOnce();
    const pushed = pushes.flatMap((p) => p.body.ops.map((o) => o.entity_id));
    expect(pushed).toContain(mine.id);
    expect(pushed).not.toContain(ownerNote);
    expect(pushes[0]!.headers['x-medlevo-user']).toBe(B);
    expect(pushes[0]!.headers['x-medlevo-client']).toMatch(/^\d+\.\d+/);
  });

  it('switching the page to another account stops the previous engine; its outbox stays frozen in its database', async () => {
    const pushes: string[] = [];
    setFetchImpl(async (url, init) => {
      if (url.startsWith('/api/sync/push')) {
        const body = JSON.parse(String(init.body)) as SyncPushRequest;
        pushes.push(...body.ops.map((o) => o.entity_id));
        return new Response(JSON.stringify({ results: body.ops.map((o) => ({ op_id: o.op_id, result: 'applied' })), server_seq: 1 }), { status: 200 });
      }
      return new Response(JSON.stringify({ changes: [], next_since: 0, has_more: false }), { status: 200 });
    });
    setStorageAccount({ userId: C, legacy: false });
    const cEngine = getSyncEngine();
    const cDb = getDb();
    const cNote = note('حساب ج');
    await writeAndEnqueue(cDb, cDb.notes, cNote, { entity_type: 'note', op: 'upsert' });
    // another account signs in on this page before C's op was sent
    setStorageAccount({ userId: B, legacy: false });
    const bEngine = getSyncEngine();
    expect(bEngine).not.toBe(cEngine);
    expect(bEngine.db.name).toBe(`medlevo:${B}`);
    await bEngine.pushOnce();
    expect(pushes).not.toContain(cNote.id);
    const frozen = new MedLevoDB(`medlevo:${C}`);
    expect(await frozen.outbox.where('entity_id').equals(cNote.id).first()).toMatchObject({ status: 'pending' });
    frozen.close();
  });
});
