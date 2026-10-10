// Regression (I2 performance pass, docs/PERFORMANCE.md): an image page above the OCR pixel budget must not be
// decoded to RGBA for quality metrics — it is never OCR'd, and the decode of a 48 MP photo cost ≈ 0.57 GB of memory
// and 2.6 s for nothing. Below the budget the metrics are still computed (they qualify the OCR text).
import { deflateSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/modules/processing/png', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/modules/processing/png')>();
  return { ...orig, decodePng: vi.fn(orig.decodePng) };
});

import { decodePng, MAX_PNG_PIXELS } from '../../src/modules/processing/png';
import { MAX_OCR_PIXELS } from '../../src/modules/processing/pipeline';
import { addSource, createProcessingApp, pages, processVersion, regions } from './helpers';

/** A real, decodable 1-bit greyscale PNG (white), cheap to build at any size. */
function whitePng(width: number, height: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, body: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const tb = Buffer.concat([Buffer.from(type, 'latin1'), body]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(tb));
    return Buffer.concat([len, tb, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 1; // bit depth
  ihdr[9] = 0; // greyscale
  const stride = Math.ceil(width / 8) + 1;
  const raw = Buffer.alloc(stride * height, 0xff);
  for (let y = 0; y < height; y++) raw[y * stride] = 0; // filter byte
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

describe('image pages above the OCR pixel budget', () => {
  it('are kept as a figure without a full RGBA decode; smaller images still get quality metrics', async () => {
    const decode = vi.mocked(decodePng);
    // 7000 × 6000 = 42 MP: above the OCR budget, below the decoder's own guard (so the old code did decode it)
    const huge = whitePng(7000, 6000);
    expect(7000 * 6000).toBeGreaterThan(MAX_OCR_PIXELS);
    expect(7000 * 6000).toBeLessThan(MAX_PNG_PIXELS);
    const small = whitePng(400, 300);

    const t = await createProcessingApp();
    try {
      const big = await addSource(t, 'huge-photo.png', 'image', { data: huge, fileName: 'huge-photo.png' });
      decode.mockClear();
      const job = await processVersion(t, big.versionId);
      expect(job.status).toBe('completed');
      expect(decode.mock.calls.filter(([buf]) => Buffer.from(buf).equals(huge))).toHaveLength(0);
      const p = pages(t, big.versionId)[0]!;
      expect(p.error_code).toBe('IMAGE_TOO_LARGE');
      expect(p.error_detail).toContain('42 ميغابكسل');
      expect(regions(t, big.versionId).map((r) => r.kind)).toEqual(['figure']);

      const little = await addSource(t, 'small-photo.png', 'image', { data: small, fileName: 'small-photo.png' });
      decode.mockClear();
      await processVersion(t, little.versionId);
      expect(decode.mock.calls.some(([buf]) => Buffer.from(buf).equals(small))).toBe(true);
    } finally {
      await t.close();
    }
  }, 60_000);
});
