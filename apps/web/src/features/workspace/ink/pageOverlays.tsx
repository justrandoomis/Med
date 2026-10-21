// The page overlays of parity N1 wave 2 (one page each, rendered by InkLayer):
//  * shape labels (G20) — the RichText inside a shape, as DOM text (bidi-correct, read by screen readers);
//  * the ruler (G08) — moved, turned and read; never ink;
//  * the zoom window's target box (G09) — where the docked strip writes; the arrow keys move it;
//  * educational measurement (G08) — set the scale from a scale bar, then lengths and angles, labelled «تقدير تعليمي»;
//  * the long-press page menu (G67) — paste here, text here, sticky here, a note page after this one (and the host's
//    «عرّف» / «أضف إلى المراجعة» on printed text, hidden until a host provides them);
//  * the neat copy (G11) — a derived drawing of the page's handwriting, never stored;
//  * snapping targets (G22) — collected once per drag from the page's items, its paper and its processed regions.
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { BookA, ClipboardPaste, FilePlus2, ListPlus, Lock, RotateCcw, RotateCw, StickyNote, Type, X } from 'lucide-react';
import { CLOSED_SHAPES, normToView, richTextToPlain, viewToNorm, type AnnotationAnchor, type ImageAnnotationData, type NormBox, type ShapeData } from '@medlevo/shared';
import { Button, IconButton, RichTextView, SegmentedControl, Select, TextField } from '../../../design';
import { fetchRegions } from '../data/api';
import { PAPER_GEOMETRY } from '../model/paper';
import type { PageMenuRequest } from './InkProvider';
import type { Vec } from './math';
import {
  angleBetween,
  calibrate,
  EDUCATIONAL_LABEL_AR,
  formatReal,
  frameAt,
  frameLength,
  loadCalibration,
  MEASURE_UNIT_LABELS_AR,
  MEASURE_UNITS,
  realLength,
  saveCalibration,
  type MeasureFrame,
  type MeasureUnit,
} from './measure';
import { isImage, isShape, itemBBox, type InkItem, type InkItemOf } from './model';
import { neatCopyItems, NEAT_COPY_LABEL_AR } from './neatCopy';
import { canvasScale, drawItem, pageMatrix, paintOrder, paperToneOf, setMatrix } from './render';
import { moveRuler, PT_PER_CM, RULER_THICKNESS, rotateRuler, rulerAngleDeg, rulerMarks, twoFingerRuler, type RulerState } from './ruler';
import { buildSnapTargets, paperPitch, type SnapTargets } from './snap';
import type { InkDocumentStore } from './store';
import type { InkPageView } from './types';
import { moveBox } from './zoomGeometry';

// ─── shape labels (G20) ─────────────────────────────────────────────────────────────────────────
/** Where a shape's label sits: the centre of its box (closed shapes) or the middle of the line, and how wide it may be. */
export function labelPlacement(d: ShapeData): {
  cx: number;
  cy: number;
  w: number;
  h: number;
  rotation: number;
} {
  const xs = d.points?.length ? d.points.map((p) => p[0]) : [d.from[0], d.to[0]];
  const ys = d.points?.length ? d.points.map((p) => p[1]) : [d.from[1], d.to[1]];
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  const closed = (CLOSED_SHAPES as readonly string[]).includes(d.shape);
  return {
    cx: (x0 + x1) / 2,
    cy: (y0 + y1) / 2,
    w: closed ? Math.max(0.04, (x1 - x0) * 0.9) : Math.max(0.12, x1 - x0),
    h: closed ? y1 - y0 : 0,
    rotation: closed && d.shape !== 'polygon' ? (d.rotation ?? 0) : 0,
  };
}

export function ShapeLabels({ items, view, hidden }: { items: ReadonlyArray<InkItemOf<ShapeData>>; view: InkPageView; hidden: (id: string) => boolean }) {
  return (
    <>
      {items.map((it) => {
        const d = it.data;
        if (!d.label || d.label.paragraphs.length === 0) return null;
        const p = labelPlacement(d);
        const [x, y] = normToView(p.cx, p.cy, view);
        const w = p.w * view.pageWidth * view.scale;
        const font = Math.max(4, (d.label_scale ?? 0.017) * view.pageWidth * view.scale);
        const turn = [view.rotation ? `rotate(${view.rotation}deg)` : '', p.rotation ? `rotate(${Math.round(p.rotation * 1e6) / 1e6}rad)` : ''].filter(Boolean).join(' ');
        const style: CSSProperties = {
          left: x - w / 2,
          top: y,
          width: w,
          fontSize: font,
          transform: `translateY(-50%)${turn ? ` ${turn}` : ''}`,
          visibility: hidden(it.id) ? 'hidden' : undefined,
        };
        return (
          <div key={it.id} className="ml-ink-shape-label" style={style} dir="auto" data-ink-id={it.id}>
            <RichTextView value={d.label} />
          </div>
        );
      })}
    </>
  );
}

// ─── the ruler (G08) ────────────────────────────────────────────────────────────────────────────
export function RulerOverlay({
  ruler,
  view,
  onChange,
  onClose,
  layerRoot,
}: {
  ruler: RulerState;
  view: InkPageView;
  onChange: (r: RulerState) => void;
  onClose: () => void;
  layerRoot: () => HTMLElement | null;
}) {
  const ar = view.pageHeight / view.pageWidth;
  const [cx, cy] = normToView(ruler.cx, ruler.cy, view);
  const len = ruler.length * view.pageWidth * view.scale;
  const thick = RULER_THICKNESS * view.pageWidth * view.scale;
  const deg = rulerAngleDeg(ruler);
  const touches = useRef(new Map<number, Vec>());
  const start = useRef<{ r: RulerState; pts: Vec[]; handle: boolean } | null>(null);
  const pxToNorm = useCallback(
    (dx: number, dy: number): Vec => {
      const r = layerRoot()?.getBoundingClientRect();
      const [ax, ay] = viewToNorm(100, 100, view);
      const [bx, by] = viewToNorm(
        100 + dx * (r && r.width ? ((view.rotation % 180 ? view.pageHeight : view.pageWidth) * view.scale) / r.width : 1),
        100 + dy * (r && r.height ? ((view.rotation % 180 ? view.pageWidth : view.pageHeight) * view.scale) / r.height : 1),
        view,
      );
      return [bx - ax, by - ay];
    },
    [view, layerRoot],
  );
  const onDown = (e: ReactPointerEvent<HTMLElement>, handle = false) => {
    e.stopPropagation();
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // best effort
    }
    touches.current.set(e.pointerId, [e.clientX, e.clientY]);
    start.current = { r: ruler, pts: [...touches.current.values()], handle };
  };
  const onMove = (e: ReactPointerEvent<HTMLElement>) => {
    if (!touches.current.has(e.pointerId) || !start.current) return;
    e.preventDefault();
    touches.current.set(e.pointerId, [e.clientX, e.clientY]);
    const now = [...touches.current.values()];
    const s = start.current;
    if (now.length >= 2 && s.pts.length >= 2) {
      // two fingers: turn and move together
      onChange(twoFingerRuler(s.r, s.pts[0]!, s.pts[1]!, now[0]!, now[1]!, pxToNorm));
    } else if (s.handle) {
      // the handle: the angle from the ruler's centre to the pointer
      const r = layerRoot()?.getBoundingClientRect();
      if (!r) return;
      const [nx, ny] = viewToNorm(
        ((e.clientX - r.left) * (view.rotation % 180 ? view.pageHeight : view.pageWidth) * view.scale) / (r.width || 1),
        ((e.clientY - r.top) * (view.rotation % 180 ? view.pageWidth : view.pageHeight) * view.scale) / (r.height || 1),
        view,
      );
      const a = Math.atan2((ny - s.r.cy) * ar, nx - s.r.cx);
      onChange(rotateRuler({ ...s.r, angle: a }, 0));
    } else {
      const [dx, dy] = pxToNorm(now[0]![0] - s.pts[0]![0], now[0]![1] - s.pts[0]![1]);
      onChange(moveRuler(s.r, dx, dy));
    }
  };
  const onUp = (e: ReactPointerEvent<HTMLElement>) => {
    touches.current.delete(e.pointerId);
    start.current = touches.current.size ? { r: ruler, pts: [...touches.current.values()], handle: false } : null;
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    const step = e.shiftKey ? 10 : 1;
    if (e.key === '[' || e.key === ']') {
      e.preventDefault();
      onChange(rotateRuler(ruler, e.key === ']' ? step : -step, false));
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    const d: Record<string, Vec> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const v = d[e.key];
    if (!v) return;
    e.preventDefault();
    e.stopPropagation();
    const [dx, dy] = pxToNorm(v[0] * view.scale, v[1] * view.scale);
    onChange(moveRuler(ruler, dx, dy));
  };
  const marks = rulerMarks(ruler, view.pageWidth);
  const angle = view.rotation + (ruler.angle * 180) / Math.PI;
  return (
    <div
      className="ml-ink-ruler"
      data-ink-ui=""
      role="group"
      tabIndex={0}
      aria-roledescription="مسطرة"
      aria-label={`المسطرة: الزاوية ${deg} درجة. الأسهم تحرّكها، و[ و ] تديرها (مع Shift عشر درجات)، Escape يخفيها. لا تُحفظ كحبر.`}
      style={{
        left: cx - len / 2,
        top: cy - thick / 2,
        width: len,
        height: thick,
        transform: `rotate(${angle}deg)`,
      }}
      onPointerDown={(e) => onDown(e)}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onKeyDown={onKeyDown}
    >
      <svg className="ml-ink-ruler__marks" width={len} height={thick} aria-hidden="true">
        {marks.map((m, i) => (
          <g key={i}>
            <line x1={m.t * len} y1={0} x2={m.t * len} y2={m.major ? thick * 0.45 : thick * 0.25} />
            {m.label && m.t * len < len - 10 && (
              <text x={m.t * len + 2} y={thick * 0.8}>
                {m.label}
              </text>
            )}
          </g>
        ))}
      </svg>
      <span className="ml-ink-ruler__handle" aria-hidden="true" onPointerDown={(e) => onDown(e, true)} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        <RotateCw size={14} />
      </span>
      <div className="ml-ink-ruler__bar" onPointerDown={(e) => e.stopPropagation()}>
        {/* the readout sits beside the buttons, never over the marks */}
        <span className="ml-ink-ruler__angle" aria-hidden="true" title={`سم على الصفحة (${(view.pageWidth / PT_PER_CM).toFixed(1)} سم عرضها)`}>
          {`${deg}° · سم`}
        </span>
        <IconButton size="sm" label="أدر المسطرة ١٥ درجة عكس عقارب الساعة" icon={<RotateCcw size={16} />} onClick={() => onChange(rotateRuler(ruler, -15, false))} />
        <IconButton size="sm" label="أدر المسطرة ١٥ درجة مع عقارب الساعة" icon={<RotateCw size={16} />} onClick={() => onChange(rotateRuler(ruler, 15, false))} />
        <IconButton size="sm" label="أخفِ المسطرة" icon={<X size={16} />} onClick={onClose} />
      </div>
    </div>
  );
}

// ─── the zoom window's target box (G09) ─────────────────────────────────────────────────────────
export function ZoomTargetBox({ box, view, onMove }: { box: NormBox; view: InkPageView; onMove: (b: NormBox) => void }) {
  const ar = view.pageHeight / view.pageWidth;
  const [x0, y0] = normToView(box.x, box.y, view);
  const [x1, y1] = normToView(box.x + box.w, box.y + box.h, view);
  const style: CSSProperties = {
    left: Math.min(x0, x1),
    top: Math.min(y0, y1),
    width: Math.abs(x1 - x0),
    height: Math.abs(y1 - y0),
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    const step = e.shiftKey ? 0.05 : 0.01;
    const d: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step / ar],
      ArrowDown: [0, step / ar],
    };
    const v = d[e.key];
    if (!v) return;
    e.preventDefault();
    e.stopPropagation();
    onMove(moveBox(box, v[0], v[1]));
  };
  return (
    <div
      className="ml-ink-zoom-target"
      style={style}
      data-ink-ui=""
      role="group"
      tabIndex={0}
      aria-label="مكان الكتابة المكبّرة على الصفحة. الأسهم تحرّكه (مع Shift خطوة أكبر)."
      onKeyDown={onKeyDown}
    />
  );
}

/** Panels fixed to the screen render at the app root: a transformed page (pinch zoom, page flip) would otherwise be their
 *  containing block. */
function portal(node: ReactNode) {
  return typeof document !== 'undefined' ? createPortal(node, document.getElementById('root') ?? document.body) : node;
}

// ─── educational measurement (G08) ───────────────────────────────────────────────────────────────
type MeasureMode = 'length' | 'angle' | 'calibrate';
export interface MeasureSession {
  mode: MeasureMode;
  segments: Array<[Vec, Vec]>;
}

export function MeasureOverlay({
  targetKey,
  view,
  session,
  setSession,
  images,
  onClose,
}: {
  targetKey: string;
  view: InkPageView;
  session: MeasureSession;
  setSession: (s: MeasureSession) => void;
  images: ReadonlyArray<InkItemOf<ImageAnnotationData>>;
  onClose: () => void;
}) {
  const ar = view.pageHeight / view.pageWidth;
  const titleId = useId();
  const seg = session.segments;
  const first = seg[0];
  const frame: MeasureFrame | null = first ? frameAt(first[0], targetKey, images, ar) : null;
  const [cal, setCal] = useState(() => (frame ? loadCalibration(frame) : null));
  const [real, setReal] = useState('');
  const [unit, setUnit] = useState<MeasureUnit>('µm');
  const frameKeyNow = frame ? (frame.kind === 'image' ? frame.imageKey : frame.targetKey) : '';
  // a different picture or page: its own scale (adjusted while rendering)
  const [calFor, setCalFor] = useState(frameKeyNow);
  if (calFor !== frameKeyNow) {
    setCalFor(frameKeyNow);
    setCal(frame ? loadCalibration(frame) : null);
  }
  const toView = (p: Vec) => normToView(p[0], p[1], view);
  let result: string | null = null;
  if (session.mode === 'length' && first && frame) {
    const len = frameLength(first[0], first[1], frame, ar);
    result = cal ? `الطول: ${formatReal(realLength(len, cal))}` : 'لم يُعايَر المقياس بعد: عايِر من شريط مقياس ظاهر لترى الطول بالوحدات.';
  } else if (session.mode === 'angle') {
    result = seg.length >= 2 ? `الزاوية بين الخطين: ${angleBetween(seg[0]!, seg[1]!, ar)}°` : seg.length === 1 ? 'اسحب الخط الثاني.' : 'اسحب الخط الأول.';
  }
  const save = () => {
    if (!first || !frame) return;
    const n = Number(real.replace(',', '.'));
    const c = calibrate(frameLength(first[0], first[1], frame, ar), n, unit);
    if (!c) return;
    saveCalibration(frame, c);
    setCal(c);
    setSession({ mode: 'length', segments: [] });
    setReal('');
  };
  return (
    <>
      <svg
        className="ml-ink-measure-lines"
        width={view.rotation % 180 ? view.pageHeight * view.scale : view.pageWidth * view.scale}
        height={view.rotation % 180 ? view.pageWidth * view.scale : view.pageHeight * view.scale}
        aria-hidden="true"
      >
        {seg.map(([a, b], i) => {
          const [x1, y1] = toView(a);
          const [x2, y2] = toView(b);
          return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} />;
        })}
      </svg>
      {portal(
        <section className="ml-ink-measure" data-ink-ui="" dir="rtl" aria-labelledby={titleId} role="region">
          <h3 id={titleId} className="ml-ink-measure__title">
            قياس تعليمي
          </h3>
          <SegmentedControl
            label="ما تقيسه"
            size="sm"
            fullWidth
            options={[
              { value: 'length', label: 'طول' },
              { value: 'angle', label: 'زاوية' },
              { value: 'calibrate', label: 'عايِر من شريط المقياس' },
            ]}
            value={session.mode}
            onValueChange={(v) => setSession({ mode: v as MeasureMode, segments: [] })}
          />
          {session.mode === 'calibrate' ? (
            first ? (
              <div className="ml-ink-measure__form">
                <TextField label="طول شريط المقياس كما هو مكتوب عليه" inputMode="decimal" value={real} onChange={(e) => setReal(e.target.value)} dir="ltr" />
                <Select
                  label="الوحدة"
                  value={unit}
                  options={MEASURE_UNITS.map((u) => ({
                    value: u,
                    label: MEASURE_UNIT_LABELS_AR[u],
                  }))}
                  onValueChange={(v) => setUnit(v as MeasureUnit)}
                />
                <Button size="sm" onClick={save} disabled={!(Number(real.replace(',', '.')) > 0)}>
                  احفظ المقياس لهذه {frame?.kind === 'image' ? 'الصورة' : 'الصفحة'}
                </Button>
              </div>
            ) : (
              <p className="ml-ink-options__note">اسحب على طول شريط المقياس في الصورة (من طرف إلى طرف)، ثم اكتب طوله.</p>
            )
          ) : (
            <p className="ml-ink-measure__result" role="status" aria-live="polite">
              {result ? <bdi>{result}</bdi> : session.mode === 'length' ? 'اسحب خطًا لتقيسه.' : null}
            </p>
          )}
          {cal && <p className="ml-ink-options__note">{`المقياس محفوظ على هذا الجهاز لهذه ${frame?.kind === 'image' ? 'الصورة' : 'الصفحة'} (${cal.unit}).`}</p>}
          <p className="ml-ink-measure__label">
            <Lock size={14} aria-hidden="true" /> {EDUCATIONAL_LABEL_AR}. يعتمد على مواضع النقاط وعلى شريط المقياس، ولا يُحفظ كحبر.
          </p>
          <div className="ml-ink-measure__actions">
            <Button size="sm" variant="plain" onClick={() => setSession({ ...session, segments: [] })}>
              امسح القياس
            </Button>
            <Button size="sm" variant="plain" onClick={onClose}>
              أغلق
            </Button>
          </div>
        </section>,
      )}
    </>
  );
}

/** The measure session after one more segment (length: one, angle: two, calibrate: one). */
export function addSegment(s: MeasureSession, a: Vec, b: Vec): MeasureSession {
  if (s.mode === 'angle')
    return {
      ...s,
      segments: s.segments.length >= 2 ? [[a, b]] : [...s.segments, [a, b]],
    };
  return { ...s, segments: [[a, b]] };
}

// ─── the long-press page menu (G67) ──────────────────────────────────────────────────────────────
export interface PageMenuActions {
  paste: (() => void) | null;
  pasteReason: string;
  text: () => void;
  sticky: () => void;
  notePageAfter: (() => void) | null;
  define: (() => void) | null;
  review: (() => void) | null;
  neat: { on: boolean; toggle: () => void };
}

export function PageMenu({ req, view, actions, onClose }: { req: PageMenuRequest; view: InkPageView; actions: PageMenuActions; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  /** (review of N1 wave 2) where the focus was when the menu opened: Escape / Tab give it back there */
  const returnTo = useRef<HTMLElement | null>(null);
  const [x, y] = normToView(req.at[0], req.at[1], view);
  const W = view.rotation % 180 ? view.pageHeight * view.scale : view.pageWidth * view.scale;
  useLayoutEffect(() => {
    const before = document.activeElement;
    returnTo.current = before instanceof HTMLElement && before !== document.body && !ref.current?.contains(before) ? before : null;
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')?.focus();
  }, []);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [onClose]);
  const run = (fn: (() => void) | null) => () => {
    if (!fn) return;
    onClose();
    fn();
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const list = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? []);
    const i = list.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      const back = returnTo.current;
      onClose();
      if (back?.isConnected) back.focus();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      list[(i + 1) % list.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      list[(i - 1 + list.length) % list.length]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      list[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      list[list.length - 1]?.focus();
    }
  };
  const item = (label: string, icon: React.ReactNode, fn: (() => void) | null, reason?: string) => (
    <button type="button" role="menuitem" className="ml-ink-pagemenu__item" aria-disabled={fn ? undefined : true} onClick={run(fn)} title={!fn ? reason : undefined}>
      <span aria-hidden="true">{icon}</span>
      <span>{label}</span>
      {!fn && reason && <span className="ml-ink-pagemenu__reason">{reason}</span>}
    </button>
  );
  return (
    <div
      ref={ref}
      className="ml-ink-pagemenu"
      role="menu"
      aria-label={req.printed ? 'قائمة النص المطبوع' : 'قائمة الصفحة'}
      data-ink-ui=""
      dir="rtl"
      style={{
        left: Math.min(Math.max(8, x - 8), Math.max(8, W - 248)),
        top: y + 8,
      }}
      onKeyDown={onKeyDown}
    >
      {req.printed && actions.define && item('عرّف', <BookA size={16} />, actions.define)}
      {req.printed && actions.review && item('أضف إلى المراجعة', <ListPlus size={16} />, actions.review)}
      {item('الصق هنا', <ClipboardPaste size={16} />, actions.paste, actions.pasteReason)}
      {item('نص هنا', <Type size={16} />, actions.text)}
      {item('ملاحظة لاصقة هنا', <StickyNote size={16} />, actions.sticky)}
      {actions.notePageAfter && item('صفحة ملاحظات بعد هذه الصفحة', <FilePlus2 size={16} />, actions.notePageAfter)}
      {item(actions.neat.on ? 'اعرض الحبر كما كتبته' : 'النسخة المرتبة لهذه الصفحة (عرض فقط)', <RotateCw size={16} />, actions.neat.toggle)}
    </div>
  );
}

/** Is the press on printed text of the page (a text-layer span with letters)? */
export function printedTextAt(target: EventTarget | null): string | null {
  const el = target instanceof Element ? target : null;
  if (!el || el.closest('[data-ink-ui], .ml-ink-layer')) return null;
  const span = el.closest('.textLayer span, [data-region-id], .wk-textlayer span, .wk-ocr span, .wk-text p') as HTMLElement | null;
  const t = (span ?? el).textContent?.trim() ?? '';
  return span && t ? t.slice(0, 200) : null;
}

// ─── the neat copy (G11) ─────────────────────────────────────────────────────────────────────────
export function NeatCopyCanvas({ store, targetKey, view, dir }: { store: InkDocumentStore; targetKey: string; view: InkPageView; dir: 'rtl' | 'ltr' }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => store.subscribePage(targetKey, (e) => (e.kind === 'items' || e.kind === 'loaded' || e.kind === 'view') && setVersion((v) => v + 1)), [store, targetKey]);
  const ar = view.pageHeight / view.pageWidth;
  // (review of N1 wave 2) derived once per change of the page's writing (or of the layers shown) — a zoom or pinch step
  // only redraws it
  const items = useMemo(
    () =>
      neatCopyItems(
        store.items(targetKey).filter((it) => store.isVisible(it) && (it.kind === 'shape' || (it.kind === 'ink' && (it.data as { style?: { tool?: string } }).style?.tool !== 'highlighter'))),
        ar,
        dir,
      ).sort(paintOrder),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `version` is the page's change counter (the store is mutable)
    [store, targetKey, ar, dir, version],
  );
  useLayoutEffect(() => {
    const c = ref.current;
    if (!c) return;
    const w = view.rotation % 180 ? view.pageHeight * view.scale : view.pageWidth * view.scale;
    const h = view.rotation % 180 ? view.pageWidth * view.scale : view.pageHeight * view.scale;
    const dpr = canvasScale(w, h, typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);
    c.width = Math.max(1, Math.round(w * dpr));
    c.height = Math.max(1, Math.round(h * dpr));
    c.style.width = `${w}px`;
    c.style.height = `${h}px`;
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = c.getContext('2d');
    } catch {
      ctx = null;
    }
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    setMatrix(ctx, pageMatrix(view, dpr));
    const env = {
      W: view.pageWidth,
      H: view.pageHeight,
      tone: paperToneOf(c),
      css: (() => {
        try {
          return getComputedStyle(c);
        } catch {
          return null;
        }
      })(),
    };
    for (const it of items) drawItem(ctx, it, env);
  }, [items, view]);
  return <canvas ref={ref} className="ml-ink-layer__canvas ml-ink-layer__canvas--neat" aria-hidden="true" />;
}

export function NeatCopyBanner({ onOff }: { onOff: () => void }) {
  return (
    <p className="ml-ink-neat-banner" data-ink-ui="" dir="rtl" role="note">
      <span>{NEAT_COPY_LABEL_AR}</span>
      <button type="button" className="ml-ink-linkbtn" onClick={onOff}>
        اعرض الحبر كما كتبته
      </button>
    </p>
  );
}

// ─── snapping targets (G22) ──────────────────────────────────────────────────────────────────────
const regionBoxes = new Map<string, NormBox[] | Promise<NormBox[]>>();

/** The processed regions of a lecture page (loaded once per page; [] offline or for note pages). */
export function pageRegions(anchor: AnnotationAnchor | null): NormBox[] | null {
  if (!anchor || anchor.type !== 'page') return [];
  const hit = regionBoxes.get(anchor.page_id);
  if (Array.isArray(hit)) return hit;
  if (!hit) {
    const p = fetchRegions(anchor.page_id)
      .then((r) => r.regions.map((g) => g.bbox).filter((b): b is NormBox => !!b && b.w > 0 && b.h > 0 && b.w < 0.98))
      .catch(() => [] as NormBox[])
      .then((boxes) => {
        regionBoxes.set(anchor.page_id, boxes);
        return boxes;
      });
    regionBoxes.set(anchor.page_id, p);
  }
  return null;
}

/** Tests only. */
export function __setPageRegions(pageId: string, boxes: NormBox[]): void {
  regionBoxes.set(pageId, boxes);
}

/**
 * What a moving selection or a shape being drawn snaps to on this page: other visible items, the paper's pitch (note
 * pages) and the processed regions (lecture pages) — each as the owner's settings allow. `exclude`: the moving items.
 */
export function snapTargetsFor(
  store: InkDocumentStore,
  targetKey: string,
  anchor: AnnotationAnchor | null,
  layerRoot: HTMLElement | null,
  view: InkPageView,
  snap: { enabled: boolean; items: boolean; grid: boolean; regions: boolean } | undefined,
  exclude: ReadonlySet<string> = new Set(),
): SnapTargets | null {
  if (!snap || !snap.enabled) return null;
  const ar = view.pageHeight / view.pageWidth;
  const items = snap.items
    ? store
        .items(targetKey)
        .filter((it) => !exclude.has(it.id) && store.isVisible(it))
        .map((it) => itemBBox(it, ar))
    : [];
  const loaded = snap.regions ? pageRegions(anchor) : [];
  const template = snap.grid ? (layerRoot?.closest('[data-template]')?.getAttribute('data-template') ?? null) : null;
  const pitch = template ? paperPitch(template, view.pageWidth, view.pageHeight, PAPER_GEOMETRY) : null;
  const t = buildSnapTargets({ items, regions: loaded ?? [], pitch });
  return loaded === null ? { ...t, partial: true } : t;
}

/** Shapes of a page that carry a label (for ShapeLabels). */
export function useLabelledShapes(items: readonly InkItem[]): Array<InkItemOf<ShapeData>> {
  return useMemo(() => items.filter((i): i is InkItemOf<ShapeData> => isShape(i) && !!i.data.label && richTextToPlain(i.data.label).trim() !== ''), [items]);
}

/** Pictures of a page (the measurement uses their own pixels). */
export function imagesOf(items: readonly InkItem[]): Array<InkItemOf<ImageAnnotationData>> {
  return items.filter((i): i is InkItemOf<ImageAnnotationData> => isImage(i));
}

/** The label editor of a shape: plain text in, RichText out (bidi-safe, terms isolated by the shared RichText). */
export function ShapeLabelEditor({ item, view, onSave, onCancel }: { item: InkItemOf<ShapeData>; view: InkPageView; onSave: (text: string) => void; onCancel: () => void }) {
  const p = labelPlacement(item.data);
  const [x, y] = normToView(p.cx, p.cy, view);
  const [value, setValue] = useState(() => (item.data.label ? richTextToPlain(item.data.label) : ''));
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const w = Math.max(160, p.w * view.pageWidth * view.scale);
  return (
    <div className="ml-ink-sticky-card ml-ink-label-editor" style={{ left: Math.max(0, x - w / 2), top: y + 8, width: w }} data-ink-ui="" dir="rtl">
      <label className="ml-visually-hidden" htmlFor={`label-${item.id}`}>
        النص داخل الشكل
      </label>
      <textarea
        id={`label-${item.id}`}
        ref={ref}
        className="ml-ink-sticky-card__input"
        value={value}
        maxLength={500}
        rows={2}
        dir="auto"
        placeholder="مثلًا: الإنسولين Insulin"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            onSave(value);
          }
        }}
      />
      <div className="ml-ink-sticky-card__actions">
        <button type="button" className="ml-ink-linkbtn" onClick={onCancel}>
          إلغاء
        </button>
        <button type="button" className="ml-ink-linkbtn" onClick={() => onSave(value)}>
          تم
        </button>
      </div>
    </div>
  );
}
