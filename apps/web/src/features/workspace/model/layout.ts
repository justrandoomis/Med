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

// ───────── (chat side panel, wp/chat-side) the study chat beside the book ─────────
/** from this width the chat is a docked, resizable side panel; below it the chat is full screen */
export const CHAT_SIDE_MIN_WIDTH = 900;
export const CHAT_MIN = 360;
export const CHAT_MAX_RATIO = 0.65;
export const CHAT_DEFAULT_RATIO = 0.42;

/** min / max width of the docked chat for a workspace this wide (max 65 %, never under the min) */
export function chatBounds(width: number): { min: number; max: number } {
  return { min: CHAT_MIN, max: Math.max(CHAT_MIN, Math.round(width * CHAT_MAX_RATIO)) };
}

/** the docked chat's width: the remembered one (clamped to this screen), else ~42 % of it */
export function chatWidthFor(width: number, remembered: number | null): number {
  const { min, max } = chatBounds(width);
  const want = remembered ?? Math.round(width * CHAT_DEFAULT_RATIO);
  return Math.round(Math.min(max, Math.max(min, want)));
}

export type ChatMode = 'closed' | 'docked' | 'full' | 'split';
/** on a phone: the chat full screen, the page (chat hidden, kept), or — landscape — both side by side */
export type ChatPhoneView = 'chat' | 'page' | 'split';

export function decideChat(r: { width: number; open: boolean; phoneView: ChatPhoneView; landscape: boolean }): ChatMode {
  if (!r.open) return 'closed';
  if (r.width >= CHAT_SIDE_MIN_WIDTH) return 'docked';
  if (r.phoneView === 'split' && r.landscape) return 'split';
  return 'full';
}

/**
 * The panels with the chat docked beside the book: the chat takes the study rail's place (the two never squeeze the
 * book together — opening one closes the other), the page panel stays only while the book keeps its minimum width
 * (it is not «closed» for good: it comes back when the chat closes).
 */
export function decidePanelsWithChat(r: PanelRequest & { chatWidth: number }): PanelDecision {
  const phone = r.width < PHONE_MAX_WIDTH;
  const left: PanelMode = !r.leftOpen ? 'closed' : phone ? 'closed' : r.width - r.chatWidth - LEFT_PANEL_WIDTH >= MIN_CANVAS_WIDTH ? 'docked' : 'closed';
  const railWidth = Math.min(RAIL_MAX, Math.max(RAIL_MIN, Math.round(r.railWidth)));
  return { phone, rail: 'closed', left, railWidth, canvasWidth: Math.max(0, r.width - r.chatWidth - (left === 'docked' ? LEFT_PANEL_WIDTH : 0)), closed: null };
}
