// /weakness/replay/:questionId?attempt_id= — Reasoning Replay (§44): a structured TEACHING explanation of why one answer
// wins and the others lose, built only from the question version (its explanation, distractor explanations, claims and
// answer evidence) — never presented as a model's hidden reasoning. Every missing part is said; completing it needs AI
// through the evidence-checked explain flow (gated with the real reason).
import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ArrowRight, CircleCheck, CircleHelp, Info, UserCheck } from 'lucide-react';
import { ANSWER_STATUS_LABELS_AR, type AnswerStatus, type ReasoningReplayView } from '@medlevo/shared';
import { ErrorState, LoadingState, RichTextView, StatusPill, buttonClass } from '../../design';
import { errorMessage } from '../../lib/api';
import { usePageTitle } from '../../lib/usePageTitle';
import { CitationChip } from '../evidence';
import { ClaimedText } from '../exams/ClaimedText';
import { learningApi } from '../review/api';
import { questionUrl } from '../review/links';
import '../exams/exams.css';
import '../review/learning.css';
import './weakness.css';

const SOURCE_AR: Record<ReasoningReplayView['content_source'], string> = {
  question_explanation: 'من شرح السؤال المحفوظ وأدلته',
  evidence_only: 'من أدلة الإجابة فقط (لا يوجد شرح محفوظ)',
  none: 'لا يوجد شرح ولا أدلة محفوظة لهذا السؤال',
};

export function ReplayScreen() {
  usePageTitle('لماذا هذه الإجابة؟');
  const { questionId = '' } = useParams();
  const [params] = useSearchParams();
  const attemptId = params.get('attempt_id');
  const [r, setR] = useState<ReasoningReplayView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void learningApi
      .replay(questionId, attemptId)
      .then(setR)
      .catch((e) => setError(errorMessage(e, 'تعذّر تحميل الشرح.')));
  }, [questionId, attemptId]);

  return (
    <div className="ml-page ml-page--narrow lw-page">
      <header className="ml-page__header lw-head">
        <div>
          <h1 className="ml-page__title">
            لماذا ترجح إجابة على أخرى؟ <bdi dir="ltr" lang="en" className="lw-term">Reasoning Replay</bdi>
          </h1>
          {r && <p className="ml-page__lede">{r.label_ar}</p>}
        </div>
        <Link to="/weakness" className={buttonClass({ variant: 'plain' })}>
          <ArrowRight size={16} aria-hidden="true" />
          نقاط الضعف
        </Link>
      </header>
      {error && <ErrorState message={error} />}
      {!r && !error && <LoadingState stage="جارٍ تحميل السؤال وشرحه…" />}
      {r && (
        <div className="lw-stack">
          <section className="lw-sheet" aria-label="السؤال">
            <p className="lw-muted">{SOURCE_AR[r.content_source]}</p>
            <RichTextView value={r.stem} className="lw-face__text" />
            {!r.key_known && (
              <p className="lw-note lw-note--warn" role="note">
                <CircleHelp size={16} aria-hidden="true" />
                <span>{`مفتاح هذا السؤال غير محسوم (${ANSWER_STATUS_LABELS_AR[r.answer_status as AnswerStatus] ?? r.answer_status})؛ لا يُعرض أي خيار على أنه الأفضل.`}</span>
              </p>
            )}
            <ol className="lw-replay">
              {r.options.map((o) => (
                <li key={o.option_id} className="lw-replay__opt" data-best={o.is_best || undefined} data-mine={o.chosen_by_you || undefined}>
                  <div className="lw-replay__head">
                    <span className="lw-replay__label">{o.label}</span>
                    <RichTextView value={o.text} className="lw-replay__text" />
                    <span className="ml-cluster">
                      {o.is_best && (
                        <StatusPill tone="success" icon={<CircleCheck size={14} />}>
                          الإجابة الأفضل
                        </StatusPill>
                      )}
                      {o.chosen_by_you && (
                        <StatusPill tone="neutral" icon={<UserCheck size={14} />}>
                          اختيارك
                        </StatusPill>
                      )}
                    </span>
                  </div>
                  {o.why ? <ClaimedText value={o.why} claims={r.claims} className="lw-replay__why" /> : <p className="lw-muted">{o.is_best ? 'لا يوجد شرح محفوظ لسبب ترجيح هذا الخيار.' : `لا يوجد شرح محفوظ لسبب استبعاد الخيار ${o.label}.`}</p>}
                </li>
              ))}
            </ol>
          </section>

          {r.explanation && r.explanation.paragraphs.length > 0 && (
            <section className="lw-sheet" aria-labelledby="lw-rp-exp">
              <h2 id="lw-rp-exp" className="lw-sheet__title">
                الشرح العام
              </h2>
              <ClaimedText value={r.explanation} claims={r.claims} />
            </section>
          )}

          {r.evidence.length > 0 && (
            <section className="lw-sheet" aria-labelledby="lw-rp-ev">
              <h2 id="lw-rp-ev" className="lw-sheet__title">
                أدلة الإجابة
              </h2>
              <ul className="lw-evidence lw-evidence--compact">
                {r.evidence.map((ev) => (
                  <li key={ev.id} className="lw-evidence__item">
                    <CitationChip evidence={ev} />
                  </li>
                ))}
              </ul>
            </section>
          )}

          {r.missing_ar.length > 0 && (
            <section className="lw-sheet" aria-labelledby="lw-rp-miss">
              <h2 id="lw-rp-miss" className="lw-sheet__title">
                ما ينقص هذا الشرح
              </h2>
              <ul className="lw-basis">
                {r.missing_ar.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
              {r.ai.needed && (
                <p className="lw-note" role="note">
                  <Info size={16} aria-hidden="true" />
                  <span>
                    {r.ai.available
                      ? 'يمكن إكمال الشرح من المحاضرة عبر «اشرح» في مساحة الدراسة؛ يُولَّد من مصادرك ويُتحقق من أدلته قبل عرضه.'
                      : `إكمال الشرح يحتاج الذكاء الاصطناعي: ${r.ai.reason_ar ?? 'غير مهيأ على الخادم.'} لا يُعرض شرح مخمَّن بدلًا منه.`}
                  </span>
                </p>
              )}
            </section>
          )}

          {r.attempt && (
            <p className="lw-muted">{`محاولتك: ${r.attempt.is_correct === null ? 'غير محسوبة' : r.attempt.is_correct ? 'صحيحة' : 'خاطئة'}${r.attempt.confidence ? ` — ثقتك: ${r.attempt.confidence === 'guess' ? 'تخمين' : r.attempt.confidence === 'unsure' ? 'غير متأكد' : 'واثق'}` : ''}${r.attempt.hints_used ? ` — تلميحات: ${r.attempt.hints_used}` : ''}.`}</p>
          )}
          <Link className="lw-link" to={questionUrl(r.question_id)}>
            افتح السؤال في خزنة الأسئلة
          </Link>
        </div>
      )}
    </div>
  );
}
