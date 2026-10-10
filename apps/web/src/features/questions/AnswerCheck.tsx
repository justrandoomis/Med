// «التحقق من الإجابة بأدلة المحاضرة» (§34 AI-derived Answer / Conflicting Key; AC-14, AC-15). An independent model
// solves the question from the linked lecture's excerpts only (it never sees the key) and every sentence of its support
// is verified against the evidence. The result is shown with its evidence chips; a conflict with the printed key is
// shown as a conflict (the key and past results are never changed silently). Without an AI provider the button is
// disabled with the server's reason (capability `ai.answer_check`), never a dead button.
import { useId, useState } from 'react';
import { ScanSearch } from 'lucide-react';
import type { AnswerCheckOutcome, QuestionDetailResponse } from '@medlevo/shared';
import { Button, StatusPill, useToast, type StatusTone } from '../../design';
import { errorMessage } from '../../lib/api';
import { useCapabilities } from '../../lib/capabilities';
import { formatDateTime } from '../../lib/time';
import { ClaimChips } from '../exams/ClaimedText';
import { questionsApi } from './api';
import { MixedText } from './labels';

export const ANSWER_CHECK_OUTCOME_LABELS_AR: Record<AnswerCheckOutcome, string> = {
  agrees: 'الأدلة تؤيد المفتاح',
  conflicts: 'تعارض بين المفتاح والأدلة',
  derived: 'حل مولد من الأدلة (AI-derived)',
  unresolved: 'لم تُحسم الإجابة',
  abstained: 'لا أدلة كافية',
};
const TONE: Record<AnswerCheckOutcome, StatusTone> = { agrees: 'success', conflicts: 'danger', derived: 'info', unresolved: 'warning', abstained: 'neutral' };

export function AnswerCheckSection({ d, onChanged }: { d: QuestionDetailResponse; onChanged: () => void }) {
  const caps = useCapabilities();
  const gate = caps.feature('ai.answer_check');
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reasonId = useId();
  const v = d.question.current;
  const check = v.key_details?.answer_check ?? null;
  const hasLecture = d.question.lecture_links.some((l) => l.status !== 'rejected');
  if (v.options.length < 2) return null;
  const blocked = !gate.available
    ? (gate.reason ?? 'التحقق من الإجابة بالأدلة غير متاح الآن.')
    : !hasLecture
      ? 'لا توجد محاضرة مرتبطة بهذا السؤال؛ اربطه بمحاضرة أولًا كي يُتحقق من إجابته بأدلتها.'
      : d.question.status === 'retired'
        ? 'هذا السؤال مستبعد.'
        : null;
  const claims = check ? check.claim_ids.map((id) => d.answer_check_claims?.[id]).filter((c): c is NonNullable<typeof c> => !!c) : [];

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await questionsApi.answerCheck(d.question.id);
      toast.show({ tone: r.check.outcome === 'conflicts' ? 'warning' : 'success', title: ANSWER_CHECK_OUTCOME_LABELS_AR[r.check.outcome], description: r.impact?.summary_ar ?? r.check.reason_ar });
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="qv-section" aria-labelledby="qv-check-h">
      <h2 id="qv-check-h" className="qv-section__h">
        التحقق من الإجابة بأدلة المحاضرة
      </h2>
      <p className="qv-muted">
        يحل نموذج مستقل السؤال من مقتطفات المحاضرة المرتبطة فقط دون أن يرى المفتاح، ثم تُتحقق كل جملة من تعليله بالأدلة. لا يُصحَّح مفتاح المصدر ولا نتائجك السابقة
        تلقائيًا.
      </p>
      <span className="qv-gated">
        <Button variant="secondary" icon={<ScanSearch size={18} />} onClick={() => void run()} disabled={!!blocked || busy} aria-describedby={blocked ? reasonId : undefined}>
          {busy ? 'جارٍ التحقق…' : 'تحقق من الإجابة بالأدلة'}
        </Button>
        {blocked && (
          <span id={reasonId} className="qv-gated__reason">
            {blocked}
          </span>
        )}
      </span>
      {error && (
        <p className="qv-alert" role="alert">
          {error}
        </p>
      )}
      {check && (
        <div className="qv-card" aria-live="polite">
          <div className="ml-cluster">
            <StatusPill tone={TONE[check.outcome]}>{ANSWER_CHECK_OUTCOME_LABELS_AR[check.outcome]}</StatusPill>
            <span className="qv-muted">{formatDateTime(check.checked_at)}</span>
          </div>
          <p className={check.outcome === 'conflicts' ? 'qv-alert' : undefined} role={check.outcome === 'conflicts' ? 'note' : undefined}>
            <MixedText text={check.reason_ar} />
          </p>
          {claims.length > 0 && (
            <ul className="qv-cards" role="list" aria-label="أدلة التعليل">
              {claims.map((c) => (
                <li key={c.id}>
                  <MixedText text={c.text} /> <ClaimChips claim={c} />
                </li>
              ))}
            </ul>
          )}
          {check.scope_describe_ar && <p className="qv-muted">النطاق: {check.scope_describe_ar}</p>}
        </div>
      )}
    </section>
  );
}
