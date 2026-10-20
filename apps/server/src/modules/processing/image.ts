// Raster image layer for scans and photos (H2): one decode path for PNG (png.ts) and JPEG (jpeg-js, pure JS), the
// JPEG EXIF orientation, quarter-turn rotation and encoders. Used by the processing pipeline (scan-quality metrics,
// the OCR coverage check, orientation before OCR) and by the Image Quiz (masks burned into a served copy).
//
// Memory is bounded: nothing is decoded above a pixel budget (callers pass one; MAX_DECODE_PIXELS by default), and
// jpeg-js is given the same limits so a file that lies about its size cannot allocate more. (H2 review) For a JPEG the
// working memory jpeg-js needs is read from the frame header (components and chroma subsampling) and checked against
// JPEG_BYTES_PER_BUDGET_PIXEL × the budget BEFORE decoding: a 24 MP 4:2:0 phone photo needs ≈ 14.5 bytes per pixel, a
// 4:4:4 picture ≈ 22 (so ≈ 16 MP fit the 24 MP budget). The old cap (8 bytes per budget pixel) refused 4:4:4 JPEGs
// above ≈ 11 MP and 4:2:0 above ≈ 17 MP although the budget said 24 MP.
// The stored original file is never modified — every function here returns a NEW image or buffer.
import { decode as decodeJpegJs, encode as encodeJpegJs } from 'jpeg-js';
import { decodePng, encodePng, isPng, jpegSize, PngError, pngSize, type RgbaImage } from './png';

/** default decode budget: a 24 MP RGBA raster is ≈ 96 MB (phone photos are 12 MP) */
export const MAX_DECODE_PIXELS = 24_000_000;
/** jpeg-js working memory allowed per pixel of the budget (24 MP → ≈ 360 MB): a 24 MP 4:2:0 photo fits */
const JPEG_BYTES_PER_BUDGET_PIXEL = 15;

export class ImageDecodeError extends Error {
  constructor(
    /** NOT_IMAGE: not a PNG/JPEG; UNSUPPORTED: a valid variant this decoder does not read (interlaced PNG…);
     *  CORRUPT: the picture itself is damaged (truncated, invalid data); TOO_LARGE: above the pixel budget */
    readonly code: 'NOT_IMAGE' | 'UNSUPPORTED' | 'CORRUPT' | 'TOO_LARGE',
    message: string,
  ) {
    super(message);
    this.name = 'ImageDecodeError';
  }
}

export function isJpeg(buf: Uint8Array): boolean {
  return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

/** EXIF orientation (1–8) of a JPEG, or 1 when absent / unreadable. Both TIFF byte orders («II» and «MM»). */
export function jpegOrientation(buf: Uint8Array): number {
  if (!isJpeg(buf)) return 1;
  let i = 2;
  while (i + 4 < buf.length) {
    if (buf[i] !== 0xff) return 1;
    const marker = buf[i + 1]!;
    if (marker === 0xd9 || marker === 0xda) return 1; // end of image / start of scan: no EXIF before the pixels
    const len = (buf[i + 2]! << 8) | buf[i + 3]!;
    if (len < 2) return 1;
    if (marker === 0xe1 && len >= 16 && Buffer.from(buf.subarray(i + 4, i + 10)).toString('latin1') === 'Exif\0\0') {
      const tiff = i + 10;
      const end = Math.min(buf.length, i + 2 + len);
      const le = buf[tiff] === 0x49 && buf[tiff + 1] === 0x49;
      const be = buf[tiff] === 0x4d && buf[tiff + 1] === 0x4d;
      if (!le && !be) return 1;
      const u16 = (o: number) => (o + 2 > end ? -1 : le ? buf[o]! | (buf[o + 1]! << 8) : (buf[o]! << 8) | buf[o + 1]!);
      const u32 = (o: number) =>
        o + 4 > end ? -1 : le ? (buf[o]! | (buf[o + 1]! << 8) | (buf[o + 2]! << 16)) + buf[o + 3]! * 0x1000000 : buf[o]! * 0x1000000 + ((buf[o + 1]! << 16) | (buf[o + 2]! << 8) | buf[o + 3]!);
      const ifd = u32(tiff + 4);
      if (ifd < 0) return 1;
      const n = u16(tiff + ifd);
      for (let k = 0; k < n && k < 512; k++) {
        const e = tiff + ifd + 2 + k * 12;
        if (u16(e) === 0x0112) {
          const v = u16(e + 8);
          return v >= 1 && v <= 8 ? v : 1;
        }
      }
      return 1;
    }
    i += 2 + len;
  }
  return 1;
}

/** The marker of a JPEG's first frame header (0xc0 baseline, 0xc2 progressive, 0xc3 lossless, 0xc9 arithmetic…), or null. */
function jpegFrameMarker(buf: Uint8Array): number | null {
  return jpegFrame(buf)?.marker ?? null;
}

/**
 * (H2 review) The bytes jpeg-js allocates to decode this JPEG into RGBA, from its frame header — the same arithmetic
 * jpeg-js uses for its own memory check: coefficient blocks per component (MCU-padded, 256 bytes per 8×8 block),
 * component sample planes, the colour-converted data and the RGBA output. Null when the header cannot be read.
 */
export function jpegDecodeBytes(buf: Uint8Array): number | null {
  const f = jpegFrame(buf);
  if (!f) return null;
  const i = f.at;
  if (i + 10 > buf.length) return null;
  const height = (buf[i + 5]! << 8) | buf[i + 6]!;
  const width = (buf[i + 7]! << 8) | buf[i + 8]!;
  const n = buf[i + 9]!;
  if (!width || !height || !n || i + 10 + 3 * n > buf.length) return null;
  const comps: Array<{ h: number; v: number }> = [];
  for (let k = 0; k < n; k++) {
    const hv = buf[i + 10 + 3 * k + 1]!;
    if (hv >> 4 === 0 || (hv & 15) === 0) return null;
    comps.push({ h: hv >> 4, v: hv & 15 });
  }
  const maxH = Math.max(...comps.map((c) => c.h));
  const maxV = Math.max(...comps.map((c) => c.v));
  const mcusPerLine = Math.ceil(width / 8 / maxH);
  const mcusPerColumn = Math.ceil(height / 8 / maxV);
  let bytes = width * height * (n + 4);
  for (const c of comps) {
    bytes += mcusPerLine * c.h * mcusPerColumn * c.v * 256;
    bytes += Math.ceil(Math.ceil((width * c.h) / maxH) / 8) * 8 * Math.ceil(Math.ceil((height * c.v) / maxV) / 8) * 8;
  }
  return bytes;
}

function jpegFrame(buf: Uint8Array): { marker: number; at: number } | null {
  let i = 2;
  while (i + 4 < buf.length) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1]!;
    if (marker === 0xff || marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += marker === 0xff ? 1 : 2;
      continue;
    }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { marker, at: i };
    if (marker === 0xda || marker === 0xd9) return null;
    const len = (buf[i + 2]! << 8) | buf[i + 3]!;
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

/** Pixel size of the image as stored (no EXIF applied), PNG or JPEG. */
export function rawImageSize(buf: Uint8Array): { width: number; height: number } | null {
  return pngSize(buf) ?? jpegSize(buf);
}

/** Size of the image as a browser DISPLAYS it (EXIF orientation 5–8 swaps width and height). */
export function displayedImageSize(buf: Uint8Array): { width: number; height: number } | null {
  const s = rawImageSize(buf);
  if (!s) return null;
  return jpegOrientation(buf) >= 5 ? { width: s.height, height: s.width } : s;
}

/** Decode a PNG or JPEG into RGBA, refusing anything above `maxPixels` BEFORE allocating it. */
export function decodeImage(buf: Uint8Array, maxPixels = MAX_DECODE_PIXELS): RgbaImage {
  if (isPng(buf)) {
    const s = pngSize(buf);
    if (s && s.width * s.height > maxPixels) throw new ImageDecodeError('TOO_LARGE', 'image above the decode budget');
    try {
      return decodePng(buf);
    } catch (e) {
      if (e instanceof PngError) {
        throw new ImageDecodeError(e.code === 'NOT_PNG' ? 'NOT_IMAGE' : e.code === 'TOO_LARGE' ? 'TOO_LARGE' : e.code === 'UNSUPPORTED' ? 'UNSUPPORTED' : 'CORRUPT', e.message);
      }
      throw new ImageDecodeError('CORRUPT', (e as Error).message);
    }
  }
  if (isJpeg(buf)) {
    const s = jpegSize(buf);
    if (!s) throw new ImageDecodeError('CORRUPT', 'JPEG without a frame header');
    // (H2 review) a valid JPEG in an encoding jpeg-js does not read (lossless, arithmetic, hierarchical) is UNSUPPORTED —
    // never «damaged» (an OCR failure on a CORRUPT picture tells the owner that reprocessing will not help)
    const sof = jpegFrameMarker(buf);
    if (sof !== null && sof !== 0xc0 && sof !== 0xc1 && sof !== 0xc2) throw new ImageDecodeError('UNSUPPORTED', `JPEG frame type ${sof.toString(16)} is not read by this decoder`);
    if (s.width * s.height > maxPixels) throw new ImageDecodeError('TOO_LARGE', 'image above the decode budget');
    const memoryBudget = maxPixels * JPEG_BYTES_PER_BUDGET_PIXEL;
    const need = jpegDecodeBytes(buf);
    if (need !== null && need > memoryBudget) throw new ImageDecodeError('TOO_LARGE', 'JPEG working memory above the decode budget');
    let out: { width: number; height: number; data: Uint8Array };
    try {
      out = decodeJpegJs(buf, {
        useTArray: true,
        formatAsRGBA: true,
        tolerantDecoding: false,
        maxResolutionInMP: Math.ceil(maxPixels / 1_000_000),
        // the same budget as a backstop (Huffman / quantization tables are a few KB): a file that lies cannot allocate more
        maxMemoryUsageInMB: Math.ceil(memoryBudget / 1_048_576) + 4,
      });
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      if (/progressive|arithmetic|unsupported|not supported/i.test(msg)) throw new ImageDecodeError('UNSUPPORTED', msg);
      if (/maxResolutionInMP|maxMemoryUsageInMB|exceeded|Could not allocate/i.test(msg)) throw new ImageDecodeError('TOO_LARGE', msg);
      if (/single frame/i.test(msg)) throw new ImageDecodeError('UNSUPPORTED', msg);
      throw new ImageDecodeError('CORRUPT', msg);
    }
    if (!out || out.width <= 0 || out.height <= 0 || out.data.length < out.width * out.height * 4) throw new ImageDecodeError('CORRUPT', 'empty JPEG frame');
    return { width: out.width, height: out.height, data: out.data };
  }
  throw new ImageDecodeError('NOT_IMAGE', 'not a PNG or JPEG image');
}

/** Rotate clockwise by a quarter turn (0, 90, 180, 270). */
export function rotateImage(img: RgbaImage, degreesCw: number): RgbaImage {
  const r = (((Math.round(degreesCw / 90) * 90) % 360) + 360) % 360;
  if (r === 0) return img;
  const { width: w, height: h, data } = img;
  const ow = r === 180 ? w : h;
  const oh = r === 180 ? h : w;
  const out = new Uint8Array(w * h * 4);
  const src32 = new Uint32Array(data.buffer, data.byteOffset, w * h);
  const dst32 = new Uint32Array(out.buffer, 0, w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let nx: number;
      let ny: number;
      if (r === 90) {
        nx = h - 1 - y;
        ny = x;
      } else if (r === 180) {
        nx = w - 1 - x;
        ny = h - 1 - y;
      } else {
        nx = y;
        ny = w - 1 - x;
      }
      dst32[ny * ow + nx] = src32[y * w + x]!;
    }
  }
  return { width: ow, height: oh, data: out };
}

function flipHorizontal(img: RgbaImage): RgbaImage {
  const { width: w, height: h, data } = img;
  const out = new Uint8Array(data.length);
  const src32 = new Uint32Array(data.buffer, data.byteOffset, w * h);
  const dst32 = new Uint32Array(out.buffer, 0, w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) dst32[y * w + (w - 1 - x)] = src32[y * w + x]!;
  return { width: w, height: h, data: out };
}

/** Apply an EXIF orientation (1–8): the result is the picture as a browser displays it. */
export function applyExifOrientation(img: RgbaImage, orientation: number): RgbaImage {
  switch (orientation) {
    case 2:
      return flipHorizontal(img);
    case 3:
      return rotateImage(img, 180);
    case 4:
      return flipHorizontal(rotateImage(img, 180));
    case 5:
      return flipHorizontal(rotateImage(img, 90));
    case 6:
      return rotateImage(img, 90);
    case 7:
      return flipHorizontal(rotateImage(img, 270));
    case 8:
      return rotateImage(img, 270);
    default:
      return img;
  }
}

/** Decode and orient as displayed (EXIF applied). */
export function decodeDisplayed(buf: Uint8Array, maxPixels = MAX_DECODE_PIXELS): { image: RgbaImage; orientation: number } {
  const orientation = jpegOrientation(buf);
  return { image: applyExifOrientation(decodeImage(buf, maxPixels), orientation), orientation };
}

/** The JPEG without its EXIF APP1 segment(s): an OCR engine then reads it in its stored orientation, deterministically. */
export function stripJpegExif(buf: Buffer): Buffer {
  if (!isJpeg(buf)) return buf;
  const parts: Buffer[] = [buf.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= buf.length && buf[i] === 0xff) {
    const marker = buf[i + 1]!;
    if (marker === 0xda || marker === 0xd9) break; // the rest (scan data) is copied as is
    const len = (buf[i + 2]! << 8) | buf[i + 3]!;
    if (len < 2 || i + 2 + len > buf.length) break;
    const isExif = marker === 0xe1 && Buffer.from(buf.subarray(i + 4, i + 10)).toString('latin1') === 'Exif\0\0';
    if (!isExif) parts.push(buf.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  parts.push(buf.subarray(i));
  return Buffer.concat(parts);
}

/** A word box read in a JPEG's stored (raw) orientation, mapped to the picture as displayed (EXIF 1–8). */
export function exifWordToDisplayed<W extends { x0: number; y0: number; x1: number; y1: number }>(w: W, raw: { width: number; height: number }, orientation: number): W {
  const W0 = raw.width;
  const H0 = raw.height;
  const map = (x: number, y: number): [number, number] => {
    switch (orientation) {
      case 2:
        return [W0 - x, y];
      case 3:
        return [W0 - x, H0 - y];
      case 4:
        return [x, H0 - y];
      case 5:
        return [y, x];
      case 6:
        return [H0 - y, x];
      case 7:
        return [H0 - y, W0 - x];
      case 8:
        return [y, W0 - x];
      default:
        return [x, y];
    }
  };
  const [ax, ay] = map(w.x0, w.y0);
  const [bx, by] = map(w.x1, w.y1);
  return { ...w, x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by) };
}

/** Baseline JPEG (no EXIF: the pixels are already oriented). */
export function encodeJpeg(img: RgbaImage, quality = 90): Buffer {
  return encodeJpegJs({ width: img.width, height: img.height, data: img.data }, quality).data;
}

export { encodePng };
