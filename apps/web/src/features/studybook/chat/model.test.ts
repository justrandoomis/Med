// Pure logic of the study chat: history groups, turns + page tags, reader ↔ chat page sync in both directions, the
// feedback-loop guard, the auto-explain decision, and the safe markdown parser.
import { describe, expect, it } from 'vitest';
import type { ChatMessageView, ChatThreadView } from '@medlevo/shared';
import { parseInline, parseMarkdown } from './Markdown';
import { groupThreads, pageDividers, pageForTurn, PageSyncGuard, readerTargetForAnswer, shouldAutoExplain, topTurn, turnForPage, turnsOf } from './model';

const NOW = new Date(2026, 10, 22, 15, 0, 0).getTime();
const DAY = 24 * 3600 * 1000;
const th = (id: string, updated_at: number) => ({ id, updated_at, title: id }) as unknown as ChatThreadView;
const q = (id: string, pages: number[] = []) => ({ id, role: 'owner', status: 'final', page_indexes: pages, content: { v: 1, paragraphs: [] }, reply_to_id: null }) as unknown as ChatMessageView;
const a = (id: string, replyTo: string, pages: number[] = []) => ({ id, role: 'assistant', status: 'final', page_indexes: pages, content: { v: 1, paragraphs: [] }, reply_to_id: replyTo }) as unknown as ChatMessageView;

describe('history groups', () => {
  it('groups by the device’s day, newest first, empty groups dropped', () => {
    const g = groupThreads([th('old', NOW - 90 * DAY), th('t1', NOW - 3600_000), th('y', NOW - DAY), th('w', NOW - 4 * DAY), th('t2', NOW - 60_000), th('m', NOW - 20 * DAY)], NOW);
    expect(g.map((x) => x.label)).toEqual(['اليوم', 'أمس', 'آخر 7 أيام', 'آخر 30 يومًا', 'أقدم']);
    expect(g[0]!.threads.map((t) => t.id)).toEqual(['t2', 't1']);
    expect(groupThreads([th('y', NOW - DAY)], NOW).map((x) => x.key)).toEqual(['yesterday']);
    expect(groupThreads([], NOW)).toEqual([]);
  });
});

describe('turns and page tags', () => {
  const msgs = [q('q1', [0]), a('a1', 'q1', [0, 1]), q('q2', [1]), a('a2', 'q2', [1]), q('q3'), a('a3', 'q3', [4, 2]), q('q4', [1]), a('a4', 'q4', [1])];
  const turns = turnsOf(msgs);

  it('a turn = a question + its answer; filed under the attached page, else the first cited page', () => {
    expect(turns.map((t) => [t.id, t.primaryPage, t.pages])).toEqual([
      ['q1', 0, [0, 1]],
      ['q2', 1, [1]],
      ['q3', 2, [2, 4]],
      ['q4', 1, [1]],
    ]);
  });

  it('«صفحة N» dividers open each page section', () => {
    expect([...pageDividers(turns).entries()]).toEqual([
      ['q1', 0],
      ['q2', 1],
      ['q3', 2],
      ['q4', 1],
    ]);
    // consecutive turns on the same page share one divider
    expect([...pageDividers(turnsOf([q('x', [3]), a('xa', 'x', [3]), q('y', [3]), a('ya', 'y', [3])])).keys()]).toEqual(['x']);
  });

  it('reader → chat: the latest turn FILED under the page, else the latest that cites it, else nothing', () => {
    expect(turnForPage(1, turns)).toBe('q4');
    expect(turnForPage(4, turns)).toBe('q3');
    expect(turnForPage(0, turns)).toBe('q1');
    expect(turnForPage(9, turns)).toBeNull();
  });

  it('chat → reader: a turn stands for its primary page; an answer moves the reader only when the visible page is not explained', () => {
    expect(pageForTurn('q3', turns)).toBe(2);
    expect(pageForTurn('nope', turns)).toBeNull();
    expect(readerTargetForAnswer([1, 2], 2)).toBeNull();
    expect(readerTargetForAnswer([3, 1], 0)).toBe(1);
    expect(readerTargetForAnswer([], 0)).toBeNull();
    expect(readerTargetForAnswer([5], null)).toBe(5);
  });

  it('the turn at the top of the chat viewport', () => {
    const tops = [
      { id: 'a', top: -400 },
      { id: 'b', top: 20 },
      { id: 'c', top: 300 },
    ];
    expect(topTurn(tops, 48)).toBe('b');
    expect(topTurn([{ id: 'a', top: 100 }], 48)).toBe('a');
    expect(topTurn([], 48)).toBeNull();
  });
});

describe('no scroll feedback loop', () => {
  it('a move one side makes is not followed back from the other side within the window; the person’s next move is', () => {
    let now = 1000;
    const g = new PageSyncGuard(900, () => now);
    expect(g.followReader()).toBe(true);
    expect(g.followChat()).toBe(true);
    // the chat moves the reader → the reader's page report (and intermediate pages) are its echo
    g.movingReader();
    now += 50;
    expect(g.followReader()).toBe(false);
    expect(g.followChat()).toBe(true);
    now += 900;
    expect(g.followReader()).toBe(true);
    // the reader scrolls the chat → the chat's scroll events are its echo
    g.movingChat();
    now += 100;
    expect(g.followChat()).toBe(false);
    now += 900;
    expect(g.followChat()).toBe(true);
  });

  it('simulated ping-pong: reader page → chat scroll → (echo ignored) → no reader move', () => {
    let now = 0;
    const g = new PageSyncGuard(900, () => now);
    const turns = turnsOf([q('p1', [1]), a('a1', 'p1', [1]), q('p2', [2]), a('a2', 'p2', [2])]);
    const readerMoves: number[] = [];
    const chatScrolls: string[] = [];
    const onReaderPage = (page: number) => {
      if (!g.followReader()) return;
      const id = turnForPage(page, turns);
      if (id) {
        g.movingChat();
        chatScrolls.push(id);
      }
    };
    const onChatTop = (id: string, visible: number) => {
      if (!g.followChat()) return;
      const p = pageForTurn(id, turns);
      if (p !== null && p !== visible) {
        g.movingReader();
        readerMoves.push(p);
      }
    };
    onReaderPage(2); // the person reads page 2
    now += 180;
    onChatTop('p1', 2); // the smooth scroll passes p1 first — an echo, ignored
    now += 200;
    onChatTop('p2', 2);
    expect(chatScrolls).toEqual(['p2']);
    expect(readerMoves).toEqual([]);
    // later the person scrolls the chat up to page 1's section → the reader follows once, and its report is not echoed
    now += 2000;
    onChatTop('p1', 2);
    now += 50;
    onReaderPage(1);
    expect(readerMoves).toEqual([1]);
    expect(chatScrolls).toEqual(['p2']);
  });
});

describe('«اشرح هذه الصفحة تلقائيًا»', () => {
  const base = { enabled: true, sync: true, page: 3, hasTurn: false, asked: new Set<number>(), busy: false, available: true, online: true };
  it('asks only when everything allows it, once per page', () => {
    expect(shouldAutoExplain(base)).toBe(true);
    expect(shouldAutoExplain({ ...base, enabled: false })).toBe(false);
    expect(shouldAutoExplain({ ...base, sync: false })).toBe(false);
    expect(shouldAutoExplain({ ...base, hasTurn: true })).toBe(false);
    expect(shouldAutoExplain({ ...base, asked: new Set([3]) })).toBe(false);
    expect(shouldAutoExplain({ ...base, busy: true })).toBe(false);
    expect(shouldAutoExplain({ ...base, available: false })).toBe(false); // no allowance / not configured
    expect(shouldAutoExplain({ ...base, online: false })).toBe(false);
    expect(shouldAutoExplain({ ...base, page: null })).toBe(false);
  });
});

describe('safe markdown', () => {
  it('blocks: headings, lists, tables, code, quotes, paragraphs (an unfinished draft parses as far as it goes)', () => {
    const md = '## التشخيص\n\nنص **مهم** عن CT.\n\n- أول\n- ثانٍ\n\n1. a\n2. b\n\n| الفحص | الاستخدام |\n|---|---|\n| US | الأطفال |\n\n```\ncode line\n```\n> اقتباس\n\n```js\nunfinished';
    const b = parseMarkdown(md);
    expect(b.map((x) => x.kind)).toEqual(['heading', 'paragraph', 'list', 'list', 'table', 'code', 'quote', 'code']);
    expect(b[2]).toEqual({ kind: 'list', ordered: false, items: ['أول', 'ثانٍ'] });
    expect(b[3]).toMatchObject({ ordered: true, items: ['a', 'b'] });
    expect(b[4]).toEqual({ kind: 'table', header: ['الفحص', 'الاستخدام'], rows: [['US', 'الأطفال']] });
    expect(b[7]).toEqual({ kind: 'code', text: 'unfinished', lang: 'js' });
  });

  it('inline: code first (no marks inside), bold, italic; snake_case and 2*3*4 are not italic', () => {
    expect(parseInline('a **b** `**c**` *d*')).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'bold', text: 'b' },
      { kind: 'text', text: ' ' },
      { kind: 'code', text: '**c**' },
      { kind: 'text', text: ' ' },
      { kind: 'italic', text: 'd' },
    ]);
    expect(parseInline('snake_case_name and 2*3*4')).toEqual([{ kind: 'text', text: 'snake_case_name and 2*3*4' }]);
  });
});
