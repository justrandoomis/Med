// Lasso selection: frame with move / uniform-resize / rotate handles and an action bar
// (colour, width, duplicate, delete, copy, layer order, lock, undo shape enhancement).
// Dragging is 1:1 with the pointer and never re-renders React per move: the frame follows through
// a CSS matrix on a ref, the selected items are drawn transformed on the live canvas, and the
// change is committed once (one undo step) on release.
import { useEffect, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { ArrowDownToLine, ArrowUpToLine, Copy, CopyPlus, Ellipsis, Lock, LockOpen, Palette, RotateCw, Trash2, Undo2, Minus } from 'lucide-react';
import { normBoxToView, normToView, viewToNorm, type NormBox } from '@medlevo/shared';
import { IconButton, Menu, MenuItem, MenuSeparator, Toolbar, Tooltip } from '../../../design';
import { useInkInternal } from './InkProvider';
import type { PageInkController } from './layerController';
import { IDENTITY, invertMat, isIdentity, multiply, rotateAbout, scaleAbout, translate, type Mat, type Vec } from './math';
import { isInkStroke, isShape, limitScaleToRange, revertEnhancement, type InkItem } from './model';
import { HIGHLIGHTER_COLORS, PEN_COLORS, resolveInkColor } from './palette';
import { pageMatrix, paperToneOf } from './render';
import type { InkPageView } from './types';

type Mode = { kind: 'move' } | { kind: 'rotate' } | { kind: 'scale'; corner: 0 | 1 | 2 | 3 };

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
}: {
  targetKey: string;
  view: InkPageView;
  controller: RefObject<PageInkController | null>;
  onStrokeActiveChange: (active: boolean) => void;
}) {
  const { store, announce } = useInkInternal();
  useSyncExternalStore(store.subscribeSelection, store.getSelectionVersion, store.getSelectionVersion);
  const [, setItemsVersion] = useState(0);
  useEffect(() => store.subscribePage(targetKey, (e) => e.kind === 'items' && setItemsVersion((v) => v + 1)), [store, targetKey]);
  const frameRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ mode: Mode; pointerId: number; start: Vec; bbox: NormBox; m: Mat; ids: string[] } | null>(null);
  const activeRef = useRef(onStrokeActiveChange);
  activeRef.current = onStrokeActiveChange;
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

  const items = store.selectedItems();
  const bbox = store.selectionBBox();
  if (!bbox || items.length === 0) return null;
  const ar = view.pageHeight / view.pageWidth;
  const locked = items.some((i) => i.locked);
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

  const matrixFor = (mode: Mode, start: Vec, cur: Vec, b: NormBox): Mat => {
    if (mode.kind === 'move') {
      let dx = cur[0] - start[0];
      let dy = cur[1] - start[1];
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
      const anchor = iso[(mode.corner + 2) % 4]!;
      const dxv = corner[0] - anchor[0];
      const dyv = corner[1] - anchor[1];
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

  const begin = (mode: Mode) => (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    if (locked) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // best effort
    }
    drag.current = { mode, pointerId: e.pointerId, start: toIso(e.clientX, e.clientY), bbox, m: IDENTITY, ids: items.map((i) => i.id) };
    store.setHidden(targetKey, items.map((i) => i.id), true);
    controller.current?.setTransformPreview(IDENTITY);
    if (barRef.current) barRef.current.style.visibility = 'hidden';
    onStrokeActiveChange(true);
  };

  const move = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    e.preventDefault();
    d.m = matrixFor(d.mode, d.start, toIso(e.clientX, e.clientY), d.bbox);
    controller.current?.setTransformPreview(d.m);
    if (frameRef.current) frameRef.current.style.transform = viewCss(d.m);
  };

  const end = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    drag.current = null;
    controller.current?.setTransformPreview(null);
    store.setHidden(targetKey, d.ids, false);
    if (frameRef.current) frameRef.current.style.transform = '';
    if (barRef.current) barRef.current.style.visibility = '';
    if (!isIdentity(d.m, 1e-9)) store.transformSelection(d.m);
    onStrokeActiveChange(false);
  };

  const handlers = (mode: Mode) => ({ onPointerDown: begin(mode), onPointerMove: move, onPointerUp: end, onPointerCancel: end });

  const tone = paperToneOf(frameRef.current);
  const colors = allHighlighter ? HIGHLIGHTER_COLORS : PEN_COLORS;
  const widths = allHighlighter ? HL_WIDTHS : PEN_WIDTHS;
  // above the rotate handle when there is room, otherwise below the frame (never covering a handle)
  const barTop = rect.top >= 100 ? rect.top - 96 : rect.top + rect.height + 14;
  const barCenter = Math.min(Math.max(rect.left + rect.width / 2, 150), Math.max(150, layerW - 150));

  const undoEnhancement = (shape: InkItem) => {
    const after = revertEnhancement(shape, Date.now());
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
        aria-hidden="true"
        {...handlers({ kind: 'move' })}
      >
        {!locked && (
          <span className="ml-ink-selection__rotate" {...handlers({ kind: 'rotate' })}>
            <RotateCw size={14} />
          </span>
        )}
        {locked && (
          <span className="ml-ink-selection__lock">
            <Lock size={14} />
          </span>
        )}
      </div>
      {!locked &&
        handles.map(([hx, hy], i) => (
          <span key={i} className="ml-ink-handle" style={{ left: hx, top: hy }} data-ink-ui="" aria-hidden="true" {...handlers({ kind: 'scale', corner: i as 0 | 1 | 2 | 3 })} />
        ))}
      <div ref={barRef} className="ml-ink-selbar" style={{ top: barTop, left: barCenter }} data-ink-ui="" dir="rtl">
        <Toolbar label={`إجراءات التحديد (${items.length} عنصر)`}>
          {locked ? (
            <Tooltip content="فك القفل" describe={false}>
              <IconButton label="فك القفل" icon={<LockOpen size={18} />} size="sm" onClick={() => store.setSelectionLocked(false)} />
            </Tooltip>
          ) : (
            <>
              {hasStyled && (
                <Menu label="تغيير اللون" trigger={<IconButton label="تغيير اللون" icon={<Palette size={18} />} size="sm" />}>
                  {colors.map((c) => (
                    <MenuItem key={c.token} icon={<span className="ml-ink-swatch ml-ink-swatch--sm" style={{ background: resolveInkColor(c.token, tone, null) }} />} onSelect={() => store.recolorSelection(c.token)}>
                      {c.label_ar}
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
            <MenuSeparator />
            <MenuItem disabled disabledReason="يحتاج التعرف على الخط اليدوي، ولم يُبنَ بعد." onSelect={() => {}}>
              تحويل إلى نص
            </MenuItem>
            <MenuItem disabled disabledReason="يُبنى مع لوحة الدراسة السياقية." onSelect={() => {}}>
              اسأل عن المحدد
            </MenuItem>
          </Menu>
        </Toolbar>
      </div>
    </>
  );
}
