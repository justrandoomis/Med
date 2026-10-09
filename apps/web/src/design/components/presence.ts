import { useEffect, useState } from 'react';

function motionReduced(): boolean {
  const attr = document.documentElement.getAttribute('data-reduce-motion');
  if (attr === 'on') return true;
  if (attr === 'off') return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * Keeps an overlay mounted while its exit transition plays (enter and exit follow the same path,
 * §22 / Apple "spatial consistency"). `state` drives data-state="open|closed" in CSS.
 */
export function usePresence(open: boolean, exitMs = 180): { mounted: boolean; state: 'open' | 'closed' } {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    const delay = motionReduced() ? 0 : exitMs;
    const t = window.setTimeout(() => setMounted(false), delay);
    return () => window.clearTimeout(t);
  }, [open, exitMs]);
  return { mounted: open || mounted, state: open ? 'open' : 'closed' };
}
