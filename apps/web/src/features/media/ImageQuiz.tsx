// /media/quiz/:quizId — Image Quiz (§32). The page receives nothing that reveals an answer: a neutral image URL (no
// file name), numbered mask positions, no caption / title / source. For PNG images the masks are burned into the
// served copy; otherwise they are drawn here over the image (said on the page). Each answer is checked once by the
// server; a non-matching answer can be marked correct by the owner's own judgement (recorded as such). The source,
// caption and labels are shown only after finishing.
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CircleCheck, CircleX, Flag, PenLine } from 'lucide-react';
import type { ImageQuizFinishResponse, ImageQuizView } from '@medlevo/shared';
import { Breadcrumbs, Button, ErrorState, LoadingState, StatusPill, TextField, buttonClass } from '../../design';
import { errorMessage } from '../../lib/api';
import { usePageTitle } from '../../lib/usePageTitle';
import { BidiText } from '../evidence';
import { mediaApi } from './api';
import { ORIGIN_TONE, studyUrl } from './model';
import './media.css';

const RESULT_LABEL = { correct: 'صحيحة', incorrect: 'لم تطابق', self_marked_correct: 'صحيحة بحكمك' } as const;

export function ImageQuiz() {
  const { quizId = '' } = useParams();
  usePageTitle('اختبار الصورة');
  const [quiz, setQuiz] = useState<ImageQuizView | null>(null);
  const [reveal, setReveal] = useState<ImageQuizFinishResponse['reveal'] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [announce, setAnnounce] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      setQuiz(await mediaApi.quiz(quizId));
    } catch (e) {
      setError(errorMessage(e, 'تعذّر فتح الاختبار.'));
    }
  }, [quizId]);
  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <ErrorState message={error} onRetry={() => void load()} />;
  if (!quiz) return <LoadingState stage="جارٍ فتح الاختبار…" />;

  const answered = new Map(quiz.answers.map((a) => [a.key, a]));
  const submit = async (key: string, selfMark = false) => {
    setBusy(key);
    setActionError(null);
    try {
      const r = await mediaApi.answer(quiz.id, { key, answer: selfMark ? (answered.get(key)?.answer ?? 'x') : (answers[key] ?? '').trim(), ...(selfMark ? { self_mark_correct: true } : {}) });
      setQuiz(r.quiz);
      setAnnounce(`المنطقة ${key.slice(1)}: ${RESULT_LABEL[r.result]}. الجواب: ${r.expected}`);
    } catch (e) {
      setActionError(errorMessage(e, 'تعذّر تسجيل الإجابة.'));
    } finally {
      setBusy(null);
    }
  };
  const finish = async () => {
    setBusy('finish');
    setActionError(null);
    try {
      const r = await mediaApi.finishQuiz(quiz.id);
      setQuiz(r.quiz);
      setReveal(r.reveal);
    } catch (e) {
      setActionError(errorMessage(e, 'تعذّر إنهاء الاختبار.'));
    } finally {
      setBusy(null);
    }
  };
  const correct = quiz.answers.filter((a) => a.result !== 'incorrect').length;

  return (
    <div className="ml-page md-page">
      <Breadcrumbs items={[{ label: 'الصور والصوت', to: '/media' }, { label: 'اختبار الصورة' }]} />
      <header className="ml-page__header">
        <h1 className="ml-page__title">ماذا تخفي المناطق المرقّمة؟</h1>
        <p className="ml-page__lede">{quiz.prompt_ar}</p>
      </header>
      <p className="ml-visually-hidden" aria-live="polite">
        {announce}
      </p>
      {quiz.masks_rendered === 'client' && <p className="md-muted">الأقنعة في هذه الصورة مرسومة في المتصفح فوق الصورة (ليست بصيغة PNG)؛ الصورة الأصلية لم تتغير.</p>}
      {quiz.excluded.length > 0 && (
        <p className="md-muted">
          استُبعد {quiz.excluded.length === 1 ? 'قناع واحد' : `${quiz.excluded.length} أقنعة`}: {[...new Set(quiz.excluded.map((x) => x.reason_ar))].join(' ')}
        </p>
      )}
      {actionError && <ErrorState inline message={actionError} />}

      <div className="md-detail">
        <div className="md-detail__image">
          <div className="md-frame md-frame--quiz">
            <img src={quiz.image_url} alt="صورة السؤال" draggable={false} />
            {quiz.masks.map((m) => (
              <span
                key={m.key}
                className={`md-mask${quiz.masks_rendered === 'client' && !reveal ? ' md-mask--opaque' : ''}`}
                style={{ left: `${m.shape.x * 100}%`, top: `${m.shape.y * 100}%`, width: `${m.shape.w * 100}%`, height: `${m.shape.h * 100}%` }}
                aria-hidden="true"
              >
                <span className="md-mask__no">{m.key.slice(1)}</span>
              </span>
            ))}
          </div>
        </div>
        <div className="md-detail__side">
          <ol className="md-answers">
            {quiz.masks.map((m) => {
              const a = answered.get(m.key);
              return (
                <li key={m.key} className="md-answer">
                  {a ? (
                    <>
                      <p className="md-answer__head">
                        <span className="md-answer__no">المنطقة {m.key.slice(1)}</span>
                        {a.result === 'incorrect' ? (
                          <StatusPill tone="danger" icon={<CircleX size={14} />}>
                            {RESULT_LABEL[a.result]}
                          </StatusPill>
                        ) : (
                          <StatusPill tone="success" icon={<CircleCheck size={14} />}>
                            {RESULT_LABEL[a.result]}
                          </StatusPill>
                        )}
                      </p>
                      <p className="md-muted">
                        إجابتك: <BidiText as="span" text={a.answer} /> — الجواب: <BidiText as="span" text={a.expected} />
                      </p>
                      {a.result === 'incorrect' && quiz.status !== 'finished' && (
                        <Button size="sm" variant="plain" icon={<PenLine size={14} />} loading={busy === m.key} onClick={() => void submit(m.key, true)}>
                          كانت إجابتي صحيحة بصياغة أخرى
                        </Button>
                      )}
                    </>
                  ) : (
                    <form
                      className="md-answer__form"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void submit(m.key);
                      }}
                    >
                      <TextField label={`المنطقة ${m.key.slice(1)}`} value={answers[m.key] ?? ''} onChange={(e) => setAnswers({ ...answers, [m.key]: e.target.value })} disabled={quiz.status === 'finished'} />
                      <Button type="submit" variant="secondary" size="sm" loading={busy === m.key} disabled={!(answers[m.key] ?? '').trim() || quiz.status === 'finished'}>
                        تحقّق
                      </Button>
                    </form>
                  )}
                </li>
              );
            })}
          </ol>
          {quiz.status !== 'finished' ? (
            <Button variant="primary" icon={<Flag size={16} />} loading={busy === 'finish'} onClick={() => void finish()}>
              أنهِ واكشف المصدر
            </Button>
          ) : (
            <p className="md-muted">
              {correct} من {quiz.masks.length} صحيحة (منها ما حكمت أنت بصحته).
            </p>
          )}
          {reveal && (
            <section className="md-reveal" aria-labelledby="md-reveal-h">
              <h2 id="md-reveal-h" className="md-section__title">
                الصورة ومصدرها
              </h2>
              <StatusPill tone={ORIGIN_TONE[reveal.image.origin_badge]} icon={false}>
                {reveal.image.origin_label_ar}
              </StatusPill>
              {reveal.image.caption && <BidiText text={reveal.image.caption} />}
              <ul className="md-list">
                {reveal.labels.map((l) => (
                  <li key={l.key}>
                    {l.key.slice(1)}. <BidiText as="span" text={l.label} /> <span className="md-muted">({l.certainty_label_ar})</span>
                  </li>
                ))}
              </ul>
              <div className="ml-cluster">
                <Link className={buttonClass({ variant: 'secondary' })} to={`/media/images/${encodeURIComponent(reveal.image.id)}`}>
                  صفحة الصورة
                </Link>
                {reveal.image.source && reveal.image.page && !reveal.image.source.deleted && (
                  <Link className={buttonClass({ variant: 'plain' })} to={studyUrl(reveal.image.source.id, { versionId: reveal.image.version_id, pageId: reveal.image.page.id, regionId: reveal.image.region_id })}>
                    <BidiText as="span" text={`${reveal.image.source.title} — ${reveal.image.page.label_ar}`} />
                  </Link>
                )}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
