import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
} from 'react';
import { Portal, useFloatingPosition } from './Portal';

type ChildProps = {
  ref?: Ref<HTMLElement>;
  'aria-describedby'?: string;
  onFocus?: (e: ReactFocusEvent<HTMLElement>) => void;
  onBlur?: (e: ReactFocusEvent<HTMLElement>) => void;
  onPointerEnter?: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerLeave?: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerDown?: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp?: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel?: (e: ReactPointerEvent<HTMLElement>) => void;
  onKeyDown?: (e: ReactKeyboardEvent<HTMLElement>) => void;
  onContextMenu?: (e: ReactMouseEvent<HTMLElement>) => void;
};

export interface TooltipProps {
  content: ReactNode;
  children: ReactElement<ChildProps>;
  /**
   * Link the tooltip with aria-describedby. Set false when the tooltip only repeats the control's
   * accessible name (e.g. an IconButton label) to avoid double announcements.
   */
  describe?: boolean;
  placement?: 'top' | 'bottom';
}

const HOVER_DELAY = 400;
const LONG_PRESS = 450;
const TOUCH_LINGER = 1600;

/**
 * Supplementary hint. Shows on keyboard focus and on touch long-press (never hover-only), and on
 * mouse hover after a short delay. Escape hides it. Never put essential information only here.
 */
export function Tooltip({ content, children, describe = true, placement = 'top' }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const id = useId();
  const pos = useFloatingPosition(anchorRef, tipRef, open, { placement, align: 'center', offset: 8 });

  const clear = () => window.clearTimeout(timer.current);
  useEffect(() => clear, []);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  if (!isValidElement(children)) return children;
  const p = children.props;
  const child = cloneElement(children, {
    ref: anchorRef as Ref<HTMLElement>,
    'aria-describedby': describe ? [p['aria-describedby'], open ? id : undefined].filter(Boolean).join(' ') || undefined : p['aria-describedby'],
    onFocus: (e) => {
      p.onFocus?.(e);
      // keyboard focus (not a mouse click) shows the hint
      try {
        if ((e.target as HTMLElement).matches(':focus-visible')) setOpen(true);
      } catch {
        setOpen(true);
      }
    },
    onBlur: (e) => {
      p.onBlur?.(e);
      clear();
      setOpen(false);
    },
    onPointerEnter: (e) => {
      p.onPointerEnter?.(e);
      if (e.pointerType !== 'mouse') return;
      clear();
      timer.current = window.setTimeout(() => setOpen(true), HOVER_DELAY);
    },
    onPointerLeave: (e) => {
      p.onPointerLeave?.(e);
      if (e.pointerType !== 'mouse') return;
      clear();
      setOpen(false);
    },
    onPointerDown: (e) => {
      p.onPointerDown?.(e);
      if (e.pointerType === 'mouse') return;
      clear();
      timer.current = window.setTimeout(() => setOpen(true), LONG_PRESS);
    },
    onPointerUp: (e) => {
      p.onPointerUp?.(e);
      if (e.pointerType === 'mouse') return;
      clear();
      timer.current = window.setTimeout(() => setOpen(false), TOUCH_LINGER);
    },
    onPointerCancel: (e) => {
      p.onPointerCancel?.(e);
      clear();
      setOpen(false);
    },
    onContextMenu: (e) => {
      p.onContextMenu?.(e);
      // long-press on touch would otherwise open the system menu over the hint
      if (open) e.preventDefault();
    },
  });

  return (
    <>
      {child}
      {open && (
        <Portal>
          <div
            ref={tipRef}
            id={id}
            role="tooltip"
            className="ml-tooltip"
            data-placement={pos.placement}
            style={{ top: pos.top, left: pos.left, visibility: pos.ready ? 'visible' : 'hidden' }}
          >
            {content}
          </div>
        </Portal>
      )}
    </>
  );
}
