// The paper tone (light / dark) under an ink element, for picking readable ink colours. It is measured from the DOM
// after each commit (a layout effect, so before paint) instead of being read from a ref during render; until the
// element exists the theme decides, exactly as `paperToneOf(null)` does.
import { useLayoutEffect, useState, type RefObject } from 'react';
import type { PaperTone } from './palette';
import { paperToneOf } from './render';

export function usePaperTone(ref: RefObject<Element | null>): PaperTone {
  const [tone, setTone] = useState<PaperTone>(() => paperToneOf(null));
  // re-measured after every commit, like the render-time read it replaces (the theme or the paper behind can change
  // with any render); an unchanged tone is a no-op update (React bails out), so this never loops
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately no dependency list (see above)
  useLayoutEffect(() => {
    setTone(paperToneOf(ref.current));
  });
  return tone;
}
