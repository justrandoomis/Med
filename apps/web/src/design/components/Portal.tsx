import { useLayoutEffect, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { isRtl, placeFloating } from '../utils';

/**
 * Renders children into document.body (outside #root so modals can make the app root inert).
 * The portal carries the document direction so bidi stays correct.
 */
export function Portal({ children }: { children: ReactNode }) {
  if (typeof document === 'undefined') return null;
  return createPortal(children, document.body);
}

export interface FloatingPosition {
  top: number;
  left: number;
  placement: 'bottom' | 'top';
  ready: boolean;
}

/** Keeps a fixed-position floating element next to its anchor while open. */
export function useFloatingPosition(
  anchorRef: RefObject<HTMLElement | null>,
  floatingRef: RefObject<HTMLElement | null>,
  open: boolean,
  opts: { placement?: 'bottom' | 'top'; align?: 'start' | 'end' | 'center'; offset?: number } = {},
): FloatingPosition {
  const [pos, setPos] = useState<FloatingPosition>({ top: -9999, left: -9999, placement: opts.placement ?? 'bottom', ready: false });
  const { placement, align, offset } = opts;
  useLayoutEffect(() => {
    if (!open) {
      setPos((p) => (p.ready ? { ...p, ready: false } : p));
      return;
    }
    const update = () => {
      const anchor = anchorRef.current;
      const floating = floatingRef.current;
      if (!anchor || !floating) return;
      const rect = anchor.getBoundingClientRect();
      const size = { width: floating.offsetWidth, height: floating.offsetHeight };
      const next = placeFloating(rect, size, { placement, align, offset, rtl: isRtl(anchor) });
      setPos({ ...next, ready: true });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open, anchorRef, floatingRef, placement, align, offset]);
  return pos;
}
