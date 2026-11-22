// (chat side panel, wp/chat-side) The state of the study chat beside the book: open / closed, its docked width
// (~42 % by default, 360 px … 65 %, drag or arrow keys on the handle, remembered per account in userStorage), and on a
// phone the full-screen chat with «اعرض الصفحة» (the page, chat kept) or — landscape — the two side by side. On a phone
// the open chat is a history entry: the back gesture closes it and returns to the reader (at the synced page).
import { useCallback, useEffect, useRef, useState } from 'react';
import { useResizablePanel } from '../../../design';
import { userStorage } from '../../../lib/userStorage';
import { CHAT_SIDE_MIN_WIDTH, chatBounds, chatWidthFor, decideChat, type ChatMode, type ChatPhoneView } from '../model/layout';

/** the account's docked chat width (px) */
export const CHAT_WIDTH_KEY = 'medlevo.workspace.chat-width';
/** marks the history entry the phone chat pushed (so only that entry is popped when the chat closes) */
const HISTORY_MARK = 'medlevoChat';

function readWidth(): number | null {
  try {
    const v = userStorage.get(CHAT_WIDTH_KEY);
    const n = v != null && /^\d{2,5}$/.test(v) ? Number(v) : null;
    return n && n > 0 ? n : null;
  } catch {
    return null;
  }
}
function writeWidth(w: number): void {
  try {
    userStorage.set(CHAT_WIDTH_KEY, String(Math.round(w)));
  } catch {
    /* storage unavailable: the width is simply not remembered */
  }
}

function useLandscape(): boolean {
  const query = '(orientation: landscape)';
  const get = () => {
    try {
      return typeof window !== 'undefined' && !!window.matchMedia?.(query).matches;
    } catch {
      return false;
    }
  };
  const [on, setOn] = useState(get);
  useEffect(() => {
    let mq: MediaQueryList | undefined;
    try {
      mq = window.matchMedia?.(query);
    } catch {
      mq = undefined;
    }
    if (!mq) return;
    const fn = () => setOn(mq!.matches);
    mq.addEventListener?.('change', fn);
    return () => mq!.removeEventListener?.('change', fn);
  }, []);
  return on;
}

export interface ChatPanelApi {
  open: boolean;
  mode: ChatMode;
  /** the docked / split width in px (0 when not beside the book) */
  width: number;
  min: number;
  max: number;
  handleProps: ReturnType<typeof useResizablePanel>['handleProps'];
  phoneView: ChatPhoneView;
  setPhoneView: (v: ChatPhoneView) => void;
  landscape: boolean;
  /** bumps on every explicit open (the panel moves focus into the composer) */
  openKey: number;
  openChat: () => void;
  close: () => void;
}

export function useChatPanel({ width, disabled = false }: { width: number; disabled?: boolean }): ChatPanelApi {
  const [open, setOpen] = useState(false);
  const [phoneView, setPhoneView] = useState<ChatPhoneView>('chat');
  const [openKey, setOpenKey] = useState(0);
  const [remembered, setRemembered] = useState<number | null>(readWidth);
  const landscape = useLandscape();
  const { min, max } = chatBounds(width);
  const panel = useResizablePanel({
    initial: chatWidthFor(width, remembered),
    min,
    max,
    side: 'start',
    step: 24,
    onCommit: (w) => {
      setRemembered(w);
      writeWidth(w);
    },
  });
  const isOpen = open && !disabled;
  const mode = decideChat({ width, open: isOpen, phoneView, landscape });

  const openChat = useCallback(() => {
    setOpen(true);
    setPhoneView((v) => (v === 'page' ? 'chat' : v));
    setOpenKey((n) => n + 1);
  }, []);
  const close = useCallback(() => setOpen(false), []);

  // phone: the open chat is a history entry — back closes it (and returns to the reader at the synced page)
  const phoneOpen = isOpen && width < CHAT_SIDE_MIN_WIDTH;
  const pushed = useRef(false);
  useEffect(() => {
    if (!phoneOpen) return;
    try {
      const state: unknown = window.history.state;
      window.history.pushState({ ...(state && typeof state === 'object' ? state : {}), [HISTORY_MARK]: true }, '', window.location.href);
      pushed.current = true;
    } catch {
      pushed.current = false;
    }
    const onPop = () => {
      pushed.current = false;
      setOpen(false);
    };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      // closed from the panel (or the screen grew): drop our entry — never when the app navigated elsewhere meanwhile
      const s: unknown = window.history.state;
      if (pushed.current && s && typeof s === 'object' && (s as Record<string, unknown>)[HISTORY_MARK]) window.history.back();
      pushed.current = false;
    };
  }, [phoneOpen]);

  return {
    open: isOpen,
    mode,
    width: mode === 'docked' ? panel.width : mode === 'split' ? Math.round(width / 2) : 0,
    min,
    max,
    handleProps: panel.handleProps,
    phoneView,
    setPhoneView,
    landscape,
    openKey,
    openChat,
    close,
  };
}
