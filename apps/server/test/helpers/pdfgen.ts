// Test-time PDF fixtures (H2): a minimal PDF 1.4 writer (standard Helvetica fonts, one content stream per page,
// optional /Rotate) plus content helpers for text, rectangles, lines and filled polygons — so layout cases (vector
// figures, sideways pages, scanned tables) are built in the test itself instead of committed binaries.
// Rendering to PNG uses the real poppler pdftoppm (the same tool the pipeline uses).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderPdfPage } from '../../src/modules/processing/tools';

export interface GenPage {
  width?: number;
  height?: number;
  rotate?: 0 | 90 | 180 | 270;
  /** raw content stream operators (PDF user space, origin bottom-left) */
  content: string;
}

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

/** Text at (x, y) baseline in PDF user space. */
export function text(x: number, y: number, size: number, s: string, opts: { bold?: boolean } = {}): string {
  return `BT /${opts.bold ? 'F2' : 'F1'} ${size} Tf 1 0 0 1 ${x} ${y} Tm (${esc(s)}) Tj ET\n`;
}

/** Text drawn with an arbitrary text matrix (a b c d at x y). */
export function textMatrix(m: [number, number, number, number], x: number, y: number, size: number, s: string): string {
  return `BT /F1 ${size} Tf ${m.join(' ')} ${x} ${y} Tm (${esc(s)}) Tj ET\n`;
}

export function rect(x: number, y: number, w: number, h: number, op: 'S' | 'f' | 'B' = 'S', lineWidth = 1): string {
  return `${lineWidth} w ${x} ${y} ${w} ${h} re ${op}\n`;
}

export function line(x0: number, y0: number, x1: number, y1: number, lineWidth = 1): string {
  return `${lineWidth} w ${x0} ${y0} m ${x1} ${y1} l S\n`;
}

/** A closed, filled polygon (e.g. an arrowhead). */
export function polygon(points: Array<[number, number]>): string {
  const [first, ...rest] = points;
  return `${first![0]} ${first![1]} m ${rest.map(([x, y]) => `${x} ${y} l`).join(' ')} h f\n`;
}

/** A rounded rectangle (Bézier corners), stroked. */
export function roundRect(x: number, y: number, w: number, h: number, r = 6): string {
  const k = 0.5523 * r;
  return (
    `1 w ${x + r} ${y} m ${x + w - r} ${y} l ${x + w - r + k} ${y} ${x + w} ${y + r - k} ${x + w} ${y + r} c ` +
    `${x + w} ${y + h - r} l ${x + w} ${y + h - r + k} ${x + w - r + k} ${y + h} ${x + w - r} ${y + h} c ` +
    `${x + r} ${y + h} l ${x + r - k} ${y + h} ${x} ${y + h - r + k} ${x} ${y + h - r} c ` +
    `${x} ${y + r} l ${x} ${y + r - k} ${x + r - k} ${y} ${x + r} ${y} c h S\n`
  );
}

/** A downward arrow from (x, y0) to (x, y1) with a filled triangular head. */
export function arrowDown(x: number, y0: number, y1: number): string {
  return line(x, y0, x, y1 + 6) + polygon([[x - 4, y1 + 7], [x + 4, y1 + 7], [x, y1]]);
}

export function makePdf(pages: GenPage[]): Buffer {
  const objs: string[] = [];
  const add = (body: string) => {
    objs.push(body);
    return objs.length;
  };
  const catalog = add('');
  const pagesObj = add('');
  const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const kids: number[] = [];
  for (const p of pages) {
    const w = p.width ?? 595;
    const h = p.height ?? 842;
    const stream = add(`<< /Length ${Buffer.byteLength(p.content, 'latin1')} >>\nstream\n${p.content}\nendstream`);
    kids.push(
      add(
        `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${w} ${h}]${p.rotate ? ` /Rotate ${p.rotate}` : ''} /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${stream} 0 R >>`,
      ),
    );
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n%âãÏÓ\n';
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** Render one page (1-based) to PNG with the real pdftoppm. */
export async function renderPng(pdf: Buffer, pageNumber = 1, dpi = 150): Promise<Buffer> {
  const dir = mkdtempSync(join(tmpdir(), 'medlevo-pdfgen-'));
  try {
    const path = join(dir, 'in.pdf');
    writeFileSync(path, pdf);
    return await renderPdfPage({ pdftoppm: 'pdftoppm', pdfPath: path, pageNumber, dpi, tmpRoot: dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
