// Round 7 H4 item 9 (§32 «أنشئ سجلًا للمصادر البصرية التي أسمح بها»): the owner-managed registry of allowed external
// visual sources. Before H4 there was none — an external candidate passed AC-09 on modality / region / caption alone,
// whatever site it came from. Now:
//   * validateImageCandidate excludes an EXTERNAL candidate unless its original URL belongs to an ENABLED entry
//     (domain or a sub-domain, the atlas path when given) — no URL / empty registry / unlisted / disabled → reason;
//   * /api/media/images/match uses the registry; disabling the entry excludes the picture again;
//   * the fetch gate needs BOTH MEDLEVO_ALLOW_EXTERNAL_FETCH and an enabled entry (nothing is fetched: no provider);
//   * entries are owner data: change log, full JSON export.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExportManifest, ImageMatchResponse, VisualSourceListResponse, VisualSourceView } from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import { matchAllowedSource, validateImageCandidate, type AllowedVisualSource } from '../../src/modules/media/validate-image';
import { assertExternalFetchAllowed, normalizeDomain } from '../../src/modules/media/visual-sources';
import { createTestApp, type AuthHeaders, type TestApp } from '../helpers/app';

const request = { modality: 'X-ray', anatomic_region: 'chest', finding_terms: ['pneumothorax'], require_real_example: true };
const good = { modality: 'x-ray', anatomic_region: 'chest', caption: 'Chest X-ray: right pneumothorax.', origin: 'external' as const };
const atlas: AllowedVisualSource = { id: 'V1', name: 'Atlas (TEST)', domain: 'atlas.example-med.org', path_prefix: '/cases/' };
const open: AllowedVisualSource = { id: 'V2', name: 'Open images (TEST)', domain: 'openimages-test.org', path_prefix: null };

describe('allowed_source check (pure)', () => {
  it('an external candidate that passes every other check is still excluded without a registry entry', () => {
    const none = validateImageCandidate({ ...good, source_url: 'https://openimages-test.org/i/1' }, request);
    expect(none.accepted).toBe(false);
    expect(none.checks.find((c) => c.check === 'allowed_source')).toMatchObject({ passed: false, reason_ar: expect.stringContaining('لا توجد مصادر بصرية مسموح بها') });
    const noUrl = validateImageCandidate(good, request, { allowedSources: [open] });
    expect(noUrl.accepted).toBe(false);
    expect(noUrl.reasons_ar.join(' ')).toContain('بلا رابط');
    const unlisted = validateImageCandidate({ ...good, source_url: 'https://random-images.net/x.png' }, request, { allowedSources: [open] });
    expect(unlisted.accepted).toBe(false);
    expect(unlisted.reasons_ar.join(' ')).toContain('random-images.net');
  });

  it('accepted from an enabled entry; the reason names it; the owner’s own source images need no entry', () => {
    const v = validateImageCandidate({ ...good, source_url: 'https://openimages-test.org/i/1' }, request, { allowedSources: [open] });
    expect(v.accepted).toBe(true);
    expect(v.checks.find((c) => c.check === 'allowed_source')!.reason_ar).toContain('Open images (TEST)');
    const own = validateImageCandidate({ ...good, origin: 'source' }, request);
    expect(own.accepted).toBe(true);
    expect(own.checks.some((c) => c.check === 'allowed_source')).toBe(false);
  });

  it('URL matching: sub-domains yes, look-alike hosts no, atlas path enforced, only http(s), no credentials', () => {
    const reg = [atlas, open];
    expect(matchAllowedSource('https://img.openimages-test.org/a.png', reg)?.id).toBe('V2');
    expect(matchAllowedSource('https://OPENIMAGES-TEST.ORG./a', reg)?.id).toBe('V2');
    expect(matchAllowedSource('https://openimages-test.org.evil.com/a', reg)).toBeNull();
    expect(matchAllowedSource('https://notopenimages-test.org/a', reg)).toBeNull();
    expect(matchAllowedSource('https://atlas.example-med.org/cases/123', reg)?.id).toBe('V1');
    expect(matchAllowedSource('https://atlas.example-med.org/articles/123', reg)).toBeNull();
    expect(matchAllowedSource('https://atlas.example-med.org/cases/../articles/1', reg)).toBeNull();
    expect(matchAllowedSource('ftp://openimages-test.org/a', reg)).toBeNull();
    expect(matchAllowedSource('javascript:alert(1)', reg)).toBeNull();
    expect(matchAllowedSource('https://user:pw@openimages-test.org/a', reg)).toBeNull();
    expect(matchAllowedSource('not a url', reg)).toBeNull();
  });

  it('normalizeDomain keeps a public host (and the path as the atlas), rejects IPs, local names, ports, credentials', () => {
    expect(normalizeDomain('https://www.Atlas.Example-Med.org/cases/')).toEqual({ domain: 'atlas.example-med.org', path: '/cases/' });
    expect(normalizeDomain('openimages-test.org')).toEqual({ domain: 'openimages-test.org', path: null });
    for (const bad of ['127.0.0.1', 'http://[::1]/', 'localhost', 'printer.local', 'intranet', 'example.org:8443', 'https://a:b@example.org', 'file:///etc/passwd']) {
      expect(() => normalizeDomain(bad), bad).toThrow();
    }
    // the URL parser resolves dot-segments: what is stored is the resolved path, never a traversal
    expect(normalizeDomain('https://x-test.org/../../a')).toEqual({ domain: 'x-test.org', path: '/a' });
  });
});

describe('registry API, image matching, fetch gate, export', () => {
  let t: TestApp;
  let h: AuthHeaders;
  beforeAll(async () => {
    t = await createTestApp();
    h = await t.login();
  });
  afterAll(async () => t.close());
  const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => t.app.inject({ method, url, headers: h, payload: payload as never });

  let entry: VisualSourceView;
  it('create / list / duplicate / validation; the list says fetching is disabled on this server', async () => {
    const empty = (await call('GET', '/api/media/visual-sources')).json() as VisualSourceListResponse;
    expect(empty.items).toEqual([]);
    expect(empty.fetch).toMatchObject({ server_allows: false, provider_available: false, state: 'disabled' });
    expect(empty.fetch.reason_ar).toContain('MEDLEVO_ALLOW_EXTERNAL_FETCH');

    const res = await call('POST', '/api/media/visual-sources', { name: 'Atlas (TEST)', domain: 'https://www.atlas.example-med.org/cases/', kind: 'atlas', licence_note: 'CC BY-NC-SA — للدراسة الشخصية' });
    expect(res.statusCode, res.body).toBe(201);
    entry = (res.json() as { item: VisualSourceView }).item;
    expect(entry).toMatchObject({ name: 'Atlas (TEST)', domain: 'atlas.example-med.org', path_prefix: '/cases/', kind: 'atlas', kind_label_ar: 'أطلس صور', enabled: true, licence_note: 'CC BY-NC-SA — للدراسة الشخصية' });

    const dup = await call('POST', '/api/media/visual-sources', { name: 'Again', domain: 'atlas.example-med.org', path_prefix: '/cases/' });
    expect(dup.statusCode).toBe(409);
    expect(dup.body).toContain('مسجّل مسبقًا');
    const bad = await call('POST', '/api/media/visual-sources', { name: 'Local', domain: '192.168.1.10' });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).toContain('IP');
    expect((await call('POST', '/api/media/visual-sources', { name: '', domain: 'x.org' })).statusCode).toBe(400);
    // CSRF: a mutation without the header is refused
    const noCsrf = await t.app.inject({ method: 'POST', url: '/api/media/visual-sources', headers: { cookie: h.cookie }, payload: { name: 'X', domain: 'x-test.org' } });
    expect(noCsrf.statusCode).toBe(403);
    expect((await t.app.inject({ method: 'GET', url: '/api/media/visual-sources' })).statusCode).toBe(401);

    const list = (await call('GET', '/api/media/visual-sources')).json() as VisualSourceListResponse;
    expect(list.items.map((i) => i.id)).toEqual([entry.id]);
    expect(t.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM change_log WHERE entity_type = 'visual_source' AND entity_id = ? AND action = 'create'`, [entry.id])!.n).toBe(1);
  });

  it('/images/match: an external picture is excluded until its site is an ENABLED entry, and again after disabling', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6360f8cfc0000003010100c9fe92ef0000000049454e44ae426082', 'hex');
    const file = await t.ctx.files.put(png, { mime: 'image/png', originalName: 'ext.png' });
    const now = t.ctx.clock.now();
    const imgId = newId(now);
    t.ctx.db.run(
      `INSERT INTO image_asset (id, file_id, origin, image_kind, modality, anatomic_region, caption, original_url, match_status, created_at)
       VALUES (?, ?, 'external', 'radiology', 'x-ray', 'chest', 'Chest X-ray: right pneumothorax (TEST)', 'https://atlas.example-med.org/cases/ptx-1', 'unverified', ?)`,
      [imgId, file.id, now],
    );
    const match = async () => (await call('POST', '/api/media/images/match', { request })).json() as ImageMatchResponse;
    let m = await match();
    expect(m.accepted.map((a) => a.image.id)).toContain(imgId);
    // disable the entry: excluded with the registry reason
    const off = await call('PATCH', `/api/media/visual-sources/${entry.id}`, { enabled: false });
    expect(off.statusCode, off.body).toBe(200);
    expect((off.json() as { item: VisualSourceView }).item.enabled).toBe(false);
    m = await match();
    const ex = m.excluded.find((e) => e.image.id === imgId)!;
    expect(ex.validation.checks.find((c) => c.check === 'allowed_source')!.passed).toBe(false);
    expect(m.accepted.some((a) => a.image.id === imgId)).toBe(false);
    // narrowing the atlas path to another collection also excludes it
    await call('PATCH', `/api/media/visual-sources/${entry.id}`, { enabled: true, path_prefix: '/articles/' });
    m = await match();
    expect(m.excluded.find((e) => e.image.id === imgId)!.validation.reasons_ar.join(' ')).toContain('atlas.example-med.org');
    await call('PATCH', `/api/media/visual-sources/${entry.id}`, { path_prefix: '/cases/' });
    expect((await match()).accepted.map((a) => a.image.id)).toContain(imgId);
    expect(t.ctx.db.all<{ action: string }>(`SELECT action FROM change_log WHERE entity_type = 'visual_source' AND entity_id = ? ORDER BY created_at, id`, [entry.id]).map((r) => r.action)).toEqual(
      expect.arrayContaining(['create', 'disable', 'enable', 'update']),
    );
  });

  it('the fetch gate: refused while the server switch is off, even for a listed site', () => {
    expect(() => assertExternalFetchAllowed(t.ctx, 'https://atlas.example-med.org/cases/ptx-1')).toThrow(/MEDLEVO_ALLOW_EXTERNAL_FETCH/);
  });

  it('the full JSON export carries the registry (owner data); delete removes the entry and is logged', async () => {
    const res = await call('GET', '/api/data/export/all?format=json');
    const body = JSON.parse(res.body) as { manifest: ExportManifest; data: Record<string, Array<Record<string, unknown>>> };
    expect(body.data.visual_source?.map((r) => r.domain)).toEqual(['atlas.example-med.org']);
    expect(body.manifest.entities).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'visual_source', id: entry.id })]));
    expect((await call('DELETE', `/api/media/visual-sources/${entry.id}`)).statusCode).toBe(200);
    expect(((await call('GET', '/api/media/visual-sources')).json() as VisualSourceListResponse).items).toEqual([]);
    expect((await call('DELETE', `/api/media/visual-sources/${entry.id}`)).statusCode).toBe(404);
    expect(t.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM change_log WHERE entity_type = 'visual_source' AND action = 'delete'`)!.n).toBe(1);
  });
});

describe('fetch gate with the server switch ON', () => {
  let t: TestApp;
  let h: AuthHeaders;
  beforeAll(async () => {
    t = await createTestApp({ env: { MEDLEVO_ALLOW_EXTERNAL_FETCH: 'true' } });
    h = await t.login();
  });
  afterAll(async () => t.close());

  it('allows only an enabled entry; the list says there is still no provider (nothing fetched)', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/media/visual-sources', headers: h, payload: { name: 'Open images (TEST)', domain: 'openimages-test.org' } });
    expect(res.statusCode, res.body).toBe(201);
    const id = (res.json() as { item: VisualSourceView }).item.id;
    expect(assertExternalFetchAllowed(t.ctx, 'https://cdn.openimages-test.org/a.png').id).toBe(id);
    expect(() => assertExternalFetchAllowed(t.ctx, 'https://elsewhere-test.org/a.png')).toThrow(/ليس من مصدر بصري سمحت به/);
    await t.app.inject({ method: 'PATCH', url: `/api/media/visual-sources/${id}`, headers: h, payload: { enabled: false } });
    expect(() => assertExternalFetchAllowed(t.ctx, 'https://cdn.openimages-test.org/a.png')).toThrow(/ليس من مصدر بصري سمحت به/);
    const list = (await t.app.inject({ method: 'GET', url: '/api/media/visual-sources', headers: h })).json() as VisualSourceListResponse;
    expect(list.fetch).toMatchObject({ server_allows: true, provider_available: false, state: 'not_implemented' });
    // the capability stays honest: external image search is not built
    const caps = (await t.app.inject({ method: 'GET', url: '/api/capabilities', headers: h })).json() as { features: Record<string, { state: string; reason_ar?: string }> };
    expect(caps.features['external.images']!.state).toBe('not_implemented');
    expect(caps.features['external.images']!.reason_ar).toContain('سجل المصادر البصرية');
  });
});
