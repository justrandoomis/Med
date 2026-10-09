// The ORIGINAL page(s) of a question occurrence with the question's regions highlighted (side-by-side review,
// §34/§48). PDF pages are drawn with pdf.js from the authenticated file route; image pages use their stored
// image. Boxes are normalized to the unrotated page (ARCHITECTURE §3.8) and mapped with the page's rotation.
import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { normBoxToView, normalizeRotation, richTextFromPlain, type NormBox, type QuestionOriginalView } from '@medlevo/shared';
import { ErrorState, RichTextView, Skeleton } from '../../design';
import { openPdf } from '../../lib/pdf';

const fileUrl = (id: string) => `/api/files/${encodeURIComponent(id)}`;
const docs = new Map<string, Promise<PDFDocumentProxy>>();

function loadDoc(fileId: string): Promise<PDFDocumentProxy> {
  let p = docs.get(fileId);
  if (!p) {
    p = openPdf({ url: fileUrl(fileId) });
    docs.set(fileId, p);
    p.catch(() => docs.delete(fileId));
  }
  return p;
}

type PageSpec = QuestionOriginalView['pages'][number];

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setW(Math.floor(el.getBoundingClientRect().width));
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

function Boxes({ boxes, rect }: { boxes: Array<{ region_id: string | null; bbox: NormBox }>; rect: (b: NormBox) => { left: number; top: number; width: number; height: number } }) {
  return (
    <>
      {boxes.map((b, i) => {
        const r = rect(b.bbox);
        return <span key={`${b.region_id ?? i}`} className="qv-orig__box" style={{ left: r.left - 3, top: r.top - 2, width: r.width + 6, height: r.height + 4 }} aria-hidden="true" />;
      })}
    </>
  );
}

function PdfPage({ fileId, page, label }: { fileId: string; page: PageSpec; label: string }) {
  const [wrapRef, width] = useWidth<HTMLDivElement>();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<{ status: 'loading' | 'ready' | 'error'; error?: string; w?: number; h?: number; scale?: number; rot?: 0 | 90 | 180 | 270; pw?: number; ph?: number }>({ status: 'loading' });

  useEffect(() => {
    if (width <= 0) return;
    let cancelled = false;
    let task: { cancel(): void; promise: Promise<unknown> } | null = null;
    (async () => {
      try {
        const doc = await loadDoc(fileId);
        const p = await doc.getPage(page.page_index + 1);
        if (cancelled) return;
        const rot = normalizeRotation(p.rotate);
        const [x0, y0, x1, y1] = p.view as [number, number, number, number];
        const pw = x1 - x0;
        const ph = y1 - y0;
        const viewW = rot === 90 || rot === 270 ? ph : pw;
        const scale = Math.min(width, 900) / viewW;
        const viewport = p.getViewport({ scale, rotation: rot });
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.floor(viewport.width * ratio);
        canvas.height = Math.floor(viewport.height * ratio);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        task = p.render({ canvas, viewport, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined });
        await task.promise;
        if (!cancelled) setState({ status: 'ready', w: viewport.width, h: viewport.height, scale, rot, pw, ph });
      } catch (e) {
        if (!cancelled && !(e instanceof Error && e.name === 'RenderingCancelledException')) {
          setState({ status: 'error', error: 'تعذّر عرض الصفحة الأصلية. افتحها في مساحة الدراسة بدلًا من ذلك.' });
        }
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [fileId, page.page_index, width]);

  return (
    <figure className="qv-orig__page" ref={wrapRef}>
      {/* the page is drawn LTR: a canvas inherits `direction`, and an RTL context misplaces pdf.js glyphs */}
      <div className="qv-orig__sheet" dir="ltr" style={state.w ? { width: state.w, height: state.h } : undefined}>
        <canvas ref={canvasRef} role="img" aria-label={`${label} — الصفحة الأصلية، ومكان السؤال مظلل`} />
        {state.status === 'loading' && <Skeleton height="24rem" />}
        {state.status === 'ready' && (
          <Boxes boxes={page.boxes} rect={(b) => normBoxToView(b, { pageWidth: state.pw!, pageHeight: state.ph!, scale: state.scale!, rotation: state.rot! })} />
        )}
      </div>
      {state.status === 'error' && <ErrorState inline message={state.error!} />}
      <figcaption className="qv-orig__caption">{label}</figcaption>
    </figure>
  );
}

function ImagePage({ fileId, page, label }: { fileId: string; page: PageSpec; label: string }) {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [failed, setFailed] = useState(false);
  return (
    <figure className="qv-orig__page">
      <div className="qv-orig__sheet qv-orig__sheet--image" dir="ltr">
        <img
          src={fileUrl(fileId)}
          alt={`${label} — صورة السؤال الأصلية، ومكان السؤال مظلل`}
          onLoad={(e) => setSize({ w: e.currentTarget.clientWidth, h: e.currentTarget.clientHeight })}
          onError={() => setFailed(true)}
        />
        {size && <Boxes boxes={page.boxes} rect={(b) => ({ left: b.x * size.w, top: b.y * size.h, width: b.w * size.w, height: b.h * size.h })} />}
      </div>
      {failed && <ErrorState inline message="تعذّر تحميل الصورة الأصلية." />}
      <figcaption className="qv-orig__caption">{label}</figcaption>
    </figure>
  );
}

export function OriginalPages({ original }: { original: QuestionOriginalView }) {
  const v = original.version;
  const pdfFile = v.display_file_id ?? (v.format === 'pdf' ? v.file_id : null);
  if (original.pages.length === 0) {
    return <p className="qv-muted">لا توجد صفحة أصلية لهذا الموضع.</p>;
  }
  return (
    <div className="qv-orig">
      {original.pages.map((p) =>
        p.render_file_id && (v.format === 'image' || v.format === 'image_set') ? (
          <ImagePage key={p.page_id} fileId={p.render_file_id} page={p} label={p.label_ar} />
        ) : pdfFile ? (
          <PdfPage key={p.page_id} fileId={pdfFile} page={p} label={p.label_ar} />
        ) : (
          <div key={p.page_id} className="qv-orig__text">
            <p className="qv-muted">لا يوجد عرض ثابت لهذه الصفحة ({p.label_ar}). النص كما استُخرج:</p>
          </div>
        ),
      )}
      {!pdfFile && v.format !== 'image' && v.format !== 'image_set' && original.raw_text && (
        <RichTextView value={richTextFromPlain(original.raw_text)} className="qv-raw" />
      )}
    </div>
  );
}
