// /review/revision — One-Tap Revision (§45): the owner gives minutes; the server builds a deterministic session from
// recent mistakes, weak points, due cards and the pages behind them — each item with its reason and a labelled time
// estimate, never more than the minutes. No AI call. The session is then run here: cards in the offline reviewer,
// questions as one practice set, pages opened in the book. What was done is remembered on this device.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { BookOpen, CheckCircle2, Circle, FileQuestion, Layers, Sparkles } from 'lucide-react';
import { newId, type RevisionSessionDetail } from '@medlevo/shared';
import { Button, EmptyState, ErrorState, LoadingState, StatusPill, buttonClass, useToast } from '../../design';
import { errorMessage } from '../../lib/api';
import { useCapabilities } from '../../lib/capabilities';
import { getDb, kvGet, kvSet } from '../../lib/localdb';
import { formatDateTime } from '../../lib/time';
import { usePageTitle } from '../../lib/usePageTitle';
import { examsApi } from '../exams/api';
import { learningApi } from './api';
import { CardReviewer } from './components/CardReviewer';
import { MinutesPicker, clampMinutes } from './components/MinutesPicker';
import { useLearningSync } from './local/hooks';
import { cardsAr, itemsAr, minutesAr, questionsAr } from './local/time';
import { practiceUrl, studyUrl } from './links';
import './learning.css';

type Item = RevisionSessionDetail['items'][number];
interface DoneState {
  cards: boolean;
  questions: boolean;
  pages: string[];
  practiceAttemptId?: string | null;
}

const doneKey = (id: string) => `learning.revision.${id}.done`;

function sum(items: Item[]): number {
  return Math.round(items.reduce((a, i) => a + i.est_minutes, 0) * 10) / 10;
}

function Builder() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const caps = useCapabilities();
  const [minutes, setMinutes] = useState(clampMinutes(Number(params.get('minutes') ?? 20)));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const weakness = params.get('weakness');
  const auto = params.get('minutes') !== null;
  const started = useRef(false);
  const build = async (m: number) => {
    setBusy(true);
    setError(null);
    try {
      const s = weakness ? await learningApi.weaknessRevision(weakness, m) : await learningApi.revision({ minutes: m });
      navigate(`/review/revision/${encodeURIComponent(s.id)}`, { replace: true });
    } catch (e) {
      setError(errorMessage(e, 'تعذّر بناء الجلسة.'));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (auto && caps.online && !started.current) {
      started.current = true;
      void build(minutes);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, caps.online]);
  if (busy) return <LoadingState stage={`جارٍ بناء جلسة ${minutesAr(minutes)} من أخطائك ونقاط ضعفك وبطاقاتك…`} />;
  return (
    <section className="lw-sheet" aria-labelledby="lw-build-h">
      <h2 id="lw-build-h" className="lw-sheet__title">
        كم دقيقة لديك؟
      </h2>
      <MinutesPicker value={minutes} onChange={setMinutes} />
      <Button variant="primary" icon={<Sparkles size={16} />} disabled={!caps.online} onClick={() => void build(minutes)}>
        ابنِ الجلسة
      </Button>
      {!caps.online && <p className="lw-muted">بناء الجلسة يحتاج اتصالًا. البطاقات المستحقة تعمل دون اتصال من صفحة المراجعة.</p>}
      {error && <ErrorState inline message={error} onRetry={() => void build(minutes)} />}
    </section>
  );
}

function Step({ n, title, est, done, children }: { n: number; title: React.ReactNode; est: number; done: boolean; children: React.ReactNode }) {
  return (
    <section className="lw-step" data-done={done || undefined} aria-labelledby={`lw-step-${n}`}>
      <header className="lw-step__head">
        <span className="lw-step__icon" aria-hidden="true">
          {done ? <CheckCircle2 size={22} /> : <Circle size={22} />}
        </span>
        <h2 id={`lw-step-${n}`} className="lw-step__title">
          {n}. {title}
        </h2>
        <span className="lw-step__est">{`تقدير: ${minutesAr(Math.max(1, Math.round(est)))}`}</span>
        {done && <StatusPill tone="success">أنجزته</StatusPill>}
      </header>
      <div className="lw-step__body">{children}</div>
    </section>
  );
}

function Session({ id }: { id: string }) {
  useLearningSync();
  const caps = useCapabilities();
  const toast = useToast();
  const navigate = useNavigate();
  const [s, setS] = useState<RevisionSessionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<DoneState>({ cards: false, questions: false, pages: [] });
  const [reviewing, setReviewing] = useState(false);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void kvGet<DoneState>(getDb(), doneKey(id)).then((d) => !cancelled && d && setDone(d));
    void learningApi
      .revisionById(id)
      .then(async (r) => {
        if (cancelled) return;
        setS(r);
        await kvSet(getDb(), `learning.revision.${id}.session`, r).catch(() => undefined);
      })
      .catch(async (e) => {
        const cached = await kvGet<RevisionSessionDetail>(getDb(), `learning.revision.${id}.session`).catch(() => undefined);
        if (cancelled) return;
        if (cached) setS(cached);
        else setError(errorMessage(e, 'تعذّر تحميل الجلسة.'));
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const mark = (patch: Partial<DoneState>) => {
    setDone((d) => {
      const next = { ...d, ...patch };
      void kvSet(getDb(), doneKey(id), next);
      return next;
    });
  };

  const groups = useMemo(() => {
    const items = s?.items ?? [];
    return {
      cards: items.filter((i): i is Extract<Item, { kind: 'flashcard' }> => i.kind === 'flashcard'),
      questions: items.filter((i): i is Extract<Item, { kind: 'question' }> => i.kind === 'question'),
      pages: items.filter((i): i is Extract<Item, { kind: 'pages' }> => i.kind === 'pages'),
    };
  }, [s]);

  if (error) return <ErrorState message={error} />;
  if (!s) return <LoadingState stage="جارٍ فتح الجلسة…" />;
  if (s.items.length === 0)
    return (
      <EmptyState
        title="لا شيء يحتاج مراجعة الآن"
        description={s.explanation_ar}
        actions={
          <Link to="/review" className={buttonClass({ variant: 'primary' })}>
            المراجعة
          </Link>
        }
      />
    );

  const startPractice = async () => {
    setStarting(true);
    try {
      const attemptId = done.practiceAttemptId ?? newId();
      mark({ practiceAttemptId: attemptId });
      const res = await examsApi.create({ title: 'أسئلة جلسة المراجعة', mode: 'practice', count: groups.questions.length, question_ids: groups.questions.map((q) => q.question_id), attempt_id: attemptId });
      navigate(`/exams/${encodeURIComponent(res.session.attempt.id)}`);
    } catch (e) {
      toast.show({ title: errorMessage(e, 'تعذّر بدء التدريب.'), tone: 'danger' });
    } finally {
      setStarting(false);
    }
  };

  let n = 0;
  return (
    <div className="lw-stack">
      <section className="lw-sheet" aria-label="عن هذه الجلسة">
        <p className="lw-session-sum">{`${minutesAr(s.minutes)} — ${itemsAr(s.items.length)}، مجموع تقديرها ${minutesAr(Math.round(s.total_est_minutes))} (لا يتجاوز المدة).`}</p>
        <p>{s.explanation_ar}</p>
        {s.estimate_basis_ar.length > 0 && (
          <ul className="lw-basis" aria-label="أساس تقدير الوقت">
            {s.estimate_basis_ar.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        )}
        <p className="lw-muted">بُنيت في {formatDateTime(s.created_at)} دون أي استدعاء للذكاء الاصطناعي.</p>
      </section>

      {groups.cards.length > 0 && (
        <Step n={++n} title={`البطاقات (${cardsAr(groups.cards.length)})`} est={sum(groups.cards)} done={done.cards}>
          <details className="lw-reasons">
            <summary>لماذا هذه البطاقات؟</summary>
            <ul>
              {groups.cards.map((c) => (
                <li key={c.card_id}>{c.reason_ar}</li>
              ))}
            </ul>
          </details>
          {reviewing ? (
            <CardReviewer
              cardIds={groups.cards.map((c) => c.card_id)}
              doneActions={
                <Button
                  variant="primary"
                  onClick={() => {
                    mark({ cards: true });
                    setReviewing(false);
                  }}
                >
                  علّم البطاقات منجزة
                </Button>
              }
            />
          ) : (
            <Button variant="primary" icon={<Layers size={16} />} onClick={() => setReviewing(true)}>
              {done.cards ? 'راجعها مرة أخرى' : 'ابدأ البطاقات'}
            </Button>
          )}
        </Step>
      )}

      {groups.questions.length > 0 && (
        <Step n={++n} title={`الأسئلة (${questionsAr(groups.questions.length)})`} est={sum(groups.questions)} done={done.questions}>
          <ul className="lw-items">
            {groups.questions.map((q) => (
              <li key={q.question_id}>
                <span>{q.reason_ar}</span>{' '}
                <Link className="lw-link" to={practiceUrl(q.question_id)}>
                  هذا السؤال وحده
                </Link>
              </li>
            ))}
          </ul>
          <div className="ml-cluster">
            <Button variant="primary" icon={<FileQuestion size={16} />} loading={starting} disabled={!caps.online} onClick={() => void startPractice()}>
              تدرّب على أسئلة الجلسة
            </Button>
            <Button variant="plain" icon={done.questions ? <CheckCircle2 size={16} /> : undefined} aria-pressed={done.questions} onClick={() => mark({ questions: !done.questions })}>
              {done.questions ? 'أنجزتها' : 'علّمها منجزة'}
            </Button>
            {!caps.online && <span className="lw-muted">التدريب على الأسئلة يحتاج اتصالًا.</span>}
          </div>
        </Step>
      )}

      {groups.pages.length > 0 && (
        <Step n={++n} title="صفحات تقرؤها" est={sum(groups.pages)} done={groups.pages.every((p) => done.pages.includes(`${p.source_id}:${p.page_indexes.join(',')}`))}>
          <ul className="lw-items">
            {groups.pages.map((p) => {
              const key = `${p.source_id}:${p.page_indexes.join(',')}`;
              const read = done.pages.includes(key);
              return (
                <li key={key} className="lw-items__page">
                  <span>{p.reason_ar}</span>
                  <span className="ml-cluster">
                    <Link className="lw-link" to={studyUrl(p.source_id, { pageIndex: p.page_indexes[0] ?? null })}>
                      <BookOpen size={16} aria-hidden="true" /> افتح {p.page_indexes.length > 1 ? `الصفحات ${p.page_indexes.map((i) => i + 1).join('، ')} في الملف` : `الصفحة ${(p.page_indexes[0] ?? 0) + 1} في الملف`}
                    </Link>
                    <Button size="sm" variant={read ? 'plain' : 'secondary'} icon={read ? <CheckCircle2 size={16} /> : undefined} onClick={() => mark({ pages: read ? done.pages.filter((x) => x !== key) : [...done.pages, key] })} aria-pressed={read}>
                      {read ? 'قرأتها' : 'علّمها مقروءة'}
                    </Button>
                  </span>
                </li>
              );
            })}
          </ul>
        </Step>
      )}
      <p className="lw-muted">علامات «أنجزته» محفوظة على هذا الجهاز لتتابع الجلسة؛ نتائج البطاقات والأسئلة نفسها تُسجَّل في سجلك وتُزامَن.</p>
    </div>
  );
}

export function RevisionScreen() {
  usePageTitle('مراجعة بنقرة واحدة');
  const { revisionId } = useParams();
  return (
    <div className="ml-page lw-page lw-page--narrow">
      <header className="ml-page__header lw-head">
        <div>
          <h1 className="ml-page__title">
            مراجعة بنقرة واحدة <bdi dir="ltr" lang="en" className="lw-term">One-Tap Revision</bdi>
          </h1>
          <p className="ml-page__lede">جلسة بالمدة التي لديك، من أخطائك ونقاط ضعفك وبطاقاتك — مع سبب كل عنصر.</p>
        </div>
        <Link to="/review" className={buttonClass({ variant: 'plain' })}>
          المراجعة
        </Link>
      </header>
      {revisionId ? <Session id={revisionId} /> : <Builder />}
    </div>
  );
}
