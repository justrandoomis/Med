// Workspace layout decisions (§23): the book gets the space first; side panels only dock when they fit,
// and both side panels never open together on a screen that cannot hold them. Phones: book first, the
// rail and the page panel become bottom sheets (one at a time).
export const PHONE_MAX_WIDTH = 768; // 48rem — same breakpoint as the shell
export const MIN_CANVAS_WIDTH = 420;
export const LEFT_PANEL_WIDTH = 264;
export const RAIL_MIN = 280;
export const RAIL_MAX = 640;
/** each page of a spread must be at least this wide to stay readable */
export const SPREAD_MIN_PAGE_WIDTH = 360;

export type PanelMode = 'docked' | 'sheet' | 'closed';

export interface PanelRequest {
  /** workspace width (css px) */
  width: number;
  railOpen: boolean;
  railWidth: number;
  leftOpen: boolean;
  /** the panel the owner opened most recently (wins when only one fits) */
  last: 'rail' | 'left';
}

export interface PanelDecision {
  phone: boolean;
  rail: PanelMode;
  left: PanelMode;
  /** docked rail width after clamping to the space left for the book */
  railWidth: number;
  /** width left for the book canvas */
  canvasWidth: number;
  /** a panel the owner asked for was closed because it did not fit */
  closed: 'rail' | 'left' | null;
}

export function decidePanels(r: PanelRequest): PanelDecision {
  const railWidthWanted = Math.min(RAIL_MAX, Math.max(RAIL_MIN, Math.round(r.railWidth)));
  if (r.width < PHONE_MAX_WIDTH) {
    // phone: sheets are modal → at most one
    let rail: PanelMode = r.railOpen ? 'sheet' : 'closed';
    let left: PanelMode = r.leftOpen ? 'sheet' : 'closed';
    let closed: PanelDecision['closed'] = null;
    if (rail === 'sheet' && left === 'sheet') {
      if (r.last === 'rail') {
        left = 'closed';
        closed = 'left';
      } else {
        rail = 'closed';
        closed = 'rail';
      }
    }
    return { phone: true, rail, left, railWidth: railWidthWanted, canvasWidth: r.width, closed };
  }

  let rail: PanelMode = r.railOpen ? 'docked' : 'closed';
  let left: PanelMode = r.leftOpen ? 'docked' : 'closed';
  let closed: PanelDecision['closed'] = null;
  const leftW = () => (left === 'docked' ? LEFT_PANEL_WIDTH : 0);

  if (rail === 'docked' && left === 'docked' && r.width - LEFT_PANEL_WIDTH - RAIL_MIN < MIN_CANVAS_WIDTH) {
    // both do not fit: keep the one opened last
    if (r.last === 'rail') {
      left = 'closed';
      closed = 'left';
    } else {
      rail = 'closed';
      closed = 'rail';
    }
  }
  let railWidth = railWidthWanted;
  if (rail === 'docked') {
    const room = r.width - leftW() - MIN_CANVAS_WIDTH;
    if (room < RAIL_MIN) {
      // even a narrow rail would squeeze the book: float it as a sheet instead of docking
      rail = 'sheet';
    } else {
      railWidth = Math.min(railWidthWanted, room);
    }
  }
  const canvasWidth = r.width - leftW() - (rail === 'docked' ? railWidth : 0);
  return { phone: false, rail, left, railWidth, canvasWidth, closed };
}

/** The page panel starts closed unless the screen is roomy (§23: default favours the book). */
export function defaultLeftOpen(width: number): boolean {
  return width >= 1440;
}

/** Can a two-page spread be shown at a readable size? */
export function canShowSpread(canvasWidth: number, phone: boolean): boolean {
  if (phone) return false;
  return canvasWidth >= SPREAD_MIN_PAGE_WIDTH * 2 + 16 + 48;
}

/** Effective layout: a requested spread falls back to one page when it does not fit. */
export function effectiveLayout(requested: 'single' | 'double' | 'continuous', canvasWidth: number, phone: boolean): 'single' | 'double' | 'continuous' {
  if (requested === 'double' && !canShowSpread(canvasWidth, phone)) return 'single';
  return requested;
}

/** Split Study needs room for two books side by side. */
export const SPLIT_MIN_WIDTH = 1024;
export function canSplit(width: number): boolean {
  return width >= SPLIT_MIN_WIDTH;
}
