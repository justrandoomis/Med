// The study mode the reader is in (§39), for the per-mode toolbars (parity N1, G66). The ink engine only READS it: from
// the host (`InkHost` studyMode) when the screen around provides it, otherwise from the mode switch the reader shows
// (`.wk-modeswitch[data-mode]`, the rail's `.wk-rail-mode[data-mode]`, or the compact switch's Arabic name).
import { useSyncExternalStore } from 'react';
import { STUDY_MODES, STUDY_MODE_LABELS_AR, type StudyMode } from '@medlevo/shared';

const LABEL_PREFIX = 'وضع الدراسة: ';

export function readStudyMode(root: ParentNode | null = typeof document !== 'undefined' ? document : null): StudyMode | null {
  if (!root) return null;
  const v = root.querySelector('.wk-modeswitch[data-mode], .wk-rail-mode[data-mode]')?.getAttribute('data-mode');
  if (v && (STUDY_MODES as readonly string[]).includes(v)) return v as StudyMode;
  const label = root.querySelector(`[aria-label^="${LABEL_PREFIX}"]`)?.getAttribute('aria-label')?.slice(LABEL_PREFIX.length);
  for (const m of STUDY_MODES) if (STUDY_MODE_LABELS_AR[m] === label) return m;
  return null;
}

let current: StudyMode | null = null;
const listeners = new Set<() => void>();
let observer: MutationObserver | null = null;

function refresh() {
  const next = readStudyMode();
  if (next === current) return;
  current = next;
  listeners.forEach((l) => l());
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  if (!observer && typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
    observer = new MutationObserver(refresh);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-mode', 'aria-label'] });
    current = readStudyMode();
  }
  return () => {
    listeners.delete(l);
    if (listeners.size === 0 && observer) {
      observer.disconnect();
      observer = null;
    }
  };
}

const get = () => current;
const none = () => () => undefined;
const nothing = () => null;

/** The reader's study mode (null outside a reader or when unknown); watched only while `enabled`. */
export function useStudyMode(enabled: boolean, fromHost?: StudyMode | null): StudyMode | null {
  const fromPage = useSyncExternalStore(enabled && fromHost === undefined ? subscribe : none, enabled && fromHost === undefined ? get : nothing, nothing);
  return fromHost !== undefined ? fromHost : fromPage;
}
