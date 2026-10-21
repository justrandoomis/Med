// P1-T1 step 1 — adversarial review (BUILD_PLAN §1.2). Each case failed before its fix.
//   1. A session whose account cannot be used right now (its vault is locked / being deleted / missing) was a dead end:
//      EVERY request — /api/auth/status, sign-out, even signing in as somebody else on that browser — answered 401
//      «sign in again», so a shared browser could neither sign out nor hand over to another student.
//   2. The job index (system DB) could lose sight of a queued job that lives in a vault: a job enqueued between the
//      system-DB snapshot and the vault snapshots of a backup (restore), or met while its vault was locked
//      («unavailable»), was never run again — nothing reconciled the index with the vault.
import { rmSync } from 'node:fs';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app';
import type { AppContext } from '../../src/context';
import { MODULES, type ModuleEntry } from '../../src/modules';
import { type AuthHeaders, createClock, CSRF, sessionCookie, type TestApp, createTestApp, OWNER } from '../helpers/app';
import { processTemplateDir } from '../helpers/template';
import { addUser, type ExtraUser } from '../helpers/tenancy';
import { newId } from '../../src/lib/ids';
import { push, rt } from '../learning/helpers';

const T0 = Date.UTC(2026, 9, 9, 12, 0, 0);

const runs: string[] = [];
const probe: ModuleEntry = {
  name: 'treview',
  prefix: '/api/treview',
  plugin: async (app, { ctx }) => {
    ctx.jobs.register<{ tag: string }, { ok: true }>('treview_job', {
      version: 'treview-1',
      inputSchema: z.object({ tag: z.string().max(40) }),
      handler: async (run) => {
        runs.push(`${run.input.tag}@${ctx.binding.current()?.kind === 'vault' ? (ctx.binding.current() as { vaultId: string }).vaultId : '?'}`);
        return { ok: true };
      },
    });
    app.post('/job', async (req) => ctx.jobs.enqueue('treview_job', { tag: (req.body as { tag: string }).tag }));
  },
};
const MODS = [...MODULES, probe];

const drainLikeTheWorker = (ctx: AppContext) => ctx.binding.runRoot(() => ctx.jobs.drain());

describe('a session whose vault is not usable right now', () => {
  let t: TestApp;
  let b: ExtraUser;
  beforeAll(async () => {
    t = await createTestApp();
    await t.login();
    b = await addUser(t, 'student-locked');
  }, 120_000);
  afterAll(async () => {
    await t?.close();
  });
  const lock = (status: 'locked' | 'active') => t.ctx.system.db.run('UPDATE vault SET status = ? WHERE id = ?', [status, b.vault.id]);

  it('can read the sign-in state, sign out, and hand the browser to another account; its own sign-in says why it is refused', async () => {
    const hB = await b.login();
    const sessionB = t.ctx.system.db.get<{ id: string }>('SELECT id FROM auth_session WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1', [b.user.id])!.id;
    lock('locked');
    try {
      // private routes: 401 with the honest reason (no database is opened)
      const tree = await t.app.inject({ method: 'GET', url: '/api/library/tree', headers: hB });
      expect(tree.statusCode).toBe(401);
      expect(tree.json().error.message).toContain('غير متاح');

      // the sign-in state: not usable now (the web client shows the sign-in screen instead of looping on 401s)
      const st = await t.app.inject({ method: 'GET', url: '/api/auth/status', headers: hB });
      expect(st.statusCode, st.body).toBe(200);
      expect(st.json().authenticated).toBe(false);

      // signing in again as the same account is refused with the reason — after the password was checked
      const again = await t.app.inject({ method: 'POST', url: '/api/auth/login', headers: { ...CSRF, 'user-agent': 'vitest' }, payload: { username: 'student-locked', password: b.password } });
      expect(again.statusCode).toBe(401);
      expect(again.json().error.message).toContain('غير متاح');
      expect(t.ctx.system.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM auth_session WHERE user_id = ? AND revoked_at IS NULL', [b.user.id])!.n).toBe(1);

      // another student signs in on the same browser: works, and the locked account's session on it is retired
      const other = await t.app.inject({ method: 'POST', url: '/api/auth/login', headers: { ...hB, 'user-agent': 'vitest' }, payload: OWNER });
      expect(other.statusCode, other.body).toBe(200);
      expect(t.ctx.system.db.get<{ revoked_at: number | null }>('SELECT revoked_at FROM auth_session WHERE id = ?', [sessionB])!.revoked_at).not.toBeNull();
    } finally {
      lock('active');
    }
  });

  it('sign-out works while the vault is locked (shared browser), and the account works again once its vault is active', async () => {
    const hB = await b.login();
    lock('locked');
    try {
      const out = await t.app.inject({ method: 'POST', url: '/api/auth/logout', headers: hB });
      expect(out.statusCode, out.body).toBe(200);
      expect(String(out.headers['set-cookie'] ?? '')).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/i);
    } finally {
      lock('active');
    }
    const after = await t.app.inject({ method: 'GET', url: '/api/library/tree', headers: hB });
    expect(after.statusCode).toBe(401); // that session was signed out
    const fresh = await b.login();
    expect((await t.app.inject({ method: 'GET', url: '/api/library/tree', headers: fresh })).statusCode).toBe(200);
  });
});

describe('sync feeds, op replay and spaced repetition stay per account (AOS-11.27, 14.11, 21.27, 21.28, 21.29)', () => {
  let t: TestApp;
  let A: { app: TestApp['app']; h: AuthHeaders; ctx: AppContext };
  let B: { app: TestApp['app']; h: AuthHeaders; ctx: AppContext };
  let vaultA: string;
  let vaultB: string;
  beforeAll(async () => {
    t = await createTestApp();
    A = { app: t.app, h: await t.login(), ctx: t.ctx };
    const b = await addUser(t, 'student-sync');
    B = { app: t.app, h: await b.login(), ctx: t.ctx };
    vaultA = (t.ownerBinding() as { vaultId: string }).vaultId;
    vaultB = b.vault.id;
  }, 120_000);
  afterAll(async () => {
    await t?.close();
  });
  const inVault = <T>(vaultId: string, fn: () => T) => t.ctx.binding.run({ kind: 'vault', vaultId, viewer: null }, fn);
  const card = (id: string, front: string) => ({ id, kind: 'basic', front: rt(front), back: rt('back'), origin: 'owner', suspended: false, updatedAt: T0, syncState: 'pending_sync', createdAt: T0 });

  it('a pull never returns another account’s rows; a replayed op id never returns another account’s result; reviews stay in their own vault', async () => {
    const noteA = newId();
    const cardA = newId();
    const cardB = newId();
    const sharedOpId = newId(); // the same client op id used by both accounts (e.g. two devices with a colliding clock)
    const ra = await push(A, [
      { op_id: sharedOpId, entity_type: 'note', entity_id: noteA, op: 'upsert', payload: { body: rt('ملاحظة خاصة بالمستخدم أ') } },
      { entity_type: 'flashcard', entity_id: cardA, op: 'upsert', payload: card(cardA, 'A private card') },
      { entity_type: 'review_event', entity_id: newId(), op: 'append', payload: { cardId: cardA, rating: 3, reviewedAt: T0 } },
    ]);
    expect(ra.map((r) => r.result)).toEqual(['applied', 'applied', 'applied']);
    // B replays A's op id with B's own content: B gets B's own result, never A's note
    const rb = await push(B, [
      { op_id: sharedOpId, entity_type: 'flashcard', entity_id: cardB, op: 'upsert', payload: card(cardB, 'B private card') },
      { entity_type: 'review_event', entity_id: newId(), op: 'append', payload: { cardId: cardB, rating: 1, reviewedAt: T0 } },
    ]);
    expect(rb.map((r) => r.result)).toEqual(['applied', 'applied']);
    expect(JSON.stringify(rb)).not.toContain(noteA);
    // pulls: each sees only its own entities
    const pullA = (await t.app.inject({ method: 'GET', url: '/api/sync/pull?since=0&limit=1000', headers: A.h })).json() as { changes: Array<{ entity_id: string }> };
    const pullB = (await t.app.inject({ method: 'GET', url: '/api/sync/pull?since=0&limit=1000', headers: B.h })).json() as { changes: Array<{ entity_id: string }> };
    const idsA = new Set(pullA.changes.map((c) => c.entity_id));
    const idsB = new Set(pullB.changes.map((c) => c.entity_id));
    expect(idsA.has(noteA) && idsA.has(cardA)).toBe(true);
    expect(idsA.has(cardB)).toBe(false);
    expect(idsB.has(cardB)).toBe(true);
    expect(idsB.has(noteA) || idsB.has(cardA)).toBe(false);
    expect(JSON.stringify(pullB)).not.toContain('A private card');
    // FSRS state: each vault holds only its own card and review events
    expect(inVault(vaultA, () => t.ctx.db.all<{ id: string }>('SELECT id FROM flashcard').map((r) => r.id))).toEqual([cardA]);
    expect(inVault(vaultB, () => t.ctx.db.all<{ id: string }>('SELECT id FROM flashcard').map((r) => r.id))).toEqual([cardB]);
    expect(inVault(vaultA, () => t.ctx.db.all<{ card_id: string }>('SELECT card_id FROM review_event').map((r) => r.card_id))).toEqual([cardA]);
    expect(inVault(vaultB, () => t.ctx.db.all<{ card_id: string }>('SELECT card_id FROM review_event').map((r) => r.card_id))).toEqual([cardB]);
  });
});

describe('storage report honesty with several accounts (one shared file store)', () => {
  let t: TestApp;
  let hA: AuthHeaders;
  beforeAll(async () => {
    t = await createTestApp();
    hA = await t.login();
    const b = await addUser(t, 'student-files');
    // B's file: in B's vault (and in every whole-instance backup), never in the admin's
    await t.ctx.binding.run({ kind: 'vault', vaultId: b.vault.id, viewer: null }, () => t.ctx.files.put(Buffer.alloc(32 * 1024, 7), { mime: 'application/pdf', originalName: 'b.pdf' }));
  }, 120_000);
  afterAll(async () => {
    await t?.close();
  });

  it('the platform admin is not told another account’s files are unregistered leftovers missing from backups', async () => {
    const r = await t.app.inject({ method: 'GET', url: '/api/control/storage', headers: hA });
    expect(r.statusCode).toBe(200);
    const notes = (r.json() as { notes_ar: string[] }).notes_ar.join('\n');
    expect(notes).not.toContain('لا تدخل في النسخ الاحتياطية');
    expect(notes).toContain('مشترك');
  });
});

describe('the job index never loses a queued job of a vault', () => {
  let t: TestApp;
  let hB: AuthHeaders;
  let b: ExtraUser;
  beforeAll(async () => {
    t = await createTestApp({ modules: MODS });
    await t.login();
    b = await addUser(t, 'student-jobs');
    hB = await b.login();
  }, 120_000);
  afterAll(async () => {
    await t?.close();
  });

  it('a job met while its vault was locked («unavailable») runs once the vault is active again (the heartbeat re-checks)', async () => {
    const r = await t.app.inject({ method: 'POST', url: '/api/treview/job', headers: hB, payload: { tag: 'was-locked' } });
    expect(r.statusCode, r.body).toBe(200);
    const id = (r.json() as { id: string }).id;
    t.ctx.system.db.run(`UPDATE vault SET status = 'locked' WHERE id = ?`, [b.vault.id]);
    await drainLikeTheWorker(t.ctx);
    expect(runs.filter((x) => x.startsWith('was-locked@'))).toEqual([]);
    expect(t.ctx.system.db.get<{ status: string }>('SELECT status FROM job_index WHERE job_id = ?', [id])!.status).toBe('unavailable');
    t.ctx.system.db.run(`UPDATE vault SET status = 'active' WHERE id = ?`, [b.vault.id]);
    t.ctx.binding.runRoot(() => t.ctx.jobs.requeueStale()); // what the heartbeat runs
    await drainLikeTheWorker(t.ctx);
    expect(runs.filter((x) => x.startsWith('was-locked@'))).toEqual([`was-locked@${b.vault.id}`]);
  });

  it('after a restart, a queued job missing from the index (a backup snapshot window) is indexed when its vault opens, and runs once', async () => {
    const r = await t.app.inject({ method: 'POST', url: '/api/treview/job', headers: hB, payload: { tag: 'not-indexed' } });
    const id = (r.json() as { id: string }).id;
    // the restored system DB was snapshotted before this job existed: no index row
    t.ctx.system.db.run('DELETE FROM job_index WHERE job_id = ?', [id]);
    await drainLikeTheWorker(t.ctx);
    expect(runs.filter((x) => x.startsWith('not-indexed@'))).toEqual([]);

    // restart on the same data directory (as after a restore), the student opens the app
    await t.app.close();
    const app2 = await buildApp({ config: t.config, overrides: { clock: createClock(), aiProvider: null, templateDir: processTemplateDir() }, modules: MODS });
    try {
      await app2.ready();
      // background work enqueues in B's vault as the very FIRST access of this process: the index row is written
      // before the job row, and the open (with its reconciliation) happens during that enqueue — the entry must stay
      const first = app2.ctx.binding.run({ kind: 'vault', vaultId: b.vault.id, viewer: null }, () => app2.ctx.jobs.enqueue('treview_job', { tag: 'first-open' }));
      expect(app2.ctx.system.db.get<{ status: string }>('SELECT status FROM job_index WHERE job_id = ?', [first.id])?.status).toBe('queued');
      const login = await app2.inject({ method: 'POST', url: '/api/auth/login', headers: { ...CSRF, 'user-agent': 'vitest' }, payload: { username: 'student-jobs', password: b.password } });
      expect(login.statusCode, login.body).toBe(200);
      const tree = await app2.inject({ method: 'GET', url: '/api/library/tree', headers: { cookie: sessionCookie(login), ...CSRF } });
      expect(tree.statusCode).toBe(200);
      expect(app2.ctx.system.db.get<{ status: string }>('SELECT status FROM job_index WHERE job_id = ?', [id])?.status).toBe('queued');
      await drainLikeTheWorker(app2.ctx);
      await drainLikeTheWorker(app2.ctx);
      expect(runs.filter((x) => x.startsWith('not-indexed@'))).toEqual([`not-indexed@${b.vault.id}`]);
      expect(runs.filter((x) => x.startsWith('first-open@'))).toEqual([`first-open@${b.vault.id}`]);
    } finally {
      await app2.close();
      rmSync(t.dataDir, { recursive: true, force: true });
    }
  });
});
