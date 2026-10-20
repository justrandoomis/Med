// H2 items 3, 4, 7 — scans and photos in the right orientation, JPEG metrics, and an honest OCR failure reason.
//  * a page photo stored sideways / upside down is OCR'd in the orientation where its text reads (rotated trials, chosen
//    by reading quality), the detected rotation is stored, the reader shows it upright (page rotation) and every box
//    stays in the picture's own space;
//  * a JPEG's EXIF orientation is applied before OCR (both TIFF byte orders) and the page has the DISPLAYED size;
//  * JPEG scans get quality metrics (low contrast → LOW_QUALITY_SCAN) like PNG;
//  * a damaged picture says «الصورة نفسها تالفة — إعادة المعالجة لن تفيد», a transient engine failure says «أعد المعالجة».
// Fixtures are made in the test: a text page rendered by the real pdftoppm, rotated / re-encoded in memory.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { NormBox } from '@medlevo/shared';
import { fromJson } from '../../src/db/db';
import { rotateImage } from '../../src/modules/processing/image';
import { OcrEngine } from '../../src/modules/processing/ocr';
import { decodePng, encodePng, type RgbaImage } from '../../src/modules/processing/png';
import type { TestApp } from '../helpers/app';
import { jpeg, withExif } from '../helpers/images';
import { makePdf, renderPng, text } from '../helpers/pdfgen';
import { addSource, createProcessingApp, pages, processVersion, regions } from './helpers';

const HEADING = 'Acute appendicitis: clinical features';
const LINES = [
  'Pain starts around the umbilicus and migrates to the',
  'right iliac fossa within 24 hours. Anorexia and nausea are',
  'common; fever is usually low grade. Tenderness at',
  "McBurney's point and rebound tenderness suggest peritonitis.",
];

let upright: RgbaImage;
let t: TestApp;

beforeAll(async () => {
  let content = text(50, 350, 20, HEADING, { bold: true });
  LINES.forEach((l, i) => (content += text(50, 305 - i * 17, 13, l)));
  content += text(50, 150, 13, 'Ultrasound is the first-line imaging test in children.');
  upright = decodePng(await renderPng(makePdf([{ content, width: 500, height: 400 }]), 1, 200));
  t = await createProcessingApp();
}, 120_000);
afterAll(async () => t?.close());

interface PageOrientation {
  rotation: number;
  width: number;
  height: number;
  content_rotation: number | null;
  content_rotation_origin: string | null;
  image_orientation: number | null;
  error_code: string | null;
  error_detail: string | null;
  processing_status: string;
}
const orientationOf = (versionId: string): PageOrientation =>
  t.ctx.db.get<PageOrientation>(
    'SELECT rotation, width, height, content_rotation, content_rotation_origin, image_orientation, error_code, error_detail, processing_status FROM source_page WHERE version_id = ?',
    [versionId],
  )!;

async function imagePage(name: string, data: Buffer): Promise<string> {
  const { versionId } = await addSource(t, name, 'image', { data, fileName: name });
  await processVersion(t, versionId);
  return versionId;
}

const allText = (versionId: string) =>
  regions(t, versionId)
    .map((r) => r.text ?? '')
    .join('\n');

function expectReadsUpright(versionId: string): void {
  const rs = regions(t, versionId).filter((r) => r.text);
  const all = rs.map((r) => r.text).join('\n');
  // the lines of the paragraph come back whole and in reading order (not one region per word, not scrambled)
  expect(all).toContain('Pain starts around the umbilicus');
  expect(all).toContain("McBurney's point and rebound tenderness");
  expect(all.indexOf('Acute appendicitis')).toBeLessThan(all.indexOf('Pain starts'));
  expect(all.indexOf('Pain starts')).toBeLessThan(all.indexOf('Ultrasound is the first-line'));
  const para = rs.find((r) => r.text!.includes('Pain starts'))!;
  expect(para.text).toContain('migrates to the right iliac fossa');
}

describe('page photos in the right orientation (H2 item 3)', () => {
  it('an upright scan: read as is, rotation 0 recorded (checked by the reading)', async () => {
    const v = await imagePage('upright.png', encodePng(upright));
    expectReadsUpright(v);
    expect(orientationOf(v)).toMatchObject({ rotation: 0, content_rotation: 0, content_rotation_origin: 'ocr_trials', width: upright.width, height: upright.height });
  }, 120_000);

  for (const turned of [90, 180, 270] as const) {
    it(`a photo stored turned ${turned}° clockwise: read upright, the rotation is stored and shown, boxes stay in the photo's space`, async () => {
      const img = rotateImage(upright, turned);
      const v = await imagePage(`turned-${turned}.png`, encodePng(img));
      expectReadsUpright(v);
      const back = (360 - turned) % 360;
      const o = orientationOf(v);
      expect(o).toMatchObject({ content_rotation: back, content_rotation_origin: 'ocr_trials', rotation: back, width: img.width, height: img.height });
      // the heading sits at the top of the UPRIGHT page: in the stored photo that is the right edge (90°), the bottom
      // (180°) or the left edge (270°) — boxes are normalized to the photo as stored, never to the rotated reading
      const heading = regions(t, v).find((r) => r.text?.includes('Acute appendicitis'))!;
      const b = fromJson<NormBox>(heading.bbox_json)!;
      if (turned === 90) expect(b.x + b.w).toBeGreaterThan(0.8);
      if (turned === 180) expect(b.y + b.h).toBeGreaterThan(0.8);
      if (turned === 270) expect(b.x).toBeLessThan(0.2);
      if (turned !== 180) expect(b.h).toBeGreaterThan(b.w * (img.height / img.width)); // tall in the stored photo
    }, 180_000);
  }
});

describe('JPEG photos: EXIF orientation before OCR, displayed size, quality metrics (H2 items 3, 4)', () => {
  it('a phone photo stored sideways with EXIF orientation 6 (both byte orders) is read upright; the page has the displayed size', async () => {
    // stored = upright turned 90° counter-clockwise; EXIF 6 tells viewers to turn it 90° clockwise
    const stored = rotateImage(upright, 270);
    for (const order of ['II', 'MM'] as const) {
      const v = await imagePage(`phone-${order}.jpg`, withExif(jpeg(stored, 92), 6, order));
      expectReadsUpright(v);
      expect(orientationOf(v), order).toMatchObject({ image_orientation: 6, content_rotation: 0, rotation: 0, width: upright.width, height: upright.height });
    }
  }, 240_000);

  it('a washed-out JPEG scan is flagged LOW_QUALITY_SCAN (metrics were PNG-only)', async () => {
    const faint: RgbaImage = { width: upright.width, height: upright.height, data: new Uint8Array(upright.data) };
    for (let i = 0; i < faint.data.length; i += 4) for (let c = 0; c < 3; c++) faint.data[i + c] = 175 + Math.round((faint.data[i + c]! * 60) / 255);
    const v = await imagePage('faint.jpg', jpeg(faint, 90));
    const o = orientationOf(v);
    expect(o.error_code).toBe('LOW_QUALITY_SCAN');
    expect(o.processing_status).toBe('needs_review');
  }, 120_000);
});

describe('OCR failure reasons (H2 item 7)', () => {
  it('a damaged picture: «الصورة نفسها تالفة — إعادة المعالجة لن تفيد», never «retry later»', async () => {
    const good = jpeg(upright, 90);
    for (const [name, data] of [
      ['cut.jpg', good.subarray(0, Math.floor(good.length / 4))],
      ['cut.png', encodePng(upright).subarray(0, 4000)],
    ] as const) {
      const v = await imagePage(name, Buffer.from(data));
      const o = orientationOf(v);
      expect(o.processing_status, name).toBe('failed');
      expect(o.error_code, name).toBe('OCR_FAILED');
      expect(o.error_detail, name).toContain('الصورة نفسها تالفة — إعادة المعالجة لن تفيد');
      expect(o.error_detail, name).not.toContain('أعد معالجة الصفحة لاحقًا');
      expect(o.error_detail, name).toContain('بقية الصفحات لم تتأثر');
    }
  }, 120_000);

  it('a transient engine failure on a sound picture keeps the «retry later» reason', async () => {
    const spy = vi.spyOn(OcrEngine.prototype, 'recognize').mockRejectedValueOnce(new Error('worker crashed'));
    try {
      const v = await imagePage('sound.png', encodePng(upright));
      const o = orientationOf(v);
      expect(o.error_code).toBe('OCR_FAILED');
      expect(o.error_detail).toContain('أعد معالجة الصفحة لاحقًا');
      expect(o.error_detail).not.toContain('تالفة');
    } finally {
      spy.mockRestore();
    }
    expect(allText).toBeTypeOf('function');
  }, 120_000);
});

void pages;
