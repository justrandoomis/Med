// P1-T4 step 3 — QR for joining (AOS-2.12: «the QR encodes the same expiring join link; in-app scanner with a JS
// decoder and manual-code fallback»). The encoder draws the invite link the admin hands out; the decoder reads it back
// from camera frames or from a chosen picture. Round trip here on raw pixels (no canvas in jsdom).
import { describe, expect, it } from 'vitest';
import { decodeQrPixels, joinFromQrText } from '../../src/features/channels/qr';
import { qrMatrix, qrSvgPath } from '../../src/features/channels/qrEncode';

/** Paint a QR matrix into RGBA pixels: `cell` px per module, a white quiet zone of 4 modules. */
function paint(matrix: boolean[][], cell = 4): { data: Uint8ClampedArray; width: number; height: number } {
  const size = (matrix.length + 8) * cell;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  matrix.forEach((row, r) =>
    row.forEach((dark, c) => {
      if (!dark) return;
      for (let y = 0; y < cell; y++)
        for (let x = 0; x < cell; x++) {
          const i = (((r + 4) * cell + y) * size + (c + 4) * cell + x) * 4;
          data[i] = data[i + 1] = data[i + 2] = 0;
        }
    }),
  );
  return { data, width: size, height: size };
}

describe('QR join codes', () => {
  const link = 'https://medlevo.example/join/abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456';

  it('encodes an invite link and decodes it back from pixels', async () => {
    const m = qrMatrix(link);
    expect(m.length).toBeGreaterThanOrEqual(21);
    expect(m.every((row) => row.length === m.length)).toBe(true);
    const px = paint(m);
    expect(await decodeQrPixels(px.data, px.width, px.height)).toBe(link);
  });

  it('decodes nothing from a blank picture', async () => {
    const blank = new Uint8ClampedArray(120 * 120 * 4).fill(255);
    expect(await decodeQrPixels(blank, 120, 120)).toBeNull();
  });

  it('draws the matrix as one SVG path of unit squares (crisp at any size, works in e-ink)', () => {
    const m = qrMatrix(link);
    const d = qrSvgPath(m);
    const squares = d.match(/M/g)?.length ?? 0;
    expect(squares).toBe(m.flat().filter(Boolean).length);
    expect(d).toMatch(/^M\d+ \d+h1v1h-1z/);
  });

  it('turns a decoded QR into a join request: an invite link, a bare class code, or an Arabic reason', () => {
    expect(joinFromQrText(link)).toEqual({ kind: 'link', token: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456' });
    expect(joinFromQrText('ABCD-EFGH')).toEqual({ kind: 'code', code: 'ABCDEFGH' });
    const other = joinFromQrText('https://shop.example/menu');
    expect(other.kind).toBe('invalid');
    expect(other.kind === 'invalid' && other.reason_ar).toMatch(/ليس رمز انضمام/);
  });
});
