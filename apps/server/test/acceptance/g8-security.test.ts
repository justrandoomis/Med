// G8 — security sweep (§49, ARCHITECTURE §0): adversarial checks against the REAL server code (every module mounted,
// real processing pipeline, real LibreOffice / poppler / OCR) — nothing here is a hand-written list of routes:
//   * auth on EVERY registered /api route (collected from Fastify's onRoute inside each module): 401 without a session
//     except the explicit public list; forged / expired / revoked sessions are no session; path tricks
//     (`/%61pi/…`, case, double slashes, dot segments) never reach a handler without the guard;
//   * CSRF on EVERY mutation route (missing header, foreign Origin, cross-site fetch metadata) — nothing is written;
//     no GET route is a state-changing verb;
//   * private files: a session or a short-lived token bound to ONE file; files are served sandboxed; an uploaded web
//     page / SVG never becomes an active page of the app;
//   * ZIP / upload abuse through the real upload route: traversal names, measured bombs, too many entries, a DOCX whose
//     zip headers LIE about the inflated size, a disguised executable, an oversized upload, a traversal file name;
//   * SSRF: an uploaded PPTX / legacy DOC whose picture is only a LINK to another host — LibreOffice (used for the
//     fixed slide rendering and for .doc conversion) must never fetch it; metadata URLs are never fetched; only the
//     SSRF guard and the AI SDK may open outbound connections (static check of the server sources);
//   * secrets: the AI key (a canary), the server secret, the owner's password and session token never appear in any
//     GET response, error body, export or backup — and never in the logs of a REAL server process.
import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import JSZip from 'jszip';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { UploadResponse } from '@medlevo/shared';
import { REPO_ROOT } from '../../src/config';
import { PUBLIC_ROUTES } from '../../src/modules/auth/guard';
import { CSRF, OWNER, sessionCookie } from '../helpers/app';
import { api, createNode } from '../questions/helpers';
import { acc, concreteUrl, g8App, gold, startTrap, uploadRaw, type G8App, type Trap } from './g8-helpers';

const CANARY_KEY = 'sk-ant-api03-G8CANARY-never-leave-the-server-0123456789abcdef';
const SERVER_SRC = join(REPO_ROOT, 'apps', 'server', 'src');

let t: G8App;
let course: string;
let trap: Trap;

beforeAll(async () => {
  t = await g8App({
    env: {
      ANTHROPIC_API_KEY: CANARY_KEY,
      // small limits so the abuse cases stay fast (the real defaults are larger, the rules are the same)
      MEDLEVO_MAX_UPLOAD_MB: '3',
      MEDLEVO_MAX_ZIP_UNCOMPRESSED_MB: '20',
      MEDLEVO_MAX_ZIP_ENTRIES: '60',
    },
  });
  course = (await createNode(t, 'G8 security course')).id;
  trap = await startTrap();
}, 120_000);

afterAll(async () => {
  await trap?.close();
  await t?.close();
});

const isPublic = (method: string, url: string) => PUBLIC_ROUTES.has(`${method} ${url}`);
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const uniqueRoutes = () => {
  const seen = new Set<string>();
  return t.routes.filter((r) => {
    const k = `${r.method} ${r.url}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};
const tableCounts = () => {
  const n = (table: string) => t.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)!.n;
  return { change_log: n('change_log'), source: n('source'), library_node: n('library_node'), sync_operation: n('sync_operation'), processing_job: n('processing_job') };
};
const STACK_OR_PATH = /\bat [\w.<>]+ \(|node_modules|\/home\/|\/tmp\/|SQLITE_|SELECT .* FROM|\.ts:\d+/;

describe('G8 security — authentication on every registered /api route', () => {
  it('the route list is the real one (every module, > 300 routes) and every non-public route answers 401 without a session', async () => {
    const routes = uniqueRoutes();
    expect(routes.length).toBeGreaterThan(300);
    expect(routes.every((r) => r.url.startsWith('/api/'))).toBe(true);
    const failures: string[] = [];
    let checked = 0;
    for (const r of routes) {
      if (isPublic(r.method, r.url) || r.method === 'OPTIONS') continue;
      const res = await t.app.inject({
        method: r.method as never,
        url: concreteUrl(r.url),
        // the CSRF header is present, so a 401 can only come from the missing session
        headers: { ...CSRF, 'content-type': 'application/json' },
        payload: MUTATING.has(r.method) ? '{}' : undefined,
      });
      checked++;
      const code = r.method === 'HEAD' ? null : (res.json() as { error?: { code?: string } }).error?.code;
      if (res.statusCode !== 401 || (code !== null && code !== 'UNAUTHENTICATED')) failures.push(`${r.method} ${r.url} → ${res.statusCode} ${code ?? ''}`);
    }
    expect(failures).toEqual([]);
    expect(checked).toBeGreaterThan(300);
  });

  it('the public list is exactly health, auth status/setup/login/recover and the signed file token — and none of them leaks owner data', async () => {
    expect([...PUBLIC_ROUTES].sort()).toEqual(
      ['GET /api/auth/status', 'GET /api/files/t/:token', 'GET /api/health', 'HEAD /api/auth/status', 'HEAD /api/files/t/:token', 'HEAD /api/health', 'POST /api/auth/login', 'POST /api/auth/recover', 'POST /api/auth/setup'].sort(),
    );
    const registered = new Set(uniqueRoutes().map((r) => `${r.method} ${r.url}`));
    for (const p of PUBLIC_ROUTES) expect(registered.has(p), p).toBe(true);
    // a forged token is refused; setup cannot run twice; a wrong login is refused
    expect((await t.app.inject({ method: 'GET', url: `/api/files/t/${'x'.repeat(48)}` })).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'POST', url: '/api/auth/setup', headers: CSRF, payload: { username: 'x', password: 'another-password-123' } })).statusCode).toBe(409);
    expect((await t.app.inject({ method: 'POST', url: '/api/auth/login', headers: CSRF, payload: { username: OWNER.username, password: 'wrong-password-000' } })).statusCode).toBe(401);
    const status = (await t.app.inject({ method: 'GET', url: '/api/auth/status' })).json() as { owner: unknown; session: unknown; authenticated: boolean };
    expect(status).toMatchObject({ owner: null, session: null, authenticated: false });
  });

  it('a forged, expired or revoked session cookie is no session', async () => {
    const url = '/api/library/tree';
    expect((await t.app.inject({ method: 'GET', url, headers: { cookie: t.h.cookie } })).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url, headers: { cookie: 'medlevo_session=forged-token-value' } })).statusCode).toBe(401);
    // a second session, logged out → its cookie is dead
    const other = await t.login({ userAgent: 'g8-logout' });
    expect((await t.app.inject({ method: 'POST', url: '/api/auth/logout', headers: other })).statusCode).toBeLessThan(300);
    expect((await t.app.inject({ method: 'GET', url, headers: { cookie: other.cookie } })).statusCode).toBe(401);
    // expiry: a session whose time has passed (the clock moves beyond the TTL)
    const late = await t.login({ userAgent: 'g8-expiry' });
    t.clock.advance(t.ctx.config.auth.sessionTtlMs + 60_000);
    try {
      expect((await t.app.inject({ method: 'GET', url, headers: { cookie: late.cookie } })).statusCode).toBe(401);
    } finally {
      t.h = await t.login(); // the main session may have expired too
    }
  });

  it('path tricks never reach a handler without the guard (decoded %XX, case, slashes, dot segments, NUL)', async () => {
    const variants = [
      '/%61pi/library/tree',
      '/api/%6cibrary/tree',
      '/%2561pi/library/tree',
      '/API/library/tree',
      '/api//library/tree',
      '//api/library/tree',
      '/api/library/tree/',
      '/./api/library/tree',
      '/api/./library/tree',
      '/api/x/../library/tree',
      '/api/library/tree%00',
      '/api/library/tree;x=1',
      '/api/library/tree?node=..%2F..',
    ];
    for (const url of variants) {
      const res = await t.app.inject({ method: 'GET', url });
      expect(res.statusCode, url).not.toBe(200);
      expect([401, 404, 400], url).toContain(res.statusCode);
      expect(res.body, url).not.toMatch(/"nodes"|"children"/);
    }
  });
});

describe('G8 security — CSRF on every mutation route', () => {
  it('missing header, a foreign Origin and cross-site fetch metadata are refused before any handler runs — nothing is written', async () => {
    const mutations = uniqueRoutes().filter((r) => MUTATING.has(r.method));
    expect(mutations.length).toBeGreaterThan(150);
    const before = tableCounts();
    const failures: string[] = [];
    const cookie = { cookie: t.h.cookie, 'content-type': 'application/json' };
    for (const r of mutations) {
      const url = concreteUrl(r.url);
      const cases: Array<[string, Record<string, string>]> = [
        ['no header', { ...cookie }],
        ['foreign origin', { ...cookie, ...CSRF, origin: 'https://evil.example' }],
        ['cross-site', { ...cookie, ...CSRF, 'sec-fetch-site': 'cross-site' }],
        ['wrong header value', { ...cookie, 'x-medlevo-csrf': 'yes' }],
      ];
      for (const [name, headers] of cases) {
        const res = await t.app.inject({ method: r.method as never, url, headers, payload: '{}' });
        const code = (res.json() as { error?: { code?: string } }).error?.code;
        if (res.statusCode !== 403 || code !== 'CSRF_FAILED') failures.push(`${name}: ${r.method} ${r.url} → ${res.statusCode} ${code}`);
      }
    }
    expect(failures).toEqual([]);
    expect(tableCounts()).toEqual(before);
  });

  it('a multipart upload without the header is refused too (the body is never parsed into a source)', async () => {
    const before = tableCounts();
    const { multipart } = await import('../sources/helpers');
    const body = multipart({ node_id: course, on_duplicate: 'create' }, [{ name: 'lecture.pdf', data: gold('lecture_appendicitis.pdf') }]);
    const res = await t.app.inject({ method: 'POST', url: '/api/sources/upload', headers: { cookie: t.h.cookie, 'content-type': body.contentType }, payload: body.payload });
    expect(res.statusCode).toBe(403);
    expect(tableCounts()).toEqual(before);
  });

  it('no GET route is a state-changing verb (logout, delete, purge, reset, restore … are never GET)', () => {
    const verbs = /\/(logout|delete|remove|purge|reset|restore|revoke|resolve|ack|decision|decide|archive|rebuild|suspend|bury|retry|cancel|reprocess|verify|finish|answer|hint|solution|grade|publish|freeze|import|setup|login|recover)(\/|$)/;
    const gets = uniqueRoutes().filter((r) => r.method === 'GET' && verbs.test(r.url));
    expect(gets.map((r) => r.url)).toEqual([]);
  });

  it('the session cookie is HttpOnly + SameSite=Strict and never readable by page scripts', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/auth/login', headers: { ...CSRF, 'user-agent': 'g8-cookie' }, payload: { username: OWNER.username, password: OWNER.password } });
    const raw = ([] as string[]).concat(res.headers['set-cookie'] as string[] | string).find((c) => c.startsWith('medlevo_session='))!;
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/SameSite=Strict/i);
    expect(raw).toMatch(/Path=\//);
    expect(res.body).not.toContain(sessionCookie(res).split('=')[1]!);
  });
});

describe('G8 security — private files', () => {
  it('files need a session or a token bound to that ONE file; served with nosniff + sandbox CSP; no file name leaks a path', async () => {
    const up = await uploadRaw(t, course, 'lecture_appendicitis.pdf', gold('lecture_appendicitis.pdf'), 'lecture');
    expect(up.body.results[0]!.status).toBe('accepted');
    const fileId = t.ctx.db.get<{ f: string }>('SELECT COALESCE(file_id, original_file_id) AS f FROM source_version WHERE id = ?', [up.body.results[0]!.version_id])!.f;
    const other = await uploadRaw(t, course, 'flowchart.png', gold('flowchart.png'), 'lecture');
    const otherFile = t.ctx.db.get<{ f: string }>('SELECT COALESCE(file_id, original_file_id) AS f FROM source_version WHERE id = ?', [other.body.results[0]!.version_id])!.f;

    expect((await t.app.inject({ method: 'GET', url: `/api/files/${fileId}` })).statusCode).toBe(401);
    const ok = await t.app.inject({ method: 'GET', url: `/api/files/${fileId}`, headers: { cookie: t.h.cookie } });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['x-content-type-options']).toBe('nosniff');
    expect(String(ok.headers['content-security-policy'])).toContain('sandbox');
    expect(String(ok.headers['content-disposition'] ?? '')).not.toMatch(/\/|\\/);
    expect(String(ok.headers['cache-control'])).toMatch(/private|no-store/);

    const { token } = t.ctx.files.createToken(fileId, 60_000);
    expect((await t.app.inject({ method: 'GET', url: `/api/files/t/${token}` })).statusCode).toBe(200);
    // the token is bound to the file: it is not a session, and it never opens another file
    expect((await t.app.inject({ method: 'GET', url: `/api/files/${otherFile}`, headers: { cookie: `medlevo_session=${token}` } })).statusCode).toBe(401);
    const [payload, sig] = token.split('.');
    const forged = Buffer.from(Buffer.from(payload!, 'base64url').toString('utf8').replace(fileId, otherFile)).toString('base64url');
    expect((await t.app.inject({ method: 'GET', url: `/api/files/t/${forged}.${sig}` })).statusCode).toBe(403);
    t.clock.advance(61_000);
    expect((await t.app.inject({ method: 'GET', url: `/api/files/t/${token}` })).statusCode).toBe(403);
    // traversal in the id never reaches the disk
    for (const u of ['/api/files/..%2F..%2Fsecret.key', '/api/files/%2e%2e%2fmedlevo.db', '/api/files/../../secret.key']) {
      const r = await t.app.inject({ method: 'GET', url: u, headers: { cookie: t.h.cookie } });
      expect([400, 404], u).toContain(r.statusCode);
      expect(r.body).not.toContain(readFileSync(join(t.dataDir, 'secret.key'), 'utf8').trim());
    }
  });

  it('an uploaded web page, SVG or script is never stored as an active document of the app', async () => {
    const page = Buffer.from('<!doctype html><html><body><script>fetch("/api/data/export/all")</script>TEST FIXTURE</body></html>');
    const svg = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><text>TEST FIXTURE</text></svg>');
    for (const [name, data] of [
      ['notes.html', page],
      ['notes.pdf', page],
      ['figure.svg', svg],
      ['figure.png', svg],
      ['run.js', Buffer.from('alert(1)')],
    ] as const) {
      const r = await uploadRaw(t, course, name, data, 'lecture');
      expect(r.status, name).toBe(200);
      expect(r.body.results[0]!.status, name).toBe('rejected');
      expect(r.body.results[0]!.reason_ar, name).toMatch(/[\u0600-\u06FF]/);
    }
  });
});

describe('G8 security — ZIP / upload abuse through the real upload route', () => {
  async function zipOf(entries: Array<[string, Buffer | string]>, level = 9): Promise<Buffer> {
    const z = new JSZip();
    for (const [n, d] of entries) z.file(n, d, { createFolders: false });
    return Buffer.from(await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level } }));
  }
  /** rewrite the DECLARED uncompressed size of one entry (local header + central directory): a lying archive */
  function lieAboutSize(buf: Buffer, entry: string, declared: number): Buffer {
    const b = Buffer.from(buf);
    for (let i = 0; i < b.length - 46; i++) {
      if (b.readUInt32LE(i) === 0x04034b50 && b.toString('latin1', i + 30, i + 30 + b.readUInt16LE(i + 26)) === entry) b.writeUInt32LE(declared, i + 22);
      if (b.readUInt32LE(i) === 0x02014b50 && b.toString('latin1', i + 46, i + 46 + b.readUInt16LE(i + 28)) === entry) b.writeUInt32LE(declared, i + 24);
    }
    return b;
  }
  const filesOnDisk = () => {
    const out: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else out.push(relative(t.dataDir, p));
      }
    };
    walk(t.dataDir);
    return out;
  };

  it('an image set with traversal names keeps only the safe pictures; nothing is written outside the data dir', async () => {
    const png = gold('flowchart.png');
    const zip = await zipOf([
      ['../../../../tmp/g8-escape.png', png],
      ['/etc/g8-abs.png', png],
      ['ok/page1.png', png],
      ['C:\\windows\\g8.png', png],
    ]);
    const r = await uploadRaw(t, course, 'pages.zip', zip, 'lecture');
    const res = r.body.results[0]!;
    expect(res.status).toBe('accepted');
    expect((res.rejected_entries ?? []).map((e) => e.name)).toEqual(expect.arrayContaining(['../../../../tmp/g8-escape.png', '/etc/g8-abs.png']));
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM source_page WHERE version_id = ?', [res.version_id])!.n).toBe(1);
    expect(() => statSync('/tmp/g8-escape.png')).toThrow();
    expect(filesOnDisk().some((f) => f.startsWith('..'))).toBe(false);
  });

  it('a measured zip bomb (honest headers) and an archive with too many entries are refused with an Arabic reason', async () => {
    const bomb = await zipOf([['page1.png', Buffer.alloc(30 * 1024 * 1024)]]);
    expect(bomb.length).toBeLessThan(200_000);
    const r1 = (await uploadRaw(t, course, 'bomb.zip', bomb, 'lecture')).body.results[0]!;
    expect(r1.status).toBe('rejected');
    expect(r1.reason_ar).toMatch(/[\u0600-\u06FF]/);
    const many = await zipOf(Array.from({ length: 80 }, (_, i) => [`p${i}.txt`, 'x'] as [string, string]));
    const r2 = (await uploadRaw(t, course, 'many.zip', many, 'lecture')).body.results[0]!;
    expect(r2.status).toBe('rejected');
    expect(r2.reason_ar).toContain('80');
  });

  it('a DOCX whose zip headers LIE about the inflated size (a 40 MB part declared as 4 KB) is refused at upload — it never reaches the parser', async () => {
    const z = await JSZip.loadAsync(gold('lecture_notes_shock.docx'));
    const doc = await z.file('word/document.xml')!.async('string');
    z.file('word/document.xml', doc.replace('</w:body>', `${' '.repeat(40 * 1024 * 1024)}</w:body>`));
    const honest = Buffer.from(await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } }));
    const lying = lieAboutSize(honest, 'word/document.xml', 4000);
    expect(lying.length).toBeLessThan(400_000);
    // the honest bomb is caught from its headers…
    expect((await uploadRaw(t, course, 'honest-bomb.docx', honest, 'lecture')).body.results[0]!.status).toBe('rejected');
    // …and the lying one must be caught by MEASURING (headers are not trusted)
    const jobsBefore = tableCounts().processing_job;
    const res = (await uploadRaw(t, course, 'notes.docx', lying, 'lecture')).body.results[0]!;
    expect(res.status, JSON.stringify(res)).toBe('rejected');
    expect(res.reason_ar).toMatch(/[\u0600-\u06FF]/);
    expect(tableCounts().processing_job).toBe(jobsBefore);
  });

  it('a disguised executable, an oversized upload and a traversal file name', async () => {
    const elf = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]), Buffer.alloc(2048, 1)]);
    const r1 = (await uploadRaw(t, course, 'lecture.pdf', elf, 'lecture')).body.results[0]!;
    expect(r1.status).toBe('rejected');
    // > MEDLEVO_MAX_UPLOAD_MB (3 MB here): 413 with the Arabic message, no partial file left behind
    const before = filesOnDisk().filter((f) => !f.startsWith('medlevo.db')).length;
    const big = Buffer.concat([gold('lecture_appendicitis.pdf'), Buffer.alloc(4 * 1024 * 1024, 0x20)]);
    const r2 = await uploadRaw(t, course, 'big.pdf', big, 'lecture');
    expect([413, 200]).toContain(r2.status);
    if (r2.status === 200) expect(r2.body.results[0]!.status).toBe('rejected');
    else expect(r2.body.error!.message).toMatch(/[\u0600-\u06FF]/);
    expect(filesOnDisk().filter((f) => !f.startsWith('medlevo.db')).length).toBe(before);
    // a file name that tries to walk out of the store is only a title
    const r3 = (await uploadRaw(t, course, '../../../../etc/passwd.pdf', gold('lecture_cholecystitis.pdf'), 'lecture')).body.results[0]!;
    expect(r3.status).toBe('accepted');
    expect(filesOnDisk().some((f) => f.includes('passwd') || f.startsWith('..'))).toBe(false);
  });
});

describe('G8 security — SSRF: nothing in an uploaded file makes the server call another host', () => {
  async function pptxPointingAt(port: number): Promise<Buffer> {
    const z = await JSZip.loadAsync(acc('g8_linked_image.pptx'));
    const rels = 'ppt/slides/_rels/slide1.xml.rels';
    const xml = await z.file(rels)!.async('string');
    expect(xml).toContain('http://127.0.0.1:65001/g8-pptx-ssrf.png');
    z.file(rels, xml.replace('127.0.0.1:65001', `127.0.0.1:${port}`));
    return Buffer.from(await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  }
  function docPointingAt(port: number): Buffer {
    const p = String(port);
    expect(p).toHaveLength(5);
    let b = acc('g8_linked_image.doc');
    for (const [from, to] of [
      [Buffer.from('65001', 'latin1'), Buffer.from(p, 'latin1')],
      [Buffer.from('65001', 'utf16le'), Buffer.from(p, 'utf16le')],
    ] as const) {
      let i = b.indexOf(from);
      while (i >= 0) {
        b = Buffer.concat([b.subarray(0, i), to, b.subarray(i + from.length)]);
        i = b.indexOf(from, i + to.length);
      }
    }
    return b;
  }

  it('a PPTX whose picture is only a link: the fixed slide rendering (LibreOffice) is made WITHOUT fetching it', async () => {
    trap.hits.length = 0;
    const r = (await uploadRaw(t, course, 'linked.pptx', await pptxPointingAt(trap.port), 'lecture')).body.results[0]!;
    expect(r.status).toBe('accepted');
    await t.ctx.jobs.drain();
    const v = t.ctx.db.get<{ processing_status: string; display_file_id: string | null }>('SELECT processing_status, display_file_id FROM source_version WHERE id = ?', [r.version_id])!;
    expect(v.display_file_id, 'LibreOffice still produced the fixed rendering').not.toBeNull();
    expect(trap.hits).toEqual([]);
  }, 240_000);

  it('a legacy .doc whose picture is only a link: the conversion (LibreOffice) never fetches it', async () => {
    trap.hits.length = 0;
    const r = (await uploadRaw(t, course, 'linked.doc', docPointingAt(trap.port), 'lecture')).body.results[0]!;
    expect(r.status, JSON.stringify(r)).toBe('accepted');
    await t.ctx.jobs.drain();
    const v = t.ctx.db.get<{ processing_status: string; file_id: string | null }>('SELECT processing_status, file_id FROM source_version WHERE id = ?', [r.version_id])!;
    expect(v.file_id, 'the .doc was converted').not.toBeNull();
    expect(trap.hits).toEqual([]);
  }, 240_000);

  it('a source URL in the metadata is stored, never fetched; javascript: / file: URLs are refused', async () => {
    trap.hits.length = 0;
    const up = await uploadRaw(t, course, 'lecture_cholecystitis.pdf', gold('lecture_cholecystitis.pdf'), 'lecture');
    const sid = up.body.results[0]!.source_id!;
    const ok = await api(t).patch(`/api/sources/${sid}`, { original_url: `http://127.0.0.1:${trap.port}/g8-metadata` });
    expect(ok.statusCode).toBe(200);
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', `gopher://127.0.0.1:${trap.port}/`]) {
      expect((await api(t).patch(`/api/sources/${sid}`, { original_url: bad })).statusCode, bad).toBe(400);
    }
    await t.ctx.jobs.drain();
    expect(trap.hits).toEqual([]);
  });

  it('only the SSRF guard and the AI provider SDK may open outbound connections (static check of every server source file)', () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts')) files.push(p);
      }
    };
    walk(SERVER_SRC);
    const NET = /\bfetch\s*\(|from ['"]node:(http|https|net|tls|dgram)['"]|require\(['"](http|https|net|tls)['"]\)|\bundici\b|\baxios\b|new\s+WebSocket\b|XMLHttpRequest/;
    const allowed = new Set(['lib/ssrf-guard.ts']);
    const hits = files.map((f) => relative(SERVER_SRC, f)).filter((rel) => !allowed.has(rel) && NET.test(readFileSync(join(SERVER_SRC, rel), 'utf8')));
    expect(hits).toEqual([]);
    // the production AI provider is built from the key and the model names only — no base URL / fetch override
    const factory = readFileSync(join(SERVER_SRC, 'modules', 'ai', 'providers', 'index.ts'), 'utf8');
    expect(factory).toMatch(/new AnthropicProvider\(\{ apiKey: key, models: config\.ai\.models \}\)/);
    expect(factory).not.toMatch(/baseURL|fetch\s*:/);
  });
});

describe('G8 security — secrets never in responses, errors, exports or logs', () => {
  it('no GET route (with a session) answers with the AI key, the server secret or the password; no error body carries a stack, path or SQL', async () => {
    const secret = readFileSync(join(t.dataDir, 'secret.key'), 'utf8').trim();
    const needles = [CANARY_KEY, 'G8CANARY', secret, OWNER.password, t.h.cookie.split('=')[1]!];
    const failures: string[] = [];
    for (const r of uniqueRoutes().filter((x) => x.method === 'GET')) {
      const res = await t.app.inject({ method: 'GET', url: concreteUrl(r.url), headers: { cookie: t.h.cookie } });
      const blob = `${JSON.stringify(res.headers)}\n${res.rawPayload.toString('latin1')}`;
      for (const n of needles) if (blob.includes(n)) failures.push(`${r.url} contains a secret`);
      if (res.statusCode >= 400 && STACK_OR_PATH.test(res.body)) failures.push(`${r.url} → ${res.statusCode} leaks internals: ${res.body.slice(0, 200)}`);
    }
    expect(failures).toEqual([]);
    // malformed bodies / huge numbers / wrong types on a sample of mutations: Arabic errors without internals
    for (const [method, url, payload] of [
      ['POST', '/api/library/nodes', '{"title":'],
      ['POST', '/api/library/nodes', JSON.stringify({ parent_id: null, kind: 'course', title: 'x'.repeat(100_000) })],
      ['PATCH', '/api/learning/profile', JSON.stringify({ pace_minutes_per_day: 1e308 })],
      ['POST', '/api/sync/push', JSON.stringify({ ops: 'not-an-array' })],
    ] as const) {
      const res = await t.app.inject({ method, url, headers: { ...t.h, 'content-type': 'application/json' }, payload });
      expect(res.statusCode, url).toBeGreaterThanOrEqual(400);
      expect(res.statusCode, url).toBeLessThan(500);
      expect(res.body).not.toMatch(STACK_OR_PATH);
      expect((res.json() as { error: { message: string } }).error.message).toMatch(/[\u0600-\u06FF]/);
    }
  });

  it('the full export and a backup archive carry neither the AI key, the server secret, the password nor a live session token', async () => {
    const secret = readFileSync(join(t.dataDir, 'secret.key'), 'utf8').trim();
    const token = t.h.cookie.split('=')[1]!;
    const exp = await t.app.inject({ method: 'GET', url: '/api/data/export/all', headers: { cookie: t.h.cookie } });
    expect(exp.statusCode).toBe(200);
    const b = await t.app.inject({ method: 'POST', url: '/api/data/backups', headers: t.h, payload: {} });
    expect(b.statusCode).toBe(200);
    await t.ctx.jobs.drain();
    const id = (b.json() as { backup: { id: string } }).backup.id;
    const dl = await t.app.inject({ method: 'GET', url: `/api/data/backups/${id}/download`, headers: { cookie: t.h.cookie } });
    expect(dl.statusCode).toBe(200);
    for (const blob of [exp.rawPayload, dl.rawPayload]) {
      for (const n of [CANARY_KEY, 'G8CANARY', secret, OWNER.password, token]) expect(blob.includes(Buffer.from(n))).toBe(false);
    }
  }, 120_000);

  it('a REAL server process never writes the AI key, the password, the session token or a signed file token to its logs', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'medlevo-g8-log-'));
    const port = await new Promise<number>((resolveP) => {
      const probe = createNetServer();
      probe.listen(0, '127.0.0.1', () => {
        const p = (probe.address() as { port: number }).port;
        probe.close(() => resolveP(p));
      });
    });
    const base = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', join(SERVER_SRC, 'index.ts')], {
      cwd: join(REPO_ROOT, 'apps', 'server'),
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: dataDir,
        NODE_ENV: 'production',
        MEDLEVO_DATA_DIR: dataDir,
        MEDLEVO_HOST: '127.0.0.1',
        MEDLEVO_PORT: String(port),
        MEDLEVO_ORIGIN: base,
        MEDLEVO_LOG_LEVEL: 'trace',
        MEDLEVO_SETUP_TOKEN: '',
        ANTHROPIC_API_KEY: CANARY_KEY,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout!.on('data', (d) => (log += d.toString()));
    child.stderr!.on('data', (d) => (log += d.toString()));
    try {
      for (let i = 0; i < 240; i++) {
        try {
          if ((await fetch(`${base}/api/health`)).ok) break;
        } catch {
          /* not yet */
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      const password = 'g8-Very-Secret-Passphrase-42';
      const post = (url: string, body: unknown, cookie?: string) =>
        fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-medlevo-csrf': '1', origin: base, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
      const setup = await post('/api/auth/setup', { username: 'owner', password });
      expect(setup.status).toBe(200);
      const recovery = ((await setup.json()) as { recovery_codes: string[] }).recovery_codes;
      await post('/api/auth/login', { username: 'owner', password: 'wrong-password-xyz' });
      const login = await post('/api/auth/login', { username: 'owner', password });
      const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
      const token = cookie.split('=')[1]!;
      await fetch(`${base}/api/control/overview`, { headers: { cookie } });
      await fetch(`${base}/api/settings`, { headers: { cookie } });
      await post('/api/auth/recover', { username: 'owner', recovery_code: recovery[0], new_password: 'another-Passphrase-77' });
      await fetch(`${base}/api/files/t/${'y'.repeat(60)}.zzzz`);
      await post('/api/library/nodes', '{"broken":', cookie);
      await new Promise((r) => setTimeout(r, 500));
      expect(log.length).toBeGreaterThan(200); // the server really logged (trace level)
      for (const n of [CANARY_KEY, 'G8CANARY', password, 'wrong-password-xyz', 'another-Passphrase-77', token, recovery[0]!, 'y'.repeat(60)]) {
        expect(log.includes(n), `log contains ${n.slice(0, 12)}…`).toBe(false);
      }
    } finally {
      child.kill('SIGTERM');
      await new Promise((r) => child.once('exit', r));
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 120_000);
});

export type { UploadResponse };
