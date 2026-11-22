// Web reference images («صور من الويب») — pictures from public image services shown NEXT TO a lecture, never as part
// of it. Server: apps/server/src/modules/media/web-images (docs/modules/cases-media.md «Web reference images»).
//
// THE RULES (enforced server-side):
//  * Search runs on the server only, through a fixed allow-list of API hosts (Wikimedia Commons, NLM Open-i and — only
//    when the owner set GOOGLE_CSE_KEY + GOOGLE_CSE_ID — Google Programmable Search). Google is never scraped.
//  * Nothing is fetched unless the server switch MEDLEVO_ALLOW_EXTERNAL_FETCH is on; the state says so honestly.
//  * Every picture carries its attribution (source, author, licence, link to the original page) and the label
//    «صورة من الويب — ليست من محاضرتك». It is never presented as the owner's or as lecture content.
//  * Thumbnails reach the browser only through the server's proxy-and-cache (the user's address is not sent to the
//    image hosts); Wikimedia results are freely licensed files; Open-i / Google results are linked previews with credit.
//  * «أضف إلى ملاحظاتي» keeps a reference card (the attribution travels with it; the result is signed by the server so
//    the credit cannot be dropped or changed on the way).
import { z } from 'zod';
import type { FeatureState } from './features';

export const WEB_IMAGE_PROVIDERS = ['wikimedia', 'openi', 'google'] as const;
export type WebImageProvider = (typeof WEB_IMAGE_PROVIDERS)[number];
export const WEB_IMAGE_PROVIDER_LABELS_AR: Record<WebImageProvider, string> = {
  wikimedia: 'ويكيميديا كومنز',
  openi: 'Open-i (المكتبة الوطنية للطب NLM)',
  google: 'بحث Google',
};
/** shown on every web picture, everywhere */
export const WEB_IMAGE_LABEL_AR = 'صورة من الويب — ليست من محاضرتك';

/** free_licence: a freely licensed file (Wikimedia Commons); linked_preview: a preview with credit, the original stays at its source */
export type WebImageUsage = 'free_licence' | 'linked_preview';
export const WEB_IMAGE_USAGE_LABELS_AR: Record<WebImageUsage, string> = {
  free_licence: 'ترخيص حر — يُذكر المؤلف والترخيص',
  linked_preview: 'معاينة مرتبطة — الصورة الأصلية في مصدرها وحقوقها لأصحابها',
};

export interface WebImageResult {
  /** stable id of the picture (hash of provider + original image URL) */
  id: string;
  provider: WebImageProvider;
  provider_label_ar: string;
  title: string;
  caption: string | null;
  author: string | null;
  license: string | null;
  license_url: string | null;
  usage: WebImageUsage;
  /** the original page (file page / article / the page the picture is on) */
  page_url: string;
  /** the original picture at its source (shown as a link, never loaded by the browser) */
  image_url: string;
  /** same-origin proxied thumbnail and larger preview (the server fetches and caches them) */
  thumb: string;
  large: string;
  width: number | null;
  height: number | null;
  /** relevance used for ordering (0–1, higher first) */
  score: number;
  /** the server's signature over this result: «أضف إلى ملاحظاتي» needs it, so the attribution cannot be changed */
  token: string;
}

export interface WebImageProviderStatus {
  provider: WebImageProvider;
  label_ar: string;
  state: FeatureState;
  reason_ar?: string;
}

export interface WebImageStatusResponse {
  state: FeatureState;
  reason_ar?: string;
  providers: WebImageProviderStatus[];
  label_ar: string;
  /** what the owner sets on the server to turn it on */
  how_to_enable_ar: string[];
}

export const webImageSearchSchema = z
  .object({
    query: z.string().trim().min(2).max(300),
    providers: z.array(z.enum(WEB_IMAGE_PROVIDERS)).min(1).max(3).optional(),
    limit: z.number().int().min(1).max(40).optional(),
  })
  .strict();
export type WebImageSearchRequest = z.infer<typeof webImageSearchSchema>;

export interface WebImageSearchResponse {
  query: string;
  /** the English medical query actually sent */
  query_en: string;
  /** Arabic words translated with the built-in medical dictionary */
  translated: Array<{ ar: string; en: string }>;
  /** Arabic words the dictionary does not know (left out of the query) */
  untranslated: string[];
  items: WebImageResult[];
  providers: Array<WebImageProviderStatus & { count: number; error_ar?: string }>;
  label_ar: string;
  notes_ar: string[];
}

export const webImagePinSchema = z
  .object({
    result: z
      .object({
        id: z.string().min(1).max(80),
        provider: z.enum(WEB_IMAGE_PROVIDERS),
        title: z.string().max(500),
        caption: z.string().max(4000).nullable(),
        author: z.string().max(500).nullable(),
        license: z.string().max(200).nullable(),
        license_url: z.string().max(1000).nullable(),
        usage: z.enum(['free_licence', 'linked_preview']),
        page_url: z.string().max(2000),
        image_url: z.string().max(2000),
        thumb: z.string().max(4000),
        large: z.string().max(4000),
        token: z.string().min(16).max(200),
      })
      .passthrough(),
    query: z.string().trim().max(300).optional(),
    source_id: z.string().trim().min(1).max(64).optional(),
    version_id: z.string().trim().min(1).max(64).optional(),
    page_id: z.string().trim().min(1).max(64).optional(),
    note: z.string().trim().max(2000).optional(),
  })
  .strict();
export type WebImagePinRequest = z.infer<typeof webImagePinSchema>;

/** a reference card in the owner's notes: the web picture with its attribution (never lecture content) */
export interface WebImageRefView {
  id: string;
  provider: WebImageProvider;
  provider_label_ar: string;
  title: string;
  caption: string | null;
  author: string | null;
  license: string | null;
  license_url: string | null;
  usage: WebImageUsage;
  page_url: string;
  image_url: string;
  thumb: string;
  large: string;
  query: string | null;
  source_id: string | null;
  version_id: string | null;
  page_id: string | null;
  note: string | null;
  label_ar: string;
  created_at: number;
}

export interface WebImageRefListResponse {
  items: WebImageRefView[];
}
