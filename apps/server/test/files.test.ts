import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256 } from '../src/lib/hash';
import { type AuthHeaders, createTestApp, type TestApp } from './helpers/app';

let t: TestApp;
let h: AuthHeaders;
beforeAll(async () => {
  t = await createTestApp();
  ({ headers: h } = await t.setupOwner());
});
afterAll(async () => {
  await t.close();
});

const CONTENT = Buffer.from('TEST FIXTURE — synthetic file content 0123456789');
const RANGE_CONTENT = Buffer.from('TEST FIXTURE — range content abcdefghijklmnopqrstuvwxyz');

describe('FileStore', () => {
  it('stores content-addressed blobs and deduplicates identical content', async () => {
    const a = await t.ctx.files.put(CONTENT, { mime: 'text/plain', originalName: 'notes.txt' });
    const b = await t.ctx.files.put(Readable.from([CONTENT.subarray(0, 10), CONTENT.subarray(10)]), { mime: 'text/plain' });
    expect(a.deduplicated).toBe(false);
    expect(b.deduplicated).toBe(true);
    expect(b.id).toBe(a.id);
    const sha = sha256(CONTENT);
    expect(a.sha256).toBe(sha);
    expect(a.size).toBe(CONTENT.length);
    expect(a.storage_key).toBe(`${sha.slice(0, 2)}/${sha.slice(2, 4)}/${sha}`);
    const path = t.ctx.files.path(a.id);
    expect(path).toBe(join(t.dataDir, 'files', sha.slice(0, 2), sha.slice(2, 4), sha));
    expect(existsSync(path)).toBe(true);
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM stored_file WHERE sha256 = ?', [sha])!.n).toBe(1);
    expect((await t.ctx.files.read(a.id)).equals(CONTENT)).toBe(true);
    expect(t.ctx.files.verifyBlob(a.id)).toBe(true);
    // temp files are cleaned up
    expect(readdirSync(join(t.dataDir, 'tmp')).filter((f) => f.startsWith('upload-'))).toEqual([]);
  });

  it('enforces a max size while streaming and leaves no partial file behind', async () => {
    await expect(t.ctx.files.put(Buffer.alloc(2048, 1), { mime: 'application/octet-stream', maxBytes: 1024 })).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    expect(readdirSync(join(t.dataDir, 'tmp')).filter((f) => f.startsWith('upload-'))).toEqual([]);
  });

  it('creates the server secret with 0600 permissions', () => {
    const mode = statSync(join(t.dataDir, 'secret.key')).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe('GET /api/files/:id', () => {
  let id: string;
  beforeAll(async () => {
    id = (await t.ctx.files.put(RANGE_CONTENT, { mime: 'text/plain; charset=utf-8', originalName: 'محاضرة.txt' })).id;
  });

  it('denies unauthenticated access', async () => {
    const res = await t.app.inject({ method: 'GET', url: `/api/files/${id}` });
    expect(res.statusCode).toBe(401);
  });

  it('serves the full file with safe headers', async () => {
    const res = await t.app.inject({ method: 'GET', url: `/api/files/${id}`, headers: { cookie: h.cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(RANGE_CONTENT)).toBe(true);
    expect(res.headers['content-type']).toBe('text/plain');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toMatch(/^private/);
    expect(res.headers['content-disposition']).toMatch(/^inline; filename="/);
    expect(res.headers['content-disposition']).toContain("filename*=UTF-8''" + encodeURIComponent('محاضرة.txt'));
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['content-security-policy']).toContain('sandbox');
    const etag = res.headers['etag'] as string;
    const cached = await t.app.inject({ method: 'GET', url: `/api/files/${id}`, headers: { cookie: h.cookie, 'if-none-match': etag } });
    expect(cached.statusCode).toBe(304);
  });

  it('supports Range requests (start-end, suffix, open-ended, unsatisfiable)', async () => {
    const get = (range: string) => t.app.inject({ method: 'GET', url: `/api/files/${id}`, headers: { cookie: h.cookie, range } });
    const r1 = await get('bytes=0-4');
    expect(r1.statusCode).toBe(206);
    expect(r1.headers['content-range']).toBe(`bytes 0-4/${RANGE_CONTENT.length}`);
    expect(r1.rawPayload.equals(RANGE_CONTENT.subarray(0, 5))).toBe(true);
    const r2 = await get('bytes=-3');
    expect(r2.statusCode).toBe(206);
    expect(r2.rawPayload.equals(RANGE_CONTENT.subarray(RANGE_CONTENT.length - 3))).toBe(true);
    const r3 = await get('bytes=10-');
    expect(r3.rawPayload.equals(RANGE_CONTENT.subarray(10))).toBe(true);
    const r4 = await get(`bytes=${RANGE_CONTENT.length + 10}-`);
    expect(r4.statusCode).toBe(416);
    expect(r4.headers['content-range']).toBe(`bytes */${RANGE_CONTENT.length}`);
  });

  // regression: HEAD used to answer Content-Length: 0 (Fastify rewrites it for an empty payload)
  it('answers HEAD with the real length and no body (full and ranged, session and token)', async () => {
    const head = await t.app.inject({ method: 'HEAD', url: `/api/files/${id}`, headers: { cookie: h.cookie } });
    expect(head.statusCode).toBe(200);
    expect(head.headers['content-length']).toBe(String(RANGE_CONTENT.length));
    expect(head.rawPayload.length).toBe(0);
    const ranged = await t.app.inject({ method: 'HEAD', url: `/api/files/${id}`, headers: { cookie: h.cookie, range: 'bytes=0-4' } });
    expect(ranged.statusCode).toBe(206);
    expect(ranged.headers['content-length']).toBe('5');
    const { token } = t.ctx.files.createToken(id, 60_000);
    const viaToken = await t.app.inject({ method: 'HEAD', url: `/api/files/t/${token}` });
    expect(viaToken.statusCode).toBe(200);
    expect(viaToken.headers['content-length']).toBe(String(RANGE_CONTENT.length));
  });

  it('forces download for active content types', async () => {
    const html = await t.ctx.files.put(Buffer.from('<script>alert(1)</script>'), { mime: 'text/html', originalName: 'x.html' });
    const res = await t.app.inject({ method: 'GET', url: `/api/files/${html.id}`, headers: { cookie: h.cookie } });
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-disposition']).toMatch(/^attachment/);
  });

  it('returns 404 for unknown files without leaking paths', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/files/01J0000000000000000000000Z', headers: { cookie: h.cookie } });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain(t.dataDir);
  });
});

describe('short-lived signed file tokens', () => {
  it('grants access without a session until expiry, and rejects tampering', async () => {
    const f = await t.ctx.files.put(Buffer.from('token test fixture'), { mime: 'text/plain' });
    const other = await t.ctx.files.put(Buffer.from('another fixture'), { mime: 'text/plain' });
    const tok = await t.app.inject({ method: 'POST', url: `/api/files/${f.id}/token`, headers: h, payload: { ttl_seconds: 60 } });
    expect(tok.statusCode).toBe(200);
    const { url, token, expires_at } = tok.json();
    expect(expires_at).toBe(t.clock.now() + 60_000);

    const ok = await t.app.inject({ method: 'GET', url });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('token test fixture');

    // signature is bound to the file id
    const [payload, sig] = (token as string).split('.');
    const forgedPayload = Buffer.from(JSON.stringify({ f: other.id, e: expires_at })).toString('base64url');
    expect((await t.app.inject({ method: 'GET', url: `/api/files/t/${forgedPayload}.${sig}` })).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'GET', url: `/api/files/t/${payload}.${sig}x` })).statusCode).toBe(403);

    t.clock.advance(61_000);
    const expired = await t.app.inject({ method: 'GET', url });
    expect(expired.statusCode).toBe(403);
    expect(expired.json().error.message).toMatch(/منتهي الصلاحية/);
  });

  it('caps the token lifetime at one hour', () => {
    const f = t.ctx.db.get<{ id: string }>('SELECT id FROM stored_file LIMIT 1')!;
    const { expiresAt } = t.ctx.files.createToken(f.id, 24 * 60 * 60_000);
    expect(expiresAt - t.clock.now()).toBe(60 * 60_000);
  });
});
