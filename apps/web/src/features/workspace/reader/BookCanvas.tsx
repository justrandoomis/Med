// Book Canvas (§23, §24, §55): the scrollable book. Fixed-page sources (PDF, page images) are laid out
// from known page sizes and virtualized — only pages near the viewport are rendered; canvases far away
// are released. Structured text (DOCX / slide text) flows as paper sections. The owner's place (page +
// offset under the reading line) survives zoom, rotation, layout and window changes.
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { cx } from '../../../design';
import type { ReaderSheet } from '../model/sequence';
import { clampZoom, fitWidthZoom } from '../model/zoom';
import { ANCHOR_LINE, anchorAt, layoutContinuous, layoutSpread, pagesInRange, readingLineY, spreadOf, type Layout, type PageBox } from './geometry';
import { NotePageView } from './NotePageView';
import { PageView } from './PageView';
import { SwipeTracker } from './swipe';
import { useReaderPage, type MeasuredSize } from './readerContext';

export type LayoutMode = 'single' | 'double' | 'continuous';

/** A place in the canvas. `pageIndex` is the index in the SHEET sequence (source pages + inserted note pages). */
export interface BookLocation {
  pageIndex: number;
  /** fraction of the page under the reading line */
  frac: number;
}

export interface BookCanvasHandle {
  /** scroll to a page (and a fraction inside it) */
  goTo(pageIndex: number, frac?: number): void;
  location(): BookLocation;
  /** scroll the viewport by a fraction of its height (keyboard) */
  scrollByViewport(fraction: number): void;
  element(): HTMLElement | null;
}

export interface BookCanvasProps {
  /** what the book shows, in order: source pages and the owner's note pages (model/sequence.ts) */
  sheets: readonly ReaderSheet[];
  /** fallback page size when a page has no stored size */
  fallbackSize: { w: number; h: number; unit: 'pt' | 'px' } | null;
  /** real PDF page boxes measured by pdf.js (override stored sizes) */
  measured?: ReadonlyMap<number, MeasuredSize>;
  /** current sheet (index in `sheets`; paged layouts render its spread) */
  pageIndex: number;
  /** place to restore on first layout */
  initialFrac?: number;
  zoom: number;
  fit: 'width' | null;
  viewRotation: number;
  layout: LayoutMode;
  /** spreads put the first page on the right (Arabic books) */
  spreadRtl: boolean;
  flipAnimation: boolean;
  label: string;
  onLocation(loc: BookLocation): void;
  onEffectiveZoom(z: number): void;
  /** gesture zoom (pinch / Ctrl+wheel) committed: the canvas already anchored the focal point */
  onZoomGesture(z: number): void;
  onViewed(pageIndex: number): void;
  /** a swipe asked for the next/previous spread (paged layouts) */
  onSwipe?(dir: 1 | -1): void;
  /** a pen stroke is in progress (touches during it are never swipes, §24) */
  strokeActive?: () => boolean;
  className?: string;
  id?: string;
}

const VIEWED_MS = 2000;

export function boxesFor(sheets: readonly ReaderSheet[], fallbackIn: BookCanvasProps['fallbackSize'], measured?: ReadonlyMap<number, MeasuredSize>): PageBox[] {
  const firstMeasured = measured && measured.size ? [...measured.values()][0]! : null;
  const fallback = fallbackIn ?? (firstMeasured ? { w: firstMeasured.w, h: firstMeasured.h, unit: 'pt' as const } : null);
  return sheets.map((sheet, index) => {
    // a note page is paper of its own size (pt); it never rotates with the PDF's /Rotate
    if (sheet.kind === 'note') return { index, w: sheet.note.width, h: sheet.note.height, unit: 'pt' as const, intrinsic: 0 };
    const p = sheet.page;
    const m = measured?.get(p.page_index);
    if (m) return { index, w: m.w, h: m.h, unit: 'pt' as const, intrinsic: m.rotate };
    const ok = p.width && p.height && p.width > 0 && p.height > 0;
    const unit: 'pt' | 'px' = (ok ? p.unit : fallback?.unit) === 'px' ? 'px' : 'pt';
    return {
      index,
      w: ok ? p.width! : (fallback?.w ?? 595),
      h: ok ? p.height! : (fallback?.h ?? 842),
      unit,
      intrinsic: p.rotation ?? 0,
    };
  });
}

interface Anchor {
  index: number;
  fy: number;
  fx: number;
  /** where that point should sit in the viewport */
  vy: number;
  vx: number;
}

export const BookCanvas = forwardRef<BookCanvasHandle, BookCanvasProps>(function BookCanvas(props, ref) {
  const { sheets, fallbackSize, measured, pageIndex, zoom, fit, viewRotation, layout, spreadRtl, flipAnimation, label, onLocation, onEffectiveZoom, onZoomGesture, onViewed, onSwipe, strokeActive, className } = props;
  const ctx = useReaderPage();
  const flow = ctx.mode === 'text';
  const scrollerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const boxes = useMemo(() => boxesFor(sheets, fallbackSize, measured), [sheets, fallbackSize, measured]);

  // ── zoom: fit width uses the widest (rotated) page so every page fits ──
  const columns = layout === 'double' ? 2 : 1;
  const effectiveZoom = useMemo(() => {
    if (fit !== 'width' || size.w === 0 || boxes.length === 0) return clampZoom(zoom);
    let widest = boxes[0]!;
    let widestW = 0;
    for (const b of boxes) {
      const sideways = ((b.intrinsic + viewRotation) / 90) % 2 !== 0;
      const w = (sideways ? b.h : b.w) * (b.unit === 'px' ? 1 : 96 / 72);
      if (w > widestW) {
        widestW = w;
        widest = b;
      }
    }
    const rot = (((widest.intrinsic + viewRotation) % 360) + 360) % 360;
    return fitWidthZoom({ containerWidth: size.w, pageWidth: widest.w, pageHeight: widest.h, unit: widest.unit, rotation: rot as 0 | 90 | 180 | 270, columns });
  }, [fit, zoom, size.w, boxes, viewRotation, columns]);
  useEffect(() => onEffectiveZoom(effectiveZoom), [effectiveZoom, onEffectiveZoom]);

  // ── layout ──
  const spread = useMemo(() => spreadOf(pageIndex, layout, sheets.length), [pageIndex, layout, sheets.length]);
  const geometry: Layout | null = useMemo(() => {
    if (flow || size.w === 0 || boxes.length === 0) return null;
    if (layout === 'continuous') return layoutContinuous(boxes, effectiveZoom, viewRotation, size.w);
    const subset = spread.map((i) => boxes[i]!).filter(Boolean);
    return layoutSpread(subset, effectiveZoom, viewRotation, size.w, spreadRtl, size.h);
  }, [flow, size.w, size.h, boxes, layout, effectiveZoom, viewRotation, spread, spreadRtl]);

  // ── place tracking ──
  const locRef = useRef<BookLocation>({ pageIndex, frac: props.initialFrac ?? 0 });
  const pendingAnchor = useRef<Anchor | null>(null);
  const restored = useRef(false);

  const currentAnchor = useCallback((): Anchor => {
    const el = scrollerRef.current;
    const vh = el?.clientHeight ?? 0;
    const vw = el?.clientWidth ?? 0;
    return { index: locRef.current.pageIndex, fy: locRef.current.frac, fx: 0.5, vy: vh * ANCHOR_LINE, vx: vw / 2 };
  }, []);

  const applyAnchor = useCallback(
    (a: Anchor) => {
      const el = scrollerRef.current;
      if (!el) return;
      if (flow) {
        const section = el.querySelector<HTMLElement>(`[data-seq="${a.index}"]`);
        if (section) el.scrollTop = Math.max(0, section.offsetTop + a.fy * section.offsetHeight - a.vy);
        return;
      }
      if (!geometry) return;
      const g = geometry.pages.find((p) => p.index === a.index);
      if (!g) {
        el.scrollTop = 0;
        return;
      }
      el.scrollTop = Math.max(0, Math.ceil(g.top + a.fy * g.viewH - a.vy));
      const left = g.left + a.fx * g.viewW - a.vx;
      el.scrollLeft = Math.max(0, Math.min(left, geometry.contentW - el.clientWidth));
    },
    [geometry, flow],
  );

  // The place is an index in the SHEET sequence: when the sequence changes under it (note pages arriving from
  // IndexedDB / the server after the first layout, inserted, trashed or moved before the place), the place follows its
  // sheet by key — otherwise the reader would show (and save) the neighbouring page. A sheet that went away leaves the
  // place where it was: on the sheet that now follows the last surviving one before it. Runs before the effects below.
  const prevSheets = useRef(sheets);
  useLayoutEffect(() => {
    const prev = prevSheets.current;
    prevSheets.current = sheets;
    if (prev === sheets) return;
    const cur = locRef.current;
    const key = prev[cur.pageIndex]?.key;
    if (key == null) return;
    const same = sheets.findIndex((s) => s.key === key);
    if (same >= 0) {
      if (same !== cur.pageIndex) locRef.current = { pageIndex: same, frac: cur.frac };
      return;
    }
    let next = 0;
    for (let j = cur.pageIndex - 1; j >= 0; j--) {
      const k = sheets.findIndex((s) => s.key === prev[j]!.key);
      if (k >= 0) {
        next = Math.min(k + 1, Math.max(0, sheets.length - 1));
        break;
      }
    }
    locRef.current = { pageIndex: next, frac: 0 };
  }, [sheets]);

  // paged layouts: a new spread starts at its top
  const lastSpread = useRef(spread.join(','));
  const [flipDir, setFlipDir] = useState<'next' | 'prev' | null>(null);
  useLayoutEffect(() => {
    const key = spread.join(',');
    if (layout === 'continuous' || key === lastSpread.current) {
      lastSpread.current = key;
      return;
    }
    const prevFirst = Number(lastSpread.current.split(',')[0] ?? 0);
    lastSpread.current = key;
    locRef.current = { pageIndex, frac: locRef.current.pageIndex === pageIndex ? locRef.current.frac : 0 };
    if (flipAnimation) setFlipDir((spread[0] ?? 0) > prevFirst ? 'next' : 'prev');
  }, [spread, layout, pageIndex, flipAnimation]);
  useEffect(() => {
    if (!flipDir) return;
    const t = setTimeout(() => setFlipDir(null), 260);
    return () => clearTimeout(t);
  }, [flipDir]);

  // after every layout change, put the owner's place back under the reading line
  useLayoutEffect(() => {
    if (!flow && !geometry) return;
    const a = pendingAnchor.current ?? currentAnchor();
    pendingAnchor.current = null;
    applyAnchor(a);
    restored.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geometry, flow]);

  // ── size ──
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const measure = () => setSize((s) => (s.w === el.clientWidth && s.h === el.clientHeight ? s : { w: el.clientWidth, h: el.clientHeight }));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ── render window (virtualization) ──
  const [near, setNear] = useState<ReadonlySet<number>>(() => new Set([pageIndex]));
  const computeNear = useCallback(() => {
    const el = scrollerRef.current;
    if (!el || !geometry) return;
    const vh = el.clientHeight || 800;
    const list = layout === 'continuous' ? pagesInRange(geometry, el.scrollTop - vh, el.scrollTop + vh * 2) : spread;
    setNear((prev) => (prev.size === list.length && list.every((i) => prev.has(i)) ? prev : new Set(list)));
  }, [geometry, layout, spread]);
  useEffect(() => computeNear(), [computeNear]);

  const onScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el || !restored.current) return;
    if (flow) {
      const sections = Array.from(el.querySelectorAll<HTMLElement>('[data-seq]'));
      const line = readingLineY(el.scrollTop, el.clientHeight, el.scrollHeight);
      let hit = sections[0];
      for (const s of sections) if (s.offsetTop <= line) hit = s;
      if (hit) {
        const idx = Number(hit.dataset.seq);
        const frac = hit.offsetHeight > 0 ? Math.min(1, Math.max(0, (line - hit.offsetTop) / hit.offsetHeight)) : 0;
        locRef.current = { pageIndex: idx, frac };
        onLocation(locRef.current);
      }
      return;
    }
    if (!geometry) return;
    const a = anchorAt(geometry, layout === 'continuous' ? readingLineY(el.scrollTop, el.clientHeight, el.scrollHeight) : el.scrollTop + el.clientHeight * ANCHOR_LINE);
    locRef.current = layout === 'continuous' ? { pageIndex: a.index, frac: a.frac } : { pageIndex: spread.includes(locRef.current.pageIndex) ? locRef.current.pageIndex : (spread[0] ?? 0), frac: a.frac };
    onLocation(locRef.current);
    computeNear();
  }, [flow, geometry, layout, spread, onLocation, computeNear]);

  const rafScroll = useRef(0);
  const handleScroll = useCallback(() => {
    if (rafScroll.current) return;
    rafScroll.current = requestAnimationFrame(() => {
      rafScroll.current = 0;
      onScroll();
    });
  }, [onScroll]);

  // ── imperative API ──
  useImperativeHandle(
    ref,
    () => ({
      goTo(index, frac = 0) {
        const el = scrollerRef.current;
        locRef.current = { pageIndex: index, frac };
        const a: Anchor = { index, fy: frac, fx: 0.5, vy: (el?.clientHeight ?? 0) * ANCHOR_LINE, vx: (el?.clientWidth ?? 0) / 2 };
        if (layout !== 'continuous' && !spreadOf(index, layout, sheets.length).every((i) => spread.includes(i))) {
          // a different spread: the parent changes pageIndex, the layout effect restores the anchor
          pendingAnchor.current = a;
          return;
        }
        applyAnchor(a);
        onLocation(locRef.current);
      },
      location: () => locRef.current,
      scrollByViewport(fraction) {
        const el = scrollerRef.current;
        if (el) el.scrollBy({ top: el.clientHeight * fraction });
      },
      element: () => scrollerRef.current,
    }),
    [applyAnchor, layout, sheets.length, spread, onLocation],
  );

  // ── gesture zoom: Ctrl/⌘ + wheel, Safari trackpad gestures, two-finger pinch ──
  const preview = useRef<{ factor: number; fx: number; fy: number; timer: number } | null>(null);
  const commitZoom = useCallback(() => {
    const p = preview.current;
    const el = scrollerRef.current;
    const content = contentRef.current;
    preview.current = null;
    if (content) {
      content.style.transform = '';
      content.style.transformOrigin = '';
    }
    if (!p || !el || Math.abs(p.factor - 1) < 0.01) return;
    // focal point (content coords) → page-relative fractions before the re-layout
    const cx = el.scrollLeft + p.fx;
    const cy = el.scrollTop + p.fy;
    if (geometry && !flow) {
      const a = anchorAt(geometry, cy);
      const g = geometry.pages.find((x) => x.index === a.index);
      if (g) pendingAnchor.current = { index: g.index, fy: (cy - g.top) / g.viewH, fx: (cx - g.left) / g.viewW, vy: p.fy, vx: p.fx };
    }
    onZoomGesture(clampZoom(effectiveZoom * p.factor));
  }, [geometry, flow, effectiveZoom, onZoomGesture]);

  const updatePreview = useCallback(
    (factor: number, clientX: number, clientY: number) => {
      const el = scrollerRef.current;
      const content = contentRef.current;
      if (!el || !content) return;
      const rect = el.getBoundingClientRect();
      const fx = clientX - rect.left;
      const fy = clientY - rect.top;
      const minF = 0.25 / effectiveZoom;
      const maxF = 5 / effectiveZoom;
      const f = Math.min(maxF, Math.max(minF, factor));
      const p = preview.current ?? { factor: 1, fx, fy, timer: 0 };
      p.factor = f;
      preview.current = p;
      content.style.transformOrigin = `${el.scrollLeft + p.fx}px ${el.scrollTop + p.fy}px`;
      content.style.transform = `scale(${f})`;
    },
    [effectiveZoom],
  );

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1;
      const current = preview.current?.factor ?? 1;
      updatePreview(current * Math.exp((-e.deltaY * unit) / 500), e.clientX, e.clientY);
      const p = preview.current;
      if (p) {
        window.clearTimeout(p.timer);
        p.timer = window.setTimeout(commitZoom, 160);
      }
    };
    // Safari (macOS trackpad pinch, iPad keyboard trackpad): non-standard gesture events
    let gestureStart = 1;
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      gestureStart = preview.current?.factor ?? 1;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const ge = e as Event & { scale: number; clientX: number; clientY: number };
      updatePreview(gestureStart * ge.scale, ge.clientX, ge.clientY);
    };
    const onGestureEnd = (e: Event) => {
      e.preventDefault();
      commitZoom();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('gesturestart', onGestureStart);
    el.addEventListener('gesturechange', onGestureChange);
    el.addEventListener('gestureend', onGestureEnd);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('gesturestart', onGestureStart);
      el.removeEventListener('gesturechange', onGestureChange);
      el.removeEventListener('gestureend', onGestureEnd);
    };
  }, [updatePreview, commitZoom]);

  // two-finger pinch on touch screens (fingers never write in pen-only mode, so they may always pinch)
  const touches = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number } | null>(null);
  const swipe = useRef(new SwipeTracker());
  const busy = () => strokeActive?.() ?? false;
  const pointer = (e: React.PointerEvent) => ({
    pointerId: e.pointerId,
    pointerType: e.pointerType,
    clientX: e.clientX,
    clientY: e.clientY,
    timeStamp: e.timeStamp,
    // the ink layer (a native listener below us) claimed this pointer for writing
    defaultPrevented: e.nativeEvent.defaultPrevented,
  });
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType !== 'touch') return;
    touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.current.size === 2) {
      const [a, b] = [...touches.current.values()];
      pinch.current = { dist: Math.hypot(a!.x - b!.x, a!.y - b!.y) || 1 };
      swipe.current.cancel();
    } else if (touches.current.size === 1) {
      swipe.current.down(pointer(e), busy());
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (e.pointerType !== 'touch' || !touches.current.has(e.pointerId)) return;
    touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    swipe.current.move(pointer(e), busy());
    if (pinch.current && touches.current.size === 2) {
      const [a, b] = [...touches.current.values()];
      const dist = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      updatePreview(dist / pinch.current.dist, (a!.x + b!.x) / 2, (a!.y + b!.y) / 2);
    }
  };
  const onPointerEnd = (e: React.PointerEvent) => {
    if (e.pointerType !== 'touch') return;
    touches.current.delete(e.pointerId);
    if (pinch.current && touches.current.size < 2) {
      pinch.current = null;
      swipe.current.cancel();
      commitZoom();
      return;
    }
    const dir = swipe.current.up({ ...pointer(e), cancelled: e.type === 'pointercancel' }, spreadRtl, busy());
    if (dir === 0 || layout === 'continuous' || !onSwipe) return;
    const el = scrollerRef.current;
    if (el && el.scrollWidth > el.clientWidth + 4) return; // zoomed in: horizontal moves pan the page
    // next page comes from the side the book reads towards
    onSwipe(dir);
  };

  // ── reading progress: a page counts as viewed after ≥ 2 s with ≥ half of it on screen (§45: viewing, not mastery) ──
  const viewedSent = useRef(new Set<number>());
  useEffect(() => {
    viewedSent.current = new Set();
  }, [sheets]);
  const visible = useRef(new Map<number, number>());
  useEffect(() => {
    const root = scrollerRef.current;
    if (!root || typeof IntersectionObserver === 'undefined') return;
    const vis = visible.current;
    const io = new IntersectionObserver(
      (entries) => {
        for (const en of entries) {
          const idx = Number((en.target as HTMLElement).dataset.seq);
          if (en.isIntersecting && en.intersectionRatio >= 0.5) {
            if (!vis.has(idx)) vis.set(idx, performance.now());
          } else {
            vis.delete(idx);
          }
        }
      },
      { root, threshold: [0, 0.5, 1] },
    );
    const sections = root.querySelectorAll('[data-seq]');
    sections.forEach((s) => io.observe(s));
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      const now = performance.now();
      for (const [idx, since] of vis) {
        if (now - since >= VIEWED_MS && !viewedSent.current.has(idx)) {
          viewedSent.current.add(idx);
          onViewed(idx);
        }
      }
    }, 500);
    return () => {
      io.disconnect();
      window.clearInterval(timer);
      vis.clear();
    };
  }, [geometry, near, flow, onViewed]);

  // paged layouts that fit the width turn pages with a horizontal swipe: the browser must not claim
  // horizontal finger moves for panning (it would cancel the pointer and the swipe never arrives)
  const swipeable = !flow && layout !== 'continuous' && !!onSwipe && !!geometry && geometry.contentW <= size.w + 1;

  // ── render ──
  const boxByIndex = useMemo(() => new Map(boxes.map((b) => [b.index, b])), [boxes]);
  const flowW = Math.min(760, Math.max(280, size.w - 32));

  return (
    <div
      ref={scrollerRef}
      id={props.id}
      className={cx('wk-canvas', flow && 'wk-canvas--flow', swipeable && 'wk-canvas--swipe', className)}
      dir="ltr"
      tabIndex={0}
      role="region"
      aria-label={label}
      onScroll={handleScroll}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
    >
      {flow ? (
        <div ref={contentRef} className="wk-flow">
          {sheets.map((sh, i) =>
            sh.kind === 'source' ? (
              <PageView key={sh.key} seq={i} page={sh.page} geom={{ index: i, viewW: flowW, viewH: 240, top: 0, left: 0, scale: effectiveZoom, rotation: 0 }} unrotated={{ w: 1, h: 1 }} near />
            ) : (
              // paper keeps its page geometry among flowing text sections (ink needs fixed page space)
              <NotePageView key={sh.key} sheet={sh} geom={{ index: i, viewW: flowW, viewH: (flowW / sh.note.width) * sh.note.height, top: 0, left: 0, scale: flowW / sh.note.width, rotation: 0 }} near />
            ),
          )}
        </div>
      ) : (
        geometry && (
          <div
            ref={contentRef}
            className={cx('wk-content', flipDir && `wk-content--flip-${flipDir}`, layout !== 'continuous' && 'wk-content--paged')}
            style={{ width: geometry.contentW, height: geometry.contentH }}
          >
            {geometry.pages.map((g) => {
              const sh = sheets[g.index];
              const b = boxByIndex.get(g.index);
              if (!sh || !b) return null;
              if (sh.kind === 'note') {
                return <NotePageView key={sh.key} sheet={sh} geom={g} near={near.has(g.index)} style={{ position: 'absolute', top: g.top, left: g.left, width: g.viewW }} />;
              }
              const p = sh.page;
              return (
                <PageView
                  key={sh.key}
                  seq={g.index}
                  page={p}
                  geom={g}
                  unrotated={{ w: b.w, h: b.h }}
                  near={near.has(g.index)}
                  style={{ position: 'absolute', top: g.top, left: g.left, width: g.viewW }}
                />
              );
            })}
          </div>
        )
      )}
    </div>
  );
});
