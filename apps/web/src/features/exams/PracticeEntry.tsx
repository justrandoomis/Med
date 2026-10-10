// /practice?source_id=&question_id= — the «تدرّب» entry used by the workspace Questions tab and the vault: creates a
// practice set that starts with this question (then the lecture's other questions) and opens the runner.
// Idempotent: the client attempt id is fixed for this visit, so a double render never creates two exams.
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { WRITTEN_QUESTION_TYPES, newId, writtenUrl, type ExamCreateRequest } from '@medlevo/shared';
import { ErrorState, LoadingState, buttonClass } from '../../design';
import { errorMessage, isApiError } from '../../lib/api';
import { usePageTitle } from '../../lib/usePageTitle';
import { examsApi } from './api';

export function PracticeEntry() {
  usePageTitle('تدريب');
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const sourceId = params.get('source_id');
  const questionId = params.get('question_id');
  // (track F3) the study mode's policy: «امتحن نفسك» → an assessed exam (no hints, solutions at the end); «راجع» →
  // revision; «تدرّب» → practice with Anti-shortcut. The server fixes the policy when the set is created.
  const modeParam = params.get('mode');
  const mode: ExamCreateRequest['mode'] = modeParam === 'exam' || modeParam === 'revision' ? modeParam : 'practice';
  const antiShortcut = params.get('anti_shortcut') === '1';
  const attemptId = useRef(newId());
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const title = mode === 'exam' ? 'امتحن نفسك من المحاضرة' : mode === 'revision' ? 'مراجعة من المحاضرة' : 'تدريب من المحاضرة';
    const policy = mode === 'practice' && antiShortcut ? { anti_shortcut: true } : undefined;
    const base: ExamCreateRequest = sourceId
      ? { title, mode, count: 10, source_ids: [sourceId], start_question_id: questionId, attempt_id: attemptId.current }
      : questionId
        ? { title: mode === 'exam' ? 'امتحن نفسك' : 'تدريب على سؤال', mode, count: 1, question_ids: [questionId], attempt_id: attemptId.current }
        : { title: 'تدريب', mode, count: 10, attempt_id: attemptId.current };
    const req: ExamCreateRequest = policy ? { ...base, policy } : base;
    (async () => {
      // a written question (short answer / essay) is answered in the written flow, not in the MCQ runner
      if (questionId) {
        const w = await examsApi.written(questionId).catch(() => null);
        if (w && (WRITTEN_QUESTION_TYPES as readonly string[]).includes(w.qtype)) return { written: true as const };
      }
      return { written: false as const, r: await examsApi.create(req) };
    })()
      .then((out) => {
        if (cancelled) return;
        if (out.written) navigate(writtenUrl(questionId!), { replace: true });
        else navigate(`/exams/${encodeURIComponent(out.r.session.attempt.id)}`, { replace: true });
      })
      .catch((e) => {
        if (cancelled) return;
        setError(isApiError(e) && e.offline ? 'بدء تدريب جديد يحتاج اتصالًا بالخادم. التدريبات التي فتحتها سابقًا تعمل دون اتصال من سجل الاختبارات.' : errorMessage(e, 'تعذّر بدء التدريب.'));
      });
    return () => {
      cancelled = true;
    };
  }, [sourceId, questionId, navigate, retry, mode, antiShortcut]);

  if (error) {
    return (
      <ErrorState
        message={error}
        onRetry={() => {
          setError(null);
          setRetry((r) => r + 1);
        }}
        actions={
          <Link to="/exams" className={buttonClass({ variant: 'secondary' })}>
            سجل الاختبارات
          </Link>
        }
      />
    );
  }
  return <LoadingState stage="جارٍ تجهيز التدريب…" />;
}
