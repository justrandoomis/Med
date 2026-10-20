// Split Study with the lecture's questions or the explanations (§26 «محاضرة وأسئلة … محاضرة وشرح»; Round 7 — H3 item 3).
// The lecture stays in the main pane (its page, zoom and place are untouched — it is the same canvas); the second pane
// shows «الأسئلة المرتبطة» (following the lecture page, like the rail's tab) or «الشرح والسؤال». Both kinds stay mounted
// once opened: switching between them keeps each one's state (loaded questions, the explanation run, an unsent
// question), and the choice is saved with the study session so a reload reopens the same split. The study mode arranges
// what each shows (questions in «امتحن نفسك» hide their reasons; explanations are not offered there at all).
import { useState } from 'react';
import { X } from 'lucide-react';
import type { SourcePageView } from '@medlevo/shared';
import { IconButton, SegmentedControl, Tooltip, cx } from '../../../design';
import type { SourceDocument } from '../data/useSourceDocument';
import type { ModeArrangement } from '../modes/arrangement';
import { ExplainTab } from '../panels/ExplainTab';
import { QuestionsTab } from '../panels/QuestionsTab';

export type SplitSideKind = 'questions' | 'explain';
export const SPLIT_SIDE_LABELS_AR: Record<SplitSideKind, string> = {
  questions: 'الأسئلة المرتبطة',
  explain: 'الشرح والسؤال',
};

export interface SplitSidePaneProps {
  kind: SplitSideKind;
  onKind: (k: SplitSideKind) => void;
  doc: SourceDocument;
  page: SourcePageView | null;
  pageIndex: number;
  online: boolean;
  onGoToPage: (pageIndex: number) => void;
  arrangement: ModeArrangement;
  /** why the explanations are not offered (e.g. «امتحن نفسك») — null when they are */
  explainHiddenReason: string | null;
  onClose: () => void;
}

export function SplitSidePane({ kind, onKind, doc, page, pageIndex, online, onGoToPage, arrangement, explainHiddenReason, onClose }: SplitSidePaneProps) {
  // a kind is mounted the first time it is shown and then kept (hidden) so switching never loses its state
  const [opened, setOpened] = useState<ReadonlySet<SplitSideKind>>(() => new Set([kind]));
  if (!opened.has(kind)) setOpened(new Set([...opened, kind]));
  const showExplain = opened.has('explain') && !explainHiddenReason;
  return (
    <section className="wk-split wk-split-side" aria-label={`بجانب المحاضرة: ${SPLIT_SIDE_LABELS_AR[kind]}`}>
      <header className="wk-split__bar">
        <SegmentedControl<SplitSideKind>
          label="ما يُعرض بجانب المحاضرة"
          size="sm"
          value={kind}
          onValueChange={onKind}
          options={[
            { value: 'questions', label: SPLIT_SIDE_LABELS_AR.questions },
            { value: 'explain', label: SPLIT_SIDE_LABELS_AR.explain, disabled: !!explainHiddenReason },
          ]}
        />
        <span className="wk-split-side__spacer" />
        <Tooltip content="إغلاق الجزء الجانبي" describe={false}>
          <IconButton label="إغلاق الجزء الجانبي" icon={<X size={16} />} size="sm" onClick={onClose} />
        </Tooltip>
      </header>
      {explainHiddenReason && kind === 'explain' && <p className="wk-muted wk-split-side__note">{explainHiddenReason}</p>}
      <div className={cx('wk-split-side__body', kind !== 'questions' && 'is-hidden')} hidden={kind !== 'questions'}>
        {opened.has('questions') && <QuestionsTab doc={doc} page={page} pageIndex={pageIndex} onGoToPage={onGoToPage} online={online} arrangement={arrangement} />}
      </div>
      <div className={cx('wk-split-side__body', kind !== 'explain' && 'is-hidden')} hidden={kind !== 'explain'}>
        {showExplain && <ExplainTab doc={doc} page={page} pageIndex={pageIndex} online={online} />}
      </div>
    </section>
  );
}
