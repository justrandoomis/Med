// pdf.js loader for the browser (Book Canvas / Source Inspector).
// The library and its worker are loaded lazily so they never weigh on the first paint. The worker
// URL comes from Vite's `?url` import, so the hashed worker file is emitted, precached by the PWA
// (offline reading) and served from our own origin (no CDN).
import type * as PdfjsLib from 'pdfjs-dist';

let loading: Promise<typeof PdfjsLib> | null = null;

export function loadPdfjs(): Promise<typeof PdfjsLib> {
  if (!loading) {
    loading = Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]).then(([lib, worker]) => {
      lib.GlobalWorkerOptions.workerSrc = worker.default;
      return lib;
    });
    loading.catch(() => {
      loading = null; // allow a retry after a transient failure
    });
  }
  return loading;
}

/**
 * Opens a PDF from bytes or an authenticated same-origin URL (e.g. /api/files/:id).
 * Credentials ride on the session cookie; nothing is fetched from third parties.
 */
export async function openPdf(src: { data: ArrayBuffer | Uint8Array } | { url: string }) {
  const pdfjs = await loadPdfjs();
  const params = 'data' in src ? { data: src.data } : { url: src.url, withCredentials: true };
  return pdfjs.getDocument(params).promise;
}
