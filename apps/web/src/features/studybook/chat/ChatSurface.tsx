// The Claude-style study chat: explain a lecture page, help with a question, compare, or chat freely — one surface used
// in the lecture workspace (side panel / phone dock) and on /chat. Everything an answer says goes through the server's
// evidence pipeline: the draft streams labelled «مسودة لم تُتحقق بعد» and is REPLACED by the checked answer (unsupported
// medical sentences removed, never softened; citations to the lecture pages).
//
// Reader ↔ chat page sync («مزامنة الصفحات», on by default, remembered):
//   reader → chat  the visible page scrolls the thread to the turn filed under that page (turnForPage); with
//                  «اشرح هذه الصفحة تلقائيًا» a page at rest for AUTO_EXPLAIN_DELAY_MS that has no turn yet is asked
//                  for once (never twice per page, never while an answer is being written, never without allowance)
//   chat → reader  an answer about other pages moves the reader to them; scrolling the thread to a page's section,
//                  a «صفحة N» divider or a «ص N» chip moves the reader there
//   no loop        each side marks the move it makes (PageSyncGuard) and the echo of that move is not followed back
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { History, MessageSquarePlus, Paperclip } from 'lucide-react';
import {
  newId,
  type ChatAttachment,
  type ChatEffort,
  type ChatKind,
  type ChatMessageContext,
  type ChatMessageView,
  type ChatModelId,
  type ChatPrefsResponse,
  type ChatSkillId,
  type ChatThreadResponse,
  type ChatThreadView,
  type SelectionAnchor,
  type SourceScope,
} from '@medlevo/shared';
import { Button, ErrorState, IconButton, LoadingState, Switch, cx, useToast } from '../../../design';
import { errorMessage } from '../../../lib/api';
import { aiAllowanceStore } from '../../../lib/aiAllowance';
import type { FeatureGateState } from '../../../lib/capabilities';
import { MixedText } from '../../../lib/MixedText';
import { ScopeBadge } from '../../evidence';
import { getSyncEngine } from '../../../lib/sync';
import { studybookApi } from '../api';
import { threadMatchesScope } from '../model';
import { EMPTY_STREAM, reduceStream } from '../streaming';
import { chatApi } from './api';
import { ChatHistory } from './ChatHistory';
import { ChatTurns, type PendingTurn } from './ChatTurns';
import { Composer, type ComposerHandle, type ContextChip } from './Composer';
import { ModelEffortMenu, type ModelEffortValue } from './ModelEffortMenu';
import { ChatCard, type CardContext } from './cards';
import { SKILL_ICONS, SkillBar, type SkillItem, type SkillRunInput } from './SkillBar';
import { matchSkills, requestText, skillDef, slashQuery } from './skills';
import {
  AUTO_EXPLAIN_DELAY_MS,
  AUTO_EXPLAIN_PROMPT,
  pageChipLabel,
  pageForTurn,
  PageSyncGuard,
  plainOf,
  readerTargetForAnswer,
  shouldAutoExplain,
  topTurn,
  turnForPage,
  turnsOf,
  type Turn,
} from './model';
import './chat.css';

export interface ChatPage {
  id: string;
  version_id: string;
}

/** (smart chat) what a card skill returns: the owner's request wording and the card to append to the conversation */
export interface SkillCardResult {
  text: string;
  attachment: ChatAttachment;
  artifact_id?: string | null;
  context?: ChatMessageContext | null;
}

/**
 * (smart chat, wp/smart-rail) the skills of this place: chips above the composer and the «/» menu. Chat skills
 * («اشرح الصفحة», «لخّص») are questions to this chat; the others run their module's capability (`run`) and come back
 * as a card stored in the conversation (chatApi.appendCard).
 */
export interface ChatSkillsConfig {
  items: SkillItem[];
  run: (id: ChatSkillId, input: SkillRunInput, o: { signal: AbortSignal; onStage: (stage: string) => void }) => Promise<SkillCardResult>;
  card: CardContext;
  /** the compare form's first term (e.g. the selection) */
  compareSeed?: string;
}

const SKILL_STAGE_AR: Partial<Record<ChatSkillId, string>> = {
  mcq: 'تُكتب الأسئلة ثم يُتحقق من مفتاح كل سؤال ومن تفسير كل خيار…',
  figure_question: 'يُكتب سؤال الصورة ثم يُتحقق منه…',
  case: 'تُطلب الحالة من صفحات المحاضرة…',
  compare: 'يُبحث عن كل طرف في النطاق ثم يُتحقق من كل خلية…',
  explain_figure: 'يُقرأ الشكل وتعليقه ويُتحقق مما يذكره المصدر…',
  cards: 'تُصنع البطاقات من أوصاف صور المحاضرة…',
  lecture_questions: 'تُجمع أسئلة خزنتك المرتبطة…',
  sources: 'تُجمع مصادر المحادثة…',
};
const AI_SKILLS = new Set<ChatSkillId>(['mcq', 'figure_question', 'case', 'compare', 'explain_figure']);

export interface ChatSurfaceProps {
  /** the lecture the conversation is about (null on /chat without a lecture) */
  sourceId: string | null;
  sourceTitle?: string | null;
  /** the lecture's pages by index (to attach the visible page) */
  pages?: ReadonlyArray<ChatPage>;
  /** printed page label of an index (chips «ص 3»), default index + 1 */
  pageLabel?: (pageIndex: number) => string | null;
  /** the page the reader shows now (page sync) */
  visiblePage?: number | null;
  /** a selection in the reader the owner may attach */
  selection?: { anchor: SelectionAnchor; text: string } | null;
  /** the Source Lock new conversations are created under (null: cannot start one here) */
  scope: SourceScope | null;
  gate: FeatureGateState;
  online: boolean;
  /** move the reader (chat → reader); absent → no page sync */
  onJumpToPage?: (pageIndex: number) => void;
  /** without a reader (/chat): a «ص N» chip opens that page of the conversation's lecture */
  onOpenSourcePage?: (sourceId: string, pageIndex: number) => void;
  /** the owner widened the lock from an abstention */
  onScopeChange?: (scope: SourceScope) => void;
  /** bump to focus the composer, optionally with text put in it (never auto-sent) */
  focusKey?: number;
  prefill?: string | null;
  initialThreadId?: string | null;
  /**
   * 'rail' = narrow panel inside a tab (history as an overlay), 'side' = the workspace's full-height chat panel (history
   * slides in as a column inside it), 'full' = /chat (history as a column, open)
   */
  layout?: 'rail' | 'side' | 'full';
  /** extra controls at the end of the header (the side panel's «أغلق المحادثة») */
  headerActions?: ReactNode;
  /** tests: a fixed clock for the history groups and the guard */
  now?: () => number;
  /** (smart chat) skill chips + «/» menu + result cards */
  skills?: ChatSkillsConfig;
  /** cards without skills (e.g. /chat): how a card reaches pages and tools */
  cardContext?: CardContext;
}

interface Outcome {
  hadDraft: boolean;
  removed: Array<{ text: string; reason_ar: string }>;
}

const SUGGESTIONS: Array<{ label: string; text: string; kind: ChatKind; page: boolean; send: boolean }> = [
  { label: 'اشرح هذه الصفحة', text: 'اشرح هذه الصفحة', kind: 'explain', page: true, send: true },
  { label: 'لخّص المحاضرة', text: 'لخّص المحاضرة في نقاط مرتبة.', kind: 'chat', page: false, send: true },
  { label: 'اسألني سؤالًا', text: 'اسألني سؤالًا واحدًا عن هذه الصفحة وانتظر جوابي.', kind: 'question', page: true, send: true },
  { label: 'قارن بين…', text: 'قارن بين  و  في جدول.', kind: 'compare', page: false, send: false },
];

function reducedMotion(): boolean {
  try {
    return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export function ChatSurface(p: ChatSurfaceProps) {
  const toast = useToast();
  const layout = p.layout ?? 'rail';
  const clock = p.now ?? Date.now;
  const visible = p.visiblePage ?? null;
  const [prefs, setPrefs] = useState<ChatPrefsResponse | null>(null);
  const [threads, setThreads] = useState<ChatThreadView[] | null>(null);
  const [filter, setFilter] = useState<'lecture' | 'all'>(p.sourceId ? 'lecture' : 'all');
  const [query, setQuery] = useState('');
  const [historyOpen, setHistoryOpen] = useState(layout === 'full');
  const [active, setActive] = useState<ChatThreadResponse | null>(null);
  const [text, setText] = useState('');
  const [kindNext, setKindNext] = useState<ChatKind>('chat');
  const [editing, setEditing] = useState<string | null>(null);
  const [pending, setPending] = useState<(PendingTurn & { replaceFrom: string | null }) | null>(null);
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const [saved, setSaved] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<{ message: string; retry: (() => void) | null } | null>(null);
  const [announce, setAnnounce] = useState('');
  const [attachPage, setAttachPage] = useState(true);
  const [selDismissed, setSelDismissed] = useState<string | null>(null);
  const [choice, setChoice] = useState<ModelEffortValue>({ model: null, effort: null });
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const composer = useRef<ComposerHandle>(null);
  const guard = useMemo(() => new PageSyncGuard(900, clock), [clock]);
  const autoAsked = useRef(new Set<number>());
  const triedInitial = useRef(false);

  const syncOn = (prefs?.prefs.sync_pages ?? true) && !!p.onJumpToPage;
  const autoOn = prefs?.prefs.auto_explain ?? false;
  const turns = useMemo(() => turnsOf(active?.messages ?? []), [active]);
  const shownTurns = useMemo(() => {
    if (!pending?.replaceFrom) return turns;
    const i = turns.findIndex((t) => t.id === pending.replaceFrom);
    return i >= 0 ? turns.slice(0, i) : turns;
  }, [turns, pending]);
  // (smart chat) a card skill running: its request, the stage it is in
  const [skillPending, setSkillPending] = useState<{ id: ChatSkillId; text: string; stage: string } | null>(null);
  const [skillForm, setSkillForm] = useState<ChatSkillId | null>(null);
  const skillAbort = useRef<AbortController | null>(null);
  const busy = pending !== null || skillPending !== null;
  const labelOf = p.pageLabel;

  // ── loading: preferences, history, the conversation to show ──
  useEffect(() => {
    if (!p.online) return;
    let live = true;
    chatApi
      .prefs()
      .then((r) => {
        if (!live || !r?.prefs) return;
        setPrefs(r);
        setChoice({ model: r.prefs.model, effort: r.prefs.effort });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [p.online]);

  const loadThreads = useCallback(() => {
    if (!p.online) return Promise.resolve([] as ChatThreadView[]);
    return chatApi
      .list({ source_id: filter === 'lecture' ? p.sourceId : null, q: query })
      .then((r) => {
        const list = Array.isArray(r?.threads) ? r.threads : [];
        setThreads(list);
        return list;
      })
      .catch((e: unknown) => {
        setThreads([]);
        setError({ message: errorMessage(e, 'تعذّر تحميل المحادثات.'), retry: null });
        return [] as ChatThreadView[];
      });
  }, [p.online, p.sourceId, filter, query]);

  const open = useCallback(async (id: string) => {
    try {
      const r = await chatApi.thread(id);
      setActive(r);
      setEditing(null);
      setError(null);
      if (layout !== 'full') setHistoryOpen(false);
    } catch (e) {
      setError({
        message: errorMessage(e, 'تعذّر فتح المحادثة.'),
        retry: () => {
          setError(null);
          void chatApi.thread(id).then(setActive).catch(() => undefined);
        },
      });
    }
  }, [layout]);

  useEffect(() => {
    const t = setTimeout(() => {
      void loadThreads().then((list) => {
        // the lecture's latest conversation continues where it was (page sync needs one thread per reading)
        if (triedInitial.current) return;
        triedInitial.current = true;
        const first = p.initialThreadId ?? (p.sourceId ? list.find((x) => x.source_id === p.sourceId)?.id : null);
        if (first) void open(first);
      });
    }, query ? 250 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadThreads]);

  // ── composer handover (selection toolbar «اسأل», handwriting) ──
  const [takenFocus, setTakenFocus] = useState<number | null>(null);
  if (p.focusKey !== undefined && takenFocus !== p.focusKey) {
    setTakenFocus(p.focusKey);
    if (p.focusKey > 0 && p.prefill) setText((t) => (t.trim() && t.trim() !== p.prefill!.trim() ? `${t.trimEnd()}\n\n${p.prefill}` : p.prefill!));
  }
  useEffect(() => {
    if ((p.focusKey ?? 0) > 0) composer.current?.focus();
  }, [p.focusKey]);

  // ── context chips ──
  const page = visible !== null ? (p.pages?.[visible] ?? null) : null;
  const selKey = p.selection ? `${p.selection.anchor.page_id ?? ''}|${p.selection.text}` : null;
  const selection = p.selection && selKey !== selDismissed ? p.selection : null;
  const chips: ContextChip[] = [];
  if (page && attachPage && visible !== null) chips.push({ key: 'page', kind: 'page', label: `${pageChipLabel(visible, labelOf).replace('ص', 'الصفحة')}` });
  if (selection) chips.push({ key: 'selection', kind: 'selection', label: 'التحديد', quote: selection.text.length > 80 ? `${selection.text.slice(0, 80)}…` : selection.text });

  const contextFor = (withPage: boolean, pageIndex: number | null): ChatMessageContext | null => {
    const pg = pageIndex !== null ? (p.pages?.[pageIndex] ?? null) : null;
    const c: ChatMessageContext = {};
    if (withPage && pg) c.page_id = pg.id;
    if (selection) {
      c.page_id = selection.anchor.page_id ?? c.page_id ?? null;
      c.region_ids = selection.anchor.region_ids ?? [];
      c.quote = selection.text.slice(0, 6000);
    }
    return c.page_id || c.quote ? c : null;
  };

  // ── programmatic scrolling (marked, so it is never followed back) ──
  const scrollToTurn = useCallback(
    (id: string) => {
      const box = listRef.current;
      const el = box ? Array.from(box.querySelectorAll<HTMLElement>('[data-turn-id]')).find((x) => x.dataset.turnId === id) : undefined;
      if (!box || !el) return;
      guard.movingChat();
      el.scrollIntoView?.({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
    },
    [guard],
  );
  const scrollToEnd = useCallback(() => {
    const box = listRef.current;
    if (!box) return;
    guard.movingChat();
    box.scrollTop = box.scrollHeight;
  }, [guard]);
  const jumpReader = useCallback(
    (i: number) => {
      if (!p.onJumpToPage) return;
      guard.movingReader();
      p.onJumpToPage(i);
    },
    [guard, p],
  );

  // ── sending ──
  const send = async (
    raw: string,
    o: { kind?: ChatKind; withPage?: boolean; replaceFrom?: string | null; context?: ChatMessageContext | null; pageIndex?: number | null; scope?: SourceScope } = {},
  ) => {
    const q = raw.trim();
    if (!q || busy || !p.gate.available) return;
    setSkillForm(null);
    setError(null);
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    const pageIndex = o.pageIndex !== undefined ? o.pageIndex : (o.withPage ?? attachPage) ? visible : null;
    const context = o.context !== undefined ? o.context : contextFor(o.withPage ?? attachPage, pageIndex);
    const kind = o.kind ?? kindNext;
    setPending({ text: q, pageIndex: context?.page_id ? pageIndex : null, stream: EMPTY_STREAM, replaceFrom: o.replaceFrom ?? null });
    setAnnounce('أُرسل سؤالك؛ تُكتب الإجابة ثم يُتحقق منها.');
    setTimeout(scrollToEnd, 0);
    let threadId: string | null = null;
    try {
      // G2 / AC-05: only ever continue a thread pinned to the lock in force (an explicit wider lock comes in `o.scope`)
      const lock = o.scope ?? p.scope;
      let thread = active?.thread ?? null;
      if (!thread || (lock && !threadMatchesScope(thread, lock))) {
        if (!lock) throw new Error('لا يمكن بدء محادثة هنا: افتح محاضرة أولًا.');
        const created = await chatApi.create({ anchor: null, scope: lock, kind });
        thread = created.thread;
        setActive(created);
      }
      threadId = thread.id;
      const { result, removed, hadDraft } = await chatApi.send(
        thread.id,
        { text: q, kind, context, ...(choice.model ? { model: choice.model } : {}), ...(choice.effort ? { effort: choice.effort } : {}), ...(o.replaceFrom ? { replace_from: o.replaceFrom } : {}) },
        {
          signal: ac.signal,
          onEvent: (e) => {
            if (ac.signal.aborted) return;
            setPending((v) => (v ? { ...v, stream: reduceStream(v.stream, e) } : v));
          },
        },
      );
      if (ac.signal.aborted) return;
      setOutcomes((m) => ({ ...m, [result.answer.id]: { hadDraft, removed } }));
      const fresh = await chatApi.thread(thread.id);
      setActive(fresh);
      setPending(null);
      setText('');
      setEditing(null);
      setKindNext('chat');
      setAnnounce(result.answer.status === 'abstained' ? 'لم تُكتب إجابة؛ السبب معروض تحت السؤال.' : removed.length ? `اكتملت الإجابة بعد التحقق؛ حُذفت ${removed.length} جملة لم تجتز التحقق.` : 'اكتملت الإجابة بعد التحقق.');
      void loadThreads();
      // chat → reader: an answer about other pages brings them into view
      if (syncOn && result.answer.status === 'final') {
        const target = readerTargetForAnswer(result.answer.page_indexes ?? [], visible);
        if (target !== null) jumpReader(target);
      }
    } catch (e) {
      setPending(null);
      if (ac.signal.aborted) {
        setAnnounce('أوقفتَ الإجابة؛ لم يُحفظ منها شيء.');
        toast.show({ title: 'أوقفتَ الإجابة؛ لم يُحفظ منها شيء.', tone: 'info' });
      } else {
        setError({ message: errorMessage(e, 'تعذّر إرسال الرسالة.'), retry: () => void send(q, o) });
        setAnnounce('تعذّر إكمال الإجابة.');
      }
      if (threadId) void chatApi.thread(threadId).then(setActive).catch(() => undefined);
    } finally {
      if (!ac.signal.aborted) aiAllowanceStore.spent();
    }
  };
  useEffect(
    () => () => {
      abortRef.current?.abort();
      skillAbort.current?.abort();
    },
    [],
  );
  const stop = () => abortRef.current?.abort();

  // ── (smart chat) skills ──
  const runSkill = async (id: ChatSkillId, input: SkillRunInput) => {
    const cfg = p.skills;
    const item = cfg?.items.find((x) => x.def.id === id);
    if (!cfg || !item?.available || busy) return;
    const def = skillDef(id);
    setSkillForm(null);
    setError(null);
    if (def.mode === 'chat') {
      void send(requestText(id, { selection: !!selection }), { kind: id === 'explain_page' ? 'explain' : 'chat', withPage: true });
      return;
    }
    skillAbort.current?.abort();
    const ac = new AbortController();
    skillAbort.current = ac;
    setSkillPending({ id, text: def.label, stage: SKILL_STAGE_AR[id] ?? 'يُنفَّذ الطلب…' });
    setAnnounce(`بدأت «${def.label}».`);
    setTimeout(scrollToEnd, 0);
    try {
      const r = await cfg.run(id, input, { signal: ac.signal, onStage: (stage) => setSkillPending((v) => (v && v.id === id ? { ...v, stage } : v)) });
      if (ac.signal.aborted) return;
      setSkillPending((v) => (v ? { ...v, text: r.text } : v));
      let thread = active?.thread ?? null;
      const lock = p.scope;
      if (!thread || (lock && !threadMatchesScope(thread, lock))) {
        if (!lock) throw new Error('لا يمكن بدء محادثة هنا: افتح محاضرة أولًا.');
        thread = (await chatApi.create({ anchor: null, scope: lock, kind: 'chat' })).thread;
      }
      await chatApi.appendCard(thread.id, { text: r.text, skill: id, attachment: r.attachment, artifact_id: r.artifact_id ?? null, context: r.context ?? null });
      const fresh = await chatApi.thread(thread.id);
      if (ac.signal.aborted) return;
      setActive(fresh);
      setAnnounce(`اكتملت «${def.label}»؛ النتيجة في المحادثة.`);
      void loadThreads();
      setTimeout(scrollToEnd, 0);
    } catch (e) {
      if (!ac.signal.aborted) {
        setError({ message: errorMessage(e, `تعذّر إكمال «${def.label}».`), retry: () => void runSkill(id, input) });
        setAnnounce(`تعذّر إكمال «${def.label}».`);
      }
    } finally {
      if (skillAbort.current === ac) setSkillPending(null);
      if (AI_SKILLS.has(id) && !ac.signal.aborted) aiAllowanceStore.spent();
    }
  };
  const stopSkill = () => {
    skillAbort.current?.abort();
    setSkillPending(null);
    setAnnounce('أوقفتَ الطلب.');
  };

  // the «/» menu: the composer's text starting with «/» lists the matching skills (arrows, Enter / Tab, Escape)
  const menuId = useId();
  const [slashActive, setSlashActive] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState<string | null>(null);
  const slash = p.skills && !busy ? slashQuery(text) : null;
  const slashItems = slash !== null && p.skills ? matchSkills(slash, p.skills.items) : [];
  const slashOpen = slash !== null && slashItems.length > 0 && slashDismissed !== text;
  const activeIdx = slashOpen ? Math.min(slashActive, slashItems.length - 1) : 0;
  const pickSlash = (it: SkillItem) => {
    if (!it.available) return;
    setText('');
    setSlashActive(0);
    if (it.def.form) setSkillForm(it.def.id);
    else void runSkill(it.def.id, {});
  };
  const onMenuKey = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!slashOpen) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = slashItems.length;
      setSlashActive((activeIdx + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
      return true;
    }
    if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
      e.preventDefault();
      pickSlash(slashItems[activeIdx]!);
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setSlashDismissed(text);
      return true;
    }
    return false;
  };
  const slashMenu = slashOpen ? (
    <ul id={menuId} className="ch-slash" role="listbox" aria-label="المهارات">
      {slashItems.map((it, i) => (
        <li
          key={it.def.id}
          id={`${menuId}-${it.def.id}`}
          role="option"
          aria-selected={i === activeIdx}
          aria-disabled={!it.available || undefined}
          className={cx('ch-slash__item', i === activeIdx && 'ch-slash__item--active')}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => pickSlash(it)}
        >
          <span className="ch-slash__icon" aria-hidden="true">
            {SKILL_ICONS[it.def.id]}
          </span>
          <span className="ch-slash__label">{it.def.label}</span>
          <bdi className="ch-slash__cmd" dir="auto">{`/${it.def.command}`}</bdi>
          <span className="ch-slash__hint">{it.available ? it.def.hint : (it.reason ?? 'غير متاح الآن.')}</span>
        </li>
      ))}
    </ul>
  ) : null;
  const cardCtx = p.skills?.card ?? p.cardContext;

  // ── reader → chat ──
  useEffect(() => {
    if (!syncOn || visible === null || !active || pending) return;
    if (!guard.followReader()) return;
    const id = turnForPage(visible, turns);
    if (id) scrollToTurn(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // ── «اشرح هذه الصفحة تلقائيًا» (debounced: the page must stay in view) ──
  useEffect(() => {
    if (!autoOn || visible === null) return;
    const t = setTimeout(() => {
      const hasTurn = turnForPage(visible, turns) !== null && turns.some((x) => x.primaryPage === visible);
      if (!shouldAutoExplain({ enabled: autoOn, sync: syncOn, page: visible, hasTurn, asked: autoAsked.current, busy, available: p.gate.available && !!p.scope, online: p.online })) return;
      autoAsked.current.add(visible);
      void send(AUTO_EXPLAIN_PROMPT, { kind: 'explain', withPage: true, pageIndex: visible, context: p.pages?.[visible] ? { page_id: p.pages[visible]!.id } : null });
    }, AUTO_EXPLAIN_DELAY_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, autoOn, syncOn, busy, turns, p.gate.available, p.online]);

  // ── chat → reader: the person scrolls the thread to another page's section ──
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onThreadScroll = () => {
    if (!syncOn) return;
    if (scrollTimer.current) clearTimeout(scrollTimer.current);
    scrollTimer.current = setTimeout(() => {
      const box = listRef.current;
      if (!box || !guard.followChat()) return;
      const boxTop = box.getBoundingClientRect().top;
      const tops = Array.from(box.querySelectorAll<HTMLElement>('[data-turn-id]')).map((el) => ({ id: el.dataset.turnId!, top: el.getBoundingClientRect().top - boxTop }));
      const id = topTurn(tops, 48);
      const pg = id ? pageForTurn(id, turns) : null;
      if (pg !== null && pg !== visible) jumpReader(pg);
    }, 180);
  };
  useEffect(() => () => {
    if (scrollTimer.current) clearTimeout(scrollTimer.current);
  }, []);

  // ── preferences ──
  const savePrefs = (patch: Partial<ChatPrefsResponse['prefs']>) => {
    setPrefs((cur) => (cur ? { ...cur, prefs: { ...cur.prefs, ...patch } } : cur));
    void chatApi.savePrefs(patch).catch((e: unknown) => toast.show({ title: errorMessage(e, 'تعذّر حفظ التفضيل.'), tone: 'warning' }));
  };
  const onChoice = (v: ModelEffortValue) => {
    setChoice(v);
    savePrefs({ model: v.model as ChatModelId | null, effort: v.effort as ChatEffort | null });
  };

  // ── message actions ──
  const copy = async (m: ChatMessageView) => {
    try {
      await navigator.clipboard.writeText(plainOf(m));
      toast.show({ title: 'نُسخ النص.', tone: 'success' });
    } catch {
      toast.show({ title: 'تعذّر النسخ إلى الحافظة.', tone: 'warning' });
    }
  };
  const saveNote = async (m: ChatMessageView) => {
    try {
      const r = await studybookApi.saveAsNote(m.id, newId());
      setSaved((s) => ({ ...s, [m.id]: true }));
      toast.show({ title: r.result === 'duplicate' ? 'هذه الإجابة محفوظة مسبقًا في ملاحظاتي.' : 'حُفظت الإجابة في «ملاحظاتي» موسومةً بأنها مولَّدة، مع سؤالها وأدلتها.', tone: 'success' });
      void getSyncEngine().syncNow();
    } catch (e) {
      toast.show({ title: errorMessage(e, 'تعذّر حفظ الإجابة كملاحظة.'), tone: 'danger' });
    }
  };
  const regenerate = (t: Turn) => {
    const ctx = t.question.context ?? null;
    void send(plainOf(t.question), { replaceFrom: t.id, context: ctx, pageIndex: t.question.page_indexes?.[0] ?? null });
  };
  const edit = (t: Turn) => {
    setEditing(t.id);
    setText(plainOf(t.question));
    composer.current?.focus();
  };
  const newChat = () => {
    abortRef.current?.abort();
    setActive(null);
    setEditing(null);
    setText('');
    autoAsked.current.clear();
    if (layout !== 'full') setHistoryOpen(false);
    composer.current?.focus();
  };

  const scopeMismatch = active && p.scope && !threadMatchesScope(active.thread, p.scope);
  const canStart = !!p.scope || !!active;
  const disabledReason = !p.gate.available ? p.gate.reason : !p.online ? 'تحتاج المحادثة اتصالًا بالخادم.' : !canStart ? 'افتح محاضرة لتبدأ محادثة جديدة عنها، أو افتح محادثة محفوظة.' : null;

  const history = (
    <ChatHistory
      threads={threads}
      activeId={active?.thread.id ?? null}
      filter={filter}
      onFilter={p.sourceId ? setFilter : undefined}
      query={query}
      onQuery={setQuery}
      onOpen={(id) => void open(id)}
      onNew={newChat}
      onRename={async (id, title) => {
        try {
          const r = await chatApi.rename(id, title);
          setThreads((ts) => ts?.map((x) => (x.id === id ? r.thread : x)) ?? ts);
          if (active?.thread.id === id) setActive({ ...active, thread: r.thread });
        } catch (e) {
          toast.show({ title: errorMessage(e, 'تعذّرت إعادة التسمية.'), tone: 'danger' });
        }
      }}
      onDelete={async (id) => {
        await chatApi.remove(id);
        setThreads((ts) => ts?.filter((x) => x.id !== id) ?? ts);
        if (active?.thread.id === id) setActive(null);
        toast.show({ title: 'حُذفت المحادثة.', tone: 'success' });
      }}
      now={p.now?.()}
    />
  );

  return (
    <section className="ch" data-layout={layout} aria-label="المحادثة الدراسية">
      <header className="ch-head">
        <IconButton size="sm" variant="plain" label={historyOpen ? 'أخفِ المحادثات المحفوظة' : 'المحادثات المحفوظة'} icon={<History size={16} />} pressed={historyOpen} onClick={() => setHistoryOpen((v) => !v)} />
        <MixedText as="span" className="ch-head__title" text={active?.thread.title ?? (p.sourceTitle ? `محادثة جديدة — ${p.sourceTitle}` : 'محادثة جديدة')} />
        {active && <ScopeBadge className="ch-scope-badge" scope={active.thread.scope} />}
        <IconButton size="sm" variant="plain" label="محادثة جديدة" icon={<MessageSquarePlus size={16} />} onClick={newChat} />
        {p.headerActions}
      </header>
      {p.onJumpToPage && (
        <div className="ch-syncbar">
          <Switch checked={prefs?.prefs.sync_pages ?? true} onCheckedChange={(v) => savePrefs({ sync_pages: v })} label="مزامنة الصفحات" description="الشرح يتبع الصفحة التي تقرؤها، والصفحة تتبع الشرح." />
          <Switch checked={autoOn} disabled={!syncOn} onCheckedChange={(v) => savePrefs({ auto_explain: v })} label="اشرح هذه الصفحة تلقائيًا" description="عند الوصول إلى صفحة لم تُشرح بعد (مرة واحدة لكل صفحة، ضمن رصيدك)." />
        </div>
      )}
      <div className="ch-body">
        {historyOpen && <aside className="ch-body__history">{history}</aside>}
        <div className="ch-main">
          <div ref={listRef} className="ch-thread" onScroll={onThreadScroll} tabIndex={0} aria-label="الرسائل">
            {!active && !pending && !skillPending ? (
              <div className="ch-empty">
                <p className="ch-empty__title">بماذا أساعدك في هذه المحاضرة؟</p>
                <p className="ch-muted">كل إجابة تُبنى من مصادرك ويُتحقق من كل جملة طبية فيها قبل اعتمادها؛ تُحذف الجمل غير المدعومة.</p>
                {!p.skills && <div className="ch-suggest" role="group" aria-label="اقتراحات">
                  {SUGGESTIONS.filter((s) => !s.page || !!page).map((s) => (
                    <Button
                      key={s.label}
                      size="sm"
                      variant="secondary"
                      disabled={!!disabledReason}
                      onClick={() => {
                        setKindNext(s.kind);
                        if (s.send) void send(s.text, { kind: s.kind, withPage: s.page });
                        else {
                          setText(s.text);
                          composer.current?.focus();
                        }
                      }}
                    >
                      {s.label}
                    </Button>
                  ))}
                </div>}
                {p.skills && <p className="ch-muted">اختر مهارة تحت، أو اكتب / في مربع الرسالة: شرح، تلخيص، أسئلة MCQ، حالة، مقارنة، بطاقات…</p>}
              </div>
            ) : (
              <ChatTurns
                turns={shownTurns}
                pending={pending}
                outcomes={outcomes}
                saved={saved}
                pageLabel={labelOf}
                onJump={p.onJumpToPage ? jumpReader : p.onOpenSourcePage && active?.thread.source_id ? (i) => p.onOpenSourcePage!(active.thread.source_id!, i) : undefined}
                onCopy={(m) => void copy(m)}
                onRegenerate={regenerate}
                onEdit={edit}
                onSaveNote={(m) => void saveNote(m)}
                onWidenScope={(wider, t) => {
                  // explicit owner action: the panel's lock becomes the wider one, the question is asked again under it
                  p.onScopeChange?.(wider);
                  void send(plainOf(t.question), { context: t.question.context ?? null, scope: wider, pageIndex: t.question.page_indexes?.[0] ?? null });
                }}
                onStop={stop}
                busy={busy}
                renderCard={
                  cardCtx
                    ? (t) =>
                        t.answer?.attachment ? (
                          <ChatCard messageId={t.answer.id} attachment={t.answer.attachment} thread={active?.thread ?? null} ctx={cardCtx} onSkill={p.skills ? (id, input) => void runSkill(id, input) : undefined} />
                        ) : null
                    : undefined
                }
              />
            )}
            {skillPending && (
              <article className="ch-turn ch-turn--pending" data-pending="true" aria-label="طلبك قيد التنفيذ">
                <div className="ch-msg ch-msg--owner">
                  <div className="ch-bubble">{skillPending.text}</div>
                </div>
                <div className="ch-msg ch-msg--assistant ch-skill-pending">
                  <LoadingState inline stage={skillPending.stage} />
                  <Button size="sm" variant="plain" onClick={stopSkill}>
                    أوقف
                  </Button>
                </div>
              </article>
            )}
            {scopeMismatch && <p className="ch-muted" role="note">هذه المحادثة مقفلة على نطاق مصادر آخر؛ رسالتك التالية تبدأ محادثة جديدة بالنطاق المختار.</p>}
            {error && <ErrorState inline message={error.message} onRetry={error.retry ?? undefined} />}
          </div>
          {editing && (
            <p className="ch-editing" role="status">
              تعدّل آخر سؤال؛ تُستبدل إجابته عند الإرسال.{' '}
              <Button size="sm" variant="plain" onClick={() => { setEditing(null); setText(''); }}>
                إلغاء التعديل
              </Button>
            </p>
          )}
          {p.skills && (
            <SkillBar items={p.skills.items} busy={busy} formFor={skillForm} onForm={setSkillForm} onRun={(id, input) => void runSkill(id, input)} compareSeed={p.skills.compareSeed} />
          )}
          <Composer
            ref={composer}
            value={text}
            onChange={setText}
            menu={slashMenu}
            onMenuKey={p.skills ? onMenuKey : undefined}
            menuProps={p.skills ? { 'aria-controls': slashOpen ? menuId : undefined, 'aria-activedescendant': slashOpen ? `${menuId}-${slashItems[activeIdx]!.def.id}` : undefined, 'aria-expanded': slashOpen } : undefined}
            onSend={() => void send(text, editing ? { replaceFrom: editing, context: turns.find((t) => t.id === editing)?.question.context ?? null, pageIndex: turns.find((t) => t.id === editing)?.question.page_indexes?.[0] ?? null } : {})}
            onStop={stop}
            streaming={pending !== null}
            disabled={!!disabledReason}
            disabledReason={disabledReason}
            chips={chips}
            onRemoveChip={(k) => (k === 'page' ? setAttachPage(false) : setSelDismissed(selKey))}
            attachActions={
              page && !attachPage ? (
                <IconButton size="sm" variant="plain" label="أرفق الصفحة الحالية" icon={<Paperclip size={14} />} onClick={() => setAttachPage(true)} />
              ) : null
            }
            picker={
              <ModelEffortMenu
                value={choice}
                onChange={onChoice}
                available={prefs?.available_models ?? []}
                defaults={prefs?.defaults ?? { model: null, effort: 'high' }}
                disabled={busy}
              />
            }
          />
        </div>
      </div>
      <div className="ml-visually-hidden" role="status" aria-live="polite">
        {announce}
      </div>
    </section>
  );
}
