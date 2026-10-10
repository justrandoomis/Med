// Imperative controller of one page's ink layer: Pointer Events in, canvases out.
//
// Performance rules (spec §55; React best practices "use refs for transient values"):
//  * no React state is touched during a stroke; pointer samples go to refs and draw in a
//    requestAnimationFrame callback (one paint per display frame)
//  * getCoalescedEvents() for every sample the digitizer produced; getPredictedEvents() drawn ONLY
//    on the live layer, never saved
//  * committed strokes are redrawn only inside dirty rectangles found through the spatial index
//  * writing never waits for storage or network: commit = in-memory update + queued IndexedDB write
import { newId, viewSize, viewToNorm, type AnnotationAnchor, type InkData, type InkPenTool, type NormBox } from '@medlevo/shared';
import { penProbe } from './capabilities';
import { itemHitByPath, PointEraseSession } from './eraser';
import { classifyPointerDown, StrokeCapture, type InputSample } from './input';
import { bboxOf, boxContains, expandBox, fractionInside, pointInPolygon, unionBox, type Mat, type Vec } from './math';
import { isBoxItem, isInkStroke, isShape, isSticky, isTextBox, itemBBox, itemGeometry, lassoSamplePoints, makeInkItem, makeShapeItem, transformItem, type InkItem } from './model';
import { LASER_COLOR, resolveInkColor } from './palette';
import { canvasScale, deviceRectOf, drawItem, HIGHLIGHT_ALPHA, HIGHLIGHT_ALPHA_ISOLATED, highlightBlendIsolated, pageMatrix, paintOrder, paperToneOf, setMatrix, type RenderEnv } from './render';
import { recognizeShape, type RecognizedShape } from './shapes';
import type { InkDocumentStore, PageEvent } from './store';
import type { InkPageView, InkToolId, InkToolState } from './types';

const PEN_TOOLS: ReadonlySet<InkToolId> = new Set(['pen', 'fountain', 'ball', 'highlighter']);
const SHAPE_TOOLS: ReadonlySet<InkToolId> = new Set(['line', 'arrow', 'rect', 'ellipse']);
const HOLD_MS = 600;
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
}

type Gesture =
  | { kind: 'stroke'; pointerId: number; id: string; anchor: AnnotationAnchor; capture: StrokeCapture; style: InkData['style']; predicted: InputSample[]; holdTimer: number | undefined; holdAt: [number, number]; recognized: RecognizedShape | null }
  | { kind: 'erase_stroke'; pointerId: number; last: Vec; hits: Map<string, InkItem>; cursor: [number, number] }
  | { kind: 'erase_point'; pointerId: number; last: Vec; session: PointEraseSession; wholes: Map<string, InkItem>; cursor: [number, number] }
  | { kind: 'lasso'; pointerId: number; points: Vec[]; startClient: [number, number]; moved: boolean }
  | { kind: 'shape'; pointerId: number; shape: 'line' | 'arrow' | 'rect' | 'ellipse'; from: Vec; to: Vec; startClient: [number, number] }
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

  constructor(private readonly d: LayerDeps) {
    this.hlCtx = safeContext(d.highlightCanvas);
    this.inkCtx = safeContext(d.inkCanvas);
    this.liveCtx = safeContext(d.liveCanvas, true);
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
    const unsub = d.store.subscribePage(d.targetKey, (e) => this.onPageEvent(e));
    this.disposers.push(unsub);
    // theme / paper tone changes → full redraw (colour tokens resolve per tone)
    const mo = new MutationObserver(() => this.refreshEnv(true));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
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
    const changed = tone !== this.env.tone || isolated !== (this.env.highlightAlpha === HIGHLIGHT_ALPHA_ISOLATED) || view.pageWidth !== this.env.W || view.pageHeight !== this.env.H;
    this.env = { W: view.pageWidth, H: view.pageHeight, tone, css, highlightAlpha: isolated ? HIGHLIGHT_ALPHA_ISOLATED : HIGHLIGHT_ALPHA };
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
    if (e.kind === 'items') this.invalidate(e.dirty);
    else if (e.kind === 'hidden') {
      const boxes: NormBox[] = [];
      for (const id of e.ids) {
        const b = this.d.store.page(this.d.targetKey)?.index.box(id);
        if (b) boxes.push(b);
      }
      this.invalidate(boxes);
      this.scheduleLive();
    } else if (e.kind === 'loaded') this.invalidate('all');
    else if (e.kind === 'selection') this.d.onSelectionChanged?.();
  }

  invalidate(dirty: NormBox[] | 'all'): void {
    if (dirty === 'all' || this.pendingDirty === 'all') this.pendingDirty = 'all';
    else this.pendingDirty = [...(this.pendingDirty ?? []), ...dirty];
    if (!this.commitFrame) this.commitFrame = requestAnimationFrame(() => this.paintCommitted());
  }

  /** Synchronous repaint (tests / after resize). */
  paintCommitted(): void {
    this.commitFrame = 0;
    let dirty = this.pendingDirty;
    this.pendingDirty = null;
    if (!dirty || !this.inkCtx || !this.hlCtx) return;
    // the page under the layer may have changed (e.g. the PDF bitmap replaced a placeholder)
    if (this.refreshEnv(false)) dirty = 'all';
    const view = this.d.getView();
    const page = this.d.store.page(this.d.targetKey);
    if (!page) return;
    const cw = this.d.inkCanvas.width;
    const ch = this.d.inkCanvas.height;
    let items: InkItem[];
    let clip: Array<{ x: number; y: number; w: number; h: number }> | null = null;
    if (dirty === 'all') items = [...page.items.values()];
    else {
      if (dirty.length === 0) return;
      clip = dirty.map((b) => deviceRectOf(b, view, this.matrix, 3));
      const area = clip.reduce((s, r) => s + r.w * r.h, 0);
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
    items = items.filter((it) => !this.d.store.isHidden(it.id) && (isInkStroke(it) || isShape(it))).sort(paintOrder);
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
    const ctx = this.liveCtx;
    if (!ctx) return;
    const c = this.d.liveCanvas;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    const g = this.gesture;
    let highlight = false;
    setMatrix(ctx, this.matrix);
    if (g?.kind === 'stroke') {
      if (g.recognized) {
        const item = makeShapeItem({ id: 'live', anchor: this.d.getAnchor(), now: 0, z: 0, shape: g.recognized.shape, from: g.recognized.from, to: g.recognized.to, rotation: g.recognized.rotation, style: { ...g.style, tool: g.style.tool === 'highlighter' ? 'pen' : g.style.tool } });
        drawItem(ctx, item, this.env);
      } else {
        const pts = g.capture.points.slice();
        for (const p of g.predicted) {
          const [x, y] = this.toNorm(p.clientX, p.clientY);
          pts.push([x, y, 0, p.pressure]);
        }
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
    }
    if (this.transformPreview) {
      for (const it of this.d.store.selectedItems()) {
        const moved = transformItem(it, this.transformPreview, this.ar, 0);
        if (isInkStroke(moved) || isShape(moved)) drawItem(ctx, moved, this.env);
        else if (isBoxItem(moved) || isSticky(moved)) this.outline(ctx, itemBBox(moved, this.ar));
      }
    }
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
    if (g?.kind === 'lasso' && g.points.length > 1) {
      ctx.setLineDash([6 * this.dpr, 4 * this.dpr]);
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1.5 * this.dpr;
      ctx.beginPath();
      setMatrix(ctx, this.matrix);
      const W = this.env.W;
      const H = this.env.H;
      g.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p[0] * W, p[1] * H) : ctx.lineTo(p[0] * W, p[1] * H)));
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
    const decision = classifyPointerDown(e, { penOnly: tool.penOnly, strokeActive: this.gesture !== null, sincePenUp: performance.now() - this.lastPenUp });
    if (decision !== 'write' && decision !== 'erase_with_pen_eraser') {
      if (decision === 'ignore_secondary' && this.gesture?.kind === 'stroke' && e.pointerType === 'touch' && this.gesture.capture.pointerType === 'touch' && this.gesture.capture.points.length < 6) {
        // a second finger right after the first: that was a pinch/scroll, not writing
        this.cancelGesture();
      }
      return;
    }
    e.preventDefault();
    this.rect = this.d.root.getBoundingClientRect();
    try {
      this.d.root.setPointerCapture(e.pointerId);
    } catch {
      // capture is best effort (synthetic events in tests)
    }
    const effective: InkToolId = decision === 'erase_with_pen_eraser' ? 'eraser_stroke' : tool.tool;
    const iso = this.toIso(e.clientX, e.clientY);
    const local = this.localPx(e);
    const start = (g: Gesture) => {
      this.gesture = g;
      this.d.root.setAttribute('data-ink-active', '');
      this.d.onStrokeActive(true);
    };
    if (PEN_TOOLS.has(effective)) {
      const style = { tool: effective as InkPenTool, color: tool.color, width: tool.width };
      const capture = new StrokeCapture(e.pointerType, this.toNorm, this.ar, e);
      // the page the stroke started on (the layer may be re-targeted before a teardown commit)
      start({ kind: 'stroke', pointerId: e.pointerId, id: newId(), anchor: this.d.getAnchor(), capture, style, predicted: [], holdTimer: undefined, holdAt: [e.clientX, e.clientY], recognized: null });
      this.armHold();
    } else if (effective === 'eraser_stroke') {
      start({ kind: 'erase_stroke', pointerId: e.pointerId, last: iso, hits: new Map(), cursor: local });
      this.eraseStrokeAlong([iso]);
    } else if (effective === 'eraser_point') {
      start({ kind: 'erase_point', pointerId: e.pointerId, last: iso, session: new PointEraseSession(this.ar), wholes: new Map(), cursor: local });
      this.erasePointAlong([iso]);
    } else if (effective === 'lasso') {
      start({ kind: 'lasso', pointerId: e.pointerId, points: [this.toNorm(e.clientX, e.clientY)], startClient: [e.clientX, e.clientY], moved: false });
    } else if (SHAPE_TOOLS.has(effective)) {
      const n = this.toNorm(e.clientX, e.clientY);
      start({ kind: 'shape', pointerId: e.pointerId, shape: effective as 'line', from: n, to: n, startClient: [e.clientX, e.clientY] });
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
    switch (g.kind) {
      case 'stroke': {
        let cur = g;
        if (cur.recognized) {
          if (Math.hypot(e.clientX - cur.holdAt[0], e.clientY - cur.holdAt[1]) > HOLD_CANCEL_PX) {
            cur.recognized = null; // moved on: keep writing, the stroke stays ink
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
        cur.predicted = predicted ? Array.from(predicted) : [];
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
        for (const s of samples) g.points.push(this.toNorm(s.clientX, s.clientY));
        if (Math.hypot(e.clientX - g.startClient[0], e.clientY - g.startClient[1]) > TAP_PX) g.moved = true;
        break;
      }
      case 'shape':
      case 'link_box':
        g.to = this.toNorm(e.clientX, e.clientY);
        break;
      case 'tap':
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
      case 'stroke':
        clearTimeout(g.holdTimer);
        if (!cancelled) g.capture.end(e);
        // a cancelled stroke is still writing the owner made: keep it (never lose ink)
        this.commitStroke(g);
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
          if (item) this.d.store.commit('شكل', [{ id: item.id, targetKey: this.d.targetKey, before: null, after: item }]);
        }
        break;
      }
      case 'tap':
        if (!cancelled && !g.moved) this.d.onTextRequest({ kind: g.tool, at: this.toNorm(e.clientX, e.clientY) });
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
    this.d.root.removeAttribute('data-ink-active');
    this.d.onStrokeActive(false);
    this.scheduleLive();
  }

  cancelGesture(): void {
    const g = this.gesture;
    if (!g) return;
    this.gesture = null;
    if (g.kind === 'stroke') clearTimeout(g.holdTimer);
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
    if (!tool.shapeRecognition || g.style.tool === 'highlighter') return;
    g.holdTimer = window.setTimeout(() => {
      const cur = this.gesture;
      if (cur !== g || g.capture.points.length < 4) return;
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
    this.gesture = { ...g, id: newId(), capture, predicted: [], recognized: null, holdTimer: undefined };
  }

  private commitStroke(g: Extract<Gesture, { kind: 'stroke' }>) {
    const anchor = g.anchor;
    const now = Date.now();
    const z = this.d.store.nextZ(this.d.targetKey);
    const points = g.capture.finalPoints();
    if (points.length === 0) return;
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
      this.d.store.commit('تحسين شكل', [{ id: shape.id, targetKey: this.d.targetKey, before: null, after: shape }]);
      return;
    }
    this.d.store.commit('كتابة', [{ id: ink.id, targetKey: this.d.targetKey, before: null, after: ink }]);
  }

  private shapeFromGesture(g: Extract<Gesture, { kind: 'shape' }>, id: string): InkItem | null {
    const tool = this.d.getTool();
    const [a, b] = [g.from, g.to];
    if (Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6) return null;
    const box = g.shape === 'rect' || g.shape === 'ellipse';
    const from: Vec = box ? [Math.min(a[0], b[0]), Math.min(a[1], b[1])] : a;
    const to: Vec = box ? [Math.max(a[0], b[0]), Math.max(a[1], b[1])] : b;
    return makeShapeItem({ id, anchor: this.d.getAnchor(), now: Date.now(), z: this.d.store.nextZ(this.d.targetKey), shape: g.shape, from, to, style: { tool: 'pen', color: tool.color, width: tool.width } });
  }

  // ── erasers ──
  private candidatesAlong(path: readonly Vec[], radiusIso: number): InkItem[] {
    const ar = this.ar;
    const b = bboxOf(path.map((p) => [p[0], p[1] / ar]));
    const pad = radiusIso + 0.06;
    return this.d.store.query(this.d.targetKey, expandBox(b, pad, pad / ar)).filter((it) => !it.locked && (isInkStroke(it) || isShape(it)));
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
    if (!g.moved || g.points.length < 3) {
      const hit = this.hitTest(this.toNorm(e.clientX, e.clientY));
      store.setSelection(hit ? { targetKey: this.d.targetKey, ids: [hit.id] } : null);
      return;
    }
    const poly = g.points;
    const box = bboxOf(poly);
    const ids: string[] = [];
    for (const it of store.query(this.d.targetKey, box)) {
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
    const cands = this.d.store.query(this.d.targetKey, expandBox({ x: n[0], y: n[1], w: 0, h: 0 }, r, r / ar)).sort(paintOrder).reverse();
    for (const it of cands) {
      const geo = itemGeometry(it, ar);
      if (geo.area && pointInPolygon(iso, geo.area)) return it;
      if ((isTextBox(it) && boxContains(it.data.box, n[0], n[1])) || itemHitByPath(it, [iso], r, ar)) return it;
    }
    return null;
  }
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
