// The zoom writing window (parity N1 wave 2, G09): a strip docked at the bottom of the screen shows a small box of the
// page magnified; what the owner writes in the strip is saved in that box of the page — in PAGE space like every stroke
// (AC-21), one undo step per stroke, synced like any writing. After a stroke near the far side of the strip the box
// moves on in the writing direction — to the LEFT for Arabic (the default; English pages go right) — and at the end of
// a line it returns to the start of the next one, inside the owner's margins. The box can be moved with the arrow keys
// (on the box on the page or in the strip), and placed by tapping the page with this tool.
import { useCallback, useEffect, useId, useInsertionEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeftRight, CornerDownLeft, MoveLeft, MoveRight, Undo2, X } from 'lucide-react';
import { newId, type InkPoint, type InkStyle } from '@medlevo/shared';
import { IconButton, Tooltip } from '../../../design';
import { feelFor, styleFeel } from './feel';
import { useInk, useInkInternal, type ZoomTarget } from './InkProvider';
import { meaningOf, slotsFor } from './inkSettings';
import { classifyPointerDown, palmPolicy, StrokeCapture } from './input';
import { newStrokeStyle } from './layerController';
import { makeInkItem, type InkItem } from './model';
import { canvasScale, drawItem, paintOrder, paperToneOf, setMatrix, type RenderEnv } from './render';
import { advanceBox, boxSize, lineBand, lineBelowFits, magnification, moveBox, nextLineBox, shouldAdvance } from './zoomGeometry';

const STRIP_PX = { small: 112, medium: 152, large: 212 } as const;
/** (review of N1 wave 2) the box stays on the last line of the page instead of wrapping onto it */
const END_OF_PAGE_AR = 'بلغت النافذة آخر سطر في الصفحة؛ بقي المربع مكانه. حرّكه بالأسهم، أو المس صفحة أخرى بهذه الأداة.';

/** The strip's css aspect (width / height) before it is measured: the window's width minus the gutters. */
export function defaultStripAspect(strip: keyof typeof STRIP_PX): number {
  const w = typeof window !== 'undefined' ? Math.min(window.innerWidth - 32, 960) : 600;
  return Math.max(1.5, w / STRIP_PX[strip]);
}

/** The page element under a layer's target (its sheet), for the strip's background. */
function sheetOf(targetKey: string): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  const layer = document.querySelector<HTMLElement>(`.ml-ink-layer[data-ink-target="${CSS.escape(targetKey)}"]`);
  return (layer?.closest('.wk-sheet') as HTMLElement | null) ?? layer?.parentElement?.parentElement ?? null;
}

export function ZoomWindow() {
  const ink = useInk();
  const { store, zoom, setZoom, prefs, inkSettings, feelProfile, toolRef, announce } = useInkInternal();
  const z = zoom!;
  const settings = inkSettings.zoom;
  const titleId = useId();
  const stripRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<HTMLCanvasElement>(null);
  const liveRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: STRIP_PX[settings.strip] });
  const latest = useRef({ z, settings, size });
  useInsertionEffect(() => {
    latest.current = { z, settings, size };
  });
  const capture = useRef<{ pointerId: number; cap: StrokeCapture; id: string; style: InkStyle } | null>(null);
  const liveFrame = useRef(0);

  // the strip's measured size; the box keeps the strip's proportions (one written line tall)
  useLayoutEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    // the drawing area of the strip (inside its border): the canvases fill it and the pen is mapped over it
    const measure = () => setSize({ w: Math.round(el.clientWidth), h: Math.round(el.clientHeight) || STRIP_PX[latest.current.settings.strip] });
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [settings.strip]);
  useEffect(() => {
    if (size.w <= 0) return;
    // (review of N1 wave 2) the box has the strip's proportions and fits between the owner's margins
    const [bl, br] = lineBand(z.dir, settings);
    const want = boxSize(settings.line_height, size.w / size.h, z.ar, Math.min(0.9, Math.max(0.05, br - bl)));
    if (Math.abs(want.w - z.box.w) < 1e-4 && Math.abs(want.h - z.box.h) < 1e-4) return;
    // keep the start side of the box where it is (the right side for RTL)
    const x = z.dir === 'rtl' ? z.box.x + z.box.w - want.w : z.box.x;
    setZoom({ ...z, box: moveBox({ x, y: z.box.y, w: want.w, h: want.h }, 0, 0) });
  }, [size.w, size.h, settings, z, setZoom]);

  /** page units → strip device px */
  const matrix = useCallback((dpr: number): [number, number, number, number, number, number] => {
    const { z: t, size: s } = latest.current;
    const k = (s.w * dpr) / (t.box.w * t.pageW);
    const H = t.pageW * t.ar;
    return [k, 0, 0, k, -t.box.x * t.pageW * k, -t.box.y * H * k];
  }, []);
  const env = useCallback((): RenderEnv => {
    const { z: t } = latest.current;
    const sheet = sheetOf(t.targetKey);
    const layer = sheet?.querySelector('.ml-ink-layer') ?? null;
    let css: CSSStyleDeclaration | null = null;
    try {
      css = layer ? getComputedStyle(layer) : null;
    } catch {
      css = null;
    }
    return { W: t.pageW, H: t.pageW * t.ar, tone: layer ? paperToneOf(layer.firstElementChild ?? layer) : 'light', css };
  }, []);

  // the box of the page, magnified: the page picture under it, then the ink in it
  const paintBase = useCallback(() => {
    const c = baseRef.current;
    const { z: t, size: s } = latest.current;
    if (!c || s.w <= 0) return;
    const dpr = canvasScale(s.w, s.h, typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);
    c.width = Math.max(1, Math.round(s.w * dpr));
    c.height = Math.max(1, Math.round(s.h * dpr));
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = c.getContext('2d');
    } catch {
      ctx = null;
    }
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    const sheet = sheetOf(t.targetKey);
    const src = sheet?.querySelector<HTMLCanvasElement | HTMLImageElement>('canvas.wk-pagecanvas, img.wk-pageimage, .wk-sheet__image img') ?? null;
    try {
      if (src && Number(sheet?.getAttribute('data-rot') ?? 0) === 0) {
        const sw = src instanceof HTMLCanvasElement ? src.width : src.naturalWidth;
        const sh = src instanceof HTMLCanvasElement ? src.height : src.naturalHeight;
        // the part of the page the strip shows at its one scale (the box's width across the strip's width)
        const shownH = (s.h / s.w) * (t.box.w / t.ar);
        if (sw && sh) ctx.drawImage(src, t.box.x * sw, t.box.y * sh, t.box.w * sw, shownH * sh, 0, 0, c.width, c.height);
      }
    } catch {
      // a picture the browser will not let the page read: plain paper
    }
    setMatrix(ctx, matrix(dpr));
    const e = env();
    const items = store
      .query(t.targetKey, t.box)
      .filter((it) => store.isVisible(it) && (it.kind === 'ink' || it.kind === 'shape'))
      .sort(paintOrder);
    for (const it of items) drawItem(ctx, it, e);
  }, [store, matrix, env]);

  useEffect(() => {
    paintBase();
    return store.subscribePage(z.targetKey, (e) => {
      if (e.kind === 'items' || e.kind === 'loaded' || e.kind === 'view') paintBase();
    });
  }, [store, z.targetKey, z.box, size.w, size.h, paintBase]);

  const paintLive = useCallback(() => {
    liveFrame.current = 0;
    const c = liveRef.current;
    const { size: s } = latest.current;
    if (!c || s.w <= 0) return;
    const dpr = canvasScale(s.w, s.h, typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);
    if (c.width !== Math.round(s.w * dpr)) {
      c.width = Math.max(1, Math.round(s.w * dpr));
      c.height = Math.max(1, Math.round(s.h * dpr));
    }
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = c.getContext('2d', { desynchronized: true }) as CanvasRenderingContext2D | null;
    } catch {
      ctx = null;
    }
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    const g = capture.current;
    if (!g) return;
    setMatrix(ctx, matrix(dpr));
    drawItem(ctx, { ...makeInkItem({ id: 'live', anchor: latest.current.z.anchor, now: 0, z: 0, style: g.style, points: g.cap.points.slice(), pressureAvailable: g.cap.pressureAvailable, tiltAvailable: false, pointerType: g.cap.pointerType }) }, env());
  }, [matrix, env]);
  const scheduleLive = () => {
    if (!liveFrame.current) liveFrame.current = requestAnimationFrame(paintLive);
  };
  useEffect(() => () => cancelAnimationFrame(liveFrame.current), []);

  /**
   * client px in the strip → normalized page point, at the ONE scale the strip draws with (the box's width across the
   * strip's drawing width, the same down): the ink is saved exactly where the pen wrote in the strip (review of N1 wave 2)
   */
  const toNorm = useCallback((clientX: number, clientY: number): [number, number] => {
    const el = stripRef.current;
    const { z: t } = latest.current;
    const r = el?.getBoundingClientRect();
    if (!el || !r || r.width <= 0 || r.height <= 0) return [t.box.x, t.box.y];
    const w = el.clientWidth || r.width;
    const perPx = t.box.w / w; // normalized page x per css px of the strip
    return [t.box.x + (clientX - r.left - el.clientLeft) * perPx, t.box.y + ((clientY - r.top - el.clientTop) * perPx) / t.ar];
  }, []);

  /** the pen the strip writes with: the last pen and its preset (colour slot meaning, feel, line pattern) */
  const strokeStyle = (): InkStyle => {
    const pen = prefs.lastPen;
    const preset = prefs.presets[pen];
    const slots = slotsFor(inkSettings, pen);
    const meaning = meaningOf(slots, preset.color, preset.slot);
    const feel = styleFeel(feelFor(feelProfile, pen as 'pen', inkSettings));
    return newStrokeStyle(pen, { ...toolRef.current, color: preset.color, width: preset.width, ...(meaning ? { meaning } : { meaning: undefined }), feel, ...(preset.dash ? { dash: preset.dash } : { dash: undefined }) });
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const t = toolRef.current;
    const decision = classifyPointerDown(e.nativeEvent, { penOnly: t.penOnly, strokeActive: !!capture.current, sincePenUp: Infinity, palm: t.palm ? palmPolicy(t.palm.sensitivity, t.palm.hand) : undefined, lastPen: null });
    if (decision !== 'write') return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // best effort
    }
    capture.current = { pointerId: e.pointerId, cap: new StrokeCapture(e.pointerType, toNorm, latest.current.z.ar, e.nativeEvent), id: newId(), style: strokeStyle() };
    scheduleLive();
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = capture.current;
    if (!g || g.pointerId !== e.pointerId) return;
    e.preventDefault();
    const coalesced = typeof e.nativeEvent.getCoalescedEvents === 'function' ? e.nativeEvent.getCoalescedEvents() : [];
    for (const s of coalesced.length ? coalesced : [e.nativeEvent]) if (!g.cap.full) g.cap.add(s);
    scheduleLive();
  };
  const finish = (e: React.PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const g = capture.current;
    if (!g || g.pointerId !== e.pointerId) return;
    capture.current = null;
    if (!cancelled) g.cap.end(e.nativeEvent);
    const points: InkPoint[] = g.cap.finalPoints();
    scheduleLive();
    if (points.length === 0) return;
    const { z: t, settings: st } = latest.current;
    const item: InkItem = makeInkItem({ id: g.id, anchor: t.anchor, now: Date.now(), z: store.nextZ(t.targetKey), style: g.style, points, pressureAvailable: g.cap.pressureAvailable, tiltAvailable: g.cap.tiltAvailable, pointerType: g.cap.pointerType });
    // one stroke = one undo step, saved to this device first, then synced (the page may not be on screen: it is attached)
    store.attachPage(t.targetKey, t.anchor, t.ar);
    store.commit('كتابة', [{ id: item.id, targetKey: t.targetKey, before: null, after: item }]);
    store.markActive(t.targetKey);
    if (!st.auto_advance) return;
    const xs = points.map((p) => (p[0] - t.box.x) / t.box.w);
    if (shouldAdvance({ x0: Math.min(...xs), x1: Math.max(...xs) }, t.dir)) {
      const next = advanceBox(t.box, t.dir, st);
      if (next.end) {
        announce(END_OF_PAGE_AR);
        return;
      }
      setZoom({ ...t, box: next.box });
      announce(next.wrapped ? 'انتقلت النافذة إلى بداية السطر التالي.' : t.dir === 'rtl' ? 'تقدّمت النافذة إلى اليسار.' : 'تقدّمت النافذة إلى اليمين.');
    }
  };

  const move = (dx: number, dy: number) => setZoom({ ...z, box: moveBox(z.box, dx, dy) });
  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    const step = e.shiftKey ? 0.05 : 0.01;
    const d: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const v = d[e.key];
    if (!v) return;
    e.preventDefault();
    e.stopPropagation();
    move(v[0], v[1] / z.ar);
  };
  const pageH = (sheetOf(z.targetKey)?.getBoundingClientRect().height ?? 0) || 1;
  const mag = magnification(z.box, size.h, pageH);
  const dirLabel = z.dir === 'rtl' ? 'من اليمين إلى اليسار' : 'من اليسار إلى اليمين';

  const panel = (
    <section className="ml-ink-zoom" data-ink-ui="" dir="rtl" aria-labelledby={titleId} data-strip={settings.strip}>
      <div className="ml-ink-zoom__bar">
        <h2 id={titleId} className="ml-ink-zoom__title">
          نافذة الكتابة المكبّرة
          <span className="ml-ink-zoom__meta">{` — ×${mag >= 10 ? Math.round(mag) : mag.toFixed(1)}، ${dirLabel}`}</span>
        </h2>
        <div className="ml-ink-zoom__actions" role="toolbar" aria-label="أدوات نافذة الكتابة">
          <Tooltip content="تقدّم في اتجاه الكتابة" describe={false}>
            <IconButton
              label="تقدّم في اتجاه الكتابة"
              icon={z.dir === 'rtl' ? <MoveLeft size={18} /> : <MoveRight size={18} />}
              onClick={() => {
                const n = advanceBox(z.box, z.dir, settings);
                if (n.end) return announce(END_OF_PAGE_AR);
                setZoom({ ...z, box: n.box });
                announce(n.wrapped ? 'بداية السطر التالي.' : 'تقدّمت النافذة.');
              }}
            />
          </Tooltip>
          <Tooltip content="سطر جديد" describe={false}>
            <IconButton
              label="سطر جديد"
              icon={<CornerDownLeft size={18} />}
              onClick={() => {
                if (!lineBelowFits(z.box, settings)) return announce(END_OF_PAGE_AR);
                setZoom({ ...z, box: nextLineBox(z.box, z.dir, settings) });
                announce('بداية السطر التالي.');
              }}
            />
          </Tooltip>
          <Tooltip content={`اتجاه الكتابة: ${dirLabel} — اضغط للتبديل`} describe={false}>
            <IconButton
              label={`اتجاه الكتابة: ${dirLabel}`}
              icon={<ArrowLeftRight size={18} />}
              pressed={z.dir === 'ltr'}
              onClick={() => {
                const dir = z.dir === 'rtl' ? 'ltr' : 'rtl';
                setZoom({ ...z, dir });
                announce(dir === 'rtl' ? 'الكتابة من اليمين إلى اليسار.' : 'الكتابة من اليسار إلى اليمين.');
              }}
            />
          </Tooltip>
          <Tooltip content="تراجع عن آخر خط" describe={false}>
            <IconButton label="تراجع" icon={<Undo2 size={18} />} disabled={!ink.canUndo} onClick={ink.undo} />
          </Tooltip>
          <Tooltip content="إغلاق النافذة والعودة إلى القلم" describe={false}>
            <IconButton label="إغلاق نافذة الكتابة المكبّرة" icon={<X size={18} />} onClick={() => ink.setTool(prefs.lastPen)} />
          </Tooltip>
        </div>
      </div>
      <div
        ref={stripRef}
        className="ml-ink-zoom__strip"
        style={{ height: STRIP_PX[settings.strip] }}
        role="application"
        aria-roledescription="مساحة كتابة مكبّرة"
        aria-label={`اكتب هنا: يُحفظ في المربع المحدد على الصفحة. الأسهم تحرّك المربع (مع Shift خطوة أكبر).`}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => finish(e, false)}
        onPointerCancel={(e) => finish(e, true)}
        onContextMenu={(e) => e.preventDefault()}
      >
        <canvas ref={baseRef} className="ml-ink-zoom__canvas" aria-hidden="true" />
        <canvas ref={liveRef} className="ml-ink-zoom__canvas" aria-hidden="true" />
        <span className={`ml-ink-zoom__advance ml-ink-zoom__advance--${z.dir}`} aria-hidden="true" />
      </div>
    </section>
  );
  return typeof document !== 'undefined' ? createPortal(panel, document.getElementById('root') ?? document.body) : panel;
}

/** (tests) The target a tap places for a page. */
export type { ZoomTarget };
