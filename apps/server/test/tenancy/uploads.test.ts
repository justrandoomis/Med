// P1-T1 step 2 — chunked, resumable uploads (ARCHITECTURE_DELTA §7.12). The whole file is announced (size + sha256),
// chunks arrive in any order, each checked against its own sha256, a broken connection resumes the same session, and
// nothing reaches the content-addressed store until the assembled file has the announced hash. Sessions are per user.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { UploadSessionView } from '@medlevo/shared';
import { type AuthHeaders, createTestApp, type TestApp } from '../helpers/app';
import { addUser } from '../helpers/tenancy';

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

const CHUNK = 64 * 1024;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function app() {
  t = await createTestApp({ env: { MEDLEVO_UPLOAD_CHUNK_MB: String(CHUNK / (1024 * 1024)) } });
  return { t, h: await t.login() };
}

const start = (a: TestApp, h: AuthHeaders, body: Buffer, extra: Record<string, unknown> = {}) =>
  a.app.inject({ method: 'POST', url: '/api/files/uploads', headers: h, payload: { size: body.length, sha256: sha(body), mime: 'audio/webm', name: 'lecture.webm', ...extra } });

const chunk = (a: TestApp, h: AuthHeaders, id: string, n: number, part: Buffer, claimed = sha(part)) =>
  a.app.inject({ method: 'PUT', url: `/api/files/uploads/${id}/chunks/${n}`, headers: { ...h, 'content-type': 'application/octet-stream', 'x-content-sha256': claimed }, payload: part });

const parts = (body: Buffer) => Array.from({ length: Math.ceil(body.length / CHUNK) }, (_, i) => body.subarray(i * CHUNK, (i + 1) * CHUNK));

describe('chunked uploads', () => {
  it('chunks in any order, a broken connection resumes the same session, then the verified file is stored once', async () => {
    const { t: a, h } = await app();
    const body = randomBytes(3 * CHUNK + 1234);
    const s1 = await start(a, h, body);
    expect(s1.statusCode, s1.body).toBe(200);
    const v1 = s1.json() as UploadSessionView;
    expect(v1).toMatchObject({ status: 'open', chunk_size: CHUNK, chunks: 4, received: [], file_id: null });
    const p = parts(body);
    expect((await chunk(a, h, v1.upload_id, 2, p[2]!)).json().received).toEqual([2]);
    expect((await chunk(a, h, v1.upload_id, 0, p[0]!)).json().received).toEqual([0, 2]);
    // «the connection broke»: the client announces the same bytes again and gets the same session back
    const again = (await start(a, h, body)).json() as UploadSessionView;
    expect(again.upload_id).toBe(v1.upload_id);
    expect(again.received).toEqual([0, 2]);
    // completing early names what is missing
    const early = await a.app.inject({ method: 'POST', url: `/api/files/uploads/${v1.upload_id}/complete`, headers: h });
    expect(early.statusCode).toBe(409);
    expect(early.json().error.details.missing).toEqual([1, 3]);
    // a chunk sent twice is fine
    await chunk(a, h, v1.upload_id, 3, p[3]!);
    await chunk(a, h, v1.upload_id, 1, p[1]!);
    await chunk(a, h, v1.upload_id, 1, p[1]!);
    const done = await a.app.inject({ method: 'POST', url: `/api/files/uploads/${v1.upload_id}/complete`, headers: h });
    expect(done.statusCode, done.body).toBe(200);
    const { file, session } = done.json();
    expect(file).toMatchObject({ sha256: sha(body), size: body.length, mime: 'audio/webm', original_name: 'lecture.webm' });
    expect(session).toMatchObject({ status: 'completed', file_id: file.id });
    expect((await a.ctx.files.read(file.id)).equals(body)).toBe(true);
    expect(a.ctx.system.blobs.getInternal(sha(body))).not.toBeNull();
    // a repeated «complete» (lost answer) returns the same file; the chunks are gone
    const twice = await a.app.inject({ method: 'POST', url: `/api/files/uploads/${v1.upload_id}/complete`, headers: h });
    expect(twice.json().file.id).toBe(file.id);
    expect(existsSync(join(a.config.tmpDir, 'uploads', v1.upload_id))).toBe(false);
  });

  it('a damaged chunk is refused (its hash), a wrong size is refused, and an index out of range is refused', async () => {
    const { t: a, h } = await app();
    const body = randomBytes(2 * CHUNK);
    const v = (await start(a, h, body)).json() as UploadSessionView;
    const [p0, p1] = parts(body);
    const damaged = Buffer.from(p0!);
    damaged[10] = damaged[10]! ^ 0xff;
    const bad = await chunk(a, h, v.upload_id, 0, damaged, sha(p0!));
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.message).toMatch(/بصمة الجزء/);
    expect((await chunk(a, h, v.upload_id, 1, p1!.subarray(0, 100))).statusCode).toBe(400);
    expect((await chunk(a, h, v.upload_id, 2, p1!)).statusCode).toBe(400);
    expect((await a.app.inject({ method: 'GET', url: `/api/files/uploads/${v.upload_id}`, headers: h })).json().received).toEqual([]);
  });

  it('a file whose assembled bytes do not match the announced hash never reaches the store', async () => {
    const { t: a, h } = await app();
    const real = randomBytes(CHUNK + 10);
    const lie = Buffer.from(real);
    lie[0] = lie[0]! ^ 1;
    // announce `real`, send `lie` (each chunk with its own correct hash)
    const v = (await a.app.inject({ method: 'POST', url: '/api/files/uploads', headers: h, payload: { size: real.length, sha256: sha(real) } })).json() as UploadSessionView;
    for (const [i, p] of parts(lie).entries()) expect((await chunk(a, h, v.upload_id, i, p)).statusCode).toBe(200);
    const done = await a.app.inject({ method: 'POST', url: `/api/files/uploads/${v.upload_id}/complete`, headers: h });
    expect(done.statusCode).toBe(400);
    expect(a.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM stored_file')!.n).toBe(0);
    expect(a.ctx.system.blobs.getInternal(sha(lie))).toBeNull();
    expect((await a.app.inject({ method: 'GET', url: `/api/files/uploads/${v.upload_id}`, headers: h })).json().status).toBe('failed');
  });

  it('bytes the vault already holds complete at once (nothing is sent again)', async () => {
    const { t: a, h } = await app();
    const body = randomBytes(5000);
    const have = await a.ctx.files.put(body, { mime: 'audio/webm' });
    const v = (await start(a, h, body)).json() as UploadSessionView;
    expect(v).toMatchObject({ status: 'completed', file_id: have.id });
  });

  it("sessions are per user: another account cannot read, extend or complete it, and its chunks never land in the other's vault", async () => {
    const { t: a, h } = await app();
    const b = await addUser(a, 'student-b');
    const hb = await b.login();
    const body = randomBytes(CHUNK);
    const v = (await start(a, h, body)).json() as UploadSessionView;
    expect((await a.app.inject({ method: 'GET', url: `/api/files/uploads/${v.upload_id}`, headers: hb })).statusCode).toBe(404);
    expect((await chunk(a, hb, v.upload_id, 0, body)).statusCode).toBe(404);
    expect((await a.app.inject({ method: 'POST', url: `/api/files/uploads/${v.upload_id}/complete`, headers: hb })).statusCode).toBe(404);
    expect((await a.app.inject({ method: 'DELETE', url: `/api/files/uploads/${v.upload_id}`, headers: hb })).statusCode).toBe(404);
  });

  it('the storage quota is checked when the session starts (open sessions count) and a session can be abandoned', async () => {
    const { t: a } = await app();
    const b = await addUser(a, 'student-b');
    const hb = await b.login();
    const used = a.ctx.quota.storageUsed(b.vault.id);
    a.ctx.system.quotas.setUserInternal(b.user.id, { storage_bytes_limit: used.bytes_db + used.bytes_files + 3 * CHUNK }, b.user.id);
    const one = randomBytes(2 * CHUNK);
    const v1 = (await start(a, hb, one)).json() as UploadSessionView;
    // a second session that would not fit beside the first open one
    const over = await start(a, hb, randomBytes(2 * CHUNK));
    expect(over.statusCode).toBe(409);
    expect(over.json().error).toMatchObject({ code: 'QUOTA_EXCEEDED', details: { kind: 'storage' } });
    // abandoning the first frees its bytes
    expect((await a.app.inject({ method: 'DELETE', url: `/api/files/uploads/${v1.upload_id}`, headers: hb })).statusCode).toBe(200);
    expect((await start(a, hb, randomBytes(2 * CHUNK))).statusCode).toBe(200);
  });

  it('a session past its expiry cannot continue; maintenance expires it and removes its chunks', async () => {
    const { t: a, h } = await app();
    const body = randomBytes(2 * CHUNK);
    const v = (await start(a, h, body)).json() as UploadSessionView;
    await chunk(a, h, v.upload_id, 0, parts(body)[0]!);
    a.clock.advance(25 * 60 * 60 * 1000);
    const late = await chunk(a, h, v.upload_id, 1, parts(body)[1]!);
    expect(late.statusCode).toBe(409);
    const other = (await start(a, h, randomBytes(100))).json() as UploadSessionView;
    await chunk(a, h, other.upload_id, 0, randomBytes(100)).catch(() => undefined);
    a.clock.advance(25 * 60 * 60 * 1000);
    const { FileMaintenance } = await import('../../src/modules/files');
    const { UploadService } = await import('../../src/modules/files/uploads');
    await new FileMaintenance(a.ctx, new UploadService(a.ctx)).tick();
    const left = existsSync(join(a.config.tmpDir, 'uploads')) ? readdirSync(join(a.config.tmpDir, 'uploads')) : [];
    expect(left).toEqual([]);
    expect((await a.app.inject({ method: 'GET', url: `/api/files/uploads/${other.upload_id}`, headers: h })).json().status).toBe('expired');
  });

  it('a subject space as target is refused until spaces exist (R1-c)', async () => {
    const { t: a, h } = await app();
    const res = await start(a, h, randomBytes(10), { target: { space_id: 'x' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('FEATURE_DISABLED');
  });
});
