// The Question Sheet (§39): one clean question at a time — stem with negation emphasized, options with display
// labels (A–E or أ–هـ), keyboard 1–5 / letters, flag, navigator, timer, pause only when the FIXED policy allows it,
// autosave status (local first), confidence after answering. Practice adds progressive hints, «تحقّق» with
// immediate feedback (evidence chips, origin, occurrences, mistake type) and the optional Anti-shortcut mode.
// During an exam nothing reveals the answer: no keys, no explanations, no source names (AC-19).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Check, CircleCheck, Flag, Lightbulb, LogOut, Pause, Play, Send, Timer, WifiOff } from 'lucide-react';
import {
  CONFIDENCE_LEVELS,
  isAssessedMode,
  type AttemptFeedbackView,
  type ConfidenceLevel,
  type ExamItemView,
  type HintView,
  type MistakeType,
} from '@medlevo/shared';
import { Bidi, Button, ConfirmDialog, EmptyState, ErrorState, LoadingState, RichTextView, SaveStatus, StatusPill, buttonClass, useToast } from '../../design';
import { errorMessage, isApiError } from '../../lib/api';
import { getDb } from '../../lib/localdb';
import { getSyncEngine, useEntitySyncState } from '../../lib/sync';
import { useOnline } from '../../lib/useOnline';
import { usePageTitle } from '../../lib/usePageTitle';
import { examsApi } from './api';
import { FeedbackPanel } from './FeedbackPanel';
import { MixedLine } from './MixedLine';
import { recordQuestionAttempt, saveMistakeType } from './local';
import {
  CONFIDENCE_LABELS_AR,
  answeredCount,
  chooseOption,
  durationAr,
  finish,
  formatClock,
  isFinished,
  isTypingTarget,
  navigatorLabel,
  optionIndexForKey,
  patchAnswer,
  pause,
  questionsAr,
  resume,
  setConfidence,
  timerView,
  toggleFlag,
} from './model';
import { useExamSession } from './useExamSession';
import './exams.css';

function syncSoon(): void {
  try {
    void getSyncEngine().syncNow();
  } catch {
    // no engine (tests)
  }
}

export function RunnerScreen() {
  const { attemptId = '' } = useParams();
  const s = useExamSession(attemptId);
  const navigate = useNavigate();
  const toast = useToast();
  const online = useOnline();
  const saveState = useEntitySyncState('exam_attempt', attemptId);
  const [feedback, setFeedback] = useState<Record<number, AttemptFeedbackView>>({});
  const [hints, setHints] = useState<Record<number, HintView[]>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmFinish, setConfirmFinish] = useState(false);
  const [announce, setAnnounce] = useState('');
  const stemRef = useRef<HTMLDivElement>(null);
  const announced = useRef<Set<string>>(new Set());

  const session = s.session;
  const state = s.state;
  const exam = session?.exam;
  usePageTitle(exam ? `${exam.title} — ${exam.mode_label_ar}` : 'الاختبار');
  const policy = exam?.policy;
  const practice = !!exam && !isAssessedMode(exam.mode) && policy?.show_solution === 'after_each';
  const index = state?.current_index ?? 0;
  const item: ExamItemView | undefined = session?.items[index];
  const answer = state?.answers[String(index)];
  const finished = state ? isFinished(state) : false;
  const timers = policy && state ? timerView(policy, state) : null;

  // ── navigation ──
  const goTo = useCallback(
    async (i: number) => {
      if (!session) return;
      const n = Math.max(0, Math.min(session.items.length - 1, i));
      setNotice(null);
      await s.update((st) => ({ ...st, current_index: n }), { persist: true });
      stemRef.current?.focus();
    },
    [s, session],
  );

  // ── answering ──
  const choose = useCallback(
    async (optionIndex: number) => {
      if (!item || !state || state.status !== 'in_progress') return;
      const opt = item.options[optionIndex];
      if (!opt) return;
      await s.update((st) => chooseOption(st, index, opt.id, { multi: item.qtype === 'multi_select', attemptId: s.newClientId(), now: Date.now() }), { persist: true });
    },
    [item, state, s, index],
  );

  const loadFeedback = useCallback(
    async (i: number) => {
      try {
        const fb = await examsApi.feedback(attemptId, i);
        setFeedback((f) => ({ ...f, [i]: fb }));
      } catch (e) {
        if (!(isApiError(e) && e.status === 409)) setNotice(isApiError(e) && e.offline ? 'التصحيح يحتاج اتصالًا؛ إجابتك محفوظة على هذا الجهاز.' : errorMessage(e));
      }
    },
    [attemptId],
  );

  // a checked practice answer reopened after a reload: fetch its feedback
  useEffect(() => {
    if (!practice || !answer?.submitted || feedback[index] || !online) return;
    void loadFeedback(index);
  }, [practice, answer?.submitted, feedback, index, online, loadFeedback]);

  const check = useCallback(async () => {
    if (!item || !answer || answer.selected_option_ids.length === 0 || answer.submitted || !session) return;
    setBusy('check');
    setNotice(null);
    try {
      const served = hints[index]?.length ?? 0;
      const next = await s.update((st) => patchAnswer(st, index, { submitted: true, hints_used: Math.max(answer.hints_used, served) }), { persist: true });
      const a = next?.answers[String(index)];
      if (!a) return;
      const payload = {
        id: a.attempt_id,
        question_id: item.question_id,
        question_version_id: item.question_version_id,
        exam_attempt_id: attemptId,
        exam_item_index: index,
        selected_option_ids: a.selected_option_ids,
        confidence: a.confidence,
        hints_used: a.hints_used,
        solution_viewed_before_answer: a.solution_viewed_before_answer,
        time_ms: a.time_ms ?? Math.round(next!.timer.item_ms[String(index)] ?? 0),
        flagged: next!.flagged.includes(index),
        answered_at: a.at,
      };
      await recordQuestionAttempt(getDb(), payload);
      syncSoon();
      try {
        const { question_id: _q, question_version_id: _v, exam_attempt_id: _e, exam_item_index: _i, ...body } = payload;
        const fb = await examsApi.answer(attemptId, index, body);
        setFeedback((f) => ({ ...f, [index]: fb }));
      } catch (e) {
        setNotice(isApiError(e) && e.offline ? 'حُفظت إجابتك على هذا الجهاز وستُرسل عند عودة الاتصال؛ التصحيح والشرح يظهران عندها.' : errorMessage(e));
      }
    } finally {
      setBusy(null);
    }
  }, [item, answer, session, hints, index, s, attemptId]);

  const askHint = useCallback(
    async (level: 1 | 2) => {
      setBusy(`hint${level}`);
      setNotice(null);
      try {
        const { hint } = await examsApi.hint(attemptId, index, level);
        setHints((h) => ({ ...h, [index]: [...(h[index] ?? []).filter((x) => x.level !== level), hint] }));
        await s.update((st) => patchAnswer(st, index, { hints_used: Math.max(st.answers[String(index)]?.hints_used ?? 0, level) }), { persist: true });
      } catch (e) {
        setNotice(isApiError(e) && e.offline ? 'التلميحات تحتاج اتصالًا بالخادم.' : errorMessage(e));
      } finally {
        setBusy(null);
      }
    },
    [attemptId, index, s],
  );

  const showSolution = useCallback(async () => {
    setBusy('solution');
    setNotice(null);
    try {
      const fb = await examsApi.solution(attemptId, index);
      setFeedback((f) => ({ ...f, [index]: fb }));
      await s.update((st) => patchAnswer(st, index, { solution_viewed_before_answer: !st.answers[String(index)]?.submitted }), { persist: true });
    } catch (e) {
      setNotice(isApiError(e) && e.offline ? 'عرض الحل يحتاج اتصالًا بالخادم.' : errorMessage(e));
    } finally {
      setBusy(null);
    }
  }, [attemptId, index, s]);

  const changeMistake = useCallback(
    async (type: MistakeType | null) => {
      const fb = feedback[index];
      if (!fb?.attempt) return;
      await saveMistakeType(getDb(), fb.attempt, type);
      syncSoon();
      setFeedback((f) => ({ ...f, [index]: { ...fb, attempt: { ...fb.attempt!, mistake_type: type, mistake_origin: 'owner' } } }));
      toast.show({ title: 'حُفظ تصنيف الخطأ', tone: 'success' });
    },
    [feedback, index, toast],
  );

  const doFinish = useCallback(async () => {
    await s.update((st) => finish(st, Date.now()), { persist: true });
    syncSoon();
    navigate(`/exams/${encodeURIComponent(attemptId)}/results`);
  }, [s, navigate, attemptId]);

  // ── total time over: finish automatically, answers kept ──
  useEffect(() => {
    if (!timers?.totalExpired || finished || !state) return;
    void (async () => {
      await s.update((st) => finish(st, Date.now()), { persist: true });
      syncSoon();
      toast.show({ title: 'انتهى وقت الاختبار', description: 'حُفظت جميع إجاباتك وأُنهيت المحاولة.', tone: 'info' });
      navigate(`/exams/${encodeURIComponent(attemptId)}/results`);
    })();
  }, [timers?.totalExpired, finished, state, s, toast, navigate, attemptId]);

  // ── spoken time warnings (never every second) ──
  useEffect(() => {
    const left = timers?.totalLeftMs;
    if (left === null || left === undefined) return;
    for (const [mark, text] of [
      [5 * 60_000, 'بقيت خمس دقائق.'],
      [60_000, 'بقيت دقيقة واحدة.'],
    ] as const) {
      const key = `t${mark}`;
      if (left <= mark && left > mark - 5_000 && !announced.current.has(key)) {
        announced.current.add(key);
        setAnnounce(text);
      }
    }
  }, [timers?.totalLeftMs]);

  // ── keyboard: 1–9 / letters choose, ←/→ navigate (RTL aware), Enter checks (practice) ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
      if (document.getElementById('root')?.hasAttribute('inert') || !item || !state) return;
      if (state.status !== 'in_progress') return;
      const i = optionIndexForKey(e.key, item.options.length);
      if (i !== null && !answer?.submitted) {
        e.preventDefault();
        void choose(i);
        return;
      }
      const rtl = document.documentElement.dir !== 'ltr';
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        if (e.target instanceof Element && e.target.closest('.ml-segmented')) return; // the confidence control uses arrows itself
        e.preventDefault();
        const forward = (e.key === 'ArrowLeft') === rtl;
        void goTo(index + (forward ? 1 : -1));
        return;
      }
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && e.target instanceof Element && e.target.closest('.ex-options')) {
        // move focus between the options (the choice itself stays a deliberate Space / Enter / click)
        const opts = [...document.querySelectorAll<HTMLButtonElement>('.ex-options .ex-opt')];
        const at = opts.indexOf(e.target.closest('.ex-opt') as HTMLButtonElement);
        const next = opts[Math.max(0, Math.min(opts.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))];
        if (next) {
          e.preventDefault();
          next.focus();
        }
        return;
      }
      if (e.key === 'Enter' && practice && answer && !answer.submitted && !(e.target instanceof HTMLButtonElement) && !(e.target instanceof HTMLAnchorElement)) {
        e.preventDefault();
        void check();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [item, state, answer, choose, goTo, index, practice, check]);

  const counts = useMemo(() => {
    if (!state || !session) return null;
    const answered = answeredCount(state);
    return { answered, unanswered: session.items.length - answered, flagged: state.flagged.length };
  }, [state, session]);

  if (s.status === 'loading') return <LoadingState stage="جارٍ فتح الاختبار…" />;
  if (s.status === 'error' || !session || !state || !exam || !policy) {
    return (
      <main className="ex-runner ex-runner--message">
        <ErrorState message={s.error ?? 'تعذّر فتح الاختبار.'} onRetry={s.reload} actions={<Link to="/exams" className={buttonClass({ variant: 'secondary' })}>سجل الاختبارات</Link>} />
      </main>
    );
  }
  if (session.items.length === 0) {
    return (
      <main className="ex-runner ex-runner--message">
        <EmptyState title="لا توجد أسئلة في هذا الاختبار" description="أنشئ اختبارًا جديدًا بنطاق أوسع." actions={<Link to="/exams/new" className={buttonClass({ variant: 'primary' })}>اختبار جديد</Link>} />
      </main>
    );
  }

  const fb = feedback[index];
  const itemHints = hints[index] ?? [];
  const chosen = new Set(answer?.selected_option_ids ?? []);
  const paused = state.status === 'paused';
  const multi = item!.qtype === 'multi_select';
  const unscoredReason = session.unscored_reasons[String(index)];
  const solutionBlocked = policy.anti_shortcut && !(answer && answer.selected_option_ids.length > 0);
  const stemId = `ex-stem-${index}`;
  // the question keeps its own direction (an English question reads LTR: labels on the left, like the paper)
  const qDir = item!.stem.paragraphs[0]?.dir ?? 'rtl';

  return (
    <main className="ex-runner" aria-labelledby="ex-runner-title">
      <header className="ex-runner__bar">
        <Link to="/exams" className={buttonClass({ variant: 'plain', size: 'sm' })} aria-label="الخروج إلى سجل الاختبارات (إجاباتك محفوظة)">
          <LogOut size={18} aria-hidden="true" />
          <span className="ex-hide-sm">خروج</span>
        </Link>
        <div className="ex-runner__title">
          <h1 id="ex-runner-title">
            <MixedLine text={exam.title} />
          </h1>
          {exam.title !== exam.mode_label_ar && <span className="ex-muted">{exam.mode_label_ar}</span>}
        </div>
        <div className="ex-runner__tools">
          {(s.offline || !online) && (
            <StatusPill tone="warning" icon={<WifiOff size={14} />}>
              دون اتصال
            </StatusPill>
          )}
          <SaveStatus state={saveState ?? 'synced'} compact={false} live detail={saveState === 'saved_locally' ? 'إجاباتك محفوظة على هذا الجهاز وتُرسل عند عودة الاتصال.' : undefined} />
          <TimerDisplay totalLeftMs={timers!.totalLeftMs} elapsedMs={state.elapsed_ms} itemLeftMs={timers!.itemLeftMs} itemOver={timers!.itemOver} />
          {policy.pause_allowed && !finished && (
            <Button size="sm" variant="secondary" icon={paused ? <Play size={16} /> : <Pause size={16} />} onClick={() => void s.update((st) => (paused ? resume(st) : pause(st, policy, Date.now())), { persist: true })}>
              {paused ? 'استئناف' : 'إيقاف مؤقت'}
            </Button>
          )}
          {!finished && (
            <Button size="sm" variant="primary" icon={<Send size={16} />} onClick={() => setConfirmFinish(true)}>
              {practice ? 'إنهاء التدريب' : 'إنهاء الاختبار'}
            </Button>
          )}
          {finished && (
            <Link className={buttonClass({ variant: 'primary', size: 'sm' })} to={`/exams/${encodeURIComponent(attemptId)}/results`}>
              النتيجة
            </Link>
          )}
        </div>
      </header>
      <p className="ml-visually-hidden" role="status" aria-live="polite">
        {announce}
      </p>

      <div className="ex-runner__body">
        <section className="ex-sheet" aria-labelledby={stemId}>
          <div className="ex-sheet__head">
            <p className="ex-sheet__count" id={`${stemId}-count`}>
              السؤال {index + 1} من {session.items.length}
            </p>
            <div className="ml-cluster">
              {item!.has_negation && (
                <StatusPill tone="info" icon={false} title="السؤال منفي: ابحث عن الخيار الذي لا ينطبق">
                  سؤال منفي: <Bidi dir="ltr">{item!.negation_terms.join('، ') || 'NOT'}</Bidi>
                </StatusPill>
              )}
              {!item!.scored && <StatusPill tone="warning">غير محسوب</StatusPill>}
              <Button
                size="sm"
                variant="plain"
                icon={<Flag size={16} />}
                aria-pressed={state.flagged.includes(index)}
                onClick={() => void s.update((st) => toggleFlag(st, index), { persist: true })}
                disabled={finished}
              >
                {state.flagged.includes(index) ? 'مُعلَّم للمراجعة' : 'علّم للمراجعة'}
              </Button>
            </div>
          </div>
          {unscoredReason && (
            <p className="ex-note" role="note">
              لا يُحتسب في النتيجة: {unscoredReason}
            </p>
          )}

          {paused ? (
            <div className="ex-paused" role="status">
              <Pause size={28} aria-hidden="true" />
              <p>الاختبار متوقف مؤقتًا. الوقت لا يُحتسب، والسؤال مخفي حتى تستأنف.</p>
              <Button variant="primary" icon={<Play size={16} />} onClick={() => void s.update(resume, { persist: true })}>
                استئناف
              </Button>
            </div>
          ) : (
            <>
              <div ref={stemRef} tabIndex={-1} id={stemId} className="ex-stem" dir={qDir} aria-describedby={`${stemId}-count`}>
                <RichTextView value={item!.stem} variant="reading" />
              </div>
              {item!.media.length > 0 && (
                <div className="ex-media">
                  {item!.media.map((m) => (
                    <img key={m.token_url} src={m.token_url} alt={m.alt_ar} loading="lazy" />
                  ))}
                </div>
              )}
              <div className="ex-options" dir={qDir} role={multi ? 'group' : 'radiogroup'} aria-labelledby={stemId} aria-describedby="ex-keys-hint">
                {item!.options.map((o, i) => {
                  const on = chosen.has(o.id);
                  const locked = !!answer?.submitted || finished;
                  const isKey = !!fb?.correct_option_ids?.includes(o.id);
                  return (
                    <button
                      key={o.id}
                      type="button"
                      role={multi ? 'checkbox' : 'radio'}
                      aria-checked={on}
                      aria-disabled={locked || undefined}
                      className="ex-opt"
                      data-selected={on ? 'true' : undefined}
                      data-key={fb && isKey ? 'true' : undefined}
                      onClick={() => !locked && void choose(i)}
                    >
                      <span className="ex-opt__label" aria-hidden="true">
                        {o.display_label}
                      </span>
                      <span className="ml-visually-hidden">{`${o.display_label}. `}</span>
                      <RichTextView value={o.text} className="ex-opt__text" />
                      {on && <CircleCheck size={18} className="ex-opt__mark" aria-hidden="true" />}
                      {fb && isKey && <span className="ex-opt__keytag">الإجابة الصحيحة</span>}
                    </button>
                  );
                })}
              </div>
              <p id="ex-keys-hint" className="ex-muted ex-keys-hint">
                اختر بالأرقام 1–{Math.min(9, item!.options.length)} أو بالحروف. سهما الأعلى والأسفل بين الخيارات، وسهما اليمين واليسار بين الأسئلة.
              </p>

              {answer && answer.selected_option_ids.length > 0 && !finished && (
                <ConfidencePicker value={answer.confidence} onChange={(v) => void s.update((st) => setConfidence(st, index, v, Date.now()), { persist: true })} />
              )}

              {practice && !finished && (
                <div className="ex-practice">
                  {itemHints.map((h) => (
                    <HintCard key={h.level} hint={h} />
                  ))}
                  <div className="ml-cluster">
                    {policy.hints === 'progressive' && !answer?.submitted && (
                      <>
                        {!itemHints.some((h) => h.level === 1) && (
                          <Button variant="secondary" icon={<Lightbulb size={16} />} loading={busy === 'hint1'} disabled={!online} onClick={() => void askHint(1)}>
                            تلميح
                          </Button>
                        )}
                        {itemHints.some((h) => h.level === 1) && !itemHints.some((h) => h.level === 2) && (
                          <Button variant="secondary" icon={<Lightbulb size={16} />} loading={busy === 'hint2'} disabled={!online} onClick={() => void askHint(2)}>
                            تلميح أعمق
                          </Button>
                        )}
                      </>
                    )}
                    {!answer?.submitted && !fb && (
                      <Button variant="plain" loading={busy === 'solution'} disabled={solutionBlocked || !online} aria-describedby={solutionBlocked ? 'ex-anti-why' : undefined} onClick={() => void showSolution()}>
                        اعرض الحل
                      </Button>
                    )}
                    {!answer?.submitted && (
                      <Button variant="primary" icon={<Check size={16} />} loading={busy === 'check'} disabled={!answer || answer.selected_option_ids.length === 0} onClick={() => void check()}>
                        تحقّق من إجابتي
                      </Button>
                    )}
                  </div>
                  {solutionBlocked && (
                    <p id="ex-anti-why" className="ex-muted">
                      وضع منع الاختصار مفعّل: اختر إجابة أولًا، ثم يمكنك عرض الحل.
                    </p>
                  )}
                  {!online && <p className="ex-muted">التلميحات والتصحيح تحتاج اتصالًا؛ إجاباتك تُحفظ على هذا الجهاز.</p>}
                </div>
              )}
              {notice && (
                <p className="ex-note ex-note--warn" role="status">
                  {notice}
                </p>
              )}
              {practice && fb && <FeedbackPanel feedback={fb} onMistakeChange={changeMistake} />}
            </>
          )}

          <nav className="ex-sheet__nav" aria-label="التنقل بين الأسئلة">
            <Button variant="secondary" icon={<ArrowRight size={16} />} disabled={index === 0} onClick={() => void goTo(index - 1)}>
              السابق
            </Button>
            <Button variant="secondary" iconEnd={<ArrowLeft size={16} />} disabled={index >= session.items.length - 1} onClick={() => void goTo(index + 1)}>
              التالي
            </Button>
          </nav>
        </section>

        <aside className="ex-navigator" aria-label="خريطة الأسئلة">
          <h2 className="ex-subhead">الأسئلة</h2>
          {counts && (
            <p className="ex-muted">
              أُجيب {counts.answered} من {session.items.length}
              {counts.flagged > 0 && ` — ${questionsAr(counts.flagged)} مُعلَّمة`}
            </p>
          )}
          <ol className="ex-navigator__grid">
            {session.items.map((it, i) => {
              const a = state.answers[String(i)];
              const answered = !!a && a.selected_option_ids.length > 0;
              return (
                <li key={it.question_version_id + i}>
                  <button
                    type="button"
                    className="ex-nav-btn"
                    aria-label={navigatorLabel(i, state)}
                    aria-current={i === index ? 'step' : undefined}
                    data-answered={answered ? 'true' : undefined}
                    data-flagged={state.flagged.includes(i) ? 'true' : undefined}
                    onClick={() => void goTo(i)}
                  >
                    <span aria-hidden="true">{i + 1}</span>
                    {answered && <CircleCheck size={12} aria-hidden="true" className="ex-nav-btn__mark" />}
                    {state.flagged.includes(i) && <Flag size={12} aria-hidden="true" className="ex-nav-btn__flag" />}
                  </button>
                </li>
              );
            })}
          </ol>
        </aside>
      </div>

      <ConfirmDialog
        open={confirmFinish}
        title={practice ? 'إنهاء التدريب؟' : 'إنهاء الاختبار؟'}
        impact={
          counts ? (
            <>
              أُجيب {counts.answered} من {session.items.length}.{counts.unanswered > 0 && ` ${questionsAr(counts.unanswered)} بلا إجابة ${isAssessedMode(exam.mode) ? 'تُحسب غير صحيحة' : 'لا تدخل في النتيجة'}.`}
              {counts.flagged > 0 && ` لديك ${questionsAr(counts.flagged)} مُعلَّمة للمراجعة.`} بعد الإنهاء لا تتغير الإجابات.
            </>
          ) : (
            'بعد الإنهاء لا تتغير الإجابات.'
          )
        }
        confirmLabel="إنهاء وعرض النتيجة"
        onConfirm={doFinish}
        onCancel={() => setConfirmFinish(false)}
      />
    </main>
  );
}

function ConfidencePicker({ value, onChange }: { value: ConfidenceLevel | null; onChange: (v: ConfidenceLevel) => void }) {
  return (
    <div className="ex-confidence" role="group" aria-labelledby="ex-conf-label">
      <span id="ex-conf-label" className="ex-group-label">
        مدى ثقتك بإجابتك (اختياري)
      </span>
      <div className="ml-cluster">
        {CONFIDENCE_LEVELS.map((c) => (
          <Button key={c} size="sm" variant={value === c ? 'primary' : 'secondary'} aria-pressed={value === c} icon={value === c ? <Check size={14} /> : undefined} onClick={() => onChange(c)}>
            {CONFIDENCE_LABELS_AR[c]}
          </Button>
        ))}
      </div>
    </div>
  );
}

function TimerDisplay({ totalLeftMs, elapsedMs, itemLeftMs, itemOver }: { totalLeftMs: number | null; elapsedMs: number; itemLeftMs: number | null; itemOver: boolean }) {
  const main = totalLeftMs ?? elapsedMs;
  const label = totalLeftMs !== null ? `الوقت المتبقي ${durationAr(totalLeftMs)}` : `الوقت المنقضي ${durationAr(elapsedMs)}`;
  return (
    <span className="ex-timer" role="timer" aria-label={label} data-low={totalLeftMs !== null && totalLeftMs < 60_000 ? 'true' : undefined}>
      <Timer size={16} aria-hidden="true" />
      <span aria-hidden="true" className="ex-timer__main">
        <bdi dir="ltr">{formatClock(main)}</bdi>
      </span>
      <span aria-hidden="true" className="ex-timer__kind">
        {totalLeftMs !== null ? 'متبقٍ' : 'منقضٍ'}
      </span>
      {itemLeftMs !== null && (
        <span className="ex-timer__item" data-over={itemOver ? 'true' : undefined}>
          {itemOver ? (
            'تجاوزت وقت السؤال'
          ) : (
            <>
              للسؤال <bdi dir="ltr">{formatClock(itemLeftMs)}</bdi>
            </>
          )}
        </span>
      )}
    </span>
  );
}

function HintCard({ hint }: { hint: HintView }) {
  return (
    <section className="ex-hint" aria-label={hint.title_ar}>
      <h3 className="ex-subhead">
        <Lightbulb size={16} aria-hidden="true" /> {hint.title_ar}
      </h3>
      <p>
        <MixedLine text={hint.text_ar} />
      </p>
      {hint.pages.length > 0 && (
        <ul className="ex-list">
          {hint.pages.map((p) => (
            <li key={p.page_id}>
              <Link className="ex-link" to={`/study/${encodeURIComponent(p.source_id)}?page_id=${encodeURIComponent(p.page_id)}`}>
                <MixedLine text={p.lecture_title} /> — {p.label_ar}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {hint.stem && <RichTextView value={hint.stem} className="ex-hint__stem" />}
      {hint.clues.length > 0 && (
        <ul className="ex-list">
          {hint.clues.map((c, i) => (
            <li key={i}>
              <MixedLine text={c.why_ar} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
