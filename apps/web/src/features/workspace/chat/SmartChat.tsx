// «المحادثة الذكية» (wp/smart-rail): the lecture's ONE study surface — the Claude-style chat (ChatSurface) with its
// skills: chips above the composer and a «/» menu (explain, summarize, MCQ, case, compare, flashcards, image question,
// explain the figure, the lecture's questions, sources). Every skill is an existing server capability; its result is
// a card in the conversation (saved with the history). Used in the study rail's first tab (layout 'rail') and as the
// full-height side chat beside the book (layout 'side', ChatSidePanel).
// Honesty: without an AI provider / connection / consent the chat says why («الشرح غير متاح الآن» + the server's
// reason), and each chip that needs AI is disabled with its own reason; the Source Lock is always visible.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { SelectionAnchor, SourceScope, StudyMode } from '@medlevo/shared';
import { Button } from '../../../design';
import { AiAllowanceNote } from '../../../lib/aiAllowance';
import { useCapabilities } from '../../../lib/capabilities';
import { useSettings } from '../../../lib/settings';
import { ScopeBadge, ScopePicker } from '../../evidence';
import { ChatSurface } from '../../studybook/chat/ChatSurface';
import type { CardContext } from '../../studybook/chat/cards';
import { defaultScopeFor, referencesOf, regionsUnder } from '../../studybook/model';
import { fetchRegions } from '../data/api';
import type { SourceDocument } from '../data/useSourceDocument';
import { aiRequestStore, usePendingAiRequest, type AiRequest } from '../model/aiActions';
import { arrangementFor } from '../modes/arrangement';
import { useSmartSkills } from './useSmartSkills';

export interface SmartChatProps {
  doc: SourceDocument;
  pageIndex: number;
  online: boolean;
  layout: 'rail' | 'side';
  /** chat → reader (page sync, «ص N» chips, evidence chips of the cards) */
  onJumpToPage?: (pageIndex: number) => void;
  /** the full tools behind a card («الصفحة وأشكالها», «كل أسئلة المحاضرة», «حالات المحاضرة») */
  onOpenTool?: CardContext['onOpenTool'];
  headerActions?: ReactNode;
  /** bump to focus the composer (an explicit open) */
  openKey?: number;
  /** this surface takes «اسأل عن التحديد» requests (the side chat does; the rail's chat only when there is no side chat) */
  consumeAsk?: boolean;
  /** (track F3) the study mode: which skills lead (practice: MCQ, case, the lecture's questions) */
  mode?: StudyMode;
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

export function SmartChat(p: SmartChatProps) {
  const { doc } = p;
  const { settings } = useSettings();
  const gate = useCapabilities().feature('ai.chat');
  const [scope, setScope] = useState<SourceScope>(() => defaultScopeFor(doc.detail, settings.default_scope_mode));
  const [picking, setPicking] = useState(false);
  const [selection, setSelection] = useState<{ anchor: SelectionAnchor; text: string } | null>(null);
  const [prefill, setPrefill] = useState<string | null>(null);
  const [focus, setFocus] = useState(p.openKey ? 1 : 0);
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
    if (!p.consumeAsk || !pending || pending.action !== 'ask') return;
    // consuming the request re-runs this effect with `null`: the resolution below must not be dropped by it
    aiRequestStore.clear(pending.id);
    void withRegions(pending).then((anchor) => {
      if (!mounted.current) return;
      setSelection({ anchor, text: pending.text });
      setPrefill(pending.prefill ?? null);
      setFocus((n) => n + 1);
    });
  }, [pending, p.consumeAsk]);

  const base = useSmartSkills({ doc, pageIndex: p.pageIndex, selection, scope, online: p.online, onJumpToPage: p.onJumpToPage, onOpenTool: p.onOpenTool });
  const first = arrangementFor(p.mode).skillsFirst as string[];
  const rank = (id: string) => (first.includes(id) ? first.indexOf(id) : first.length);
  const skills = first.length ? { ...base, items: [...base.items].sort((x, y) => rank(x.def.id) - rank(y.def.id)) } : base;
  const blocked = gate.available ? null : (gate.reason ?? 'المحادثة غير متاحة الآن.');

  return (
    <div className="wk-smart" data-layout={p.layout}>
      {blocked && (
        <div className="wk-disabled-card" role="note">
          <p className="wk-disabled-card__title">الشرح غير متاح الآن</p>
          <p className="wk-muted">{blocked}</p>
        </div>
      )}
      <div className="sb-scope wk-smart__scope">
        <ScopeBadge scope={{ mode: scope.mode, source_ids: [scope.lecture_source_id ?? '', ...scope.reference_source_ids].filter(Boolean) }} />
        <Button size="sm" variant="plain" onClick={() => setPicking((v) => !v)} aria-expanded={picking}>
          {picking ? 'إخفاء النطاق' : 'غيّر النطاق'}
        </Button>
        <AiAllowanceNote />
        {picking && (
          <ScopePicker
            value={scope}
            lectureSourceId={doc.detail.id}
            references={referencesOf(doc.detail)}
            onApply={(s) => {
              setScope(s);
              setPicking(false);
            }}
            onCancel={() => setPicking(false)}
          />
        )}
      </div>
      <div className="wk-smart__surface">
        <ChatSurface
          layout={p.layout}
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
          headerActions={p.headerActions}
          skills={skills}
        />
      </div>
    </div>
  );
}
