// (chat side panel, wp/chat-side) The study chat as a full side chat, like Claude / ChatGPT side chat:
//   docked  ≥ 900 px: the whole height under the reading bar, in the study rail's place (right in Arabic), ~42 % wide,
//           drag / arrow keys on the handle (role="separator"), the book reflows to the rest (never covered)
//   full    < 900 px: full screen, a compact «الصفحة N» bar (thumbnail + label) with «اعرض الصفحة» (the reader; the chat
//           stays mounted and comes back with «عُد إلى المحادثة») and — landscape — «جنبًا إلى جنب» (50 / 50)
//   split   phone landscape: the chat and the page side by side
// Inside: ChatSurface (layout 'side'): title, «محادثة جديدة», the history as a column, the thread filling the height,
// the composer (model / effort picker) pinned at the bottom. Escape closes; focus moves into the composer on open.
// It consumes the selection toolbar's «اسأل عن التحديد» requests (the selection becomes a context chip).
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { BookOpen, Columns2, Maximize2, MessageSquare, X } from 'lucide-react';
import type { SelectionAnchor, SourceScope } from '@medlevo/shared';
import { Button, IconButton, cx } from '../../../design';
import { useCapabilities } from '../../../lib/capabilities';
import { useSettings } from '../../../lib/settings';
import { ChatSurface } from '../../studybook/chat/ChatSurface';
import { defaultScopeFor, regionsUnder } from '../../studybook/model';
import { fetchRegions } from '../data/api';
import type { SourceDocument } from '../data/useSourceDocument';
import { aiRequestStore, usePendingAiRequest, type AiRequest } from '../model/aiActions';
import type { ChatMode, ChatPhoneView } from '../model/layout';
import { fullPageLabel } from '../model/pages';
import { ThumbImage } from '../panels/LeftPanel';
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
}

async function withRegions(req: AiRequest): Promise<SelectionAnchor> {
  if (!req.rects.length || !req.anchor.page_id) return req.anchor;
  try {
    const r = await fetchRegions(req.anchor.page_id);
    const ids = regionsUnder(r.regions, req.rects);
    return ids.length ? { ...req.anchor, region_ids: ids } : req.anchor;
  } catch {
    return req.anchor;
  }
}

export function ChatSidePanel(p: ChatSidePanelProps) {
  const { doc } = p;
  const { settings } = useSettings();
  const gate = useCapabilities().feature('ai.chat');
  const [scope, setScope] = useState<SourceScope>(() => defaultScopeFor(doc.detail, settings.default_scope_mode));
  const [selection, setSelection] = useState<{ anchor: SelectionAnchor; text: string } | null>(null);
  const [prefill, setPrefill] = useState<string | null>(null);
  const [focus, setFocus] = useState(1);
  // an explicit open (again) focuses the composer (adjusted while rendering; an old prefill is not re-applied)
  const [seenOpen, setSeenOpen] = useState(p.openKey);
  if (seenOpen !== p.openKey) {
    setSeenOpen(p.openKey);
    setPrefill(null);
    setFocus((n) => n + 1);
  }

  // «اسأل عن التحديد» from the selection toolbar / handwriting: the selection is attached, the question prefilled
  const pending = usePendingAiRequest();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!pending || pending.action !== 'ask') return;
    // consuming the request re-runs this effect with `null`: the resolution below must not be dropped by it
    aiRequestStore.clear(pending.id);
    void withRegions(pending).then((anchor) => {
      if (!mounted.current) return;
      setSelection({ anchor, text: pending.text });
      setPrefill(pending.prefill ?? null);
      setFocus((n) => n + 1);
    });
  }, [pending]);

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
  const surface = (
    <ChatSurface
      layout="side"
      sourceId={doc.detail.id}
      sourceTitle={doc.detail.title}
      pages={doc.pages}
      pageLabel={(i) => doc.pages[i]?.printed_label ?? null}
      visiblePage={p.pageIndex}
      selection={selection}
      scope={scope}
      gate={gate}
      online={p.online}
      onJumpToPage={p.onJumpToPage}
      onScopeChange={setScope}
      focusKey={focus}
      prefill={prefill}
      headerActions={
        p.mode === 'split' ? (
          <>
            <IconButton size="sm" variant="plain" label="المحادثة بملء الشاشة" icon={<Maximize2 size={16} />} onClick={() => p.onPhoneView('chat')} />
            {closeButton}
          </>
        ) : full ? null : (
          closeButton
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
