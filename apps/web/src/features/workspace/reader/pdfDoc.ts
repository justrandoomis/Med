// pdf.js document handle for the Book Canvas: pages and their text are fetched lazily and cached.
// The file comes from an explicitly downloaded copy (IndexedDB `blobs`, Download Manager) when present,
// otherwise from the authenticated same-origin file route (Range requests; nothing from third parties).
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { getDb } from '../../../lib/localdb';
import { openPdf } from '../../../lib/pdf';
import { fileUrl } from '../data/api';
import { logicalTextContent } from './textOrder';

export interface PageText {
  /** concatenation of the text items exactly as the text layer puts them in the DOM (logical order, textOrder.ts) */
  text: string;
  /** offsets where a line ended (pdf.js hasEOL) — searched as a space */
  breaks: number[];
}

export interface PdfHandle {
  fileId: string;
  doc: PDFDocumentProxy;
  numPages: number;
  page(index: number): Promise<PDFPageProxy>;
  text(index: number): Promise<PageText>;
  destroy(): void;
}

async function localCopy(fileId: string): Promise<ArrayBuffer | null> {
  try {
    const db = getDb();
    const rec = (await db.blobs.get(fileId)) ?? (await db.blobs.get(`file:${fileId}`));
    return rec?.data ? await rec.data.arrayBuffer() : null;
  } catch {
    return null;
  }
}

export async function loadPdfHandle(fileId: string): Promise<PdfHandle> {
  const bytes = await localCopy(fileId);
  const doc = await openPdf(bytes ? { data: bytes } : { url: fileUrl(fileId) });
  return pdfHandleFor(doc, fileId);
}

/**
 * Pages whose rendering resources pdf.js may keep. After a display render pdf.js keeps the page's operator list and
 * decoded objects until `cleanup()` is called — measured in Chromium (docs/PERFORMANCE.md): scrolling a 300-page
 * lecture grew the JS heap from 11 MB to 125 MB after GC, while only 2–3 page canvases existed. The least recently
 * used pages beyond this window are cleaned up (pdf.js refuses while a render of that page is still running, and a
 * page needed again simply rebuilds its operator list). Larger than the reader's render window + visible thumbnails.
 */
export const PDF_PAGES_KEPT = 16;

export function pdfHandleFor(doc: PDFDocumentProxy, fileId: string): PdfHandle {
  const pages = new Map<number, Promise<PDFPageProxy>>();
  const texts = new Map<number, Promise<PageText>>();
  /** page indexes, least recently used first */
  const recent: number[] = [];
  let destroyed = false;
  const touch = (index: number) => {
    const at = recent.indexOf(index);
    if (at >= 0) recent.splice(at, 1);
    recent.push(index);
    while (recent.length > PDF_PAGES_KEPT) {
      const old = recent.shift()!;
      const p = pages.get(old);
      pages.delete(old);
      void p?.then((pg) => pg.cleanup()).catch(() => undefined);
    }
  };
  const handle: PdfHandle = {
    fileId,
    doc,
    numPages: doc.numPages,
    page(index) {
      touch(index);
      let p = pages.get(index);
      if (!p) {
        const fresh = doc.getPage(index + 1);
        p = fresh;
        pages.set(index, fresh);
        fresh.catch(() => {
          if (pages.get(index) === fresh) pages.delete(index);
        });
      }
      return p;
    },
    text(index) {
      let t = texts.get(index);
      if (!t) {
        t = handle.page(index).then(async (page) => {
          // the same logical order as the text layer (textOrder.ts), so search offsets match the DOM text nodes
          const content = logicalTextContent(await page.getTextContent());
          let text = '';
          const breaks: number[] = [];
          for (const item of content.items) {
            if (!('str' in item)) continue;
            text += item.str;
            if (item.hasEOL) breaks.push(text.length);
          }
          return { text, breaks };
        });
        texts.set(index, t);
        t.catch(() => texts.delete(index));
      }
      return t;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      void doc.loadingTask.destroy();
    },
  };
  return handle;
}

/** Normalized intrinsic rotation (/Rotate) of a pdf.js page. */
export function intrinsicRotation(page: PDFPageProxy): number {
  return ((page.rotate % 360) + 360) % 360;
}
