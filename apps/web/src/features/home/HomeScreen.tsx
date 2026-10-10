// Home (§45, §23): Continue Studying FIRST — the book the owner left open, at the place they left it — then today's plan,
// the cards due, the exam countdown, the one weakness that needs attention and the important questions, each with its
// reason. Calm sentences, not a dashboard of counters. Works offline from this device (recent sessions, local cards,
// the last saved answer of the server).
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { BookOpen, CalendarDays, FileQuestion, Flag, Layers, Library, Target } from 'lucide-react';
import { liveQuery } from 'dexie';
import { stemPreview, type HomeDetail, type PlanTaskView, type QuestionDetailResponse, type StudyPlanView } from '@medlevo/shared';
import { Checkbox, ErrorState, Skeleton, buttonClass, useToast } from '../../design';
import { errorMessage } from '../../lib/api';
import { useCapabilities } from '../../lib/capabilities';
import { getDb, type StudySessionRow } from '../../lib/localdb';
import { formatRelative } from '../../lib/time';
import { usePageTitle } from '../../lib/usePageTitle';
import { BidiText } from '../evidence';
import { useQuery } from '../library/data';
import { useLibrary } from '../library/useLibrary';
import { LEARNING_PATHS, learningApi } from '../review/api';
import { useLearningSync, useLocalCards, useNow, useSrsConfig } from '../review/local/hooks';
import { computeQueue } from '../review/local/queue';
import { cardsAr, dayLabelAr, daysCountAr, minutesAr } from '../review/local/time';
import { planUrl, questionUrl, sessionUrl, studyUrl, weaknessUrl } from '../review/links';
import { TASK_KIND_AR } from '../planner/model';
import '../review/learning.css';
import '../planner/planner.css';
import './home.css';

const MODE_AR: Record<string, string> = { learn: 'تعلّم', understand: 'فهم', practice: 'تدريب', review: 'مراجعة', exam: 'امتحان' };

export interface ContinueItem {
  source_id: string;
  title: string;
  version_id: string | null;
  page_label_ar: string | null;
  mode: string;
  updated_at: number;
}

/** Recent study sessions saved on this device (offline fallback for Continue Studying). */
function useLocalContinue(titles: Map<string, string>): ContinueItem[] {
  const [rows, setRows] = useState<StudySessionRow[]>([]);
  useEffect(() => {
    const sub = liveQuery(() => getDb().studySessions.orderBy('updatedAt').reverse().limit(20).toArray()).subscribe({ next: setRows, error: () => setRows([]) });
    return () => sub.unsubscribe();
  }, []);
  return useMemo(() => {
    const seen = new Set<string>();
    const out: ContinueItem[] = [];
    for (const r of rows) {
      if (!r.sourceId || seen.has(r.sourceId) || r.deletedAt) continue;
      seen.add(r.sourceId);
      out.push({ source_id: r.sourceId, title: titles.get(r.sourceId) ?? 'مصدر على هذا الجهاز', version_id: r.versionId ?? null, page_label_ar: null, mode: r.mode, updated_at: r.updatedAt });
    }
    return out.slice(0, 5);
  }, [rows, titles]);
}

/** Server list first (it knows every device); this device's newer sessions are merged in. */
export function mergeContinue(server: readonly ContinueItem[] | null, local: readonly ContinueItem[]): ContinueItem[] {
  const by = new Map<string, ContinueItem>();
  for (const it of server ?? []) by.set(it.source_id, it);
  for (const it of local) {
    const s = by.get(it.source_id);
    if (!s) by.set(it.source_id, it);
    else if (it.updated_at > s.updated_at) by.set(it.source_id, { ...s, updated_at: it.updated_at, page_label_ar: s.page_label_ar });
  }
  return [...by.values()].sort((a, b) => b.updated_at - a.updated_at).slice(0, 5);
}

function ContinueStudying({ items, loading }: { items: ContinueItem[]; loading: boolean }) {
  const now = useNow(60_000);
  const [first, ...rest] = items;
  return (
    <section className="lw-sheet lw-continue" aria-labelledby="home-continue">
      <h2 id="home-continue" className="lw-sheet__title">
        تابع الدراسة
      </h2>
      {loading && !first ? (
        <Skeleton lines={2} />
      ) : !first ? (
        <>
          <p className="lw-continue__lead">لم تفتح كتابًا بعد. ابدأ بمحاضرة من مكتبتك، وستعود إلى الموضع نفسه في كل مرة.</p>
          <div className="ml-cluster">
            <Link to="/library" className={buttonClass({ variant: 'primary', size: 'lg' })}>
              <Library size={18} aria-hidden="true" />
              افتح المكتبة
            </Link>
          </div>
        </>
      ) : (
        <>
          <Link to={studyUrl(first.source_id)} className="lw-continue__book">
            <BookOpen size={28} aria-hidden="true" className="lw-continue__icon" />
            <span className="lw-continue__text">
              <BidiText as="span" className="lw-continue__title" text={first.title} />
              <span className="lw-muted">{[first.page_label_ar, MODE_AR[first.mode] ? `وضع ${MODE_AR[first.mode]}` : null, formatRelative(first.updated_at, now)].filter(Boolean).join(' · ')}</span>
            </span>
            <span className={buttonClass({ variant: 'primary' })}>افتح من حيث توقفت</span>
          </Link>
          {rest.length > 0 && (
            <ul className="lw-continue__more" aria-label="كتب فتحتها مؤخرًا">
              {rest.map((it) => (
                <li key={it.source_id}>
                  <Link to={studyUrl(it.source_id)} className="lw-continue__row">
                    <BidiText as="span" text={it.title} />
                    <span className="lw-muted">{[it.page_label_ar, formatRelative(it.updated_at, now)].filter(Boolean).join(' · ')}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function TodayPlan({ home, onChanged }: { home: HomeDetail; onChanged: () => void }) {
  const caps = useCapabilities();
  const toast = useToast();
  const [tasks, setTasks] = useState<PlanTaskView[]>(home.today);
  useEffect(() => setTasks(home.today), [home.today]);
  if (!home.plan_id) {
    return (
      <section className="lw-sheet" aria-labelledby="home-plan">
        <h2 id="home-plan" className="lw-sheet__title">
          خطة اليوم
        </h2>
        <p className="lw-muted">لا توجد خطة دراسة نشطة. حدّد موعد امتحانك ومحاضراتك ووقتك اليومي لتُبنى خطة واقعية.</p>
        <Link to="/planner/new" className={buttonClass({ variant: 'secondary', size: 'sm' })}>
          <CalendarDays size={16} aria-hidden="true" />
          أنشئ خطة
        </Link>
      </section>
    );
  }
  const minutes = tasks.reduce((a, t) => a + t.minutes, 0);
  return (
    <section className="lw-sheet" aria-labelledby="home-plan">
      <h2 id="home-plan" className="lw-sheet__title">
        خطة اليوم
      </h2>
      {tasks.length === 0 ? (
        <p className="lw-muted">لا مهام في خطتك لهذا اليوم.</p>
      ) : (
        <>
          <p className="lw-muted">{`${minutesAr(minutes)} لهذا اليوم (${dayLabelAr(home.day)}).`}</p>
          <ul className="lw-tasks">
            {tasks.map((t) => (
              <li key={t.id} className="lw-task" data-status={t.status}>
                <Checkbox
                  checked={t.status === 'done'}
                  disabled={!caps.online}
                  label={<BidiText as="span" text={t.title_ar} />}
                  description={`${TASK_KIND_AR[t.kind]} · ${minutesAr(t.minutes)}`}
                  onCheckedChange={async (v) => {
                    const status = v ? 'done' : 'todo';
                    setTasks((xs) => xs.map((x) => (x.id === t.id ? { ...x, status } : x)));
                    try {
                      const plan: StudyPlanView = await learningApi.setTask(home.plan_id!, t.id, status);
                      setTasks(plan.tasks.filter((x) => x.day === plan.today && x.kind !== 'exam' && x.status !== 'moved'));
                      onChanged();
                    } catch (e) {
                      setTasks(home.today);
                      toast.show({ title: errorMessage(e, 'تعذّر حفظ حالة المهمة.'), tone: 'danger' });
                    }
                  }}
                />
              </li>
            ))}
          </ul>
        </>
      )}
      <Link className="lw-link" to={planUrl(home.plan_id)}>
        الخطة كاملة
      </Link>
    </section>
  );
}

function DueCards({ home }: { home: HomeDetail | null }) {
  const cfg = useSrsConfig();
  const local = useLocalCards();
  const now = useNow();
  const q = useMemo(
    () => (cfg.config && cfg.parity?.ok && local.ready ? computeQueue({ params: cfg.config.params, daily_new_limit: cfg.config.daily_new_limit, timezone: cfg.config.timezone }, local.cards, local.events, now) : null),
    [cfg.config, cfg.parity, local, now],
  );
  const due = q ? q.counts.due_now : (home?.due_cards ?? null);
  const fresh = q ? q.counts.new_available : (home?.new_cards_available ?? null);
  const total = q ? q.counts.total : null;
  let sentence: string;
  if (due === null) sentence = 'جارٍ قراءة البطاقات…';
  else if (total === 0) sentence = 'لا بطاقات بعد. أنشئها من نص تحدده في الكتاب أو من سؤال أخطأت فيه.';
  else if (due + (fresh ?? 0) === 0) sentence = q?.next_due_at ? `لا بطاقات مستحقة الآن؛ أقرب موعد ${formatRelative(q.next_due_at, now)}.` : 'لا بطاقات مستحقة الآن.';
  else sentence = [due ? `${cardsAr(due)} مستحقة الآن` : null, fresh ? `${cardsAr(fresh)} جديدة لليوم` : null].filter(Boolean).join('، و') + '.';
  return (
    <section className="lw-sheet" aria-labelledby="home-cards">
      <h2 id="home-cards" className="lw-sheet__title">
        البطاقات
      </h2>
      <p>{sentence}</p>
      {due !== null && due + (fresh ?? 0) > 0 && (
        <Link to={sessionUrl({ back: '/' })} className={buttonClass({ variant: 'secondary', size: 'sm' })}>
          <Layers size={16} aria-hidden="true" />
          ابدأ المراجعة
        </Link>
      )}
    </section>
  );
}

function ExamCountdown({ exam, planId }: { exam: NonNullable<HomeDetail['exam']>; planId: string | null }) {
  return (
    <section className="lw-sheet lw-exam" aria-labelledby="home-exam">
      <h2 id="home-exam" className="lw-sheet__title">
        <Flag size={18} aria-hidden="true" /> الامتحان
      </h2>
      <p>
        <BidiText as="span" text={exam.title} /> — {exam.days_left === 0 ? 'اليوم' : `بعد ${daysCountAr(exam.days_left)}`} ({dayLabelAr(exam.date, { year: true })}).
      </p>
      {planId && (
        <Link className="lw-link" to={planUrl(planId)}>
          الخطة حتى الامتحان
        </Link>
      )}
    </section>
  );
}

function TopWeakness({ w }: { w: NonNullable<HomeDetail['top_weakness']> }) {
  return (
    <section className="lw-sheet" aria-labelledby="home-weak">
      <h2 id="home-weak" className="lw-sheet__title">
        <Target size={18} aria-hidden="true" /> أبرز ما يحتاج انتباهك
      </h2>
      <p className="lw-home-weak">
        <BidiText as="span" className="lw-home-weak__label" text={w.label} />
      </p>
      {w.reasons_ar[0] && <p className="lw-muted">{w.reasons_ar[0]}</p>}
      <Link className="lw-link" to={weaknessUrl(w.id)}>
        لماذا، وماذا أراجع؟
      </Link>
    </section>
  );
}

/** One important question: its stem (from the question bank, cached for offline) as the link, then why it is listed. */
function ImportantQuestion({ id, reason }: { id: string; reason: string }) {
  const q = useQuery<QuestionDetailResponse>(`/questions/${encodeURIComponent(id)}`, { cache: true });
  const stem = q.data ? stemPreview(q.data.question.current.stem, 140) : '';
  return (
    <li>
      {stem ? (
        <Link className="lw-home-q__stem" to={questionUrl(id)}>
          <BidiText as="span" text={stem} />
        </Link>
      ) : q.loading ? (
        <Skeleton height="1.25rem" width="80%" />
      ) : (
        <Link className="lw-link" to={questionUrl(id)}>
          افتح السؤال
        </Link>
      )}
      <span className="lw-muted">{reason}</span>
    </li>
  );
}

function ImportantQuestions({ items }: { items: HomeDetail['important_questions'] }) {
  return (
    <section className="lw-sheet" aria-labelledby="home-q">
      <h2 id="home-q" className="lw-sheet__title">
        <FileQuestion size={18} aria-hidden="true" /> أسئلة مهمة
      </h2>
      <ul className="lw-home-q">
        {items.map((q) => (
          <ImportantQuestion key={q.question_id} id={q.question_id} reason={q.reason_ar} />
        ))}
      </ul>
    </section>
  );
}

export function HomeScreen() {
  usePageTitle('الرئيسية');
  useLearningSync();
  const home = useQuery<HomeDetail>(LEARNING_PATHS.home, { cache: true });
  const lib = useLibrary();
  const titles = useMemo(() => new Map((lib.data?.sources ?? []).map((s) => [s.id, s.title])), [lib.data]);
  const local = useLocalContinue(titles);
  const items = mergeContinue(home.data?.continue ?? null, local);
  const h = home.data;

  return (
    <div className="ml-page lw-page lw-home">
      <h1 className="ml-visually-hidden">الرئيسية</h1>
      <ContinueStudying items={items} loading={home.loading && !h && local.length === 0} />
      {home.fromCache && <p className="lw-muted lw-home__cache">{`ما يلي من آخر نسخة محفوظة على هذا الجهاز${home.cachedAt ? ` (${formatRelative(home.cachedAt)})` : ''}؛ تتحدث عند عودة الاتصال.`}</p>}
      {home.error && !h && !home.fromCache && <ErrorState inline message={home.error.message} onRetry={() => void home.refresh()} />}
      <div className="lw-home__grid">
        {h ? <TodayPlan home={h} onChanged={() => void home.refresh()} /> : null}
        <DueCards home={h} />
        {h?.exam && <ExamCountdown exam={h.exam} planId={h.plan_id} />}
        {h?.top_weakness && <TopWeakness w={h.top_weakness} />}
        {h && h.important_questions.length > 0 && <ImportantQuestions items={h.important_questions} />}
      </div>
    </div>
  );
}
