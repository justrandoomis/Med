// Source Jump & Back (§11): opening a cited place records where the owner was (page, offset, zoom,
// rotation, layout) so «العودة إلى الشرح» returns to exactly that position.
export interface ReaderPosition {
  sourceId: string;
  versionId: string;
  pageIndex: number;
  /** scroll offset inside the page, fraction [0,1] */
  pageOffset: number;
  zoom: number;
  fit: 'width' | null;
  rotation: number;
  layout: 'single' | 'double' | 'continuous';
}

export interface BackEntry {
  position: ReaderPosition;
  /** e.g. «ص 12 — محاضرة الزائدة» */
  label: string;
  createdAt: number;
}

export const BACK_STACK_MAX = 30;

export function samePlace(a: ReaderPosition, b: ReaderPosition): boolean {
  return a.sourceId === b.sourceId && a.versionId === b.versionId && a.pageIndex === b.pageIndex && Math.abs(a.pageOffset - b.pageOffset) < 0.02;
}

/** Push the current position before a jump. A jump from the same place twice records it once. */
export function pushBack(stack: readonly BackEntry[], entry: BackEntry, max = BACK_STACK_MAX): BackEntry[] {
  const top = stack[stack.length - 1];
  if (top && samePlace(top.position, entry.position)) return [...stack.slice(0, -1), entry];
  const next = [...stack, entry];
  return next.length > max ? next.slice(next.length - max) : next;
}

export function popBack(stack: readonly BackEntry[]): { entry: BackEntry | null; stack: BackEntry[] } {
  if (stack.length === 0) return { entry: null, stack: [] };
  return { entry: stack[stack.length - 1]!, stack: stack.slice(0, -1) };
}

/** Back entries survive a jump to another source (a route change) in sessionStorage. */
const STORAGE_KEY = 'medlevo.workspace.back.v1';

export function loadBackStack(): BackEntry[] {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed.filter((e) => e && typeof e === 'object' && (e as BackEntry).position) as BackEntry[]) : [];
  } catch {
    return [];
  }
}

export function saveBackStack(stack: readonly BackEntry[]): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(stack));
  } catch {
    // storage unavailable (private mode): the stack still works in memory
  }
}
