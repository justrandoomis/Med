// Raster image layer for scans and photos (H2): one decode path for PNG (png.ts) and JPEG (jpeg-js, pure JS), the
// JPEG EXIF orientation, quarter-turn rotation and encoders. Used by the processing pipeline (scan-quality metrics,
// the OCR coverage check, orientation before OCR) and by the Image Quiz (masks burned into a served copy).
//
// Memory is bounded: nothing is decoded above a pixel budget (callers pass one; MAX_DECODE_PIXELS by default), and
// jpeg-js is given the same limits so a file that lies about its size cannot allocate more.
// The stored original file is never modified — every function here returns a NEW image or buffer.
import { decode as decodeJpegJs, encode as encodeJpegJs } from 'jpeg-js';
import { decodePng, encodePng, isPng, jpegSize, PngError, pngSize, type RgbaImage } from './png';

/** default decode budget: a 24 MP RGBA raster is ≈ 96 MB (phone photos are 12 MP) */
export const MAX_DECODE_PIXELS = 24_000_000;

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
    if (s.width * s.height > maxPixels) throw new ImageDecodeError('TOO_LARGE', 'image above the decode budget');
    let out: { width: number; height: number; data: Uint8Array };
    try {
      out = decodeJpegJs(buf, {
        useTArray: true,
        formatAsRGBA: true,
        tolerantDecoding: false,
        maxResolutionInMP: Math.ceil(maxPixels / 1_000_000),
        // RGBA output + jpeg-js component planes (≈ 3 bytes per pixel) + headroom
        maxMemoryUsageInMB: Math.ceil((maxPixels * 8) / 1_048_576) + 64,
      });
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      if (/progressive|arithmetic|unsupported|not supported/i.test(msg)) throw new ImageDecodeError('UNSUPPORTED', msg);
      if (/maxResolutionInMP|maxMemoryUsageInMB|exceeded/i.test(msg)) throw new ImageDecodeError('TOO_LARGE', msg);
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
