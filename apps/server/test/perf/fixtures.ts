// LARGE synthetic fixtures for the performance & resilience pass (§55, §58). Generated at test time and cached in
// the OS temp dir (never committed): Chromium (the repo's Playwright, /opt/pw-browsers/chromium) prints HTML to real
// PDFs with a real text layer (Arabic shaping + bidi done by the browser), and a tiny zlib PNG encoder makes images.
//
// Every document says «TEST FIXTURE — synthetic performance document. Not a medical reference.» The sentences are
// structural filler (numbers, units, NOT/EXCEPT, Arabic/English mix) chosen to exercise extraction; they are not
// medical statements and must never be shown to the owner as study material.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeflate } from 'node:zlib';

/** Perf tests run only with MEDLEVO_PERF=1 (they take minutes and need Chromium + poppler). */
export const PERF_ENABLED = process.env.MEDLEVO_PERF === '1';
export const CHROMIUM = process.env.PW_CHROMIUM_PATH || '/opt/pw-browsers/chromium';
export const FIXTURE_NOTICE = 'TEST FIXTURE — synthetic performance document. Not a medical reference.';
/** bump to regenerate cached fixtures after a generator change */
const GENERATOR_VERSION = 'perf-fixtures-v2';
export const CACHE_DIR = process.env.MEDLEVO_PERF_CACHE || join(tmpdir(), 'medlevo-perf-fixtures');

function cachePath(kind: string, params: unknown, ext: string): string {
  const key = createHash('sha256').update(JSON.stringify([GENERATOR_VERSION, kind, params])).digest('hex').slice(0, 16);
  mkdirSync(CACHE_DIR, { recursive: true });
  return join(CACHE_DIR, `${kind}-${key}.${ext}`);
}

async function cached(kind: string, params: unknown, ext: string, make: () => Promise<Buffer> | Buffer): Promise<{ path: string; data: Buffer }> {
  const path = cachePath(kind, params, ext);
  if (existsSync(path)) return { path, data: readFileSync(path) };
  const data = await make();
  writeFileSync(`${path}.part`, data);
  renameSync(`${path}.part`, path);
  return { path, data };
}

// ───────────────────────── PNG (RGB, 8-bit, filter 0) ─────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, body: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  const tb = Buffer.concat([Buffer.from(type, 'latin1'), body]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(tb));
  return Buffer.concat([len, tb, c]);
}

/**
 * RGB PNG built row by row and streamed through one zlib deflate (memory: one row + the compressed output — the raw
 * image is never held, so generating a 48 MP fixture does not inflate the memory the perf tests then measure).
 * `grey(x, y)` returns 0–255 (scan-like content); a slight warm paper tint makes it a real 3-channel RGB file.
 */
export async function encodeRgbPng(width: number, height: number, grey: (x: number, y: number) => number): Promise<Buffer> {
  const stride = width * 3 + 1;
  const deflate = createDeflate({ level: 6 });
  const parts: Buffer[] = [];
  deflate.on('data', (b: Buffer) => parts.push(b));
  const done = new Promise<void>((resolve, reject) => {
    deflate.once('end', resolve);
    deflate.once('error', reject);
  });
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(stride);
    row[0] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const g = grey(x, y);
      const p = 1 + x * 3;
      row[p] = Math.min(255, g + 3);
      row[p + 1] = Math.min(255, g + 1);
      row[p + 2] = g;
    }
    if (!deflate.write(row)) await new Promise<void>((r) => deflate.once('drain', r));
  }
  deflate.end();
  await done;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', Buffer.concat(parts)), chunk('IEND', Buffer.alloc(0))]);
}

/** A scan-like high-resolution page photo: paper, dark «text lines», a framed box. 6000×8000 = 48 MP by default. */
export async function largeScanPng(width = 6000, height = 8000): Promise<{ path: string; data: Buffer; width: number; height: number }> {
  const r = await cached('scan-png', { width, height }, 'png', async () => {
    const margin = Math.round(width * 0.08);
    const lineH = Math.max(8, Math.round(height / 90));
    return await encodeRgbPng(width, height, (x, y) => {
      if (x < margin || x > width - margin || y < margin || y > height - margin) return 246;
      const row = Math.floor((y - margin) / lineH);
      const inLine = (y - margin) % lineH < lineH * 0.45;
      // word-like dashes of varying length per row
      const word = Math.floor((x + row * 37) / Math.max(20, Math.round(width / 60))) % 7 !== 0;
      if (inLine && word && row % 12 !== 11) return 30 + ((x * 7 + y * 13) % 25);
      return 240 + ((x + y) % 7);
    });
  });
  return { ...r, width, height };
}

// ───────────────────────── Chromium → PDF ─────────────────────────
type Browser = import('@playwright/test').Browser;

export async function withBrowser<T>(fn: (b: Browser) => Promise<T>): Promise<T> {
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch({ executablePath: CHROMIUM });
  try {
    return await fn(browser);
  } finally {
    await browser.close();
  }
}

async function htmlToPdf(html: string): Promise<Buffer> {
  return withBrowser(async (b) => {
    const page = await b.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate('document.fonts.ready.then(() => true)'); // string: this file has no DOM lib
    return Buffer.from(await page.pdf({ preferCSSPageSize: true, printBackground: true }));
  });
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const BASE_CSS = `
@page { size: A4; margin: 0 }
* { box-sizing: border-box }
body { margin: 0; font-family: 'DejaVu Sans', sans-serif; color: #111; background: #fff }
.page { position: relative; height: 296.5mm; padding: 20mm 18mm 22mm; overflow: hidden; break-after: page }
.hdr { position: absolute; top: 8mm; left: 18mm; right: 18mm; font-size: 7.5pt; color: #555 }
.ftr { position: absolute; bottom: 9mm; left: 0; right: 0; text-align: center; font-size: 9pt; color: #333 }
h1 { font-size: 17pt; margin: 0 0 4mm } h2 { font-size: 12.5pt; margin: 4mm 0 2mm }
p { font-size: 10pt; line-height: 1.35; margin: 0 0 2.2mm; text-align: justify }
p[dir=rtl] { text-align: right }
.cols { column-count: 2; column-gap: 7mm } .cols p { font-size: 8.4pt; line-height: 1.28; margin-bottom: 1.6mm }
table { border-collapse: collapse; width: 100%; font-size: 9pt; margin: 3mm 0 }
td, th { border: 0.6pt solid #222; padding: 1.2mm 2mm; text-align: left }
th { font-weight: bold; background: #eee }
figure { margin: 4mm 0; text-align: center } figure img { width: 120mm } figcaption { font-size: 9pt; margin-top: 2mm }
`;

const EN = [
  'The fixture value of {n}.{m} mmol/L is printed here so that numbers and units survive extraction.',
  'This sentence is NOT a clinical statement; it keeps the negation token for the critical-token checks.',
  'All of the listed fixture items EXCEPT item {m} carry a dose written as {n} mg/kg every 8 hours.',
  'A threshold of {n}0/{m}0 mmHg appears in this paragraph together with the term CT scan and ultrasound.',
  'Section {n} continues with a longer explanatory paragraph that wraps over several printed lines in order to build realistic line, block and column structure for the layout analyser.',
  'Reference ranges such as {m}.{n} ×10⁹/L and {n}{m} U/L are repeated across pages to give the search index many similar chunks.',
];
const AR = [
  'هذه فقرة اختبار رقم {n} لاختبار استخراج النص العربي وليست مرجعًا طبيًا، وتحتوي على مصطلح Appendicitis داخل الجملة.',
  'القيمة التجريبية {n}.{m} ملغ/دل مذكورة هنا لاختبار الأرقام والوحدات، مع كلمة لا للنفي في وسط السطر.',
  'يتكرر عنوان القسم {m} في صفحات متعددة حتى يحتوي فهرس البحث على مقاطع متشابهة كثيرة يجب ترتيبها بدقة.',
];

function sentence(list: readonly string[], i: number, n: number, m: number): string {
  return list[i % list.length]!.replaceAll('{n}', String(n)).replaceAll('{m}', String(m));
}

function paragraph(page: number, k: number, words: 'normal' | 'dense'): string {
  const arabic = (page + k) % 4 === 1;
  const reps = words === 'dense' ? 3 : 2;
  if (arabic) {
    const s = Array.from({ length: reps }, (_, r) => sentence(AR, k + r, page + 1, k + r + 1)).join(' ');
    return `<p dir="rtl" lang="ar">${esc(s)}</p>`;
  }
  const s = Array.from({ length: reps + 1 }, (_, r) => sentence(EN, page + k + r, page + 1, k + r + 1)).join(' ');
  return `<p>${esc(s)}</p>`;
}

let figurePng: string | null = null;
/** a small flowchart-like PNG (boxes + connectors), as a data URI → an image XObject in the PDF */
async function figureDataUri(): Promise<string> {
  if (figurePng) return figurePng;
  const w = 600;
  const h = 300;
  const png = await encodeRgbPng(w, h, (x, y) => {
    const box = (bx: number, by: number) => (Math.abs(x - bx) < 90 && (Math.abs(y - by) === 40 || Math.abs(y - by) === 41)) || (Math.abs(y - by) < 40 && (Math.abs(x - bx) === 90 || Math.abs(x - bx) === 91));
    if (box(120, 80) || box(480, 80) || box(300, 220)) return 20;
    if ((y === 80 || y === 81) && x > 210 && x < 390) return 40;
    if ((x === 300 || x === 301) && y > 80 && y < 180) return 40;
    return 252;
  });
  figurePng = `data:image/png;base64,${png.toString('base64')}`;
  return figurePng;
}

export interface LectureOptions {
  pages: number;
  /** every n-th page is a dense two-column page (0 = none) */
  twoColumnEvery?: number;
  /** every n-th page carries a ruled table (0 = none) */
  tableEvery?: number;
  /** every n-th page carries a raster figure + caption (0 = none) */
  figureEvery?: number;
  /** all pages dense two-column */
  allDense?: boolean;
}

/** which page of every `every` pages carries the table (not the two-column slot, every-5th = index 4) */
export const tableSlot = (every: number) => Math.max(0, every - 3);
/** which page of every `every` pages carries the figure */
export const figureSlot = (every: number) => Math.floor(every / 2);

function lectureHtml(o: LectureOptions, figureUri = ''): string {
  const pages: string[] = [];
  for (let i = 0; i < o.pages; i++) {
    const dense = o.allDense || (!!o.twoColumnEvery && i % o.twoColumnEvery === o.twoColumnEvery - 1);
    const parts: string[] = [`<div class="hdr">MedLevo performance fixture · ${esc(FIXTURE_NOTICE)}</div>`];
    parts.push(i % 3 === 2 ? `<h1 dir="rtl" lang="ar">القسم ${i + 1}: موضوع تجريبي ${i + 1}</h1>` : `<h1>Section ${i + 1}: Fixture topic ${i + 1}</h1>`);
    if (dense) {
      const body = Array.from({ length: 18 }, (_, k) => paragraph(i, k, 'dense')).join('');
      parts.push(`<div class="cols">${body}</div>`);
    } else {
      parts.push(`<h2>${i + 1}.1 Overview</h2>`);
      const table = !!o.tableEvery && i % o.tableEvery === tableSlot(o.tableEvery);
      const n = table ? 4 : o.figureEvery && i % o.figureEvery === figureSlot(o.figureEvery) ? 3 : 7;
      for (let k = 0; k < n; k++) parts.push(paragraph(i, k, 'normal'));
      if (table) {
        const rows = Array.from({ length: 7 }, (_, r) => `<tr><td>Fixture item ${r + 1}</td><td>${r + 2}.${i % 10} mmol/L</td><td>${(r + 1) * 10} mg</td><td>${r % 2 ? 'NOT used' : 'used'}</td></tr>`).join('');
        parts.push(`<table><caption style="caption-side:top;text-align:left;font-size:9pt">Table ${i + 1}. Fixture values with units</caption><tr><th>Item</th><th>Value</th><th>Dose</th><th>Status</th></tr>${rows}</table>`);
      }
      if (o.figureEvery && i % o.figureEvery === figureSlot(o.figureEvery)) {
        parts.push(`<figure><img src="${figureUri}" alt=""><figcaption>Figure ${i + 1}. Fixture flowchart (boxes and arrows only)</figcaption></figure>`);
        parts.push(paragraph(i, 9, 'normal'));
      }
    }
    parts.push(`<div class="ftr">${i + 1}</div>`);
    pages.push(`<section class="page">${parts.join('')}</section>`);
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(FIXTURE_NOTICE)}</title><style>${BASE_CSS}</style></head><body>${pages.join('')}</body></html>`;
}

/** A long digital lecture PDF (real text layer, printed page numbers, headers, tables, figures, two-column pages). */
export async function lecturePdf(o: LectureOptions): Promise<{ path: string; data: Buffer; pages: number }> {
  const r = await cached('lecture', o, 'pdf', async () => htmlToPdf(lectureHtml(o, o.figureEvery ? await figureDataUri() : '')));
  return { ...r, pages: o.pages };
}

/** Image-only PDF pages (each page is a rendered text screenshot) → the OCR path. */
export async function scannedPdf(pages: number): Promise<{ path: string; data: Buffer; pages: number }> {
  const r = await cached('scanned', { pages }, 'pdf', () =>
    withBrowser(async (b) => {
      const shots: string[] = [];
      const page = await b.newPage({ viewport: { width: 1240, height: 1754 } });
      for (let i = 0; i < pages; i++) {
        await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS} .page{height:1754px;width:1240px;padding:120px 110px;font-size:20pt} p{font-size:19pt}</style></head><body>${lectureHtml({ pages: 1 }).replace(/^[\s\S]*<body>|<\/body>[\s\S]*$/g, '').replaceAll('Section 1', `Scanned section ${i + 1}`)}</body></html>`);
        shots.push((await page.screenshot({ type: 'png', fullPage: false })).toString('base64'));
      }
      const html = `<!doctype html><html><head><meta charset="utf-8"><style>@page{size:A4;margin:0} body{margin:0} .s{height:296.5mm;break-after:page;overflow:hidden} .s img{width:210mm;height:297mm;display:block}</style></head><body>${shots.map((s) => `<div class="s"><img src="data:image/png;base64,${s}" alt=""></div>`).join('')}</body></html>`;
      await page.setContent(html, { waitUntil: 'load' });
      return Buffer.from(await page.pdf({ preferCSSPageSize: true, printBackground: true }));
    }),
  );
  return { ...r, pages };
}

/**
 * A question bank of `count` MCQs in sections of `perSection` (numbering restarts per section, like real banks),
 * options A–D (every 10th question in Arabic with أ–د), every 7th stem with NOT/EXCEPT, and an answer key per section.
 */
export async function questionBankPdf(count: number, perSection = 100): Promise<{ path: string; data: Buffer; count: number; sections: number }> {
  const sections = Math.ceil(count / perSection);
  const r = await cached('qbank', { count, perSection }, 'pdf', () => {
    const body: string[] = [`<div class="intro"><h1>Fixture Question Bank — ${count} items</h1><p>${esc(FIXTURE_NOTICE)}</p></div>`];
    const keys: string[] = [];
    let q = 0;
    for (let s = 0; s < sections; s++) {
      body.push(`<h2>Section ${s + 1} — Fixture block ${s + 1}</h2>`);
      const key: string[] = [];
      for (let n = 1; n <= perSection && q < count; n++, q++) {
        const arabic = q % 10 === 9;
        const letters = arabic ? ['أ', 'ب', 'ج', 'د'] : ['A', 'B', 'C', 'D'];
        const correct = (q * 7 + s) % 4;
        key.push(`${n}. ${['A', 'B', 'C', 'D'][correct]}`);
        if (arabic) {
          body.push(`<div class="q" dir="rtl" lang="ar"><p>${n}. ما هي القيمة التجريبية رقم ${q + 1} في هذا السؤال الاختباري (ليست مرجعًا طبيًا)؟</p>${letters.map((l, k) => `<p>${l}. خيار تجريبي ${k + 1} للسؤال ${q + 1}</p>`).join('')}</div>`);
        } else {
          const neg = q % 7 === 3 ? ' NOT' : q % 7 === 5 ? ' (EXCEPT one)' : '';
          body.push(
            `<div class="q"><p>${n}. Fixture question ${q + 1}: which listed value is${neg} the marked one for item ${s + 1}.${n} measured at ${(q % 9) + 1}.${q % 10} mmol/L?</p>${letters
              .map((l, k) => `<p>${l}. Option ${l} for fixture question ${q + 1} (${(k + 1) * ((q % 5) + 1)} mg)</p>`)
              .join('')}</div>`,
          );
        }
      }
      keys.push(`<p>Section ${s + 1}: ${key.join(' ')}</p>`);
    }
    body.push(`<h2 style="break-before:page">Answer Key</h2>${keys.join('')}`);
    const css = `@page{size:A4;margin:18mm 18mm 20mm} body{margin:0;font-family:'DejaVu Sans',sans-serif;font-size:9.5pt;color:#111} h1{font-size:15pt} h2{font-size:12pt;margin:5mm 0 2mm} p{margin:0 0 0.8mm;line-height:1.3} .q{margin-bottom:2.2mm;break-inside:avoid}`;
    return htmlToPdf(`<!doctype html><html lang="en"><head><meta charset="utf-8"><style>${css}</style></head><body>${body.join('')}</body></html>`);
  });
  return { ...r, count, sections };
}
