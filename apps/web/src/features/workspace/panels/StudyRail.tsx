// Contextual Study Rail (§30): four sections instead of nine squeezed tabs — explain & ask, questions,
// sources, my notes (with bookmarks and «تحتاج إعادة ربط» inside). Features that arrive later are shown
// disabled with their reason (§61), never as working buttons.
import { BookMarked, FileSearch, MessageCircleQuestion, NotebookPen } from 'lucide-react';
import type { AnnotationAnchor, SourcePageView } from '@medlevo/shared';
import { Button, Tab, TabList, TabPanel, Tabs, Term } from '../../../design';
import { useCapabilities } from '../../../lib/capabilities';
import type { SourceDocument } from '../data/useSourceDocument';
import { NOT_WIRED_AR, pendingActionReason, SELECTION_AI_ACTIONS } from '../model/aiActions';
import { MineTab, type MineTabValue, type NoteDraft } from './MineTab';
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
        <ExplainTab />
      </TabPanel>
      <TabPanel value="questions" className="wk-rail-panel">
        <QuestionsTab />
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
        />
      </TabPanel>
    </Tabs>
  );
}

function ExplainTab() {
  const caps = useCapabilities();
  const explain = caps.feature('ai.explain');
  const chat = caps.feature('ai.chat');
  return (
    <div className="wk-rail-section">
      <p className="wk-rail-lede">
        الشرح والأسئلة هنا يرتبطان دائمًا بما تحدده في الصفحة وبنسختها، ويلتزمان بقفل المصدر. لا تولّد هذه اللوحة أي شرح في هذا الإصدار.
      </p>
      <div className="wk-disabled-card" role="note">
        <p className="wk-disabled-card__title">غير متاح الآن</p>
        <p className="wk-muted">{!explain.available && explain.reason ? explain.reason : NOT_WIRED_AR}</p>
      </div>
      <ul className="wk-pending-list" role="list">
        {SELECTION_AI_ACTIONS.slice(0, 5).map((a) => {
          const reason = pendingActionReason(caps.feature(a.feature));
          return (
            <li key={a.id}>
              <Button size="sm" variant="secondary" disabled aria-describedby={`wk-why-${a.id}`}>
                {a.label} <Term>{a.term}</Term>
              </Button>
              <span id={`wk-why-${a.id}`} className="ml-visually-hidden">
                {reason}
              </span>
            </li>
          );
        })}
      </ul>
      {!chat.available && chat.reason && chat.reason !== explain.reason && <p className="wk-muted">المحادثة: {chat.reason}</p>}
      <p className="wk-muted">حدّد نصًا في الصفحة لترى أدوات التحديد المتاحة الآن: التظليل والتسطير والنسخ والملاحظات.</p>
    </div>
  );
}

function QuestionsTab() {
  const caps = useCapabilities();
  const vault = caps.feature('questions.vault');
  return (
    <div className="wk-rail-section">
      <p className="wk-rail-lede">
        الأسئلة المرتبطة بهذه الصفحة — من امتحاناتك السابقة ومصادر أسئلتك — تظهر هنا عندما تصل خزانة الأسئلة (<Term>Question Vault</Term>).
      </p>
      <div className="wk-disabled-card" role="note">
        <p className="wk-disabled-card__title">غير متاح الآن</p>
        <p className="wk-muted">{vault.available ? NOT_WIRED_AR : (vault.reason ?? NOT_WIRED_AR)}</p>
      </div>
    </div>
  );
}
