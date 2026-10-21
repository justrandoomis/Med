// Server PDF exporter (§46 «فرّق بين PDF مسطح يحفظ المظهر وحبر قابل لإعادة التحرير») — Round 7 H4 item 8.
//
//  (a) The ORIGINAL PDF with the owner's writing drawn on it as VECTOR paths (pdf-lib): pen / highlighter strokes,
//      shapes (line, arrow, rectangle, ellipse — with their rotation), text highlights / underlines and pictures the
//      owner placed. A copy is written; the stored original is never changed. Coordinates go through the ONE page
//      geometry (ARCHITECTURE §3.8): a normalized point (x, y ∈ [0,1], unrotated page box, top-left origin) becomes the
//      user-space point (box.x + x·W, box.top − y·H) of the page's crop box — the box pdf.js shows and the reader
//      measures — so the page's own /Rotate turns the writing with the page exactly as in the reader. The original
//      page content is wrapped in q … Q first (pdf-lib normalize), so whatever graphics state it leaves cannot move
//      the writing.
//      This is a FLATTENED picture of the writing: not re-editable ink (that stays in the app, the JSON export and the
//      backup). What cannot be drawn faithfully is listed, never silently dropped: text boxes and sticky notes (their
//      Arabic text would need shaping this exporter does not do — they are in the notes export), writing that needs
//      re-anchoring (its place is not certain), writing on a page the file does not have.
//  (b) Study Book / notes / questions as PDF = the DOCX export (RTL paragraphs, isolated LTR runs, citations as text)
//      converted by LibreOffice in its no-network sandbox (processing/tools.ts convertToPdf).
import {
  BlendMode,
  LineCapStyle,
  LineJoinStyle,
  PDFDocument,
  rgb,
  setLineJoin,
  type PDFPage,
  type RGB,
} from 'pdf-lib';
import type { AnnotatedPdfSummary, ImageAnnotationData, InkData, NormBox, ShapeData, TextHighlightData } from '@medlevo/shared';
import { shapeOutlineIso } from '@medlevo/shared';
import type { AppContext } from '../../context';
import { fromJson } from '../../db/db';
import { AppError } from '../../lib/errors';
import { convertToPdf, detectTools } from '../processing/tools';
import type { ExportFile } from './export';
import { resolveOfflineTarget } from './offline';

// ───────── colours: the reader's ink tokens, light-paper values (web features/workspace/ink/palette.ts) ─────────
export const INK_TOKEN_LIGHT: Record<string, string> = {
  'ink-black': '#1c2230',
  'ink-blue': '#2346c8',
  'ink-red': '#c62828',
  'ink-green': '#1e7a46',
  'ink-purple': '#6a3fb5',
  'ink-orange': '#b85300',
  'hl-yellow': '#ffe14d',
  'hl-green': '#9be38d',
  'hl-pink': '#ff9ccf',
  'hl-blue': '#8fd3ff',
  'hl-orange': '#ffc074',
  // text highlights / underlines made from a selection (web workspace.css --wk-marker / --wk-paper-accent)
  'marker-yellow': '#ffcd40',
  'ink-accent': '#3a47a8',
};
/** the reader draws highlighter strokes at this alpha with a multiply blend (web ink/render.ts HIGHLIGHT_ALPHA) */
export const HIGHLIGHT_ALPHA = 0.85;
/** text highlights (selection → «ظلّل») are translucent fills (the reader: rgba(255, 205, 64, 0.42), multiply) */
const TEXT_HIGHLIGHT_ALPHA = 0.42;

export function colorOf(token: string | null | undefined, fallback = '#1c2230'): RGB {
  const hex = token && /^#[0-9a-fA-F]{6}$/.test(token) ? token : (INK_TOKEN_LIGHT[token ?? ''] ?? fallback);
  const n = parseInt(hex.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

// ───────── shapes: the reader's outline geometry (web ink/model.ts shapeOutline), in «iso» units ─────────
// iso x = normalized x, iso y = normalized y × (H / W); page units = iso × W on both axes.
type Vec = [number, number];
export function arrowHeadLength(shaftLength: number, width: number): number {
  return Math.min(shaftLength * 0.35, Math.max(width * 5, 0.018));
}
export function shapeOutline(d: ShapeData, ar: number): Vec[][] {
  // (parity N1 wave 2) new shape kinds, pathway heads, routes, rounded corners: the shared geometry the reader draws
  if (!['line', 'arrow', 'rect', 'ellipse'].includes(d.shape) || d.head || d.route || d.corner || d.points) return shapeOutlineIso(d, ar);
  const f: Vec = [d.from[0], d.from[1] * ar];
  const t: Vec = [d.to[0], d.to[1] * ar];
  if (d.shape === 'line') return [[f, t]];
  if (d.shape === 'arrow') {
    const len = Math.hypot(t[0] - f[0], t[1] - f[1]);
    const head = arrowHeadLength(len, d.style.width);
    const ang = Math.atan2(t[1] - f[1], t[0] - f[0]);
    const spread = (28 * Math.PI) / 180;
    const h1: Vec = [t[0] - head * Math.cos(ang - spread), t[1] - head * Math.sin(ang - spread)];
    const h2: Vec = [t[0] - head * Math.cos(ang + spread), t[1] - head * Math.sin(ang + spread)];
    return [
      [f, t],
      [h1, t, h2],
    ];
  }
  const cx = (f[0] + t[0]) / 2;
  const cy = (f[1] + t[1]) / 2;
  const hx = Math.abs(t[0] - f[0]) / 2;
  const hy = Math.abs(t[1] - f[1]) / 2;
  const rot = d.rotation ?? 0;
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const place = (u: number, v: number): Vec => [cx + u * c - v * s, cy + u * s + v * c];
  if (d.shape === 'rect') return [[place(-hx, -hy), place(hx, -hy), place(hx, hy), place(-hx, hy), place(-hx, -hy)]];
  const pts: Vec[] = [];
  for (let i = 0; i <= 64; i++) {
    const a = (i / 64) * Math.PI * 2;
    pts.push(place(hx * Math.cos(a), hy * Math.sin(a)));
  }
  return [pts];
}

// ───────── the page box mapping (normalized → PDF user space) ─────────
export interface PageBox {
  x: number;
  y: number;
  width: number;
  height: number;
}
/** normalized point (unrotated page box, top-left origin) → PDF user space of the crop box. */
export function normToUserSpace(nx: number, ny: number, box: PageBox): [number, number] {
  return [box.x + nx * box.width, box.y + box.height - ny * box.height];
}

const fmt = (n: number) => (Math.round(n * 1000) / 1000).toString();
/** SVG path in «top-left origin, y down» page units (pdf-lib's drawSvgPath flips y around the given origin). */
function svgPolyline(points: Array<[number, number]>): string {
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${fmt(p[0])} ${fmt(p[1])}`).join(' ');
}

// ───────── what is drawn ─────────
interface Row {
  id: string;
  kind: string;
  data_json: string;
  anchor_status: string;
  page_index: number;
  z: number;
}

type Item =
  | { type: 'stroke'; page: number; data: InkData; highlighter: boolean }
  | { type: 'shape'; page: number; data: ShapeData }
  | { type: 'text_highlight'; page: number; data: TextHighlightData }
  | { type: 'image'; page: number; data: ImageAnnotationData };

const SKIP_REASON_AR: Record<string, string> = {
  needs_reanchor: 'كتابة تحتاج إعادة ربط بموضعها بعد تغيّر الصفحة — مكانها غير مؤكد، فلم تُرسم.',
  text: 'مربعات النص لا تُرسم في PDF المسطح (نصها العربي يحتاج تشكيلًا لا يقوم به هذا المُصدِّر) — هي في تصدير الملاحظات.',
  sticky: 'الملاحظات اللاصقة لا تُرسم في PDF المسطح — نصها في تصدير الملاحظات.',
  bookmark: 'العلامات المرجعية ليست رسمًا على الصفحة.',
  link: 'روابط الصفحات تعمل داخل التطبيق فقط؛ لا تُرسم.',
  missing_page: 'كتابة على صفحة غير موجودة في ملف PDF هذا.',
  missing_image: 'صورة وضعتها لم يصل ملفها إلى الخادم بعد، أو بصيغة لا تُضمَّن (PNG وJPEG فقط).',
  unknown: 'نوع كتابة لا يعرف هذا المُصدِّر رسمه.',
};

function classify(rows: Row[], pageCount: number | null): { items: Item[]; skipped: Map<string, number> } {
  const items: Item[] = [];
  const skipped = new Map<string, number>();
  const skip = (k: string) => skipped.set(k, (skipped.get(k) ?? 0) + 1);
  for (const r of rows) {
    if (r.anchor_status === 'needs_reanchor') {
      skip('needs_reanchor');
      continue;
    }
    if (pageCount !== null && (r.page_index < 0 || r.page_index >= pageCount)) {
      skip('missing_page');
      continue;
    }
    const d = fromJson<Record<string, unknown>>(r.data_json, {}) ?? {};
    if (Array.isArray(d.points) && d.style) {
      const data = d as unknown as InkData;
      items.push({ type: 'stroke', page: r.page_index, data, highlighter: data.style.tool === 'highlighter' || r.kind === 'highlight' });
    } else if (typeof d.shape === 'string' && Array.isArray(d.from) && Array.isArray(d.to) && d.style) {
      items.push({ type: 'shape', page: r.page_index, data: d as unknown as ShapeData });
    } else if (Array.isArray(d.rects)) {
      items.push({ type: 'text_highlight', page: r.page_index, data: d as unknown as TextHighlightData });
    } else if (typeof d.image_key === 'string' && d.box) {
      items.push({ type: 'image', page: r.page_index, data: d as unknown as ImageAnnotationData });
    } else {
      skip(['text', 'sticky', 'bookmark', 'link'].includes(r.kind) ? r.kind : 'unknown');
    }
  }
  return { items, skipped };
}

interface Target {
  sourceId: string;
  versionId: string;
  title: string;
  pdfFileId: string | null;
  pageCount: number | null;
  rows: Row[];
}

function target(ctx: AppContext, sourceId: string, versionId: string | null): Target {
  const { source, version } = resolveOfflineTarget(ctx, sourceId, versionId);
  const pdfFileId = version.display_file_id ?? (version.format === 'pdf' ? version.file_id : null);
  const rows = ctx.db.all<Row>(
    `SELECT a.id, a.kind, a.data_json, a.anchor_status, a.z, p.page_index
       FROM annotation a JOIN annotation_target t ON t.annotation_id = a.id AND t.target_type = 'source_page'
       JOIN source_page p ON p.id = t.target_id
      WHERE p.version_id = ? AND a.deleted_at IS NULL
      ORDER BY p.page_index, a.z, a.created_at, a.id`,
    [version.id],
  );
  return { sourceId: source.id, versionId: version.id, title: source.title, pdfFileId, pageCount: version.page_count, rows };
}

function summaryOf(t: Target, items: Item[], skipped: Map<string, number>): AnnotatedPdfSummary {
  const count = (pred: (i: Item) => boolean) => items.filter(pred).length;
  return {
    source_id: t.sourceId,
    version_id: t.versionId,
    title: t.title,
    available: !!t.pdfFileId,
    reason_ar: t.pdfFileId ? null : 'لهذا المصدر لا يوجد ملف PDF أصلي يُرسم عليه (صورة أو Word بلا نسخة PDF للعرض) — صدّر الملاحظات أو نص المصدر بدلًا منه.',
    pages: t.pageCount,
    drawn: {
      strokes: count((i) => i.type === 'stroke' && !i.highlighter),
      highlighter_strokes: count((i) => i.type === 'stroke' && i.highlighter),
      shapes: count((i) => i.type === 'shape'),
      text_highlights: count((i) => i.type === 'text_highlight'),
      images: count((i) => i.type === 'image'),
      pages_with_writing: new Set(items.map((i) => i.page)).size,
    },
    skipped: [...skipped.entries()].map(([kind, n]) => ({ kind, count: n, reason_ar: SKIP_REASON_AR[kind] ?? SKIP_REASON_AR.unknown! })),
    notes_ar: [
      'نسخة PDF مسطحة تحفظ المظهر: الملف الأصلي كما هو وفوقه كتابتك مرسومة خطوطًا متجهة. لا يُعدَّل الملف المحفوظ لديك.',
      'هذه صورة للكتابة وليست حبرًا قابلًا لإعادة التحرير: الحبر نفسه يبقى في التطبيق وفي تصدير JSON والنسخة الاحتياطية.',
      'سماكة الضربة ثابتة في هذا الملف (لا تتغيّر بالضغط كما في القارئ).',
    ],
  };
}

/** What the annotated PDF of a source would contain (no file built). */
export function annotatedPdfSummary(ctx: AppContext, sourceId: string, versionId: string | null): AnnotatedPdfSummary {
  const t = target(ctx, sourceId, versionId);
  const { items, skipped } = classify(t.rows, t.pageCount);
  return summaryOf(t, items, skipped);
}

function drawItem(doc: PDFDocument, page: PDFPage, box: PageBox, item: Item, images: Map<string, Awaited<ReturnType<PDFDocument['embedPng']>>>): boolean {
  const W = box.width;
  const H = box.height;
  // pdf-lib's drawSvgPath: svg (X, Y) → user space (x + X, y − Y); the origin is the crop box's top-left corner
  const at = { x: box.x, y: box.y + box.height };
  switch (item.type) {
    case 'stroke': {
      const d = item.data;
      const pts = d.points.map((p) => [p[0] * W, p[1] * H] as [number, number]);
      if (pts.length === 1) pts.push([pts[0]![0] + 0.01, pts[0]![1]]); // a dot
      page.drawSvgPath(svgPolyline(pts), {
        ...at,
        borderColor: colorOf(d.style.color, item.highlighter ? '#ffe14d' : '#1c2230'),
        borderWidth: Math.max(0.25, d.style.width * W),
        borderOpacity: item.highlighter ? HIGHLIGHT_ALPHA : (d.style.opacity ?? 1),
        borderLineCap: LineCapStyle.Round,
        ...(item.highlighter ? { blendMode: BlendMode.Multiply } : {}),
      });
      return true;
    }
    case 'shape': {
      const d = item.data;
      for (const line of shapeOutline(d, H / W)) {
        page.drawSvgPath(svgPolyline(line.map((p) => [p[0] * W, p[1] * W] as [number, number])), {
          ...at,
          borderColor: colorOf(d.style.color),
          borderWidth: Math.max(0.25, d.style.width * W),
          borderOpacity: d.style.opacity ?? 1,
          borderLineCap: LineCapStyle.Round,
        });
      }
      return true;
    }
    case 'text_highlight': {
      const d = item.data;
      for (const r of d.rects) {
        if (d.style === 'underline') {
          const y = (r.y + r.h) * H;
          page.drawSvgPath(svgPolyline([[r.x * W, y], [(r.x + r.w) * W, y]]), { ...at, borderColor: colorOf(d.color, '#3a47a8'), borderWidth: Math.max(0.5, 0.0015 * W) });
        } else {
          const [x, y] = normToUserSpace(r.x, r.y + r.h, box);
          page.drawRectangle({ x, y, width: r.w * W, height: r.h * H, color: colorOf(d.color, '#ffcd40'), opacity: TEXT_HIGHLIGHT_ALPHA, blendMode: BlendMode.Multiply });
        }
      }
      return true;
    }
    case 'image': {
      const img = images.get(item.data.image_key);
      if (!img) return false;
      const b: NormBox = item.data.box;
      const [x, y] = normToUserSpace(b.x, b.y + b.h, box);
      page.drawImage(img, { x, y, width: b.w * W, height: b.h * H });
      return true;
    }
  }
  void doc;
  return false;
}

/** The original PDF of a source version with the owner's writing drawn on a copy (vector paths). */
export async function exportAnnotatedPdf(ctx: AppContext, sourceId: string, versionId: string | null): Promise<{ file: ExportFile; summary: AnnotatedPdfSummary }> {
  const t = target(ctx, sourceId, versionId);
  if (!t.pdfFileId) throw new AppError('CONFLICT', summaryOf(t, [], new Map()).reason_ar!, 409);
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(await ctx.files.read(t.pdfFileId), { updateMetadata: false });
  } catch (e) {
    const encrypted = e instanceof Error && /encrypt/i.test(e.message);
    throw new AppError('CONFLICT', encrypted ? 'ملف PDF الأصلي مشفّر؛ لا يمكن رسم كتابتك على نسخة منه هنا.' : 'تعذّرت قراءة ملف PDF الأصلي لرسم كتابتك عليه.', 409);
  }
  const pageCount = doc.getPageCount();
  const { items, skipped } = classify(t.rows, pageCount);
  // pictures the owner placed: embedded once each (PNG / JPEG); a missing upload is reported, not guessed
  const images = new Map<string, Awaited<ReturnType<PDFDocument['embedPng']>>>();
  for (const it of items) {
    if (it.type !== 'image' || images.has(it.data.image_key)) continue;
    const row = ctx.db.get<{ file_id: string; mime: string }>('SELECT file_id, mime FROM annotation_image WHERE image_key = ?', [it.data.image_key]);
    if (!row) continue;
    try {
      const bytes = await ctx.files.read(row.file_id);
      if (row.mime === 'image/png') images.set(it.data.image_key, await doc.embedPng(bytes));
      else if (row.mime === 'image/jpeg') images.set(it.data.image_key, await doc.embedJpg(bytes));
    } catch {
      // unreadable picture: reported below
    }
  }
  const drawnItems: Item[] = [];
  const wrapped = new Set<number>();
  for (const it of items) {
    const page = doc.getPage(it.page);
    if (!wrapped.has(it.page)) {
      // pdf-lib's normalize() wraps the original content streams in q … Q (autoNormalizeCTM), so whatever graphics
      // state the original leaves behind (a dangling `cm`, colours, clipping) cannot move or tint the writing — the
      // test renders a page whose content ends with an unbalanced scale and checks the ink did not move.
      page.node.normalize();
      page.pushOperators(setLineJoin(LineJoinStyle.Round));
      wrapped.add(it.page);
    }
    const crop = page.getCropBox();
    if (drawItem(doc, page, crop, it, images)) drawnItems.push(it);
    else skipped.set('missing_image', (skipped.get('missing_image') ?? 0) + 1);
  }
  doc.setProducer('MedLevo — PDF مسطح بكتابتك (الأصل لم يتغيّر)');
  doc.setSubject('نسخة من الملف الأصلي مع كتابة المالك مرسومة خطوطًا متجهة — ليست حبرًا قابلًا للتحرير.');
  const bytes = await doc.save({ useObjectStreams: false });
  const summary = summaryOf({ ...t, pageCount }, drawnItems, skipped);
  // eslint-disable-next-line no-control-regex -- a file name never carries control characters
  const name = `${t.title} - مع كتابتي`.normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim().slice(0, 80) || 'medlevo';
  return { file: { fileName: `${name}.pdf`, contentType: 'application/pdf', body: Buffer.from(bytes) }, summary };
}

// ───────── (b) DOCX export → PDF with LibreOffice ─────────
export function pdfConverterAvailable(): boolean {
  return !!detectTools().soffice;
}

/** Convert a DOCX export to PDF on the server (LibreOffice, no network, isolated profile). */
export async function docxToPdf(ctx: AppContext, docx: ExportFile): Promise<ExportFile> {
  const soffice = detectTools().soffice;
  if (!soffice) throw new AppError('FEATURE_DISABLED', 'تحويل التصدير إلى PDF يحتاج LibreOffice على الخادم، وهو غير مثبّت هنا. صدّر Word (DOCX) أو اطبع نسخة HTML إلى PDF من المتصفح.', 409);
  if (!Buffer.isBuffer(docx.body)) throw new AppError('INTERNAL', 'تعذّر تجهيز ملف Word للتحويل.', 500);
  let pdf: Buffer;
  try {
    pdf = await convertToPdf({ soffice, input: docx.body, inputExt: 'docx', tmpRoot: ctx.config.tmpDir, timeoutMs: 120_000 });
  } catch {
    throw new AppError('INTERNAL', 'تعذّر تحويل التصدير إلى PDF على الخادم. صدّر Word (DOCX) بدلًا منه أو أعد المحاولة.', 500);
  }
  return { fileName: docx.fileName.replace(/\.docx$/i, '.pdf'), contentType: 'application/pdf', body: pdf };
}
