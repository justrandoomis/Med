// G8 — security sweep against the REAL server process (production mode, built web app) on both projects. Complements
// apps/server/test/acceptance/g8-security.test.ts (every registered route / mutation, in-process) with what only a
// real browser + a real server process can show:
//   * no session → 401 on owner data (also through percent-encoded / dot-segment paths); a cross-site page in the real
//     browser cannot make the owner's browser write anything (SameSite=Strict cookie + CSRF header + Origin check);
//   * the static site never serves repository / data files (traversal, .env, database, secret);
//   * security headers on the app shell and on /api answers; the session cookie is HttpOnly + SameSite=Strict;
//   * private files: no session → 401;
//   * an uploaded PPTX whose picture is only a LINK to another host is processed (fixed slide rendering by
//     LibreOffice) without the server ever calling that host (a local trap counts requests);
//   * the server's own log (this run) holds neither the owner's password nor the session token.
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import type { LibraryTreeResponse } from '@medlevo/shared';
import { expect, OWNER, screenshot, setupOwner, test } from './support';
import { REPO_ROOT, serverFor } from './support/paths';
import { ACCEPTANCE_DIR, uploadFile } from './g1-helpers';

test('no session, no data: 401 on owner routes and on path tricks; the static site never serves repository or data files', async ({
  page,
  playwright,
  baseURL,
}) => {
  await setupOwner(page);
  const anon = await playwright.request.newContext({ baseURL });
  try {
    for (const path of [
      '/api/library/tree',
      '/api/control/overview',
      '/api/questions',
      '/api/learning/home',
      '/api/data/export/all',
      '/api/settings',
      '/api/evidence/alerts',
      '/api/auth/sessions',
    ]) {
      const r = await anon.get(path);
      expect(r.status(), path).toBe(401);
    }
    for (const path of ['/%61pi/library/tree', '/api/%6cibrary/tree', '/api/x/../library/tree', '/API/library/tree', '//api/library/tree']) {
      const r = await anon.get(`${baseURL}${path}`); // absolute: «//api/…» alone would be read as a host name
      // never owner data: a guarded 401 / 404, or (for a path that is not an API route at all) the app shell
      if (r.status() === 200) {
        expect(r.headers()['content-type'], path).toContain('text/html');
        expect(await r.text(), path).not.toMatch(/"nodes"|"children"/);
      } else expect([401, 404], path).toContain(r.status());
    }
    // the static site: SPA shell for app routes, never a file of the repository or of the data directory
    const leaks = [
      '/..%2f..%2fpackage.json',
      '/%2e%2e/%2e%2e/package.json',
      '/..%2F..%2Fapps%2Fserver%2Fsrc%2Fconfig.ts',
      '/.env',
      '/.env.example',
      '/medlevo.db',
      '/secret.key',
      '/files/',
      '/%2e%2e/%2e%2e/%2e%2e/etc/passwd',
      '/assets/..%2f..%2f..%2fpackage.json',
    ];
    for (const path of leaks) {
      const r = await anon.get(path);
      const body = await r.text();
      expect(body, path).not.toContain('"workspaces"');
      expect(body, path).not.toContain('ANTHROPIC_API_KEY=');
      expect(body, path).not.toContain('SQLite format');
      expect(body, path).not.toContain('root:x:0:0');
      expect(body, path).not.toContain('loadConfig');
    }
    // a private file without a session
    const files = await anon.get('/api/files/01JZZZZZZZZZZZZZZZZZZZZZZZ');
    expect(files.status()).toBe(401);
  } finally {
    await anon.dispose();
  }
});

test.describe('cross-site', () => {
  // the attack page's requests are blocked by the browser / refused by the server — Chromium logs exactly that
  test.use({
    allowedConsoleErrors: [/blocked by CORS policy|Failed to load resource|net::ERR_FAILED|status of 40[13]|Blocked script execution in .*sandboxed/i],
  });
  test("a cross-site page cannot make the owner's browser write (form POST, fetch with credentials); cookie and headers are strict", async ({
    page,
    api,
    context,
    baseURL,
  }) => {
    await setupOwner(page);
    const before = (await api.get<LibraryTreeResponse>('/api/library/tree')).nodes.length;
    const attacker = 'http://attacker.g8.test';
    const target = `${baseURL}/api/library/nodes`;
    await page.route(`${attacker}/**`, (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html><body>
        <form id="f" method="POST" action="${target}" enctype="text/plain"><input name='{"parent_id":null,"kind":"notebook","title":"pwned","x":"' value='"}'></form>
        <script>
          window.results = [];
          fetch(${JSON.stringify(target)}, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', 'x-medlevo-csrf': '1' }, body: JSON.stringify({ parent_id: null, kind: 'notebook', title: 'pwned-fetch' }) })
            .then((r) => window.results.push('fetch:' + r.status)).catch((e) => window.results.push('fetch-blocked'));
          fetch(${JSON.stringify(target)}, { method: 'POST', credentials: 'include', mode: 'no-cors', headers: { 'content-type': 'text/plain' }, body: '{"parent_id":null,"kind":"notebook","title":"pwned-nocors"}' })
            .then(() => window.results.push('nocors-sent')).catch(() => window.results.push('nocors-blocked'));
          setTimeout(() => document.getElementById('f').submit(), 300);
        </script></body></html>`,
      }),
    );
    await page.goto(`${attacker}/evil.html`);
    await page.waitForTimeout(2_000);
    const after = await api.get<LibraryTreeResponse>('/api/library/tree');
    expect(after.nodes.length).toBe(before);
    expect(JSON.stringify(after.nodes)).not.toContain('pwned');

    // cookie flags as the browser stored them
    const cookie = (await context.cookies()).find((c) => c.name === 'medlevo_session')!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe('Strict');
    // headers: the app shell and an /api answer
    const shell = await page.request.get('/library');
    const h = shell.headers();
    expect(h['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(h['x-frame-options']).toBe('DENY');
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['referrer-policy']).toBe('no-referrer');
    const apiRes = await page.request.get('/api/library/tree');
    expect(apiRes.headers()['content-security-policy']).toContain('sandbox');
    expect(apiRes.headers()['cache-control']).toContain('no-store');
    // the page script cannot read the session cookie
    await page.goto('/library');
    expect(await page.evaluate(() => document.cookie)).not.toContain('medlevo_session');
  });
});

test('an uploaded PPTX whose picture is only a link is rendered without the server calling that host', async ({ page, api }, testInfo) => {
  test.setTimeout(240_000);
  await setupOwner(page);
  const hits: string[] = [];
  const trap = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => trap.listen(0, '127.0.0.1', () => r()));
  const port = (trap.address() as { port: number }).port;
  try {
    const z = await JSZip.loadAsync(readFileSync(join(ACCEPTANCE_DIR, 'g8_linked_image.pptx')));
    const rels = 'ppt/slides/_rels/slide1.xml.rels';
    z.file(rels, (await z.file(rels)!.async('string')).replace('127.0.0.1:65001', `127.0.0.1:${port}`));
    const dir = mkdtempSync(join(tmpdir(), 'g8-e2e-'));
    const file = join(dir, `g8-linked-${Date.now().toString(36)}.pptx`);
    writeFileSync(file, await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
    const { course } = await api.createNotebookAndCourse();
    const up = await uploadFile(api, course.id, file, {
      sourceType: 'lecture',
      title: `G8 linked picture ${Date.now().toString(36)}`,
    });
    const done = await api.waitForProcessing(up.version_id);
    expect(done.job?.status).toBe('completed');
    const detail = await api.source(up.source_id);
    expect(detail.versions.find((v) => v.id === up.version_id)?.display_file_id, 'the fixed rendering exists (LibreOffice ran)').toBeTruthy();
    expect(hits, 'the server never fetched the linked picture').toEqual([]);
    await page.goto(`/sources/${up.source_id}`);
    await screenshot(page, testInfo, 'g8-security-linked-pptx');
  } finally {
    await new Promise<void>((r) => trap.close(() => r()));
  }
});

test("the server log of this run holds neither the owner's password nor the session token", async ({ page, context }, testInfo) => {
  await setupOwner(page);
  // a wrong password too: it must not be logged either
  await page.request.post('/api/auth/login', {
    headers: { 'x-medlevo-csrf': '1' },
    data: { username: OWNER.username, password: 'g8-wrong-password-value' },
  });
  const token = (await context.cookies()).find((c) => c.name === 'medlevo_session')!.value;
  const info = serverFor(testInfo.project.name);
  test.skip(!info.logFile, 'an external server (E2E_BASE_URL): its log is not available here');
  await page.waitForTimeout(500);
  const log = readFileSync(join(REPO_ROOT, info.logFile!), 'utf8');
  expect(log.length).toBeGreaterThan(100);
  expect(log.includes(OWNER.password)).toBe(false);
  expect(log.includes('g8-wrong-password-value')).toBe(false);
  expect(log.includes(token)).toBe(false);
});
