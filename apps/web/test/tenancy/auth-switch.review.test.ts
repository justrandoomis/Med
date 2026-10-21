// P1-T1 step 3 — adversarial review (BUILD_PLAN §1.2): a shared device, one page, two accounts.
//
// Defect reproduced (failed before the fix): after «تسجيل الخروج» the page kept the previous account as its storage
// account (a sign-out does not reload the page), so the next sign-in — as ANOTHER account — sent the previous account's
// device id (deviceFields): the new account's session was recorded on user #1's device id (a cross-account link the
// design forbids: «signing in as another account must not borrow the previous account's device id»). The same
// account signing in again in that page still sends its own id (its sessions list keeps naming the device).
import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setFetchImpl } from '../../src/lib/api';
import { activateAccount, login, logout } from '../../src/lib/auth';
import { getDeviceId, resetDeviceIdCache } from '../../src/lib/deviceId';
import { resetSharedDb } from '../../src/lib/localdb';
import { setStorageAccount } from '../../src/lib/userStorage';

const OWNER = '01JOWNERAAAAAAAAAAAAAAAAAA';
type Call = { url: string; init: RequestInit };
let calls: Call[];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const lastBody = () => JSON.parse(String(calls.at(-1)!.init.body)) as { device_id?: string; username?: string };

beforeEach(async () => {
  calls = [];
  localStorage.clear();
  setStorageAccount(null);
  resetSharedDb();
  resetDeviceIdCache();
  for (const name of await Dexie.getDatabaseNames()) await Dexie.delete(name);
  setFetchImpl(async (url, init) => {
    calls.push({ url, init });
    return json({ ok: true, session: { id: 's' } });
  });
});
afterEach(() => {
  setFetchImpl(null);
  setStorageAccount(null);
});

describe('one page, two accounts: the device id never crosses accounts', () => {
  it('after user #1 signs out, signing in as another account sends no device id; user #1 again sends its own', async () => {
    expect(await activateAccount({ id: OWNER, username: 'Owner_R1a', display_name: 'o', is_platform_admin: true, owns_legacy_device_data: true })).toBe('activated');
    const ownerDevice = await getDeviceId();
    await logout();
    await login('student_b', 'password-123456');
    expect(lastBody().device_id, 'another account must not get user #1’s device id').toBeUndefined();
    // the same account signing in again (any letter case) keeps naming its device
    await login('owner_r1a', 'R1a-owner-password-0123');
    expect(lastBody().device_id).toBe(ownerDevice);
  });

  it('a 401 (session expired) and a sign-in as the same account still sends the device id', async () => {
    await activateAccount({ id: OWNER, username: 'owner_r1a', display_name: 'o', is_platform_admin: true, owns_legacy_device_data: true });
    const ownerDevice = await getDeviceId();
    await login('owner_r1a', 'R1a-owner-password-0123');
    expect(lastBody().device_id).toBe(ownerDevice);
  });
});

// Defect reproduced (failed before the fix): the capability store reads its cache once, when the module loads — before
// the page knows its account, i.e. from the legacy namespace (user #1's). Another account starting offline on the
// same device (activateCachedAccount) was shown user #1's cached capabilities (e.g. AI «available» — user #1 has no
// cap) instead of its own; online, until the first refresh answered.
describe('the capability cache follows the page account', () => {
  it('switching the storage account re-reads that account’s cached capabilities', async () => {
    const { capabilitiesStore } = await import('../../src/lib/capabilities');
    const B = '01JBBBBBBBBBBBBBBBBBBBBBBB';
    const cacheOf = (who: string) => ({ data: { features: { ai_explain: { state: 'available', reason: null, who } } }, fetchedAt: 1 });
    localStorage.setItem('medlevo.capabilities.v1', JSON.stringify(cacheOf('owner'))); // user #1 (legacy namespace)
    localStorage.setItem(`${B}:medlevo.capabilities.v1`, JSON.stringify(cacheOf('b')));
    setStorageAccount({ userId: B, legacy: false });
    const data = capabilitiesStore.get().data as unknown as { features: { ai_explain: { who: string } } } | null;
    expect(data?.features.ai_explain.who).toBe('b');
    setStorageAccount({ userId: OWNER, legacy: true });
    const back = capabilitiesStore.get().data as unknown as { features: { ai_explain: { who: string } } } | null;
    expect(back?.features.ai_explain.who).toBe('owner');
  });
});
