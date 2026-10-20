// Test-time image fixtures (H2): small rasters built in memory, JPEG encoding through jpeg-js and an EXIF APP1
// segment with an Orientation tag in either TIFF byte order — so EXIF / JPEG paths are tested without binary fixtures.
import { encode as encodeJpegJs } from 'jpeg-js';
import type { RgbaImage } from '../../src/modules/processing/png';

/** A W×H image filled with one RGB colour. */
export function solid(width: number, height: number, rgb: [number, number, number]): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = rgb[0];
    data[i * 4 + 1] = rgb[1];
    data[i * 4 + 2] = rgb[2];
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

/** Paint a pixel rectangle (clamped). */
export function paint(img: RgbaImage, x0: number, y0: number, x1: number, y1: number, rgb: [number, number, number]): RgbaImage {
  for (let y = Math.max(0, y0); y < Math.min(img.height, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(img.width, x1); x++) {
      const o = (y * img.width + x) * 4;
      img.data[o] = rgb[0];
      img.data[o + 1] = rgb[1];
      img.data[o + 2] = rgb[2];
      img.data[o + 3] = 255;
    }
  }
  return img;
}

export function pixel(img: RgbaImage, x: number, y: number): [number, number, number] {
  const o = (y * img.width + x) * 4;
  return [img.data[o]!, img.data[o + 1]!, img.data[o + 2]!];
}

/** Baseline JPEG of an RGBA image (quality 95, no metadata). */
export function jpeg(img: RgbaImage, quality = 95): Buffer {
  return encodeJpegJs({ width: img.width, height: img.height, data: img.data }, quality).data;
}

/** Insert an EXIF APP1 segment (IFD0 with one Orientation tag) right after the SOI marker. */
export function withExif(jpegBytes: Buffer, orientation: number, order: 'II' | 'MM' = 'II'): Buffer {
  const le = order === 'II';
  const tiff = Buffer.alloc(8 + 2 + 12 + 4);
  tiff.write(order, 0, 'latin1');
  const w16 = (v: number, o: number) => (le ? tiff.writeUInt16LE(v, o) : tiff.writeUInt16BE(v, o));
  const w32 = (v: number, o: number) => (le ? tiff.writeUInt32LE(v, o) : tiff.writeUInt32BE(v, o));
  w16(42, 2);
  w32(8, 4); // IFD0 offset
  w16(1, 8); // one entry
  w16(0x0112, 10); // Orientation
  w16(3, 12); // SHORT
  w32(1, 14); // count
  w16(orientation, 18); // value (left-justified in the 4-byte field)
  w32(0, 22); // no next IFD
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const seg = Buffer.alloc(4);
  seg[0] = 0xff;
  seg[1] = 0xe1;
  seg.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([jpegBytes.subarray(0, 2), seg, body, jpegBytes.subarray(2)]);
}
