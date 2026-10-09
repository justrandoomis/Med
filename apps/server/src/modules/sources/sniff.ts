// File type detection from CONTENT (magic bytes), never from the extension or the client's MIME (§49).
export type SniffedImage = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | 'image/tiff';
export type SniffedAudio = 'audio/mpeg' | 'audio/mp4' | 'audio/wav' | 'audio/ogg';

export type Sniffed =
  | { kind: 'pdf' }
  | { kind: 'zip' }
  | { kind: 'ole2' }
  | { kind: 'image'; mime: SniffedImage }
  | { kind: 'audio'; mime: SniffedAudio }
  | { kind: 'unsupported'; what: UnsupportedKind };

export type UnsupportedKind =
  | 'empty'
  | 'heic'
  | 'avif'
  | 'bmp'
  | 'svg'
  | 'video'
  | 'rar'
  | '7z'
  | 'gzip'
  | 'executable'
  | 'html'
  | 'text'
  | 'rtf'
  | 'unknown';

export const IMAGE_MIMES: readonly SniffedImage[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/tiff'];

const ascii = (b: Uint8Array, start: number, len: number) => Buffer.from(b.subarray(start, start + len)).toString('latin1');
const starts = (b: Uint8Array, bytes: number[], at = 0) => b.length >= at + bytes.length && bytes.every((x, i) => b[at + i] === x);

/** Detect the content type of a file from its first bytes (64 KiB is plenty). */
export function sniff(head: Uint8Array): Sniffed {
  if (head.length === 0) return { kind: 'unsupported', what: 'empty' };
  // %PDF- may legally be preceded by junk within the first 1024 bytes
  const first1k = Buffer.from(head.subarray(0, 1024));
  if (first1k.indexOf('%PDF-', 0, 'latin1') !== -1) return { kind: 'pdf' };
  if (starts(head, [0x50, 0x4b, 0x03, 0x04]) || starts(head, [0x50, 0x4b, 0x05, 0x06]) || starts(head, [0x50, 0x4b, 0x07, 0x08])) {
    return { kind: 'zip' };
  }
  if (starts(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return { kind: 'ole2' };
  if (starts(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { kind: 'image', mime: 'image/png' };
  if (starts(head, [0xff, 0xd8, 0xff])) return { kind: 'image', mime: 'image/jpeg' };
  if (ascii(head, 0, 6) === 'GIF87a' || ascii(head, 0, 6) === 'GIF89a') return { kind: 'image', mime: 'image/gif' };
  if (starts(head, [0x49, 0x49, 0x2a, 0x00]) || starts(head, [0x4d, 0x4d, 0x00, 0x2a])) return { kind: 'image', mime: 'image/tiff' };
  if (ascii(head, 0, 4) === 'RIFF') {
    const form = ascii(head, 8, 4);
    if (form === 'WEBP') return { kind: 'image', mime: 'image/webp' };
    if (form === 'WAVE') return { kind: 'audio', mime: 'audio/wav' };
    if (form === 'AVI ') return { kind: 'unsupported', what: 'video' };
    return { kind: 'unsupported', what: 'unknown' };
  }
  if (ascii(head, 4, 4) === 'ftyp') {
    const brand = ascii(head, 8, 4);
    if (['M4A ', 'M4B ', 'M4P '].includes(brand)) return { kind: 'audio', mime: 'audio/mp4' };
    if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1', 'heim', 'heis'].includes(brand)) return { kind: 'unsupported', what: 'heic' };
    if (['avif', 'avis'].includes(brand)) return { kind: 'unsupported', what: 'avif' };
    return { kind: 'unsupported', what: 'video' };
  }
  if (ascii(head, 0, 3) === 'ID3') return { kind: 'audio', mime: 'audio/mpeg' };
  // MPEG audio layer III frame sync (FF Fx with layer bits = 01)
  if (head.length >= 2 && head[0] === 0xff && (head[1]! & 0xe0) === 0xe0 && (head[1]! & 0x06) === 0x02 && (head[1]! & 0x18) !== 0x08) {
    return { kind: 'audio', mime: 'audio/mpeg' };
  }
  if (ascii(head, 0, 4) === 'OggS') return { kind: 'audio', mime: 'audio/ogg' };
  if (ascii(head, 0, 2) === 'BM') return { kind: 'unsupported', what: 'bmp' };
  if (starts(head, [0x52, 0x61, 0x72, 0x21])) return { kind: 'unsupported', what: 'rar' };
  if (starts(head, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return { kind: 'unsupported', what: '7z' };
  if (starts(head, [0x1f, 0x8b])) return { kind: 'unsupported', what: 'gzip' };
  if (ascii(head, 0, 2) === 'MZ' || starts(head, [0x7f, 0x45, 0x4c, 0x46]) || starts(head, [0xcf, 0xfa, 0xed, 0xfe])) {
    return { kind: 'unsupported', what: 'executable' };
  }
  if (head.length >= 4 && (ascii(head, 0, 4) === '\x1a\x45\xdf\xa3' || ascii(head, 4, 4) === 'moov')) return { kind: 'unsupported', what: 'video' };
  // text-like formats
  const text = Buffer.from(head.subarray(0, 4096));
  if (!text.includes(0)) {
    const t = text.toString('utf8').replace(/^﻿/, '').trimStart().toLowerCase();
    if (t.startsWith('{\\rtf')) return { kind: 'unsupported', what: 'rtf' };
    if (t.startsWith('<svg') || (t.startsWith('<?xml') && t.includes('<svg'))) return { kind: 'unsupported', what: 'svg' };
    if (t.startsWith('<!doctype html') || t.startsWith('<html')) return { kind: 'unsupported', what: 'html' };
    if (isLikelyUtf8Text(text)) return { kind: 'unsupported', what: 'text' };
  }
  return { kind: 'unsupported', what: 'unknown' };
}

function isLikelyUtf8Text(buf: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, Math.max(0, buf.length - 4)));
  } catch {
    return false;
  }
  let control = 0;
  for (const b of buf) if (b < 0x09 || (b > 0x0d && b < 0x20)) control++;
  return control <= buf.length * 0.01;
}

/** Arabic rejection reason for content that is not a supported study source. */
export const UNSUPPORTED_REASONS_AR: Record<UnsupportedKind, string> = {
  empty: 'الملف فارغ (حجمه صفر).',
  heic: 'صور HEIC (صيغة صور iPhone) غير مدعومة حاليًا. صدّرها بصيغة JPEG أو PNG ثم ارفعها.',
  avif: 'صور AVIF غير مدعومة حاليًا. حوّلها إلى JPEG أو PNG ثم ارفعها.',
  bmp: 'صور BMP غير مدعومة. حوّلها إلى PNG أو JPEG ثم ارفعها.',
  svg: 'ملفات SVG غير مدعومة كمصادر (قد تحتوي على شيفرة نشطة). صدّرها كصورة PNG.',
  video: 'ملفات الفيديو غير مدعومة. يمكن رفع الصوت فقط (MP3 أو M4A أو WAV أو OGG).',
  rar: 'أرشيف RAR غير مدعوم. استخدم ZIP للصور المرتبة.',
  '7z': 'أرشيف 7z غير مدعوم. استخدم ZIP للصور المرتبة.',
  gzip: 'الملفات المضغوطة بـ gzip غير مدعومة. استخدم ZIP للصور المرتبة.',
  executable: 'ملف تنفيذي — رُفض لأسباب أمنية.',
  html: 'صفحات HTML غير مدعومة كمصادر. احفظ الصفحة بصيغة PDF ثم ارفعها.',
  text: 'ملفات النص العادي غير مدعومة للرفع حاليًا. احفظها بصيغة PDF أو DOCX.',
  rtf: 'ملفات RTF غير مدعومة. احفظها بصيغة DOCX أو PDF.',
  unknown: 'صيغة الملف غير معروفة أو غير مدعومة. الصيغ المدعومة: PDF، DOCX، PPTX، الصور (PNG، JPEG، WebP، GIF، TIFF)، ZIP للصور، والصوت.',
};

// ───────── OLE2 (legacy Office) ─────────
export type OleKind = 'doc' | 'ppt' | 'xls' | 'encrypted_ooxml' | 'unknown';

/** Classify a compound file by its directory stream names (UTF-16LE in the directory sectors). */
export function classifyOle(buf: Buffer): OleKind {
  const has = (name: string) => buf.indexOf(Buffer.from(name, 'utf16le')) !== -1;
  if (has('EncryptedPackage')) return 'encrypted_ooxml';
  if (has('WordDocument')) return 'doc';
  if (has('PowerPoint Document')) return 'ppt';
  if (has('Workbook') || has('Book')) return 'xls';
  return 'unknown';
}

// ───────── image dimensions (header parsing only) ─────────
export function imageSize(mime: SniffedImage, b: Buffer): { width: number; height: number } | null {
  try {
    switch (mime) {
      case 'image/png':
        if (b.length >= 24 && b.toString('latin1', 12, 16) === 'IHDR') return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
        return null;
      case 'image/gif':
        return b.length >= 10 ? { width: b.readUInt16LE(6), height: b.readUInt16LE(8) } : null;
      case 'image/webp': {
        const chunk = b.toString('latin1', 12, 16);
        if (chunk === 'VP8 ' && b.length >= 30) return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
        if (chunk === 'VP8L' && b.length >= 25) {
          const bits = b.readUInt32LE(21);
          return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
        }
        if (chunk === 'VP8X' && b.length >= 30) {
          return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
        }
        return null;
      }
      case 'image/jpeg': {
        let i = 2;
        while (i + 9 < b.length) {
          if (b[i] !== 0xff) {
            i++;
            continue;
          }
          const marker = b[i + 1]!;
          if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) {
            i += marker === 0xff ? 1 : 2;
            continue;
          }
          const len = b.readUInt16BE(i + 2);
          // SOF0..SOF15 except DHT (C4), JPG (C8), DAC (CC)
          if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
            return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
          }
          i += 2 + len;
        }
        return null;
      }
      case 'image/tiff':
        // the first IFD is often written AFTER the pixel data (beyond any fixed-size head) → tiffSize()
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * TIFF pixel size from the first IFD (ImageWidth 256 / ImageLength 257, SHORT or LONG). `read` returns
 * the bytes at an absolute offset, so the IFD can be anywhere in the file. Classic TIFF only (not BigTIFF).
 */
export async function tiffSize(read: (offset: number, length: number) => Promise<Buffer>): Promise<{ width: number; height: number } | null> {
  try {
    const head = await read(0, 8);
    if (head.length < 8) return null;
    const le = head.toString('latin1', 0, 2) === 'II';
    if (!le && head.toString('latin1', 0, 2) !== 'MM') return null;
    const u16 = (b: Buffer, o: number) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
    const u32 = (b: Buffer, o: number) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
    if (u16(head, 2) !== 42) return null;
    const ifd = u32(head, 4);
    const countBuf = await read(ifd, 2);
    if (countBuf.length < 2) return null;
    const n = Math.min(u16(countBuf, 0), 4096);
    const entries = await read(ifd + 2, n * 12);
    let width: number | null = null;
    let height: number | null = null;
    for (let i = 0; i + 12 <= entries.length; i += 12) {
      const tag = u16(entries, i);
      if (tag !== 256 && tag !== 257) continue;
      const type = u16(entries, i + 2);
      const v = type === 3 ? u16(entries, i + 8) : type === 4 ? u32(entries, i + 8) : null;
      if (tag === 256) width = v;
      else height = v;
    }
    return width && height ? { width, height } : null;
  } catch {
    return null;
  }
}

// ───────── names ─────────
/** File name as shown to the owner: base name, control characters removed, bounded length. */
export function cleanFileName(name: string | undefined | null): string {
  const base = (name ?? '').split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const cleaned = base.normalize('NFC').replace(/[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]/g, '').trim();
  return (cleaned || 'ملف بلا اسم').slice(0, 255);
}

/** Title default = file name without its extension (never invented). */
export function titleFromFileName(name: string): string {
  const withoutExt = name.replace(/\.[A-Za-z0-9]{1,8}$/, '');
  const t = withoutExt.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (t || name).slice(0, 300);
}

/** Natural (numeric-aware) path order: 2.png before 10.png. */
const collator = new Intl.Collator(['en', 'ar'], { numeric: true, sensitivity: 'base' });
export function naturalCompare(a: string, b: string): number {
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}
