// A small NON-modal panel anchored to an element (used by the citation chip's Evidence Peek).
// Focus moves into the panel when it opens; Escape / outside pointer / Tab past the end close it and focus
// returns to the chip button. On phones (< 40rem) it docks to the bottom edge instead of floating.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { getFocusable, Portal } from '../../design';

export interface AnchoredPanelProps {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  onClose: (opts: { returnFocus: boolean }) => void;
  label: string;
  id?: string;
  className?: string;
  children: ReactNode;
}

interface Pos {
  top: number;
  left: number;
  docked: boolean;
  ready: boolean;
}

const GAP = 8;
const MARGIN = 12;

export function AnchoredPanel({ open, anchorRef, onClose, label, id, className, children }: AnchoredPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<Pos>({ top: 0, left: 0, docked: false, ready: false });

  useLayoutEffect(() => {
    if (!open) {
      setPos((p) => ({ ...p, ready: false }));
      return;
    }
    const place = () => {
      const a = anchorRef.current?.getBoundingClientRect();
      const p = panelRef.current;
      if (!a || !p) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      if (vw < 640) {
        setPos({ top: 0, left: 0, docked: true, ready: true });
        return;
      }
      const w = p.offsetWidth;
      const h = p.offsetHeight;
      const rtl = (document.documentElement.dir || 'rtl') === 'rtl';
      // align the panel's inline-start edge with the chip's inline-start edge
      let left = rtl ? a.right - w : a.left;
      left = Math.min(Math.max(MARGIN, left), vw - w - MARGIN);
      let top = a.bottom + GAP;
      if (top + h > vh - MARGIN && a.top - GAP - h >= MARGIN) top = a.top - GAP - h;
      top = Math.max(MARGIN, Math.min(top, vh - h - MARGIN));
      setPos({ top, left, docked: false, ready: true });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, anchorRef]);

  // focus into the panel once placed
  useEffect(() => {
    if (!open || !pos.ready || !panelRef.current) return;
    const first = getFocusable(panelRef.current)[0];
    (first ?? panelRef.current).focus();
  }, [open, pos.ready]);

  // outside pointer closes (without stealing focus back)
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (panelRef.current?.contains(t) || anchorRef.current?.contains(t)) return;
      onClose({ returnFocus: false });
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open, anchorRef, onClose]);

  if (!open) return null;
  return (
    <Portal>
      <div
        ref={panelRef}
        id={id}
        role="dialog"
        aria-label={label}
        tabIndex={-1}
        className={['ev-anchored', pos.docked ? 'ev-anchored--docked' : '', className].filter(Boolean).join(' ')}
        style={pos.docked ? { visibility: pos.ready ? 'visible' : 'hidden' } : { top: pos.top, left: pos.left, visibility: pos.ready ? 'visible' : 'hidden' }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onClose({ returnFocus: true });
            return;
          }
          if (e.key === 'Tab' && panelRef.current) {
            const items = getFocusable(panelRef.current);
            const active = document.activeElement;
            const atStart = active === panelRef.current || active === items[0];
            const atEnd = items.length === 0 || active === items[items.length - 1];
            if (e.shiftKey ? atStart : atEnd) {
              e.preventDefault();
              onClose({ returnFocus: true });
            }
          }
        }}
      >
        {children}
      </div>
    </Portal>
  );
}
