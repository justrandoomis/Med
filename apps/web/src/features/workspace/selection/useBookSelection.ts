// Tracks a native text selection inside the book (pdf.js text layer, OCR text, paragraphs). The reader
// uses it to show the selection toolbar and to block page flips while text is selected (§24).
import { useEffect, useRef, useState } from 'react';

export interface BookSelection {
  pageIndex: number;
  /** the selection spans more than one page (highlights must stay on one page) */
  multiPage: boolean;
  /** logical text (DOM order = stored order; no bidi controls) */
  text: string;
  range: Range;
  /** bounding rect in viewport coordinates (for placing the toolbar) */
  rect: DOMRect;
}

function pageOf(node: Node | null, root: HTMLElement): HTMLElement | null {
  const el = node instanceof Element ? node : node?.parentElement ?? null;
  const page = el?.closest<HTMLElement>('[data-page-index]') ?? null;
  return page && root.contains(page) ? page : null;
}

/**
 * @param root the book canvas element (selections elsewhere — the rail, dialogs — are ignored)
 */
export function useBookSelection(root: () => HTMLElement | null): { selection: BookSelection | null; clear: () => void } {
  const [selection, setSelection] = useState<BookSelection | null>(null);
  const pointerDown = useRef(false);
  const raf = useRef(0);

  useEffect(() => {
    const read = () => {
      raf.current = 0;
      const r = root();
      const sel = document.getSelection();
      if (!r || !sel || sel.isCollapsed || sel.rangeCount === 0) {
        setSelection(null);
        return;
      }
      const range = sel.getRangeAt(0);
      const a = pageOf(range.startContainer, r);
      const b = pageOf(range.endContainer, r);
      if (!a && !b) {
        setSelection(null);
        return;
      }
      const text = sel.toString();
      if (!text.trim()) {
        setSelection(null);
        return;
      }
      const page = a ?? b!;
      setSelection({ pageIndex: Number(page.dataset.pageIndex), multiPage: !!a && !!b && a !== b, text, range: range.cloneRange(), rect: range.getBoundingClientRect() });
    };
    const schedule = () => {
      if (pointerDown.current) return; // wait until the drag ends (no flicker while selecting)
      if (!raf.current) raf.current = requestAnimationFrame(read);
    };
    const onDown = () => {
      pointerDown.current = true;
    };
    const onUp = () => {
      pointerDown.current = false;
      schedule();
    };
    document.addEventListener('selectionchange', schedule);
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('pointerup', onUp, true);
    document.addEventListener('pointercancel', onUp, true);
    document.addEventListener('keyup', schedule);
    return () => {
      cancelAnimationFrame(raf.current);
      document.removeEventListener('selectionchange', schedule);
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('pointerup', onUp, true);
      document.removeEventListener('pointercancel', onUp, true);
      document.removeEventListener('keyup', schedule);
    };
  }, [root]);

  return {
    selection,
    clear: () => {
      document.getSelection()?.removeAllRanges();
      setSelection(null);
    },
  };
}

/** Is there a non-empty text selection inside the book right now? (synchronous check for key handlers) */
export function hasBookSelection(root: HTMLElement | null): boolean {
  const sel = document.getSelection();
  if (!root || !sel || sel.isCollapsed || sel.rangeCount === 0) return false;
  const range = sel.getRangeAt(0);
  return root.contains(range.commonAncestorContainer);
}
