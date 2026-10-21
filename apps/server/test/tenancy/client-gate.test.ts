// P1-T1 step 3 — the client-version gate and the session-user check (ARCHITECTURE_DELTA §4.5, §8.7; ADR-0003 §3.7):
// a pre-multi-user client (no `x-medlevo-client`, every client of R1-a) may write or pull data only as user #1, whose
// single-owner local data it holds; as any other account it gets 426 CLIENT_TOO_OLD and NOTHING is applied — so a
// stale tab can never push the owner's outbox under another account's session. A page naming another account than the
// session's (`x-medlevo-user`, two tabs of one browser) gets 401 and nothing is applied.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compareClientVersions, isSupportedClientVersion, newId, type AuthStatusResponse } from '@medlevo/shared';
import { createTestApp, CSRF, sessionCookie, type AuthHeaders, type TestApp } from '../helpers/app';
import { addUser, type ExtraUser } from '../helpers/tenancy';

const OLD = { 'x-medlevo-csrf': '1' } as const; // what an R1-a client sends on a write: CSRF only, no version
let t: TestApp;
let owner: AuthHeaders;
let b: ExtraUser;
let bh: AuthHeaders;

const noteOp = (text: string) => ({
  op_id: newId(),
  device_id: 'OLD_TAB_DEVICE',
  entity_type: 'note',
  entity_id: newId(),
  op: 'upsert',
  base_rev: null,
  payload: { title: null, body: { v: 1, paragraphs: [{ dir: 'rtl', runs: [{ t: text }] }] }, anchor: null, origin: 'owner' },
});
const notesOf = (vaultId: string) => t.ctx.binding.run({ kind: 'vault', vaultId, viewer: null }, () => t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM note')!.n);

beforeAll(async () => {
  t = await createTestApp();
  owner = await t.login();
  b = await addUser(t, 'student_b');
  bh = await b.login();
});
afterAll(async () => t.close());

describe('version comparison', () => {
  it('compares dotted versions; a missing, malformed or older version is not supported', () => {
    expect(compareClientVersions('0.1.0', '0.1.0')).toBe(0);
    expect(compareClientVersions('0.2', '0.1.9')).toBe(1);
    expect(compareClientVersions('0.1.0-beta', '0.1.0')).toBe(0);
    expect(isSupportedClientVersion(undefined)).toBe(false);
    expect(isSupportedClientVersion('')).toBe(false);
    expect(isSupportedClientVersion('web')).toBe(false);
    expect(isSupportedClientVersion('0.0.9')).toBe(false);
    expect(isSupportedClientVersion('0.1.0')).toBe(true);
    expect(isSupportedClientVersion('1.4.2')).toBe(true);
  });
});

describe('an R1-a client (no x-medlevo-client)', () => {
  it('works for user #1 — the owner whose local data it holds (push and pull)', async () => {
    const before = notesOf(t.ctx.tenancy.platformVaultBinding()!.vaultId);
    const push = await t.app.inject({ method: 'POST', url: '/api/sync/push', headers: { cookie: owner.cookie, ...OLD }, payload: { ops: [noteOp('من التبويب القديم للمالك')] } });
    expect(push.statusCode, push.body).toBe(200);
    expect(push.json().results[0].result).toBe('applied');
    expect(notesOf(t.ctx.tenancy.platformVaultBinding()!.vaultId)).toBe(before + 1);
    const pull = await t.app.inject({ method: 'GET', url: '/api/sync/pull?since=0', headers: { cookie: owner.cookie, accept: 'application/json' } });
    expect(pull.statusCode).toBe(200);
  });

  it('is refused (426) under another account: no push applied, no pull, no JSON read — the owner outbox never lands there', async () => {
    const before = notesOf(b.vault.id);
    const push = await t.app.inject({ method: 'POST', url: '/api/sync/push', headers: { cookie: bh.cookie, ...OLD }, payload: { ops: [noteOp('دفع من تبويب قديم باسم حساب آخر')] } });
    expect(push.statusCode).toBe(426);
    expect(push.json().error.code).toBe('CLIENT_TOO_OLD');
    expect(push.json().error.message).toContain('تحديث');
    expect(notesOf(b.vault.id)).toBe(before);
    const pull = await t.app.inject({ method: 'GET', url: '/api/sync/pull?since=0', headers: { cookie: bh.cookie, accept: 'application/json' } });
    expect(pull.statusCode).toBe(426);
    const tree = await t.app.inject({ method: 'GET', url: '/api/library/tree', headers: { cookie: bh.cookie, accept: 'application/json, text/plain, */*' } });
    expect(tree.statusCode).toBe(426);
    // what the browser loads by itself (images, audio, downloads) carries no JSON Accept and is not a client write
    const img = await t.app.inject({ method: 'GET', url: '/api/library/tree', headers: { cookie: bh.cookie, accept: 'image/avif,image/webp,*/*' } });
    expect(img.statusCode).toBe(200);
    // an older version than the minimum is refused the same way
    const older = await t.app.inject({ method: 'POST', url: '/api/sync/push', headers: { cookie: bh.cookie, 'x-medlevo-csrf': '1', 'x-medlevo-client': '0.0.9' }, payload: { ops: [noteOp('x')] } });
    expect(older.statusCode).toBe(426);
  });

  it('may sign in only as user #1 — another account gets 426 and no session', async () => {
    const asB = await t.app.inject({ method: 'POST', url: '/api/auth/login', headers: { ...OLD, 'user-agent': 'old-tab' }, payload: { username: 'student_b', password: b.password } });
    expect(asB.statusCode).toBe(426);
    expect(asB.headers['set-cookie']).toBeUndefined();
    const asOwner = await t.app.inject({ method: 'POST', url: '/api/auth/login', headers: { ...OLD, 'user-agent': 'old-tab' }, payload: { username: 'owner', password: 'test-password-123' } });
    expect(asOwner.statusCode).toBe(200);
    expect(sessionCookie(asOwner)).toMatch(/^medlevo_session=/);
  });

  it('can still read health and status, sign out and recover', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/health', headers: { accept: 'application/json' } })).statusCode).toBe(200);
    const status = await t.app.inject({ method: 'GET', url: '/api/auth/status', headers: { cookie: bh.cookie, accept: 'application/json' } });
    expect(status.statusCode).toBe(200);
    const other = await b.login();
    expect((await t.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: other.cookie, ...OLD } })).statusCode).toBe(200);
  });
});

describe('two tabs, one cookie: the page names its account (x-medlevo-user)', () => {
  it('a request naming another account than the session is refused with 401 and nothing applied; the right name passes', async () => {
    const before = notesOf(b.vault.id);
    const ownerId = t.ctx.system.users.findForAuth('owner')!.id;
    // tab of the owner, but the browser's cookie now belongs to student_b (signed in in another tab)
    const wrong = await t.app.inject({ method: 'POST', url: '/api/sync/push', headers: { ...bh, 'x-medlevo-user': ownerId }, payload: { ops: [noteOp('من تبويب المالك بعد دخول حساب آخر')] } });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error.details).toEqual({ session_user_changed: true });
    expect(notesOf(b.vault.id)).toBe(before);
    const right = await t.app.inject({ method: 'POST', url: '/api/sync/push', headers: { ...bh, 'x-medlevo-user': b.user.id }, payload: { ops: [noteOp('ملاحظتي')] } });
    expect(right.statusCode).toBe(200);
    expect(notesOf(b.vault.id)).toBe(before + 1);
    // the status route still answers (the page learns who is signed in and reloads)
    const status = await t.app.inject({ method: 'GET', url: '/api/auth/status', headers: { ...bh, 'x-medlevo-user': ownerId } });
    expect(status.statusCode).toBe(200);
    expect((status.json() as AuthStatusResponse).user?.id).toBe(b.user.id);
  });
});

describe('who owns the data a device kept from before accounts', () => {
  it('status and /me say user #1 (the owner) owns it; nobody else does', async () => {
    const s1 = (await t.app.inject({ method: 'GET', url: '/api/auth/status', headers: owner })).json() as AuthStatusResponse;
    expect(s1.user?.owns_legacy_device_data).toBe(true);
    const s2 = (await t.app.inject({ method: 'GET', url: '/api/auth/status', headers: bh })).json() as AuthStatusResponse;
    expect(s2.user?.owns_legacy_device_data).toBe(false);
    const me = (await t.app.inject({ method: 'GET', url: '/api/accounts/me', headers: bh })).json() as { owns_legacy_device_data: boolean; legacy_owner: boolean };
    expect(me).toMatchObject({ owns_legacy_device_data: false, legacy_owner: false });
    expect(CSRF['x-medlevo-client']).toBe('0.1.0');
  });
});
