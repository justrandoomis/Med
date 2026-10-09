// Minimal PNG codec (node:zlib only) used by the processing pipeline for:
//   * image quality metrics of scans/photos (contrast, edge sharpness, blank-page detection)
//   * cropping figure regions out of image sources and encoding the crop as PNG
// No image library is installed in this project; PNG is the format pdftoppm emits and the most common
// format for screenshots/scans. JPEG and interlaced PNGs are NOT decoded here (callers fall back to
// "metrics unavailable" and say so — never a fake quality value).
import { crc32, deflateSync, inflateSync } from 'node:zlib';

export interface RgbaImage {
  width: number;
  height: number;
  /** 8-bit RGBA, row-major, length = width * height * 4 */
  data: Uint8Array;
}

export class PngError extends Error {
  constructor(
    readonly code: 'NOT_PNG' | 'UNSUPPORTED' | 'CORRUPT' | 'TOO_LARGE',
    message: string,
  ) {
    super(message);
    this.name = 'PngError';
  }
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** refuse to allocate more than this many pixels (decompression-bomb guard) */
export const MAX_PNG_PIXELS = 60_000_000;

export function isPng(buf: Uint8Array): boolean {
  return buf.length >= 8 && Buffer.from(buf.subarray(0, 8)).equals(SIGNATURE);
}

/** Read width/height from the IHDR chunk without decoding. */
export function pngSize(buf: Uint8Array): { width: number; height: number } | null {
  if (!isPng(buf) || buf.length < 24) return null;
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

export function decodePng(input: Uint8Array): RgbaImage {
  if (!isPng(input)) throw new PngError('NOT_PNG', 'not a PNG file');
  const buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Buffer[] = [];
  let sawIhdr = false;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const start = pos + 8;
    const end = start + len;
    if (end + 4 > buf.length) throw new PngError('CORRUPT', `truncated chunk ${type}`);
    const body = buf.subarray(start, end);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      bitDepth = body[8]!;
      colorType = body[9]!;
      interlace = body[12]!;
      sawIhdr = true;
    } else if (type === 'PLTE') {
      palette = new Uint8Array(body);
    } else if (type === 'tRNS') {
      trns = new Uint8Array(body);
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
    pos = end + 4; // skip CRC
  }
  if (!sawIhdr || width === 0 || height === 0) throw new PngError('CORRUPT', 'missing IHDR');
  if (width * height > MAX_PNG_PIXELS) throw new PngError('TOO_LARGE', 'image too large to analyse');
  if (interlace !== 0) throw new PngError('UNSUPPORTED', 'interlaced PNG');
  const channelsByType: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const channels = channelsByType[colorType];
  if (channels === undefined) throw new PngError('UNSUPPORTED', `color type ${colorType}`);
  if (![1, 2, 4, 8, 16].includes(bitDepth)) throw new PngError('UNSUPPORTED', `bit depth ${bitDepth}`);
  if (colorType === 3 && !palette) throw new PngError('CORRUPT', 'palette missing');

  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat), { maxOutputLength: (Math.ceil((width * channels * bitDepth) / 8) + 1) * height + 1024 });
  } catch {
    throw new PngError('CORRUPT', 'invalid compressed data');
  }
  const bitsPerPixel = channels * bitDepth;
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  const bpp = Math.max(1, Math.ceil(bitsPerPixel / 8));
  if (raw.length < (stride + 1) * height) throw new PngError('CORRUPT', 'image data too short');

  // unfilter in place into `rows`
  const rows = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const prev = dst - stride;
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[src + x]!;
      const a = x >= bpp ? rows[dst + x - bpp]! : 0;
      const b = y > 0 ? rows[prev + x]! : 0;
      const c = x >= bpp && y > 0 ? rows[prev + x - bpp]! : 0;
      let v: number;
      switch (filter) {
        case 0:
          v = rawByte;
          break;
        case 1:
          v = rawByte + a;
          break;
        case 2:
          v = rawByte + b;
          break;
        case 3:
          v = rawByte + ((a + b) >> 1);
          break;
        case 4:
          v = rawByte + paeth(a, b, c);
          break;
        default:
          throw new PngError('CORRUPT', `bad filter ${filter}`);
      }
      rows[dst + x] = v & 0xff;
    }
  }

  const out = new Uint8Array(width * height * 4);
  const sample = (row: number, index: number): number => {
    // index = sample index within the row
    if (bitDepth === 8) return rows[row * stride + index]!;
    if (bitDepth === 16) return rows[row * stride + index * 2]!; // high byte
    const bitPos = index * bitDepth;
    const byte = rows[row * stride + (bitPos >> 3)]!;
    const shift = 8 - bitDepth - (bitPos & 7);
    const v = (byte >> shift) & ((1 << bitDepth) - 1);
    if (colorType === 3) return v; // palette index
    return Math.round((v * 255) / ((1 << bitDepth) - 1));
  };
  const rawSample16 = (row: number, index: number): number =>
    bitDepth === 16 ? (rows[row * stride + index * 2]! << 8) | rows[row * stride + index * 2 + 1]! : -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      switch (colorType) {
        case 0: {
          const g = sample(y, x);
          out[o] = out[o + 1] = out[o + 2] = g;
          let alpha = 255;
          if (trns && trns.length >= 2) {
            const t = (trns[0]! << 8) | trns[1]!;
            const rawV = bitDepth === 16 ? rawSample16(y, x) : bitDepth === 8 ? g : (sample(y, x) * ((1 << bitDepth) - 1)) / 255;
            if (Math.round(rawV) === t) alpha = 0;
          }
          out[o + 3] = alpha;
          break;
        }
        case 2:
          out[o] = sample(y, x * 3);
          out[o + 1] = sample(y, x * 3 + 1);
          out[o + 2] = sample(y, x * 3 + 2);
          out[o + 3] = 255;
          break;
        case 3: {
          const idx = sample(y, x);
          const p = palette!;
          out[o] = p[idx * 3] ?? 0;
          out[o + 1] = p[idx * 3 + 1] ?? 0;
          out[o + 2] = p[idx * 3 + 2] ?? 0;
          out[o + 3] = trns && idx < trns.length ? trns[idx]! : 255;
          break;
        }
        case 4: {
          const g = sample(y, x * 2);
          out[o] = out[o + 1] = out[o + 2] = g;
          out[o + 3] = sample(y, x * 2 + 1);
          break;
        }
        case 6:
          out[o] = sample(y, x * 4);
          out[o + 1] = sample(y, x * 4 + 1);
          out[o + 2] = sample(y, x * 4 + 2);
          out[o + 3] = sample(y, x * 4 + 3);
          break;
      }
    }
  }
  return { width, height, data: out };
}

function chunk(type: string, body: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length, 0);
  const typeBuf = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, body])) >>> 0, 0);
  return Buffer.concat([len, typeBuf, Buffer.from(body), crc]);
}

/** Encode an RGBA image as an 8-bit RGB(A) PNG (alpha dropped when fully opaque). */
export function encodePng(img: RgbaImage): Buffer {
  const { width, height, data } = img;
  let opaque = true;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] !== 255) {
      opaque = false;
      break;
    }
  }
  const channels = opaque ? 3 : 4;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 2; // filter: Up (good for scans, cheap)
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < channels; c++) {
        const v = data[(y * width + x) * 4 + c]!;
        const up = y > 0 ? data[((y - 1) * width + x) * 4 + c]! : 0;
        raw[rowStart + 1 + x * channels + c] = (v - up) & 0xff;
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = opaque ? 2 : 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', new Uint8Array(0))]);
}

/** Crop a pixel rectangle (clamped to the image). */
export function cropImage(img: RgbaImage, rect: { left: number; top: number; width: number; height: number }): RgbaImage {
  const left = Math.max(0, Math.min(img.width - 1, Math.floor(rect.left)));
  const top = Math.max(0, Math.min(img.height - 1, Math.floor(rect.top)));
  const w = Math.max(1, Math.min(img.width - left, Math.ceil(rect.width)));
  const h = Math.max(1, Math.min(img.height - top, Math.ceil(rect.height)));
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const srcStart = ((top + y) * img.width + left) * 4;
    out.set(img.data.subarray(srcStart, srcStart + w * 4), y * w * 4);
  }
  return { width: w, height: h, data: out };
}

export interface ImageQuality {
  width: number;
  height: number;
  /** luminance percentiles (0–255), alpha composited on white; darkP1 = darkest 0.2 % (ink level) */
  darkP1: number;
  median: number;
  lightP99: number;
  /** lightP99 − darkP1: how far ink is from paper */
  contrast: number;
  /** share of pixels clearly darker than the paper (ink coverage, 0–1) */
  inkCoverage: number;
  /** strongest-edge gradient over contrast: ~0.9+ crisp edges, < 0.4 blurred */
  edgeSharpness: number;
  /** nothing on the page (uniform) */
  blank: boolean;
  /** low contrast or blurred: OCR text must be reviewed */
  lowQuality: boolean;
  reasons: Array<'low_contrast' | 'blurred'>;
}

function percentile(hist: Uint32Array, total: number, p: number): number {
  const target = total * p;
  let acc = 0;
  for (let i = 0; i < hist.length; i++) {
    acc += hist[i]!;
    if (acc >= target) return i;
  }
  return hist.length - 1;
}

/**
 * Measure scan quality. Thresholds are deliberately conservative: they flag clearly washed-out or
 * blurred scans for owner review; they never "fix" or reject anything on their own.
 */
export function measureImageQuality(img: RgbaImage): ImageQuality {
  const { width, height, data } = img;
  // sample at most ~1.5M pixels for speed (stride on both axes)
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 1_500_000)));
  const sw = Math.floor(width / step);
  const sh = Math.floor(height / step);
  const lum = new Uint8Array(sw * sh);
  const hist = new Uint32Array(256);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const o = ((y * step) * width + x * step) * 4;
      const a = data[o + 3]! / 255;
      const l = 0.299 * data[o]! + 0.587 * data[o + 1]! + 0.114 * data[o + 2]!;
      const v = Math.round(l * a + 255 * (1 - a));
      lum[y * sw + x] = v;
      hist[v]!++;
    }
  }
  const total = sw * sh;
  // ink is rare on text pages (~1–3 % of pixels): use the darkest 0.2 % as the ink level
  const darkP1 = percentile(hist, total, 0.002);
  const median = percentile(hist, total, 0.5);
  const lightP99 = percentile(hist, total, 0.99);
  const contrast = lightP99 - darkP1;
  let ink = 0;
  const inkThreshold = median - Math.max(24, contrast * 0.35);
  for (let i = 0; i < lum.length; i++) if (lum[i]! < inkThreshold) ink++;
  const inkCoverage = total ? ink / total : 0;

  // gradient magnitude histogram (central differences, sampled grid)
  const gHist = new Uint32Array(512);
  let gCount = 0;
  for (let y = 1; y < sh - 1; y++) {
    for (let x = 1; x < sw - 1; x++) {
      const gx = lum[y * sw + x + 1]! - lum[y * sw + x - 1]!;
      const gy = lum[(y + 1) * sw + x]! - lum[(y - 1) * sw + x]!;
      const g = Math.min(511, Math.round(Math.sqrt(gx * gx + gy * gy) / 2));
      gHist[g]!++;
      gCount++;
    }
  }
  // edges are rare on text pages: look at the strongest 0.5% of gradients
  const gP = gCount ? percentile(gHist, gCount, 0.995) : 0;
  // central differences span 2 sampled pixels; a perfectly sharp edge gives g ≈ contrast / 2 per sample step
  const edgeSharpness = contrast > 0 ? Math.min(1.5, (gP * 2) / contrast) : 0;
  const blank = contrast < 12 || inkCoverage < 0.0005;
  const reasons: ImageQuality['reasons'] = [];
  if (!blank && contrast < 90) reasons.push('low_contrast');
  if (!blank && edgeSharpness < 0.4) reasons.push('blurred');
  return {
    width,
    height,
    darkP1,
    median,
    lightP99,
    contrast,
    inkCoverage,
    edgeSharpness,
    blank,
    lowQuality: reasons.length > 0,
    reasons,
  };
}

/** JPEG dimensions from the first SOFn marker (no decoding). */
export function jpegSize(buf: Uint8Array): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = (buf[i + 2]! << 8) | buf[i + 3]!;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      const height = (buf[i + 5]! << 8) | buf[i + 6]!;
      const width = (buf[i + 7]! << 8) | buf[i + 8]!;
      return width > 0 && height > 0 ? { width, height } : null;
    }
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

/** Pixel size of a PNG or JPEG image, or null for other formats. */
export function imageSize(buf: Uint8Array): { width: number; height: number } | null {
  return pngSize(buf) ?? jpegSize(buf);
}
