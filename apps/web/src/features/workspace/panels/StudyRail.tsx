// Contextual Study Rail (§30): four sections instead of nine squeezed tabs — explain & ask, questions,
// sources, my notes (with bookmarks and «تحتاج إعادة ربط» inside). Features that arrive later are shown
// disabled with their reason (§61), never as working buttons.
import { BookMarked, FileSearch, MessageCircleQuestion, NotebookPen } from 'lucide-react';
import type { AnnotationAnchor, SourcePageView } from '@medlevo/shared';
import { Tab, TabList, TabPanel, Tabs } from '../../../design';
import type { SourceDocument } from '../data/useSourceDocument';
import { ExplainTab } from './ExplainTab';
import { QuestionsTab } from './QuestionsTab';
import { MineTab, type MineNotePages, type MineTabValue, type NoteDraft } from './MineTab';
import { SourcesTab } from './SourcesTab';

export type RailTab = 'explain' | 'questions' | 'sources' | 'mine';

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
}

export function StudyRail(p: StudyRailProps) {
  return (
    <Tabs value={p.tab} onValueChange={(v) => p.onTab(v as RailTab)} className="wk-rail-tabs">
      <TabList label="أقسام لوحة الدراسة" className="wk-rail-tablist">
        <Tab value="explain" icon={<MessageCircleQuestion size={16} />}>
          الشرح والسؤال
        </Tab>
        <Tab value="questions" icon={<FileSearch size={16} />}>
          الأسئلة
        </Tab>
        <Tab value="sources" icon={<BookMarked size={16} />}>
          المصادر
        </Tab>
        <Tab value="mine" icon={<NotebookPen size={16} />}>
          ملاحظاتي
        </Tab>
      </TabList>
      <TabPanel value="explain" className="wk-rail-panel">
        <ExplainTab doc={p.doc} page={p.page} pageIndex={p.pageIndex} online={p.online} />
      </TabPanel>
      <TabPanel value="questions" className="wk-rail-panel">
        <QuestionsTab doc={p.doc} page={p.page} pageIndex={p.pageIndex} onGoToPage={p.onGoToPage} online={p.online} />
      </TabPanel>
      <TabPanel value="sources" className="wk-rail-panel">
        <SourcesTab doc={p.doc} page={p.page} onOpenSplit={p.onOpenSplit} splitReason={p.splitReason} />
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
  );
}
