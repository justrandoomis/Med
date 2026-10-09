// Global keyboard shortcuts of the app shell (kept apart from AppShell.tsx so they are unit-testable).

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

/**
 * "/" (not while typing) or Ctrl/⌘+K opens search — but never while a modal (dialog / sheet) is
 * open: it makes #root inert, and navigating would unmount the screen that owns the modal.
 */
export function isSearchShortcut(e: KeyboardEvent): boolean {
  if (e.defaultPrevented || document.getElementById('root')?.hasAttribute('inert')) return false;
  const k = (e.key ?? '').toLowerCase(); // autofill dispatches keydown without a key
  return (k === 'k' && (e.ctrlKey || e.metaKey)) || (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !isTypingTarget(e.target));
}
