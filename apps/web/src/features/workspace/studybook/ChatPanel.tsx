// Contextual chat in the rail (§30): threads per page, each bound to its selection, version and Source Lock.
// (Round 7 H4) While the model writes, its text streams as a draft labelled «مسودة لم تُتحقق بعد» (never stored, never
// cited, «أوقف» cancels it); the answer that is kept is only the verified one, and sentences verification removed
// from the draft are listed as removed. Abstentions say why and offer an
// explicit wider scope (a NEW thread — a thread never carries assumptions into another scope or lecture).
// A verified answer can be saved as a note: it stays labelled generated (§28).
import { useCallback, useEffect, useRef, useState } from 'react';
import { MessageSquarePlus, NotebookPen, Send } from 'lucide-react';
import {
  ANSWER_STYLE_LABELS_AR,
  newId,
  type AnswerStyle,
  type ChatMessageView,
  type ChatThreadResponse,
  type ChatThreadView,
  type SelectionAnchor,
  type SourcePageView,
  type SourceScope,
} from '@medlevo/shared';
import { Button, ErrorState, RichTextView, Skeleton, StatusPill, Switch, TextArea, useToast } from '../../../design';
import { errorMessage } from '../../../lib/api';
import type { FeatureGateState } from '../../../lib/capabilities';
import { getSyncEngine } from '../../../lib/sync';
import { ArtifactContent, BidiText, ScopeBadge } from '../../evidence';
import { studybookApi } from '../../studybook/api';
import { shortQuote, threadMatchesScope } from '../../studybook/model';
import { DraftOutcome, EMPTY_STREAM, reduceStream, StreamDraft, type StreamView } from '../../studybook/streaming';

export interface ChatPanelProps {
  sourceId: string;
  page: SourcePageView | null;
  /** the selection the next new thread is bound to (null → the page) */
  anchor: SelectionAnchor | null;
  anchorText: string | null;
  scope: SourceScope;
  style: AnswerStyle;
  gate: FeatureGateState;
  online: boolean;
  /** bump to focus the composer (Ask from the selection toolbar) */
  focusKey: number;
  /** (track F4) text put in the composer with the focus bump (the owner reviews and sends it) */
  prefill?: string | null;
  /** the owner explicitly widened the lock from an abstention: the rail's lock follows (G2 / AC-05) */
  onScopeChange?: (scope: SourceScope) => void;
}

const DRAFT_LABEL: Partial<Record<ChatMessageView['status'], string>> = {
  draft: 'تُكتب الإجابة — لا يُعتمد منها إلا ما يجتاز التحقق',
  verifying: 'يُتحقق من الإجابة جملةً جملة',
  rejected: 'تعذّر إكمال هذه الإجابة؛ لم يُعرض أي جزء منها',
};

export function ChatPanel({ sourceId, page, anchor, anchorText, scope, style, gate, online, focusKey, prefill, onScopeChange }: ChatPanelProps) {
  const toast = useToast();
  const [threads, setThreads] = useState<ChatThreadView[] | null>(null);
  const [active, setActive] = useState<ChatThreadResponse | null>(null);
  const [text, setText] = useState('');
  const [socratic, setSocratic] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<Record<string, boolean>>({});
  // (Round 7 H4) the live draft of the answer being written, and what verification removed from it
  const [stream, setStream] = useState<StreamView | null>(null);
  const [outcome, setOutcome] = useState<{ messageId: string; hadDraft: boolean; removed: Array<{ text: string; reason_ar: string }> } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const pageId = page?.id ?? null;
  const anchorKey = anchor ? `${anchor.page_id}|${anchor.quote?.exact ?? ''}|${(anchor.region_ids ?? []).join(',')}` : `page:${pageId}`;

  // state is set only when the request settles (no synchronous setState on the effect path)
  const loadThreads = useCallback((): Promise<void> => {
    if (!online) return Promise.resolve();
    return studybookApi
      .threads(sourceId, pageId)
      .then((r) => setThreads(r.threads))
      .catch((e: unknown) => setError(errorMessage(e, 'تعذّر تحميل المحادثات.')));
  }, [sourceId, pageId, online]);

  // The resets below are made while rendering (React's «adjust state when a prop changes»), not in effects:
  //  * another page / connectivity: the thread list is loaded afresh (the request runs in the effect)
  //  * a new selection starts a new conversation (never continues another passage's thread silently)
  //  * G2 / AC-05: a changed Source Lock in the rail starts a new conversation — a question is never sent to a thread
  //    pinned to another (e.g. wider) lock than the one the rail shows
  const scopeKey = JSON.stringify([scope.mode, scope.lecture_source_id ?? null, [...scope.reference_source_ids].sort(), scope.include_my_notes]);
  const listKey = `${online}|${sourceId}|${pageId ?? ''}`;
  const [shownFor, setShownFor] = useState({ listKey, anchorKey, scopeKey });
  if (shownFor.listKey !== listKey || shownFor.anchorKey !== anchorKey || shownFor.scopeKey !== scopeKey) {
    setShownFor({ listKey, anchorKey, scopeKey });
    if (shownFor.listKey !== listKey || shownFor.anchorKey !== anchorKey) setActive(null);
    else if (active && !threadMatchesScope(active.thread, scope)) setActive(null);
  }
  useEffect(() => {
    void loadThreads();
  }, [loadThreads]);

  // a composed question handed over (focusKey bumped) joins the draft while rendering; the composer is focused in the
  // effect. `null` = not seen yet, so a panel opened with a question takes it too.
  const [takenFocusKey, setTakenFocusKey] = useState<number | null>(null);
  if (takenFocusKey !== focusKey) {
    setTakenFocusKey(focusKey);
    // (track F4) the composed question joins an unsent draft instead of replacing it (the owner's words are kept)
    if (focusKey > 0 && prefill) setText((t) => (t.trim() && t.trim() !== prefill.trim() ? `${t.trimEnd()}\n\n${prefill}` : prefill));
  }
  useEffect(() => {
    if (focusKey > 0) composer.current?.focus();
  }, [focusKey]);

  const open = async (id: string) => {
    try {
      setActive(await studybookApi.thread(id));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const send = async (question: string, opts: { scope?: SourceScope; forceNew?: boolean } = {}) => {
    const q = question.trim();
    if (!q) return;
    setSending(true);
    setError(null);
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    let threadId: string | null = null;
    try {
      let thread = active?.thread ?? null;
      const lock = opts.scope ?? scope;
      // only ever continue a thread whose pinned lock is the one in force (an opened older thread with another
      // lock is shown, but the next question starts a new conversation under the rail's lock)
      if (!thread || opts.forceNew || !threadMatchesScope(thread, lock)) {
        const created = await studybookApi.createThread({ anchor: anchor ?? (page ? { source_id: sourceId, version_id: page.version_id, page_id: page.id, region_ids: [] } : null), scope: lock, style, socratic });
        thread = created.thread;
        setActive(created);
      }
      threadId = thread.id;
      // the draft streams labelled as unverified; the answer that is kept arrives only when verified
      setStream(EMPTY_STREAM);
      setOutcome(null);
      const { result: res, removed, hadDraft } = await studybookApi.askStream(thread.id, q, style, {
        signal: ac.signal,
        onEvent: (e) => {
          if (!ac.signal.aborted) setStream((v) => reduceStream(v ?? EMPTY_STREAM, e));
        },
      });
      setStream(null);
      setOutcome({ messageId: res.answer.id, hadDraft, removed });
      setText('');
      setActive(await studybookApi.thread(thread.id));
      void loadThreads();
      if (res.answer.status === 'abstained') toast.show({ title: 'لم تُكتب إجابة: السبب معروض تحت السؤال.', tone: 'info' });
    } catch (e) {
      setStream(null);
      if (ac.signal.aborted) {
        toast.show({ title: 'أوقفتَ الإجابة؛ لم يُحفظ منها شيء.', tone: 'info' });
        if (threadId) void open(threadId);
        return;
      }
      setError(errorMessage(e, 'تعذّر إرسال السؤال.'));
      if (threadId ?? active?.thread) void open((threadId ?? active?.thread.id)!);
    } finally {
      setSending(false);
    }
  };
  useEffect(() => () => abortRef.current?.abort(), []);

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

  const lastQuestion = (m: ChatMessageView) => {
    const q = active?.messages.find((x) => x.id === m.reply_to_id);
    return q ? q.content.paragraphs.map((p) => p.runs.map((r) => r.t).join('')).join('\n') : '';
  };

  const composerId = 'sb-chat-composer';
  const reasonId = 'sb-chat-reason';
  return (
    <div className="sb-chat">
      {anchorText ? (
        <p className="sb-muted">
          تُربط المحادثة الجديدة بالتحديد: <BidiText as="span" className="sb-quote" text={shortQuote(anchorText, 120)} />
        </p>
      ) : (
        <p className="sb-muted">تُربط المحادثة بهذه الصفحة ونسختها ونطاق المصادر المختار؛ لا تنتقل افتراضاتها إلى محاضرة أخرى.</p>
      )}

      {threads === null && online && <Skeleton lines={2} />}
      {threads && threads.length > 0 && (
        <details className="sb-threads" open={!active}>
          <summary>{`محادثات هذه الصفحة (${threads.length})`}</summary>
          <ul role="list">
            {threads.map((t) => (
              <li key={t.id}>
                <Button size="sm" variant={active?.thread.id === t.id ? 'secondary' : 'plain'} onClick={() => void open(t.id)} aria-current={active?.thread.id === t.id ? 'true' : undefined}>
                  {t.title ?? 'محادثة'}
                </Button>
                {t.last_message_preview && <span className="sb-muted">{shortQuote(t.last_message_preview, 80)}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}

      {active && (
        <div className="sb-messages" aria-live="polite">
          <div className="sb-row">
            <BidiText as="span" className="sb-thread-title" text={shortQuote(active.thread.title ?? 'محادثة', 140)} />
            <ScopeBadge scope={active.thread.scope} />
            {active.thread.socratic && <StatusPill tone="info">وضع سقراطي</StatusPill>}
            <Button size="sm" variant="plain" icon={<MessageSquarePlus size={14} />} onClick={() => setActive(null)}>
              محادثة جديدة
            </Button>
          </div>
          {!threadMatchesScope(active.thread, scope) && (
            <p className="sb-muted" role="note">
              هذه المحادثة مقفلة على نطاقها المعروض أعلاه؛ سؤالك التالي يبدأ محادثة جديدة بنطاق المصادر المختار في اللوحة.
            </p>
          )}
          {active.messages.map((m) =>
            m.role === 'owner' ? (
              <div key={m.id} className="sb-msg sb-msg--owner">
                <span className="ml-visually-hidden">سؤالك: </span>
                <RichTextView value={m.content} />
              </div>
            ) : (
              <div key={m.id} className="sb-msg sb-msg--assistant">
                {outcome?.messageId === m.id && <DraftOutcome hadDraft={outcome.hadDraft} removed={outcome.removed} />}
                {m.status === 'final' || m.status === 'abstained' ? (
                  m.artifact ? (
                    <ArtifactContent
                      artifact={m.artifact}
                      showRibbon={false}
                      onWidenScope={(wider) => {
                        // explicit owner action: the rail's lock becomes the wider one, then the question is re-asked
                        onScopeChange?.(wider);
                        void send(lastQuestion(m), { scope: wider, forceNew: true });
                      }}
                    />
                  ) : (
                    <RichTextView value={m.content} />
                  )
                ) : (
                  <StatusPill tone={m.status === 'rejected' ? 'danger' : 'info'}>{DRAFT_LABEL[m.status] ?? m.status}</StatusPill>
                )}
                {m.status === 'final' && (
                  <Button size="sm" variant="plain" icon={<NotebookPen size={14} />} disabled={saved[m.id]} onClick={() => void saveNote(m)}>
                    {saved[m.id] ? 'حُفظت في ملاحظاتي' : 'احفظ الإجابة كملاحظة'}
                  </Button>
                )}
              </div>
            ),
          )}
        </div>
      )}

      {stream && (
        <StreamDraft
          view={stream}
          actions={
            <Button size="sm" variant="plain" onClick={() => abortRef.current?.abort()}>
              أوقف
            </Button>
          }
        />
      )}

      <form
        className="sb-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send(text);
        }}
      >
        <TextArea
          id={composerId}
          ref={composer}
          label="سؤالك عن هذا الموضع"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          disabled={!gate.available || sending}
          aria-describedby={!gate.available ? reasonId : undefined}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void send(text);
            }
          }}
        />
        {!active && <Switch checked={socratic} onCheckedChange={setSocratic} label="وضع سقراطي" description="تلميح ثم سؤال موجّه بدل كشف الجواب فورًا." />}
        <div className="sb-row">
          <Button type="submit" variant="primary" icon={<Send size={16} />} loading={sending} loadingLabel="يُبحث في المصادر ثم يُتحقق…" disabled={!gate.available || !text.trim()}>
            اسأل
          </Button>
          <span className="sb-muted">{`نمط الرد: ${ANSWER_STYLE_LABELS_AR[style]}`}</span>
        </div>
        {!gate.available && (
          <p id={reasonId} className="sb-reason" role="note">
            {gate.reason}
          </p>
        )}
      </form>
      {error && <ErrorState inline message={error} />}
    </div>
  );
}
