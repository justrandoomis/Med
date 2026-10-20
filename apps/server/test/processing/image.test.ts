// H2 item 4 — the raster layer (image.ts): JPEG decoding (jpeg-js), EXIF orientation in both TIFF byte orders, the
// eight orientations applied exactly as a browser displays them, quarter-turn rotation, and honest decode errors
// (a damaged picture is CORRUPT, an over-budget one is refused BEFORE allocating, other formats are NOT_IMAGE).
import { describe, expect, it } from 'vitest';
import {
  applyExifOrientation,
  decodeDisplayed,
  decodeImage,
  displayedImageSize,
  encodeJpeg,
  ImageDecodeError,
  jpegDecodeBytes,
  jpegOrientation,
  rotateImage,
} from '../../src/modules/processing/image';
import { encodePng, measureImageQuality, type RgbaImage } from '../../src/modules/processing/png';
import { jpeg, paint, pixel, solid, withExif } from '../helpers/images';

/** 3×2 image with distinct corner colours: TL red, TR green, BL blue, BR white. */
function corners(): RgbaImage {
  const img = solid(3, 2, [0, 0, 0]);
  paint(img, 0, 0, 1, 1, [255, 0, 0]);
  paint(img, 2, 0, 3, 1, [0, 255, 0]);
  paint(img, 0, 1, 1, 2, [0, 0, 255]);
  paint(img, 2, 1, 3, 2, [255, 255, 255]);
  return img;
}
const at = (img: RgbaImage, x: number, y: number) => pixel(img, x, y).join(',');

function decodeError(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof ImageDecodeError) return e.code;
    throw e;
  }
  return 'no error';
}

describe('JPEG decoding and EXIF orientation (H2 item 4)', () => {
  it('decodes a baseline JPEG into RGBA (scan-quality metrics now work for JPEG)', () => {
    const img = paint(solid(120, 60, [245, 245, 240]), 10, 20, 110, 30, [20, 20, 20]);
    const back = decodeImage(jpeg(img));
    expect([back.width, back.height]).toEqual([120, 60]);
    expect(pixel(back, 50, 25).every((v) => v < 50)).toBe(true);
    expect(pixel(back, 50, 45).every((v) => v > 220)).toBe(true);
    const q = measureImageQuality(back);
    expect(q.blank).toBe(false);
    expect(q.contrast).toBeGreaterThan(150);
  });

  it('reads the Orientation tag in little-endian («II», Android) and big-endian («MM», iPhone) EXIF', () => {
    const base = jpeg(solid(8, 4, [200, 200, 200]));
    expect(jpegOrientation(base)).toBe(1);
    for (const o of [1, 3, 6, 8]) {
      expect(jpegOrientation(withExif(base, o, 'II')), `II ${o}`).toBe(o);
      expect(jpegOrientation(withExif(base, o, 'MM')), `MM ${o}`).toBe(o);
    }
    expect(displayedImageSize(withExif(base, 6, 'II'))).toEqual({ width: 4, height: 8 });
    expect(displayedImageSize(withExif(base, 3, 'MM'))).toEqual({ width: 8, height: 4 });
    expect(displayedImageSize(encodePng(solid(8, 4, [0, 0, 0])))).toEqual({ width: 8, height: 4 });
  });

  it('applies all eight orientations exactly as displayed (corner colours land where a browser shows them)', () => {
    const img = corners(); // TL red, TR green, BL blue, BR white
    const R = '255,0,0';
    const G = '0,255,0';
    const B = '0,0,255';
    const W = '255,255,255';
    // [orientation, displayed TL, TR, BL, BR]
    const cases: Array<[number, string, string, string, string]> = [
      [1, R, G, B, W],
      [2, G, R, W, B], // mirrored
      [3, W, B, G, R], // 180°
      [4, B, W, R, G], // mirrored vertically
      [5, R, B, G, W], // transposed
      [6, B, R, W, G], // 90° clockwise
      [7, W, G, B, R], // transversed
      [8, G, W, R, B], // 270° clockwise
    ];
    for (const [o, tl, tr, bl, br] of cases) {
      const d = applyExifOrientation(img, o);
      const w = d.width - 1;
      const h = d.height - 1;
      expect([at(d, 0, 0), at(d, w, 0), at(d, 0, h), at(d, w, h)], `orientation ${o}`).toEqual([tl, tr, bl, br]);
      expect(o >= 5 ? [d.width, d.height] : [d.width, d.height], `size ${o}`).toEqual(o >= 5 ? [2, 3] : [3, 2]);
    }
    expect(at(rotateImage(img, 90), 1, 0)).toBe(R); // TL → TR after a clockwise quarter turn
    expect(at(rotateImage(rotateImage(img, 90), 270), 0, 0)).toBe(R);
  });

  it('decodeDisplayed returns the picture as displayed; re-encoding writes no EXIF', () => {
    const stored = corners();
    const big = solid(30, 20, [0, 0, 0]);
    for (let y = 0; y < 20; y++) for (let x = 0; x < 30; x++) paint(big, x, y, x + 1, y + 1, pixel(stored, Math.min(2, Math.floor(x / 10)), Math.floor(y / 10)));
    const { image, orientation } = decodeDisplayed(withExif(jpeg(big), 6, 'MM'));
    expect(orientation).toBe(6);
    expect([image.width, image.height]).toEqual([20, 30]);
    expect(pixel(image, 2, 2)[2]).toBeGreaterThan(200); // blue (stored bottom-left) is now top-left
    expect(jpegOrientation(encodeJpeg(image))).toBe(1);
  });

  it('a damaged picture is CORRUPT (not a transient failure); an over-budget one is refused before decoding; others are NOT_IMAGE', () => {
    const good = jpeg(solid(64, 64, [128, 128, 128]));
    expect(decodeError(() => decodeImage(good.subarray(0, Math.floor(good.length / 3))))).toBe('CORRUPT');
    const png = encodePng(solid(64, 64, [128, 128, 128]));
    expect(decodeError(() => decodeImage(png.subarray(0, png.length - 30)))).toBe('CORRUPT');
    expect(decodeError(() => decodeImage(good, 1000))).toBe('TOO_LARGE');
    expect(decodeError(() => decodeImage(png, 1000))).toBe('TOO_LARGE');
    expect(decodeError(() => decodeImage(Buffer.from('GIF89a……')))).toBe('NOT_IMAGE');
    // a JPEG header claiming a gigantic frame is refused from the header, no allocation
    const lie = Buffer.from(good);
    const sof = lie.indexOf(Buffer.from([0xff, 0xc0]));
    lie.writeUInt16BE(60000, sof + 5);
    lie.writeUInt16BE(60000, sof + 7);
    expect(decodeError(() => decodeImage(lie))).toBe('TOO_LARGE');
  });

  it('(H2 review) the decode budget holds what it says: a 12 MP photo without chroma subsampling decodes (it was TOO_LARGE)', () => {
    // jpeg-js counts ≈ 14.5 bytes per pixel for a 4:2:0 photo and ≈ 22 for 4:4:4; the old memory cap (8 bytes per budget
    // pixel) refused 4:4:4 JPEGs above ≈ 11 MP and 4:2:0 photos above ≈ 17 MP — below the 24 MP budget it stated, so
    // such a picture got no scan metrics and its Image Quiz was served with browser-drawn masks only
    const big = jpeg(solid(4000, 3000, [180, 180, 180]), 80);
    const img = decodeImage(big);
    expect([img.width, img.height]).toEqual([4000, 3000]);
  }, 60_000);

  it('(H2 review) the working memory is read from the frame header and checked BEFORE decoding', () => {
    const header = (w: number, h: number, sampling: number[]) => {
      // SOI + SOF0 (8-bit, h × w, one component per sampling byte) + EOI — enough for the header readers
      const comps = sampling.flatMap((hv, i) => [i + 1, hv, 0]);
      const len = 8 + comps.length;
      return Buffer.from([0xff, 0xd8, 0xff, 0xc0, len >> 8, len & 255, 8, h >> 8, h & 255, w >> 8, w & 255, sampling.length, ...comps, 0xff, 0xd9]);
    };
    const p420 = header(6000, 4000, [0x22, 0x11, 0x11]); // a 24 MP phone photo
    const p444 = header(6000, 4000, [0x11, 0x11, 0x11]);
    expect(jpegDecodeBytes(p420)! / 24e6).toBeGreaterThan(14);
    expect(jpegDecodeBytes(p420)! / 24e6).toBeLessThan(15);
    expect(jpegDecodeBytes(p444)! / 24e6).toBeGreaterThan(21);
    // 4:4:4 at the full 24 MP budget needs more than the cap: refused from the header, nothing allocated
    expect(decodeError(() => decodeImage(p444))).toBe('TOO_LARGE');
    // the same frame within the budget is not refused for its size (it fails as what it is: a frame without data)
    expect(decodeError(() => decodeImage(header(1200, 800, [0x22, 0x11, 0x11])))).toBe('CORRUPT');
  });

  it('(H2 review) a VALID JPEG in an encoding this decoder does not read (arithmetic / lossless / hierarchical) is UNSUPPORTED, never «damaged»', () => {
    // it was CORRUPT, and an OCR failure on it then said «the picture itself is damaged — reprocessing will not help»
    const good = jpeg(solid(64, 64, [128, 128, 128]));
    for (const marker of [0xc3, 0xc9, 0xca, 0xcb, 0xcd]) {
      const other = Buffer.from(good);
      other[other.indexOf(Buffer.from([0xff, 0xc0])) + 1] = marker;
      expect(decodeError(() => decodeImage(other)), marker.toString(16)).toBe('UNSUPPORTED');
    }
  });
});
