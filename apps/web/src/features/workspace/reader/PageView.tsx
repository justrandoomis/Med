// One page of the Book Canvas: the paper sheet (pdf.js canvas / page image), an accessible selectable text
// layer, overlays (text highlights, search hits, cited region) and the ink layer — all in the page's own
// coordinate system — plus the folio that names the page (printed label + file position, AC-04).
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { RenderTask } from 'pdfjs-dist';
import { annotationTargetKey, detectDir, richTextFromPlain, type NormBox, type PageViewTransform, type SourcePageView, type SourceRegionView } from '@medlevo/shared';
import { RichTextView, Skeleton, cx } from '../../../design';
import { loadPdfjs } from '../../../lib/pdf';
import { InkLayer } from '../ink';
import { useFileSrc } from '../../../lib/offline';
import { fetchRegions } from '../data/api';
import { folio, fullPageLabel } from '../model/pages';
import { pdfPageUsesRegionText, regionTextRuns } from '../model/regionText';
import { clientRectsToNorm, rangeFromOffsets } from '../model/textQuote';
import type { PageGeom } from './geometry';
import { BoxesLayer, RegionHighlight, TextHighlightsLayer } from './overlays';
import { PdfLinkLayer } from './pdfLinks';
import { useReaderPage } from './readerContext';
import { logicalTextContent } from './textOrder';

const MAX_CANVAS_PIXELS = 12_000_000; // stays under iOS Safari's canvas memory limit

export interface PageViewProps {
  page: SourcePageView;
  /** index of this page in the reader's sheet sequence (data-seq; defaults to page_index) */
  seq?: number;
  geom: PageGeom;
  /** unrotated page size in page units */
  unrotated: { w: number; h: number };
  /** render the full page (near the viewport); otherwise a sized placeholder */
  near: boolean;
  /** position: absolute inside the canvas content */
  style?: React.CSSProperties;
}

export const PageView = memo(function PageView({ page, seq, geom, unrotated, near, style }: PageViewProps) {
  const ctx = useReaderPage();
  const f = folio(page);
  const label = fullPageLabel(page);
  const view: PageViewTransform = { pageWidth: unrotated.w, pageHeight: unrotated.h, scale: geom.scale, rotation: geom.rotation };
  const sheetRef = useRef<HTMLDivElement>(null);
  const textRootRef = useRef<HTMLElement | null>(null);
  const [textVersion, setTextVersion] = useState(0);
  const onTextRoot = useCallback(
    (el: HTMLElement | null) => {
      textRootRef.current = el;
      ctx.registerTextRoot(page.page_index, el);
      if (el) setTextVersion((v) => v + 1);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [page.page_index, ctx.registerTextRoot],
  );

  // search hits → normalized boxes (computed from the DOM text, so they land on the exact characters)
  const [hitBoxes, setHitBoxes] = useState<{ boxes: NormBox[]; current: number | null }>({ boxes: [], current: null });
  const results = ctx.searchResults;
  const current = ctx.currentResult;
  useEffect(() => {
    const root = textRootRef.current;
    const sheet = sheetRef.current;
    const mine = results.filter((r) => r.pageIndex === page.page_index);
    if (!near || !root || !sheet || mine.length === 0 || ctx.mode === 'text') {
      setHitBoxes((s) => (s.boxes.length ? { boxes: [], current: null } : s));
      return;
    }
    const box = sheet.getBoundingClientRect();
    const boxes: NormBox[] = [];
    let cur: number | null = null;
    for (const r of mine) {
      const range = rangeFromOffsets(root, r.start, r.end);
      if (!range) continue;
      const rects = Array.from(range.getClientRects());
      const norm = clientRectsToNorm(rects, box, view);
      if (current && current.pageIndex === r.pageIndex && current.start === r.start) cur = boxes.length;
      boxes.push(...norm);
    }
    setHitBoxes({ boxes, current: cur });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results, current, near, textVersion, geom.scale, geom.rotation, page.page_index]);

  const showHighlight = ctx.highlight && ctx.highlight.pageId === page.id;
  const targetKey = `source_page:${page.id}`;
  const anchor = ctx.anchorFor(page.page_index);
  const hasInk = ctx.inkEnabled && ctx.mode !== 'text' && !!anchor && near;

  return (
    <div
      role="group"
      className="wk-page"
      style={style}
      data-page-index={page.page_index}
      data-seq={seq ?? page.page_index}
      data-page-id={page.id}
      aria-label={label}
      aria-roledescription="صفحة"
    >
      <div
        ref={sheetRef}
        className={cx('wk-sheet', ctx.mode === 'text' && 'wk-sheet--text')}
        data-pw={unrotated.w}
        data-ph={unrotated.h}
        data-scale={geom.scale}
        data-rot={geom.rotation}
        style={ctx.mode === 'text' ? { width: geom.viewW, minHeight: geom.viewH } : { width: geom.viewW, height: geom.viewH }}
      >
        {!near ? (
          <div className="wk-sheet__placeholder" aria-hidden="true" />
        ) : ctx.mode === 'pdf' ? (
          <PdfSheet page={page} geom={geom} unrotated={unrotated} onTextRoot={onTextRoot}>
            <TextHighlightsLayer targetKey={targetKey} />
            <BoxesLayer boxes={hitBoxes.boxes} current={hitBoxes.current} className="wk-hit" />
            {showHighlight && <RegionHighlight pageId={page.id} bbox={ctx.highlight!.bbox} label={ctx.highlight!.label ?? undefined} />}
          </PdfSheet>
        ) : ctx.mode === 'image' ? (
          <ImageSheet page={page} geom={geom} unrotated={unrotated} onTextRoot={onTextRoot}>
            <TextHighlightsLayer targetKey={targetKey} />
            <BoxesLayer boxes={hitBoxes.boxes} current={hitBoxes.current} className="wk-hit" />
            {showHighlight && <RegionHighlight pageId={page.id} bbox={ctx.highlight!.bbox} label={ctx.highlight!.label ?? undefined} />}
          </ImageSheet>
        ) : (
          <TextSheet page={page} zoom={geom.scale} onTextRoot={onTextRoot} highlightRegionId={showHighlight ? ctx.highlight!.regionId : null} />
        )}
        {hasInk && anchor && (
          <div className={cx('wk-ink-slot', ctx.inkInteractive && 'wk-ink-slot--active')}>
            <InkLayer
              targetKey={annotationTargetKey(anchor)}
              anchor={anchor}
              view={view}
              interactive={ctx.inkInteractive}
              onStrokeActiveChange={ctx.onStrokeActiveChange}
            />
          </div>
        )}
      </div>
      <p className="wk-folio" aria-hidden="true">
        <span className="wk-folio__primary">{f.primary}</span>
        {f.secondary && <span className="wk-folio__secondary">{f.secondary}</span>}
      </p>
    </div>
  );
});

// ───────────────────────────── PDF ─────────────────────────────
function PdfSheet({
  page: sourcePage,
  geom,
  unrotated,
  onTextRoot,
  children,
}: {
  page: SourcePageView;
  geom: PageGeom;
  unrotated: { w: number; h: number };
  onTextRoot: (el: HTMLElement | null) => void;
  children: React.ReactNode;
}) {
  const pageIndex = sourcePage.page_index;
  const { pdf, textInteractive, reportPageSize, textLang } = useReaderPage();
  const canvasSlot = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  // a scanned page inside the PDF has no PDF text layer: its text is the server's OCR (AC-02 — never an empty page)
  const regionText = pdfPageUsesRegionText(sourcePage);
  const regions = useRegions(sourcePage.id, regionText);
  const ocrRef = useRef<HTMLDivElement>(null);
  const runs = regionText ? regionTextRuns(regions ?? []) : [];
  const [state, setState] = useState<'rendering' | 'ready' | 'error'>('rendering');

  // canvas: rendered into a fresh canvas that replaces the old one when done (no blank flash on zoom)
  useEffect(() => {
    if (!pdf) return;
    let cancelled = false;
    let task: RenderTask | null = null;
    const canvas = document.createElement('canvas');
    canvas.className = 'wk-pagecanvas';
    canvas.setAttribute('aria-hidden', 'true');
    (async () => {
      const page = await pdf.page(pageIndex);
      if (cancelled) return;
      const viewport = page.getViewport({ scale: geom.scale, rotation: geom.rotation });
      let ratio = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, 3);
      if (viewport.width * viewport.height * ratio * ratio > MAX_CANVAS_PIXELS) ratio = Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height));
      canvas.width = Math.max(1, Math.floor(viewport.width * ratio));
      canvas.height = Math.max(1, Math.floor(viewport.height * ratio));
      task = page.render({ canvas, viewport, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined });
      await task.promise;
      if (cancelled) return;
      const slot = canvasSlot.current;
      if (!slot) return;
      const old = Array.from(slot.querySelectorAll('canvas'));
      slot.append(canvas);
      for (const c of old) {
        c.width = 0; // release the bitmap now (Safari keeps detached canvases alive)
        c.height = 0;
        c.remove();
      }
      setState('ready');
    })().catch((e: unknown) => {
      if (cancelled || (e instanceof Error && e.name === 'RenderingCancelledException')) return;
      console.warn('[workspace] page render failed', e);
      setState('error');
    });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [pdf, pageIndex, geom.scale, geom.rotation]);

  // release canvases when the page leaves the render window
  useEffect(
    () => () => {
      const slot = canvasSlot.current;
      slot?.querySelectorAll('canvas').forEach((c) => {
        c.width = 0;
        c.height = 0;
      });
    },
    [],
  );

  // accessible, selectable text layer (pdf.js TextLayer) in the unrotated page space
  useEffect(() => {
    if (!pdf) return;
    let cancelled = false;
    let layer: { cancel(): void } | null = null;
    const container = textRef.current;
    if (!container) return;
    (async () => {
      const [pdfjs, page] = await Promise.all([loadPdfjs(), pdf.page(pageIndex)]);
      if (cancelled) return;
      const raw = page.getViewport({ scale: 1 }).rawDims as { pageWidth: number; pageHeight: number };
      reportPageSize(pageIndex, { w: raw.pageWidth, h: raw.pageHeight, rotate: ((page.rotate % 360) + 360) % 360 });
      container.replaceChildren();
      if (regionText) return; // the OCR layer below carries this page's text
      container.style.setProperty('--total-scale-factor', String(geom.scale));
      // items in logical reading order (textOrder.ts): selection, copy and in-document search follow the reading,
      // not the order the PDF producer drew mixed Arabic/English pieces in (AC-20)
      const content = logicalTextContent(await page.getTextContent());
      if (cancelled) return;
      const tl = new pdfjs.TextLayer({ textContentSource: content, container, viewport: page.getViewport({ scale: geom.scale, rotation: 0 }) });
      layer = tl;
      await tl.render();
      if (!cancelled) onTextRoot(container);
    })().catch(() => {
      // text layer failures leave the page readable as an image; search/selection say so elsewhere
    });
    return () => {
      cancelled = true;
      layer?.cancel();
      if (!regionText) onTextRoot(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdf, pageIndex, geom.scale, regionText]);

  // OCR text root: registered again once the runs are in the DOM (search hits and selection map onto it)
  useEffect(() => {
    if (!regionText) return;
    onTextRoot(ocrRef.current);
    return () => onTextRoot(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regionText, regions]);

  return (
    <>
      <div ref={canvasSlot} className="wk-canvas-slot" />
      {state === 'rendering' && <Skeleton className="wk-sheet__skeleton" width="100%" height="100%" radius="0" />}
      {state === 'error' && <p className="wk-sheet__error">تعذّر رسم هذه الصفحة.</p>}
      <div className="wk-layers" data-rot={geom.rotation} style={{ width: unrotated.w * geom.scale, height: unrotated.h * geom.scale }}>
        {children}
        <div ref={textRef} className={cx('wk-textlayer', !textInteractive && 'wk-textlayer--inert')} lang={textLang ?? undefined} />
        {regionText && <OcrTextLayer layerRef={ocrRef} runs={runs} interactive={textInteractive} />}
        <PdfLinkLayer pageIndex={pageIndex} />
      </div>
    </>
  );
}

// ───────────────────────────── page images (image / image_set) ─────────────────────────────
function useRegions(pageId: string, enabled: boolean): SourceRegionView[] | null {
  const [regions, setRegions] = useState<SourceRegionView[] | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetchRegions(pageId)
      .then((r) => !cancelled && setRegions(r.regions))
      .catch(() => !cancelled && setRegions([]));
    return () => {
      cancelled = true;
    };
  }, [pageId, enabled]);
  return regions;
}

function ImageSheet({
  page,
  geom,
  unrotated,
  onTextRoot,
  children,
}: {
  page: SourcePageView;
  geom: PageGeom;
  unrotated: { w: number; h: number };
  onTextRoot: (el: HTMLElement | null) => void;
  children: React.ReactNode;
}) {
  const { textInteractive } = useReaderPage();
  const regions = useRegions(page.id, true);
  const fileId = page.render_file_id;
  // the downloaded copy on this device when there is one (object URL), else the authenticated file route
  const src = useFileSrc(fileId);
  const [failed, setFailed] = useState(false);
  const textRef = useCallback((el: HTMLDivElement | null) => onTextRoot(el), [onTextRoot]);
  // same filter and order as the search text of this page (offsets must agree)
  const textRegions = regionTextRuns(regions ?? []);
  return (
    <div className="wk-layers" data-rot={geom.rotation} style={{ width: unrotated.w * geom.scale, height: unrotated.h * geom.scale }}>
      {fileId && !failed ? (
        // with OCR text the text layer carries the content; without it the image itself must be named
        src && <img className="wk-page-image" src={src} alt={textRegions.length ? '' : `صورة ${fullPageLabel(page)} (لا يوجد نص مقروء لها بعد)`} draggable={false} onError={() => setFailed(true)} />
      ) : (
        <p className="wk-sheet__error">
          {!fileId
            ? 'لا توجد صورة معالجة لهذه الصفحة بعد.'
            : typeof navigator !== 'undefined' && navigator.onLine === false
              ? 'صورة هذه الصفحة غير محمّلة على هذا الجهاز؛ تظهر عند عودة الاتصال.'
              : 'تعذّر تحميل صورة هذه الصفحة.'}
        </p>
      )}
      {children}
      {/* OCR text placed over the image: selectable and readable by screen readers */}
      <OcrTextLayer layerRef={textRef} runs={textRegions} interactive={textInteractive} />
    </div>
  );
}

/** Region text placed over a page picture (page image or scanned PDF page): selectable, read by screen readers. */
function OcrTextLayer({ layerRef, runs, interactive }: { layerRef: React.Ref<HTMLDivElement>; runs: SourceRegionView[]; interactive: boolean }) {
  return (
    <div ref={layerRef} className={cx('wk-ocrlayer', !interactive && 'wk-textlayer--inert')} lang={runs[0]?.lang ?? undefined}>
      {runs.map((r) => (
        <span key={r.id} className="wk-ocrlayer__run" style={{ left: `${r.bbox!.x * 100}%`, top: `${r.bbox!.y * 100}%`, width: `${r.bbox!.w * 100}%`, height: `${r.bbox!.h * 100}%` }} dir={detectDir(r.text ?? '')}>
          {r.text}
        </span>
      ))}
    </div>
  );
}

// ───────────────────────────── structured text (DOCX sections, slide text) ─────────────────────────────
function TextSheet({ page, zoom, onTextRoot, highlightRegionId }: { page: SourcePageView; zoom: number; onTextRoot: (el: HTMLElement | null) => void; highlightRegionId: string | null }) {
  const regions = useRegions(page.id, true);
  const textRef = useCallback((el: HTMLDivElement | null) => onTextRoot(el), [onTextRoot]);
  useEffect(() => {
    if (!highlightRegionId) return;
    document.querySelector(`[data-region-id="${CSS.escape(highlightRegionId)}"]`)?.scrollIntoView?.({ block: 'center' });
  }, [highlightRegionId, regions]);
  if (regions === null) {
    return (
      <div className="wk-textsheet" aria-busy="true">
        <Skeleton lines={6} />
      </div>
    );
  }
  const blocks = regions.filter((r) => r.text && r.kind !== 'footer' && r.kind !== 'header').sort((a, b) => a.reading_order - b.reading_order);
  return (
    <div ref={textRef} className="wk-textsheet" style={{ ['--wk-text-zoom' as string]: String(Math.max(0.6, Math.min(3, zoom))) }}>
      {blocks.length === 0 && <p className="wk-textsheet__empty">لا يوجد نص مستخرج لهذا الجزء بعد.</p>}
      {blocks.map((r) => {
        const rt = richTextFromPlain(r.text ?? '', { kind: r.kind === 'heading' ? 'h' : r.kind === 'list_item' ? 'li' : r.kind === 'caption' ? 'caption' : undefined });
        return (
          <div key={r.id} data-region-id={r.id} className={cx('wk-textsheet__block', r.id === highlightRegionId && 'wk-textsheet__block--hl')}>
            <RichTextView value={rt} variant="reading" headingOffset={1} />
          </div>
        );
      })}
    </div>
  );
}
