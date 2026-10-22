// Drawing a QR (P1-T4 step 3; PRD AOS-2.12): qrcode-generator (MIT), one SVG path of unit squares — crisp at any size, no
// colour, fine on e-ink. Its own module so the join sheet and the other screens do not load the encoder.
import qrcode from 'qrcode-generator';

/** The QR modules of `text` (error correction M, smallest version that fits). ASCII only: links and codes are ASCII. */
export function qrMatrix(text: string): boolean[][] {
  if (!/^[\x20-\x7e]+$/.test(text)) throw new Error('QR payload must be printable ASCII');
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c)));
}

/** One SVG path of 1×1 squares for the dark modules (use with viewBox `-4 -4 n+8 n+8` for the quiet zone). */
export function qrSvgPath(matrix: boolean[][]): string {
  let d = '';
  matrix.forEach((row, r) => row.forEach((dark, c) => dark && (d += `M${c} ${r}h1v1h-1z`)));
  return d;
}
