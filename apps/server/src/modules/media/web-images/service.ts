// Web reference images («صور من الويب»): the service behind /api/media/web-images/*.
//   status()  honest state: the server switch MEDLEVO_ALLOW_EXTERNAL_FETCH, then each provider (Google needs its key)
//   search()  English medical query (built-in dictionary) → every enabled provider in parallel → merged, de-duplicated,
//             unsafe titles dropped, medical relevance boosted; each result signed (token) and its pictures proxied
//   thumb()   the proxy-and-cache: a server-signed URL only (never an open proxy), allow-listed image host, raster
//             image only, size-capped, content-addressed cache, long cache headers
//   pins      «أضف إلى ملاحظاتي»: a reference card in the owner's vault keeping the attribution (signed result only)
import { join } from 'node:path';
import {
  WEB_IMAGE_LABEL_AR,
  WEB_IMAGE_PROVIDER_LABELS_AR,
  webImagePinSchema,
  webImageSearchSchema,
  type FeatureState,
  type WebImageProvider,
  type WebImageProviderStatus,
  type WebImageRefView,
  type WebImageResult,
  type WebImageSearchResponse,
  type WebImageStatusResponse,
} from '@medlevo/shared';
import type { AppContext } from '../../../context';
import { AppError } from '../../../lib/errors';
import { hmacSha256, safeEqual, sha256 } from '../../../lib/hash';
import { parseWith } from '../../../lib/http';
import { newId } from '../../../lib/ids';
import type { Resolver, Transport } from '../../../lib/ssrf-guard';
import { ThumbCache, type CachedImage } from './cache';
import { createWebHttp, isAllowedImageUrl, type WebHttp } from './http';
import { googleProvider, GOOGLE_NEEDS_KEY_AR, openiProvider, wikimediaProvider, type ImageSearchProvider, type RawWebImage } from './providers';
import { buildQuery, MEDICAL_HINTS } from './query';

export const THUMB_ROUTE = '/api/media/web-images/thumb';
const SEARCH_TTL_MS = 10 * 60_000;
const SEARCH_CACHE_MAX = 200;
const BASE_SCORE: Record<WebImageProvider, number> = { openi: 0.45, wikimedia: 0.42, google: 0.35 };

export const DISABLED_AR =
  'البحث عن صور من الويب متوقف: الجلب من الإنترنت معطّل على الخادم (MEDLEVO_ALLOW_EXTERNAL_FETCH). لا يُرسل أي طلب إلى أي خدمة صور. يفعّله مالك الخادم بضبط MEDLEVO_ALLOW_EXTERNAL_FETCH=true ثم إعادة التشغيل.';
export const HOW_TO_ENABLE_AR = [
  'على الخادم: MEDLEVO_ALLOW_EXTERNAL_FETCH=true في ملف ‎.env‎ (أو متغيرات البيئة) ثم أعد التشغيل. على Cloudflare: في wrangler.jsonc ضمن vars القيمة "true" (نص)، ثم انشر.',
  'يتصل الخادم فقط بقائمة ثابتة: commons.wikimedia.org و upload.wikimedia.org و openi.nlm.nih.gov و www.googleapis.com و encrypted-tbn0…3.gstatic.com (صور Google المصغرة). أي مضيف آخر يُرفض.',
  'اختياري — بحث Google: أنشئ Programmable Search Engine مع تفعيل «Image search» ومفتاح Custom Search JSON API، ثم اضبط GOOGLE_CSE_KEY و GOOGLE_CSE_ID (على Cloudflare: wrangler secret put GOOGLE_CSE_KEY، و GOOGLE_CSE_ID في vars).',
];

export interface WebImageServiceOptions {
  /** tests: the fake HTTP layer under the SSRF guard (no real network) */
  transport?: Transport;
  resolver?: Resolver;
  /** tests: a different signing key */
  signingKey?: Buffer;
}

interface RefRow {
  id: string;
  provider: WebImageProvider;
  query: string | null;
  title: string;
  caption: string | null;
  author: string | null;
  license: string | null;
  license_url: string | null;
  usage: 'free_licence' | 'linked_preview';
  page_url: string;
  image_url: string;
  thumb_remote: string;
  large_remote: string;
  source_id: string | null;
  version_id: string | null;
  page_id: string | null;
  note: string | null;
  created_at: number;
}

export class WebImageService {
  readonly providers: ImageSearchProvider[];
  readonly cache: ThumbCache;
  private http: WebHttp;
  private readonly key: Buffer;
  private readonly searches = new Map<string, { at: number; value: WebImageSearchResponse }>();
  private readonly inflight = new Map<string, Promise<CachedImage>>();

  constructor(
    private readonly ctx: AppContext,
    signingKey: Buffer,
    opts: WebImageServiceOptions = {},
  ) {
    this.key = opts.signingKey ?? signingKey;
    const cfg = ctx.config.webImages;
    this.providers = [openiProvider, wikimediaProvider, googleProvider({ key: () => ctx.config.secrets.googleCseKey(), cx: cfg.googleCseId })];
    this.cache = new ThumbCache(join(ctx.config.dataDir, 'cache', 'web-images'), cfg.cacheBytes);
    this.http = createWebHttp({ allowExternalFetch: ctx.config.allowExternalFetch, transport: opts.transport, resolver: opts.resolver });
  }

  /** tests: swap the fake HTTP layer (still under the SSRF guard and the allow-list) */
  useTransport(transport: Transport, resolver: Resolver): void {
    this.http = createWebHttp({ allowExternalFetch: this.ctx.config.allowExternalFetch, transport, resolver });
    this.searches.clear();
  }

  // ───────── state ─────────
  status(): WebImageStatusResponse {
    const allowed = this.ctx.config.allowExternalFetch;
    const providers: WebImageProviderStatus[] = this.providers.map((p) => {
      const s = p.state();
      const state: FeatureState = allowed ? s.state : 'requires_configuration';
      const reason_ar = allowed ? s.reason_ar : p.id === 'google' && s.state !== 'available' ? `${DISABLED_AR} ${GOOGLE_NEEDS_KEY_AR}` : DISABLED_AR;
      return { provider: p.id, label_ar: WEB_IMAGE_PROVIDER_LABELS_AR[p.id], state, ...(reason_ar ? { reason_ar } : {}) };
    });
    const google = providers.find((p) => p.provider === 'google')!;
    const state: FeatureState = allowed ? 'available' : 'requires_configuration';
    const reason_ar = allowed
      ? `صور من الويب تعمل من ويكيميديا كومنز (ملفات بترخيص حر) و Open-i (أشكال من مقالات PubMed Central)، مع ذكر المصدر والمؤلف والترخيص لكل صورة. ${google.state === 'available' ? 'بحث Google مفعّل (Programmable Search، البحث الآمن مفعّل).' : 'بحث Google: يحتاج مفتاح Google (GOOGLE_CSE_KEY و GOOGLE_CSE_ID).'}`
      : DISABLED_AR;
    return { state, reason_ar, providers, label_ar: WEB_IMAGE_LABEL_AR, how_to_enable_ar: HOW_TO_ENABLE_AR };
  }

  // ───────── signing ─────────
  private sign(data: string): string {
    return hmacSha256(this.key, data).subarray(0, 18).toString('base64url');
  }

  /** same-origin path of the proxied picture (signed: the proxy fetches only what the server itself returned) */
  proxied(remote: string): string {
    return `${THUMB_ROUTE}?u=${encodeURIComponent(remote)}&s=${this.sign(`thumb|${remote}`)}`;
  }

  private remoteOf(proxied: string): string | null {
    try {
      const u = new URL(proxied, 'https://medlevo.invalid');
      if (u.pathname !== THUMB_ROUTE) return null;
      const remote = u.searchParams.get('u');
      const s = u.searchParams.get('s');
      return remote && s && this.verifyThumb(remote, s) ? remote : null;
    } catch {
      return null;
    }
  }

  verifyThumb(remote: string, s: string): boolean {
    return safeEqual(this.sign(`thumb|${remote}`), s);
  }

  private resultToken(r: Pick<WebImageResult, 'provider' | 'title' | 'caption' | 'author' | 'license' | 'license_url' | 'usage' | 'page_url' | 'image_url' | 'thumb' | 'large'>): string {
    return this.sign(`result|${JSON.stringify([r.provider, r.title, r.caption, r.author, r.license, r.license_url, r.usage, r.page_url, r.image_url, r.thumb, r.large])}`);
  }

  // ───────── search ─────────
  async search(body: unknown, signal?: AbortSignal): Promise<WebImageSearchResponse> {
    const b = parseWith(webImageSearchSchema, body, 'body');
    if (!this.ctx.config.allowExternalFetch) throw new AppError('FEATURE_DISABLED', DISABLED_AR, 409);
    const built = buildQuery(b.query);
    if (!built.en) {
      throw new AppError(
        'VALIDATION_FAILED',
        built.untranslated.length
          ? `لم أجد مقابلًا إنجليزيًا لـ «${built.untranslated.join(' ')}» في القاموس الطبي المدمج. اكتب المصطلح بالإنجليزية (مثل adenocarcinoma colon).`
          : 'اكتب ما تبحث عنه (مصطلحًا طبيًا).',
        400,
      );
    }
    const limit = b.limit ?? 24;
    const wanted = new Set<WebImageProvider>(b.providers ?? ['openi', 'wikimedia', 'google']);
    const cacheKey = `${[...wanted].sort().join(',')}|${limit}|${built.en}`;
    const hit = this.searches.get(cacheKey);
    if (hit && Date.now() - hit.at < SEARCH_TTL_MS) return { ...hit.value, query: b.query };

    type Run = { status: WebImageSearchResponse['providers'][number]; items: RawWebImage[] };
    const runs = await Promise.all(
      this.providers.map(async (p): Promise<Run> => {
        const st = p.state();
        const base = { provider: p.id, label_ar: WEB_IMAGE_PROVIDER_LABELS_AR[p.id], state: st.state, ...(st.reason_ar ? { reason_ar: st.reason_ar } : {}) };
        if (!wanted.has(p.id) || st.state !== 'available') return { status: { ...base, count: 0 }, items: [] as RawWebImage[] };
        try {
          const items = await p.search(built.en, Math.min(limit, 20), this.http, signal);
          return { status: { ...base, count: items.length }, items };
        } catch (e) {
          const msg = e instanceof AppError ? e.message : 'تعذّر الاتصال بالخدمة.';
          this.ctx.log.warn({ provider: p.id, code: e instanceof AppError ? e.code : 'ERR' }, 'web image provider failed');
          return { status: { ...base, count: 0, error_ar: `تعذّر البحث في ${WEB_IMAGE_PROVIDER_LABELS_AR[p.id]}: ${msg}` }, items: [] as RawWebImage[] };
        }
      }),
    );
    const items = this.merge(
      runs.flatMap((r) => r.items),
      built.en,
    )
      .slice(0, limit)
      .map((r) => this.toResult(r));
    const notes_ar = [
      'صور من خدمات عامة على الإنترنت للمقارنة والمراجعة فقط — ليست من محاضرتك ولا تُعد مصدرًا للإجابات. تحقق من مطابقتها لما تدرسه.',
      'لكل صورة مصدرها ومؤلفها وترخيصها ورابط صفحتها الأصلية. صور ويكيميديا بترخيص حر؛ صور Open-i و Google معاينات مرتبطة وحقوقها لأصحابها.',
      'تُجلب الصور المصغرة عبر خادم MedLevo (لا يصل عنوانك إلى مواقع الصور).',
    ];
    if (built.untranslated.length) notes_ar.unshift(`كلمات لم تُترجم وتُركت خارج البحث: ${built.untranslated.join('، ')}. اكتبها بالإنجليزية إن كانت مهمة.`);
    const value: WebImageSearchResponse = { query: b.query, query_en: built.en, translated: built.translated, untranslated: built.untranslated, items, providers: runs.map((r) => r.status), label_ar: WEB_IMAGE_LABEL_AR, notes_ar };
    if (runs.every((r) => !r.status.error_ar)) {
      if (this.searches.size >= SEARCH_CACHE_MAX) this.searches.delete(this.searches.keys().next().value!);
      this.searches.set(cacheKey, { at: Date.now(), value });
    }
    return value;
  }

  /** de-duplicate (same picture from two services, same file twice) and order by medical relevance */
  merge(raw: RawWebImage[], queryEn: string): Array<RawWebImage & { score: number }> {
    const terms = queryEn.split(' ').filter((t) => t.length > 2);
    const seen = new Set<string>();
    const out: Array<RawWebImage & { score: number }> = [];
    const scored = raw.map((r) => {
      const text = `${r.title} ${r.caption ?? ''}`.toLowerCase();
      const overlap = terms.length ? terms.filter((t) => text.includes(t)).length / terms.length : 0;
      const medical = MEDICAL_HINTS.test(text) ? 0.15 : 0;
      const score = Math.max(0, Math.min(1, BASE_SCORE[r.provider] + 0.35 * overlap + medical - Math.min(r.rank, 20) * 0.01));
      return { ...r, score: Math.round(score * 1000) / 1000 };
    });
    scored.sort((a, b) => b.score - a.score || a.rank - b.rank);
    for (const r of scored) {
      const keys = [dedupeKey(r.image_url), dedupeKey(r.thumb_remote), wikimediaFileKey(r.image_url)].filter((k): k is string => !!k);
      if (keys.some((k) => seen.has(k))) continue;
      keys.forEach((k) => seen.add(k));
      out.push(r);
    }
    return out;
  }

  private toResult(r: RawWebImage & { score: number }): WebImageResult {
    const base = {
      provider: r.provider,
      title: r.title,
      caption: r.caption,
      author: r.author,
      license: r.license,
      license_url: r.license_url,
      usage: r.usage,
      page_url: r.page_url,
      image_url: r.image_url,
      thumb: this.proxied(r.thumb_remote),
      large: this.proxied(r.large_remote),
    };
    return {
      id: sha256(`${r.provider}|${r.image_url}`).slice(0, 24),
      provider_label_ar: WEB_IMAGE_PROVIDER_LABELS_AR[r.provider],
      ...base,
      width: r.width,
      height: r.height,
      score: r.score,
      token: this.resultToken(base),
    };
  }

  // ───────── proxy-and-cache ─────────
  async thumb(remote: string, s: string): Promise<CachedImage> {
    if (!this.verifyThumb(remote, s)) throw new AppError('FORBIDDEN', 'رابط الصورة غير صالح (غير موقّع من الخادم).', 403);
    if (!isAllowedImageUrl(remote)) throw new AppError('FORBIDDEN', 'مضيف الصورة ليس في قائمة المصادر المسموح بها.', 403);
    const cached = this.cache.get(remote);
    if (cached) return cached;
    if (!this.ctx.config.allowExternalFetch) throw new AppError('FEATURE_DISABLED', DISABLED_AR, 409);
    const running = this.inflight.get(remote);
    if (running) return running;
    const p = this.http
      .getImage(remote)
      .then((img) => this.cache.put(remote, img.body, img.mime))
      .finally(() => this.inflight.delete(remote));
    this.inflight.set(remote, p);
    return p;
  }

  // ───────── reference cards («أضف إلى ملاحظاتي») ─────────
  pin(body: unknown): WebImageRefView {
    const b = parseWith(webImagePinSchema, body, 'body');
    const r = b.result;
    const expected = this.resultToken({ provider: r.provider, title: r.title, caption: r.caption, author: r.author, license: r.license, license_url: r.license_url, usage: r.usage, page_url: r.page_url, image_url: r.image_url, thumb: r.thumb, large: r.large });
    if (!safeEqual(expected, r.token)) throw new AppError('FORBIDDEN', 'هذه النتيجة لم تأتِ من بحث MedLevo أو عُدّلت بياناتها (المصدر والترخيص)؛ لا تُحفظ.', 403);
    const thumbRemote = this.remoteOf(r.thumb);
    const largeRemote = this.remoteOf(r.large);
    if (!thumbRemote || !largeRemote) throw new AppError('FORBIDDEN', 'رابط الصورة غير صالح.', 403);
    const db = this.ctx.db;
    const dup = db.get<{ id: string }>('SELECT id FROM web_image_ref WHERE image_url = ? AND COALESCE(source_id, \'\') = ?', [r.image_url, b.source_id ?? '']);
    if (dup) return this.refView(db.get<RefRow>('SELECT * FROM web_image_ref WHERE id = ?', [dup.id])!);
    const now = this.ctx.clock.now();
    const id = newId(now);
    db.tx(() => {
      db.run(
        `INSERT INTO web_image_ref (id, provider, query, title, caption, author, license, license_url, usage, page_url, image_url, thumb_remote, large_remote, source_id, version_id, page_id, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, r.provider, b.query ?? null, r.title, r.caption, r.author, r.license, r.license_url, r.usage, r.page_url, r.image_url, thumbRemote, largeRemote, b.source_id ?? null, b.version_id ?? null, b.page_id ?? null, b.note || null, now],
      );
      this.ctx.audit.record({ entityType: 'web_image_ref', entityId: id, action: 'create', summary: `أضفت صورة من الويب مرجعًا إلى ملاحظاتك: ${r.title} (${WEB_IMAGE_PROVIDER_LABELS_AR[r.provider]})`, after: { provider: r.provider, page_url: r.page_url, license: r.license } });
    });
    return this.refView(db.get<RefRow>('SELECT * FROM web_image_ref WHERE id = ?', [id])!);
  }

  listRefs(q: { source_id?: string }): WebImageRefView[] {
    const rows = q.source_id
      ? this.ctx.db.all<RefRow>('SELECT * FROM web_image_ref WHERE source_id = ? ORDER BY created_at DESC, id DESC LIMIT 200', [q.source_id])
      : this.ctx.db.all<RefRow>('SELECT * FROM web_image_ref ORDER BY created_at DESC, id DESC LIMIT 200');
    return rows.map((r) => this.refView(r));
  }

  deleteRef(id: string): void {
    const db = this.ctx.db;
    const row = db.get<RefRow>('SELECT * FROM web_image_ref WHERE id = ?', [id]);
    if (!row) throw new AppError('NOT_FOUND', 'هذا المرجع غير موجود في ملاحظاتك.', 404);
    db.tx(() => {
      db.run('DELETE FROM web_image_ref WHERE id = ?', [id]);
      this.ctx.audit.record({ entityType: 'web_image_ref', entityId: id, action: 'delete', summary: `أزلت صورة الويب «${row.title}» من ملاحظاتك`, before: { provider: row.provider, page_url: row.page_url } });
    });
  }

  private refView(r: RefRow): WebImageRefView {
    return {
      id: r.id,
      provider: r.provider,
      provider_label_ar: WEB_IMAGE_PROVIDER_LABELS_AR[r.provider],
      title: r.title,
      caption: r.caption,
      author: r.author,
      license: r.license,
      license_url: r.license_url,
      usage: r.usage,
      page_url: r.page_url,
      image_url: r.image_url,
      thumb: this.proxied(r.thumb_remote),
      large: this.proxied(r.large_remote),
      query: r.query,
      source_id: r.source_id,
      version_id: r.version_id,
      page_id: r.page_id,
      note: r.note,
      label_ar: WEB_IMAGE_LABEL_AR,
      created_at: r.created_at,
    };
  }
}

function dedupeKey(raw: string): string | null {
  try {
    const u = new URL(raw);
    return `${u.hostname.toLowerCase()}${decodeURIComponent(u.pathname).toLowerCase()}`;
  } catch {
    return null;
  }
}

/** «…/commons/thumb/a/ab/Foo.jpg/640px-Foo.jpg» and «…/commons/a/ab/Foo.jpg» are the same Commons file */
function wikimediaFileKey(raw: string): string | null {
  const m = /upload\.wikimedia\.org\/wikipedia\/commons\/(?:thumb\/)?[0-9a-f]\/[0-9a-f]{2}\/([^/?#]+)/i.exec(raw);
  return m ? `commons:${decodeURIComponent(m[1]!).toLowerCase()}` : null;
}
