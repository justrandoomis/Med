// DOCX (mammoth document model) and PPTX (jszip + OOXML) extraction.
//  * DOCX has no stable pages (§07): pages are 'docx_section' groups by top-level heading, printed_label
//    null, and every region carries a locator { paragraph_index, heading_path } — never a page number.
//  * PPTX: slide order from presentation.xml sldIdLst → relationships; slide size from sldSz; shape
//    boxes from a:off/a:ext (group transforms applied); title placeholders → headings; notes → 'note'.
import { posix } from 'node:path';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import { countStrong } from './text';
import { orderElements } from './layout/page';
import type { Box, LayoutRegion, TableCellOut, TableOut } from './layout/types';
import { serializeTable } from './layout/tables';
import { attr, childElements, findAll, findFirst, firstChild, localName, parseXml, textContent, type XmlElement } from './xml';

export interface OfficeImage {
  /** region key of the figure this image belongs to */
  regionKey: string;
  data: Buffer;
  mime: string;
  name: string;
}

export interface OfficePage {
  index: number;
  kind: 'docx_section' | 'slide';
  printedLabel: string | null;
  width: number | null;
  height: number | null;
  sectionKey: string | null;
  regions: LayoutRegion[];
  images: OfficeImage[];
}

export interface OfficeDocument {
  pages: OfficePage[];
  warnings: string[];
}

function langOf(text: string): 'ar' | 'en' | 'mixed' | null {
  const { r, l } = countStrong(text);
  if (r === 0 && l === 0) return null;
  if (l === 0) return 'ar';
  if (r === 0) return 'en';
  return 'mixed';
}

function dirOf(text: string): 'rtl' | 'ltr' {
  const { r, l } = countStrong(text);
  return r > 0 && r >= l ? 'rtl' : 'ltr';
}

const IMAGE_MIME = /^image\/(png|jpe?g|gif|webp|bmp|tiff|svg\+xml)$/i;

// ───────────────────────────── DOCX ─────────────────────────────
interface MammothNode {
  type: string;
  children?: MammothNode[];
  value?: string;
  styleId?: string | null;
  styleName?: string | null;
  numbering?: { level?: string | number; isOrdered?: boolean } | null;
  breakType?: string;
  colSpan?: number;
  rowSpan?: number;
  isHeader?: boolean;
  contentType?: string;
  altText?: string;
  read?: () => Promise<Buffer>;
}

function headingLevel(p: MammothNode): number | null {
  const name = `${p.styleName ?? ''}`.trim();
  const id = `${p.styleId ?? ''}`.trim();
  if (/^title$/i.test(name) || /^title$/i.test(id)) return 1;
  const m = /^(?:heading|عنوان)\s*([1-9])$/i.exec(name) ?? /^heading([1-9])$/i.exec(id);
  return m ? Number(m[1]) : null;
}

function runText(node: MammothNode): string {
  switch (node.type) {
    case 'text':
      return node.value ?? '';
    case 'tab':
      return ' ';
    case 'break':
      return node.breakType === 'line' ? '\n' : ' ';
    case 'deleted':
    case 'noteReference':
    case 'commentReference':
    case 'image':
      return '';
    default:
      return (node.children ?? []).map(runText).join('');
  }
}

function collectImages(node: MammothNode, out: MammothNode[]): void {
  if (node.type === 'image') out.push(node);
  for (const c of node.children ?? []) collectImages(c, out);
}

interface DocxBlock {
  paragraphIndex: number;
  kind: 'heading' | 'paragraph' | 'list_item' | 'table' | 'figure';
  level: number | null;
  text: string;
  table?: TableOut;
  image?: MammothNode;
}

export async function extractDocx(buffer: Buffer): Promise<OfficeDocument> {
  let model: MammothNode | null = null;
  const warnings: string[] = [];
  const result = await mammoth.convertToHtml(
    { buffer },
    {
      transformDocument: (doc: MammothNode) => {
        model = doc;
        return doc;
      },
    },
  );
  for (const m of result.messages) if (m.type === 'error') warnings.push(m.message);
  const doc = model as MammothNode | null;
  if (!doc) throw new Error('mammoth returned no document');

  const blocks: DocxBlock[] = [];
  let paragraphIndex = 0;
  for (const node of doc.children ?? []) {
    const idx = paragraphIndex++;
    if (node.type === 'paragraph') {
      const text = runText(node).replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
      const imgs: MammothNode[] = [];
      collectImages(node, imgs);
      for (const img of imgs) blocks.push({ paragraphIndex: idx, kind: 'figure', level: null, text: img.altText ?? '', image: img });
      if (!text) continue;
      const level = headingLevel(node);
      blocks.push({
        paragraphIndex: idx,
        kind: level !== null ? 'heading' : node.numbering ? 'list_item' : 'paragraph',
        level,
        text,
      });
    } else if (node.type === 'table') {
      const table = docxTable(node);
      if (table) blocks.push({ paragraphIndex: idx, kind: 'table', level: null, text: serializeTable(table), table });
    }
  }

  // section level: the highest heading level; a single document-title heading does not split sections
  const levels = blocks.filter((b) => b.kind === 'heading').map((b) => b.level!);
  let sectionLevel: number | null = levels.length ? Math.min(...levels) : null;
  if (sectionLevel !== null && levels.filter((l) => l === sectionLevel).length === 1) {
    const deeper = levels.filter((l) => l > sectionLevel!);
    if (deeper.length) sectionLevel = Math.min(...deeper);
  }

  const pages: OfficePage[] = [];
  let current: OfficePage | null = null;
  const headingStack: Array<{ level: number; text: string }> = [];
  let seq = 0;
  for (const b of blocks) {
    if (b.kind === 'heading') {
      while (headingStack.length && headingStack[headingStack.length - 1]!.level >= b.level!) headingStack.pop();
    }
    const startsSection = b.kind === 'heading' && sectionLevel !== null && b.level === sectionLevel;
    if (!current || (startsSection && current.regions.length > 0)) {
      current = { index: pages.length, kind: 'docx_section', printedLabel: null, width: null, height: null, sectionKey: null, regions: [], images: [] };
      pages.push(current);
    }
    if (startsSection) current.sectionKey = b.text.slice(0, 200);
    const headingPath = headingStack.map((h) => h.text);
    if (b.kind === 'heading') headingStack.push({ level: b.level!, text: b.text });
    const key = `d${++seq}`;
    const locator: Record<string, unknown> = { paragraph_index: b.paragraphIndex, heading_path: b.kind === 'heading' ? headingPath : headingStack.map((h) => h.text) };
    if (b.kind === 'heading') locator.heading_level = b.level;
    const region: LayoutRegion = {
      key,
      kind: b.kind,
      box: null,
      text: b.kind === 'figure' ? null : b.text,
      textOrigin: b.kind === 'figure' ? null : 'digital',
      dir: dirOf(b.text),
      lang: langOf(b.text),
      headingLevel: b.level,
      locator,
    };
    if (b.table) {
      region.table = b.table;
      current.regions.push(region);
      for (const c of b.table.cells.filter((x) => x.text.trim())) {
        current.regions.push({
          key: `d${++seq}`,
          kind: 'table_cell',
          box: null,
          text: c.text,
          textOrigin: 'digital',
          parentKey: key,
          lang: langOf(c.text),
          locator: { paragraph_index: b.paragraphIndex, r: c.r, c: c.c, rowspan: c.rowspan, colspan: c.colspan, header: c.header },
        });
      }
      continue;
    }
    if (b.kind === 'figure' && b.image) {
      region.figure = { captionKey: null, labels: [], labelsOrigin: null };
      if (b.image.altText) region.locator = { ...locator, alt_text: b.image.altText.slice(0, 500) };
      const mime = b.image.contentType ?? '';
      if (IMAGE_MIME.test(mime) && b.image.read) {
        try {
          const data = await b.image.read();
          current.images.push({ regionKey: key, data, mime, name: `docx-image-${b.paragraphIndex}` });
        } catch {
          warnings.push(`image at paragraph ${b.paragraphIndex} could not be read`);
        }
      }
    }
    current.regions.push(region);
  }
  return { pages, warnings };
}

function docxTable(node: MammothNode): TableOut | null {
  const rows = (node.children ?? []).filter((r) => r.type === 'tableRow');
  if (!rows.length) return null;
  const cells: TableCellOut[] = [];
  // occupancy grid to place cells after row-spanning cells from previous rows
  const occupied = new Set<string>();
  let cols = 0;
  rows.forEach((row, r) => {
    let c = 0;
    for (const cell of (row.children ?? []).filter((x) => x.type === 'tableCell')) {
      while (occupied.has(`${r}:${c}`)) c++;
      const colspan = Math.max(1, cell.colSpan ?? 1);
      const rowspan = Math.max(1, cell.rowSpan ?? 1);
      for (let dr = 0; dr < rowspan; dr++) for (let dc = 0; dc < colspan; dc++) occupied.add(`${r + dr}:${c + dc}`);
      const text = (cell.children ?? []).map((p) => runText(p).trim()).filter(Boolean).join('\n');
      cells.push({ r, c, rowspan, colspan, header: Boolean(row.isHeader), text, box: { x0: 0, top: 0, x1: 0, bottom: 0 } });
      c += colspan;
      cols = Math.max(cols, c);
    }
  });
  return { box: { x0: 0, top: 0, x1: 0, bottom: 0 }, rows: rows.length, cols, cells, method: 'office' };
}

// ───────────────────────────── PPTX ─────────────────────────────
const EMU_PER_PT = 12700;

interface Xfrm {
  x: number;
  y: number;
  cx: number;
  cy: number;
}

function readXfrm(el: XmlElement | undefined): Xfrm | null {
  if (!el) return null;
  const off = firstChild(el, 'off');
  const ext = firstChild(el, 'ext');
  if (!off || !ext) return null;
  const n = (v: string | undefined) => (v === undefined ? NaN : Number(v));
  const x = n(attr(off, 'x'));
  const y = n(attr(off, 'y'));
  const cx = n(attr(ext, 'cx'));
  const cy = n(attr(ext, 'cy'));
  if (![x, y, cx, cy].every(Number.isFinite)) return null;
  return { x, y, cx, cy };
}

type GroupMap = (x: Xfrm) => Xfrm;
const identityMap: GroupMap = (x) => x;

function groupMap(grpSpPr: XmlElement | undefined, parent: GroupMap): GroupMap {
  const xfrm = grpSpPr ? firstChild(grpSpPr, 'xfrm') : undefined;
  if (!xfrm) return parent;
  const own = readXfrm(xfrm);
  const chOff = firstChild(xfrm, 'chOff');
  const chExt = firstChild(xfrm, 'chExt');
  if (!own || !chOff || !chExt) return parent;
  const cox = Number(attr(chOff, 'x'));
  const coy = Number(attr(chOff, 'y'));
  const cex = Number(attr(chExt, 'cx')) || 1;
  const cey = Number(attr(chExt, 'cy')) || 1;
  const sx = own.cx / cex;
  const sy = own.cy / cey;
  return (c) => parent({ x: own.x + (c.x - cox) * sx, y: own.y + (c.y - coy) * sy, cx: c.cx * sx, cy: c.cy * sy });
}

interface PlaceholderInfo {
  type: string | null;
  idx: string | null;
}

function placeholderOf(shape: XmlElement): PlaceholderInfo | null {
  const nv = findFirst(shape, 'nvPr');
  const ph = nv ? firstChild(nv, 'ph') : undefined;
  if (!ph) return null;
  return { type: attr(ph, 'type') ?? null, idx: attr(ph, 'idx') ?? null };
}

function relsMap(xml: string | null, baseDir: string): Map<string, { type: string; target: string }> {
  const out = new Map<string, { type: string; target: string }>();
  if (!xml) return out;
  const root = parseXml(xml);
  for (const r of childElements(root, 'Relationship')) {
    const id = attr(r, 'Id');
    const target = attr(r, 'Target');
    const type = attr(r, 'Type') ?? '';
    if (!id || !target || attr(r, 'TargetMode') === 'External') continue;
    out.set(id, { type, target: posix.normalize(posix.join(baseDir, target)) });
  }
  return out;
}

function relsPathFor(part: string): string {
  return posix.join(posix.dirname(part), '_rels', posix.basename(part) + '.rels');
}

/** Largest OOXML part we inflate (slide XML, rels…); a hostile package must not exhaust memory. */
const MAX_PART_BYTES = 64 * 1024 * 1024;

/** Uncompressed size declared in the zip directory (JSZip internal; may be absent). */
function declaredSize(f: JSZip.JSZipObject): number | null {
  const d = (f as unknown as { _data?: { uncompressedSize?: unknown } })._data;
  return typeof d?.uncompressedSize === 'number' ? d.uncompressedSize : null;
}

async function readPart(zip: JSZip, path: string): Promise<string | null> {
  const f = zip.file(path);
  if (!f) return null;
  const size = declaredSize(f);
  if (size !== null && size > MAX_PART_BYTES) throw new Error(`part ${path} too large`);
  const text = await f.async('string');
  if (text.length > MAX_PART_BYTES) throw new Error(`part ${path} too large`);
  return text;
}

function paragraphText(p: XmlElement): string {
  let out = '';
  for (const c of p.children) {
    if (typeof c === 'string') continue;
    const ln = localName(c.name);
    if (ln === 'r' || ln === 'fld') {
      const t = firstChild(c, 't');
      if (t) out += textContent(t);
    } else if (ln === 'br') out += '\n';
  }
  return out.replace(/[ \t]+/g, ' ').trim();
}

function maxFontSize(el: XmlElement): number | null {
  let max: number | null = null;
  for (const rPr of [...findAll(el, 'rPr'), ...findAll(el, 'defRPr'), ...findAll(el, 'endParaRPr')]) {
    const sz = Number(attr(rPr, 'sz'));
    if (Number.isFinite(sz) && sz > 0) max = Math.max(max ?? 0, sz / 100);
  }
  return max;
}

const MEDIA_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  webp: 'image/webp',
};

/** Max total uncompressed bytes we read from a PPTX package (zip-bomb guard on top of upload limits). */
const MAX_PPTX_MEDIA_BYTES = 400 * 1024 * 1024;

export async function extractPptx(buffer: Buffer): Promise<OfficeDocument & { slideWidth: number; slideHeight: number; hiddenSlides: number[] }> {
  const zip = await JSZip.loadAsync(buffer);
  const warnings: string[] = [];
  const presXml = await readPart(zip, 'ppt/presentation.xml');
  if (!presXml) throw new Error('presentation.xml missing');
  const pres = parseXml(presXml);
  const presRels = relsMap(await readPart(zip, 'ppt/_rels/presentation.xml.rels'), 'ppt');
  const sldSz = findFirst(pres, 'sldSz');
  const slideWidth = (Number(sldSz ? attr(sldSz, 'cx') : NaN) || 9144000) / EMU_PER_PT;
  const slideHeight = (Number(sldSz ? attr(sldSz, 'cy') : NaN) || 6858000) / EMU_PER_PT;
  const sldIdLst = findFirst(pres, 'sldIdLst');
  const slidePaths: string[] = [];
  for (const s of sldIdLst ? childElements(sldIdLst, 'sldId') : []) {
    const rid = attr(s, 'r:id') ?? attr(s, 'id');
    const rel = rid ? presRels.get(rid) : undefined;
    if (rel && /\/slide$/.test(rel.type)) slidePaths.push(rel.target);
  }

  const pages: OfficePage[] = [];
  const hiddenSlides: number[] = [];
  let mediaBytes = 0;
  for (let si = 0; si < slidePaths.length; si++) {
    const path = slidePaths[si]!;
    const xml = await readPart(zip, path);
    const page: OfficePage = {
      index: si,
      kind: 'slide',
      printedLabel: String(si + 1),
      width: slideWidth,
      height: slideHeight,
      sectionKey: null,
      regions: [],
      images: [],
    };
    pages.push(page);
    if (!xml) {
      warnings.push(`slide ${si + 1} part missing`);
      continue;
    }
    const slide = parseXml(xml);
    if (attr(slide, 'show') === '0') hiddenSlides.push(si);
    const rels = relsMap(await readPart(zip, relsPathFor(path)), posix.dirname(path));
    // placeholder positions inherited from the layout (and its master)
    const inherited = await inheritedPlaceholders(zip, rels);
    const spTree = findFirst(slide, 'spTree');
    let seq = 0;
    const key = (p: string) => `s${si + 1}${p}${++seq}`;
    const toBox = (x: Xfrm): Box => ({ x0: x.x / EMU_PER_PT, top: x.y / EMU_PER_PT, x1: (x.x + x.cx) / EMU_PER_PT, bottom: (x.y + x.cy) / EMU_PER_PT });
    interface El {
      box: Box;
      regions: LayoutRegion[];
      isTitle: boolean;
      fontSize: number | null;
    }
    const els: El[] = [];

    const walk = async (tree: XmlElement, map: GroupMap) => {
      for (const shape of tree.children) {
        if (typeof shape === 'string') continue;
        const ln = localName(shape.name);
        if (ln === 'grpSp') {
          await walk(shape, groupMap(firstChild(shape, 'grpSpPr'), map));
          continue;
        }
        const cNvPr = findFirst(shape, 'cNvPr');
        const shapeId = cNvPr ? attr(cNvPr, 'id') ?? null : null;
        if (ln === 'sp') {
          const ph = placeholderOf(shape);
          const spPr = firstChild(shape, 'spPr');
          let xf = readXfrm(spPr ? firstChild(spPr, 'xfrm') : undefined);
          if (!xf && ph) xf = inherited.get(`${ph.type ?? ''}|${ph.idx ?? ''}`) ?? inherited.get(`${ph.type ?? ''}|`) ?? inherited.get(`|${ph.idx ?? ''}`) ?? null;
          const box = xf ? toBox(map(xf)) : null;
          const txBody = firstChild(shape, 'txBody');
          if (!txBody) continue;
          const isTitle = ph?.type === 'title' || ph?.type === 'ctrTitle';
          const isBodyPh = ph !== null && !isTitle && (ph.type === null || ph.type === 'body' || ph.type === 'obj');
          if (ph && ['dt', 'ftr', 'sldNum', 'hdr'].includes(ph.type ?? '')) continue; // date/footer/slide-number placeholders
          const paras = childElements(txBody, 'p');
          const regions: LayoutRegion[] = [];
          let pIndex = 0;
          for (const p of paras) {
            const text = paragraphText(p);
            const idx = pIndex++;
            if (!text) continue;
            const pPr = firstChild(p, 'pPr');
            const buNone = pPr ? firstChild(pPr, 'buNone') : undefined;
            const hasBullet = pPr ? Boolean(firstChild(pPr, 'buChar') ?? firstChild(pPr, 'buAutoNum')) : false;
            const kind: LayoutRegion['kind'] = isTitle ? 'heading' : hasBullet || (isBodyPh && !buNone) ? 'list_item' : 'paragraph';
            regions.push({
              key: key(isTitle ? 'h' : 'p'),
              kind,
              box,
              text,
              textOrigin: 'digital',
              dir: dirOf(text),
              lang: langOf(text),
              headingLevel: isTitle ? 1 : null,
              locator: { slide: si + 1, shape_id: shapeId, paragraph_index: idx },
            });
          }
          if (regions.length) els.push({ box: box ?? { x0: 0, top: 0, x1: 0, bottom: 0 }, regions, isTitle, fontSize: maxFontSize(txBody) });
        } else if (ln === 'graphicFrame') {
          const xf = readXfrm(firstChild(shape, 'xfrm'));
          const box = xf ? toBox(map(xf)) : null;
          const tbl = findFirst(shape, 'tbl');
          if (tbl) {
            const t = pptxTable(tbl, box);
            const tKey = key('tbl');
            const regions: LayoutRegion[] = [
              { key: tKey, kind: 'table', box, text: serializeTable(t), textOrigin: 'digital', table: t, locator: { slide: si + 1, shape_id: shapeId } },
              ...t.cells
                .filter((c) => c.text.trim())
                .map((c) => ({
                  key: key('cell'),
                  kind: 'table_cell' as const,
                  box: null,
                  text: c.text,
                  textOrigin: 'digital' as const,
                  parentKey: tKey,
                  lang: langOf(c.text),
                  locator: { slide: si + 1, shape_id: shapeId, r: c.r, c: c.c, rowspan: c.rowspan, colspan: c.colspan, header: c.header },
                })),
            ];
            els.push({ box: box ?? { x0: 0, top: 0, x1: 0, bottom: 0 }, regions, isTitle: false, fontSize: null });
          } else if (findFirst(shape, 'chart')) {
            els.push({
              box: box ?? { x0: 0, top: 0, x1: 0, bottom: 0 },
              regions: [
                {
                  key: key('fig'),
                  kind: 'figure',
                  box,
                  text: null,
                  textOrigin: null,
                  figure: { captionKey: null, labels: [], labelsOrigin: null },
                  locator: { slide: si + 1, shape_id: shapeId, chart: true },
                },
              ],
              isTitle: false,
              fontSize: null,
            });
          }
        } else if (ln === 'pic') {
          const spPr = firstChild(shape, 'spPr');
          const xf = readXfrm(spPr ? firstChild(spPr, 'xfrm') : undefined);
          const box = xf ? toBox(map(xf)) : null;
          const blip = findFirst(shape, 'blip');
          const rid = blip ? (attr(blip, 'r:embed') ?? attr(blip, 'embed')) : undefined;
          const rel = rid ? rels.get(rid) : undefined;
          const fKey = key('fig');
          const alt = cNvPr ? attr(cNvPr, 'descr') : undefined;
          const region: LayoutRegion = {
            key: fKey,
            kind: 'figure',
            box,
            text: null,
            textOrigin: null,
            figure: { captionKey: null, labels: [], labelsOrigin: null },
            locator: { slide: si + 1, shape_id: shapeId, ...(alt ? { alt_text: alt.slice(0, 500) } : {}) },
          };
          if (rel) {
            const ext = posix.extname(rel.target).slice(1).toLowerCase();
            const mime = MEDIA_MIME[ext];
            const file = zip.file(rel.target);
            const declared = file ? declaredSize(file) : null;
            if (declared !== null && mediaBytes + declared > MAX_PPTX_MEDIA_BYTES) {
              warnings.push('media size limit reached; remaining pictures not stored');
            } else if (mime && file) {
              const data = await file.async('nodebuffer');
              mediaBytes += data.length;
              if (mediaBytes <= MAX_PPTX_MEDIA_BYTES) page.images.push({ regionKey: fKey, data, mime, name: posix.basename(rel.target) });
              else warnings.push('media size limit reached; remaining pictures not stored');
            }
          }
          els.push({ box: box ?? { x0: 0, top: 0, x1: 0, bottom: 0 }, regions: [region], isTitle: false, fontSize: null });
        }
      }
    };
    if (spTree) await walk(spTree, identityMap);

    // title fallback: no title placeholder → the largest-font short text shape in the top third
    if (!els.some((e) => e.isTitle)) {
      const candidates = els.filter(
        (e) => e.fontSize !== null && e.regions.length <= 2 && e.regions.every((r) => r.kind !== 'table' && (r.text ?? '').length <= 120) && e.box.top <= slideHeight * 0.35,
      );
      const maxSize = Math.max(0, ...els.map((e) => e.fontSize ?? 0));
      const best = candidates.sort((a, b) => (b.fontSize ?? 0) - (a.fontSize ?? 0) || a.box.top - b.box.top)[0];
      if (best && best.fontSize === maxSize) {
        best.isTitle = true;
        for (const r of best.regions) {
          if (r.kind === 'figure') continue;
          r.kind = 'heading';
          r.headingLevel = 1;
        }
      }
    }
    const allText = els.flatMap((e) => e.regions.map((r) => r.text ?? '')).join(' ');
    const { r, l } = countStrong(allText);
    const dir: 'rtl' | 'ltr' = r > l ? 'rtl' : 'ltr';
    const titleEls = els.filter((e) => e.isTitle);
    const rest = orderElements(els.filter((e) => !e.isTitle), dir, slideWidth * 0.02);
    for (const e of [...titleEls, ...rest]) page.regions.push(...e.regions);
    page.sectionKey = titleEls[0]?.regions[0]?.text?.slice(0, 200) ?? null;

    // speaker notes
    const notesRel = [...rels.values()].find((x) => /\/notesSlide$/.test(x.type));
    if (notesRel) {
      const notesXml = await readPart(zip, notesRel.target);
      if (notesXml) {
        const notes = parseXml(notesXml);
        const texts: string[] = [];
        for (const sp of findAll(notes, 'sp')) {
          const ph = placeholderOf(sp);
          if (ph?.type !== 'body') continue;
          const txBody = firstChild(sp, 'txBody');
          if (!txBody) continue;
          for (const p of childElements(txBody, 'p')) {
            const t = paragraphText(p);
            if (t) texts.push(t);
          }
        }
        texts.forEach((t, i) =>
          page.regions.push({
            key: key('note'),
            kind: 'note',
            box: null,
            text: t,
            textOrigin: 'digital',
            dir: dirOf(t),
            lang: langOf(t),
            locator: { slide: si + 1, notes: true, paragraph_index: i },
          }),
        );
      }
    }
  }
  return { pages, warnings, slideWidth, slideHeight, hiddenSlides };
}

async function inheritedPlaceholders(zip: JSZip, slideRels: Map<string, { type: string; target: string }>): Promise<Map<string, Xfrm>> {
  const out = new Map<string, Xfrm>();
  const layoutRel = [...slideRels.values()].find((x) => /\/slideLayout$/.test(x.type));
  if (!layoutRel) return out;
  const collect = (xml: string | null) => {
    if (!xml) return;
    const root = parseXml(xml);
    for (const sp of findAll(root, 'sp')) {
      const ph = placeholderOf(sp);
      if (!ph) continue;
      const spPr = firstChild(sp, 'spPr');
      const xf = readXfrm(spPr ? firstChild(spPr, 'xfrm') : undefined);
      if (!xf) continue;
      for (const k of [`${ph.type ?? ''}|${ph.idx ?? ''}`, `${ph.type ?? ''}|`, `|${ph.idx ?? ''}`]) if (!out.has(k)) out.set(k, xf);
    }
  };
  collect(await readPart(zip, layoutRel.target));
  const layoutRels = relsMap(await readPart(zip, relsPathFor(layoutRel.target)), posix.dirname(layoutRel.target));
  const masterRel = [...layoutRels.values()].find((x) => /\/slideMaster$/.test(x.type));
  if (masterRel) collect(await readPart(zip, masterRel.target));
  return out;
}

function pptxTable(tbl: XmlElement, box: Box | null): TableOut {
  const rows = childElements(tbl, 'tr');
  const tblPr = firstChild(tbl, 'tblPr');
  const firstRowHeader = tblPr ? attr(tblPr, 'firstRow') === '1' : false;
  const cells: TableCellOut[] = [];
  let cols = 0;
  rows.forEach((tr, r) => {
    let c = 0;
    for (const tc of childElements(tr, 'tc')) {
      const colspan = Math.max(1, Number(attr(tc, 'gridSpan') ?? 1) || 1);
      const rowspan = Math.max(1, Number(attr(tc, 'rowSpan') ?? 1) || 1);
      const continuation = attr(tc, 'hMerge') === '1' || attr(tc, 'vMerge') === '1';
      if (!continuation) {
        const txBody = firstChild(tc, 'txBody');
        const text = txBody ? childElements(txBody, 'p').map(paragraphText).filter(Boolean).join('\n') : '';
        cells.push({ r, c, rowspan, colspan, header: firstRowHeader && r === 0, text, box: box ?? { x0: 0, top: 0, x1: 0, bottom: 0 } });
      }
      c += 1; // every grid column has its own <a:tc> (merged ones carry hMerge/vMerge)
      cols = Math.max(cols, c);
    }
  });
  return { box: box ?? { x0: 0, top: 0, x1: 0, bottom: 0 }, rows: rows.length, cols, cells, method: 'office' };
}
