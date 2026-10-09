// Pointer drag & drop for library items (mouse, pen and touch via Pointer Events). Drop a folder or a
// source onto a folder (shelf cover, folder row or breadcrumb) to move it there. The handle is a
// pointer-only affordance hidden from assistive tech: the keyboard path is «نقل…» in each item's menu
// (MoveDialog), so nothing depends on dragging.
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';

export interface DragItem {
  kind: 'node' | 'source';
  id: string;
  title: string;
}

interface DragState {
  item: DragItem;
  x: number;
  y: number;
  target: string | null;
  allowed: boolean;
}

const THRESHOLD = 6;

export function useLibraryDnd(opts: { canDrop: (item: DragItem, targetNodeId: string) => boolean; onDrop: (item: DragItem, targetNodeId: string) => void }) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const pending = useRef<{ item: DragItem; x: number; y: number; id: number; el: HTMLElement } | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const finish = useCallback((commit: boolean) => {
    setDrag((d) => {
      if (commit && d && d.target && d.allowed) optsRef.current.onDrop(d.item, d.target);
      return null;
    });
    document.documentElement.classList.remove('ml-dragging');
    pending.current = null;
  }, []);

  useEffect(() => {
    if (!drag) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drag, finish]);

  const handleProps = (item: DragItem) => ({
    'aria-hidden': true as const,
    tabIndex: -1,
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      pending.current = { item, x: e.clientX, y: e.clientY, id: e.pointerId, el: e.currentTarget };
    },
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
      const p = pending.current;
      if (!p || p.id !== e.pointerId) return;
      if (!drag && Math.hypot(e.clientX - p.x, e.clientY - p.y) < THRESHOLD) return;
      document.documentElement.classList.add('ml-dragging');
      const under = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-drop-target]');
      const target = under?.dataset.dropTarget ?? null;
      const allowed = !!target && optsRef.current.canDrop(p.item, target);
      setDrag({ item: p.item, x: e.clientX, y: e.clientY, target, allowed });
    },
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => {
      if (pending.current?.id !== e.pointerId) return;
      finish(true);
    },
    onPointerCancel: () => finish(false),
  });

  /** Props for a drop target (a folder). */
  const dropProps = (nodeId: string) => ({
    'data-drop-target': nodeId,
    'data-drop-active': drag && drag.target === nodeId && drag.allowed ? 'true' : undefined,
  });

  const ghost =
    drag && typeof document !== 'undefined'
      ? createPortal(
          <div className="ml-drag-ghost" style={{ insetInlineStart: undefined, left: drag.x + 12, top: drag.y + 12 }} role="presentation">
            {drag.target && drag.allowed ? 'إفلات للنقل إلى هذا المجلد: ' : ''}
            <bdi>{drag.item.title}</bdi>
          </div>,
          document.body,
        )
      : null;

  return { handleProps, dropProps, ghost, dragging: drag };
}
