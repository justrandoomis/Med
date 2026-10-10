// Contextual Study Rail (§30): five sections instead of nine squeezed tabs — explain & ask, questions, cases, sources,
// my notes (with bookmarks and «تحتاج إعادة ربط» inside). The study mode (§39, track F3) arranges them: their order,
// the section a mode opens on, and — in «امتحن نفسك» — the sections that stay hidden (explanations, the source
// inspector) with the reason in words. Features that arrive later are shown disabled with their reason (§61).
import { BookMarked, FileSearch, MessageCircleQuestion, NotebookPen, Stethoscope } from 'lucide-react';
import { EXAM_MODE_HIDDEN_AR, STUDY_MODE_HINTS_AR, STUDY_MODE_LABELS_AR, type AnnotationAnchor, type SourcePageView, type StudyMode } from '@medlevo/shared';
import { Tab, TabList, TabPanel, Tabs } from '../../../design';
import type { SourceDocument } from '../data/useSourceDocument';
import { arrangementFor, RAIL_SECTION_LABELS_AR, visibleTab, type RailSection } from '../modes/arrangement';
import { DiagramPanel } from '../../studybook/diagrams/DiagramPanel';
import { CasesTab } from './CasesTab';
import { ExplainTab } from './ExplainTab';
import { QuestionsTab } from './QuestionsTab';
import { MineTab, type MineNotePages, type MineTabValue, type NoteDraft } from './MineTab';
import { SourcesTab } from './SourcesTab';
import '../modes/modes.css';

export type RailTab = RailSection;

export interface StudyRailProps {
  doc: SourceDocument;
  page: SourcePageView | null;
  pageIndex: number;
  tab: RailTab;
  onTab: (t: RailTab) => void;
  mineTab: MineTabValue;
  onMineTab: (t: MineTabValue) => void;
  draft: NoteDraft | null;
  onDraftConsumed: () => void;
  anchorFor: (pageIndex: number) => AnnotationAnchor | null;
  onGoToPage: (pageIndex: number) => void;
  onOpenSplit: (sourceId: string) => void;
  splitReason: string | null;
  online: boolean;
  /** the source's inserted note pages (track F1) */
  notePages?: MineNotePages;
  /** (track F3) the study mode arranging the rail; defaults to «تعلّم» */
  mode?: StudyMode;
}

const ICONS: Record<RailSection, typeof BookMarked> = {
  explain: MessageCircleQuestion,
  questions: FileSearch,
  cases: Stethoscope,
  sources: BookMarked,
  mine: NotebookPen,
};

export function StudyRail(p: StudyRailProps) {
  const mode = p.mode ?? 'learn';
  const a = arrangementFor(mode);
  const tab = visibleTab(a, p.tab);
  return (
    <div className="wk-rail-mode-wrap">
      <p className="wk-rail-mode" data-mode={mode}>
        <span className="wk-rail-mode__name">{`وضع الدراسة: ${STUDY_MODE_LABELS_AR[mode]}`}</span>
        <span className="wk-rail-mode__hint">{STUDY_MODE_HINTS_AR[mode]}</span>
      </p>
      <Tabs value={tab} onValueChange={(v) => p.onTab(v as RailTab)} className="wk-rail-tabs">
        <TabList label="أقسام لوحة الدراسة" className={a.railOrder.length > 4 ? 'wk-rail-tablist wk-rail-tablist--dense' : 'wk-rail-tablist'}>
          {a.railOrder.map((s) => {
            const Icon = ICONS[s];
            return (
              <Tab key={s} value={s} icon={<Icon size={16} />}>
                {RAIL_SECTION_LABELS_AR[s]}
              </Tab>
            );
          })}
        </TabList>
        {a.hidden.length > 0 && (
          <p className="wk-rail-hidden" role="note">
            {`مخفي الآن: ${a.hidden.map((h) => `«${RAIL_SECTION_LABELS_AR[h]}»`).join(' و')}. ${EXAM_MODE_HIDDEN_AR}`}
          </p>
        )}
        {a.railOrder.includes('explain') && (
          <TabPanel value="explain" className="wk-rail-panel">
            <ExplainTab doc={p.doc} page={p.page} pageIndex={p.pageIndex} online={p.online} />
            <DiagramPanel doc={p.doc} page={p.page} online={p.online} />
          </TabPanel>
        )}
        <TabPanel value="questions" className="wk-rail-panel">
          <QuestionsTab doc={p.doc} page={p.page} pageIndex={p.pageIndex} onGoToPage={p.onGoToPage} online={p.online} arrangement={a} />
        </TabPanel>
        <TabPanel value="cases" className="wk-rail-panel">
          <CasesTab doc={p.doc} online={p.online} examMode={mode === 'exam'} />
        </TabPanel>
        {a.railOrder.includes('sources') && (
          <TabPanel value="sources" className="wk-rail-panel">
            <SourcesTab doc={p.doc} page={p.page} onOpenSplit={p.onOpenSplit} splitReason={p.splitReason} />
          </TabPanel>
        )}
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
