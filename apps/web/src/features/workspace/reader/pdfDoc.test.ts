// Regression (I2 performance pass, docs/PERFORMANCE.md): pdf.js keeps a page's operator list and decoded objects
// after a display render until cleanup() — scrolling a 300-page lecture grew the JS heap from 11 MB to 125 MB (after
// GC) although only 2–3 page canvases existed. The handle now cleans up pages outside its recently-used window.
import { describe, expect, it, vi } from 'vitest';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { PDF_PAGES_KEPT, pdfHandleFor } from './pdfDoc';

function fakeDoc(numPages: number) {
  const proxies = new Map<number, { cleanup: ReturnType<typeof vi.fn>; getTextContent: () => Promise<{ items: unknown[] }> }>();
  const getPage = vi.fn(async (n: number) => {
    let p = proxies.get(n);
    if (!p) {
      p = { cleanup: vi.fn(() => true), getTextContent: async () => ({ items: [{ str: `page ${n}`, hasEOL: false }] }) };
      proxies.set(n, p);
    }
    return p as unknown as PDFPageProxy;
  });
  const doc = { numPages, getPage, loadingTask: { destroy: vi.fn() } } as unknown as PDFDocumentProxy;
  return { doc, getPage, proxies };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('pdf handle page window', () => {
  it('cleans up pages that left the recently used window; recent pages keep their resources', async () => {
    const { doc, proxies } = fakeDoc(300);
    const h = pdfHandleFor(doc, 'F1');
    for (let i = 0; i < 300; i++) await h.page(i); // scrolling through the whole book
    await settle();
    const cleaned = [...proxies.entries()].filter(([, p]) => p.cleanup.mock.calls.length > 0).map(([n]) => n - 1);
    expect(cleaned).toHaveLength(300 - PDF_PAGES_KEPT);
    expect(cleaned).toEqual(Array.from({ length: 300 - PDF_PAGES_KEPT }, (_, i) => i));
    for (let i = 300 - PDF_PAGES_KEPT; i < 300; i++) expect(proxies.get(i + 1)!.cleanup).not.toHaveBeenCalled();
  });

  it('a page used again moves to the front (not cleaned up), and an evicted page is simply fetched again', async () => {
    const { doc, getPage, proxies } = fakeDoc(100);
    const h = pdfHandleFor(doc, 'F1');
    await h.page(0);
    for (let i = 1; i < PDF_PAGES_KEPT + 5; i++) {
      await h.page(i);
      await h.page(0); // e.g. the page under the reading line keeps being used
    }
    await settle();
    expect(proxies.get(1)!.cleanup).not.toHaveBeenCalled();
    expect(proxies.get(2)!.cleanup).toHaveBeenCalled();
    const calls = getPage.mock.calls.filter(([n]) => n === 2).length;
    await h.page(1); // evicted earlier → asked from the document again
    expect(getPage.mock.calls.filter(([n]) => n === 2).length).toBe(calls + 1);
    // the search text of a page stays available whatever happens to its rendering resources
    expect((await h.text(1)).text).toBe('page 2');
  });
});
