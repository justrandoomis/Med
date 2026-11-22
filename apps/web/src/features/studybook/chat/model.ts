// Pure logic of the Claude-style study chat: history grouping (ChatGPT-like «اليوم، أمس، آخر 7 أيام…»), turns and their
// page tags, the reader ↔ chat page sync (both directions) with a guard against scroll feedback loops, and the
// «اشرح هذه الصفحة تلقائيًا» decision. No React, no DOM — unit-tested on its own (chat/model.test.ts).
import type { ChatMessageView, ChatThreadView } from '@medlevo/shared';

// ───────── history grouping ─────────
export interface HistoryGroup {
  key: 'today' | 'yesterday' | 'week' | 'month' | 'older';
  label: string;
  threads: ChatThreadView[];
}

const GROUP_LABELS: Record<HistoryGroup['key'], string> = {
  today: 'اليوم',
  yesterday: 'أمس',
  week: 'آخر 7 أيام',
  month: 'آخر 30 يومًا',
  older: 'أقدم',
};

/** Local midnight of `t` (the owner's day, as the device sees it). */
function dayStart(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Threads (any order) → non-empty groups, most recent first; inside a group newest first. */
export function groupThreads(threads: ChatThreadView[], now: number): HistoryGroup[] {
  const today = dayStart(now);
  const DAY = 24 * 60 * 60 * 1000;
  const keyOf = (t: number): HistoryGroup['key'] => {
    if (t >= today) return 'today';
    if (t >= today - DAY) return 'yesterday';
    if (t >= today - 7 * DAY) return 'week';
    if (t >= today - 30 * DAY) return 'month';
    return 'older';
  };
  const order: HistoryGroup['key'][] = ['today', 'yesterday', 'week', 'month', 'older'];
  const sorted = [...threads].sort((a, b) => b.updated_at - a.updated_at || (a.id < b.id ? 1 : -1));
  return order
    .map((key) => ({ key, label: GROUP_LABELS[key], threads: sorted.filter((t) => keyOf(t.updated_at) === key) }))
    .filter((g) => g.threads.length > 0);
}

// ───────── turns + page tags ─────────
export interface Turn {
  /** the owner message id (the turn's DOM anchor) */
  id: string;
  question: ChatMessageView;
  answer: ChatMessageView | null;
  /** every lecture page the turn is about (attached page + pages the answer explains / cites), sorted */
  pages: number[];
  /** the page the turn is filed under in the thread («صفحة N» divider): the attached page, else the first cited page */
  primaryPage: number | null;
}

export function turnsOf(messages: ChatMessageView[]): Turn[] {
  const turns: Turn[] = [];
  for (const m of messages) {
    if (m.role === 'owner') {
      turns.push({ id: m.id, question: m, answer: null, pages: [], primaryPage: null });
    } else if (m.role === 'assistant') {
      const t = (m.reply_to_id ? turns.find((x) => x.id === m.reply_to_id) : undefined) ?? turns[turns.length - 1];
      if (t) t.answer = m;
    }
  }
  for (const t of turns) {
    const ctx = t.question.page_indexes ?? [];
    const ans = t.answer?.page_indexes ?? [];
    t.pages = [...new Set([...ctx, ...ans])].sort((a, b) => a - b);
    t.primaryPage = ctx.length ? Math.min(...ctx) : ans.length ? Math.min(...ans) : null;
  }
  return turns;
}

/** Turn ids that open a new page section (a «صفحة N» divider before them), with that page. */
export function pageDividers(turns: Turn[]): Map<string, number> {
  const out = new Map<string, number>();
  let prev: number | null = null;
  for (const t of turns) {
    if (t.primaryPage !== null && t.primaryPage !== prev) out.set(t.id, t.primaryPage);
    if (t.primaryPage !== null) prev = t.primaryPage;
  }
  return out;
}

/**
 * Reader → chat: the turn that explains `page` — the latest turn FILED under it (its primary page), else the latest
 * turn that cites it; null when the thread has nothing for that page.
 */
export function turnForPage(page: number, turns: Turn[]): string | null {
  for (let i = turns.length - 1; i >= 0; i--) if (turns[i]!.primaryPage === page) return turns[i]!.id;
  for (let i = turns.length - 1; i >= 0; i--) if (turns[i]!.pages.includes(page)) return turns[i]!.id;
  return null;
}

/** Chat → reader: the page a turn scrolled into view stands for (null: untagged turn, the reader stays). */
export function pageForTurn(turnId: string, turns: Turn[]): number | null {
  return turns.find((t) => t.id === turnId)?.primaryPage ?? null;
}

/**
 * Chat → reader after an answer arrives: the reader moves only when the visible page is not among the pages the
 * answer explains (then to the first of them); never for an answer without page tags.
 */
export function readerTargetForAnswer(pages: number[], visible: number | null): number | null {
  if (!pages.length) return null;
  if (visible !== null && pages.includes(visible)) return null;
  return Math.min(...pages);
}

/** The turn at the top of the chat viewport: the last turn whose top is at or above the probe line. */
export function topTurn(tops: Array<{ id: string; top: number }>, probe: number): string | null {
  let best: string | null = null;
  for (const t of tops) {
    if (t.top <= probe) best = t.id;
    else break;
  }
  return best ?? tops[0]?.id ?? null;
}

// ───────── feedback-loop guard ─────────
/**
 * Each side that moves the OTHER side programmatically marks it; for `windowMs` after that, the other side's position
 * reports are not followed back (the reader reporting the page the chat just sent it to, the chat reporting the turn
 * the reader just scrolled it to, and any intermediate positions of a smooth scroll). A move by the person is followed.
 */
export class PageSyncGuard {
  private readerMovedAt = -Infinity;
  private chatMovedAt = -Infinity;
  constructor(
    private readonly windowMs = 900,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** the chat is about to move the reader */
  movingReader(): void {
    this.readerMovedAt = this.now();
  }
  /** the reader is about to scroll the chat */
  movingChat(): void {
    this.chatMovedAt = this.now();
  }
  /** follow a reader page report into the chat? (false while it is the echo of a chat-driven move) */
  followReader(): boolean {
    return this.now() - this.readerMovedAt >= this.windowMs;
  }
  /** follow a chat scroll into the reader? (false while it is the echo of a reader-driven scroll) */
  followChat(): boolean {
    return this.now() - this.chatMovedAt >= this.windowMs;
  }
}

// ───────── «اشرح هذه الصفحة تلقائيًا» ─────────
export interface AutoExplainInput {
  enabled: boolean;
  sync: boolean;
  page: number | null;
  /** the thread already has a turn for this page */
  hasTurn: boolean;
  /** pages already asked for automatically in this session (never twice) */
  asked: ReadonlySet<number>;
  busy: boolean;
  available: boolean;
  online: boolean;
}

/** Ask for the visible page now? Only when everything allows it — the debounce is the caller's (one page at rest). */
export function shouldAutoExplain(i: AutoExplainInput): boolean {
  return i.enabled && i.sync && i.page !== null && !i.hasTurn && !i.asked.has(i.page) && !i.busy && i.available && i.online;
}

export const AUTO_EXPLAIN_DELAY_MS = 1600;
export const AUTO_EXPLAIN_PROMPT = 'اشرح هذه الصفحة';

// ───────── misc ─────────
export function plainOf(m: ChatMessageView): string {
  return m.content.paragraphs.map((p) => p.runs.map((r) => r.t).join('')).join('\n');
}

/** «ص 3» — the printed page number when known, else the 1-based position. */
export function pageChipLabel(pageIndex: number, labelOf?: (i: number) => string | null): string {
  return `ص ${labelOf?.(pageIndex) ?? String(pageIndex + 1)}`;
}
