import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cx, isRtl, useFocusTrap, useInertAppRoot, useScrollLock } from '../utils';
import { Portal } from './Portal';
import { usePresence } from './presence';
import { IconButton } from './Button';

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  /** Side on wide screens. On phones the sheet always rises from the bottom. */
  side?: 'start' | 'end';
  /** Width on wide screens (CSS length). */
  width?: string;
  footer?: ReactNode;
  className?: string;
}

/**
 * Modal sheet: a side sheet on wide screens (≥ 48rem) and a bottom sheet on phones. The bottom
 * sheet can be dragged down to dismiss (tracks the finger 1:1, uses release velocity).
 */
export function Sheet({ open, onClose, title, children, side = 'end', width = '26rem', footer, className }: SheetProps) {
  const { mounted, state } = usePresence(open, 220);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const drag = useRef<{ startY: number; lastY: number; lastT: number; v: number; id: number } | null>(null);
  const [dragY, setDragY] = useState(0);
  useFocusTrap(panelRef, open);
  useScrollLock(open);
  useInertAppRoot(open);

  useEffect(() => {
    if (!open) setDragY(0);
  }, [open]);

  const onHandleDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { startY: e.clientY, lastY: e.clientY, lastT: e.timeStamp, v: 0, id: e.pointerId };
  };
  const onHandleMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dt = Math.max(1, e.timeStamp - d.lastT);
    d.v = ((e.clientY - d.lastY) / dt) * 1000; // px/s
    d.lastY = e.clientY;
    d.lastT = e.timeStamp;
    const dy = e.clientY - d.startY;
    // rubber-band upwards, follow 1:1 downwards
    setDragY(dy >= 0 ? dy : -Math.sqrt(-dy) * 2);
  };
  const onHandleUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.id !== e.pointerId) return;
    const dy = e.clientY - d.startY;
    const height = panelRef.current?.offsetHeight ?? 400;
    // project where the flick is going (Apple's deceleration projection)
    const projected = dy + ((d.v / 1000) * 0.998) / (1 - 0.998);
    if (projected > height * 0.5) onClose();
    else setDragY(0);
  };

  if (!mounted) return null;
  return (
    <Portal>
      <div
        className="ml-overlay ml-overlay--sheet"
        data-state={state}
        onPointerDown={(e) => {
          if (e.target === e.currentTarget && open) onClose();
        }}
      >
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
          className={cx('ml-sheet', `ml-sheet--${side}`, className)}
          data-state={state}
          data-dragging={dragY !== 0 ? '' : undefined}
          style={{ ['--ml-sheet-width' as string]: width, ['--ml-sheet-drag' as string]: `${dragY}px` }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              onClose();
            }
          }}
        >
          <div
            className="ml-sheet__grabber"
            onPointerDown={onHandleDown}
            onPointerMove={onHandleMove}
            onPointerUp={onHandleUp}
            onPointerCancel={() => {
              drag.current = null;
              setDragY(0);
            }}
            aria-hidden="true"
          >
            <span />
          </div>
          <header className="ml-sheet__header">
            <h2 id={titleId} className="ml-sheet__title">
              {title}
            </h2>
            <IconButton label="إغلاق" icon={<X size={20} />} onClick={onClose} />
          </header>
          <div className="ml-sheet__body">{children}</div>
          {footer && <footer className="ml-sheet__footer">{footer}</footer>}
        </div>
      </div>
    </Portal>
  );
}

// ───────────────────────── Resizable side panel helper ─────────────────────────

export interface ResizablePanelOptions {
  initial: number;
  min: number;
  max: number;
  /** Logical side the panel sits on (start = right in Arabic). */
  side: 'start' | 'end';
  /** Called when a resize ends (persist the width, e.g. to the rail_width setting). */
  onCommit?: (width: number) => void;
  step?: number;
}

export interface ResizeHandleProps {
  role: 'separator';
  'aria-orientation': 'vertical';
  'aria-valuenow': number;
  'aria-valuemin': number;
  'aria-valuemax': number;
  'aria-label': string;
  tabIndex: 0;
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void;
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
  className: string;
}

/**
 * Width state + handle props for a resizable side panel (e.g. the Study Rail). The handle is a
 * focusable separator: Arrow keys resize (direction follows the panel's physical side), Home/End
 * jump to min/max. Pointer drags track 1:1.
 */
export function useResizablePanel({ initial, min, max, side, onCommit, step = 16 }: ResizablePanelOptions): {
  width: number;
  setWidth: (w: number) => void;
  handleProps: (label?: string) => ResizeHandleProps;
} {
  const clamp = useCallback((w: number) => Math.round(Math.min(max, Math.max(min, w))), [min, max]);
  const [width, setWidthState] = useState(() => clamp(initial));
  const widthRef = useRef(width);
  widthRef.current = width;
  const drag = useRef<{ startX: number; startW: number; physicalRight: boolean; id: number } | null>(null);
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;

  useEffect(() => {
    setWidthState(clamp(initial));
  }, [initial, clamp]);

  const setWidth = useCallback((w: number) => setWidthState(clamp(w)), [clamp]);

  const handleProps = (label = 'تغيير عرض اللوحة'): ResizeHandleProps => ({
    role: 'separator',
    'aria-orientation': 'vertical',
    'aria-valuenow': width,
    'aria-valuemin': min,
    'aria-valuemax': max,
    'aria-label': label,
    tabIndex: 0,
    className: 'ml-resize-handle',
    onPointerDown: (e) => {
      if (e.button !== 0) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      const rtl = isRtl(e.currentTarget);
      drag.current = { startX: e.clientX, startW: widthRef.current, physicalRight: (side === 'start') === rtl, id: e.pointerId };
    },
    onPointerMove: (e) => {
      const d = drag.current;
      if (!d || d.id !== e.pointerId) return;
      const dx = e.clientX - d.startX;
      setWidthState(clamp(d.physicalRight ? d.startW - dx : d.startW + dx));
    },
    onPointerUp: (e) => {
      const d = drag.current;
      drag.current = null;
      if (d && d.id === e.pointerId) commitRef.current?.(widthRef.current);
    },
    onKeyDown: (e) => {
      const rtl = isRtl(e.currentTarget);
      const physicalRight = (side === 'start') === rtl;
      let next: number | null = null;
      if (e.key === 'ArrowLeft') next = widthRef.current + (physicalRight ? step : -step);
      else if (e.key === 'ArrowRight') next = widthRef.current + (physicalRight ? -step : step);
      else if (e.key === 'Home') next = min;
      else if (e.key === 'End') next = max;
      if (next == null) return;
      e.preventDefault();
      const w = clamp(next);
      setWidthState(w);
      commitRef.current?.(w);
    },
  });

  return { width, setWidth, handleProps };
}
