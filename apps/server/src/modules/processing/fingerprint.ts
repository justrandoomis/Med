// Page fingerprints (Academic OS P1-T3, ARCHITECTURE_DELTA §4.2 `0161_page_map`, §6.2 step 1).
//
// Per page of a version: the sha256 of the page's normalised LOGICAL text, a 64 × u32 MinHash over word 3-shingles,
// the hash of the text-region geometry, and — only for pages with little or no text — a 64-bit dHash of the page
// image. Printed page numbers, running headers and footers are left out, so a page that merely moved (pages inserted
// before it) keeps its fingerprint. Computed by the versions module's analysis job after processing (never on a
// request), idempotent, and replaced when the scheme (`FINGERPRINT_ALGO`) changes.
//
// `enqueueVersionAnalysisFollowUp` is the ONE seam the processing pipeline calls (pipeline.ts, next to the question and
// knowledge follow-ups): guarded by the job kind being registered, it never fails processing.
import { createHash } from 'node:crypto';
import { normalizeForSearch, type PageFingerprintInput } from '@medlevo/shared';
import type { AppContext } from '../../context';
import { decodeImage } from './image';
import type { RgbaImage } from './png';
import { renderPdfPage } from './tools';

/**
 * fingerprint scheme: normalisation 1, word 3-shingles, 64 MinHash values, 64-bit dHash, layout grid 1/50 over the
 * text AND figure regions (`lay50f`, review fix: a figure that moved or changed size makes coordinates unsafe)
 */
export const FINGERPRINT_ALGO = 'fp2:norm1:sh3:mh64:dh64:lay50f';
export const MINHASH_SIZE = 64;
/** below this many normalised characters a page counts as «without text» and its image decides */
export const MIN_TEXT_CHARS = 40;
/** the analysis job kind of the versions module (registered there; the processing pipeline only enqueues it) */
export const VERSION_ANALYSIS_JOB = 'analyze_version';
/** the DOCX display-PDF job kind of the versions module */
export const DOCX_DISPLAY_JOB = 'docx_display_pdf';
/** never decode more than this for a dHash (a 48 MP photo is decoded by processing, not twice) */
const DHASH_MAX_PIXELS = 12_000_000;

const EXCLUDED_KINDS = new Set(['header', 'footer', 'table_cell']);
// the regions whose geometry decides «same layout»: the text AND the figures/diagrams a note is often drawn on
const LAYOUT_KINDS = new Set(['heading', 'paragraph', 'list_item', 'text_block', 'caption', 'table', 'question', 'option', 'answer_key', 'note', 'figure', 'diagram']);
// «Page 12», «p. 12», «12 / 40», «- 12 -», «ص 12», «صفحة ١٢ من ٤٠», «Slide 3» — a printed page number, not content
const PAGE_NUMBER_LINE = /^[\s\-–—]*(?:page|pg\.?|p\.?|slide|ص|صفحه|صفحة|شريحه|شريحة)?\s*\d{1,4}\s*(?:(?:of|من|\/)\s*\d{1,4})?[\s\-–—]*$/iu;

/** The page text that identifies it: regions in reading order, no header/footer/page numbers, search-normalised. */
export function normalizePageText(texts: readonly string[]): string {
  const lines: string[] = [];
  for (const t of texts) {
    for (const line of t.split(/\n+/)) {
      const s = line.trim();
      if (!s || PAGE_NUMBER_LINE.test(normalizeForSearch(s))) continue;
      lines.push(s);
    }
  }
  return normalizeForSearch(lines.join(' '))
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** murmur3 finaliser: a cheap, well-mixed 32-bit permutation */
function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** 64 fixed seeds (derived once, deterministic on every machine) */
const SEEDS: Uint32Array = (() => {
  const out = new Uint32Array(MINHASH_SIZE);
  let x = 0x9e3779b9;
  for (let i = 0; i < MINHASH_SIZE; i++) {
    x = fmix32(x + 0x6d2b79f5 + i);
    out[i] = x;
  }
  return out;
})();

/** MinHash over word 3-shingles of normalised text (null when fewer than 3 words). */
export function minhashOf(normalized: string): Uint32Array | null {
  const words = normalized.split(' ').filter(Boolean);
  if (words.length < 3) return null;
  const sig = new Uint32Array(MINHASH_SIZE).fill(0xffffffff);
  for (let i = 0; i + 2 < words.length; i++) {
    const base = fnv1a32(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
    for (let k = 0; k < MINHASH_SIZE; k++) {
      const v = fmix32(base ^ SEEDS[k]!);
      if (v < sig[k]!) sig[k] = v;
    }
  }
  return sig;
}

/** Estimated Jaccard similarity of two MinHash signatures (share of equal positions). */
export function minhashSimilarity(a: Uint32Array, b: Uint32Array): number {
  let eq = 0;
  for (let i = 0; i < MINHASH_SIZE; i++) if (a[i] === b[i]) eq++;
  return eq / MINHASH_SIZE;
}

export function minhashToBlob(sig: Uint32Array): Uint8Array {
  const buf = Buffer.alloc(MINHASH_SIZE * 4);
  for (let i = 0; i < MINHASH_SIZE; i++) buf.writeUInt32LE(sig[i]!, i * 4);
  return buf;
}

export function minhashFromBlob(blob: Uint8Array | null | undefined): Uint32Array | null {
  if (!blob || blob.byteLength !== MINHASH_SIZE * 4) return null;
  const view = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
  const out = new Uint32Array(MINHASH_SIZE);
  for (let i = 0; i < MINHASH_SIZE; i++) out[i] = view.readUInt32LE(i * 4);
  return out;
}

/** 64-bit difference hash: the image reduced to 9 × 8 grey cells, one bit per horizontal neighbour pair. */
export function dhashOf(img: RgbaImage): string {
  const W = 9;
  const H = 8;
  const cells = new Float64Array(W * H);
  const counts = new Float64Array(W * H);
  for (let y = 0; y < img.height; y++) {
    const cy = Math.min(H - 1, Math.floor((y * H) / img.height));
    for (let x = 0; x < img.width; x++) {
      const cx = Math.min(W - 1, Math.floor((x * W) / img.width));
      const o = (y * img.width + x) * 4;
      const a = img.data[o + 3]! / 255;
      // transparent pixels count as white (a page background)
      const grey = (0.299 * img.data[o]! + 0.587 * img.data[o + 1]! + 0.114 * img.data[o + 2]!) * a + 255 * (1 - a);
      cells[cy * W + cx]! += grey;
      counts[cy * W + cx]! += 1;
    }
  }
  for (let i = 0; i < cells.length; i++) cells[i] = counts[i] ? cells[i]! / counts[i]! : 255;
  let hex = '';
  for (let y = 0; y < H; y++) {
    let byte = 0;
    for (let x = 0; x < 8; x++) byte = (byte << 1) | (cells[y * W + x]! > cells[y * W + x + 1]! ? 1 : 0);
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

export function hammingHex(a: string, b: string): number {
  let d = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 2) {
    let x = parseInt(a.slice(i, i + 2), 16) ^ parseInt(b.slice(i, i + 2), 16);
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d;
}

/** Geometry of the text regions on a 1/50 grid: equal → the same layout (coordinates of notes reusable). */
export function layoutHashOf(boxes: ReadonlyArray<{ x: number; y: number; w: number; h: number }>): string | null {
  if (boxes.length === 0) return null;
  const q = (v: number) => Math.round(v * 50);
  const sig = boxes.map((b) => `${q(b.x)},${q(b.y)},${q(b.w)},${q(b.h)}`).join(';');
  return createHash('sha256').update(sig).digest('hex').slice(0, 32);
}

export function textHashOf(normalized: string): string | null {
  return normalized ? createHash('sha256').update(normalized).digest('hex') : null;
}

interface PageRow {
  id: string;
  page_index: number;
  kind: string;
  render_file_id: string | null;
}

interface RegionRow {
  page_id: string;
  kind: string;
  text: string | null;
  bbox_json: string | null;
}

export interface FingerprintOptions {
  pdftoppm: string | null;
  signal?: AbortSignal;
}

export interface FingerprintResult {
  pages: number;
  /** pages whose image was rendered for a dHash */
  rendered: number;
  skipped_current: number;
}

/** The file the pages of this version can be rendered from (a PDF), if any. */
function renderablePdf(ctx: AppContext, versionId: string): string | null {
  const v = ctx.db.get<{ format: string; file_id: string | null; display_file_id: string | null }>('SELECT format, file_id, display_file_id FROM source_version WHERE id = ?', [versionId]);
  if (!v) return null;
  const id = v.display_file_id ?? (v.format === 'pdf' ? v.file_id : null);
  return id && ctx.files.stat(id) ? id : null;
}

/**
 * Fingerprint every page of a version (idempotent). Pages already fingerprinted with the current scheme and not
 * updated since are kept unless `force`.
 */
export async function fingerprintVersion(ctx: AppContext, versionId: string, opts: FingerprintOptions & { force?: boolean }): Promise<FingerprintResult> {
  const pages = ctx.db.all<PageRow & { updated_at: number; fp_algo: string | null; fp_at: number | null }>(
    `SELECT p.id, p.page_index, p.kind, p.render_file_id, p.updated_at, f.algo AS fp_algo, f.created_at AS fp_at
       FROM source_page p LEFT JOIN page_fingerprint f ON f.page_id = p.id
      WHERE p.version_id = ? ORDER BY p.page_index`,
    [versionId],
  );
  const todo = opts.force ? pages : pages.filter((p) => p.fp_algo !== FINGERPRINT_ALGO || p.fp_at === null || p.fp_at < p.updated_at);
  if (todo.length === 0) return { pages: pages.length, rendered: 0, skipped_current: pages.length };
  const regions = ctx.db.all<RegionRow>(
    `SELECT r.page_id, r.kind, r.text, r.bbox_json FROM source_region r
      WHERE r.version_id = ? AND r.status <> 'rejected' AND r.page_id IS NOT NULL
      ORDER BY r.page_id, r.reading_order`,
    [versionId],
  );
  const byPage = new Map<string, RegionRow[]>();
  for (const r of regions) {
    const list = byPage.get(r.page_id) ?? [];
    list.push(r);
    byPage.set(r.page_id, list);
  }
  const pdfId = renderablePdf(ctx, versionId);
  let rendered = 0;
  const rows: Array<{ page: PageRow; hash: string | null; mh: Uint32Array | null; dh: string | null; lay: string | null; len: number }> = [];
  for (const page of todo) {
    if (opts.signal?.aborted) throw opts.signal.reason ?? new Error('aborted');
    const regs = (byPage.get(page.id) ?? []).filter((r) => !EXCLUDED_KINDS.has(r.kind));
    const norm = normalizePageText(regs.map((r) => r.text ?? '').filter(Boolean));
    const boxes = regs
      .filter((r) => LAYOUT_KINDS.has(r.kind) && r.bbox_json)
      .map((r) => {
        try {
          return JSON.parse(r.bbox_json!) as { x: number; y: number; w: number; h: number };
        } catch {
          return null;
        }
      })
      .filter((b): b is { x: number; y: number; w: number; h: number } => !!b && [b.x, b.y, b.w, b.h].every((v) => typeof v === 'number' && Number.isFinite(v)));
    let dh: string | null = null;
    if (norm.length < MIN_TEXT_CHARS) {
      dh = await pageDhash(ctx, page, pdfId, opts).catch((e: unknown) => {
        if (opts.signal?.aborted) throw e;
        ctx.log.warn({ err: e instanceof Error ? e.message : String(e), pageId: page.id }, 'page dHash failed');
        return null;
      });
      if (dh) rendered++;
    }
    rows.push({ page, hash: norm.length ? textHashOf(norm) : null, mh: minhashOf(norm), dh, lay: layoutHashOf(boxes), len: norm.length });
  }
  const now = ctx.clock.now();
  ctx.db.tx(() => {
    for (const r of rows) {
      // the page may have been deleted (re-processing) while we rendered
      if (!ctx.db.get('SELECT 1 AS x FROM source_page WHERE id = ?', [r.page.id])) continue;
      ctx.db.run(
        `INSERT INTO page_fingerprint (page_id, version_id, text_norm_hash, text_minhash, image_dhash, layout_hash, text_len, algo, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(page_id) DO UPDATE SET version_id = excluded.version_id, text_norm_hash = excluded.text_norm_hash, text_minhash = excluded.text_minhash,
           image_dhash = excluded.image_dhash, layout_hash = excluded.layout_hash, text_len = excluded.text_len, algo = excluded.algo, created_at = excluded.created_at`,
        [r.page.id, versionId, r.hash, r.mh ? minhashToBlob(r.mh) : null, r.dh, r.lay, r.len, FINGERPRINT_ALGO, now],
      );
    }
  });
  return { pages: pages.length, rendered, skipped_current: pages.length - todo.length };
}

async function pageDhash(ctx: AppContext, page: PageRow, pdfId: string | null, opts: FingerprintOptions): Promise<string | null> {
  if (page.render_file_id && ctx.files.stat(page.render_file_id)) {
    const img = decodeImage(await ctx.files.read(page.render_file_id), DHASH_MAX_PIXELS);
    return dhashOf(img);
  }
  if (pdfId && opts.pdftoppm && (page.kind === 'page' || page.kind === 'slide')) {
    const png = await renderPdfPage({ pdftoppm: opts.pdftoppm, pdfPath: ctx.files.path(pdfId), pageNumber: page.page_index + 1, dpi: 24, tmpRoot: ctx.config.tmpDir, timeoutMs: 60_000, signal: opts.signal });
    return dhashOf(decodeImage(png, DHASH_MAX_PIXELS));
  }
  return null;
}

/** Stored fingerprints of a version, in page order (what the pure page matcher consumes). */
export function readFingerprints(ctx: AppContext, versionId: string): PageFingerprintInput[] {
  return ctx.db
    .all<{ page_id: string; page_index: number; text_norm_hash: string | null; text_minhash: Uint8Array | null; image_dhash: string | null; layout_hash: string | null; text_len: number }>(
      `SELECT p.id AS page_id, p.page_index, f.text_norm_hash, f.text_minhash, f.image_dhash, f.layout_hash, COALESCE(f.text_len, 0) AS text_len
         FROM source_page p LEFT JOIN page_fingerprint f ON f.page_id = p.id AND f.algo = ?
        WHERE p.version_id = ? ORDER BY p.page_index`,
      [FINGERPRINT_ALGO, versionId],
    )
    .map((r) => ({ page_id: r.page_id, page_index: r.page_index, text_norm_hash: r.text_norm_hash, minhash: minhashFromBlob(r.text_minhash), dhash: r.image_dhash, layout_hash: r.layout_hash, text_len: r.text_len }));
}

/** true when every page of the version carries a fingerprint of the current scheme */
export function fingerprintsComplete(ctx: AppContext, versionId: string): boolean {
  const r = ctx.db.get<{ pages: number; fps: number }>(
    `SELECT COUNT(*) AS pages, COUNT(f.page_id) AS fps FROM source_page p
       LEFT JOIN page_fingerprint f ON f.page_id = p.id AND f.algo = ? AND f.created_at >= p.updated_at
      WHERE p.version_id = ?`,
    [FINGERPRINT_ALGO, versionId],
  );
  return !!r && r.pages > 0 && r.pages === r.fps;
}

/**
 * Seam for the processing pipeline (called once a version is processed): queue the versions module's analysis
 * (fingerprints, lecture identity, page maps, new-version detection) and, for DOCX, its display PDF. Guarded like the
 * other follow-ups: nothing happens without the versions module, and a failure here never fails processing.
 */
export function enqueueVersionAnalysisFollowUp(ctx: AppContext, versionId: string, processJobId: string): void {
  try {
    if (ctx.jobs.isRegistered(VERSION_ANALYSIS_JOB)) {
      ctx.jobs.enqueue(VERSION_ANALYSIS_JOB, { version_id: versionId }, { idempotencyKey: `${VERSION_ANALYSIS_JOB}:${versionId}:${processJobId}`, parentJobId: processJobId });
    }
    const fmt = ctx.db.get<{ format: string }>('SELECT format FROM source_version WHERE id = ?', [versionId])?.format;
    if (fmt === 'docx' && ctx.jobs.isRegistered(DOCX_DISPLAY_JOB) && !ctx.db.get(`SELECT 1 AS x FROM version_rendition WHERE version_id = ? AND role = 'docx_display_pdf' AND status = 'ready'`, [versionId])) {
      ctx.jobs.enqueue(DOCX_DISPLAY_JOB, { version_id: versionId }, { idempotencyKey: `${DOCX_DISPLAY_JOB}:${versionId}`, parentJobId: processJobId });
    }
  } catch (e) {
    ctx.log.warn({ err: e, versionId }, 'could not enqueue the version analysis follow-up job');
  }
}
