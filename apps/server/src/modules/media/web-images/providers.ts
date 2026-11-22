// Image search providers («ImageSearchProvider»): each adapter builds its API URL (allow-listed host), parses the
// answer into RawWebImage with the attribution, and drops what it may not show. Parsing is pure (tested with canned
// answers); the network goes through WebHttp only.
//   * Wikimedia Commons — files in the File namespace, raster thumbnails only, FREE licences only (CC0 / public domain /
//     CC BY / CC BY-SA / GFDL / FAL); author and licence from extmetadata.
//   * NLM Open-i — figures from PubMed Central articles with their captions; shown as linked previews (the article's
//     licence is reported, the picture stays the article's).
//   * Google Programmable Search (Custom Search JSON API, searchType=image, safe=active) — only with GOOGLE_CSE_KEY and
//     GOOGLE_CSE_ID; only Google's own thumbnail is ever fetched (never the third-party site); a linked preview.
import type { FeatureState, WebImageProvider, WebImageUsage } from '@medlevo/shared';
import type { WebHttp } from './http';
import { isAllowedImageUrl } from './http';
import { UNSAFE_TERMS } from './query';

export interface RawWebImage {
  provider: WebImageProvider;
  title: string;
  caption: string | null;
  author: string | null;
  license: string | null;
  license_url: string | null;
  usage: WebImageUsage;
  page_url: string;
  image_url: string;
  /** remote, allow-listed: the proxy fetches these */
  thumb_remote: string;
  large_remote: string;
  width: number | null;
  height: number | null;
  /** position in the provider's own ranking (0 = first) */
  rank: number;
}

export interface ProviderState {
  state: FeatureState;
  reason_ar?: string;
}

export interface ImageSearchProvider {
  readonly id: WebImageProvider;
  /** whether it can run (configuration only; the server switch is checked by the service) */
  state(): ProviderState;
  search(query: string, limit: number, http: WebHttp, signal?: AbortSignal): Promise<RawWebImage[]>;
}

// ───────── helpers ─────────
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
export function stripHtml(s: unknown, max = 600): string | null {
  if (typeof s !== 'string') return null;
  const t = s
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+\d*);/gi, (m, e: string) => {
      const k = e.toLowerCase();
      if (ENTITIES[k]) return ENTITIES[k];
      if (k.startsWith('#x')) return String.fromCodePoint(parseInt(k.slice(2), 16) || 32);
      if (k.startsWith('#')) return String.fromCodePoint(Number(k.slice(1)) || 32);
      return m;
    })
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** only https / http links leave the server as clickable links (http is upgraded for the known hosts) */
export function safeLink(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const u = new URL(raw.startsWith('//') ? `https:${raw}` : raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.username || u.password) return null;
    if (u.protocol === 'http:' && /(^|\.)(nih\.gov|wikimedia\.org|wikipedia\.org)$/.test(u.hostname)) u.protocol = 'https:';
    return u.toString();
  } catch {
    return null;
  }
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null);
const unsafe = (...texts: Array<string | null>) => texts.some((t) => t !== null && UNSAFE_TERMS.test(t));

// ───────── Wikimedia Commons ─────────
/** a free licence by Commons' own machine-readable code / short name (anything else is left out) */
export function isFreeLicence(code: string | null, shortName: string | null): boolean {
  const c = (code ?? '').toLowerCase().trim();
  const n = (shortName ?? '').toLowerCase().trim();
  if (/(^|[-\s])(nc|nd)([-\s]|$)/.test(c) || /\b(nc|nd|non-?commercial|no ?deriv|fair use)\b/.test(n)) return false;
  if (/^(cc0|cc-zero|pd|pd-\S+|public domain|cc-by(-sa)?(-\d(\.\d)?)?(-\S+)?|gfdl(-\S+)?|fal|attribution|attribution-sa)$/.test(c)) return true;
  return /^(cc0|public domain|cc by(-sa)? \d(\.\d)?|cc-by(-sa)?-\d(\.\d)?|gfdl|free art licen[cs]e|attribution)/.test(n);
}

export function wikimediaUrl(query: string, limit: number): string {
  const p = new URLSearchParams({
    action: 'query',
    format: 'json',
    formatversion: '2',
    generator: 'search',
    gsrsearch: `${query} filetype:bitmap`,
    gsrnamespace: '6',
    gsrlimit: String(Math.min(limit, 30)),
    prop: 'imageinfo',
    iiprop: 'url|mime|size|extmetadata',
    iiurlwidth: '640',
    iiextmetadatafilter: 'LicenseShortName|License|LicenseUrl|Artist|Credit|ImageDescription|ObjectName|AttributionRequired',
    origin: '*',
  });
  return `https://commons.wikimedia.org/w/api.php?${p.toString()}`;
}

interface WmPage {
  title?: string;
  index?: number;
  imageinfo?: Array<{
    thumburl?: string;
    thumbwidth?: number;
    thumbheight?: number;
    url?: string;
    descriptionurl?: string;
    mime?: string;
    width?: number;
    height?: number;
    extmetadata?: Record<string, { value?: unknown } | undefined>;
  }>;
}

export function parseWikimedia(json: unknown): RawWebImage[] {
  const pages = ((json as { query?: { pages?: WmPage[] | Record<string, WmPage> } })?.query?.pages ?? []) as WmPage[] | Record<string, WmPage>;
  const list = (Array.isArray(pages) ? pages : Object.values(pages)).slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const out: RawWebImage[] = [];
  list.forEach((p, i) => {
    const info = p.imageinfo?.[0];
    if (!info) return;
    const meta = info.extmetadata ?? {};
    const v = (k: string) => (meta[k]?.value === undefined ? null : String(meta[k]!.value));
    const code = v('License');
    const shortName = stripHtml(v('LicenseShortName'), 80);
    if (!isFreeLicence(code, shortName)) return;
    if (!info.mime || !/^image\/(jpeg|png|gif|webp|tiff|svg\+xml)$/.test(info.mime)) return;
    const thumb = info.thumburl ?? null;
    if (!thumb || !isAllowedImageUrl(thumb)) return;
    const page = safeLink(info.descriptionurl);
    const original = safeLink(info.url);
    if (!page || !original) return;
    const title = stripHtml(v('ObjectName'), 200) ?? (p.title ?? '').replace(/^File:/, '').replace(/\.[a-z0-9]{2,5}$/i, '').replace(/_/g, ' ');
    const caption = stripHtml(v('ImageDescription'));
    if (unsafe(title, caption)) return;
    out.push({
      provider: 'wikimedia',
      title: title || 'Wikimedia Commons file',
      caption,
      author: stripHtml(v('Artist'), 200) ?? stripHtml(v('Credit'), 200),
      license: shortName ?? code,
      license_url: safeLink(v('LicenseUrl')),
      usage: 'free_licence',
      page_url: page,
      image_url: original,
      thumb_remote: thumb,
      large_remote: thumb,
      width: num(info.width),
      height: num(info.height),
      rank: i,
    });
  });
  return out;
}

export const wikimediaProvider: ImageSearchProvider = {
  id: 'wikimedia',
  state: () => ({ state: 'available' }),
  async search(query, limit, http, signal) {
    return parseWikimedia(await http.getJson(wikimediaUrl(query, limit), signal));
  },
};

// ───────── NLM Open-i ─────────
const OPENI = 'https://openi.nlm.nih.gov';
export function openiUrl(query: string, limit: number): string {
  const p = new URLSearchParams({ query, m: '1', n: String(Math.min(limit, 30)) });
  return `${OPENI}/api/search?${p.toString()}`;
}

interface OpenIItem {
  uid?: string;
  title?: string;
  authors?: string;
  image?: { caption?: string; id?: string };
  imgLarge?: string;
  imgGrid150?: string;
  imgThumbLarge?: string;
  pmc_url?: string;
  pubMed_url?: string;
  detailedQueryURL?: string;
  ccLicense?: string;
  licenseURL?: string;
  journal_title?: string;
}

const openiPath = (p: unknown): string | null => (typeof p === 'string' && /^\/imgs\/[\w./-]+\.(png|jpe?g|gif)$/i.test(p) && !p.includes('..') ? `${OPENI}${p}` : null);

export function parseOpenI(json: unknown): RawWebImage[] {
  const list = ((json as { list?: OpenIItem[] })?.list ?? []) as OpenIItem[];
  const out: RawWebImage[] = [];
  list.forEach((it, i) => {
    const thumb = openiPath(it.imgGrid150) ?? openiPath(it.imgThumbLarge);
    const large = openiPath(it.imgLarge) ?? thumb;
    if (!thumb || !large) return;
    const imgId = /[?&]img=([\w.-]+)/.exec(it.detailedQueryURL ?? '')?.[1] ?? null;
    const page = safeLink(it.pmc_url) ?? safeLink(it.pubMed_url) ?? (imgId ? `${OPENI}/detailedresult?img=${encodeURIComponent(imgId)}&req=4` : null);
    if (!page) return;
    const title = stripHtml(it.title, 300) ?? 'PubMed Central figure';
    const caption = stripHtml(it.image?.caption);
    if (unsafe(title, caption)) return;
    const cc = typeof it.ccLicense === 'string' && /^[a-z-]{2,12}$/i.test(it.ccLicense) ? `CC ${it.ccLicense.toUpperCase()}` : null;
    const authors = stripHtml(it.authors, 400);
    out.push({
      provider: 'openi',
      title,
      caption,
      author: authors ? (authors.split(',').length > 3 ? `${authors.split(',').slice(0, 3).join(',').trim()} et al.` : authors) : null,
      license: cc ? `${cc} (ترخيص المقال)` : 'ترخيص المقال — راجعه في المصدر',
      license_url: safeLink(it.licenseURL),
      usage: 'linked_preview',
      page_url: page,
      image_url: large,
      thumb_remote: thumb,
      large_remote: large,
      width: null,
      height: null,
      rank: i,
    });
  });
  return out;
}

export const openiProvider: ImageSearchProvider = {
  id: 'openi',
  state: () => ({ state: 'available' }),
  async search(query, limit, http, signal) {
    return parseOpenI(await http.getJson(openiUrl(query, limit), signal));
  },
};

// ───────── Google Programmable Search (Custom Search JSON API) ─────────
export function googleUrl(query: string, limit: number, key: string, cx: string): string {
  const p = new URLSearchParams({ key, cx, q: query, searchType: 'image', safe: 'active', num: String(Math.min(limit, 10)) });
  return `https://www.googleapis.com/customsearch/v1?${p.toString()}`;
}

interface GoogleItem {
  title?: string;
  link?: string;
  displayLink?: string;
  snippet?: string;
  image?: { contextLink?: string; width?: number; height?: number; thumbnailLink?: string };
}

export function parseGoogle(json: unknown): RawWebImage[] {
  const items = ((json as { items?: GoogleItem[] })?.items ?? []) as GoogleItem[];
  const out: RawWebImage[] = [];
  items.forEach((it, i) => {
    const thumb = it.image?.thumbnailLink ?? null;
    if (!thumb || !isAllowedImageUrl(thumb)) return; // only Google's own thumbnail CDN is ever fetched
    const page = safeLink(it.image?.contextLink);
    const original = safeLink(it.link);
    if (!page || !original) return;
    const title = stripHtml(it.title, 300) ?? 'Google image result';
    const caption = stripHtml(it.snippet);
    if (unsafe(title, caption)) return;
    out.push({
      provider: 'google',
      title,
      caption,
      author: stripHtml(it.displayLink, 120),
      license: 'غير معروف — حقوق الصورة لأصحابها',
      license_url: null,
      usage: 'linked_preview',
      page_url: page,
      image_url: original,
      thumb_remote: thumb,
      large_remote: thumb,
      width: num(it.image?.width),
      height: num(it.image?.height),
      rank: i,
    });
  });
  return out;
}

export const GOOGLE_NEEDS_KEY_AR = 'يحتاج مفتاح Google: اضبط GOOGLE_CSE_KEY و GOOGLE_CSE_ID على الخادم (Programmable Search Engine مع تفعيل البحث عن الصور). دونهما يعمل البحث من ويكيميديا كومنز و Open-i فقط.';

export function googleProvider(cfg: { key: () => string | null; cx: string | null }): ImageSearchProvider {
  return {
    id: 'google',
    state: () => (cfg.key() && cfg.cx ? { state: 'available' } : { state: 'requires_configuration', reason_ar: GOOGLE_NEEDS_KEY_AR }),
    async search(query, limit, http, signal) {
      const key = cfg.key();
      if (!key || !cfg.cx) return [];
      return parseGoogle(await http.getJson(googleUrl(query, limit, key, cfg.cx), signal));
    },
  };
}
