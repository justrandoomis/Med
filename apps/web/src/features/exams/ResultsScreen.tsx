// Results (§39): explicit denominators (scored items), time, hints, AC-27 signals (guesses / hint-assisted answers
// are not independent mastery), by lecture and concept, unscored reasons, strong / weak areas, deterministic review
// suggestions, and every item with its correction, evidence and editable mistake type.
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { BookOpen, CircleCheck, CircleHelp, CircleMinus, CircleX, Flag, RotateCcw } from 'lucide-react';
import {
  MASTERY_SIGNAL_LABELS_AR,
  MISTAKE_TYPE_LABELS_AR,
  type AttemptFeedbackView,
  type ExamResultDetail,
  type ExamResultItem,
  type MistakeType,
} from '@medlevo/shared';
import { Button, ErrorState, LoadingState, StatusPill, buttonClass, useToast } from '../../design';
import { errorMessage, isApiError } from '../../lib/api';
import { getDb } from '../../lib/localdb';
import { getSyncEngine } from '../../lib/sync';
import { usePageTitle } from '../../lib/usePageTitle';
import { examsApi } from './api';
import { FeedbackPanel } from './FeedbackPanel';
import { localAttempt, registerExamAppliers, saveMistakeType } from './local';
import { MixedLine } from './MixedLine';
import { CONFIDENCE_LABELS_AR, answeredCount, durationAr, formatClock, isFinished, ofAr, questionsAr } from './model';
import './exams.css';

function ItemStatus({ item }: { item: ExamResultItem }) {
  if (!item.scored)
    return (
      <StatusPill tone="neutral" icon={<CircleHelp size={14} />}>
        غير محسوب
      </StatusPill>
    );
  if (!item.answered)
    return (
      <StatusPill tone="warning" icon={<CircleMinus size={14} />}>
        بلا إجابة
      </StatusPill>
    );
  return item.is_correct ? (
    <StatusPill tone="success" icon={<CircleCheck size={14} />}>
      صحيحة
    </StatusPill>
  ) : (
    <StatusPill tone="danger" icon={<CircleX size={14} />}>
      خاطئة
    </StatusPill>
  );
}

export function ResultsScreen() {
  const { attemptId = '' } = useParams();
  const toast = useToast();
  const [data, setData] = useState<ExamResultDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ answered: number; finished: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<Record<number, AttemptFeedbackView | 'loading' | string>>({});
  usePageTitle(data ? `نتيجة: ${data.title}` : 'النتيجة');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setPending(null);
    try {
      try {
        registerExamAppliers(getSyncEngine());
        await getSyncEngine().syncNow();
      } catch {
        // no engine / offline: the server copy may lag behind this device
      }
      setData(await examsApi.result(attemptId));
    } catch (e) {
      if (isApiError(e) && (e.status === 409 || e.offline)) {
        const local = await localAttempt(getDb(), attemptId);
        if (local?.state) {
          setPending({ answered: answeredCount(local.state), finished: isFinished(local.state) });
          return;
        }
      }
      setError(errorMessage(e, 'تعذّر تحميل النتيجة.'));
    } finally {
      setLoading(false);
    }
  }, [attemptId]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleItem = async (index: number) => {
    if (open[index] && open[index] !== 'loading') {
      setOpen(({ [index]: _x, ...rest }) => rest);
      return;
    }
    setOpen((o) => ({ ...o, [index]: 'loading' }));
    try {
      const fb = await examsApi.feedback(attemptId, index);
      setOpen((o) => ({ ...o, [index]: fb }));
    } catch (e) {
      setOpen((o) => ({ ...o, [index]: errorMessage(e) }));
    }
  };

  const changeMistake = async (index: number, type: MistakeType | null) => {
    const fb = open[index];
    if (!fb || typeof fb === 'string' || !fb.attempt) return;
    await saveMistakeType(getDb(), fb.attempt, type);
    try {
      void getSyncEngine().syncNow();
    } catch {
      // ignore
    }
    setOpen((o) => ({ ...o, [index]: { ...fb, attempt: { ...fb.attempt!, mistake_type: type, mistake_origin: 'owner' } } }));
    setData((d) => d && { ...d, items: d.items.map((it) => (it.index === index ? { ...it, mistake_type: type, mistake_origin: 'owner' } : it)) });
    toast.show({ title: 'حُفظ تصنيف الخطأ', tone: 'success' });
  };

  if (loading) return <LoadingState stage="جارٍ حساب النتيجة…" />;
  if (pending && !pending.finished) {
    // the attempt is still running on this device: the result (and the solutions) appear only after finishing
    return (
      <div className="ml-page ml-page--narrow ex-page">
        <h1 className="ml-page__title">المحاولة لم تنتهِ بعد</h1>
        <p className="ex-note" role="status">
          أجبت عن {questionsAr(pending.answered)} حتى الآن، وإجاباتك محفوظة على هذا الجهاز. تظهر النتيجة والحلول بعد إنهاء الاختبار.
        </p>
        <Link to={`/exams/${encodeURIComponent(attemptId)}`} className={buttonClass({ variant: 'primary' })}>
          أكمل الاختبار
        </Link>
      </div>
    );
  }
  if (pending) {
    return (
      <div className="ml-page ml-page--narrow ex-page">
        <h1 className="ml-page__title">النتيجة بانتظار المزامنة</h1>
        <p className="ex-note" role="status">
          أنهيت المحاولة على هذا الجهاز، وإجاباتك ({questionsAr(pending.answered)}) محفوظة عليه. تُحسب النتيجة على الخادم بعد وصول إجاباتك؛ لا يضيع منها شيء.
        </p>
        <Button variant="primary" icon={<RotateCcw size={16} />} onClick={() => void load()}>
          أعد المحاولة
        </Button>
      </div>
    );
  }
  if (error || !data) return <ErrorState message={error ?? 'تعذّر تحميل النتيجة.'} onRetry={() => void load()} />;

  const r = data;
  return (
    <div className="ml-page ex-page">
      <header className="ml-page__header ex-head">
        <div>
          <h1 className="ml-page__title">
            <MixedLine text={r.title} />
          </h1>
          <p className="ml-page__lede">النتيجة والتصحيح — الأدلة والحلول متاحة كاملة الآن.</p>
        </div>
        <div className="ml-cluster">
          <Link to="/exams/new" className={buttonClass({ variant: 'primary' })}>
            اختبار جديد
          </Link>
          <Link to="/exams" className={buttonClass({ variant: 'secondary' })}>
            السجل
          </Link>
        </div>
      </header>

      <section className="ex-summary" aria-label="ملخص النتيجة">
        <p className="ex-summary__score">
          <strong>{r.scored_items > 0 ? ofAr(r.correct, r.scored_items) : '—'}</strong>
          <span> إجابة صحيحة من الأسئلة المحسوبة</span>
        </p>
        <p className="ex-muted">{r.denominator_note_ar}</p>
        <ul className="ex-facts">
          <li>أُجيب {ofAr(r.answered, r.total_items)}</li>
          <li>
            الوقت: <bdi dir="ltr">{formatClock(r.elapsed_ms)}</bdi>
            <span className="ml-visually-hidden"> ({durationAr(r.elapsed_ms)})</span>
          </li>
          <li>التلميحات المستخدمة: {r.hints_used}</li>
          {r.unscored_reasons.length > 0 && <li>غير محسوبة: {questionsAr(r.unscored_reasons.length)}</li>}
        </ul>
        {(r.signals.correct_guess > 0 || r.signals.correct_after_hint > 0 || r.signals.solution_viewed > 0 || r.signals.confident_wrong > 0) && (
          <ul className="ex-list" aria-label="إشارات التعلم">
            {r.signals.correct_guess > 0 && <li>صحيحة بالتخمين: {r.signals.correct_guess} — لا تُعد إتقانًا</li>}
            {r.signals.correct_after_hint > 0 && <li>صحيحة بعد تلميح: {r.signals.correct_after_hint}</li>}
            {r.signals.solution_viewed > 0 && <li>رأيت الحل قبل الإجابة: {r.signals.solution_viewed}</li>}
            {r.signals.confident_wrong > 0 && <li>خاطئة رغم الثقة: {r.signals.confident_wrong} — تستحق المراجعة أولًا</li>}
          </ul>
        )}
        {r.missing_on_server > 0 && (
          <p className="ex-note ex-note--warn" role="status">
            {questionsAr(r.missing_on_server)} من إجاباتك لم تصل الخادم بعد؛ النتيجة ستُحدَّث بعد المزامنة.
          </p>
        )}
        {r.time && (
          <p className="ex-muted">
            ضمن الوقت المخصص: {ofAr(r.time.within_budget.correct, r.time.within_budget.total)} صحيحة؛ بعد تجاوزه: {ofAr(r.time.over_budget.correct, r.time.over_budget.total)}. {r.time.note_ar}
          </p>
        )}
      </section>

      {r.by_lecture.length > 0 && (
        <section aria-labelledby="ex-by-lecture">
          <h2 id="ex-by-lecture" className="ex-subhead">
            حسب المحاضرة
          </h2>
          <div className="ex-table-wrap">
            <table className="ex-table">
              <thead>
                <tr>
                  <th scope="col">المحاضرة</th>
                  <th scope="col">الصحيحة من المحسوبة</th>
                </tr>
              </thead>
              <tbody>
                {r.by_lecture.map((l) => (
                  <tr key={l.lecture_source_id ?? 'none'}>
                    <td>
                      <MixedLine text={l.label} />
                    </td>
                    <td>{ofAr(l.correct, l.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {(r.weak.length > 0 || r.strong.length > 0) && (
        <section className="ex-two" aria-label="نقاط القوة والضعف">
          {r.weak.length > 0 && (
            <div>
              <h2 className="ex-subhead">يحتاج مراجعة</h2>
              <ul className="ex-list">
                {r.weak.map((w) => (
                  <li key={w}>
                    <MixedLine text={w} />
                  </li>
                ))}
              </ul>
            </div>
          )}
          {r.strong.length > 0 && (
            <div>
              <h2 className="ex-subhead">جيد</h2>
              <ul className="ex-list">
                {r.strong.map((w) => (
                  <li key={w}>
                    <MixedLine text={w} />
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="ex-muted">تُحسب المجالات التي فيها سؤالان محسوبان على الأقل؛ عينة صغيرة لا تكفي لحكم عام.</p>
        </section>
      )}

      {r.suggested_review.length > 0 && (
        <section aria-labelledby="ex-review-h">
          <h2 id="ex-review-h" className="ex-subhead">
            خطة مراجعة مقترحة
          </h2>
          <ul className="ex-list">
            {r.suggested_review.map((s, i) => (
              <li key={i}>
                {s.kind === 'lecture_pages' && s.source_id && s.page_id ? (
                  <Link className="ex-link" to={`/study/${encodeURIComponent(s.source_id)}?page_id=${encodeURIComponent(s.page_id)}`}>
                    <BookOpen size={14} aria-hidden="true" /> <MixedLine text={s.label_ar} />
                  </Link>
                ) : s.kind === 'retry_question' && s.question_id ? (
                  <Link className="ex-link" to={`/practice?question_id=${encodeURIComponent(s.question_id)}`}>
                    <RotateCcw size={14} aria-hidden="true" /> {s.label_ar}
                  </Link>
                ) : s.question_id ? (
                  <Link className="ex-link" to={`/questions/${encodeURIComponent(s.question_id)}`}>
                    {s.label_ar}
                  </Link>
                ) : (
                  s.label_ar
                )}{' '}
                <span className="ex-muted">— {s.reason_ar}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {r.unscored_reasons.length > 0 && (
        <details className="ex-details">
          <summary>لماذا لم تُحتسب بعض الأسئلة ({r.unscored_reasons.length})</summary>
          <ul className="ex-list">
            {r.unscored_reasons.map((u, i) => (
              <li key={i}>{u.reason_ar}</li>
            ))}
          </ul>
        </details>
      )}

      <section aria-labelledby="ex-items-h">
        <h2 id="ex-items-h" className="ex-subhead">
          الأسئلة
        </h2>
        <ol className="ex-items">
          {r.items.map((it) => {
            const fb = open[it.index];
            return (
              <li key={it.index} className="ex-item">
                <div className="ex-item__head">
                  <span className="ex-item__n">{it.index + 1}</span>
                  <MixedLine text={it.stem_preview} className="ex-item__stem" />
                </div>
                <div className="ml-cluster ex-item__tags">
                  <ItemStatus item={it} />
                  {it.origin_type === 'generated' && <StatusPill tone="info">مولد</StatusPill>}
                  {it.confidence && <StatusPill tone="neutral" icon={false}>{CONFIDENCE_LABELS_AR[it.confidence]}</StatusPill>}
                  {it.mastery_signal && it.mastery_signal !== 'wrong' && it.mastery_signal !== 'correct_confident_independent' && (
                    <StatusPill tone="warning" icon={false}>
                      {MASTERY_SIGNAL_LABELS_AR[it.mastery_signal]}
                    </StatusPill>
                  )}
                  {it.flagged && (
                    <StatusPill tone="neutral" icon={<Flag size={14} />}>
                      مُعلَّم
                    </StatusPill>
                  )}
                  {it.over_time_budget && <StatusPill tone="neutral" icon={false}>تجاوز وقت السؤال</StatusPill>}
                  {it.mistake_type && (
                    <StatusPill tone="neutral" icon={false}>
                      {MISTAKE_TYPE_LABELS_AR[it.mistake_type]} ({it.mistake_origin === 'owner' ? 'تصنيفك' : 'اقتراح آلي'})
                    </StatusPill>
                  )}
                </div>
                {!it.scored && it.unscored_reason_ar && <p className="ex-muted">{it.unscored_reason_ar}</p>}
                <Button size="sm" variant="plain" aria-expanded={!!fb && fb !== 'loading'} onClick={() => void toggleItem(it.index)} loading={fb === 'loading'}>
                  {fb && fb !== 'loading' ? 'إخفاء التصحيح' : 'عرض التصحيح والأدلة'}
                </Button>
                {typeof fb === 'string' && fb !== 'loading' && <p className="ex-note ex-note--warn">{fb}</p>}
                {fb && typeof fb === 'object' && <FeedbackPanel feedback={fb} onMistakeChange={(t) => changeMistake(it.index, t)} />}
              </li>
            );
          })}
        </ol>
      </section>
    </div>
  );
}
