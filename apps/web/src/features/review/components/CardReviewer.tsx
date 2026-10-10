// The flashcard reviewer (§43, AC-23, AC-24) used by the review session and the one-tap revision. Works OFFLINE:
// cards, review events and the SRS configuration are read from IndexedDB; the schedule is computed on the device with
// the server's algorithm and parameters (verified against the server's parity sample first). A rating is a
// review_event written locally with its outbox op — the reviewer never waits for the network.
// Keyboard: Space / Enter reveals the answer, 1–4 rate (Again / Hard / Good / Easy), Ctrl/⌘+Z undoes the last
// rating while it has not been sent yet.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { BookOpen, CircleAlert, Clock3, EllipsisVertical, Eye, PauseCircle, Pencil, RotateCcw, SkipForward } from 'lucide-react';
import { liveQuery } from 'dexie';
import { REVIEW_RATING_FSRS, REVIEW_RATING_LABELS_AR, type ReviewRating } from '@medlevo/shared';
import { Button, ErrorState, IconButton, Kbd, LoadingState, Menu, MenuItem, SaveStatus, Term, cx, useToast } from '../../../design';
import { getDb } from '../../../lib/localdb';
import { useEntitySyncState, useSyncSnapshot } from '../../../lib/sync';
import { formatTime, formatRelative } from '../../../lib/time';
import { useLearningSync, useLocalCards, useSrsConfig } from '../local/hooks';
import { computeQueue, scheduleOf, tomorrowStart, type LocalQueueItem } from '../local/queue';
import { intervalLabelAr, previewIntervals } from '../local/srs';
import { recordRating, setBuriedLocal, setSuspendedLocal, undoCheck, undoRating, type UndoCheck } from '../local/store';
import { cardsAr } from '../local/time';
import { CardEvidenceList, StateLabel } from './CardBits';
import { CardFace } from './CardFace';

const RATINGS: ReviewRating[] = [1, 2, 3, 4];
const WAIT_FOR_LEARNING_MS = 20 * 60_000;

export interface ReviewSummary {
  reviewed: number;
  byRating: Record<ReviewRating, number>;
}

export interface CardReviewerProps {
  /** restrict to these cards (one-tap revision) */
  cardIds?: string[] | null;
  sourceId?: string | null;
  /** listen to keyboard shortcuts on the window (the focused session screen) */
  keyboard?: boolean;
  /** what to show when nothing is left (defaults to a summary with links) */
  doneActions?: ReactNode;
  onProgress?: (p: { remaining: number; reviewed: number }) => void;
}

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || !!t.closest('[role="menu"],[role="dialog"],[role="alertdialog"]');
}

function useUndoState(eventId: string | null): UndoCheck | null {
  const [st, setSt] = useState<UndoCheck | null>(null);
  useEffect(() => {
    if (!eventId) {
      setSt(null);
      return;
    }
    const sub = liveQuery(() => undoCheck(getDb(), eventId)).subscribe({ next: setSt, error: () => setSt(null) });
    return () => sub.unsubscribe();
  }, [eventId]);
  return st;
}

function LastRatingBar({ last, onUndo }: { last: { eventId: string; rating: ReviewRating }; onUndo: () => void }) {
  const undo = useUndoState(last.eventId);
  const sync = useEntitySyncState('review_event', last.eventId);
  return (
    <div className="lw-lastbar" role="status" aria-live="polite">
      <span className="lw-lastbar__text">
        قيّمت البطاقة السابقة «{REVIEW_RATING_LABELS_AR[last.rating]}» <Term>{REVIEW_RATING_FSRS[last.rating]}</Term> — حُفظ التقييم على هذا الجهاز.
      </span>
      {sync && <SaveStatus state={sync} compact />}
      {undo?.possible ? (
        <Button size="sm" variant="plain" icon={<RotateCcw size={16} />} onClick={onUndo}>
          تراجع (قبل المزامنة فقط)
        </Button>
      ) : undo ? (
        <span className="lw-muted">{undo.reason_ar}</span>
      ) : null}
    </div>
  );
}

export function CardReviewer({ cardIds = null, sourceId = null, keyboard = true, doneActions, onProgress }: CardReviewerProps) {
  useLearningSync();
  const toast = useToast();
  const location = useLocation();
  const navigate = useNavigate();
  const cfg = useSrsConfig();
  const local = useLocalCards();
  const sync = useSyncSnapshot();
  const [now, setNow] = useState(() => Date.now());
  const [currentId, setCurrentId] = useState<string | null>(null);
  // which card's answer is shown (per card, so a reveal pressed in the same frame the card arrives is never undone)
  const [revealedId, setRevealedId] = useState<string | null>(null);
  const [shownAt, setShownAt] = useState(() => Date.now());
  const [last, setLast] = useState<{ eventId: string; cardId: string; rating: ReviewRating } | null>(null);
  const [summary, setSummary] = useState<ReviewSummary>({ reviewed: 0, byRating: { 1: 0, 2: 0, 3: 0, 4: 0 } });
  const [busy, setBusy] = useState(false);
  // review ahead (explicit card lists only): the owner chose to review chosen cards before they are due
  const [aheadSince, setAheadSince] = useState<number | null>(null);
  const revealRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLElement>(null);

  const usable = !!cfg.config && !!cfg.parity?.ok;
  const queueCfg = useMemo(() => (cfg.config ? { params: cfg.config.params, daily_new_limit: cfg.config.daily_new_limit, timezone: cfg.config.timezone } : null), [cfg.config]);
  const idsKey = cardIds?.join(',') ?? '';
  const queue = useMemo(
    () => (usable && queueCfg && local.ready ? computeQueue(queueCfg, local.cards, local.events, now, { cardIds, sourceId, aheadSince: cardIds ? aheadSince : null }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [usable, queueCfg, local.cards, local.events, local.ready, now, idsKey, sourceId, aheadSince],
  );

  // the card on screen stays put while it is being answered, even if a pull reorders the queue
  const current: LocalQueueItem | null = useMemo(() => {
    if (!queue) return null;
    const pinned = currentId ? queue.items.find((i) => i.card.id === currentId) : undefined;
    if (pinned) return pinned;
    if (currentId && revealedId === currentId && queueCfg) {
      const row = local.cards.find((c) => c.id === currentId && !c.deletedAt && !c.suspended);
      if (row) return { ...scheduleOf(queueCfg, row, local.events.get(row.id), now), reason: 'due', reason_ar: '' };
    }
    return queue.items[0] ?? null;
  }, [queue, currentId, revealedId, queueCfg, local.cards, local.events, now]);
  const revealed = !!current && revealedId === current.card.id;

  useEffect(() => {
    if (current && current.card.id !== currentId) {
      setCurrentId(current.card.id);
      setShownAt(Date.now());
    }
  }, [current, currentId]);

  useEffect(() => {
    onProgress?.({ remaining: queue?.items.length ?? 0, reviewed: summary.reviewed });
  }, [queue?.items.length, summary.reviewed, onProgress]);

  // a learning card that comes back within the session: wake up when it is due
  useEffect(() => {
    if (!queue || queue.items.length > 0 || queue.next_due_at === null) return;
    const wait = queue.next_due_at - Date.now();
    if (wait > WAIT_FOR_LEARNING_MS) return;
    const t = setTimeout(() => setNow(Date.now()), Math.max(250, wait + 50));
    return () => clearTimeout(t);
  }, [queue]);

  const previews = useMemo(() => {
    if (!current || !cfg.config) return null;
    const at = Date.now();
    const due = previewIntervals(cfg.config.params, current.fold.card, at);
    return Object.fromEntries(RATINGS.map((r) => [r, intervalLabelAr(due[r] - at)])) as Record<ReviewRating, string>;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.card.id, current?.fold, cfg.config, revealed]);

  const reveal = useCallback(() => {
    if (!current || revealed) return;
    setCurrentId(current.card.id);
    setRevealedId(current.card.id);
  }, [current, revealed]);

  const rate = useCallback(
    async (rating: ReviewRating) => {
      if (!current || !revealed || busy) return;
      setBusy(true);
      const at = Date.now();
      try {
        const ev = await recordRating(getDb(), { cardId: current.card.id, rating, reviewedAt: at, durationMs: Math.max(0, at - shownAt) }, at);
        setLast({ eventId: ev.id, cardId: current.card.id, rating });
        setSummary((s) => ({ reviewed: s.reviewed + 1, byRating: { ...s.byRating, [rating]: s.byRating[rating] + 1 } }));
        setCurrentId(null);
        setRevealedId(null);
        setNow(Date.now());
      } catch {
        toast.show({ title: 'تعذّر حفظ التقييم على هذا الجهاز. تحقق من مساحة التخزين ثم أعد المحاولة.', tone: 'danger' });
      } finally {
        setBusy(false);
      }
    },
    [current, revealed, busy, shownAt, toast],
  );

  const undo = useCallback(async () => {
    if (!last) return;
    const r = await undoRating(getDb(), last.eventId);
    if (!r.possible) {
      toast.show({ title: r.reason_ar, tone: 'warning' });
      return;
    }
    setSummary((s) => ({ reviewed: Math.max(0, s.reviewed - 1), byRating: { ...s.byRating, [last.rating]: Math.max(0, s.byRating[last.rating] - 1) } }));
    setCurrentId(last.cardId);
    setRevealedId(last.cardId);
    setLast(null);
    setNow(Date.now());
    toast.show({ title: 'سُحب التقييم الأخير قبل مزامنته؛ قيّم البطاقة من جديد.', tone: 'info' });
  }, [last, toast]);

  // keyboard flow — the listener reads the latest state through a ref that is updated with the commit (layout
  // effect), so a key pressed right after a card appears always acts on the card that is on screen
  const keyState = useRef({ revealed, reveal, rate, undo });
  useLayoutEffect(() => {
    keyState.current = { revealed, reveal, rate, undo };
  });
  useEffect(() => {
    if (!keyboard) return;
    const onKey = (e: KeyboardEvent) => {
      const { revealed, reveal, rate, undo } = keyState.current;
      if (e.defaultPrevented || isTypingTarget(e.target) || document.querySelector('[aria-modal="true"]')) return;
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        void undo();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const onButton = e.target instanceof HTMLButtonElement || (e.target instanceof HTMLElement && e.target.tagName === 'A');
      if ((e.key === ' ' || e.key === 'Enter') && !revealed && !onButton) {
        e.preventDefault();
        reveal();
        return;
      }
      if (revealed && /^[1-4]$/.test(e.key)) {
        e.preventDefault();
        void rate(Number(e.key) as ReviewRating);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [keyboard]);

  // focus follows the flow: the card when it appears, the answer when it is revealed
  useEffect(() => {
    if (current && !revealed) revealRef.current?.focus({ preventScroll: true });
  }, [current?.card.id, revealed]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (revealed) cardRef.current?.focus({ preventScroll: true });
  }, [revealed]);

  if (cfg.loading && !cfg.config) return <LoadingState stage="جارٍ تجهيز البطاقات على هذا الجهاز…" />;
  if (!cfg.config) {
    return (
      <ErrorState
        title="لا يمكن جدولة المراجعة على هذا الجهاز بعد"
        message="لم تُحفظ إعدادات الجدولة (FSRS) على هذا الجهاز. افتح المراجعة مرة واحدة مع اتصال، ثم تعمل البطاقات دون اتصال."
        onRetry={() => void cfg.refresh()}
      />
    );
  }
  if (!cfg.parity?.ok) {
    return (
      <ErrorState
        title="جدولة هذا الجهاز لا تطابق الخادم"
        message={`حسب الجهاز عينة التحقق من الخادم بنتيجة مختلفة (${cfg.parity?.mismatches.join('، ') ?? '—'}). لن يجدول الجهاز البطاقات بنفسه حتى لا تختلف المواعيد؛ حدّث التطبيق ثم أعد المحاولة.`}
        onRetry={() => void cfg.refresh()}
      />
    );
  }
  if (!local.ready || !queue) return <LoadingState stage="جارٍ قراءة البطاقات المحفوظة على هذا الجهاز…" />;

  if (!current && queue.counts.total === 0 && sync.online && sync.lastSyncedAt === null && !sync.lastError) return <LoadingState stage="جارٍ تنزيل بطاقاتك إلى هذا الجهاز لأول مرة…" />;
  if (!current) {
    const reviewedLine =
      summary.reviewed > 0
        ? `راجعت في هذه الجلسة ${cardsAr(summary.reviewed)}: مجددًا ${summary.byRating[1]}، صعب ${summary.byRating[2]}، جيد ${summary.byRating[3]}، سهل ${summary.byRating[4]}.`
        : null;
    const soon = queue.next_due_at !== null && queue.next_due_at - Date.now() <= WAIT_FOR_LEARNING_MS;
    return (
      <section className="lw-done" aria-labelledby="lw-done-h">
        <h2 id="lw-done-h" className="lw-done__title">
          {queue.counts.total === 0 ? 'لا توجد بطاقات على هذا الجهاز بعد' : cardIds ? 'انتهت بطاقات هذه الجلسة' : 'لا بطاقات مستحقة الآن'}
        </h2>
        {reviewedLine && <p>{reviewedLine}</p>}
        {queue.next_due_at !== null && (
          <p className="lw-muted">
            <Clock3 size={16} aria-hidden="true" /> {soon ? `بطاقة قيد التعلّم تعود ${formatRelative(queue.next_due_at)} (${formatTime(queue.next_due_at)})؛ ابقَ هنا وستظهر تلقائيًا.` : `أقرب موعد مراجعة: ${formatRelative(queue.next_due_at)}.`}
          </p>
        )}
        {queue.counts.total === 0 && <p className="lw-muted">أنشئ بطاقة من نص تحدده في الكتاب، أو من سؤال أخطأت فيه، أو اكتبها بنفسك.</p>}
        {cardIds && aheadSince === null && queue.counts.ahead > 0 && (
          <div className="lw-stack-sm">
            <p>{`${cardsAr(queue.counts.ahead)} من البطاقات المختارة لم يحن موعدها بعد. تستطيع مراجعتها الآن مبكرًا؛ تُسجَّل المراجعة المبكرة في سجلك وتُحسب في جدولتها.`}</p>
            <Button variant="secondary" icon={<Clock3 size={16} />} onClick={() => setAheadSince(Date.now())}>
              راجعها الآن قبل موعدها
            </Button>
          </div>
        )}
        {last && <LastRatingBar last={last} onUndo={() => void undo()} />}
        <div className="ml-cluster">{doneActions}</div>
      </section>
    );
  }

  const card = current.card;
  const back = `${location.pathname}${location.search}`;
  const activeImpact = (card.impacts ?? []).find((i) => i.active && i.resolved_at === null);

  return (
    <div className="lw-reviewer">
      <article ref={cardRef} tabIndex={-1} className="lw-card" aria-label={revealed ? 'البطاقة مع الإجابة' : 'وجه البطاقة'} aria-busy={busy}>
        <header className="lw-card__head">
          <span className="lw-card__kind">{card.kindLabelAr ?? 'بطاقة'}</span>
          <StateLabel state={current.view.state} mastered={current.mastered} />
          <span className="lw-card__reason">{current.reason_ar}</span>
          <Menu
            label="إجراءات البطاقة"
            align="end"
            trigger={<IconButton label="إجراءات البطاقة" icon={<EllipsisVertical size={18} />} />}
          >
            <MenuItem icon={<Pencil size={16} />} onSelect={() => navigate(`/review/cards/${encodeURIComponent(card.id)}?back=${encodeURIComponent(back)}`)}>
              عدّل البطاقة
            </MenuItem>
            <MenuItem
              icon={<SkipForward size={16} />}
              hint="تعود في يومك التالي"
              onSelect={async () => {
                try {
                  await setBuriedLocal(getDb(), card, tomorrowStart(Date.now(), cfg.config!.timezone));
                  setCurrentId(null);
                  toast.show({ title: 'أُجّلت البطاقة إلى الغد. سجلها لم يتغير.', tone: 'success' });
                } catch {
                  toast.show({ title: 'تعذّر حفظ التأجيل على هذا الجهاز. تحقق من مساحة التخزين ثم أعد المحاولة.', tone: 'danger' });
                }
              }}
            >
              أجّلها إلى الغد <Term>Bury</Term>
            </MenuItem>
            <MenuItem
              icon={<PauseCircle size={16} />}
              hint="لا تظهر حتى تعيد تفعيلها"
              onSelect={async () => {
                try {
                  await setSuspendedLocal(getDb(), card, true);
                  setCurrentId(null);
                  toast.show({ title: 'أُوقفت البطاقة؛ أعد تفعيلها من مكتبة البطاقات متى شئت. سجلها محفوظ.', tone: 'success' });
                } catch {
                  toast.show({ title: 'تعذّر حفظ الإيقاف على هذا الجهاز. تحقق من مساحة التخزين ثم أعد المحاولة.', tone: 'danger' });
                }
              }}
            >
              أوقفها <Term>Suspend</Term>
            </MenuItem>
            {card.sourceId && (
              <MenuItem icon={<BookOpen size={16} />} onSelect={() => navigate(`/study/${encodeURIComponent(card.sourceId!)}`)}>
                افتح المصدر
              </MenuItem>
            )}
          </Menu>
        </header>

        {activeImpact && (
          <p className="lw-note lw-note--warn" role="note">
            <CircleAlert size={16} aria-hidden="true" />
            <span>
              {activeImpact.reason_ar}{' '}
              <Link className="lw-link" to={`/review/cards/${encodeURIComponent(card.id)}?back=${encodeURIComponent(back)}`}>
                راجع البطاقة
              </Link>
            </span>
          </p>
        )}

        <div className="lw-card__body">
          <CardFace card={card} side="front" />
          {revealed && (
            <>
              <hr className="lw-card__rule" />
              <h3 className="ml-visually-hidden">الإجابة</h3>
              <CardFace card={card} side="back" />
              <CardEvidenceList snapshots={card.evidence ?? []} compact />
              {card.originLabelAr && <p className="lw-muted lw-card__origin">{card.originLabelAr}</p>}
            </>
          )}
        </div>
      </article>

      {!revealed ? (
        <div className="lw-actions">
          <Button ref={revealRef} variant="primary" size="lg" icon={<Eye size={18} />} onClick={reveal} fullWidth>
            اعرض الإجابة
          </Button>
          <p className="lw-hint">
            <Kbd>Space</Kbd> أو <Kbd>Enter</Kbd> لعرض الإجابة
          </p>
        </div>
      ) : (
        <div className="lw-actions">
          <p className="lw-hint" id="lw-rate-hint">
            كيف كان التذكّر؟ المواعيد محسوبة على هذا الجهاز بخوارزمية <Term>FSRS</Term> نفسها التي يستخدمها الخادم. الاختصارات <Kbd>1</Kbd>–<Kbd>4</Kbd>.
          </p>
          <div className="lw-rate" role="group" aria-label="قيّم تذكّرك" aria-describedby="lw-rate-hint">
            {RATINGS.map((r) => (
              <button key={r} type="button" className={cx('lw-rate__btn', r === 1 && 'lw-rate__btn--again')} onClick={() => void rate(r)} disabled={busy} aria-keyshortcuts={String(r)}>
                <span className="lw-rate__label">
                  {REVIEW_RATING_LABELS_AR[r]} <Term>{REVIEW_RATING_FSRS[r]}</Term>
                </span>
                <span className="lw-rate__next">{previews?.[r] ?? '—'}</span>
                <Kbd className="lw-rate__key">{String(r)}</Kbd>
              </button>
            ))}
          </div>
        </div>
      )}

      {last && <LastRatingBar last={last} onUndo={() => void undo()} />}
    </div>
  );
}
