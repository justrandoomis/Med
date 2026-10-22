// QR for joining a channel (P1-T4 step 3; PRD AOS-2.12; IA §8.2 QrCard / QrScannerSheet). The QR carries exactly the
// invite link the admin hands out (`qr_payload` of a new invite link); the code is always printed as text beside it.
//  * encoding: qrEncode.ts (qrcode-generator, MIT), loaded only with the screens that draw a QR;
//  * decoding: jsQR (Apache-2.0), loaded only when the scanner or a picture is used (its own chunk).
import { parseJoinInput, type JoinInput } from './model';

/** Decode a QR from RGBA pixels (a camera frame or a picture); null when none is found. */
export async function decodeQrPixels(data: Uint8ClampedArray, width: number, height: number): Promise<string | null> {
  const { default: jsQR } = await import('jsqr');
  const hit = jsQR(data, width, height, { inversionAttempts: 'attemptBoth' });
  return hit?.data ? hit.data : null;
}

/** What a decoded QR asks for: an invite link, a class code — anything else is not a join code. */
export function joinFromQrText(text: string): JoinInput {
  const r = parseJoinInput(text);
  if (r.kind === 'link' || (r.kind === 'code' && r.code.length === 8)) return r;
  return { kind: 'invalid', reason_ar: 'هذا الرمز ليس رمز انضمام إلى قناة. امسح رمز QR الذي يعرضه مشرف المادة، أو اكتب الرمز بنفسك.' };
}

/** Decode a QR from a picture the person chose (a screenshot of the invite, a photo of the board). */
export async function decodeQrFromFile(file: Blob): Promise<string | null> {
  const bitmap = await createImageBitmap(file);
  try {
    // large photos are scaled down: QR decoding needs ~4 px per module, not 12 megapixels
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const g = canvas.getContext('2d', { willReadFrequently: true });
    if (!g) return null;
    g.fillStyle = '#fff';
    g.fillRect(0, 0, w, h);
    g.drawImage(bitmap, 0, 0, w, h);
    const img = g.getImageData(0, 0, w, h);
    return decodeQrPixels(img.data, w, h);
  } finally {
    bitmap.close();
  }
}
