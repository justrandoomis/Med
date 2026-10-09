// «تدرّب» — the practice route (/practice?source_id=&question_id=) belongs to the exams track. Until it exists the
// button is disabled with the honest reason from the capability registry (§61), never a dead button.
import { Link } from 'react-router-dom';
import { GraduationCap } from 'lucide-react';
import { practiceUrl } from '@medlevo/shared';
import { Button, buttonClass } from '../../design';
import { useCapabilities } from '../../lib/capabilities';

/** `reasonShownElsewhere`: the reason is rendered once by the caller (a list), and `describedBy` points at it. */
export function PracticeButton({
  sourceId,
  questionId,
  size = 'md',
  describedBy,
  reasonShownElsewhere = false,
}: {
  sourceId: string;
  questionId: string;
  size?: 'sm' | 'md';
  describedBy?: string;
  reasonShownElsewhere?: boolean;
}) {
  const caps = useCapabilities();
  const gate = caps.feature('exams');
  if (gate.available) {
    return (
      <Link to={practiceUrl(sourceId, questionId)} className={buttonClass({ variant: 'secondary', size })}>
        <GraduationCap size={16} aria-hidden="true" />
        تدرّب
      </Link>
    );
  }
  const reasonId = describedBy ?? `practice-why-${questionId}`;
  if (reasonShownElsewhere) {
    return (
      <Button size={size} variant="secondary" icon={<GraduationCap size={16} />} disabled aria-describedby={reasonId}>
        تدرّب
      </Button>
    );
  }
  return (
    <span className="qv-gated">
      <Button size={size} variant="secondary" icon={<GraduationCap size={16} />} disabled aria-describedby={reasonId}>
        تدرّب
      </Button>
      <span id={reasonId} className="qv-gated__reason">
        {gate.reason ?? 'التدريب غير متاح بعد.'}
      </span>
    </span>
  );
}
