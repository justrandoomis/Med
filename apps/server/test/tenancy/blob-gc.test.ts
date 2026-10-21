// P1-T1 step 2 — the blob registry and the mark-and-sweep GC (BUILD_PLAN §3.3 «test/tenancy/blob-gc.test.ts»;
// ARCHITECTURE_DELTA §4.1 `2250_ops`, ADR-0003 §3.3). Bytes shared by several databases are deleted only by the sweep:
// two sweeps at least 7 days apart, then 30 days in quarantine, then a fresh mark that still misses the blob. Covers
// the crash between a stored_file insert and its hint, a vault restored from an older copy, references made while a
// sweep runs, upload sessions in flight, a database that cannot be read (fail closed), files the registry never knew,
// and the mark pass that rebuilds the hints.
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { removeStoredFileIfUnreferenced } from '../../src/modules/files/blobs';
import { DAY_MS } from '../../src/modules/files/gc';
import type { Binding } from '../../src/system/binding';
import { createTestApp, type TestApp } from '../helpers/app';
import { addUser } from '../helpers/tenancy';

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

const inVault = <T>(app: TestApp, vaultId: string, fn: () => T): T => app.ctx.binding.run({ kind: 'vault', vaultId, viewer: null }, fn);
const ownerVault = (app: TestApp) => (app.ownerBinding() as Extract<Binding, { kind: 'vault' }>).vaultId;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function twoUsers(o: Parameters<typeof createTestApp>[0] = {}) {
  t = await createTestApp(o);
  const a = ownerVault(t);
  const b = (await addUser(t, 'student-b')).vault.id;
  return { app: t, a, b };
}

async function putIn(app: TestApp, vaultId: string, bytes: Buffer, name = 'f.pdf') {
  return inVault(app, vaultId, () => app.ctx.files.put(bytes, { mime: 'application/pdf', originalName: name }));
}

const registry = (app: TestApp) => app.ctx.system.blobs;

describe('blob registry and hints', () => {
  it('every stored file registers its blob once, with one hint per database (refcount = databases)', async () => {
    const { app, a, b } = await twoUsers();
    const bytes = randomBytes(4096);
    const fa = await putIn(app, a, bytes);
    const fb = await putIn(app, b, bytes);
    expect(fa.sha256).toBe(sha(bytes));
    expect(fb.sha256).toBe(fa.sha256);
    expect(fa.id).not.toBe(fb.id); // each database has its own row (its authorisation)
    // AOS-3.6: uploading the bytes of another account's private file gives no hint that they exist anywhere
    expect(fb.deduplicated).toBe(false);
    const row = registry(app).getInternal(fa.sha256)!;
    expect(row).toMatchObject({ size: 4096, storage: 'local', orphaned_at: null, quarantined_at: null });
    expect(registry(app).hintCountInternal(fa.sha256)).toBe(2);
    // a second put of the same bytes in the same vault is the same row; the hint stays 1 for that vault
    await putIn(app, a, bytes);
    expect(registry(app).hintCountInternal(fa.sha256)).toBe(2);
  });

  it('with several databases, dropping a row clears only that hint and never the bytes the other vault reads', async () => {
    const { app, a, b } = await twoUsers();
    const bytes = randomBytes(2048);
    const fa = await putIn(app, a, bytes);
    const fb = await putIn(app, b, bytes);
    expect(inVault(app, a, () => removeStoredFileIfUnreferenced(app.ctx, fa.id))).toBe(true);
    expect(registry(app).hintCountInternal(fa.sha256)).toBe(1);
    expect(existsSync(app.ctx.blobs.localPath(fa.sha256))).toBe(true);
    const back = await inVault(app, b, () => app.ctx.files.read(fb.id));
    expect(back.equals(bytes)).toBe(true);
  });

  it('a single-database deployment keeps today\'s exact behaviour: the last row goes, the bytes and the registry row go with it', async () => {
    t = await createTestApp();
    const a = ownerVault(t);
    const f = await putIn(t, a, randomBytes(1000));
    expect(inVault(t, a, () => removeStoredFileIfUnreferenced(t!.ctx, f.id))).toBe(true);
    expect(existsSync(t.ctx.blobs.localPath(f.sha256))).toBe(false);
    expect(registry(t).getInternal(f.sha256)).toBeNull();
  });
});

describe('mark-and-sweep', () => {
  it('orphan → (≥ 7 days, second sweep) quarantine → (30 days, fresh mark) delete — never earlier', async () => {
    const { app, a, b } = await twoUsers();
    const bytes = randomBytes(3000);
    const f = await putIn(app, a, bytes);
    await putIn(app, b, randomBytes(10)); // B exists and has other files
    inVault(app, a, () => removeStoredFileIfUnreferenced(app.ctx, f.id));
    const path = app.ctx.blobs.localPath(f.sha256);
    const qPath = app.ctx.blobs.quarantinePath(f.sha256);

    app.clock.advance(60_000);
    const s1 = await app.ctx.gc.run('sweep');
    expect(s1).toMatchObject({ status: 'completed', orphaned: 1, quarantined: 0, deleted: 0 });
    expect(registry(app).getInternal(f.sha256)!.orphaned_at).not.toBeNull();
    expect(existsSync(path)).toBe(true);

    app.clock.advance(3 * DAY_MS); // too soon
    expect(await app.ctx.gc.run('sweep')).toMatchObject({ status: 'completed', quarantined: 0 });
    expect(existsSync(path)).toBe(true);

    app.clock.advance(5 * DAY_MS); // ≥ 7 days after the first sweep that found it
    expect(await app.ctx.gc.run('sweep')).toMatchObject({ status: 'completed', quarantined: 1, deleted: 0 });
    expect(existsSync(path)).toBe(false);
    expect(readFileSync(qPath).equals(bytes)).toBe(true);

    app.clock.advance(20 * DAY_MS); // quarantine not over
    expect(await app.ctx.gc.run('sweep')).toMatchObject({ deleted: 0 });
    expect(existsSync(qPath)).toBe(true);

    app.clock.advance(11 * DAY_MS);
    expect(await app.ctx.gc.run('sweep')).toMatchObject({ status: 'completed', deleted: 1 });
    expect(existsSync(qPath)).toBe(false);
    expect(registry(app).getInternal(f.sha256)).toBeNull();
  });

  it('crash between the stored_file insert and its hint (and its registry row): the next sweep keeps the blob and repairs both', async () => {
    const { app, a, b } = await twoUsers();
    const bytes = randomBytes(5000);
    const f = await putIn(app, a, bytes);
    await putIn(app, b, randomBytes(10));
    // the system-DB half never happened
    app.ctx.system.db.run('DELETE FROM blob_ref WHERE sha256 = ?', [f.sha256]);
    app.ctx.system.db.run('DELETE FROM blob WHERE sha256 = ?', [f.sha256]);
    for (let i = 0; i < 4; i++) {
      const s = await app.ctx.gc.run('sweep');
      expect(s.status).toBe('completed');
      app.clock.advance(10 * DAY_MS);
    }
    const row = registry(app).getInternal(f.sha256)!;
    expect(row).toMatchObject({ orphaned_at: null, quarantined_at: null });
    expect(registry(app).hintCountInternal(f.sha256)).toBe(1);
    expect((await inVault(app, a, () => app.ctx.files.read(f.id))).equals(bytes)).toBe(true);
  });

  it('a vault restored from an older copy references a quarantined blob again: the sweep puts the bytes back', async () => {
    const { app, a, b } = await twoUsers();
    const bytes = randomBytes(4000);
    const f = await putIn(app, a, bytes);
    await putIn(app, b, randomBytes(10));
    const vaultPath = app.ctx.pool.pathOf('vault', a);
    const older = `${vaultPath}.older`;
    inVault(app, a, () => app.ctx.db.exec(`VACUUM INTO '${older}'`)); // the «older backup» of A's vault
    inVault(app, a, () => removeStoredFileIfUnreferenced(app.ctx, f.id));
    app.clock.advance(60_000); // a blob created in the very millisecond a sweep starts is never orphaned by it
    await app.ctx.gc.run('sweep');
    app.clock.advance(8 * DAY_MS);
    expect(await app.ctx.gc.run('sweep')).toMatchObject({ quarantined: 1 });
    expect(existsSync(app.ctx.blobs.localPath(f.sha256))).toBe(false);

    // restore A's vault file from the older copy (the pool must let go of it first)
    expect(app.ctx.pool.close('vault', a)).toBe(true);
    for (const s of ['-wal', '-shm']) rmSync(`${vaultPath}${s}`, { force: true });
    copyFileSync(older, vaultPath);
    rmSync(older, { force: true });

    app.clock.advance(DAY_MS);
    expect(await app.ctx.gc.run('sweep')).toMatchObject({ status: 'completed', restored: 1, deleted: 0 });
    expect(registry(app).getInternal(f.sha256)).toMatchObject({ orphaned_at: null, quarantined_at: null });
    expect((await inVault(app, a, () => app.ctx.files.read(f.id))).equals(bytes)).toBe(true);
  });

  it('a blob quarantined and then uploaded again is kept, and the spare quarantine copy is dropped', async () => {
    const { app, a, b } = await twoUsers();
    const bytes = randomBytes(1500);
    const f = await putIn(app, a, bytes);
    await putIn(app, b, randomBytes(10));
    inVault(app, a, () => removeStoredFileIfUnreferenced(app.ctx, f.id));
    app.clock.advance(60_000);
    await app.ctx.gc.run('sweep');
    app.clock.advance(8 * DAY_MS);
    await app.ctx.gc.run('sweep');
    expect(existsSync(app.ctx.blobs.quarantinePath(f.sha256))).toBe(true);
    const again = await putIn(app, b, bytes); // B uploads the very same bytes
    expect((await inVault(app, b, () => app.ctx.files.read(again.id))).equals(bytes)).toBe(true);
    app.clock.advance(40 * DAY_MS);
    expect(await app.ctx.gc.run('sweep')).toMatchObject({ restored: 1, deleted: 0 });
    expect(existsSync(app.ctx.blobs.quarantinePath(f.sha256))).toBe(false);
    expect((await inVault(app, b, () => app.ctx.files.read(again.id))).equals(bytes)).toBe(true);
  });

  it('a reference made WHILE a sweep runs is marked in it (the blob is not orphaned)', async () => {
    const bytes = randomBytes(1200);
    let during: (() => Promise<void>) | null = null;
    const { app, a, b } = await twoUsers({ gc: { orphanGraceMs: 7 * DAY_MS, quarantineMs: 30 * DAY_MS, beforeDecide: async () => void (await during?.()) } });
    const f = await putIn(app, a, bytes);
    inVault(app, a, () => removeStoredFileIfUnreferenced(app.ctx, f.id)); // unreferenced everywhere now
    app.clock.advance(60_000);
    during = async () => {
      await putIn(app, b, bytes); // B uploads it between the mark and the decisions
    };
    const s = await app.ctx.gc.run('sweep');
    expect(s).toMatchObject({ status: 'completed', orphaned: 0 });
    expect(registry(app).getInternal(f.sha256)!.orphaned_at).toBeNull();
  });

  it('the content of an upload session in flight is never orphaned', async () => {
    const { app, a, b } = await twoUsers();
    const bytes = randomBytes(900);
    const f = await putIn(app, a, bytes);
    inVault(app, a, () => removeStoredFileIfUnreferenced(app.ctx, f.id));
    const viewer = { userId: app.ctx.system.vaults.byIdInternal(b)!.user_id, deviceId: null, isPlatformAdmin: false };
    app.ctx.system.uploads.create(viewer, { targetDb: b, sha256: f.sha256, size: 900, chunkSize: 512, mime: 'application/pdf', name: 'x.pdf', ttlMs: DAY_MS });
    app.clock.advance(60_000);
    expect(await app.ctx.gc.run('sweep')).toMatchObject({ status: 'completed', orphaned: 0 });
  });

  it('fails closed: a registered database that cannot be read makes the sweep incomplete and nothing is decided', async () => {
    const { app, a, b } = await twoUsers();
    const f = await putIn(app, a, randomBytes(700));
    await putIn(app, b, randomBytes(10));
    inVault(app, a, () => removeStoredFileIfUnreferenced(app.ctx, f.id));
    // B's vault file disappears (disk trouble) while B is still registered
    const bPath = app.ctx.pool.pathOf('vault', b);
    expect(app.ctx.pool.close('vault', b)).toBe(true);
    for (const s of ['', '-wal', '-shm']) rmSync(`${bPath}${s}`, { force: true });
    app.clock.advance(60_000);
    const s = await app.ctx.gc.run('sweep');
    expect(s.status).toBe('incomplete');
    expect(s.error).toMatch(/database file missing/);
    expect(registry(app).getInternal(f.sha256)!.orphaned_at).toBeNull();
    expect(existsSync(app.ctx.blobs.localPath(f.sha256))).toBe(true);
  });

  it('blob files the registry never knew are registered by a sweep and only orphaned by a later one', async () => {
    const { app, a } = await twoUsers();
    await putIn(app, a, randomBytes(10));
    const stray = randomBytes(333);
    const s = sha(stray);
    const p = app.ctx.blobs.localPath(s);
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(p.slice(0, p.lastIndexOf('/')), { recursive: true });
    writeFileSync(p, stray);
    app.clock.advance(60_000);
    expect(await app.ctx.gc.run('sweep')).toMatchObject({ registered: 1, orphaned: 0 });
    app.clock.advance(60_000);
    expect(await app.ctx.gc.run('sweep')).toMatchObject({ orphaned: 1 });
  });

  it('a mark pass rebuilds every hint (after a restore) without deciding anything', async () => {
    const { app, a, b } = await twoUsers();
    const bytes = randomBytes(800);
    await putIn(app, a, bytes);
    await putIn(app, b, bytes);
    app.ctx.system.db.run('DELETE FROM blob_ref');
    const m = await app.ctx.gc.run('mark');
    expect(m).toMatchObject({ kind: 'mark', status: 'completed', orphaned: 0, quarantined: 0, deleted: 0 });
    expect(registry(app).hintCountInternal(sha(bytes))).toBe(2);
  });

  it('a second sweep requested while one runs gets the running one', async () => {
    const { app } = await twoUsers();
    const [x, y] = await Promise.all([app.ctx.gc.run('sweep'), app.ctx.gc.run('sweep')]);
    expect(x.id).toBe(y.id);
  });
});

describe('platform view of the blob store', () => {
  it('counts only, for the platform admin only; a sweep can be started on demand', async () => {
    const { app, b } = await twoUsers();
    const admin = await app.login();
    const student = await (await import('../helpers/tenancy')).addUser(app, 'student-c');
    const hs = await student.login();
    await putIn(app, b, randomBytes(100));
    const view = await app.app.inject({ method: 'GET', url: '/api/platform/blobs', headers: admin });
    expect(view.statusCode, view.body).toBe(200);
    expect(view.json()).toMatchObject({ registry: { blobs: 1, bytes: 100 }, object_store: { kind: 'local', pending_copies: 0 }, sweep: { running: false, schedule: '04:20' } });
    expect(view.json().policy_ar).toMatch(/30 يومًا/);
    expect(JSON.stringify(view.json())).not.toMatch(/[0-9a-f]{64}/); // never a content address or a file name
    expect((await app.app.inject({ method: 'GET', url: '/api/platform/blobs', headers: hs })).statusCode).toBe(404);
    expect((await app.app.inject({ method: 'POST', url: '/api/platform/blobs/sweep', headers: hs, payload: { kind: 'mark' } })).statusCode).toBe(404);
    const started = await app.app.inject({ method: 'POST', url: '/api/platform/blobs/sweep', headers: admin, payload: { kind: 'mark' } });
    expect(started.statusCode).toBe(202);
    for (let i = 0; i < 50 && registry(app).lastSweepsInternal(1)[0]?.status !== 'completed'; i++) await new Promise((r) => setTimeout(r, 20));
    expect(registry(app).lastSweepsInternal(1)[0]).toMatchObject({ kind: 'mark', status: 'completed' });
  });
});
