// Web reference images («صور من الويب»): every adapter's parsing and licence filter against canned answers, the
// Arabic → English query, the allow-list + SSRF refusals, the signed proxy-and-cache, the reference cards, and the
// honest disabled state. A fake HTTP layer sits UNDER the real SSRF guard and allow-list — no real network.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WebImageRefView, WebImageResult, WebImageSearchResponse, WebImageStatusResponse } from '@medlevo/shared';
import type { Resolver, Transport, TransportRequest } from '../../src/lib/ssrf-guard';
import { ThumbCache } from '../../src/modules/media/web-images/cache';
import { createWebHttp } from '../../src/modules/media/web-images/http';
import { isFreeLicence, parseGoogle, parseOpenI, parseWikimedia } from '../../src/modules/media/web-images/providers';
import { buildQuery } from '../../src/modules/media/web-images/query';
import { webImagesOf } from '../../src/modules/media/web-images/routes';
import { createTestApp, type AuthHeaders, type TestApp } from '../helpers/app';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake-png-body')]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('fake-jpeg')]);

const WM_THUMB = 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Colon_adenocarcinoma_HE.jpg/640px-Colon_adenocarcinoma_HE.jpg';
const wikimediaJson = {
  query: {
    pages: [
      {
        title: 'File:Colon adenocarcinoma HE.jpg',
        index: 1,
        imageinfo: [
          {
            thumburl: WM_THUMB,
            url: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Colon_adenocarcinoma_HE.jpg',
            descriptionurl: 'https://commons.wikimedia.org/wiki/File:Colon_adenocarcinoma_HE.jpg',
            mime: 'image/jpeg',
            width: 2000,
            height: 1500,
            extmetadata: {
              License: { value: 'cc-by-sa-4.0' },
              LicenseShortName: { value: 'CC BY-SA 4.0' },
              LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/4.0' },
              Artist: { value: '<a href="//commons.wikimedia.org/wiki/User:Nephron">Nephron</a>' },
              ImageDescription: { value: 'Micrograph of <b>colorectal adenocarcinoma</b>, H&amp;E stain.' },
            },
          },
        ],
      },
      {
        title: 'File:Non free logo.png',
        index: 2,
        imageinfo: [{ thumburl: 'https://upload.wikimedia.org/x/640px-logo.png', url: 'https://upload.wikimedia.org/x/logo.png', descriptionurl: 'https://commons.wikimedia.org/wiki/File:logo.png', mime: 'image/png', extmetadata: { License: { value: 'cc-by-nc-4.0' }, LicenseShortName: { value: 'CC BY-NC 4.0' } } }],
      },
      {
        title: 'File:Lecture.pdf',
        index: 3,
        imageinfo: [{ thumburl: 'https://upload.wikimedia.org/x/page1-640px-Lecture.pdf.jpg', url: 'https://upload.wikimedia.org/x/Lecture.pdf', descriptionurl: 'https://commons.wikimedia.org/wiki/File:Lecture.pdf', mime: 'application/pdf', extmetadata: { License: { value: 'cc0' } } }],
      },
      {
        title: 'File:Elsewhere.jpg',
        index: 4,
        imageinfo: [{ thumburl: 'https://evil.example.com/640px-x.jpg', url: 'https://evil.example.com/x.jpg', descriptionurl: 'https://commons.wikimedia.org/wiki/File:x.jpg', mime: 'image/jpeg', extmetadata: { License: { value: 'pd' } } }],
      },
    ],
  },
};

const openiJson = {
  total: 2,
  list: [
    {
      uid: 'PMC1',
      title: 'Granulomatous inflammation in <b>sarcoidosis</b>',
      authors: 'Smith A, Jones B, Lee C, Kim D',
      image: { caption: 'Non-caseating <b>granuloma</b> with giant cells (H&E).' },
      imgGrid150: '/imgs/150/1/1/PMC1_fig1.png',
      imgLarge: '/imgs/512/1/1/PMC1_fig1.png',
      pmc_url: 'http://www.ncbi.nlm.nih.gov/pmc/articles/PMC1',
      ccLicense: 'by',
      licenseURL: 'https://creativecommons.org/licenses/by/4.0/',
      detailedQueryURL: '/search?img=PMC1_fig1&query=granuloma&req=4',
    },
    { uid: 'PMC2', title: 'Bad path', imgGrid150: '/imgs/../../etc/passwd.png', pmc_url: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC2' },
  ],
};

const googleJson = {
  items: [
    {
      title: 'Granuloma histology - pathology atlas',
      link: 'https://atlas.example.org/granuloma.jpg',
      displayLink: 'atlas.example.org',
      image: { contextLink: 'https://atlas.example.org/granuloma', thumbnailLink: 'https://encrypted-tbn0.gstatic.com/images?q=tbn:abc', width: 800, height: 600 },
    },
    // the same Commons file Wikimedia already returned — de-duplicated
    { title: 'Colon adenocarcinoma', link: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Colon_adenocarcinoma_HE.jpg', image: { contextLink: 'https://commons.wikimedia.org/wiki/File:Colon_adenocarcinoma_HE.jpg', thumbnailLink: 'https://encrypted-tbn1.gstatic.com/images?q=tbn:def' } },
    // a thumbnail outside Google's CDN is never fetched
    { title: 'x', link: 'https://x.example.org/a.jpg', image: { contextLink: 'https://x.example.org/', thumbnailLink: 'https://x.example.org/thumb.jpg' } },
  ],
};

// ── the fake network: a public address for every name (unless told otherwise) and canned answers per host ──
interface Fake {
  calls: string[];
  transport: Transport;
  resolver: Resolver;
  privateHosts: Set<string>;
  images: Map<string, { body: Buffer; type: string }>;
}
function fakeNet(): Fake {
  const calls: string[] = [];
  const privateHosts = new Set<string>();
  const images = new Map<string, { body: Buffer; type: string }>();
  const json = (body: unknown) => ({ status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, body: Buffer.from(JSON.stringify(body)) });
  const transport: Transport = async (req: TransportRequest) => {
    const u = req.url.toString();
    calls.push(u);
    if (req.url.hostname === 'commons.wikimedia.org') return json(wikimediaJson);
    if (req.url.hostname === 'openi.nlm.nih.gov' && req.url.pathname === '/api/search') return json(openiJson);
    if (req.url.hostname === 'www.googleapis.com') return json(googleJson);
    const img = images.get(u);
    if (img) return { status: 200, headers: { 'content-type': img.type }, body: img.body };
    return { status: 404, headers: {} as Record<string, string>, body: Buffer.alloc(0) };
  };
  const resolver: Resolver = async (host) => [{ address: privateHosts.has(host) ? '10.0.0.5' : '93.184.216.34', family: 4 }];
  return { calls, transport, resolver, privateHosts, images };
}

describe('adapters: parsing and licence filtering (pure)', () => {
  it('Wikimedia: free licences only, raster from the CDN only, attribution from extmetadata (HTML stripped)', () => {
    const r = parseWikimedia(wikimediaJson);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      provider: 'wikimedia',
      author: 'Nephron',
      license: 'CC BY-SA 4.0',
      license_url: 'https://creativecommons.org/licenses/by-sa/4.0',
      usage: 'free_licence',
      page_url: 'https://commons.wikimedia.org/wiki/File:Colon_adenocarcinoma_HE.jpg',
      caption: 'Micrograph of colorectal adenocarcinoma , H&E stain.',
      thumb_remote: WM_THUMB,
    });
    expect(isFreeLicence('cc0', null)).toBe(true);
    expect(isFreeLicence('pd', 'Public domain')).toBe(true);
    expect(isFreeLicence('cc-by-3.0', 'CC BY 3.0')).toBe(true);
    expect(isFreeLicence('cc-by-nc-sa-4.0', 'CC BY-NC-SA 4.0')).toBe(false);
    expect(isFreeLicence('cc-by-nd-4.0', null)).toBe(false);
    expect(isFreeLicence(null, 'Fair use')).toBe(false);
    expect(isFreeLicence(null, null)).toBe(false);
  });

  it('Open-i: caption, article link (https), authors shortened, article licence; unsafe image paths refused', () => {
    const r = parseOpenI(openiJson);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      provider: 'openi',
      title: 'Granulomatous inflammation in sarcoidosis',
      caption: 'Non-caseating granuloma with giant cells (H&E).',
      author: 'Smith A, Jones B, Lee C et al.',
      license: 'CC BY (ترخيص المقال)',
      usage: 'linked_preview',
      page_url: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC1',
      thumb_remote: 'https://openi.nlm.nih.gov/imgs/150/1/1/PMC1_fig1.png',
      large_remote: 'https://openi.nlm.nih.gov/imgs/512/1/1/PMC1_fig1.png',
    });
  });

  it('Google: only Google-CDN thumbnails, the page and the site credited, licence unknown → linked preview', () => {
    const r = parseGoogle(googleJson);
    expect(r.map((x) => x.thumb_remote)).toEqual(['https://encrypted-tbn0.gstatic.com/images?q=tbn:abc', 'https://encrypted-tbn1.gstatic.com/images?q=tbn:def']);
    expect(r[0]).toMatchObject({ author: 'atlas.example.org', usage: 'linked_preview', page_url: 'https://atlas.example.org/granuloma' });
    expect(r[0]!.license).toContain('حقوق الصورة لأصحابها');
  });

  it('Arabic queries become English medical terms with the built-in dictionary; unknown words are reported', () => {
    expect(buildQuery('سرطان غدي في القولون').en).toBe('adenocarcinoma colon');
    expect(buildQuery('ورم حبيبي نسيجي').en).toBe('granuloma histology');
    expect(buildQuery('Granuloma histology').en).toBe('granuloma histology');
    const mixed = buildQuery('صورة granuloma في الرئة زرقاوي');
    expect(mixed.en).toBe('granuloma lung');
    expect(mixed.untranslated).toEqual(['زرقاوي']);
    expect(mixed.translated).toEqual([{ ar: 'الرئة', en: 'lung' }]);
  });
});

describe('the HTTP layer: allow-list and SSRF guard', () => {
  it('refuses hosts outside the allow-list before any DNS or connection; refuses private addresses; re-checks redirects', async () => {
    const net = fakeNet();
    const http = createWebHttp({ allowExternalFetch: true, transport: net.transport, resolver: net.resolver });
    await expect(http.getImage('https://evil.example.com/x.png')).rejects.toMatchObject({ status: 403 });
    await expect(http.getJson('https://example.org/api')).rejects.toMatchObject({ status: 403 });
    await expect(http.getImage('http://upload.wikimedia.org/x.png')).rejects.toMatchObject({ status: 403 });
    expect(net.calls).toEqual([]);
    net.privateHosts.add('upload.wikimedia.org');
    await expect(http.getImage('https://upload.wikimedia.org/x.png')).rejects.toThrow(/داخلي|محجوز/);
    expect(net.calls).toEqual([]);

    const redirecting: Transport = async (req) => {
      net.calls.push(req.url.toString());
      return { status: 302, headers: { location: 'https://evil.example.com/steal.png' }, body: Buffer.alloc(0) };
    };
    const http2 = createWebHttp({ allowExternalFetch: true, transport: redirecting, resolver: async () => [{ address: '93.184.216.34', family: 4 }] });
    await expect(http2.getImage('https://openi.nlm.nih.gov/imgs/1.png')).rejects.toThrow(/قائمة المصادر المسموح بها/);
    expect(net.calls).toEqual(['https://openi.nlm.nih.gov/imgs/1.png']);
  });

  it('pictures: the declared type AND the bytes must be JPEG / PNG / GIF / WebP (SVG and HTML refused)', async () => {
    const svg: Transport = async () => ({ status: 200, headers: { 'content-type': 'image/svg+xml' }, body: Buffer.from('<svg onload=alert(1)>') });
    const http = createWebHttp({ allowExternalFetch: true, transport: svg, resolver: async () => [{ address: '93.184.216.34', family: 4 }] });
    await expect(http.getImage('https://upload.wikimedia.org/a.svg')).rejects.toMatchObject({ status: 415 });
    const lying: Transport = async () => ({ status: 200, headers: { 'content-type': 'image/png' }, body: Buffer.from('<html>') });
    const http2 = createWebHttp({ allowExternalFetch: true, transport: lying, resolver: async () => [{ address: '93.184.216.34', family: 4 }] });
    await expect(http2.getImage('https://upload.wikimedia.org/a.png')).rejects.toMatchObject({ status: 415 });
  });

  it('the server switch off: nothing is contacted at all', async () => {
    const net = fakeNet();
    const http = createWebHttp({ allowExternalFetch: false, transport: net.transport, resolver: net.resolver });
    await expect(http.getJson('https://commons.wikimedia.org/w/api.php')).rejects.toMatchObject({ status: 409 });
    expect(net.calls).toEqual([]);
  });
});

describe('thumbnail cache (content-addressed, size-capped)', () => {
  it('one copy per picture, LRU eviction under the cap', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ml-webimg-'));
    try {
      const c = new ThumbCache(dir, 100);
      const a = c.put('https://upload.wikimedia.org/a.png', Buffer.concat([PNG, Buffer.alloc(30)]), 'image/png');
      c.put('https://upload.wikimedia.org/a-again.png', Buffer.concat([PNG, Buffer.alloc(30)]), 'image/png');
      expect(c.size()).toBe(a.body.length);
      expect(c.get('https://upload.wikimedia.org/a-again.png')!.sha).toBe(a.sha);
      c.put('https://upload.wikimedia.org/b.png', Buffer.concat([PNG, Buffer.alloc(60, 1)]), 'image/png');
      expect(c.size()).toBeLessThanOrEqual(100);
      expect(c.get('https://upload.wikimedia.org/a.png')).toBeNull();
      expect(c.get('https://upload.wikimedia.org/b.png')).not.toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('disabled (MEDLEVO_ALLOW_EXTERNAL_FETCH off — the default)', () => {
  let t: TestApp;
  let h: AuthHeaders;
  beforeAll(async () => {
    t = await createTestApp();
    h = await t.login();
  });
  afterAll(async () => t.close());

  it('the state is honest everywhere and a search contacts nothing', async () => {
    const net = fakeNet();
    webImagesOf(t.ctx).useTransport(net.transport, net.resolver);
    const s = (await t.app.inject({ method: 'GET', url: '/api/media/web-images/status', headers: h })).json() as WebImageStatusResponse;
    expect(s.state).toBe('requires_configuration');
    expect(s.reason_ar).toContain('MEDLEVO_ALLOW_EXTERNAL_FETCH');
    expect(s.how_to_enable_ar.join(' ')).toContain('wrangler.jsonc');
    expect(s.providers.find((p) => p.provider === 'google')!.reason_ar).toContain('يحتاج مفتاح Google');
    const caps = (await t.app.inject({ method: 'GET', url: '/api/capabilities', headers: h })).json() as { features: Record<string, { state: string; reason_ar?: string }> };
    expect(caps.features['external.images']).toMatchObject({ state: 'requires_configuration', reason_ar: expect.stringContaining('MEDLEVO_ALLOW_EXTERNAL_FETCH') });
    const media = (await t.app.inject({ method: 'GET', url: '/api/media/status', headers: h })).json() as { external_image_search: { state: string } };
    expect(media.external_image_search.state).toBe('requires_configuration');
    const res = await t.app.inject({ method: 'POST', url: '/api/media/web-images/search', headers: h, payload: { query: 'granuloma' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('FEATURE_DISABLED');
    expect(net.calls).toEqual([]);
  });
});

describe('enabled: search, proxy, reference cards', () => {
  let t: TestApp;
  let h: AuthHeaders;
  const net = fakeNet();
  beforeAll(async () => {
    t = await createTestApp({ env: { MEDLEVO_ALLOW_EXTERNAL_FETCH: 'true' } });
    h = await t.login();
    webImagesOf(t.ctx).useTransport(net.transport, net.resolver);
  });
  afterAll(async () => t.close());

  const search = async (query: string) => {
    const res = await t.app.inject({ method: 'POST', url: '/api/media/web-images/search', headers: h, payload: { query } });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as WebImageSearchResponse;
  };

  it('available; Google stays off without its key («يحتاج مفتاح Google») and is never called', async () => {
    const caps = (await t.app.inject({ method: 'GET', url: '/api/capabilities', headers: h })).json() as { features: Record<string, { state: string; reason_ar?: string }> };
    expect(caps.features['external.images']).toMatchObject({ state: 'available', reason_ar: expect.stringContaining('يحتاج مفتاح Google') });
    const r = await search('سرطان غدي في القولون');
    expect(r.query_en).toBe('adenocarcinoma colon');
    expect(r.providers.find((p) => p.provider === 'google')).toMatchObject({ state: 'requires_configuration', count: 0 });
    expect(net.calls.some((c) => c.includes('googleapis'))).toBe(false);
    const wm = new URL(net.calls.find((c) => c.includes('commons.wikimedia.org'))!);
    expect(wm.searchParams.get('gsrsearch')).toBe('adenocarcinoma colon filetype:bitmap');
    expect(r.label_ar).toBe('صورة من الويب — ليست من محاضرتك');
    expect(r.items.map((i) => i.provider).sort()).toEqual(['openi', 'wikimedia']);
    for (const i of r.items) {
      expect(i.thumb.startsWith('/api/media/web-images/thumb?u=')).toBe(true);
      expect(i.page_url).toMatch(/^https:\/\//);
      expect(i.license).toBeTruthy();
      expect(i.token.length).toBeGreaterThan(16);
    }
  });

  it('the thumbnail proxy: signed URLs only, cached by content, cache headers; a second view contacts nobody', async () => {
    const r = await search('granuloma histology');
    const wm = r.items.find((i) => i.provider === 'wikimedia')!;
    net.images.set(WM_THUMB, { body: JPEG, type: 'image/jpeg' });
    const first = await t.app.inject({ method: 'GET', url: wm.thumb, headers: h });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.headers['content-type']).toBe('image/jpeg');
    expect(first.headers['cache-control']).toContain('immutable');
    expect(first.headers['x-content-type-options']).toBe('nosniff');
    expect(first.rawPayload.equals(JPEG)).toBe(true);
    const before = net.calls.length;
    const again = await t.app.inject({ method: 'GET', url: wm.thumb, headers: h });
    expect(again.statusCode).toBe(200);
    expect(net.calls.length).toBe(before);
    const etag = again.headers.etag as string;
    expect((await t.app.inject({ method: 'GET', url: wm.thumb, headers: { ...h, 'if-none-match': etag } })).statusCode).toBe(304);

    // not signed by the server → refused (not an open proxy), even for an allow-listed host
    const forged = `/api/media/web-images/thumb?u=${encodeURIComponent('https://upload.wikimedia.org/other.png')}&s=AAAAAAAAAAAAAAAAAAAAAAAA`;
    expect((await t.app.inject({ method: 'GET', url: forged, headers: h })).statusCode).toBe(403);
    // signed but outside the allow-list → refused, nothing contacted
    const evil = webImagesOf(t.ctx).proxied('https://evil.example.com/a.png');
    const n = net.calls.length;
    expect((await t.app.inject({ method: 'GET', url: evil, headers: h })).statusCode).toBe(403);
    expect(net.calls.length).toBe(n);
    // the session is required
    expect((await t.app.inject({ method: 'GET', url: wm.thumb })).statusCode).toBe(401);
  });

  it('«أضف إلى ملاحظاتي»: a reference card keeping the attribution; a changed credit is refused; listed, exported, removed', async () => {
    const r = await search('granuloma');
    const item = r.items.find((i) => i.provider === 'openi')!;
    const tampered: WebImageResult = { ...item, license: 'CC0', author: 'Me' };
    const bad = await t.app.inject({ method: 'POST', url: '/api/media/web-images/refs', headers: h, payload: { result: tampered, source_id: 'S1' } });
    expect(bad.statusCode).toBe(403);
    const ok = await t.app.inject({ method: 'POST', url: '/api/media/web-images/refs', headers: h, payload: { result: item, query: 'granuloma', source_id: 'S1', page_id: 'P3' } });
    expect(ok.statusCode, ok.body).toBe(201);
    const ref = (ok.json() as { item: WebImageRefView }).item;
    expect(ref).toMatchObject({ provider: 'openi', license: item.license, author: item.author, page_url: item.page_url, label_ar: 'صورة من الويب — ليست من محاضرتك', source_id: 'S1', usage: 'linked_preview' });
    // pinning twice keeps one card
    const twice = await t.app.inject({ method: 'POST', url: '/api/media/web-images/refs', headers: h, payload: { result: item, source_id: 'S1' } });
    expect((twice.json() as { item: WebImageRefView }).item.id).toBe(ref.id);
    const list = (await t.app.inject({ method: 'GET', url: '/api/media/web-images/refs?source_id=S1', headers: h })).json() as { items: WebImageRefView[] };
    expect(list.items.map((x) => x.id)).toEqual([ref.id]);
    expect((await t.app.inject({ method: 'GET', url: '/api/media/web-images/refs?source_id=S2', headers: h })).json().items).toEqual([]);
    // the card's picture is still served through the proxy
    net.images.set('https://openi.nlm.nih.gov/imgs/150/1/1/PMC1_fig1.png', { body: PNG, type: 'image/png' });
    expect((await t.app.inject({ method: 'GET', url: ref.thumb, headers: h })).statusCode).toBe(200);
    expect(t.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM change_log WHERE entity_type = 'web_image_ref' AND action = 'create'`)!.n).toBe(1);
    const del = await t.app.inject({ method: 'DELETE', url: `/api/media/web-images/refs/${ref.id}`, headers: h });
    expect(del.statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/api/media/web-images/refs', headers: h })).json().items).toEqual([]);
  });

  it('a provider on a private address fails alone, with its reason; the others still answer', async () => {
    net.privateHosts.add('openi.nlm.nih.gov');
    const r = await search('granuloma lung');
    const openi = r.providers.find((p) => p.provider === 'openi')!;
    expect(openi.error_ar).toBeTruthy();
    expect(r.items.every((i) => i.provider === 'wikimedia')).toBe(true);
    expect(net.calls.some((c) => c.startsWith('https://openi.nlm.nih.gov/api/search?query=granuloma+lung'))).toBe(false);
    net.privateHosts.delete('openi.nlm.nih.gov');
  });

  it('a query the dictionary cannot translate is refused with the reason (nothing sent)', async () => {
    const n = net.calls.length;
    const res = await t.app.inject({ method: 'POST', url: '/api/media/web-images/search', headers: h, payload: { query: 'زرقاوي جدا' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('بالإنجليزية');
    expect(net.calls.length).toBe(n);
  });
});

describe('enabled with Google keys', () => {
  let t: TestApp;
  let h: AuthHeaders;
  const net = fakeNet();
  beforeAll(async () => {
    t = await createTestApp({ env: { MEDLEVO_ALLOW_EXTERNAL_FETCH: 'true', GOOGLE_CSE_KEY: 'test-google-key-123', GOOGLE_CSE_ID: 'cx-test' } });
    h = await t.login();
    webImagesOf(t.ctx).useTransport(net.transport, net.resolver);
  });
  afterAll(async () => t.close());

  it('Google Programmable Search with safe search and image type; merged and de-duplicated; the key never reaches the client', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/media/web-images/search', headers: h, payload: { query: 'adenocarcinoma colon' } });
    expect(res.statusCode, res.body).toBe(200);
    const r = res.json() as WebImageSearchResponse;
    const g = new URL(net.calls.find((c) => c.startsWith('https://www.googleapis.com/customsearch/v1'))!);
    expect(g.searchParams.get('searchType')).toBe('image');
    expect(g.searchParams.get('safe')).toBe('active');
    expect(g.searchParams.get('cx')).toBe('cx-test');
    expect(r.providers.find((p) => p.provider === 'google')).toMatchObject({ state: 'available', count: 2 });
    // the Google copy of the Commons file is dropped: one result for that picture
    expect(r.items.filter((i) => i.image_url.endsWith('Colon_adenocarcinoma_HE.jpg'))).toHaveLength(1);
    expect(r.items.map((i) => i.provider).sort()).toEqual(['google', 'openi', 'wikimedia']);
    expect(res.body).not.toContain('test-google-key-123');
    // never the third-party site itself, only Google's thumbnail CDN
    expect(r.items.find((i) => i.provider === 'google')!.thumb).toContain(encodeURIComponent('https://encrypted-tbn0.gstatic.com/'));
  });
});
