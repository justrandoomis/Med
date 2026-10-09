// pdf.js document handle for the Book Canvas: pages and their text are fetched lazily and cached.
// The file comes from an explicitly downloaded copy (IndexedDB `blobs`, Download Manager) when present,
// otherwise from the authenticated same-origin file route (Range requests; nothing from third parties).
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { getDb } from '../../../lib/localdb';
import { openPdf } from '../../../lib/pdf';
import { fileUrl } from '../data/api';

export interface PageText {
  /** concatenation of the text items exactly as the text layer puts them in the DOM */
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
  const pages = new Map<number, Promise<PDFPageProxy>>();
  const texts = new Map<number, Promise<PageText>>();
  let destroyed = false;
  const handle: PdfHandle = {
    fileId,
    doc,
    numPages: doc.numPages,
    page(index) {
      let p = pages.get(index);
      if (!p) {
        p = doc.getPage(index + 1);
        pages.set(index, p);
        p.catch(() => pages.delete(index));
      }
      return p;
    },
    text(index) {
      let t = texts.get(index);
      if (!t) {
        t = handle.page(index).then(async (page) => {
          const content = await page.getTextContent();
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
