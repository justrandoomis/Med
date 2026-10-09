// «الشرح والسؤال» rail tab — slot owned by the Study Book / explanation track (Round 3).
// Receives the rail context so it can explain the current selection/page under the current Source Lock.
import type { SourcePageView } from '@medlevo/shared';
import type { SourceDocument } from '../data/useSourceDocument';
import { Button, Term } from '../../../design';
import { useCapabilities } from '../../../lib/capabilities';
import { NOT_WIRED_AR, pendingActionReason, SELECTION_AI_ACTIONS } from '../model/aiActions';

export interface ExplainTabProps {
  doc: SourceDocument;
  page: SourcePageView | null;
  pageIndex: number;
  online: boolean;
}

export function ExplainTab(_props: ExplainTabProps) {
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
