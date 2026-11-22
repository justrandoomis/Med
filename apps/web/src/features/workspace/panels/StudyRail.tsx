// Contextual Study Rail (§30; wp/smart-rail): TWO sections — «المحادثة الذكية» (the study chat with its skills: explain,
// summarize, MCQ, case, compare, flashcards, image question, the lecture's questions, sources — results are cards in
// the conversation) and «ملاحظاتي» (with bookmarks and «تحتاج إعادة ربط» inside). What used to be separate tabs
// («الشرح والسؤال»، «الأسئلة»، «حالات»، «المصادر») is reached from the chat's skills and cards, and their full panels stay
// one step away as rail TOOLS (a card's «كل أسئلة المحاضرة» / «الصفحة وأشكالها», or the reading bar's «⋯»), with
// «عُد إلى المحادثة». The study mode (§39, track F3) picks the section a mode opens on and the skills that lead; in
// «امتحن نفسك» the chat and the explaining tools stay hidden (the reason in words) and the first section holds the
// lecture's questions and cases to attempt.
import { ArrowRight, Maximize2, MessageSquareText, NotebookPen } from 'lucide-react';
import { EXAM_MODE_HIDDEN_AR, STUDY_MODE_HINTS_AR, STUDY_MODE_LABELS_AR, type AnnotationAnchor, type SourcePageView, type StudyMode } from '@medlevo/shared';
import { Button, IconButton, Tab, TabList, TabPanel, Tabs } from '../../../design';
import type { SourceDocument } from '../data/useSourceDocument';
import { arrangementFor, RAIL_SECTION_LABELS_AR, RAIL_TOOL_LABELS_AR, visibleTab, visibleTool, type RailSection, type RailTool } from '../modes/arrangement';
import { DiagramPanel } from '../../studybook/diagrams/DiagramPanel';
import { SmartChat } from '../chat/SmartChat';
import { CasesTab } from './CasesTab';
import { ExplainTab } from './ExplainTab';
import { QuestionsTab } from './QuestionsTab';
import { MineTab, type MineNotePages, type MineTabValue, type NoteDraft } from './MineTab';
import { SourcesTab } from './SourcesTab';
import '../modes/modes.css';

export type RailTab = RailSection;
export type { RailTool };

export interface StudyRailProps {
  doc: SourceDocument;
  page: SourcePageView | null;
  pageIndex: number;
  tab: RailTab;
  onTab: (t: RailTab) => void;
  /** a full tool shown in place of the chat (null: the chat itself) */
  tool?: RailTool | null;
  onTool?: (t: RailTool | null) => void;
  mineTab: MineTabValue;
  onMineTab: (t: MineTabValue) => void;
  draft: NoteDraft | null;
  onDraftConsumed: () => void;
  anchorFor: (pageIndex: number) => AnnotationAnchor | null;
  onGoToPage: (pageIndex: number) => void;
  /** (chat UX) move the reader WITHOUT closing the panel (the chat's page sync and «ص N» chips) */
  onReaderJump?: (pageIndex: number) => void;
  /** (chat side panel) the full-height chat beside the book (absent: the chat lives in the rail only) */
  onOpenChat?: () => void;
  onOpenSplit: (sourceId: string) => void;
  splitReason: string | null;
  online: boolean;
  /** the source's inserted note pages (track F1) */
  notePages?: MineNotePages;
  /** (track F3) the study mode arranging the rail; defaults to «تعلّم» */
  mode?: StudyMode;
}

export function StudyRail(p: StudyRailProps) {
  const mode = p.mode ?? 'learn';
  const a = arrangementFor(mode);
  const tab = visibleTab(a, p.tab);
  const exam = mode === 'exam';
  const requested = p.tool ?? null;
  const tool = visibleTool(a, requested);
  const toolHidden = requested !== null && tool === null;
  const openTool = (t: RailTool | null) => p.onTool?.(t);

  const toolBody = (t: RailTool) => {
    switch (t) {
      case 'explain':
        return (
          <>
            <ExplainTab doc={p.doc} page={p.page} pageIndex={p.pageIndex} online={p.online} onJumpToPage={p.onReaderJump} onOpenChat={p.onOpenChat} />
            <DiagramPanel doc={p.doc} page={p.page} online={p.online} />
          </>
        );
      case 'questions':
        return <QuestionsTab doc={p.doc} page={p.page} pageIndex={p.pageIndex} onGoToPage={p.onGoToPage} online={p.online} arrangement={a} />;
      case 'cases':
        return <CasesTab doc={p.doc} online={p.online} examMode={exam} />;
      case 'sources':
        return <SourcesTab doc={p.doc} page={p.page} onOpenSplit={p.onOpenSplit} splitReason={p.splitReason} />;
    }
  };

  const first = tool ? (
    <section className="wk-rail-tool" aria-label={RAIL_TOOL_LABELS_AR[tool]}>
      <div className="wk-rail-tool__head">
        <Button size="sm" variant="plain" icon={<ArrowRight size={16} />} onClick={() => openTool(null)}>
          {exam ? `عُد إلى «${a.chatLabel}»` : 'عُد إلى المحادثة'}
        </Button>
        <span className="wk-rail-tool__title">{RAIL_TOOL_LABELS_AR[tool]}</span>
      </div>
      {toolBody(tool)}
    </section>
  ) : exam ? (
    // «امتحن نفسك»: no chat (it explains); the lecture's questions and cases, to attempt
    <div className="wk-rail-exam">
      <QuestionsTab doc={p.doc} page={p.page} pageIndex={p.pageIndex} onGoToPage={p.onGoToPage} online={p.online} arrangement={a} />
      <h3 className="wk-rail-exam__title">{RAIL_TOOL_LABELS_AR.cases}</h3>
      <CasesTab doc={p.doc} online={p.online} examMode />
    </div>
  ) : (
    <SmartChat
      layout="rail"
      doc={p.doc}
      pageIndex={p.pageIndex}
      online={p.online}
      mode={mode}
      onJumpToPage={p.onReaderJump}
      onOpenTool={(t) => openTool(t)}
      consumeAsk={!p.onOpenChat}
      headerActions={p.onOpenChat ? <IconButton size="sm" variant="plain" label="افتح المحادثة بجانب الصفحة" icon={<Maximize2 size={16} />} onClick={p.onOpenChat} /> : null}
    />
  );

  return (
    <div className="wk-rail-mode-wrap">
      <p className="wk-rail-mode" data-mode={mode}>
        <span className="wk-rail-mode__name">{`وضع الدراسة: ${STUDY_MODE_LABELS_AR[mode]}`}</span>
        <span className="wk-rail-mode__hint">{STUDY_MODE_HINTS_AR[mode]}</span>
      </p>
      <Tabs value={tab} onValueChange={(v) => p.onTab(v as RailTab)} className="wk-rail-tabs">
        <TabList label="أقسام لوحة الدراسة" className="wk-rail-tablist">
          <Tab value="chat" icon={<MessageSquareText size={16} />}>
            {a.chatLabel}
          </Tab>
          <Tab value="mine" icon={<NotebookPen size={16} />}>
            {RAIL_SECTION_LABELS_AR.mine}
          </Tab>
        </TabList>
        {a.hidden.length > 0 && (
          <p className="wk-rail-hidden" role="note">
            {`مخفي الآن: ${a.hidden.map((h) => `«${h}»`).join(' و')}. ${EXAM_MODE_HIDDEN_AR}`}
          </p>
        )}
        <TabPanel value="chat" className="wk-rail-panel wk-rail-panel--chat">
          {toolHidden && <p className="wk-muted" role="note">{`«${RAIL_TOOL_LABELS_AR[requested!]}» مخفي في هذا الوضع. ${EXAM_MODE_HIDDEN_AR}`}</p>}
          {first}
        </TabPanel>
        <TabPanel value="mine" className="wk-rail-panel">
          <MineTab
            doc={p.doc}
            pageIndex={p.pageIndex}
            sub={p.mineTab}
            onSub={p.onMineTab}
            draft={p.draft}
            onDraftConsumed={p.onDraftConsumed}
            anchorFor={p.anchorFor}
            onGoToPage={p.onGoToPage}
            online={p.online}
            notePages={p.notePages}
          />
        </TabPanel>
      </Tabs>
    </div>
  );
}
