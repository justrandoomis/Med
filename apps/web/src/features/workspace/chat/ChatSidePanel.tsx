// (chat side panel, wp/chat-side) The study chat as a full side chat, like Claude / ChatGPT side chat:
//   docked  ≥ 900 px: the whole height under the reading bar, in the study rail's place (right in Arabic), ~42 % wide,
//           drag / arrow keys on the handle (role="separator"), the book reflows to the rest (never covered)
//   full    < 900 px: full screen, a compact «الصفحة N» bar (thumbnail + label) with «اعرض الصفحة» (the reader; the chat
//           stays mounted and comes back with «عُد إلى المحادثة») and — landscape — «جنبًا إلى جنب» (50 / 50)
//   split   phone landscape: the chat and the page side by side
// Inside: «المحادثة الذكية» (SmartChat → ChatSurface, layout 'side'): title, «محادثة جديدة», the history as a column,
// the thread filling the height, the skill chips and the composer (model / effort picker, «/» menu) pinned at the
// bottom. Escape closes; focus moves into the composer on open. «ملاحظاتي» in the header goes to the rail's notes.
// It consumes the selection toolbar's «اسأل عن التحديد» requests (the selection becomes a context chip).
import type { KeyboardEvent } from 'react';
import { BookOpen, Columns2, Maximize2, MessageSquare, NotebookPen, X } from 'lucide-react';
import { Button, IconButton, cx } from '../../../design';
import type { CardContext } from '../../studybook/chat/cards';
import type { SourceDocument } from '../data/useSourceDocument';
import type { ChatMode, ChatPhoneView } from '../model/layout';
import { fullPageLabel } from '../model/pages';
import { ThumbImage } from '../panels/LeftPanel';
import { SmartChat } from './SmartChat';
import type { ChatPanelApi } from './useChatPanel';
import './chatSide.css';

export interface ChatSidePanelProps {
  doc: SourceDocument;
  /** the page the reader shows (page sync) */
  pageIndex: number;
  online: boolean;
  mode: Exclude<ChatMode, 'closed'>;
  width: number;
  handleProps?: ChatPanelApi['handleProps'];
  phoneView: ChatPhoneView;
  onPhoneView: (v: ChatPhoneView) => void;
  /** phone landscape: the 50 / 50 arrangement is offered */
  landscape: boolean;
  /** bumps on every explicit open → focus into the composer */
  openKey: number;
  onClose: () => void;
  /** chat → reader (page sync, «ص N» chips) */
  onJumpToPage: (pageIndex: number) => void;
  /** (smart chat) «ملاحظاتي»: the rail's notes tab (the chat closes, the rail takes its place) */
  onOpenNotes?: () => void;
  /** (smart chat) a card's full tool (figures / linked questions / cases) */
  onOpenTool?: CardContext['onOpenTool'];
}

export function ChatSidePanel(p: ChatSidePanelProps) {
  const { doc } = p;
  const page = doc.pages[p.pageIndex] ?? null;
  const pageName = page ? fullPageLabel(page) : `الصفحة ${p.pageIndex + 1}`;
  const full = p.mode === 'full';
  const showingPage = full && p.phoneView === 'page';

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    const t = e.target as HTMLElement;
    // Escape inside a menu, a dialog or the inline rename belongs to that control
    if (t.closest('[role="menu"],[role="listbox"],[role="dialog"],.ch-history__rename')) return;
    e.preventDefault();
    e.stopPropagation();
    p.onClose();
  };

  const closeButton = <IconButton size="sm" variant="plain" label="أغلق المحادثة" icon={<X size={16} />} onClick={p.onClose} />;
  const notesButton = p.onOpenNotes ? <IconButton size="sm" variant="plain" label="ملاحظاتي" icon={<NotebookPen size={16} />} onClick={p.onOpenNotes} /> : null;
  const surface = (
    <SmartChat
      layout="side"
      doc={doc}
      pageIndex={p.pageIndex}
      online={p.online}
      onJumpToPage={p.onJumpToPage}
      onOpenTool={p.onOpenTool}
      openKey={p.openKey}
      consumeAsk
      headerActions={
        p.mode === 'split' ? (
          <>
            <IconButton size="sm" variant="plain" label="المحادثة بملء الشاشة" icon={<Maximize2 size={16} />} onClick={() => p.onPhoneView('chat')} />
            {notesButton}
            {closeButton}
          </>
        ) : full ? (
          notesButton
        ) : (
          <>
            {notesButton}
            {closeButton}
          </>
        )
      }
    />
  );

  return (
    <>
      <section
        className={cx('wk-chat', full && 'wk-chat--full', p.mode === 'split' && 'wk-chat--split')}
        aria-label="المحادثة"
        data-mode={p.mode}
        hidden={showingPage}
        style={full ? undefined : { width: p.width }}
        onKeyDown={onKeyDown}
      >
        {full && (
          <div className="wk-chat__pagebar">
            {page && (
              <span className="wk-chat__thumb" aria-hidden="true">
                <ThumbImage doc={doc} page={page} show />
              </span>
            )}
            <span className="wk-chat__page">{pageName}</span>
            <Button size="sm" variant="secondary" icon={<BookOpen size={16} />} onClick={() => p.onPhoneView('page')}>
              اعرض الصفحة
            </Button>
            {p.landscape && <IconButton size="sm" variant="plain" label="المحادثة والصفحة جنبًا إلى جنب" icon={<Columns2 size={16} />} onClick={() => p.onPhoneView('split')} />}
            {closeButton}
          </div>
        )}
        <div className="wk-chat__inner">{surface}</div>
        {p.mode === 'docked' && p.handleProps && <div {...p.handleProps('تغيير عرض المحادثة')} />}
      </section>
      {showingPage && (
        <div className="wk-chat-return">
          <Button variant="primary" size="sm" icon={<MessageSquare size={16} />} onClick={() => p.onPhoneView('chat')}>
            {`عُد إلى المحادثة — ${pageName}`}
          </Button>
          <IconButton size="sm" variant="secondary" label="أغلق المحادثة" icon={<X size={16} />} onClick={p.onClose} />
        </div>
      )}
    </>
  );
}
