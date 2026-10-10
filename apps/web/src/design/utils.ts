import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

const FOCUSABLE = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  'audio[controls]',
  'video[controls]',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** Focusable, visible descendants in DOM order. */
export function getFocusable(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hasAttribute('inert') && !el.closest('[inert]') && el.getAttribute('aria-hidden') !== 'true',
  );
}

/**
 * Direction of an element's context. Reads the nearest [dir] attribute (jsdom does not compute
 * `direction`), then falls back to computed style.
 */
export function isRtl(el: Element | null | undefined): boolean {
  if (!el) return document.documentElement.dir === 'rtl';
  const withDir = el.closest('[dir]');
  const dir = withDir?.getAttribute('dir');
  if (dir === 'rtl') return true;
  if (dir === 'ltr') return false;
  try {
    return getComputedStyle(el).direction === 'rtl';
  } catch {
    return false;
  }
}

export type NavKey = 'next' | 'prev' | 'first' | 'last' | null;

/**
 * Maps a key to a logical navigation step. In RTL, ArrowLeft moves forward (to the next item in
 * reading order) and ArrowRight moves back. Vertical arrows are honoured when `orientation` allows.
 */
export function navKeyFor(
  key: string,
  opts: { rtl: boolean; orientation: 'horizontal' | 'vertical' | 'both' },
): NavKey {
  const { rtl, orientation } = opts;
  const horizontal = orientation !== 'vertical';
  const vertical = orientation !== 'horizontal';
  switch (key) {
    case 'ArrowLeft':
      return horizontal ? (rtl ? 'next' : 'prev') : null;
    case 'ArrowRight':
      return horizontal ? (rtl ? 'prev' : 'next') : null;
    case 'ArrowDown':
      return vertical ? 'next' : null;
    case 'ArrowUp':
      return vertical ? 'prev' : null;
    case 'Home':
      return 'first';
    case 'End':
      return 'last';
    default:
      return null;
  }
}

/** Index after a logical step, wrapping around and skipping disabled entries. */
export function stepIndex(current: number, step: Exclude<NavKey, null>, count: number, isDisabled: (i: number) => boolean): number {
  if (count === 0) return -1;
  const enabled = Array.from({ length: count }, (_, i) => i).filter((i) => !isDisabled(i));
  if (enabled.length === 0) return -1;
  if (step === 'first') return enabled[0]!;
  if (step === 'last') return enabled[enabled.length - 1]!;
  const pos = enabled.indexOf(current);
  if (pos === -1) return enabled[0]!;
  const delta = step === 'next' ? 1 : -1;
  return enabled[(pos + delta + enabled.length) % enabled.length]!;
}

/** Active focus traps, innermost last. Only the top-most trap handles Tab (nested modals). */
const trapStack: symbol[] = [];

/**
 * Traps Tab focus inside `ref` while `active`, focuses the initial element on activation and
 * returns focus to the previously focused element on deactivation. Nested traps (a confirm dialog
 * opened from a sheet) stack: only the innermost one acts, the outer ones resume when it closes.
 */
export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  opts: { initialFocus?: RefObject<HTMLElement | null>; returnFocus?: boolean } = {},
): void {
  // read at activation / deactivation time: a new `opts` object on every render must not re-run the trap
  const optsRef = useRef(opts);
  optsRef.current = opts;
  useEffect(() => {
    if (!active) return;
    const { initialFocus, returnFocus = true } = optsRef.current;
    const root = ref.current;
    if (!root) return;
    const token = Symbol('focus-trap');
    trapStack.push(token);
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const focusFirst = () => {
      const target = initialFocus?.current ?? getFocusable(root)[0] ?? root;
      target.focus({ preventScroll: false });
    };
    focusFirst();
    // Portaled content may mount a frame later: retry once if focus did not land inside.
    const raf = requestAnimationFrame(() => {
      if (!root.contains(document.activeElement)) focusFirst();
    });

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      if (trapStack[trapStack.length - 1] !== token) return; // an inner modal owns the keyboard
      const items = getFocusable(root);
      if (items.length === 0) {
        e.preventDefault();
        root.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const activeEl = document.activeElement;
      if (e.shiftKey && (activeEl === first || !root.contains(activeEl))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (activeEl === last || !root.contains(activeEl))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('keydown', onKeyDown, true);
      const i = trapStack.lastIndexOf(token);
      if (i >= 0) trapStack.splice(i, 1);
      if (returnFocus && previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus({ preventScroll: true });
      }
    };
  }, [active, ref]);
}

/** Calls `handler` on pointerdown outside every element in `refs` while `active`. */
export function useOutsidePointer(
  refs: Array<RefObject<HTMLElement | null>>,
  active: boolean,
  handler: (e: PointerEvent) => void,
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  // the latest refs (callers pass a new array literal on every render)
  const refsRef = useRef(refs);
  refsRef.current = refs;
  useEffect(() => {
    if (!active) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (refsRef.current.some((r) => r.current?.contains(target))) return;
      handlerRef.current(e);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [active]);
}

let scrollLocks = 0;
let savedOverflow = '';
/** Prevents background scroll while a modal surface is open (ref-counted for nested modals). */
export function useScrollLock(active: boolean): void {
  useLayoutEffect(() => {
    if (!active) return;
    if (scrollLocks === 0) {
      savedOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    scrollLocks++;
    return () => {
      scrollLocks--;
      if (scrollLocks === 0) document.body.style.overflow = savedOverflow;
    };
  }, [active]);
}

let inertLocks = 0;
/** Makes the app root inert (unreachable by keyboard / screen readers) while a modal is open. */
export function useInertAppRoot(active: boolean): void {
  useLayoutEffect(() => {
    if (!active) return;
    const root = document.getElementById('root');
    if (!root) return;
    inertLocks++;
    root.setAttribute('inert', '');
    root.setAttribute('aria-hidden', 'true');
    return () => {
      inertLocks--;
      if (inertLocks === 0) {
        root.removeAttribute('inert');
        root.removeAttribute('aria-hidden');
      }
    };
  }, [active]);
}

/** Positions a floating element relative to an anchor (fixed positioning, clamped to the viewport). */
export function placeFloating(
  anchor: DOMRect,
  floating: { width: number; height: number },
  opts: { placement?: 'bottom' | 'top'; align?: 'start' | 'end' | 'center'; offset?: number; rtl: boolean },
): { top: number; left: number; placement: 'bottom' | 'top' } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const gap = opts.offset ?? 6;
  const margin = 8;
  let placement = opts.placement ?? 'bottom';
  const spaceBelow = vh - anchor.bottom;
  const spaceAbove = anchor.top;
  if (placement === 'bottom' && spaceBelow < floating.height + gap + margin && spaceAbove > spaceBelow) placement = 'top';
  if (placement === 'top' && spaceAbove < floating.height + gap + margin && spaceBelow > spaceAbove) placement = 'bottom';
  const top = placement === 'bottom' ? anchor.bottom + gap : anchor.top - gap - floating.height;
  const align = opts.align ?? 'start';
  let left: number;
  if (align === 'center') left = anchor.left + anchor.width / 2 - floating.width / 2;
  else if ((align === 'start') !== opts.rtl) left = anchor.left; // start in LTR / end in RTL → align left edges
  else left = anchor.right - floating.width;
  left = Math.max(margin, Math.min(left, vw - floating.width - margin));
  return { top: Math.max(margin, Math.min(top, vh - floating.height - margin)), left, placement };
}

/** True on devices whose primary input is coarse (touch). */
export function isCoarsePointer(): boolean {
  try {
    return window.matchMedia('(pointer: coarse)').matches;
  } catch {
    return false;
  }
}
