// Imperative controller of one page's ink layer: Pointer Events in, canvases out.
//
// Performance rules (spec §55; React best practices "use refs for transient values"):
//  * no React state is touched during a stroke; pointer samples go to refs and draw in a
//    requestAnimationFrame callback (one paint per display frame)
//  * getCoalescedEvents() for every sample the digitizer produced; getPredictedEvents() drawn ONLY
//    on the live layer, never saved
//  * committed strokes are redrawn only inside dirty rectangles found through the spatial index
//  * writing never waits for storage or network: commit = in-memory update + queued IndexedDB write
import { newId, viewSize, viewToNorm, type AnnotationAnchor, type InkData, type InkPenTool, type InkStyle, type NormBox, type ShapeData } from '@medlevo/shared';
import { latencyProbe, penProbe } from './capabilities';
import { itemHitByPath, PointEraseSession } from './eraser';
import { closedLoop, closedOutline, detectScribble, FingerTapDetector, scribbleTargets } from './gestures';
import { classifyPointerDown, palmPolicy, StrokeCapture, type InputSample } from './input';
import { eraserAllows, isCanvasItem, isSelectable, lassoAllows } from './kinds';
import { bboxOf, boxContains, expandBox, fractionInside, pointInPolygon, unionBox, type Mat, type Vec } from './math';
import { isBoxItem, isInkStroke, isShape, isSticky, isTextBox, itemBBox, itemGeometry, lassoSamplePoints, makeInkItem, makeShapeItem, transformItem, type InkItem } from './model';
import { inkTool, type InkToolPointerSession } from './tools';
import { audioLinkAt } from './audioLink';
import { LASER_COLOR, paletteSignature, resolveInkColor } from './palette';
import { canvasScale, deviceRectOf, drawItem, HIGHLIGHT_ALPHA, HIGHLIGHT_ALPHA_ISOLATED, highlightBlendIsolated, pageMatrix, paintOrder, paperToneOf, setMatrix, type RenderEnv } from './render';
import { recognizeShape, type RecognizedShape } from './shapes';
import type { InkDocumentStore, PageEvent } from './store';
import type { InkPageView, InkToolId, InkToolState } from './types';
import { recordInkPaint } from './tiles';
import { TiledPainter } from './tiles/renderer';
// (parity N1 wave 2)
import { attachTarget, connectorSentence, nodeName } from './connectors';
import { sampleRenderedColor } from './eyedropper';
import { insertSpacePlan, lineBandAt } from './handwritingLayout';
import { isEngineItem } from './model';
import { RULER_SNAP_PX, snapPointsToRuler, startsAtEdge, type RulerState } from './ruler';
import { snapPoint, type SnapLine, type SnapTargets } from './snap';

/** (P1-T2) the e-ink display mode is on (`<html data-eink="on">`, design/themeDisplay.ts) */
const einkMode = () => typeof document !== 'undefined' && document.documentElement.getAttribute('data-eink') === 'on';
const perfNow = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const PEN_TOOLS: ReadonlySet<InkToolId> = new Set(['pen', 'fountain', 'ball', 'highlighter', 'pencil']);
/** shapes drawn by dragging (the polygon is tapped corner by corner; a connector runs between shapes) */
const SHAPE_TOOLS: ReadonlySet<InkToolId> = new Set(['line', 'arrow', 'rect', 'ellipse', 'triangle', 'curved_arrow', 'double_arrow']);
type DragShape = 'line' | 'arrow' | 'rect' | 'ellipse' | 'triangle' | 'curved_arrow' | 'double_arrow';
const BOX_DRAG: ReadonlySet<string> = new Set(['rect', 'ellipse', 'triangle']);
/** (N1 wave 2) a tap this close to a polygon's first corner closes it (css px) */
const POLYGON_CLOSE_PX = 14;
/** (N1 wave 2) a connector end snaps to a shape's edge point this close (css px) */
const CONNECT_PX = 28;
/** (N1 wave 2) snapping tolerance while drawing a shape (css px) */
const SNAP_PX = 8;
const HOLD_MS = 600;
/** (review) a second finger this soon after a touch started an eraser / lasso gesture: the two fingers belong together */
const SECOND_FINGER_MS = 200;
const HOLD_SLOP_PX = 3;
const HOLD_CANCEL_PX = 14;
const TAP_PX = 6;
const STROKE_ERASER_PX = 9;
const POINT_ERASER_PX = 9;
const LASER_FADE_MS = 900;
const SELECT_TAP_PX = 10;

export interface LayerDeps {
  store: InkDocumentStore;
  targetKey: string;
  root: HTMLElement;
  highlightCanvas: HTMLCanvasElement;
  inkCanvas: HTMLCanvasElement;
  liveCanvas: HTMLCanvasElement;
  getAnchor: () => AnnotationAnchor;
  getView: () => InkPageView;
  getTool: () => InkToolState;
  getInteractive: () => boolean;
  onStrokeActive: (active: boolean) => void;
  onTextRequest: (req: { kind: 'text' | 'sticky' | 'image'; at: [number, number] }) => void;
  /** the link tool finished a box (normalized); the layer asks the host where it leads (track F1) */
  onLinkRequest?: (req: { box: NormBox }) => void;
  onSelectionChanged?: () => void;
  // ── (parity N1) ──
  /** tell the owner (polite live region) */
  announce?: (message: string) => void;
  /** G14: a two-finger (undo) / three-finger (redo) double tap */
  onFingerTap?: (dir: 'undo' | 'redo') => void;
  /** G14: circle + hold selected these items on this page (the host shows the lasso selection) */
  onGestureSelect?: (ids: string[]) => void;
  /** G66: an insert tool (a shape) placed these items (the host may hand back to the lasso) */
  onInserted?: (ids: string[]) => void;
  // ── (parity N1 wave 2) ──
  /** G08: the ruler shown on this document (strokes started along its edge follow it) */
  getRuler?: () => RulerState | null;
  /** G07: the eyedropper waits for a tap on the page (this browser has no EyeDropper API) */
  getColorPick?: () => ((color: string | null) => void) | null;
  /** G09: the zoom window's target box was placed by a tap here */
  onZoomPlace?: (at: [number, number]) => void;
  /** G08: a measuring segment was drawn (normalized ends) */
  onMeasureSegment?: (a: [number, number], b: [number, number]) => void;
  /** G22: what shapes being drawn snap to on this page (null = nothing / snapping off) */
  getSnapTargets?: () => SnapTargets | null;
}

/** (N1, G15) reader items the eraser may remove (text highlights), loaded fresh when an erase starts */
interface ForeignErase {
  items: InkItem[] | null;
  /** every point the eraser went through (iso), tested again once the items arrive */
  path: Vec[];
}

type Gesture =
  | { kind: 'stroke'; pointerId: number; id: string; anchor: AnnotationAnchor; capture: StrokeCapture; style: InkData['style']; predicted: InputSample[]; holdTimer: number | undefined; holdAt: [number, number]; recognized: RecognizedShape | null; loop: { poly: Vec[]; ids: string[] } | null; ruler?: RulerState | null }
  | { kind: 'polygon_tap'; pointerId: number; startClient: [number, number]; moved: boolean }
  | { kind: 'connector'; pointerId: number; from: Vec; fromAttach: { id: string; side: 'n' | 'e' | 's' | 'w' } | null; to: Vec; toAttach: { id: string; side: 'n' | 'e' | 's' | 'w' } | null }
  | { kind: 'space'; pointerId: number; from: Vec; to: Vec }
  | { kind: 'measure'; pointerId: number; from: Vec; to: Vec; startClient: [number, number] }
  | { kind: 'zoom_tap'; pointerId: number; startClient: [number, number]; moved: boolean }
  | { kind: 'erase_stroke'; pointerId: number; last: Vec; hits: Map<string, InkItem>; cursor: [number, number]; foreign: ForeignErase | null }
  | { kind: 'erase_point'; pointerId: number; last: Vec; session: PointEraseSession; wholes: Map<string, InkItem>; cursor: [number, number]; foreign: ForeignErase | null }
  | { kind: 'lasso'; pointerId: number; points: Vec[]; startClient: [number, number]; moved: boolean; rect: boolean }
  | { kind: 'tool'; pointerId: number; session: InkToolPointerSession }
  | { kind: 'shape'; pointerId: number; shape: DragShape; from: Vec; to: Vec; startClient: [number, number] }
  | { kind: 'tap'; pointerId: number; tool: 'text' | 'sticky' | 'image'; startClient: [number, number]; moved: boolean }
  | { kind: 'link_box'; pointerId: number; from: Vec; to: Vec; startClient: [number, number] }
  | { kind: 'laser'; pointerId: number };

export class PageInkController {
  private gesture: Gesture | null = null;
  private rect: DOMRect | null = null;
  private dpr = 1;
  private matrix: Mat = [1, 0, 0, 1, 0, 0];
  private hlCtx: CanvasRenderingContext2D | null = null;
  private inkCtx: CanvasRenderingContext2D | null = null;
  private liveCtx: CanvasRenderingContext2D | null = null;
  private pendingDirty: NormBox[] | 'all' | null = 'all';
  private commitFrame = 0;
  private liveFrame = 0;
  private lastPenUp = -Infinity;
  private laser: Array<{ x: number; y: number; t: number }> = [];
  private transformPreview: Mat | null = null;
  private env: RenderEnv = { W: 1, H: 1, tone: 'light', css: null };
  private disposers: Array<() => void> = [];
  private penHovering = false;
  private viewKey = '';
  /** (P1-T2) dense pages paint through the tile cache */
  private painter: TiledPainter | null = null;
  /** the pending full repaint is a content reload (tiles of the grid on screen must be redrawn) */
  private pendingContentReset = false;
  private visKey: string;
  /** (N1, G14) two- / three-finger double taps */
  private fingers: FingerTapDetector;
  /** (N1, G02) where the pen last touched (client px), for the hand-side palm zone */
  private lastPenAt: { x: number; y: number } | null = null;
  /** (N1, G01) the oldest pointer sample not drawn yet (its timeStamp) and its pointer type */
  private pendingInput: { t: number; type: string } | null = null;
  /** (review) when and with what the current gesture started (a second finger soon after cancels a touch gesture) */
  private gestureStart: { t: number; type: string } | null = null;
  /** (review of N1 wave 2, G22) the snap lines of the shape being drawn, collected at its first point */
  private snapTargets: { t: SnapTargets | null; at: number } | null = null;
  /** (N1 wave 2, G20) the polygon being tapped corner by corner (normalized) */
  private polygon: { pts: Vec[]; lastTap: number } | null = null;
  /** (N1 wave 2, G22) the guides shown while a shape snaps (normalized lines) */
  private guides: SnapLine[] = [];

  constructor(private readonly d: LayerDeps) {
    this.fingers = new FingerTapDetector((n) => {
      if (this.d.getTool().gestures?.finger_undo === false) return;
      this.d.onFingerTap?.(n === 2 ? 'undo' : 'redo');
    });
    this.hlCtx = safeContext(d.highlightCanvas);
    this.inkCtx = safeContext(d.inkCanvas);
    this.liveCtx = safeContext(d.liveCanvas, true);
    this.visKey = d.store.visibilityKey;
    if (this.hlCtx && this.inkCtx) {
      this.painter = new TiledPainter({
        store: d.store,
        targetKey: d.targetKey,
        hlCanvas: d.highlightCanvas,
        inkCanvas: d.inkCanvas,
        hlCtx: this.hlCtx,
        inkCtx: this.inkCtx,
        getView: () => this.d.getView(),
        getMatrix: () => this.matrix,
        getEnv: () => this.env,
      });
    }
    if (this.liveCtx) {
      const attrs = (this.liveCtx as CanvasRenderingContext2D & { getContextAttributes?: () => { desynchronized?: boolean } }).getContextAttributes?.();
      if (attrs) penProbe.noteDesynchronized(!!attrs.desynchronized);
    }
    const r = d.root;
    const opts = { passive: false } as AddEventListenerOptions;
    const on = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void, o?: AddEventListenerOptions) => {
      r.addEventListener(type, fn as EventListener, o);
      this.disposers.push(() => r.removeEventListener(type, fn as EventListener, o));
    };
    on('pointerdown', (e) => this.onDown(e), opts);
    on('pointermove', (e) => this.onMove(e), opts);
    on('pointerup', (e) => this.onUp(e, false), opts);
    on('pointercancel', (e) => this.onUp(e, true), opts);
    on('lostpointercapture', (e) => {
      if (this.gesture && this.gesture.pointerId === e.pointerId) this.onUp(e, true);
    });
    on('pointerover', (e) => this.onPenHover(e, true));
    on('pointerout', (e) => this.onPenHover(e, false));
    // Pencil on iPadOS / stylus on Chrome: touch-action may still pan for a pen (W3C: "panning or
    // zooming through multiple pointer types such as touch and pen"); cancel the touch sequence of a
    // stylus so the page never scrolls or flips under the pen.
    const stopStylus = (e: TouchEvent) => {
      if (!this.d.getInteractive() || !this.isWriting()) return;
      const stylus = Array.from(e.changedTouches).some((t) => (t as Touch & { touchType?: string }).touchType === 'stylus');
      if (stylus || (this.gesture && this.gesture.kind !== 'laser') || this.penHovering) {
        if (e.cancelable) e.preventDefault();
      }
    };
    on('touchstart', stopStylus, opts);
    on('touchmove', stopStylus, opts);
    on('contextmenu', (e) => {
      if (this.gesture || (this.d.getInteractive() && this.isWriting())) e.preventDefault();
    });
    // the page may scroll under a writing pen (a finger elsewhere, momentum, the reader): the layer's
    // client rect is re-read after any scroll/resize during a gesture, never reused stale
    if (typeof window !== 'undefined') {
      const relayout = () => {
        if (this.gesture) this.rect = null;
      };
      const capture = { capture: true, passive: true } as AddEventListenerOptions;
      window.addEventListener('scroll', relayout, capture);
      window.addEventListener('resize', relayout, { passive: true });
      this.disposers.push(() => {
        window.removeEventListener('scroll', relayout, capture);
        window.removeEventListener('resize', relayout);
      });
    }
    // (N1, G14) every finger and pen pointer feeds the double-tap detector (whatever the tool decides about it)
    const feedDown = (e: PointerEvent) => this.fingers.down(e.pointerId, e.pointerType, e.clientX, e.clientY, e.timeStamp);
    const feedMove = (e: PointerEvent) => this.fingers.move(e.pointerId, e.clientX, e.clientY);
    const feedUp = (e: PointerEvent) => this.fingers.up(e.pointerId, e.pointerType, e.timeStamp);
    const feedCancel = (e: PointerEvent) => this.fingers.cancel(e.pointerId, e.pointerType);
    const capt = { capture: true, passive: true } as AddEventListenerOptions;
    on('pointerdown', feedDown, capt);
    on('pointermove', feedMove, capt);
    on('pointerup', feedUp, capt);
    on('pointercancel', feedCancel, capt);
    const unsub = d.store.subscribePage(d.targetKey, (e) => this.onPageEvent(e));
    this.disposers.push(unsub);
    // (N1 wave 2, G20) the polygon being tapped: Enter closes it, Escape drops it (the keyboard path of the gesture)
    if (typeof document !== 'undefined') {
      const onKey = (e: KeyboardEvent) => {
        if (!this.polygon || e.defaultPrevented) return;
        if (e.key === 'Enter') {
          e.preventDefault();
          this.finishPolygon();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          this.cancelPolygon(true);
        }
      };
      document.addEventListener('keydown', onKey);
      this.disposers.push(() => document.removeEventListener('keydown', onKey));
    }
    // theme / paper tone changes → full redraw (colour tokens resolve per tone)
    const mo = new MutationObserver(() => this.refreshEnv(true));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-eink', 'data-contrast'] });
    this.disposers.push(() => mo.disconnect());
    try {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const fn = () => this.refreshEnv(true);
      mq.addEventListener('change', fn);
      this.disposers.push(() => mq.removeEventListener('change', fn));
    } catch {
      // no matchMedia (tests)
    }
  }

  destroy(): void {
    // the layer is going away mid-stroke (e.g. a virtualized page scrolled out by another finger):
    // what was written so far is the owner's writing — keep it, exactly like a pointercancel
    const g = this.gesture;
    if (g?.kind === 'stroke') {
      this.gesture = null;
      clearTimeout(g.holdTimer);
      this.commitStroke(g);
      this.rect = null;
      this.d.root.removeAttribute('data-ink-active');
      this.d.onStrokeActive(false);
    }
    this.cancelGesture();
    this.disposers.forEach((f) => f());
    this.disposers = [];
    cancelAnimationFrame(this.commitFrame);
    cancelAnimationFrame(this.liveFrame);
    // changes not painted yet leave their tiles stale (the next visit redraws them)
    this.painter?.destroy(this.pendingDirty, this.pendingContentReset);
    this.painter = null;
  }

  private isWriting(): boolean {
    const t = this.d.getTool().tool;
    return t !== 'hand' && t !== 'select_text';
  }

  get strokeActive(): boolean {
    return this.gesture !== null;
  }

  // ── view & environment ──
  /** Call when the view (size/zoom/rotation) or DPR changed: resizes canvases and redraws everything. */
  setView(): void {
    const view = this.d.getView();
    const { width, height } = viewSize(view);
    const dpr = canvasScale(width, height, typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);
    const key = `${width}|${height}|${dpr}|${view.rotation}|${view.pageWidth}|${view.pageHeight}`;
    if (key === this.viewKey) return;
    // a zoom step on a dense page: keep the current picture as a stand-in while the new scale re-rasters
    if (this.viewKey) this.painter?.capturePrevious();
    this.viewKey = key;
    this.dpr = dpr;
    for (const c of [this.d.highlightCanvas, this.d.inkCanvas, this.d.liveCanvas]) {
      c.width = Math.max(1, Math.round(width * dpr));
      c.height = Math.max(1, Math.round(height * dpr));
      c.style.width = `${width}px`;
      c.style.height = `${height}px`;
    }
    this.matrix = pageMatrix(view, dpr);
    this.refreshEnv(false);
    this.invalidate('all');
  }

  /** Paper tone + blend availability are read from the live DOM (re-checked on every full repaint). */
  private refreshEnv(redraw: boolean): boolean {
    const view = this.d.getView();
    const root = this.d.root;
    const tone = paperToneOf(root);
    const isolated = highlightBlendIsolated(root);
    if (root.getAttribute('data-ink-tone') !== tone) root.setAttribute('data-ink-tone', tone);
    root.toggleAttribute('data-blend-isolated', isolated);
    let css: CSSStyleDeclaration | null = null;
    try {
      css = getComputedStyle(root);
    } catch {
      css = null;
    }
    // (P1-T2 review) the resolved colours too: e-ink / high contrast change them with the same paper tone
    const palette = paletteSignature(css);
    const changed =
      tone !== this.env.tone || isolated !== (this.env.highlightAlpha === HIGHLIGHT_ALPHA_ISOLATED) || view.pageWidth !== this.env.W || view.pageHeight !== this.env.H || palette !== (this.env.palette ?? '');
    this.env = { W: view.pageWidth, H: view.pageHeight, tone, css, highlightAlpha: isolated ? HIGHLIGHT_ALPHA_ISOLATED : HIGHLIGHT_ALPHA, palette };
    if (redraw) this.invalidate('all');
    return changed;
  }

  private get ar(): number {
    const v = this.d.getView();
    return v.pageHeight / v.pageWidth;
  }

  /** css px → iso units (one iso unit = the page width) */
  private pxToIso(px: number): number {
    const v = this.d.getView();
    return px / (v.pageWidth * v.scale);
  }

  /** The layer's client rect: cached for the gesture (one layout read per stroke), refreshed after a scroll. */
  private layoutRect(): DOMRect {
    if (this.rect) return this.rect;
    const r = this.d.root.getBoundingClientRect();
    if (this.gesture) this.rect = r;
    return r;
  }

  private toNorm = (clientX: number, clientY: number): [number, number] => {
    const rect = this.layoutRect();
    const view = this.d.getView();
    const { width, height } = viewSize(view);
    const sx = rect.width > 0 ? rect.width / width : 1;
    const sy = rect.height > 0 ? rect.height / height : 1;
    return viewToNorm((clientX - rect.left) / sx, (clientY - rect.top) / sy, view);
  };

  private toIso(clientX: number, clientY: number): Vec {
    const [x, y] = this.toNorm(clientX, clientY);
    return [x, y * this.ar];
  }

  // ── store events ──
  private onPageEvent(e: PageEvent) {
    if (e.kind === 'items') {
      if (e.dirty === 'all') this.pendingContentReset = true;
      this.invalidate(e.dirty);
    } else if (e.kind === 'view') {
      // (P1-T2) the visible-layer set changed: repaint (an editability-only change draws nothing new)
      const k = this.d.store.visibilityKey;
      if (k !== this.visKey) {
        this.visKey = k;
        this.invalidate('all');
      }
    } else if (e.kind === 'hidden') {
      const boxes: NormBox[] = [];
      for (const id of e.ids) {
        const b = this.d.store.page(this.d.targetKey)?.index.box(id);
        if (b) boxes.push(b);
      }
      this.invalidate(boxes);
      this.scheduleLive();
    } else if (e.kind === 'loaded') {
      this.pendingContentReset = true;
      this.invalidate('all');
    }
    else if (e.kind === 'selection') this.d.onSelectionChanged?.();
  }

  invalidate(dirty: NormBox[] | 'all'): void {
    if (dirty === 'all' || this.pendingDirty === 'all') this.pendingDirty = 'all';
    else this.pendingDirty = [...(this.pendingDirty ?? []), ...dirty];
    if (!this.commitFrame) this.commitFrame = requestAnimationFrame(() => this.paintCommitted());
  }

  /** Synchronous repaint (tests / after resize). */
  paintCommitted(): void {
    const t0 = perfNow();
    this.commitFrame = 0;
    let dirty = this.pendingDirty;
    this.pendingDirty = null;
    const contentReset = this.pendingContentReset;
    this.pendingContentReset = false;
    if (!dirty || !this.inkCtx || !this.hlCtx) return;
    // the page under the layer may have changed (e.g. the PDF bitmap replaced a placeholder)
    if (this.refreshEnv(false)) dirty = 'all';
    const view = this.d.getView();
    const page = this.d.store.page(this.d.targetKey);
    if (!page) return;
    const cw = this.d.inkCanvas.width;
    const ch = this.d.inkCanvas.height;
    // (P1-T2) a dense page repaints as a whole through the tile cache: warm tiles at once, cold ones in slices
    const tiled = this.painter?.use(page) ?? false;
    if (!tiled) this.painter?.leave();
    let items: InkItem[];
    let clip: Array<{ x: number; y: number; w: number; h: number }> | null = null;
    if (dirty === 'all') {
      if (tiled) {
        if (contentReset) this.painter!.contentReset();
        this.painter!.full();
        return;
      }
      items = [...page.items.values()];
    } else {
      if (dirty.length === 0) return;
      clip = dirty.map((b) => deviceRectOf(b, view, this.matrix, 3));
      const area = clip.reduce((s, r) => s + r.w * r.h, 0);
      if (area > cw * ch * 0.5 && tiled) {
        this.painter!.contentChanged(dirty);
        this.painter!.full();
        return;
      }
      if (area > cw * ch * 0.5) {
        clip = null;
        items = [...page.items.values()];
      } else {
        let q: NormBox | null = null;
        for (const b of dirty) q = unionBox(q, b);
        const seen = new Set<string>();
        items = [];
        for (const b of dirty) {
          for (const it of this.d.store.query(this.d.targetKey, expandBox(b, 0.002))) {
            if (!seen.has(it.id)) {
              seen.add(it.id);
              items.push(it);
            }
          }
        }
      }
    }
    // (P1-T2) the visibility predicate: items of a layer hidden in this session are not drawn
    const store = this.d.store;
    items = items.filter((it) => !store.isHidden(it.id) && isCanvasItem(it) && store.isVisible(it)).sort(paintOrder);
    for (const ctx of [this.hlCtx, this.inkCtx]) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (clip) {
        ctx.beginPath();
        for (const r of clip) ctx.rect(r.x, r.y, r.w, r.h);
        ctx.clip();
        for (const r of clip) ctx.clearRect(r.x, r.y, r.w, r.h);
      } else ctx.clearRect(0, 0, cw, ch);
      setMatrix(ctx, this.matrix);
      for (const it of items) {
        const hl = isInkStroke(it) && it.data.style.tool === 'highlighter';
        if ((ctx === this.hlCtx) === hl) drawItem(ctx, it, this.env);
      }
      ctx.restore();
    }
    // the tiles of the grid on screen follow what was just painted
    if (clip && this.painter?.liveGrid) this.painter.afterDirty(clip);
    if (!clip) recordInkPaint({ targetKey: this.d.targetKey, kind: 'full', mode: 'strokes', ms: Math.round((perfNow() - t0) * 10) / 10, warmTiles: 0, coldTiles: 0, items: items.length, at: t0 });
  }

  /** (P1-T2) draw any cold tiles now (tests / harness) */
  flushTiles(): void {
    this.painter?.flush();
  }

  // ── live layer ──
  private scheduleLive() {
    if (!this.liveFrame) this.liveFrame = requestAnimationFrame(() => this.paintLive());
  }

  setTransformPreview(m: Mat | null): void {
    this.transformPreview = m;
    this.scheduleLive();
  }

  private paintLive() {
    this.liveFrame = 0;
    // (N1, G01) input → frame latency of the samples this frame draws (measured here, never assumed)
    const pend = this.pendingInput;
    if (pend) {
      this.pendingInput = null;
      latencyProbe.record(pend.type, perfNow() - pend.t);
    }
    const ctx = this.liveCtx;
    if (!ctx) return;
    const c = this.d.liveCanvas;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    const g = this.gesture;
    let highlight = false;
    setMatrix(ctx, this.matrix);
    if (g?.kind === 'tool') {
      g.session.drawLive?.(ctx, { W: this.env.W, H: this.env.H });
    } else if (g?.kind === 'stroke') {
      if (g.recognized) {
        const item = makeShapeItem({ id: 'live', anchor: this.d.getAnchor(), now: 0, z: 0, shape: g.recognized.shape, from: g.recognized.from, to: g.recognized.to, rotation: g.recognized.rotation, style: { ...g.style, tool: g.style.tool === 'highlighter' ? 'pen' : g.style.tool } });
        drawItem(ctx, item, this.env);
      } else {
        let pts = g.capture.points.slice();
        for (const p of g.predicted) {
          const [x, y] = this.toNorm(p.clientX, p.clientY);
          pts.push([x, y, 0, p.pressure]);
        }
        // (N1 wave 2, G08) along the ruler: shown on its edge as it will be saved (projected here, in the frame, never per move)
        if (g.ruler) pts = snapPointsToRuler(pts, g.ruler, this.ar);
        highlight = g.style.tool === 'highlighter';
        const data: InkData = { v: 1, points: pts, style: g.style, bbox: { x: 0, y: 0, w: 0, h: 0 }, pressure_available: g.capture.pressureAvailable, tilt_available: false };
        drawItem(ctx, { ...LIVE_BASE, data } as InkItem, this.env);
      }
    } else if (g?.kind === 'erase_point') {
      for (const [id, runs] of g.session.pieces) {
        const orig = g.session.originals.get(id);
        if (!orig || !isInkStroke(orig)) continue;
        for (const run of runs) drawItem(ctx, { ...LIVE_BASE, data: { ...orig.data, points: run } } as InkItem, this.env);
      }
    } else if (g?.kind === 'shape') {
      const item = this.shapeFromGesture(g, 'live');
      if (item) drawItem(ctx, item, this.env);
    } else if (g?.kind === 'link_box') {
      this.outline(ctx, linkBoxOf(g.from, g.to));
    } else if (g?.kind === 'connector') {
      // (N1 wave 2, G21) the connector being drawn, and the edge point it will attach to
      const tool = this.d.getTool();
      const item = makeShapeItem({ id: 'live', anchor: this.d.getAnchor(), now: 0, z: 0, shape: 'arrow', from: g.from, to: g.to, style: shapeStyle(tool), extra: { ...(tool.shapeOptions?.route && tool.shapeOptions.route !== 'straight' ? { route: tool.shapeOptions.route } : {}), ...(tool.shapeOptions?.head ? { head: tool.shapeOptions.head } : {}) } });
      drawItem(ctx, item, this.env);
      for (const end of [g.fromAttach ? g.from : null, g.toAttach ? g.to : null]) if (end) this.dot(ctx, end);
    }
    // (N1 wave 2, G20) the polygon so far, closed by a dashed side
    if (this.polygon && this.polygon.pts.length) {
      const W = this.env.W;
      const H = this.env.H;
      const pts = this.polygon.pts;
      ctx.save();
      ctx.strokeStyle = resolveInkColor(this.d.getTool().color, this.env.tone, this.env.css);
      ctx.lineWidth = Math.max(this.d.getTool().width * W, 1 / this.unitPx());
      ctx.lineJoin = 'round';
      ctx.beginPath();
      pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p[0] * W, p[1] * H) : ctx.lineTo(p[0] * W, p[1] * H)));
      ctx.stroke();
      if (pts.length >= 2) {
        ctx.setLineDash([4 / this.unitPx(), 3 / this.unitPx()]);
        ctx.beginPath();
        ctx.moveTo(pts[pts.length - 1]![0] * W, pts[pts.length - 1]![1] * H);
        ctx.lineTo(pts[0]![0] * W, pts[0]![1] * H);
        ctx.stroke();
      }
      ctx.restore();
      for (const p of pts.slice(0, 1)) this.dot(ctx, p);
    }
    if (this.transformPreview) {
      for (const it of this.d.store.selectedItems()) {
        const moved = transformItem(it, this.transformPreview, this.ar, 0);
        if (isInkStroke(moved) || isShape(moved)) drawItem(ctx, moved, this.env);
        else if (isBoxItem(moved) || isSticky(moved)) this.outline(ctx, itemBBox(moved, this.ar));
      }
    }
    // (N1 wave 2) insert space: the line and the distance; a measuring segment; snapping guides (page units)
    if (g?.kind === 'space' || g?.kind === 'measure') this.liveSegment(ctx, g);
    if (this.guides.length) this.drawGuides(ctx);
    // device-pixel overlays (cursor, lasso, laser)
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const accent = this.cssVar('--ml-color-accent', '#3a47a8');
    if (g?.kind === 'erase_stroke' || g?.kind === 'erase_point') {
      const [vx, vy] = g.cursor;
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1.5 * this.dpr;
      ctx.beginPath();
      ctx.arc(vx * this.dpr, vy * this.dpr, (g.kind === 'erase_stroke' ? STROKE_ERASER_PX : POINT_ERASER_PX) * this.dpr, 0, Math.PI * 2);
      ctx.stroke();
    }
    // the lasso (loop or rectangle) and a closed loop held still (circle + hold, G14), dashed
    const dashed = g?.kind === 'lasso' && g.points.length > 1 ? (g.rect ? rectPoly(g.points[0]!, g.points[g.points.length - 1]!) : g.points) : g?.kind === 'stroke' && g.loop ? g.loop.poly : null;
    if (dashed) {
      ctx.setLineDash([6 * this.dpr, 4 * this.dpr]);
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1.5 * this.dpr;
      ctx.beginPath();
      setMatrix(ctx, this.matrix);
      const W = this.env.W;
      const H = this.env.H;
      dashed.forEach((p, i) => (i === 0 ? ctx.moveTo(p[0] * W, p[1] * H) : ctx.lineTo(p[0] * W, p[1] * H)));
      if (g?.kind !== 'lasso' || g.rect) ctx.closePath();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (this.laser.length) {
      const now = performance.now();
      this.laser = this.laser.filter((p) => now - p.t < LASER_FADE_MS);
      const color = resolveInkColor(LASER_COLOR.token, this.env.tone, this.env.css);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = color;
      for (let i = 1; i < this.laser.length; i++) {
        const a = this.laser[i - 1]!;
        const b = this.laser[i]!;
        ctx.globalAlpha = Math.max(0, 1 - (now - b.t) / LASER_FADE_MS);
        ctx.lineWidth = 4 * this.dpr;
        ctx.beginPath();
        ctx.moveTo(a.x * this.dpr, a.y * this.dpr);
        ctx.lineTo(b.x * this.dpr, b.y * this.dpr);
        ctx.stroke();
      }
      const head = this.laser[this.laser.length - 1];
      if (head) {
        ctx.globalAlpha = Math.max(0, 1 - (now - head.t) / LASER_FADE_MS);
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(head.x * this.dpr, head.y * this.dpr, 5 * this.dpr, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      if (this.laser.length) this.scheduleLive();
    }
    this.d.liveCanvas.classList.toggle('is-highlight', highlight);
  }

  /** dashed outline of a normalized box (transform preview of text boxes / sticky notes) */
  private outline(ctx: CanvasRenderingContext2D, b: NormBox) {
    const W = this.env.W;
    const H = this.env.H;
    ctx.save();
    ctx.strokeStyle = this.cssVar('--ml-color-accent', '#3a47a8');
    ctx.setLineDash([4 / this.unitPx(), 3 / this.unitPx()]);
    ctx.lineWidth = 1.5 / this.unitPx();
    ctx.strokeRect(b.x * W, b.y * H, b.w * W, b.h * H);
    ctx.restore();
  }

  /** (N1 wave 2) a small accent dot (an attachment point, a polygon's first corner) at a normalized point */
  private dot(ctx: CanvasRenderingContext2D, p: Vec) {
    ctx.save();
    ctx.fillStyle = this.cssVar('--ml-color-accent', '#3a47a8');
    ctx.beginPath();
    ctx.arc(p[0] * this.env.W, p[1] * this.env.H, 4 / this.unitPx(), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /** (N1 wave 2) insert space: the line across the page and the band it opens; measure: the segment */
  private liveSegment(ctx: CanvasRenderingContext2D, g: Extract<Gesture, { kind: 'space' | 'measure' }>) {
    const W = this.env.W;
    const H = this.env.H;
    ctx.save();
    ctx.strokeStyle = this.cssVar('--ml-color-accent', '#3a47a8');
    ctx.lineWidth = 1.5 / this.unitPx();
    ctx.setLineDash([5 / this.unitPx(), 3 / this.unitPx()]);
    ctx.beginPath();
    if (g.kind === 'measure') {
      ctx.moveTo(g.from[0] * W, g.from[1] * H);
      ctx.lineTo(g.to[0] * W, g.to[1] * H);
    } else {
      const dx = g.to[0] - g.from[0];
      const dy = g.to[1] - g.from[1];
      if (Math.abs(dy * this.ar) >= Math.abs(dx)) {
        ctx.moveTo(0, g.from[1] * H);
        ctx.lineTo(W, g.from[1] * H);
        ctx.moveTo(0, g.to[1] * H);
        ctx.lineTo(W, g.to[1] * H);
      } else {
        ctx.moveTo(g.from[0] * W, 0);
        ctx.lineTo(g.from[0] * W, H);
        ctx.moveTo(g.to[0] * W, 0);
        ctx.lineTo(g.to[0] * W, H);
      }
    }
    ctx.stroke();
    ctx.restore();
  }

  /** (N1 wave 2, G22) the guides a snapped shape lines up with */
  private drawGuides(ctx: CanvasRenderingContext2D) {
    const W = this.env.W;
    const H = this.env.H;
    ctx.save();
    ctx.strokeStyle = this.cssVar('--ml-color-accent', '#3a47a8');
    ctx.globalAlpha = 0.8;
    ctx.lineWidth = 1 / this.unitPx();
    ctx.setLineDash([3 / this.unitPx(), 3 / this.unitPx()]);
    ctx.beginPath();
    for (const l of this.guides) {
      if (l.axis === 'x') {
        ctx.moveTo(l.at * W, l.from * H);
        ctx.lineTo(l.at * W, l.to * H);
      } else {
        ctx.moveTo(l.from * W, l.at * H);
        ctx.lineTo(l.to * W, l.at * H);
      }
    }
    ctx.stroke();
    ctx.restore();
  }

  /** (N1 wave 2, G22) guides shown by the selection frame while it is dragged (normalized lines; [] hides them) */
  setGuides(lines: SnapLine[]): void {
    this.guides = lines;
    this.scheduleLive();
  }

  /** device px per page unit */
  private unitPx(): number {
    return Math.hypot(this.matrix[0], this.matrix[1]) / this.dpr || 1;
  }

  private cssVar(name: string, fallback: string): string {
    return this.env.css?.getPropertyValue(name).trim() || fallback;
  }

  // ── pointer input ──
  private localPx(e: { clientX: number; clientY: number }): [number, number] {
    const rect = this.layoutRect();
    const view = this.d.getView();
    const { width, height } = viewSize(view);
    const sx = rect.width > 0 ? rect.width / width : 1;
    const sy = rect.height > 0 ? rect.height / height : 1;
    return [(e.clientX - rect.left) / sx, (e.clientY - rect.top) / sy];
  }

  private onPenHover(e: PointerEvent, over: boolean) {
    if (e.pointerType !== 'pen') return;
    this.penHovering = over;
    // a hovering stylus switches the layer to touch-action:none before it touches (fingers still pan
    // once it leaves); not every browser applies a change this late — see CAPABILITY_MATRIX.md
    this.d.root.toggleAttribute('data-pen-near', over && this.isWriting());
  }

  private isOwnUi(e: Event): boolean {
    const t = e.target as Element | null;
    return !!t?.closest?.('[data-ink-ui]');
  }

  private onDown(e: PointerEvent) {
    penProbe.observe(e);
    if (!this.d.getInteractive() || this.isOwnUi(e)) return;
    const tool = this.d.getTool();
    if (!this.isWriting()) return;
    const decision = classifyPointerDown(e, {
      penOnly: tool.penOnly,
      strokeActive: this.gesture !== null,
      sincePenUp: performance.now() - this.lastPenUp,
      palm: tool.palm ? palmPolicy(tool.palm.sensitivity, tool.palm.hand) : undefined,
      lastPen: this.lastPenAt,
    });
    if (decision !== 'write' && decision !== 'erase_with_pen_eraser') {
      const g = this.gesture;
      if (decision === 'ignore_secondary' && g?.kind === 'stroke' && e.pointerType === 'touch' && g.capture.pointerType === 'touch' && g.capture.points.length < 6) {
        // a second finger right after the first: that was a pinch/scroll, not writing
        this.cancelGesture();
      } else if (
        decision === 'ignore_secondary' &&
        e.pointerType === 'touch' &&
        (g?.kind === 'erase_stroke' || g?.kind === 'erase_point' || g?.kind === 'lasso') &&
        this.gestureStart?.type === 'touch' &&
        e.timeStamp - this.gestureStart.t < SECOND_FINGER_MS
      ) {
        // (review of N1 wave 1) the same for a fresh eraser or lasso touch: two fingers together are a pinch, a scroll or
        // the two-finger tap (undo) — the first finger must not erase what it landed on
        this.cancelGesture();
      }
      return;
    }
    e.preventDefault();
    // (N1 wave 2, G07) the eyedropper waits for a tap: read the colour drawn here (nothing is written)
    const pick = this.d.getColorPick?.();
    if (pick) {
      pick(sampleRenderedColor(this.d.root, e.clientX, e.clientY));
      return;
    }
    this.rect = this.d.root.getBoundingClientRect();
    try {
      this.d.root.setPointerCapture(e.pointerId);
    } catch {
      // capture is best effort (synthetic events in tests)
    }
    const effective: InkToolId = decision === 'erase_with_pen_eraser' ? 'eraser_stroke' : tool.tool;
    if (effective !== 'polygon' && this.polygon) this.cancelPolygon(false);
    this.snapTargets = null;
    const iso = this.toIso(e.clientX, e.clientY);
    const local = this.localPx(e);
    const start = (g: Gesture) => {
      this.gesture = g;
      this.gestureStart = { t: e.timeStamp, type: e.pointerType };
      this.d.root.setAttribute('data-ink-active', '');
      this.d.onStrokeActive(true);
    };
    if (e.pointerType === 'pen') this.lastPenAt = { x: e.clientX, y: e.clientY };
    const registered = inkTool(effective);
    if (registered) {
      // (N1 Wave 0) a tool registered by another track handles the press
      const session = registered.pointerDown(this.toolContext(e.pointerType), this.toNorm(e.clientX, e.clientY), e);
      if (!session) return;
      start({ kind: 'tool', pointerId: e.pointerId, session });
    } else if (PEN_TOOLS.has(effective)) {
      const style = newStrokeStyle(effective as InkPenTool | 'pencil', tool);
      const capture = new StrokeCapture(e.pointerType, this.toNorm, this.ar, e);
      // (N1 wave 2, G08) a stroke that starts along the ruler's edge follows it (decided once, here)
      const r = this.d.getRuler?.() ?? null;
      const ruler = r && r.targetKey === this.d.targetKey && style.tool !== 'highlighter' && startsAtEdge(iso, r, this.ar, this.pxToIso(RULER_SNAP_PX)) ? r : null;
      // the page the stroke started on (the layer may be re-targeted before a teardown commit)
      start({ kind: 'stroke', pointerId: e.pointerId, id: newId(), anchor: this.d.getAnchor(), capture, style, predicted: [], holdTimer: undefined, holdAt: [e.clientX, e.clientY], recognized: null, loop: null, ruler });
      if (!ruler) this.armHold();
    } else if (effective === 'eraser_stroke') {
      start({ kind: 'erase_stroke', pointerId: e.pointerId, last: iso, hits: new Map(), cursor: local, foreign: this.startForeignErase(tool) });
      this.eraseStrokeAlong([iso]);
    } else if (effective === 'eraser_point') {
      start({ kind: 'erase_point', pointerId: e.pointerId, last: iso, session: new PointEraseSession(this.ar), wholes: new Map(), cursor: local, foreign: this.startForeignErase(tool) });
      this.erasePointAlong([iso]);
    } else if (effective === 'lasso') {
      start({ kind: 'lasso', pointerId: e.pointerId, points: [this.toNorm(e.clientX, e.clientY)], startClient: [e.clientX, e.clientY], moved: false, rect: tool.lasso?.mode === 'rect' });
    } else if (SHAPE_TOOLS.has(effective)) {
      const n = this.snapped(this.toNorm(e.clientX, e.clientY), e);
      start({ kind: 'shape', pointerId: e.pointerId, shape: effective as DragShape, from: n, to: n, startClient: [e.clientX, e.clientY] });
    } else if (effective === 'polygon') {
      start({ kind: 'polygon_tap', pointerId: e.pointerId, startClient: [e.clientX, e.clientY], moved: false });
    } else if (effective === 'connector') {
      const n = this.toNorm(e.clientX, e.clientY);
      const t = this.attachAt(n, null);
      start({ kind: 'connector', pointerId: e.pointerId, from: t ? t.at : n, fromAttach: t ? { id: t.item.id, side: t.side } : null, to: n, toAttach: null });
    } else if (effective === 'insert_space') {
      const n = this.toNorm(e.clientX, e.clientY);
      start({ kind: 'space', pointerId: e.pointerId, from: n, to: n });
    } else if (effective === 'measure') {
      const n = this.toNorm(e.clientX, e.clientY);
      start({ kind: 'measure', pointerId: e.pointerId, from: n, to: n, startClient: [e.clientX, e.clientY] });
    } else if (effective === 'zoom_window') {
      start({ kind: 'zoom_tap', pointerId: e.pointerId, startClient: [e.clientX, e.clientY], moved: false });
    } else if (effective === 'text' || effective === 'sticky' || effective === 'image') {
      start({ kind: 'tap', pointerId: e.pointerId, tool: effective, startClient: [e.clientX, e.clientY], moved: false });
    } else if (effective === 'link') {
      const n = this.toNorm(e.clientX, e.clientY);
      start({ kind: 'link_box', pointerId: e.pointerId, from: n, to: n, startClient: [e.clientX, e.clientY] });
    } else if (effective === 'laser') {
      start({ kind: 'laser', pointerId: e.pointerId });
      this.laser.push({ x: local[0], y: local[1], t: performance.now() });
    }
    this.d.store.activeTargetKey = this.d.targetKey;
    this.scheduleLive();
  }

  private onMove(e: PointerEvent) {
    const g = this.gesture;
    const coalesced = g && g.pointerId === e.pointerId && typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : null;
    const predicted = g?.kind === 'stroke' && g.pointerId === e.pointerId && typeof e.getPredictedEvents === 'function' ? e.getPredictedEvents() : null;
    penProbe.observe(e, coalesced?.length ?? 1, predicted?.length ?? 0);
    if (!g || g.pointerId !== e.pointerId) return;
    e.preventDefault();
    const samples: PointerEvent[] = coalesced && coalesced.length ? coalesced : [e];
    if (e.pointerType === 'pen') this.lastPenAt = { x: e.clientX, y: e.clientY };
    if (!this.pendingInput) {
      // (review) counted from the OLDEST sample this event carries (the coalesced ones came before the event itself)
      let t = e.timeStamp;
      for (const s of samples) if (s.timeStamp > 0 && s.timeStamp < t) t = s.timeStamp;
      this.pendingInput = { t, type: e.pointerType };
    }
    switch (g.kind) {
      case 'tool':
        g.session.move?.(this.toNorm(e.clientX, e.clientY), e);
        break;
      case 'stroke': {
        let cur = g;
        if (cur.recognized || cur.loop) {
          if (Math.hypot(e.clientX - cur.holdAt[0], e.clientY - cur.holdAt[1]) > HOLD_CANCEL_PX) {
            cur.recognized = null; // moved on: keep writing, the stroke stays ink
            cur.loop = null;
            this.armHold();
          } else break;
        }
        for (const s of samples) {
          if (cur.capture.full) {
            this.splitLongStroke(s); // the new stroke starts with this sample
            cur = this.gesture as typeof cur;
            continue;
          }
          cur.capture.add(s);
        }
        // (P1-T2) e-ink mode: no prediction overlay (every extra repaint costs a slow screen refresh)
        cur.predicted = predicted && !einkMode() ? Array.from(predicted) : [];
        if (Math.hypot(e.clientX - cur.holdAt[0], e.clientY - cur.holdAt[1]) > HOLD_SLOP_PX) {
          cur.holdAt = [e.clientX, e.clientY];
          this.armHold();
        }
        break;
      }
      case 'erase_stroke':
      case 'erase_point': {
        const path: Vec[] = [g.last];
        for (const s of samples) path.push(this.toIso(s.clientX, s.clientY));
        g.last = path[path.length - 1]!;
        g.cursor = this.localPx(e);
        if (g.kind === 'erase_stroke') this.eraseStrokeAlong(path);
        else this.erasePointAlong(path);
        break;
      }
      case 'lasso': {
        if (g.rect) g.points[1] = this.toNorm(e.clientX, e.clientY);
        else for (const s of samples) g.points.push(this.toNorm(s.clientX, s.clientY));
        if (Math.hypot(e.clientX - g.startClient[0], e.clientY - g.startClient[1]) > TAP_PX) g.moved = true;
        break;
      }
      case 'shape':
        g.to = this.snapped(this.toNorm(e.clientX, e.clientY), e);
        break;
      case 'link_box':
      case 'space':
        g.to = this.toNorm(e.clientX, e.clientY);
        break;
      case 'measure':
        g.to = this.toNorm(e.clientX, e.clientY);
        break;
      case 'connector': {
        const n = this.toNorm(e.clientX, e.clientY);
        const t = this.attachAt(n, g.fromAttach?.id ?? null);
        g.to = t ? t.at : n;
        g.toAttach = t ? { id: t.item.id, side: t.side } : null;
        break;
      }
      case 'tap':
      case 'polygon_tap':
      case 'zoom_tap':
        if (Math.hypot(e.clientX - g.startClient[0], e.clientY - g.startClient[1]) > TAP_PX) g.moved = true;
        break;
      case 'laser': {
        const now = performance.now();
        for (const s of samples) {
          const [x, y] = this.localPx(s);
          this.laser.push({ x, y, t: now });
        }
        break;
      }
    }
    this.scheduleLive();
  }

  private onUp(e: PointerEvent, cancelled: boolean) {
    const g = this.gesture;
    if (!g || g.pointerId !== e.pointerId) return;
    if (!cancelled) e.preventDefault();
    if (e.pointerType === 'pen') this.lastPenUp = performance.now();
    this.gesture = null;
    try {
      if (this.d.root.hasPointerCapture?.(e.pointerId)) this.d.root.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    switch (g.kind) {
      case 'tool':
        if (cancelled) g.session.cancel?.();
        else g.session.up?.(this.toNorm(e.clientX, e.clientY), e);
        break;
      case 'stroke':
        clearTimeout(g.holdTimer);
        if (!cancelled && g.loop) {
          // (N1, G14) circle + hold: a lasso selection of what the loop encloses — the loop itself is not ink
          this.d.onGestureSelect?.(g.loop.ids);
          break;
        }
        if (!cancelled) g.capture.end(e);
        // a cancelled stroke is still writing the owner made: keep it (never lose ink)
        this.commitStroke(g, !cancelled);
        break;
      case 'erase_stroke':
        this.finishStrokeErase(g);
        break;
      case 'erase_point':
        this.finishPointErase(g);
        break;
      case 'lasso':
        if (!cancelled) this.finishLasso(g, e);
        break;
      case 'shape': {
        if (!cancelled) {
          const moved = Math.hypot(e.clientX - g.startClient[0], e.clientY - g.startClient[1]) > TAP_PX;
          const item = moved ? this.shapeFromGesture(g, newId()) : null;
          if (item) {
            this.d.store.commit('شكل', [{ id: item.id, targetKey: this.d.targetKey, before: null, after: item }]);
            this.d.onInserted?.([item.id]);
          }
        }
        break;
      }
      case 'tap':
        if (!cancelled && !g.moved) this.d.onTextRequest({ kind: g.tool, at: this.toNorm(e.clientX, e.clientY) });
        break;
      case 'polygon_tap':
        if (!cancelled && !g.moved) this.polygonTap(this.toNorm(e.clientX, e.clientY), e);
        break;
      case 'connector':
        if (!cancelled) {
          // the end is where the pen lifted (a pointerup can land past the last move)
          const n = this.toNorm(e.clientX, e.clientY);
          const t = this.attachAt(n, g.fromAttach?.id ?? null);
          g.to = t ? t.at : n;
          g.toAttach = t ? { id: t.item.id, side: t.side } : null;
          this.finishConnector(g);
        }
        break;
      case 'space':
        if (!cancelled) {
          g.to = this.toNorm(e.clientX, e.clientY);
          this.finishInsertSpace(g);
        }
        break;
      case 'measure':
        if (!cancelled && Math.hypot(e.clientX - g.startClient[0], e.clientY - g.startClient[1]) > TAP_PX) this.d.onMeasureSegment?.(g.from, this.toNorm(e.clientX, e.clientY));
        break;
      case 'zoom_tap':
        if (!cancelled && !g.moved) this.d.onZoomPlace?.(this.toNorm(e.clientX, e.clientY));
        break;
      case 'link_box': {
        if (cancelled) break;
        const moved = Math.hypot(e.clientX - g.startClient[0], e.clientY - g.startClient[1]) > TAP_PX;
        // a tap makes a link of a readable default size around the point
        const box = moved ? linkBoxOf(g.from, this.toNorm(e.clientX, e.clientY)) : linkBoxAround(g.from);
        if (box.w > 0.004 && box.h > 0.004) this.d.onLinkRequest?.({ box });
        break;
      }
      case 'laser':
        break;
    }
    this.rect = null;
    this.guides = [];
    this.snapTargets = null;
    this.d.root.removeAttribute('data-ink-active');
    this.d.onStrokeActive(false);
    this.scheduleLive();
  }

  cancelGesture(): void {
    const g = this.gesture;
    this.guides = [];
    this.snapTargets = null;
    if (!g) return;
    this.gesture = null;
    if (g.kind === 'stroke') clearTimeout(g.holdTimer);
    if (g.kind === 'tool') g.session.cancel?.();
    if (g.kind === 'erase_stroke') this.d.store.setHidden(this.d.targetKey, [...g.hits.keys()], false);
    if (g.kind === 'erase_point') this.d.store.setHidden(this.d.targetKey, [...g.session.originals.keys(), ...g.wholes.keys()], false);
    this.rect = null;
    this.d.root.removeAttribute('data-ink-active');
    this.d.onStrokeActive(false);
    this.scheduleLive();
  }

  // ── strokes ──
  private armHold() {
    const g = this.gesture;
    if (!g || g.kind !== 'stroke') return;
    clearTimeout(g.holdTimer);
    const tool = this.d.getTool();
    const circleLasso = tool.gestures?.circle_lasso === true;
    if ((!tool.shapeRecognition && !circleLasso) || g.style.tool === 'highlighter') return;
    g.holdTimer = window.setTimeout(() => {
      const cur = this.gesture;
      if (cur !== g || g.capture.points.length < 4) return;
      // (N1, G14) a closed loop held still around writing: select what it encloses (before shape recognition, which
      // would turn the loop into an ellipse); an empty loop stays a shape / ink
      if (circleLasso) {
        const poly = closedLoop(g.capture.points, this.ar);
        const ids = poly ? this.enclosed(poly, tool) : [];
        if (poly && ids.length) {
          g.loop = { poly, ids };
          this.scheduleLive();
          return;
        }
      }
      if (!tool.shapeRecognition) return;
      const shape = recognizeShape(g.capture.points, this.ar);
      if (shape) {
        g.recognized = shape;
        this.scheduleLive();
      }
    }, HOLD_MS);
  }

  /** A stroke longer than the server limit continues as a new stroke (nothing is truncated). */
  private splitLongStroke(s: InputSample) {
    const g = this.gesture;
    if (!g || g.kind !== 'stroke') return;
    clearTimeout(g.holdTimer);
    this.commitStroke(g);
    const capture = new StrokeCapture(g.capture.pointerType, this.toNorm, this.ar, s);
    this.gesture = { ...g, id: newId(), capture, predicted: [], recognized: null, loop: null, holdTimer: undefined };
  }


  /** Selectable, visible items (the lasso filter applied) that a loop (normalized polygon) encloses. */
  private enclosed(poly: Vec[], tool: InkToolState): string[] {
    const store = this.d.store;
    const ids: string[] = [];
    for (const it of store.query(this.d.targetKey, bboxOf(poly))) {
      if (!store.isVisible(it) || !isSelectable(it) || !lassoAllows(it, tool.lasso?.types)) continue;
      const samples = lassoSamplePoints(it, this.ar);
      const inside = isBoxItem(it) || isSticky(it) ? samples.every((p) => pointInPolygon(p, poly)) : fractionInside(samples, poly) >= 0.5;
      if (inside) ids.push(it.id);
    }
    return ids;
  }

  /** What a registered tool's press can use (N1 Wave 0). */
  private toolContext(pointerType: string) {
    return {
      store: this.d.store,
      targetKey: this.d.targetKey,
      anchor: this.d.getAnchor(),
      ar: this.ar,
      pointerType,
      toNorm: (x: number, y: number) => this.toNorm(x, y),
      pxToIso: (px: number) => this.pxToIso(px),
      nextZ: () => this.d.store.nextZ(this.d.targetKey),
      commit: (label: string, changes: Array<{ id: string; targetKey: string; before: InkItem | null; after: InkItem | null }>) => this.d.store.commit(label, changes),
      requestLive: () => this.scheduleLive(),
      announce: (m: string) => this.d.announce?.(m),
    };
  }

  private commitStroke(g: Extract<Gesture, { kind: 'stroke' }>, gestures = false) {
    const anchor = g.anchor;
    const now = Date.now();
    const z = this.d.store.nextZ(this.d.targetKey);
    const raw = g.capture.finalPoints();
    if (raw.length === 0) return;
    // (N1 wave 2, G08) along the ruler: the owner's samples moved onto its edge (time and pressure kept)
    const points = g.ruler ? snapPointsToRuler(raw, g.ruler, this.ar) : raw;
    const ink = makeInkItem({
      id: g.id,
      anchor,
      now,
      z,
      style: g.style,
      points,
      pressureAvailable: g.capture.pressureAvailable,
      tiltAvailable: g.capture.tiltAvailable,
      pointerType: g.capture.pointerType,
    });
    // (track F4) written while an in-app recording runs → automatic time link (t of the last sample = stroke length)
    const link = audioLinkAt(now - (points[points.length - 1]?.[2] ?? 0));
    if (link) ink.data.audio_link = link;
    if (g.recognized) {
      const shape = makeShapeItem({
        id: g.id,
        anchor,
        now,
        z,
        shape: g.recognized.shape,
        from: g.recognized.from,
        to: g.recognized.to,
        rotation: g.recognized.rotation,
        style: g.style,
        recognizedFrom: ink.data,
        pointerType: g.capture.pointerType,
      });
      // (track F4) a shape drawn while recording keeps the stroke's time link on the item itself (where the lasso and
      // the server look for it), not only inside the kept original stroke
      if (link) (shape.data as { audio_link?: typeof link }).audio_link = link;
      this.d.store.commit('تحسين شكل', [{ id: shape.id, targetKey: this.d.targetKey, before: null, after: shape }]);
      return;
    }
    this.d.store.commit('كتابة', [{ id: ink.id, targetKey: this.d.targetKey, before: null, after: ink }]);
    // (N1, G14) scribble to erase: looked at only now that the stroke is committed, off the pointer path
    if (gestures && ink.data.style.tool !== 'highlighter' && this.d.getTool().gestures?.scribble_erase === true && ink.data.points.length >= 8) {
      const targetKey = this.d.targetKey;
      setTimeout(() => this.checkScribble(ink, targetKey), 0);
    }
  }

  /**
   * (N1, G14) The stroke just committed was a scribble over writing: it erases the strokes it covers and itself, in the
   * same undo step as the stroke («مسح بالخربشة»). Anything else that happened meanwhile (an undo, another stroke)
   * leaves everything as it is.
   */
  checkScribble(ink: InkItem & { data: InkData }, targetKey: string): number {
    const store = this.d.store;
    const top = store.history.peekUndo();
    if (!top || top.changes.length !== 1 || top.changes[0]!.id !== ink.id || store.item(targetKey, ink.id) !== top.changes[0]!.after) return 0;
    const page = store.page(targetKey);
    if (!page) return 0;
    const ar = page.ar;
    const shape = detectScribble(ink.data.points, ar);
    if (!shape) return 0;
    const types = this.d.getTool().eraserTypes;
    const pad = shape.swing * 0.2;
    const cands = store
      .query(targetKey, expandBox(shape.box, pad, pad / ar))
      .filter((it) => it.id !== ink.id && !it.locked && store.isVisible(it) && store.isEditable(it) && (isInkStroke(it) || isShape(it)) && eraserAllows(it, types))
      .map((it) => ({ it, c: { id: it.id, box: itemBBox(it, ar), touched: itemHitByPath(it, shape.path, 0, ar), outline: outlineOf(it, ar) } }));
    const ids = scribbleTargets(shape, cands.map((x) => x.c), ar);
    if (ids.length === 0) return 0;
    const byId = new Map(cands.map((x) => [x.it.id, x.it]));
    store.commit(
      'مسح بالخربشة',
      [{ id: ink.id, targetKey, before: ink, after: null }, ...ids.map((id) => ({ id, targetKey, before: byId.get(id)!, after: null }))],
      { amend: true },
    );
    this.d.announce?.(`${scribbleErasedAr(ids.length)} — يمكنك التراجع.`);
    return ids.length;
  }

  private shapeFromGesture(g: Extract<Gesture, { kind: 'shape' }>, id: string): InkItem | null {
    const tool = this.d.getTool();
    const [a, b] = [g.from, g.to];
    if (Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6) return null;
    const box = BOX_DRAG.has(g.shape);
    const from: Vec = box ? [Math.min(a[0], b[0]), Math.min(a[1], b[1])] : a;
    const to: Vec = box ? [Math.max(a[0], b[0]), Math.max(a[1], b[1])] : b;
    return makeShapeItem({ id, anchor: this.d.getAnchor(), now: Date.now(), z: this.d.store.nextZ(this.d.targetKey), shape: g.shape, from, to, style: shapeStyle(tool), extra: shapeExtra(g.shape, from, to, tool, this.ar) });
  }

  // ── (N1 wave 2) snapping, polygons, connectors, insert space ──
  /** G22: a point of a shape being drawn, snapped to the page's guides (Alt held: as it is) */
  private snapped(n: [number, number], e: { altKey?: boolean }): [number, number] {
    const snap = this.d.getTool().snap;
    // (review of N1 wave 2) the page's snap lines are collected ONCE per shape (at its first point), never per move
    // (and again, at most every 200 ms, while the page's processed regions are still loading)
    const stale = !this.snapTargets || (this.snapTargets.t?.partial === true && performance.now() - this.snapTargets.at > 200);
    if (!e.altKey && snap?.enabled !== false && stale) this.snapTargets = { t: this.d.getSnapTargets?.() ?? null, at: performance.now() };
    const targets = !e.altKey && snap?.enabled !== false ? (this.snapTargets?.t ?? null) : null;
    if (!targets) {
      this.guides = [];
      return n;
    }
    const tol = this.pxToIso(SNAP_PX);
    const r = snapPoint(n, targets, { x: tol, y: tol / this.ar });
    this.guides = r.guides;
    return r.at;
  }

  /** G21: the closed shape (visible, editable) a connector end at `n` attaches to, with its nearest edge point */
  private attachAt(n: [number, number], exclude: string | null) {
    const store = this.d.store;
    const r = this.pxToIso(CONNECT_PX);
    const cands = store
      .query(this.d.targetKey, expandBox({ x: n[0], y: n[1], w: 0, h: 0 }, r + 0.2, (r + 0.2) / this.ar))
      .filter((it) => isShape(it) && store.isVisible(it))
      .sort(paintOrder);
    return attachTarget(cands, n, this.ar, r, exclude ?? undefined);
  }

  /** G20: one tap of the polygon tool: a corner, or (near the first corner / a quick second tap) the end of the polygon */
  private polygonTap(n: [number, number], e: PointerEvent) {
    const now = e.timeStamp;
    const pg = this.polygon;
    if (pg && pg.pts.length >= 3) {
      const first = pg.pts[0]!;
      const last = pg.pts[pg.pts.length - 1]!;
      const nearFirst = Math.hypot(first[0] - n[0], (first[1] - n[1]) * this.ar) <= this.pxToIso(POLYGON_CLOSE_PX);
      const doubleTap = now - pg.lastTap < 350 && Math.hypot(last[0] - n[0], (last[1] - n[1]) * this.ar) <= this.pxToIso(POLYGON_CLOSE_PX);
      if (nearFirst || doubleTap) {
        this.finishPolygon();
        return;
      }
    }
    if (pg && pg.pts.length >= 64) {
      this.finishPolygon();
      return;
    }
    if (pg) {
      pg.pts.push(n);
      pg.lastTap = now;
    } else this.polygon = { pts: [n], lastTap: now };
    const k = this.polygon!.pts.length;
    this.d.announce?.(k === 1 ? 'بدأ المضلّع: المس الزاوية التالية. المس الزاوية الأولى أو اضغط Enter لإغلاقه، وEscape لإلغائه.' : `الزاوية ${k.toLocaleString('ar-EG')}`);
    this.scheduleLive();
  }

  /** Closes the polygon being tapped (three corners at least) as one shape — one undo step. */
  finishPolygon(): boolean {
    const pg = this.polygon;
    this.polygon = null;
    this.scheduleLive();
    if (!pg || pg.pts.length < 3) {
      if (pg) this.d.announce?.('المضلّع يحتاج ثلاث زوايا على الأقل؛ لم يُرسم شيء.');
      return false;
    }
    const tool = this.d.getTool();
    const bb = bboxOf(pg.pts);
    const item = makeShapeItem({
      id: newId(),
      anchor: this.d.getAnchor(),
      now: Date.now(),
      z: this.d.store.nextZ(this.d.targetKey),
      shape: 'polygon',
      from: [bb.x, bb.y],
      to: [bb.x + bb.w, bb.y + bb.h],
      style: shapeStyle(tool),
      extra: { points: pg.pts, ...(tool.shapeOptions?.fill ? { fill: tool.shapeOptions.fill } : {}) },
    });
    this.d.store.commit('مضلّع', [{ id: item.id, targetKey: this.d.targetKey, before: null, after: item }]);
    this.d.store.activeTargetKey = this.d.targetKey;
    this.d.announce?.(`رُسم مضلّع من ${pg.pts.length.toLocaleString('ar-EG')} زوايا.`);
    this.d.onInserted?.([item.id]);
    return true;
  }

  cancelPolygon(announce: boolean): void {
    if (!this.polygon) return;
    this.polygon = null;
    this.scheduleLive();
    if (announce) this.d.announce?.('أُلغي المضلّع؛ لم يُرسم شيء.');
  }

  /** G21: the connector drawn from a shape's edge (or a free point) to another shape's edge (or a free point) */
  private finishConnector(g: Extract<Gesture, { kind: 'connector' }>) {
    const len = Math.hypot(g.to[0] - g.from[0], (g.to[1] - g.from[1]) * this.ar);
    if (len < this.pxToIso(TAP_PX)) return;
    const tool = this.d.getTool();
    const opts = tool.shapeOptions;
    const attach: NonNullable<ShapeData['attach']> = {};
    if (g.fromAttach) attach.from = g.fromAttach;
    if (g.toAttach) attach.to = g.toAttach;
    const extra: Partial<ShapeData> = {};
    if (attach.from || attach.to) extra.attach = attach;
    if (opts?.route && opts.route !== 'straight') extra.route = opts.route;
    if (opts?.head) extra.head = opts.head;
    const item = makeShapeItem({ id: newId(), anchor: this.d.getAnchor(), now: Date.now(), z: this.d.store.nextZ(this.d.targetKey), shape: 'arrow', from: g.from, to: g.to, style: shapeStyle(tool), extra });
    this.d.store.commit('موصِّل', [{ id: item.id, targetKey: this.d.targetKey, before: null, after: item }]);
    const name = (id: string) => {
      const it = this.d.store.item(this.d.targetKey, id);
      return it && isShape(it) ? nodeName(it.data) : null;
    };
    this.d.announce?.(`موصِّل: ${connectorSentence(item.data as ShapeData, name)}.`);
    this.d.onInserted?.([item.id]);
  }

  /** G10: «أفسح مكانًا» — everything after the line moves by the distance dragged, in one undo step */
  private finishInsertSpace(g: Extract<Gesture, { kind: 'space' }>) {
    const dx = g.to[0] - g.from[0];
    const dy = g.to[1] - g.from[1];
    const vertical = Math.abs(dy * this.ar) >= Math.abs(dx);
    if (Math.hypot(dx, dy * this.ar) < this.pxToIso(TAP_PX)) return;
    if (vertical && dy < 0) {
      this.d.announce?.('اسحب إلى الأسفل لإفساح مكان تحت السطر (أو إلى الجانب بين الكلمات). لم يتحرك شيء.');
      return;
    }
    const store = this.d.store;
    const movable = (it: InkItem) => isEngineItem(it) && !it.locked && store.isVisible(it) && store.isEditable(it);
    const items = store.items(this.d.targetKey);
    // (review of N1 wave 2) sideways: only the written line pressed makes room, never the other lines of the page
    const band = vertical ? undefined : lineBandAt(items.filter(movable), g.from[1], this.ar, this.pxToIso(TAP_PX) / this.ar);
    const plan = insertSpacePlan(items, {
      axis: vertical ? 'y' : 'x',
      at: vertical ? g.from[1] : g.from[0],
      delta: vertical ? dy : dx,
      targetKey: this.d.targetKey,
      ar: this.ar,
      now: Date.now(),
      movable,
      band,
    });
    const edge = vertical ? 'أسفل الصفحة' : 'طرف الصفحة';
    if (plan.changes.length === 0) {
      this.d.announce?.(plan.limited ? `لا مكان: الكتابة بعد هذا الخط بلغت ${edge}، فلم يتحرك شيء (لا يُدفع شيء خارج الصفحة). انقل بعضها إلى صفحة أخرى أولًا.` : vertical ? 'لا توجد كتابة بعد هذا الخط لتحريكها.' : 'لا توجد كتابة بعد هذه النقطة على هذا السطر لتحريكها.');
      return;
    }
    store.commit('أفسح مكانًا', plan.changes);
    const notes = [
      plan.crossing ? `بقي ${plan.crossing.toLocaleString('ar-EG')} عنصر يقطع الخط في مكانه` : '',
      plan.limited ? `أُفسح ما بقي من مكان فقط: بلغت الكتابة ${edge} (لا يُدفع شيء خارج الصفحة)` : '',
    ].filter(Boolean);
    this.d.announce?.(`أُفسح مكان: تحرك ${plan.changes.length.toLocaleString('ar-EG')} عنصر. الحبر المطبوع في الملف لا يتحرك.${notes.length ? ` ${notes.join('، ')}.` : ''} يمكنك التراجع.`);
  }

  // ── erasers ──
  private candidatesAlong(path: readonly Vec[], radiusIso: number): InkItem[] {
    const ar = this.ar;
    const b = bboxOf(path.map((p) => [p[0], p[1] / ar]));
    const pad = radiusIso + 0.06;
    const store = this.d.store;
    const types = this.d.getTool().eraserTypes;
    // (P1-T2, R5) the eraser only touches visible items the owner may edit (never a followed / read-only layer's);
    // (N1, G15) and only the types its filter lets through
    return store.query(this.d.targetKey, expandBox(b, pad, pad / ar)).filter((it) => !it.locked && eraserAllows(it, types) && store.isVisible(it) && store.isEditable(it));
  }

  /** (N1, G15) when the eraser may remove text highlights, read this page's from storage (the reader holds them). */
  private startForeignErase(tool: InkToolState): ForeignErase | null {
    if (!tool.eraserTypes?.text_highlight) return null;
    const f: ForeignErase = { items: null, path: [] };
    void this.d.store.loadForeignItems(this.d.targetKey, 'text_highlight').then((items) => {
      const store = this.d.store;
      f.items = items.filter((it) => !it.locked && store.isVisible(it) && store.isEditable(it));
      const g = this.gesture;
      if (g && (g.kind === 'erase_stroke' || g.kind === 'erase_point') && g.foreign === f && f.path.length) this.eraseForeign(g, f.path);
    });
    return f;
  }

  /** Text highlights crossed by the eraser path become whole hits (never cut into pieces). */
  private eraseForeign(g: Extract<Gesture, { kind: 'erase_stroke' | 'erase_point' }>, path: Vec[]) {
    const f = g.foreign;
    if (!f) return;
    if (!f.items) {
      for (const p of path) f.path.push(p);
      return;
    }
    const r = this.pxToIso(g.kind === 'erase_stroke' ? STROKE_ERASER_PX : POINT_ERASER_PX);
    const into = g.kind === 'erase_stroke' ? g.hits : g.wholes;
    for (const it of f.items) {
      if (into.has(it.id)) continue;
      if (itemHitByPath(it, path, r, this.ar)) into.set(it.id, it);
    }
  }

  private eraseStrokeAlong(path: Vec[]) {
    const g = this.gesture;
    if (!g || g.kind !== 'erase_stroke') return;
    const r = this.pxToIso(STROKE_ERASER_PX);
    const newly: string[] = [];
    for (const it of this.candidatesAlong(path, r)) {
      if (g.hits.has(it.id) || this.d.store.isHidden(it.id)) continue;
      if (itemHitByPath(it, path, r, this.ar)) {
        g.hits.set(it.id, it);
        newly.push(it.id);
      }
    }
    if (newly.length) this.d.store.setHidden(this.d.targetKey, newly, true);
    this.eraseForeign(g, path);
  }

  private erasePointAlong(path: Vec[]) {
    const g = this.gesture;
    if (!g || g.kind !== 'erase_point') return;
    const r = this.pxToIso(POINT_ERASER_PX);
    const candidates = this.candidatesAlong(path, r).filter((it) => !g.wholes.has(it.id));
    const inks = candidates.filter(isInkStroke);
    const changed = g.session.apply(inks, path, r);
    const wholes: string[] = [];
    for (const it of candidates) {
      if (isShape(it) && itemHitByPath(it, path, r, this.ar)) {
        g.wholes.set(it.id, it);
        wholes.push(it.id);
      }
    }
    const hide = [...changed, ...wholes].filter((id) => !this.d.store.isHidden(id));
    if (hide.length) this.d.store.setHidden(this.d.targetKey, hide, true);
    this.eraseForeign(g, path);
  }

  private finishStrokeErase(g: Extract<Gesture, { kind: 'erase_stroke' }>) {
    const ids = [...g.hits.keys()];
    if (ids.length === 0) return;
    this.d.store.commit(
      'محو',
      [...g.hits.values()].map((it) => ({ id: it.id, targetKey: this.d.targetKey, before: it, after: null })),
    );
    this.d.store.setHidden(this.d.targetKey, ids, false);
  }

  private finishPointErase(g: Extract<Gesture, { kind: 'erase_point' }>) {
    const now = Date.now();
    const changes: Array<{ id: string; targetKey: string; before: InkItem | null; after: InkItem | null }> = [];
    for (const [id, orig] of g.session.originals) {
      if (!isInkStroke(orig)) continue;
      changes.push({ id, targetKey: this.d.targetKey, before: orig, after: null });
      for (const run of g.session.pieces.get(id) ?? []) {
        const piece = makeInkItem({
          id: newId(),
          anchor: orig.anchor,
          now,
          z: orig.z,
          style: orig.data.style,
          points: run,
          pressureAvailable: orig.data.pressure_available,
          tiltAvailable: orig.data.tilt_available,
          pointerType: orig.input?.pointer_type ?? 'unknown',
        });
        // (P1-T2) the pieces stay on the original's layer
        piece.layer_id = orig.layer_id ?? null;
        // (track F4) the pieces are the same writing: they keep its time link
        if (orig.data.audio_link) piece.data.audio_link = orig.data.audio_link;
        changes.push({ id: piece.id, targetKey: this.d.targetKey, before: null, after: { ...piece, input: orig.input } });
      }
    }
    for (const [id, it] of g.wholes) changes.push({ id, targetKey: this.d.targetKey, before: it, after: null });
    if (changes.length) this.d.store.commit('محو جزئي', changes);
    this.d.store.setHidden(this.d.targetKey, [...g.session.originals.keys(), ...g.wholes.keys()], false);
  }

  // ── lasso ──
  private finishLasso(g: Extract<Gesture, { kind: 'lasso' }>, e: PointerEvent) {
    const store = this.d.store;
    const ar = this.ar;
    if (g.rect) g.points[1] = this.toNorm(e.clientX, e.clientY);
    if (!g.moved || (!g.rect && g.points.length < 3)) {
      const hit = this.hitTest(this.toNorm(e.clientX, e.clientY));
      store.setSelection(hit ? { targetKey: this.d.targetKey, ids: [hit.id] } : null);
      return;
    }
    // (N1, G17) a rectangle, or the freehand loop; only the types the lasso chips let through
    const poly = g.rect ? rectPoly(g.points[0]!, g.points[g.points.length - 1]!) : g.points;
    const types = this.d.getTool().lasso?.types;
    const box = bboxOf(poly);
    const ids: string[] = [];
    for (const it of store.query(this.d.targetKey, box)) {
      // (P1-T2) a hidden layer's items are not selected; read-only ones are (they can be copied, never moved)
      if (!store.isVisible(it) || !isSelectable(it) || !lassoAllows(it, types)) continue;
      const samples = lassoSamplePoints(it, ar);
      const inside = isBoxItem(it) || isSticky(it) ? samples.every((p) => pointInPolygon(p, poly)) : fractionInside(samples, poly) >= 0.5;
      if (inside) ids.push(it.id);
    }
    store.setSelection(ids.length ? { targetKey: this.d.targetKey, ids } : null);
  }

  /** Topmost item under a normalized point (tap selection). */
  hitTest(n: [number, number]): InkItem | null {
    const ar = this.ar;
    const r = this.pxToIso(SELECT_TAP_PX);
    const iso: Vec = [n[0], n[1] * ar];
    const store = this.d.store;
    const types = this.d.getTool().lasso?.types;
    const cands = store
      .query(this.d.targetKey, expandBox({ x: n[0], y: n[1], w: 0, h: 0 }, r, r / ar))
      .filter((it) => store.isVisible(it) && isSelectable(it) && lassoAllows(it, types))
      .sort(paintOrder)
      .reverse();
    for (const it of cands) {
      const geo = itemGeometry(it, ar);
      if (geo.area && pointInPolygon(iso, geo.area)) return it;
      if ((isTextBox(it) && !it.data.rotation && boxContains(it.data.box, n[0], n[1])) || itemHitByPath(it, [iso], r, ar)) return it;
    }
    return null;
  }
}

/**
 * (review of N1 wave 1) An item as a closed outline (iso polygon) — a stroke that closes on itself, a rectangle or an
 * ellipse — so that shading or filling inside it is never taken for a scratch-out of it; undefined otherwise.
 */
function outlineOf(it: InkItem, ar: number): Vec[] | undefined {
  if (isInkStroke(it)) return closedOutline(it.data.points, ar) ?? undefined;
  if (isShape(it) && (it.data.shape === 'rect' || it.data.shape === 'ellipse')) return itemGeometry(it, ar).lines[0];
  return undefined;
}

/** (N1) the style of a new stroke: colour, width, the colour slot's meaning (G03), the pen feel (G01), (N1 wave 2) the
 * line pattern (G04) and the pencil's graphite (G06 — stored as a pen stroke, so an older app draws it as a pen line) */
export function newStrokeStyle(penTool: InkPenTool | 'pencil', tool: InkToolState): InkStyle {
  const style: InkStyle = { tool: penTool === 'pencil' ? 'pen' : penTool, color: tool.color, width: tool.width };
  if (tool.meaning) style.meaning = tool.meaning;
  const f = tool.feel;
  if (f) {
    if (typeof f.smoothing === 'number') style.smoothing = f.smoothing;
    if (typeof f.pressure_floor === 'number' && f.pressure_floor > 0) style.pressure_floor = f.pressure_floor;
    if (f.taper && f.taper !== 'none') style.taper = f.taper;
    if (f.constant) style.constant = true;
  }
  if (tool.dash && penTool !== 'highlighter') style.dash = tool.dash;
  if (penTool === 'pencil') style.texture = 'graphite';
  return style;
}

/** (N1 wave 2) the outline style of a new shape: colour, width, line pattern and the slot's meaning */
export function shapeStyle(tool: InkToolState): InkStyle {
  return { tool: 'pen', color: tool.color, width: tool.width, ...(tool.dash ? { dash: tool.dash } : {}), ...(tool.meaning ? { meaning: tool.meaning } : {}) };
}

/** (N1 wave 2, G20) the options a new shape gets from the shape tool's options: pathway head, fill, rounded corners */
export function shapeExtra(shape: string, from: Vec, to: Vec, tool: InkToolState, ar: number): Partial<ShapeData> {
  const o = tool.shapeOptions;
  if (!o) return {};
  const out: Partial<ShapeData> = {};
  if (o.head && (shape === 'arrow' || shape === 'curved_arrow' || shape === 'double_arrow')) out.head = o.head;
  if (o.fill && BOX_DRAG.has(shape)) out.fill = o.fill;
  if (o.corner && shape === 'rect') {
    const r = Math.min(Math.abs(to[0] - from[0]), Math.abs(to[1] - from[1]) * ar) * 0.22;
    if (r > 1e-4) out.corner = Math.min(0.2, r);
  }
  return out;
}

/** (N1, G17) The rectangle between two corners as a closed polygon (normalized). */
export function rectPoly(a: Vec, b: Vec): Vec[] {
  const x0 = Math.min(a[0], b[0]);
  const x1 = Math.max(a[0], b[0]);
  const y0 = Math.min(a[1], b[1]);
  const y1 = Math.max(a[1], b[1]);
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
}

/** «مُسح خط واحد» / «مُسح خطان» / «مُسح ٣ خطوط» … (the strokes a scribble erased) */
export function scribbleErasedAr(n: number): string {
  if (n === 1) return 'مُسح خط واحد بالخربشة';
  if (n === 2) return 'مُسح خطان بالخربشة';
  return n <= 10 ? `مُسح ${n.toLocaleString('ar-EG')} خطوط بالخربشة` : `مُسح ${n.toLocaleString('ar-EG')} خطًا بالخربشة`;
}

/** The normalized box between two corners, inside the page. */
export function linkBoxOf(a: Vec, b: Vec): NormBox {
  const x0 = Math.max(0, Math.min(a[0], b[0]));
  const y0 = Math.max(0, Math.min(a[1], b[1]));
  const x1 = Math.min(1, Math.max(a[0], b[0]));
  const y1 = Math.min(1, Math.max(a[1], b[1]));
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

/** A tap with the link tool: a box of a comfortable size centred on the point (inside the page). */
export function linkBoxAround(p: Vec, w = 0.22, h = 0.04): NormBox {
  return { x: Math.min(Math.max(0, p[0] - w / 2), 1 - w), y: Math.min(Math.max(0, p[1] - h / 2), 1 - h), w, h };
}

const LIVE_BASE = {
  id: 'live',
  kind: 'ink',
  tool: null,
  anchor: { type: 'note_page', note_page_id: 'live', space: 'page_norm' },
  layer: 'ink',
  z: 0,
  locked: false,
  anchor_status: 'ok',
  previous_anchor: null,
  input: null,
  device_id: null,
  rev: 0,
  created_at: 0,
  updated_at: 0,
  deleted_at: null,
} as const;

function safeContext(c: HTMLCanvasElement, desynchronized = false): CanvasRenderingContext2D | null {
  try {
    return (desynchronized ? c.getContext('2d', { desynchronized: true }) : c.getContext('2d')) as CanvasRenderingContext2D | null;
  } catch {
    return null;
  }
}
