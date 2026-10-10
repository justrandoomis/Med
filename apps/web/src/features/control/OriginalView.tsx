// The ORIGINAL side of the review desk: the region cut out of the page at reading size, or the whole page with the
// region outlined. PDF pages are drawn by pdf.js from the authenticated file route; image pages from their stored
// image. Boxes are normalized to the UNROTATED page (ARCHITECTURE §3.8) and mapped with the page's rotation.
import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { Maximize2, Minimize2 } from 'lucide-react';
import { normBoxToView, normalizeRotation, type NormBox, type ReviewOriginal } from '@medlevo/shared';
import { Button, ErrorState, Skeleton } from '../../design';
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

const PAD = 10; // css px of context around the cut-out region
const MIN_CROP_SCALE = 1.6;
const MAX_CANVAS_PX = 12_000_000;

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

function padRect(r: Rect, max: { w: number; h: number }, pad: number): Rect {
  const left = Math.max(0, r.left - pad);
  const top = Math.max(0, r.top - pad);
  const right = Math.min(max.w, r.left + r.width + pad);
  const bottom = Math.min(max.h, r.top + r.height + pad);
  return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

/** Draws the page (or the cut-out) into the canvas; returns the drawn css size and the box position on it. */
async function drawPdf(page: PDFPageProxy, canvas: HTMLCanvasElement, width: number, bbox: NormBox | null, crop: boolean): Promise<{ w: number; h: number; box: Rect | null }> {
  const rot = normalizeRotation(page.rotate);
  const [x0, y0, x1, y1] = page.view as [number, number, number, number];
  const pw = x1 - x0;
  const ph = y1 - y0;
  const viewW1 = rot === 90 || rot === 270 ? ph : pw;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  if (crop && bbox) {
    const at1 = normBoxToView(bbox, { pageWidth: pw, pageHeight: ph, scale: 1, rotation: rot });
    // the region at READING size: as wide as the panel when that is legible, never below 1.6× (a full-width line then
    // scrolls inside the frame — RTL frames start at the line's beginning) and never above 4×
    const scale = Math.min(4, Math.max(width / Math.max(at1.width + 2 * PAD, 1), MIN_CROP_SCALE));
    const viewport = page.getViewport({ scale, rotation: rot });
    const box = normBoxToView(bbox, { pageWidth: pw, pageHeight: ph, scale, rotation: rot });
    const r = padRect(box, { w: viewport.width, h: viewport.height }, PAD);
    let dpr = ratio;
    while (r.width * r.height * dpr * dpr > MAX_CANVAS_PX && dpr > 0.5) dpr /= 1.5;
    canvas.width = Math.floor(r.width * dpr);
    canvas.height = Math.floor(r.height * dpr);
    canvas.style.width = `${Math.floor(r.width)}px`;
    canvas.style.height = `${Math.floor(r.height)}px`;
    await page.render({ canvas, viewport, transform: [dpr, 0, 0, dpr, -r.left * dpr, -r.top * dpr] }).promise;
    return { w: r.width, h: r.height, box: { left: box.left - r.left, top: box.top - r.top, width: box.width, height: box.height } };
  }
  const scale = Math.min(width, 900) / viewW1;
  const viewport = page.getViewport({ scale, rotation: rot });
  canvas.width = Math.floor(viewport.width * ratio);
  canvas.height = Math.floor(viewport.height * ratio);
  canvas.style.width = `${Math.floor(viewport.width)}px`;
  canvas.style.height = `${Math.floor(viewport.height)}px`;
  await page.render({ canvas, viewport, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined }).promise;
  return { w: viewport.width, h: viewport.height, box: bbox ? normBoxToView(bbox, { pageWidth: pw, pageHeight: ph, scale, rotation: rot }) : null };
}

function PdfOriginal({ fileId, pageIndex, bbox, crop, label }: { fileId: string; pageIndex: number; bbox: NormBox | null; crop: boolean; label: string }) {
  const [wrapRef, width] = useWidth<HTMLDivElement>();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<{ status: 'loading' | 'ready' | 'error'; w?: number; h?: number; box?: Rect | null }>({ status: 'loading' });
  useEffect(() => {
    if (width <= 0) return;
    let cancelled = false;
    setState({ status: 'loading' });
    (async () => {
      try {
        const doc = await loadDoc(fileId);
        const page = await doc.getPage(pageIndex + 1);
        if (cancelled || !canvasRef.current) return;
        const r = await drawPdf(page, canvasRef.current, width, bbox, crop);
        if (!cancelled) setState({ status: 'ready', ...r });
      } catch (e) {
        if (!cancelled && !(e instanceof Error && e.name === 'RenderingCancelledException')) setState({ status: 'error' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fileId, pageIndex, width, bbox, crop]);
  return (
    <div ref={wrapRef} className="cc-orig__frame">
      {/* pages are drawn LTR: a canvas inherits `direction`, and an RTL context misplaces pdf.js glyphs */}
      <div className="cc-orig__sheet" dir="ltr" style={state.w ? { width: state.w, height: state.h } : undefined}>
        <canvas ref={canvasRef} role="img" aria-label={label} />
        {state.status === 'ready' && state.box && <span className="cc-orig__box" aria-hidden="true" style={{ left: state.box.left - 3, top: state.box.top - 2, width: state.box.width + 6, height: state.box.height + 4 }} />}
      </div>
      {state.status === 'loading' && <Skeleton height={crop ? '6rem' : '22rem'} />}
      {state.status === 'error' && <ErrorState inline message="تعذّر رسم الصفحة الأصلية هنا. افتحها في مساحة الدراسة بدلًا من ذلك." />}
    </div>
  );
}

function ImageOriginal({ fileId, bbox, crop, label }: { fileId: string; bbox: NormBox | null; crop: boolean; label: string }) {
  const [wrapRef, width] = useWidth<HTMLDivElement>();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    if (!crop || !bbox || !img || !canvasRef.current || width <= 0) return;
    const sx = Math.max(0, bbox.x * img.naturalWidth - PAD);
    const sy = Math.max(0, bbox.y * img.naturalHeight - PAD);
    const sw = Math.min(img.naturalWidth - sx, bbox.w * img.naturalWidth + 2 * PAD);
    const sh = Math.min(img.naturalHeight - sy, bbox.h * img.naturalHeight + 2 * PAD);
    // scans are already high-resolution: never below their own pixels (wide crops scroll inside the frame)
    const scale = Math.min(4, Math.max(width / Math.max(sw, 1), 1));
    const c = canvasRef.current;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.width = Math.floor(sw * scale * dpr);
    c.height = Math.floor(sh * scale * dpr);
    c.style.width = `${Math.floor(sw * scale)}px`;
    c.style.height = `${Math.floor(sh * scale)}px`;
    c.getContext('2d')?.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
  }, [crop, bbox, img, width]);
  return (
    <div ref={wrapRef} className="cc-orig__frame">
      <div className="cc-orig__sheet cc-orig__sheet--image" dir="ltr" hidden={crop && !!bbox}>
        <img
          src={fileUrl(fileId)}
          alt={label}
          onLoad={(e) => {
            setImg(e.currentTarget);
            setSize({ w: e.currentTarget.clientWidth, h: e.currentTarget.clientHeight });
          }}
          onError={() => setFailed(true)}
        />
        {size && bbox && !crop && <span className="cc-orig__box" aria-hidden="true" style={{ left: bbox.x * size.w - 3, top: bbox.y * size.h - 2, width: bbox.w * size.w + 6, height: bbox.h * size.h + 4 }} />}
      </div>
      {crop && bbox && <canvas ref={canvasRef} role="img" aria-label={label} className="cc-orig__crop" />}
      {failed && <ErrorState inline message="تعذّر تحميل الصورة الأصلية." />}
    </div>
  );
}

export function OriginalView({ original }: { original: ReviewOriginal }) {
  const hasBox = !!original.bbox;
  const [crop, setCrop] = useState(hasBox);
  const where = original.page_label_ar ?? 'الصفحة';
  const label = crop && hasBox ? `${where}: المنطقة الأصلية مقتطعة ومكبّرة` : `${where}: الصفحة الأصلية${hasBox ? '، والمنطقة محاطة بإطار' : ''}`;
  const r = original.render;
  return (
    <figure className="cc-orig">
      {r.kind === 'pdf' ? (
        <PdfOriginal fileId={r.file_id} pageIndex={r.page_index} bbox={original.bbox} crop={crop && hasBox} label={label} />
      ) : r.kind === 'image' ? (
        <ImageOriginal fileId={r.file_id} bbox={original.bbox} crop={crop && hasBox} label={label} />
      ) : (
        <p className="cc-muted">{r.reason_ar}</p>
      )}
      <figcaption className="cc-orig__caption">
        <span>{crop && hasBox ? 'المنطقة كما في الصفحة الأصلية' : where}</span>
        {hasBox && r.kind !== 'none' && (
          <Button size="sm" variant="plain" icon={crop ? <Maximize2 size={14} /> : <Minimize2 size={14} />} onClick={() => setCrop((c) => !c)}>
            {crop ? 'الصفحة كاملة' : 'المنطقة فقط'}
          </Button>
        )}
      </figcaption>
    </figure>
  );
}
