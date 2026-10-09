// Written questions (§41; grading capability ai.grade_written). The owner types the answer (a draft is kept on this
// device while typing); a saved answer is never changed. Grading is an «تقييم تعليمي آلي، ليس تصحيحًا رسميًا»:
// rubric points bound to the sources (correct / partial / missing / wrong), an ESTIMATED score only when the rubric
// is sufficient, wrong statements with their evidence, an improved answer with evidence chips — otherwise
// qualitative notes without a misleading number.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CircleAlert, CircleCheck, CircleMinus, CircleX, Save, Sparkles } from 'lucide-react';
import { newId, type WrittenAssessmentView, type WrittenAttemptView, type WrittenQuestionView } from '@medlevo/shared';
import { Button, ErrorState, LoadingState, RichTextView, StatusPill, TextArea, buttonClass } from '../../design';
import { errorMessage } from '../../lib/api';
import { useCapabilities } from '../../lib/capabilities';
import { getDb } from '../../lib/localdb';
import { useOnline } from '../../lib/useOnline';
import { usePageTitle } from '../../lib/usePageTitle';
import { formatDateTime } from '../../lib/time';
import { examsApi } from './api';
import { ClaimChips, ClaimedText } from './ClaimedText';
import { loadWrittenDraft, saveWrittenDraft } from './local';
import { MixedLine } from './MixedLine';
import './exams.css';

const POINT_LABELS: Record<WrittenAssessmentView['points'][number]['status'], { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral'; icon: ReactNode }> = {
  correct: { label: 'مذكورة بشكل صحيح', tone: 'success', icon: <CircleCheck size={14} /> },
  partial: { label: 'مذكورة جزئيًا', tone: 'warning', icon: <CircleMinus size={14} /> },
  missing: { label: 'ناقصة', tone: 'neutral', icon: <CircleMinus size={14} /> },
  wrong: { label: 'خاطئة', tone: 'danger', icon: <CircleX size={14} /> },
};

export function WrittenScreen() {
  const { questionId = '' } = useParams();
  usePageTitle('إجابة مكتوبة');
  const caps = useCapabilities();
  const grade = caps.feature('ai.grade_written');
  const online = useOnline();
  const [view, setView] = useState<WrittenQuestionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [grading, setGrading] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setView(await examsApi.written(questionId));
    } catch (e) {
      setError(errorMessage(e, 'تعذّر تحميل السؤال.'));
    }
  }, [questionId]);

  useEffect(() => {
    void load();
    void loadWrittenDraft(getDb(), questionId).then((d) => d && setText(d));
  }, [load, questionId]);

  const onType = (v: string) => {
    setText(v);
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => void saveWrittenDraft(getDb(), questionId, v), 400);
  };

  const save = async () => {
    if (!view || !text.trim()) return;
    setSaving(true);
    setActionError(null);
    try {
      await examsApi.saveWritten({ id: newId(), question_id: view.question_id, question_version_id: view.question_version_id, answer_text: text, answered_at: Date.now() });
      await saveWrittenDraft(getDb(), questionId, '');
      setText('');
      await load();
    } catch (e) {
      setActionError(errorMessage(e, 'تعذّر حفظ الإجابة؛ مسودتك محفوظة على هذا الجهاز.'));
    } finally {
      setSaving(false);
    }
  };

  const gradeAttempt = async (a: WrittenAttemptView) => {
    setGrading(a.id);
    setActionError(null);
    try {
      await examsApi.gradeWritten(a.id);
      await load();
    } catch (e) {
      setActionError(errorMessage(e, 'تعذّر التقييم الآن.'));
      await load();
    } finally {
      setGrading(null);
    }
  };

  if (error) return <ErrorState message={error} onRetry={() => void load()} />;
  if (!view) return <LoadingState stage="جارٍ تحميل السؤال…" />;

  return (
    <div className="ml-page ml-page--narrow ex-page">
      <header className="ml-page__header">
        <h1 className="ml-page__title">إجابة مكتوبة</h1>
        <p className="ex-muted">
          <MixedLine text={view.origin_label_ar} />
        </p>
      </header>
      <section className="ex-sheet" aria-label="السؤال">
        <RichTextView value={view.stem} variant="reading" />
      </section>

      <section className="ex-written" aria-labelledby="ex-written-h">
        <h2 id="ex-written-h" className="ex-subhead">
          إجابتك
        </h2>
        <TextArea
          label="اكتب إجابتك"
          hint="تُحفظ مسودتك على هذا الجهاز أثناء الكتابة. التعرف على الكتابة اليدوية غير متاح في هذا الإصدار؛ اكتب النص بنفسك."
          rows={8}
          value={text}
          onChange={(e) => onType(e.target.value)}
        />
        {actionError && (
          <p className="ex-note ex-note--warn" role="alert">
            {actionError}
          </p>
        )}
        <Button variant="primary" icon={<Save size={16} />} loading={saving} disabled={!text.trim() || !online} onClick={() => void save()}>
          احفظ الإجابة
        </Button>
        {!online && <p className="ex-muted">الحفظ على الخادم يحتاج اتصالًا؛ مسودتك محفوظة هنا.</p>}
      </section>

      {view.attempts.length > 0 && (
        <section aria-labelledby="ex-attempts-h">
          <h2 id="ex-attempts-h" className="ex-subhead">
            إجاباتك السابقة
          </h2>
          <ol className="ex-items">
            {view.attempts.map((a) => (
              <li key={a.id} className="ex-item">
                <p className="ex-muted">{formatDateTime(a.answered_at)}</p>
                <p className="ex-written__answer">
                  <MixedLine text={a.answer_text} />
                </p>
                {a.status !== 'graded' && (
                  <div className="ml-cluster">
                    <Button variant="secondary" icon={<Sparkles size={16} />} loading={grading === a.id} disabled={!grade.available || !online} aria-describedby={!grade.available ? 'ex-grade-why' : undefined} onClick={() => void gradeAttempt(a)}>
                      قيّم إجابتي
                    </Button>
                    {a.status === 'grading_failed' && a.error_ar && <span className="ex-muted">{a.error_ar}</span>}
                  </div>
                )}
                {a.assessment && <AssessmentView a={a.assessment} />}
              </li>
            ))}
          </ol>
          {!grade.available && (
            <p id="ex-grade-why" className="ex-muted">
              التقييم الآلي: {grade.reason}
            </p>
          )}
        </section>
      )}
      <Link to="/exams" className={buttonClass({ variant: 'plain' })}>
        العودة إلى الاختبارات
      </Link>
    </div>
  );
}

export function AssessmentView({ a }: { a: WrittenAssessmentView }) {
  const rubric = new Map(a.rubric.map((r) => [r.id, r]));
  return (
    <section className="ex-assessment" aria-label={a.label_ar}>
      <p className="ex-assessment__label">
        <CircleAlert size={16} aria-hidden="true" /> {a.label_ar}
      </p>
      {a.kind === 'rubric_score' && a.estimated_score ? (
        <p>
          <strong>
            تقدير: {a.estimated_score.got} من {a.estimated_score.max}
          </strong>{' '}
          <span className="ex-muted">({a.rubric_origin === 'question' ? 'على معيار السؤال' : 'على معيار مبني من مصادرك'} — تقدير تعليمي وليس درجة رسمية)</span>
        </p>
      ) : (
        <p className="ex-muted">لا درجة: المعيار غير كافٍ لتقدير دقيق، فعُرضت ملاحظات نوعية.</p>
      )}
      {a.points.length > 0 && (
        <ul className="ex-list">
          {a.points.map((p) => {
            const r = rubric.get(p.rubric_id);
            const l = POINT_LABELS[p.status];
            return (
              <li key={p.rubric_id}>
                <StatusPill tone={l.tone} icon={l.icon}>
                  {l.label}
                </StatusPill>{' '}
                {r && (
                  <>
                    <MixedLine text={r.text} />
                    {r.claim_id && <ClaimChips claim={a.claims[r.claim_id]} />}
                  </>
                )}
                {p.note && <span className="ex-muted"> — {p.note}</span>}
              </li>
            );
          })}
        </ul>
      )}
      {a.wrong_statements.length > 0 && (
        <>
          <h3 className="ex-subhead">عبارات تحتاج تصحيحًا</h3>
          <ul className="ex-list">
            {a.wrong_statements.map((w, i) => (
              <li key={i}>
                «<MixedLine text={w.text} />» — <MixedLine text={w.why} />
              </li>
            ))}
          </ul>
        </>
      )}
      {a.improved_answer && (
        <>
          <h3 className="ex-subhead">إجابة محسّنة من المصادر</h3>
          <ClaimedText value={a.improved_answer} claims={a.claims} />
        </>
      )}
      {a.qualitative_feedback.length > 0 && (
        <>
          <h3 className="ex-subhead">ملاحظات على البناء والاكتمال</h3>
          <ul className="ex-list">
            {a.qualitative_feedback.map((f, i) => (
              <li key={i}>
                <MixedLine text={f} />
              </li>
            ))}
          </ul>
        </>
      )}
      {a.notes_ar.map((n, i) => (
        <p key={i} className="ex-muted">
          {n}
        </p>
      ))}
      {a.removed.length > 0 && <p className="ex-muted">حُذفت {a.removed.length} جملة من الإجابة المحسنة لأنها لم تجتز التحقق من الأدلة.</p>}
    </section>
  );
}
