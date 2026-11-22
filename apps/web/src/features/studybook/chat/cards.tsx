// Smart chat result cards (wp/smart-rail): a skill's result inside the thread, interactive, loaded from its OWN module
// by the ids the conversation stored (ChatAttachment) — nothing here is a second copy of a question, a case or a card.
//   mcq        a practice attempt over the published (verified) questions: pick → right / wrong, the explanation, the
//              lecture pages as chips, «سؤال آخر». Candidates that did not pass the checks say «بانتظار مراجعتك».
//   case       a ready case revealed step by step: presentation → questions → answers; a generated case that is not
//              ready yet is never played here («بانتظار مراجعتك» with the way to the case screen)
//   cards      flashcard drafts of the lecture's described figures: preview + «أضف إلى مراجعاتي» (draft → accepted)
//   questions  the vault's questions linked to this lecture / page, a compact list opening the question screen
//   sources    the conversation's Source Lock and the lecture's sources, with the way to the figures / web pictures
// (compare / figure cards are the evidence-checked artifact itself — ArtifactContent in ChatTurns.)
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Check, ChevronLeft, X } from 'lucide-react';
import {
  AUTHORED_DATA_NOTE_AR,
  CASE_ORIGIN_LABELS_AR,
  CASE_STAGE_TYPE_LABELS_AR,
  DECISION_APPROPRIATENESS_LABELS_AR,
  GENERATED_ORIGIN_LABEL_AR,
  newId,
  type AttemptFeedbackView,
  type CardDetailResponse,
  type CardMutationResponse,
  type CaseDetailView,
  type ChatAttachment,
  type ChatThreadView,
  type ExamSessionView,
  type FlashcardView,
  type GenerationRunView,
  type LectureQuestionsResponse,
} from '@medlevo/shared';
import { Button, ErrorState, RichTextView, Skeleton, StatusPill, buttonClass, cx } from '../../../design';
import { api, errorMessage } from '../../../lib/api';
import { MixedText } from '../../../lib/MixedText';
import { ScopeBadge } from '../../evidence';
import { examsApi } from '../../exams/api';
import { questionsApi } from '../../questions/api';
import type { SkillRunInput } from './SkillBar';
import type { ChatSkillId } from '@medlevo/shared';

/** What a card needs from the place it is shown (the workspace's reader, or /chat without one). */
export interface CardContext {
  /** lecture page index of a page id (evidence chips); null when it is not a page of this lecture */
  pageIndexOf?: (pageId: string) => number | null;
  pageLabel?: (pageIndex: number) => string | null;
  onJump?: (pageIndex: number) => void;
  /** the workspace's full tools (figures, web pictures, linked questions, cases) */
  onOpenTool?: (tool: 'sources' | 'questions' | 'cases') => void;
  /** the lecture's sources with their role (lecture / references) */
  sources?: Array<{ id: string; title: string; role_ar: string }>;
}

export interface ChatCardProps {
  messageId: string;
  attachment: ChatAttachment;
  thread: ChatThreadView | null;
  ctx: CardContext;
  /** run a skill again (MCQ «سؤال آخر» when the set is done) */
  onSkill?: (id: ChatSkillId, input: SkillRunInput) => void;
}

export function ChatCard(p: ChatCardProps) {
  const a = p.attachment;
  let body: ReactNode;
  switch (a.type) {
    case 'mcq':
      body = <McqCard messageId={p.messageId} a={a} ctx={p.ctx} onAnother={p.onSkill ? () => p.onSkill!(a.figure ? 'figure_question' : 'mcq', { count: 1, difficulty: (a.difficulty as SkillRunInput['difficulty']) ?? undefined }) : undefined} />;
      break;
    case 'case':
      body = <CaseCard caseId={a.case_id} />;
      break;
    case 'cards':
      body = <FlashcardsCard a={a} ctx={p.ctx} />;
      break;
    case 'questions':
      body = <QuestionsCard a={a} thread={p.thread} ctx={p.ctx} />;
      break;
    case 'sources':
      body = <SourcesCard thread={p.thread} ctx={p.ctx} />;
      break;
    default:
      // a compare / figure card whose checked artifact no longer exists (it is shown as the artifact otherwise)
      body = <p className="ch-card__body ch-muted">لم تعد نتيجة هذه البطاقة موجودة (ربما حُذفت).</p>;
  }
  return (
    <div className="ch-card" data-card={a.type}>
      {body}
    </div>
  );
}

function PageChips({ pageIds, ctx }: { pageIds: string[]; ctx: CardContext }) {
  const idx = [...new Set(pageIds.map((id) => ctx.pageIndexOf?.(id) ?? null).filter((i): i is number => i !== null))].sort((x, y) => x - y);
  if (!idx.length || !ctx.onJump) return null;
  return (
    <ul className="ch-pages" aria-label="صفحات الدليل في المحاضرة">
      {idx.map((i) => (
        <li key={i}>
          <button type="button" className="ch-page-chip" onClick={() => ctx.onJump!(i)} aria-label={`اذهب إلى الصفحة ${ctx.pageLabel?.(i) ?? i + 1}`}>
            {`ص ${ctx.pageLabel?.(i) ?? i + 1}`}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** A request that settles into state only while the card is mounted (no setState after unmount). */
function useLoad<T>(load: () => Promise<T>, key: string): { data: T | null; error: string | null; reload: () => void; set: (v: T) => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });
  useEffect(() => {
    let live = true;
    loadRef
      .current()
      .then((v) => {
        if (!live) return;
        setData(v);
        setError(null);
      })
      .catch((e: unknown) => live && setError(errorMessage(e, 'تعذّر تحميل البطاقة.')));
    return () => {
      live = false;
    };
  }, [key, n]);
  return { data, error, reload: () => setN((x) => x + 1), set: setData };
}

// ───────── MCQ ─────────
/** the answer's time (called from the click handler, never while rendering) */
const stamp = () => Date.now();

function McqCard({ messageId, a, ctx, onAnother }: { messageId: string; a: Extract<ChatAttachment, { type: 'mcq' }>; ctx: CardContext; onAnother?: () => void }) {
  const run = useLoad<GenerationRunView>(() => examsApi.run(a.run_id).then((r) => r.run), a.run_id);
  // a practice attempt over the published questions; the message id makes the create idempotent (reload → same attempt)
  const session = useLoad<ExamSessionView | null>(
    () =>
      a.question_ids.length
        ? examsApi.create({ attempt_id: messageId, title: 'أسئلة من المحادثة الذكية', mode: 'practice', question_ids: a.question_ids, count: a.question_ids.length }).then((r) => r.session)
        : Promise.resolve(null),
    `${messageId}|${a.question_ids.join(',')}`,
  );
  const [index, setIndex] = useState(0);
  const [feedback, setFeedback] = useState<Record<number, AttemptFeedbackView>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const items = session.data?.items ?? [];
  const item = items[index] ?? null;
  const fb = feedback[index] ?? null;
  const attemptId = session.data?.attempt.id ?? null;

  // an item answered before (reload): its feedback comes back from the exams module
  const answeredBefore = !!(attemptId && item && session.data?.attempt.answers?.[String(index)]);
  useEffect(() => {
    if (!attemptId || !answeredBefore || feedback[index]) return;
    let live = true;
    examsApi
      .feedback(attemptId, index)
      .then((f) => live && setFeedback((m) => ({ ...m, [index]: f })))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [attemptId, index, answeredBefore, feedback]);

  const answer = async (optionId: string) => {
    if (!attemptId || fb || busy) return;
    setBusy(true);
    setError(null);
    try {
      const f = await examsApi.answer(attemptId, index, { id: newId(), selected_option_ids: [optionId], answered_at: stamp() });
      setFeedback((m) => ({ ...m, [index]: f }));
    } catch (e) {
      setError(errorMessage(e, 'تعذّر التحقق من إجابتك.'));
    } finally {
      setBusy(false);
    }
  };

  const pending = a.pending_ids?.length ?? 0;
  const summary = run.data?.summary_ar ?? null;
  return (
    <section className="ch-card__body" aria-label="أسئلة اختيار من متعدد">
      {session.error && <ErrorState inline message={session.error} onRetry={session.reload} />}
      {a.question_ids.length > 0 && !session.data && !session.error && <Skeleton lines={3} />}
      {item && (
        <div className="ch-mcq">
          <p className="ch-card__meta">
            <span>{GENERATED_ORIGIN_LABEL_AR}</span>
            {items.length > 1 && <span>{`السؤال ${index + 1} من ${items.length}`}</span>}
          </p>
          <RichTextView value={item.stem} className="ch-mcq__stem" />
          <ul className="ch-mcq__options" role="list" aria-label="الخيارات">
            {item.options.map((o) => {
              const chosen = fb?.attempt?.selected_option_ids?.includes(o.id) ?? false;
              const right = fb?.correct_option_ids?.includes(o.id) ?? false;
              return (
                <li key={o.id}>
                  <button
                    type="button"
                    className={cx('ch-mcq__option', fb && right && 'ch-mcq__option--right', fb && chosen && !right && 'ch-mcq__option--wrong')}
                    aria-pressed={chosen}
                    disabled={!!fb || busy}
                    onClick={() => void answer(o.id)}
                  >
                    <span className="ch-mcq__label">{o.display_label}</span>
                    <RichTextView value={o.text} />
                    {fb && right && <Check size={14} aria-label="الإجابة الصحيحة" />}
                    {fb && chosen && !right && <X size={14} aria-label="إجابتك" />}
                  </button>
                </li>
              );
            })}
          </ul>
          {error && <ErrorState inline message={error} />}
          {fb && (
            <div className="ch-mcq__feedback" role="status">
              <StatusPill tone={fb.is_correct === null ? 'neutral' : fb.is_correct ? 'success' : 'danger'}>
                {fb.is_correct === null ? (fb.unscored_reason_ar ?? 'لا يُحتسب هذا السؤال') : fb.is_correct ? 'إجابة صحيحة' : 'إجابة خاطئة'}
              </StatusPill>
              {fb.explanation && <RichTextView value={fb.explanation} className="ch-mcq__why" />}
              <PageChips pageIds={fb.lecture_links.flatMap((l) => l.pages.map((pg) => pg.page_id))} ctx={ctx} />
            </div>
          )}
          <div className="ch-card__actions">
            {fb && index + 1 < items.length && (
              <Button size="sm" variant="primary" iconEnd={<ChevronLeft size={14} />} onClick={() => setIndex(index + 1)}>
                السؤال التالي
              </Button>
            )}
            {fb && index + 1 >= items.length && onAnother && (
              <Button size="sm" variant="secondary" onClick={onAnother}>
                سؤال آخر
              </Button>
            )}
            <Link className={buttonClass({ variant: 'plain', size: 'sm' })} to={`/questions/${encodeURIComponent(item.question_id)}`}>
              افتح السؤال
            </Link>
          </div>
        </div>
      )}
      {pending > 0 && (
        <div className="ch-card__pending" role="note">
          <StatusPill tone="warning">بانتظار مراجعتك</StatusPill>
          <p className="ch-muted">{`${pending === 1 ? 'سؤال واحد لم يجتز' : `${pending} أسئلة لم تجتز`} التحقق المستقل فلم يُنشر؛ ينتظر مراجعتك ولن يدخل أي اختبار.`}</p>
          <Link className={buttonClass({ variant: 'plain', size: 'sm' })} to="/questions/review">
            راجعه
          </Link>
        </div>
      )}
      {!a.question_ids.length && !pending && (
        <div className="ch-card__pending" role="note">
          <p className="ch-muted">{run.data?.abstain?.reason_ar ?? summary ?? 'لم يُنشر أي سؤال.'}</p>
          {run.data?.abstain?.suggestion_ar && <p className="ch-muted">{run.data.abstain.suggestion_ar}</p>}
        </div>
      )}
      {summary && (a.question_ids.length > 0 || pending > 0) && <p className="ch-muted">{summary}</p>}
    </section>
  );
}

// ───────── case ─────────
const CASE_POLL_MS = 2000;

function CaseCard({ caseId }: { caseId: string }) {
  const d = useLoad<CaseDetailView>(() => api.get<CaseDetailView>(`/cases/${encodeURIComponent(caseId)}`), caseId);
  const [step, setStep] = useState(0);
  const generating = d.data?.generation && (d.data.generation.status === 'queued' || d.data.generation.status === 'running');
  const { reload } = d;
  useEffect(() => {
    if (!generating) return;
    const t = setTimeout(reload, CASE_POLL_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generating, d.data]);
  const c = d.data;
  const def = c?.definition;
  const facts = useMemo(() => def?.facts.filter((f) => f.reveal === 'start') ?? [], [def]);
  const caseLink = (
    <Link className={buttonClass({ variant: 'plain', size: 'sm' })} to={`/cases/${encodeURIComponent(caseId)}`}>
      افتح الحالة كاملة
    </Link>
  );
  if (d.error) return <ErrorState inline message={d.error} onRetry={d.reload} />;
  if (!c) return <Skeleton lines={3} />;
  if (generating) {
    return (
      <div className="ch-card__body" role="status">
        <StatusPill tone="info">{c.generation!.status_label_ar}</StatusPill>
        <p className="ch-muted">تُكتب الحالة من صفحات المحاضرة ثم يُتحقق من كل جملة طبية فيها.</p>
      </div>
    );
  }
  if (c.generation && (c.generation.status === 'abstained' || c.generation.status === 'failed')) {
    return (
      <div className="ch-card__body" role="note">
        <StatusPill tone="warning">{c.generation.status_label_ar}</StatusPill>
        {c.generation.message_ar && <p className="ch-muted">{c.generation.message_ar}</p>}
      </div>
    );
  }
  if (c.status !== 'ready' || !def) {
    return (
      <div className="ch-card__body ch-card__pending" role="note">
        <StatusPill tone="warning">بانتظار مراجعتك</StatusPill>
        <p className="ch-muted">{c.status_reasons_ar[0] ?? 'لم تكتمل مراجعة هذه الحالة بعد؛ لا تُعرض هنا قبل أن تصبح جاهزة.'}</p>
        {caseLink}
      </div>
    );
  }
  const stages = def.stages;
  return (
    <section className="ch-card__body ch-case" aria-label={`حالة: ${c.title}`}>
      <p className="ch-card__title">
        <bdi>{c.title}</bdi>
      </p>
      <p className="ch-card__meta">
        <span>{CASE_ORIGIN_LABELS_AR[c.origin]}</span>
      </p>
      <h4 className="ch-case__step">العرض</h4>
      {def.summary && <MixedText as="p" text={def.summary} />}
      {facts.length > 0 && (
        <ul className="ch-case__facts">
          {facts.map((f) => (
            <li key={f.id}>
              <MixedText as="span" text={`${f.label}: ${f.value}`} />
            </li>
          ))}
        </ul>
      )}
      {step >= 1 && (
        <>
          <h4 className="ch-case__step">الأسئلة</h4>
          <ol className="ch-case__qs">
            {stages.map((s) => (
              <li key={s.id}>
                <span className="ch-case__stage">{CASE_STAGE_TYPE_LABELS_AR[s.type]}</span> <MixedText as="span" text={s.prompt || s.title} />
              </li>
            ))}
          </ol>
        </>
      )}
      {step >= 2 && (
        <>
          <h4 className="ch-case__step">الإجابات</h4>
          <ol className="ch-case__answers">
            {stages.map((s) => (
              <li key={s.id}>
                <MixedText as="p" className="ch-case__stage" text={s.title || CASE_STAGE_TYPE_LABELS_AR[s.type]} />
                <ul>
                  {s.decisions.map((x) => (
                    <li key={x.id}>
                      <MixedText as="span" text={x.label} /> — <span className="ch-muted">{DECISION_APPROPRIATENESS_LABELS_AR[x.appropriateness]}</span>
                      {x.explanation.length > 0 && <MixedText as="p" className="ch-muted" text={x.explanation.map((e) => e.text).join(' ')} />}
                    </li>
                  ))}
                </ul>
                {s.teaching_points.length > 0 && <MixedText as="p" text={s.teaching_points.map((e) => e.text).join(' ')} />}
              </li>
            ))}
          </ol>
        </>
      )}
      <p className="ch-muted">{AUTHORED_DATA_NOTE_AR}</p>
      <div className="ch-card__actions">
        {step === 0 && (
          <Button size="sm" variant="primary" onClick={() => setStep(1)}>
            اعرض الأسئلة
          </Button>
        )}
        {step === 1 && (
          <Button size="sm" variant="primary" onClick={() => setStep(2)}>
            اعرض الإجابات
          </Button>
        )}
        {caseLink}
      </div>
    </section>
  );
}

// ───────── flashcards ─────────
const isDraft = (c: FlashcardView) => {
  const d = (c.origin_ref as Record<string, unknown> | null)?.draft;
  return d === true || d === 1;
};

function FlashcardsCard({ a, ctx }: { a: Extract<ChatAttachment, { type: 'cards' }>; ctx: CardContext }) {
  const load = useCallback(
    () => Promise.all(a.card_ids.slice(0, 20).map((id) => api.get<CardDetailResponse>(`/learning/cards/${encodeURIComponent(id)}`).then((r) => r.card).catch(() => null))).then((xs) => xs.filter((x): x is FlashcardView => !!x && !x.deleted_at)),
    [a.card_ids],
  );
  const cards = useLoad<FlashcardView[]>(load, a.card_ids.join(','));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = cards.data ?? [];
  const drafts = list.filter(isDraft);
  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      const done = await Promise.all(drafts.map((c) => api.post<CardMutationResponse>(`/learning/cards/${encodeURIComponent(c.id)}/draft`, { decision: 'accept' }).then((r) => r.card)));
      cards.set(list.map((c) => done.find((x) => x.id === c.id) ?? c));
    } catch (e) {
      setError(errorMessage(e, 'تعذّرت إضافة البطاقات إلى مراجعاتك.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="ch-card__body" aria-label="بطاقات المراجعة">
      {cards.error && <ErrorState inline message={cards.error} onRetry={cards.reload} />}
      {a.card_ids.length > 0 && !cards.data && !cards.error && <Skeleton lines={2} />}
      {(a.notes_ar ?? []).map((n) => (
        <p key={n} className="ch-muted">
          {n}
        </p>
      ))}
      {list.length > 0 && (
        <ul className="ch-flash" role="list">
          {list.map((c) => (
            <li key={c.id} className="ch-flash__card">
              <RichTextView value={c.front} />
              <RichTextView value={c.back} className="ch-flash__back" />
              <span className="ch-card__meta">{isDraft(c) ? 'مسودة' : 'في مراجعاتك'}</span>
            </li>
          ))}
        </ul>
      )}
      {error && <ErrorState inline message={error} />}
      <div className="ch-card__actions">
        {drafts.length > 0 && (
          <Button size="sm" variant="primary" loading={busy} onClick={() => void accept()}>
            أضف إلى مراجعاتي
          </Button>
        )}
        {list.length > 0 && drafts.length === 0 && (
          <Link className={buttonClass({ variant: 'plain', size: 'sm' })} to="/review">
            افتح مراجعاتي
          </Link>
        )}
        {a.card_ids.length === 0 && ctx.onOpenTool && (
          <Button size="sm" variant="plain" onClick={() => ctx.onOpenTool!('sources')}>
            صور المحاضرة وأوصافها
          </Button>
        )}
      </div>
    </section>
  );
}

// ───────── linked questions ─────────
function QuestionsCard({ a, thread, ctx }: { a: Extract<ChatAttachment, { type: 'questions' }>; thread: ChatThreadView | null; ctx: CardContext }) {
  const sourceId = thread?.source_id ?? null;
  const d = useLoad<LectureQuestionsResponse | null>(() => (sourceId ? questionsApi.forLecture(sourceId, a.page_id) : Promise.resolve(null)), `${sourceId}|${a.page_id}`);
  const items = (d.data?.items ?? []).filter((x) => a.ids.includes(x.question_id));
  return (
    <section className="ch-card__body" aria-label="أسئلة المحاضرة المرتبطة">
      {d.error && <ErrorState inline message={d.error} onRetry={d.reload} />}
      {!d.data && !d.error && sourceId && <Skeleton lines={2} />}
      {d.data && items.length === 0 && <p className="ch-muted">{d.data.matching.message_ar ?? 'لا توجد أسئلة مرتبطة بهذه الصفحة بعد.'}</p>}
      {items.length > 0 && (
        <ul className="ch-qlist" role="list" aria-label={`الأسئلة المرتبطة (${items.length})`}>
          {items.slice(0, 12).map((q) => (
            <li key={q.question_id}>
              <Link className="ch-qlist__item" to={`/questions/${encodeURIComponent(q.question_id)}`}>
                <MixedText as="span" className="ch-qlist__stem" text={q.stem_preview} />
                <span className="ch-card__meta">{q.on_this_page ? `${q.origin_label_ar} · هذه الصفحة` : q.origin_label_ar}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <div className="ch-card__actions">
        {ctx.onOpenTool && (
          <Button size="sm" variant="plain" onClick={() => ctx.onOpenTool!('questions')}>
            كل أسئلة المحاضرة
          </Button>
        )}
      </div>
    </section>
  );
}

// ───────── sources ─────────
function SourcesCard({ thread, ctx }: { thread: ChatThreadView | null; ctx: CardContext }) {
  return (
    <section className="ch-card__body" aria-label="المصادر">
      {thread && <ScopeBadge scope={thread.scope} detailed />}
      {thread?.scope.describe_ar && <p className="ch-muted">{thread.scope.describe_ar}</p>}
      {(ctx.sources ?? []).length > 0 && (
        <ul className="ch-sources" role="list" aria-label="مصادر المحاضرة">
          {ctx.sources!.map((s) => (
            <li key={s.id} className="ch-sources__chip">
              <MixedText as="span" text={s.title} />
              <span className="ch-card__meta">{s.role_ar}</span>
            </li>
          ))}
        </ul>
      )}
      {ctx.onOpenTool && (
        <div className="ch-card__actions">
          <Button size="sm" variant="secondary" onClick={() => ctx.onOpenTool!('sources')}>
            الصفحة وأشكالها وصور الويب
          </Button>
          <Button size="sm" variant="plain" onClick={() => ctx.onOpenTool!('cases')}>
            حالات المحاضرة
          </Button>
        </div>
      )}
    </section>
  );
}
