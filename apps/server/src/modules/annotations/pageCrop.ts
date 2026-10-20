// (Round 7 — H3 item 4, spec §28/§29 «حوّل المحدد إلى بطاقة») «بطاقة إخفاء في صورة» from a lasso selection: the area of
// the SOURCE page under the selection box becomes a picture of that source (an `image_asset`) that an image-occlusion
// card can be made from (POST /api/learning/cards/occlusion takes its id).
//  * The server cuts the picture out of the stored source file itself — the display PDF with poppler (pdftoppm, the
//    renderer the pipeline uses) or the stored page picture for image sources — so the card's picture IS the source page
//    area: never the owner's ink, never a picture the client sends.
//  * Without pdftoppm a PDF page cannot be cut: the request is refused with the reason (nothing is guessed).
//  * The row is marked as the owner's crop (match_details_json.owner_crop) and has no region: re-processing the page
//    (which replaces the regions and the figure pictures processing made) keeps it, and the image explorer does not list
//    it as a figure of the source. A purge of the source removes it with the source (its source_id / version_id).
//  * `id` is the client's ULID: the same request again returns the same picture (a retried call never makes a second).
import { readFile } from 'node:fs/promises';
import type { NormBox, PageCropResponse, PageCropView } from '@medlevo/shared';
import { z } from 'zod';
import type { AppContext } from '../../context';
import { fromJson, toJson } from '../../db/db';
import { AppError } from '../../lib/errors';
import { decodeDisplayed, ImageDecodeError, rotateImage } from '../processing/image';
import { cropImage, encodePng, pngSize } from '../processing/png';
import { renderPdfPage } from '../processing/tools';

const ID = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);
const unit = z.number().finite().min(0).max(1);
export const pageCropBody = z
  .object({
    id: ID,
    page_id: ID,
    bbox: z.object({ x: unit, y: unit, w: z.number().finite().gt(0).max(1), h: z.number().finite().gt(0).max(1) }).strict(),
  })
  .strict();
export type PageCropBody = z.infer<typeof pageCropBody>;

/** the longest side of a PDF crop, in pixels (enough to draw masks on, small enough to review offline) */
export const CROP_TARGET_PX = 1400;
/** a selection narrower / shorter than this share of the page is too small to become a picture */
export const CROP_MIN_FRACTION = 0.01;
const CROP_DPI_MIN = 72;
const CROP_DPI_MAX = 300;

export const CROP_NO_RENDERER_AR =
  'قص جزء من صفحة PDF يحتاج أداة poppler (pdftoppm) على الخادم، وهي غير مثبتة؛ لم تُصنع صورة. ثبّتها (حزمة poppler-utils) ثم أعد المحاولة، أو اصنع بطاقة نصية.';
export const CROP_TOO_SMALL_AR = 'المنطقة المحددة صغيرة جدًا لتصبح صورة؛ حدّد مساحة أكبر من الصفحة.';
const CROP_NO_FILE_AR = 'لا يوجد ملف معروض لهذه الصفحة يمكن قص صورة منه.';
const CROP_FAILED_AR = 'تعذّر قص الصورة من صفحة المصدر؛ لم يُحفظ شيء.';

export interface PageCropDeps {
  /** absolute path of pdftoppm, or null when it is not installed */
  pdftoppm: string | null;
}

interface PageRow {
  page_id: string;
  page_index: number;
  width: number | null;
  height: number | null;
  rotation: number | null;
  render_file_id: string | null;
  version_id: string;
  format: string;
  file_id: string | null;
  display_file_id: string | null;
  source_id: string;
  source_deleted_at: number | null;
}

interface AssetRow {
  id: string;
  file_id: string | null;
  source_id: string | null;
  version_id: string | null;
  page_id: string | null;
  match_details_json: string | null;
}

interface OwnerCropDetails {
  owner_crop?: { bbox: NormBox; page_index: number; width: number; height: number };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The box kept inside the page (a selection may reach past its edge). */
export function clampBox(b: NormBox): NormBox {
  const x = clamp(b.x, 0, 1);
  const y = clamp(b.y, 0, 1);
  return { x, y, w: clamp(b.x + b.w, 0, 1) - x, h: clamp(b.y + b.h, 0, 1) - y };
}

const quarter = (deg: number | null): 0 | 90 | 180 | 270 => ((((Math.round((deg ?? 0) / 90) * 90) % 360) + 360) % 360) as 0 | 90 | 180 | 270;

/**
 * The reader keeps annotations (and the lasso box) in the UNROTATED page box and turns the page by its /Rotate when it
 * shows it; poppler renders the page turned. This maps a normalized box of the unrotated page to the turned page
 * (rotation clockwise, as /Rotate).
 */
export function toDisplayBox(b: NormBox, rotation: number | null): NormBox {
  switch (quarter(rotation)) {
    case 90:
      return { x: 1 - b.y - b.h, y: b.x, w: b.h, h: b.w };
    case 180:
      return { x: 1 - b.x - b.w, y: 1 - b.y - b.h, w: b.w, h: b.h };
    case 270:
      return { x: b.y, y: 1 - b.x - b.w, w: b.h, h: b.w };
    default:
      return b;
  }
}

/** Resolution for a PDF crop: its longest side ≈ CROP_TARGET_PX, within [72, 300] dpi. */
export function cropDpi(pageWpt: number, pageHpt: number, box: NormBox): number {
  const longestPt = Math.max(box.w * pageWpt, box.h * pageHpt, 1);
  return Math.round(clamp((CROP_TARGET_PX * 72) / longestPt, CROP_DPI_MIN, CROP_DPI_MAX));
}

function view(row: AssetRow, details: NonNullable<OwnerCropDetails['owner_crop']>): PageCropView {
  return {
    image_asset_id: row.id,
    file_id: row.file_id!,
    url: `/api/files/${encodeURIComponent(row.file_id!)}`,
    width: details.width,
    height: details.height,
    source_id: row.source_id!,
    version_id: row.version_id!,
    page_id: row.page_id!,
    page_index: details.page_index,
    bbox: details.bbox,
  };
}

async function cutPdf(ctx: AppContext, deps: PageCropDeps, page: PageRow, pdfFileId: string, box: NormBox): Promise<Buffer> {
  if (!deps.pdftoppm) throw new AppError('FEATURE_DISABLED', CROP_NO_RENDERER_AR, 409);
  const render = (dpi: number, crop?: { x: number; y: number; w: number; h: number }) =>
    renderPdfPage({ pdftoppm: deps.pdftoppm!, pdfPath: ctx.files.path(pdfFileId), pageNumber: page.page_index + 1, dpi, crop, tmpRoot: ctx.config.tmpDir, timeoutMs: 60_000 });
  // poppler renders the page as shown (crop box, /Rotate applied): the box and the page size are turned the same way
  const shown = toDisplayBox(box, page.rotation);
  if (page.width && page.height) {
    const sideways = quarter(page.rotation) % 180 !== 0;
    const wPt = sideways ? page.height : page.width;
    const hPt = sideways ? page.width : page.height;
    const dpi = cropDpi(wPt, hPt, shown);
    const s = dpi / 72;
    const pw = wPt * s;
    const ph = hPt * s;
    const x = Math.floor(shown.x * pw);
    const y = Math.floor(shown.y * ph);
    return render(dpi, { x, y, w: Math.max(1, Math.min(Math.ceil(shown.w * pw), Math.ceil(pw) - x)), h: Math.max(1, Math.min(Math.ceil(shown.h * ph), Math.ceil(ph) - y)) });
  }
  // size unknown: the whole page at a modest resolution, then the box out of it
  return cutRaster(await render(110), shown, 0);
}

/** The box out of a stored picture (as a browser shows it), then turned like the page is shown. */
function cutRaster(buf: Uint8Array, box: NormBox, rotation: number | null): Buffer {
  let img;
  try {
    img = decodeDisplayed(buf).image; // the picture as a browser shows it (JPEG EXIF orientation applied)
  } catch (e) {
    if (e instanceof ImageDecodeError) throw new AppError('UNSUPPORTED_FORMAT', 'تعذّر قراءة صورة هذه الصفحة لقص جزء منها.', 409);
    throw e;
  }
  const left = Math.floor(box.x * img.width);
  const top = Math.floor(box.y * img.height);
  const width = Math.max(1, Math.min(Math.ceil(box.w * img.width), img.width - left));
  const height = Math.max(1, Math.min(Math.ceil(box.h * img.height), img.height - top));
  const cut = cropImage(img, { left, top, width, height });
  const turn = quarter(rotation);
  return encodePng(turn ? rotateImage(cut, turn) : cut);
}

export async function createPageCrop(ctx: AppContext, body: PageCropBody, deps: PageCropDeps): Promise<PageCropResponse> {
  const prior = ctx.db.get<AssetRow>('SELECT id, file_id, source_id, version_id, page_id, match_details_json FROM image_asset WHERE id = ?', [body.id]);
  if (prior) {
    const d = fromJson<OwnerCropDetails>(prior.match_details_json)?.owner_crop;
    if (!d || prior.page_id !== body.page_id || !prior.file_id) throw new AppError('CONFLICT', 'هذا المعرّف مستخدم لصورة أخرى.', 409);
    return { crop: view(prior, d), created: false };
  }
  const page = ctx.db.get<PageRow>(
    `SELECT p.id AS page_id, p.page_index, p.width, p.height, p.rotation, p.render_file_id, v.id AS version_id, v.format, v.file_id, v.display_file_id,
            s.id AS source_id, s.deleted_at AS source_deleted_at
       FROM source_page p JOIN source_version v ON v.id = p.version_id JOIN source s ON s.id = v.source_id
      WHERE p.id = ?`,
    [body.page_id],
  );
  if (!page || page.source_deleted_at !== null) throw new AppError('NOT_FOUND', 'الصفحة غير موجودة أو مصدرها في سلة المحذوفات.', 404);
  const box = clampBox(body.bbox);
  if (box.w < CROP_MIN_FRACTION || box.h < CROP_MIN_FRACTION) throw new AppError('VALIDATION_FAILED', CROP_TOO_SMALL_AR, 400);

  const pdfFileId = page.display_file_id ?? (page.format === 'pdf' ? page.file_id : null);
  const rasterFileId = page.render_file_id ?? (page.format === 'image' ? page.file_id : null);
  let png: Buffer;
  try {
    if (page.format === 'image' || page.format === 'image_set' || (!pdfFileId && rasterFileId)) {
      if (!rasterFileId || !ctx.files.stat(rasterFileId)) throw new AppError('CONFLICT', CROP_NO_FILE_AR, 409);
      png = cutRaster(await readFile(ctx.files.path(rasterFileId)), box, page.rotation);
    } else {
      if (!pdfFileId || !ctx.files.stat(pdfFileId)) throw new AppError('CONFLICT', CROP_NO_FILE_AR, 409);
      png = await cutPdf(ctx, deps, page, pdfFileId, box);
    }
  } catch (e) {
    if (e instanceof AppError) throw e;
    ctx.log.warn({ err: e instanceof Error ? e.message : String(e) }, 'page crop failed');
    throw new AppError('INTERNAL', CROP_FAILED_AR, 500);
  }
  const size = pngSize(png);
  if (!size) throw new AppError('INTERNAL', CROP_FAILED_AR, 500);

  const stored = await ctx.files.put(png, { mime: 'image/png', originalName: `page-${page.page_index + 1}-crop.png` });
  const details: NonNullable<OwnerCropDetails['owner_crop']> = { bbox: box, page_index: page.page_index, width: size.width, height: size.height };
  const now = ctx.clock.now();
  const row: AssetRow = { id: body.id, file_id: stored.id, source_id: page.source_id, version_id: page.version_id, page_id: page.page_id, match_details_json: toJson({ owner_crop: details }) };
  ctx.db.tx(() => {
    ctx.db.run(
      `INSERT INTO image_asset (id, file_id, source_id, version_id, page_id, region_id, caption_region_id, origin, image_kind, title, caption, match_status, match_details_json, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, 'source', 'unknown', ?, NULL, 'unverified', ?, ?)`,
      [row.id, row.file_id, row.source_id, row.version_id, row.page_id, `جزء من الصفحة ${page.page_index + 1} قصصته بنفسك`, row.match_details_json, now],
    );
    ctx.audit.record({
      entityType: 'image_asset',
      entityId: row.id,
      action: 'page_crop',
      summary: `قصّ المالك جزءًا من الصفحة ${page.page_index + 1} في المصدر ليصنع منه بطاقة إخفاء في صورة.`,
      after: { source_id: row.source_id, version_id: row.version_id, page_id: row.page_id, bbox: box, file_id: row.file_id },
      actor: 'owner',
    });
  });
  return { crop: view(row, details), created: true };
}

/** SQL condition: the image_asset row `alias` is an owner's page crop (not a figure processing found). */
export const OWNER_CROP_SQL = (alias: string) => `json_extract(COALESCE(${alias}.match_details_json, '{}'), '$.owner_crop') IS NOT NULL`;
