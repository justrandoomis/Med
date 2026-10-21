// Lasso selection: frame with move / resize / rotate handles and an action bar
// (colour, width, duplicate, delete, copy, layer order, lock, undo shape enhancement).
// (parity N1, G19) Resizing is free for shapes, text boxes and strokes (Shift keeps the proportions, Alt resizes about the
// centre); a selection with a picture or a link keeps its proportions. Text boxes and pictures turn with the rotate handle
// (their rotation is kept in page space). The frame is a focusable group with an Arabic name: the arrow keys move the
// selection 1 point (Shift: 10) in the direction pressed on screen, Delete removes it, Escape clears it.
// Dragging is 1:1 with the pointer and never re-renders React per move: the frame follows through
// a CSS matrix on a ref, the selected items are drawn transformed on the live canvas, and the
// change is committed once (one undo step) on release.
import { useEffect, useId, useInsertionEffect, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { ArrowDownToLine, ArrowUpToLine, Brain, Clock, Copy, CopyPlus, Ellipsis, FileQuestion, Layers, Lock, LockOpen, MessageCircleQuestion, Network, Palette, Play, Plus, RotateCw, ScanText, Shapes, SpellCheck2, Trash2, Type, Undo2, Minus, WrapText, AlignHorizontalJustifyCenter } from 'lucide-react';
import { newId, normBoxToView, normToView, shapeSidePoint, SHAPE_SIDES, viewToNorm, type NormBox, type ShapeData, type ShapeSide } from '@medlevo/shared';
import { useCapabilities } from '../../../lib/capabilities';
import { autoLayoutPlan, connectedShapePlan, isConnector } from './connectors';
import { straightenPlan } from './handwritingLayout';
import { isClosedShape, nowMs } from './model';
import { snapTargetsFor } from './pageOverlays';
import { ConceptDialog, ReflowDialog, RelationCheckDialog, ShapePropsDialog } from './shapeDialogs';
import { snapMove, type SnapTargets } from './snap';
import { IconButton, Menu, MenuItem, MenuSeparator, Toolbar, Tooltip } from '../../../design';
import { useInkInternal } from './InkProvider';
import type { PageInkController } from './layerController';
import { IDENTITY, invertMat, isIdentity, multiply, rotateAbout, scaleAbout, translate, type Mat, type Vec } from './math';
import { canStretch, isInkStroke, isShape, limitScaleToRange, limitStretchToRange, revertEnhancement, type InkItem } from './model';
import { colorLabel, resolveInkColor } from './palette';
import { slotsFor } from './inkSettings';
import { pageMatrix } from './render';
import { usePaperTone } from './usePaperTone';
import { audioLinkOf, formatOffset } from './audioLink';
import { NO_ASK_HOST_AR, NO_CARD_HOST_AR, NO_RECOGNITION_HOST_AR, useInkSelectionActions } from './selectionActions';
import type { InkPageView } from './types';

type Mode = { kind: 'move' } | { kind: 'rotate' } | { kind: 'scale'; corner: 0 | 1 | 2 | 3 };
/** (N1, G19) modifier keys held during a resize */
interface Mods {
  shift: boolean;
  alt: boolean;
}

function isTyping(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || (t.tagName === 'INPUT' && !['button', 'checkbox', 'radio', 'range', 'color'].includes((t as HTMLInputElement).type));
}

const PEN_WIDTHS = [
  { label: 'رفيع', w: 0.0015 },
  { label: 'متوسط', w: 0.0028 },
  { label: 'عريض', w: 0.0055 },
];
const HL_WIDTHS = [
  { label: 'رفيع', w: 0.012 },
  { label: 'متوسط', w: 0.018 },
  { label: 'عريض', w: 0.028 },
];

function corners(b: NormBox): Vec[] {
  return [
    [b.x, b.y],
    [b.x + b.w, b.y],
    [b.x + b.w, b.y + b.h],
    [b.x, b.y + b.h],
  ];
}

export function SelectionOverlay({
  targetKey,
  view,
  controller,
  onStrokeActiveChange,
  onEditLabel,
}: {
  targetKey: string;
  view: InkPageView;
  controller: RefObject<PageInkController | null>;
  onStrokeActiveChange: (active: boolean) => void;
  /** (N1 wave 2, G20) open the label editor of a shape */
  onEditLabel?: (id: string) => void;
}) {
  const { store, announce, inkSettings, toolRef } = useInkInternal();
  const caps = useCapabilities();
  // (N1 wave 2) the dialogs of the selection and the snapping targets of a drag (collected once when it starts)
  const [dialog, setDialog] = useState<null | { kind: 'props' | 'concept' | 'relations' | 'reflow'; ids: string[] }>(null);
  const snapRef = useRef<SnapTargets | null>(null);
  const actions = useInkSelectionActions();
  const helpId = useId();
  useSyncExternalStore(store.subscribeSelection, store.getSelectionVersion, store.getSelectionVersion);
  const [, setItemsVersion] = useState(0);
  useEffect(() => store.subscribePage(targetKey, (e) => e.kind === 'items' && setItemsVersion((v) => v + 1)), [store, targetKey]);
  const frameRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ mode: Mode; pointerId: number; start: Vec; bbox: NormBox; m: Mat; ids: string[]; free: boolean } | null>(null);
  const activeRef = useRef(onStrokeActiveChange);
  // the latest callback for the unmount cleanup, written at commit (before any layout effect) rather than during render
  useInsertionEffect(() => {
    activeRef.current = onStrokeActiveChange;
  });
  const tone = usePaperTone(frameRef);
  // (N1, G19) arrow keys move the selection in the direction pressed on screen (1 point; Shift: 10)
  const viewRef = useRef(view);
  useInsertionEffect(() => {
    viewRef.current = view;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target) || document.querySelector('[aria-modal="true"]')) return;
      const dirs: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      const d = dirs[e.key];
      const sel = store.getSelection();
      if (!d || !sel || sel.targetKey !== targetKey || drag.current) return;
      // (review) only when the keyboard is on the selection, on a page's ink, or on nothing in particular: a slider, a
      // radio group or a check box elsewhere keeps its own arrows (they must never move the owner's ink instead)
      const focus = document.activeElement;
      if (focus && focus !== document.body && focus !== document.documentElement && !focus.closest?.('.ml-ink-layer')) return;
      e.preventDefault();
      // the reader turns pages with the arrows: the selection has them now
      e.stopPropagation();
      const v = viewRef.current;
      const units = e.shiftKey ? 10 : 1;
      const px = units * v.scale; // css px per page unit
      const [x0, y0] = viewToNorm(100, 100, v);
      const [x1, y1] = viewToNorm(100 + d[0] * px, 100 + d[1] * px, v);
      const ar = v.pageHeight / v.pageWidth;
      store.nudgeSelection(x1 - x0, (y1 - y0) * ar);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [store, targetKey]);
  // The overlay can disappear in the middle of a drag (Escape / Delete / a tool shortcut clears the
  // selection): cancel the drag so the items never stay hidden and the reader is not left thinking a
  // gesture is still running (it blocks page flips meanwhile).
  useEffect(
    () => () => {
      const d = drag.current;
      if (!d) return;
      drag.current = null;
      controller.current?.setTransformPreview(null);
      store.setHidden(targetKey, d.ids, false);
      activeRef.current(false);
    },
    [store, targetKey, controller],
  );

  // (N1, G19) a new selection takes the keyboard (the arrows move it, Delete removes it) unless the owner is typing or in
  // a dialog / menu; a press on the page does not move focus by itself (the pen's pointerdown is default-prevented)
  const current = store.getSelection();
  const selKey = current && current.targetKey === targetKey ? current.ids.join(',') : '';
  useEffect(() => {
    const el = frameRef.current;
    if (!selKey || !el) return;
    const active = document.activeElement;
    if (isTyping(active) || active?.closest?.('[role="dialog"],[role="menu"],[role="listbox"]')) return;
    el.focus({ preventScroll: true });
  }, [selKey]);

  const items = store.selectedItems();
  const bbox = store.selectionBBox();
  if (!bbox || items.length === 0) return null;
  const ar = view.pageHeight / view.pageWidth;
  // (P1-T2, R5) items of a read-only layer (a followed explanation, a snapshot) are copied, never moved or changed
  const readOnly = items.some((i) => !store.isEditable(i));
  const locked = readOnly || items.some((i) => i.locked);
  const rect = normBoxToView(bbox, view);
  const handles = corners(bbox).map((c) => normToView(c[0], c[1], view));
  const allHighlighter = items.every((i) => isInkStroke(i) && i.data.style.tool === 'highlighter');
  const hasStyled = items.some((i) => isInkStroke(i) || isShape(i));
  const enhanced = items.length === 1 && isShape(items[0]!) && !!items[0]!.data.recognized_from ? items[0]! : null;
  const layerW = view.rotation === 90 || view.rotation === 270 ? view.pageHeight * view.scale : view.pageWidth * view.scale;

  const toIso = (clientX: number, clientY: number): Vec => {
    const layer = frameRef.current?.closest('.ml-ink-layer') as HTMLElement | null;
    const r = layer?.getBoundingClientRect();
    if (!r) return [0, 0];
    const vw = layerW;
    const vh = view.rotation === 90 || view.rotation === 270 ? view.pageWidth * view.scale : view.pageHeight * view.scale;
    const [x, y] = viewToNorm(((clientX - r.left) * vw) / (r.width || vw), ((clientY - r.top) * vh) / (r.height || vh), view);
    return [x, y * ar];
  };

  // (N1, G19) a free resize stretches; a selection with a picture, a link or a rotated box keeps its proportions
  const freeResize = items.every(canStretch);
  const matrixFor = (mode: Mode, start: Vec, cur: Vec, b: NormBox, mods: Mods = { shift: false, alt: false }, free = false): Mat => {
    if (mode.kind === 'move') {
      let dx = cur[0] - start[0];
      let dy = cur[1] - start[1];
      // (N1 wave 2, G22) edges and centre snap to the page's guides (Alt held: no snapping)
      const targets = mods.alt ? null : snapRef.current;
      if (targets) {
        const tol = 8 / (view.pageWidth * view.scale);
        const r = snapMove(b, dx, dy / ar, targets, { x: tol, y: tol / ar });
        dx = r.dx;
        dy = r.dy * ar;
        controller.current?.setGuides(r.guides);
      } else controller.current?.setGuides([]);
      // keep the selection's centre on the page
      const cx = b.x + b.w / 2;
      const cy = (b.y + b.h / 2) * ar;
      dx = Math.min(1 - cx, Math.max(-cx, dx));
      dy = Math.min(ar - cy, Math.max(-cy, dy));
      return translate(dx, dy);
    }
    const iso = corners(b).map((c): Vec => [c[0], c[1] * ar]);
    if (mode.kind === 'scale') {
      const corner = iso[mode.corner]!;
      // Alt: about the centre; otherwise about the opposite corner
      const anchor: Vec = mods.alt ? [b.x + b.w / 2, (b.y + b.h / 2) * ar] : iso[(mode.corner + 2) % 4]!;
      const dxv = corner[0] - anchor[0];
      const dyv = corner[1] - anchor[1];
      if (free && !mods.shift && Math.abs(dxv) > 1e-9 && Math.abs(dyv) > 1e-9) {
        const rx = Math.min(20, Math.max(0.05, (cur[0] - anchor[0]) / dxv));
        const ry = Math.min(20, Math.max(0.05, (cur[1] - anchor[1]) / dyv));
        const [sx, sy] = limitStretchToRange(rx, ry, anchor, b, ar);
        return [sx, 0, 0, sy, anchor[0] - sx * anchor[0], anchor[1] - sy * anchor[1]];
      }
      const len2 = dxv * dxv + dyv * dyv;
      if (len2 < 1e-12) return IDENTITY;
      const raw = Math.min(20, Math.max(0.05, ((cur[0] - anchor[0]) * dxv + (cur[1] - anchor[1]) * dyv) / len2));
      // stop at the edge of what can be stored (and synced) instead of flattening the far side
      const s = limitScaleToRange(raw, anchor, b, ar);
      return scaleAbout(s, anchor[0], anchor[1]);
    }
    const c: Vec = [b.x + b.w / 2, (b.y + b.h / 2) * ar];
    let angle = Math.atan2(cur[1] - c[1], cur[0] - c[0]) - Math.atan2(start[1] - c[1], start[0] - c[0]);
    const step = Math.PI / 12; // snap to 15° when close
    const snapped = Math.round(angle / step) * step;
    if (Math.abs(angle - snapped) < (4 * Math.PI) / 180) angle = snapped;
    return rotateAbout(angle, c[0], c[1]);
  };

  /** iso-space matrix → css matrix in the layer's view space (for the frame feedback) */
  const viewCss = (m: Mat): string => {
    const P = pageMatrix(view, 1);
    const Pinv = invertMat(P) ?? IDENTITY;
    const W = view.pageWidth;
    const T = multiply(P, multiply([W, 0, 0, W, 0, 0], multiply(m, multiply([1 / W, 0, 0, 1 / W, 0, 0], Pinv))));
    return `matrix(${T.join(',')})`;
  };

  const collectSnap = () => snapTargetsFor(store, targetKey, store.page(targetKey)?.anchor ?? null, frameRef.current?.closest('.ml-ink-layer') as HTMLElement | null, view, toolRef.current.snap, new Set(items.map((i) => i.id)));
  const begin = (mode: Mode, e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    if (locked) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // best effort
    }
    drag.current = { mode, pointerId: e.pointerId, start: toIso(e.clientX, e.clientY), bbox, m: IDENTITY, ids: items.map((i) => i.id), free: freeResize };
    // (N1 wave 2, G22) what a move snaps to: collected once, here (never per pointer move — only again while the page's
    // processed regions are still loading)
    snapRef.current = mode.kind === 'move' ? collectSnap() : null;
    store.setHidden(targetKey, items.map((i) => i.id), true);
    controller.current?.setTransformPreview(IDENTITY);
    if (barRef.current) barRef.current.style.visibility = 'hidden';
    onStrokeActiveChange(true);
  };

  const move = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    e.preventDefault();
    if (snapRef.current?.partial) snapRef.current = collectSnap();
    d.m = matrixFor(d.mode, d.start, toIso(e.clientX, e.clientY), d.bbox, { shift: e.shiftKey, alt: e.altKey }, d.free);
    controller.current?.setTransformPreview(d.m);
    if (frameRef.current) frameRef.current.style.transform = viewCss(d.m);
  };

  const end = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    drag.current = null;
    snapRef.current = null;
    controller.current?.setGuides([]);
    controller.current?.setTransformPreview(null);
    store.setHidden(targetKey, d.ids, false);
    if (frameRef.current) frameRef.current.style.transform = '';
    if (barRef.current) barRef.current.style.visibility = '';
    if (!isIdentity(d.m, 1e-9)) store.transformSelection(d.m);
    onStrokeActiveChange(false);
  };

  const colors = slotsFor(inkSettings, allHighlighter ? 'highlighter' : 'pen');
  const meaningsHere = [...new Set(items.map((i) => (isInkStroke(i) || isShape(i) ? i.data.style.meaning : undefined)).filter((m): m is string => !!m))];
  const widths = allHighlighter ? HL_WIDTHS : PEN_WIDTHS;
  // above the rotate handle when there is room, otherwise below the frame (never covering a handle)
  const barTop = rect.top >= 100 ? rect.top - 96 : rect.top + rect.height + 14;
  const barCenter = Math.min(Math.max(rect.left + rect.width / 2, 150), Math.max(150, layerW - 150));

  // (track F4) handwriting: what the screen around the engine offers for this selection
  const page = store.page(targetKey);
  const selInfo = () => ({ targetKey, anchor: page?.anchor ?? null, items, bbox, ar: page?.ar ?? ar });
  const hasWriting = items.some((i) => isInkStroke(i) || isShape(i));
  const convertReason = !hasWriting ? 'حدّد كتابة بالقلم (لا نصًا مطبوعًا أو صورة).' : actions?.convert ? actions.convert.reason : NO_RECOGNITION_HOST_AR;
  const askReason = !hasWriting ? 'حدّد كتابة بالقلم بجانب فقرة.' : actions?.ask ? actions.ask.reason : NO_ASK_HOST_AR;
  // (H3 item 4) a card / an owner question from the selection (the dialog says what needs a reading or the server)
  const unloaded = !page?.anchor ? 'الصفحة لم تُحمَّل بعد.' : null;
  const cardReason = unloaded ?? (actions?.card ? actions.card.reason : NO_CARD_HOST_AR);
  const questionReason = unloaded ?? (actions?.question ? actions.question.reason : NO_CARD_HOST_AR);
  // time link of the earliest linked stroke in the selection (written during an in-app recording)
  const linked = items
    .map((i) => ({ item: i, link: audioLinkOf(i) }))
    .filter((x): x is { item: InkItem; link: NonNullable<ReturnType<typeof audioLinkOf>> } => !!x.link)
    .sort((a, b) => a.link.offset_ms - b.link.offset_ms)[0];

  // ── (parity N1 wave 2) shapes, connectors, handwriting layout ──
  const shapes = items.filter(isShape);
  const closedShapes = items.filter(isClosedShape);
  const strokes = items.filter(isInkStroke);
  const single = items.length === 1 && closedShapes.length === 1 ? closedShapes[0]! : null;
  const connectors = items.filter(isConnector);
  const recognition = caps.feature('workspace.handwriting_recognition');
  const reflowReason = strokes.length === 0 ? 'حدّد كتابة بالقلم.' : !recognition.available ? `إعادة ترتيب الكلمات تحتاج قراءة الخط: ${recognition.reason ?? 'غير متاحة الآن.'}` : null;
  const openDialog = (kind: 'props' | 'concept' | 'relations' | 'reflow') => setDialog({ kind, ids: items.map((i) => i.id) });
  const straighten = () => {
    const plan = straightenPlan(items, { targetKey, ar, now: nowMs(), movable: (it) => store.isEditable(it) && !it.locked });
    if (plan.changes.length === 0) {
      announce('الأسطر المحددة مستقيمة أصلًا (أو مائلة كثيرًا فتُعدّ رسمًا): لم يتغير شيء.');
      return;
    }
    store.commit('استقامة الكتابة', plan.changes);
    announce(`استقام ${plan.lines.toLocaleString('ar-EG')} سطر — تحرّكت الكلمات كاملة ولم يتغير شكل أي حرف. يمكنك التراجع.`);
  };
  const autoLayout = () => {
    const pageConnectors = store.items(targetKey).filter(isConnector);
    const rtl = typeof document === 'undefined' || document.documentElement.dir !== 'ltr';
    const plan = autoLayoutPlan(closedShapes, pageConnectors, ar, rtl, nowMs()).map((c) => ({ ...c, targetKey }));
    if (plan.length === 0) {
      announce('الأشكال مرتبة أصلًا.');
      return;
    }
    store.commit('ترتيب تلقائي', plan);
    announce(`رُتّب ${plan.length.toLocaleString('ar-EG')} شكل في مخطط؛ تبعتها الموصِّلات. يمكنك التراجع.`);
  };
  const addConnected = (side: ShapeSide) => {
    if (!single) return;
    const plan = connectedShapePlan(single, side, ar, nowMs(), { shape: newId(), connector: newId() }, store.nextZ(targetKey));
    store.commit('شكل متصل', [
      { id: plan.shape.id, targetKey, before: null, after: plan.shape },
      { id: plan.connector.id, targetKey, before: null, after: plan.connector },
    ]);
    store.setSelection({ targetKey, ids: [plan.shape.id] });
    announce('أُضيف شكل متصل وموصِّل إليه. يمكنك التراجع.');
  };
  const SIDE_NAMES: Record<ShapeSide, string> = { n: 'الأعلى', s: 'الأسفل', e: 'اليمين', w: 'اليسار' };

  const undoEnhancement = (shape: InkItem) => {
    const after = revertEnhancement(shape, nowMs());
    if (!after) return;
    store.commit('إلغاء تحسين الشكل', [{ id: shape.id, targetKey, before: shape, after }]);
    announce('أُعيد الخط الأصلي');
  };

  return (
    <>
      <div
        ref={frameRef}
        className="ml-ink-selection"
        style={{ left: rect.left - 4, top: rect.top - 4, width: rect.width + 8, height: rect.height + 8, transformOrigin: `${-(rect.left - 4)}px ${-(rect.top - 4)}px` }}
        data-ink-ui=""
        data-locked={locked ? '' : undefined}
        data-read-only={readOnly ? '' : undefined}
        role="group"
        tabIndex={0}
        aria-roledescription="تحديد"
        aria-label={`المحدد: ${items.length.toLocaleString('ar-EG')} عنصر${meaningsHere.length ? ` (${meaningsHere.map((m) => `«${m}»`).join('، ')})` : ''}${locked ? '، مقفل أو للقراءة فقط' : ''}`}
        aria-describedby={helpId}
        onPointerDown={(e) => begin({ kind: 'move' }, e)}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
      >
        {!locked && (
          <span className="ml-ink-selection__rotate" aria-hidden="true" onPointerDown={(e) => begin({ kind: 'rotate' }, e)} onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
            <RotateCw size={14} />
          </span>
        )}
        {locked && (
          <span className="ml-ink-selection__lock" aria-hidden="true">
            <Lock size={14} />
          </span>
        )}
        <span id={helpId} className="ml-visually-hidden">
          {locked ? 'يمكن نسخه فقط. Escape يلغي التحديد.' : 'الأسهم تحرّكه نقطة واحدة (مع Shift عشر نقاط)، Delete يحذفه، Escape يلغي التحديد. سحب الزوايا يغيّر الحجم (Shift يحفظ النسبة، Alt حول المركز).'}
        </span>
      </div>
      {!locked &&
        handles.map(([hx, hy], i) => (
          <span
            key={i}
            className="ml-ink-handle"
            style={{ left: hx, top: hy }}
            data-ink-ui=""
            aria-hidden="true"
            onPointerDown={(e) => begin({ kind: 'scale', corner: i as 0 | 1 | 2 | 3 }, e)}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
          />
        ))}
      <div ref={barRef} className="ml-ink-selbar" style={{ top: barTop, left: barCenter }} data-ink-ui="" dir="rtl">
        <Toolbar label={`إجراءات التحديد (${items.length} عنصر)`}>
          {linked && actions?.playAudio && (
            <Tooltip content={linked.link.origin === 'auto' ? 'رابط زمني تلقائي: كُتب أثناء التسجيل' : 'رابط زمني عدّلته بنفسك'} describe={false}>
              <IconButton
                label={`استمع من ${formatOffset(linked.link.offset_ms)} في التسجيل (${linked.link.origin === 'auto' ? 'رابط تلقائي' : 'رابط يدوي'})`}
                icon={<Play size={18} />}
                size="sm"
                onClick={() => actions.playAudio!(linked.link)}
              />
            </Tooltip>
          )}
          {readOnly ? (
            <>
              <span className="ml-ink-selbar__note" role="note">
                للقراءة فقط
              </span>
              <Tooltip content="ينسخ المحدد في مكانه إلى الطبقة التي تكتب عليها؛ يبقى الأصل كما هو" describe={false}>
                <IconButton
                  label="انسخ إلى طبقتي"
                  icon={<CopyPlus size={18} />}
                  size="sm"
                  onClick={() => {
                    const n = store.copySelectionToActiveLayer();
                    announce(n ? `نُسخ ${n} عنصر إلى طبقتك؛ بقي الأصل كما هو.` : 'لا يوجد ما يُنسخ.');
                  }}
                />
              </Tooltip>
            </>
          ) : locked ? (
            <Tooltip content="فك القفل" describe={false}>
              <IconButton label="فك القفل" icon={<LockOpen size={18} />} size="sm" onClick={() => store.setSelectionLocked(false)} />
            </Tooltip>
          ) : (
            <>
              {hasStyled && (
                <Menu label="تغيير اللون" trigger={<IconButton label="تغيير اللون" icon={<Palette size={18} />} size="sm" />}>
                  {colors.map((c, i) => (
                    <MenuItem key={`${i}:${c.color}`} icon={<span className="ml-ink-swatch ml-ink-swatch--sm" style={{ background: resolveInkColor(c.color, tone, null) }} />} onSelect={() => store.recolorSelection(c.color, c.meaning ?? null)}>
                      {c.meaning ? `${colorLabel(c.color)} — ${c.meaning}` : colorLabel(c.color)}
                    </MenuItem>
                  ))}
                </Menu>
              )}
              {hasStyled && (
                <Menu label="تغيير السماكة" trigger={<IconButton label="تغيير السماكة" icon={<Minus size={18} strokeWidth={3} />} size="sm" />}>
                  {widths.map((w) => (
                    <MenuItem key={w.label} onSelect={() => store.rewidthSelection(w.w)}>
                      {w.label}
                    </MenuItem>
                  ))}
                </Menu>
              )}
              <Tooltip content="تكرار (Ctrl+D)" describe={false}>
                <IconButton label="تكرار" icon={<CopyPlus size={18} />} size="sm" onClick={() => store.duplicateSelection()} />
              </Tooltip>
              <Tooltip content="حذف (Delete)" describe={false}>
                <IconButton
                  label="حذف"
                  icon={<Trash2 size={18} />}
                  size="sm"
                  onClick={() => {
                    store.deleteSelection();
                    announce('حُذف التحديد. يمكنك التراجع.');
                  }}
                />
              </Tooltip>
            </>
          )}
          <Menu label="المزيد من إجراءات التحديد" trigger={<IconButton label="المزيد" icon={<Ellipsis size={18} />} size="sm" />}>
            <MenuItem icon={<Copy size={16} />} hint="Ctrl+C" onSelect={() => announce(`نُسخ ${store.copySelection()} عنصر؛ الصقه في أي صفحة.`)}>
              نسخ
            </MenuItem>
            {!locked && (
              <>
                <MenuItem icon={<ArrowUpToLine size={16} />} onSelect={() => store.restackSelection(true)}>
                  إحضار إلى الأمام
                </MenuItem>
                <MenuItem icon={<ArrowDownToLine size={16} />} onSelect={() => store.restackSelection(false)}>
                  إرسال إلى الخلف
                </MenuItem>
                <MenuItem icon={<Lock size={16} />} onSelect={() => store.setSelectionLocked(true)}>
                  قفل
                </MenuItem>
              </>
            )}
            {enhanced && (
              <MenuItem icon={<Undo2 size={16} />} onSelect={() => undoEnhancement(enhanced)}>
                إلغاء تحسين الشكل (إرجاع الخط الأصلي)
              </MenuItem>
            )}
            {linked && actions?.editAudioLink && (
              <MenuItem icon={<Clock size={16} />} hint={formatOffset(linked.link.offset_ms)} onSelect={() => actions.editAudioLink!(linked.item, targetKey)}>
                {linked.link.origin === 'auto' ? 'الرابط الزمني (تلقائي)…' : 'الرابط الزمني (يدوي)…'}
              </MenuItem>
            )}
            <MenuSeparator />
            <MenuItem icon={<ScanText size={16} />} disabled={!!convertReason} disabledReason={convertReason ?? undefined} onSelect={() => actions?.convert?.run(selInfo())}>
              تحويل إلى نص
            </MenuItem>
            <MenuItem icon={<MessageCircleQuestion size={16} />} disabled={!!askReason} disabledReason={askReason ?? undefined} onSelect={() => actions?.ask?.run(selInfo())}>
              اسأل عن المحدد
            </MenuItem>
            <MenuItem icon={<Layers size={16} />} disabled={!!cardReason} disabledReason={cardReason ?? undefined} onSelect={() => actions?.card?.run(selInfo())}>
              اصنع بطاقة من المحدد…
            </MenuItem>
            <MenuItem icon={<FileQuestion size={16} />} disabled={!!questionReason} disabledReason={questionReason ?? undefined} onSelect={() => actions?.question?.run(selInfo())}>
              اكتب سؤالًا من المحدد…
            </MenuItem>
            {/* (parity N1 wave 2) */}
            {!locked && shapes.length > 0 && (
              <MenuItem icon={<Shapes size={16} />} onSelect={() => openDialog('props')}>
                خصائص الشكل…
              </MenuItem>
            )}
            {!locked && single && onEditLabel && (
              <MenuItem icon={<Type size={16} />} onSelect={() => onEditLabel(single.id)}>
                {single.data.label ? 'عدّل النص داخل الشكل…' : 'اكتب داخل الشكل…'}
              </MenuItem>
            )}
            {!locked && single && (
              <MenuItem icon={<Brain size={16} />} hint={single.data.concept_name ?? undefined} onSelect={() => openDialog('concept')}>
                اربط بمفهوم من المادة…
              </MenuItem>
            )}
            {!locked && closedShapes.length >= 2 && (
              <MenuItem icon={<Network size={16} />} onSelect={autoLayout}>
                رتّب تلقائيًا
              </MenuItem>
            )}
            {connectors.length > 0 && (
              <MenuItem icon={<SpellCheck2 size={16} />} onSelect={() => openDialog('relations')}>
                تحقّق من العلاقات في خريطة المعرفة…
              </MenuItem>
            )}
            {!locked && strokes.length > 0 && (
              <MenuItem icon={<AlignHorizontalJustifyCenter size={16} />} onSelect={straighten}>
                استقم (سوِّ الأسطر المائلة)
              </MenuItem>
            )}
            {!locked && strokes.length > 0 && (
              <MenuItem icon={<WrapText size={16} />} disabled={!!reflowReason} disabledReason={reflowReason ?? undefined} onSelect={() => openDialog('reflow')}>
                أعد ترتيب الكلمات…
              </MenuItem>
            )}
            {/* (N1 Wave 0) named actions supplied by the screen around the engine (N2, N4 …) */}
            {actions?.extra?.map((a) => (
              <MenuItem key={a.id} icon={a.icon} disabled={!!a.reason} disabledReason={a.reason ?? undefined} onSelect={() => a.run(selInfo())}>
                {a.label_ar}
              </MenuItem>
            ))}
          </Menu>
        </Toolbar>
      </div>
      {/* (N1 wave 2, G21) the edge dots of one shape: a tap adds a connected shape on that side */}
      {!locked &&
        single &&
        SHAPE_SIDES.map((side) => {
          const p = shapeSidePoint(single.data as ShapeData, side, ar);
          if (!p) return null;
          const [x, y] = normToView(p[0], p[1], view);
          const [ox, oy] = side === 'n' ? [0, -22] : side === 's' ? [0, 22] : side === 'e' ? [22, 0] : [-22, 0];
          return (
            <button
              key={side}
              type="button"
              className="ml-ink-edge-dot"
              style={{ left: x + ox, top: y + oy }}
              data-ink-ui=""
              aria-label={`أضف شكلًا متصلًا من ${SIDE_NAMES[side]}`}
              title={`أضف شكلًا متصلًا من ${SIDE_NAMES[side]}`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => addConnected(side)}
            >
              <Plus size={14} aria-hidden="true" />
            </button>
          );
        })}
      {dialog?.kind === 'props' && <ShapePropsDialog open onClose={() => setDialog(null)} store={store} targetKey={targetKey} ids={dialog.ids} announce={announce} />}
      {dialog?.kind === 'concept' && <ConceptDialog open onClose={() => setDialog(null)} store={store} targetKey={targetKey} id={dialog.ids[0] ?? null} sourceId={page?.anchor?.type === 'page' ? page.anchor.source_id : null} announce={announce} />}
      {dialog?.kind === 'relations' && <RelationCheckDialog open onClose={() => setDialog(null)} store={store} targetKey={targetKey} ids={dialog.ids} />}
      {dialog?.kind === 'reflow' && <ReflowDialog open onClose={() => setDialog(null)} store={store} targetKey={targetKey} ids={dialog.ids} ar={ar} announce={announce} />}
    </>
  );
}
