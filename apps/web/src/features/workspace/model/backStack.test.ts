import { describe, expect, it } from 'vitest';
import { BACK_STACK_MAX, loadBackStack, popBack, pushBack, saveBackStack, samePlace, type BackEntry, type ReaderPosition } from './backStack';

const pos = (p: Partial<ReaderPosition> = {}): ReaderPosition => ({ sourceId: 'S1', versionId: 'V1', pageIndex: 3, pageOffset: 0.4, zoom: 1.25, fit: null, rotation: 90, layout: 'continuous', ...p });
const entry = (p: Partial<ReaderPosition> = {}, label = 'ص 14 — محاضرة'): BackEntry => ({ position: pos(p), label, createdAt: 1 });

describe('Source Jump & Back (§11)', () => {
  it('returns to exactly the recorded position: page, offset, zoom, rotation, layout', () => {
    const s1 = pushBack([], entry());
    const { entry: back, stack } = popBack(s1);
    expect(back?.position).toEqual(pos());
    expect(stack).toEqual([]);
  });
  it('is a stack: the latest jump is undone first', () => {
    let s = pushBack([], entry({ pageIndex: 1 }, 'a'));
    s = pushBack(s, entry({ pageIndex: 7 }, 'b'));
    expect(popBack(s).entry?.label).toBe('b');
    expect(popBack(popBack(s).stack).entry?.label).toBe('a');
    expect(popBack([]).entry).toBeNull();
  });
  it('records two jumps from the same place once (the newest wins)', () => {
    let s = pushBack([], entry({}, 'first'));
    s = pushBack(s, entry({ pageOffset: 0.41 }, 'second'));
    expect(s).toHaveLength(1);
    expect(s[0]!.label).toBe('second');
    expect(samePlace(pos(), pos({ pageOffset: 0.5 }))).toBe(false);
    expect(samePlace(pos(), pos({ versionId: 'V2' }))).toBe(false);
  });
  it('keeps at most BACK_STACK_MAX entries (oldest dropped)', () => {
    let s: BackEntry[] = [];
    for (let i = 0; i < BACK_STACK_MAX + 5; i++) s = pushBack(s, entry({ pageIndex: i }, String(i)));
    expect(s).toHaveLength(BACK_STACK_MAX);
    expect(s[0]!.label).toBe('5');
  });
  it('survives a route change through sessionStorage (cross-source jumps)', () => {
    const s = pushBack([], entry({ sourceId: 'S9' }));
    saveBackStack(s);
    expect(loadBackStack()).toEqual(s);
    sessionStorage.setItem('medlevo.workspace.back.v1', '{broken');
    expect(loadBackStack()).toEqual([]);
  });
});

describe('Back from page links and note pages (track F1, §26)', () => {
  it('a note page inserted after a source page is its own place: jumping from it and from the page before it records both', () => {
    let s = pushBack([], entry({ pageIndex: 3 }, 'ص 14'));
    s = pushBack(s, entry({ pageIndex: 3, notePageId: 'NP1' }, 'صفحة ملاحظات بعد ص 14'));
    expect(s.map((e) => e.label)).toEqual(['ص 14', 'صفحة ملاحظات بعد ص 14']);
    expect(samePlace(pos({ notePageId: 'NP1' }), pos({ notePageId: 'NP2' }))).toBe(false);
    expect(samePlace(pos({ notePageId: null }), pos())).toBe(true);
    // going back restores the note page and the offset inside it
    expect(popBack(s).entry?.position).toMatchObject({ pageIndex: 3, notePageId: 'NP1', pageOffset: 0.4 });
  });
  it('an entry from a notebook page carries its route; the same position in another route is another place', () => {
    const notebook = (page: string, label: string): BackEntry => ({ ...entry({ sourceId: 'notebook:N1', notePageId: page }, label), route: `/notebook/N1?page=${page}` });
    let s = pushBack([], notebook('A', 'الصفحة 1'));
    s = pushBack(s, notebook('A', 'الصفحة 1 (مكرر)'));
    expect(s).toHaveLength(1);
    s = pushBack(s, { ...notebook('A', 'نفس الموضع من مسار آخر'), route: '/notebook/N2?page=A' });
    expect(s).toHaveLength(2);
    saveBackStack(s);
    expect(loadBackStack().map((e) => e.route)).toEqual(['/notebook/N1?page=A', '/notebook/N2?page=A']);
  });
});
