// «الأسئلة» rail tab — slot owned by the Question Vault track (Round 3).
// Shows source questions linked to this lecture/page (with origin label) and generated ones allowed in context.
import type { SourcePageView } from '@medlevo/shared';
import type { SourceDocument } from '../data/useSourceDocument';
import { Term } from '../../../design';
import { useCapabilities } from '../../../lib/capabilities';
import { NOT_WIRED_AR } from '../model/aiActions';

export interface QuestionsTabProps {
  doc: SourceDocument;
  page: SourcePageView | null;
  pageIndex: number;
  onGoToPage: (pageIndex: number) => void;
  online: boolean;
}

export function QuestionsTab(_props: QuestionsTabProps) {
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
