// Parity N1 — G14 gestures and G15 selective erasing, through the real input path of <InkLayer> (synthetic pointer
// events) and the real store (IndexedDB + outbox):
//  * a scribble over writing erases the strokes it covers and itself in ONE undo step, announced; on empty paper, or as
//    handwriting, it stays ink; the highlighter never erases; the gesture can be turned off;
//  * circle + hold selects what the loop encloses (the loop is not ink) and Escape returns to the pen;
//  * two-finger double tap = undo, three = redo (fingers only);
//  * the eraser's type filter; text highlights (the reader's) erased as tombstones and restored by undo;
//  * «امسح الصفحة» / «احذف كل … في الدفتر»: the count first, tombstones, one undo step — also after a reload — and
//    «المحذوف بالجملة» restores them.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { annotationTargetKey, DEFAULT_INK_SETTINGS, newId, type AnnotationAnchor, type InkData } from '@medlevo/shared';
import { applyBulk, listTrash, planClearPage, planDeleteByType, restoreTrash } from '../../src/features/workspace/ink/bulk';
import { InkHost } from '../../src/features/workspace/ink/host';
import { setInkSettingsBackend } from '../../src/features/workspace/ink/inkSettings';
import { makeInkItem, type InkItem } from '../../src/features/workspace/ink/model';
import { __resetStores, getDocumentStore } from '../../src/features/workspace/ink/store';
import { getDb } from '../../src/lib/localdb';
import { installSettings, pointer, setupLayer, stroke } from './n1-helpers';

// a real layer and toolbar in jsdom: slow on a loaded machine, never hanging
vi.setConfig({ testTimeout: 20_000 });

const sleep = (ms: number) => act(async () => new Promise((r) => setTimeout(r, ms)));
/** shape enhancement on hold off: a slow test run must not turn a zig-zag into a recognised shape */
const NO_HOLD = { prefs: { shapeRecognition: false } };

beforeEach(() => {
  __resetStores();
  window.localStorage.clear();
  installSettings();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});
afterEach(() => {
  setInkSettingsBackend(null);
  __resetStores();
});

/** a zig-zag across x0..x1 (layer px) drifting down from y0 to y1 — a scratch-out */
function zigzag(x0: number, x1: number, y0: number, y1: number, swings = 9): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  for (let i = 0; i <= swings; i++) pts.push([i % 2 === 0 ? x0 : x1, y0 + ((y1 - y0) * i) / swings]);
  return pts;
}
/** a short handwritten «word»: a wavy line */
function word(x: number, y: number, w = 30): Array<[number, number]> {
  return [
    [x, y],
    [x + w * 0.25, y - 4],
    [x + w * 0.5, y + 3],
    [x + w * 0.75, y - 3],
    [x + w, y + 2],
  ];
}

describe('G14 scribble to erase', () => {
  it('erases the two words it covers and itself, in one undo step («مسح بالخربشة»), and says so', async () => {
    const { root, store, key } = setupLayer('pen', NO_HOLD);
    await waitFor(() => expect(root.getAttribute('data-tool')).toBe('pen'));
    stroke(root, word(190, 160));
    stroke(root, word(230, 160));
    stroke(root, word(100, 500)); // far away: kept
    expect(store.items(key)).toHaveLength(3);
    stroke(root, zigzag(182, 266, 150, 172));
    await sleep(20);
    const left = store.items(key);
    expect(left).toHaveLength(1);
    expect((left[0]!.data as InkData).points[0]![1]).toBeCloseTo(500 / 800, 3);
    expect(store.history.peekUndo()?.label_ar).toBe('مسح بالخربشة');
    await waitFor(() => expect(document.querySelector('[role="status"]')?.textContent).toMatch(/مُسح خطان بالخربشة/));
    // (a stroke written before the page finished loading makes the step check this device's copy first: wait for it)
    await act(async () => {
      store.undo();
      await store.stepSettled();
    });
    // the two words are back; the scribble is not (it was a gesture, not writing)
    expect(store.items(key)).toHaveLength(3);
    await store.flush();
  });

  it('a zig-zag on empty paper stays ink (writing is never lost), and so does handwriting over writing', async () => {
    const { root, store, key } = setupLayer('pen', NO_HOLD);
    await waitFor(() => expect(root.getAttribute('data-tool')).toBe('pen'));
    stroke(root, zigzag(182, 266, 150, 172));
    await sleep(20);
    expect(store.items(key)).toHaveLength(1);
    // «m» written over a word
    stroke(root, word(190, 300));
    stroke(root, [
      [188, 310],
      [188, 290],
      [196, 284],
      [204, 290],
      [204, 310],
      [204, 290],
      [212, 284],
      [220, 290],
      [220, 310],
    ]);
    await sleep(20);
    expect(store.items(key)).toHaveLength(3);
    await store.flush();
  });

  it('the highlighter never erases, and the gesture can be turned off in the settings', async () => {
    const backend = installSettings({ ...DEFAULT_INK_SETTINGS, gestures: { ...DEFAULT_INK_SETTINGS.gestures, scribble_erase: false } });
    const { root, store, key } = setupLayer('pen', NO_HOLD);
    await waitFor(() => expect(root.getAttribute('data-tool')).toBe('pen'));
    stroke(root, word(190, 160));
    stroke(root, word(230, 160));
    stroke(root, zigzag(182, 266, 150, 172));
    await sleep(20);
    expect(store.items(key)).toHaveLength(3);
    // turned back on: a highlighter zig-zag still erases nothing
    await act(() => backend.update({ ...DEFAULT_INK_SETTINGS }));
    act(() => {
      fireEvent.keyDown(document, { code: 'KeyH', key: 'h' });
    });
    await waitFor(() => expect(root.getAttribute('data-tool')).toBe('highlighter'));
    stroke(root, zigzag(182, 266, 150, 172));
    await sleep(20);
    expect(store.items(key)).toHaveLength(4);
    await store.flush();
  });
});

describe('G14 circle + hold, finger taps', () => {
  it('a closed loop held still selects what it encloses (the loop is not saved); Escape returns to the pen', async () => {
    const { root, store, key } = setupLayer('pen');
    await waitFor(() => expect(root.getAttribute('data-tool')).toBe('pen'));
    stroke(root, word(280, 400));
    const inside = store.items(key)[0]!;
    // a loop around it, then hold still
    const loop: Array<[number, number]> = [];
    for (let i = 0; i <= 40; i++) {
      const a = (i / 40) * Math.PI * 2.05;
      loop.push([295 + Math.cos(a) * 60, 400 + Math.sin(a) * 40]);
    }
    pointer(root, 'pointerdown', loop[0]![0], loop[0]![1], { pointerId: 77 });
    for (const p of loop.slice(1)) pointer(root, 'pointermove', p[0], p[1], { pointerId: 77 });
    await sleep(720);
    const last = loop[loop.length - 1]!;
    pointer(root, 'pointerup', last[0], last[1], { pointerId: 77 });
    await waitFor(() => expect(root.getAttribute('data-tool')).toBe('lasso'));
    expect(store.getSelection()?.ids).toEqual([inside.id]);
    expect(store.items(key)).toHaveLength(1); // no loop stroke
    act(() => {
      fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' });
    });
    await waitFor(() => expect(root.getAttribute('data-tool')).toBe('pen'));
    await store.flush();
  });

  it('two-finger double tap undoes, three-finger double tap redoes; a pen on the screen blocks it', async () => {
    const { root, store, key } = setupLayer('pen', { penOnly: true });
    await waitFor(() => expect(root.getAttribute('data-tool')).toBe('pen'));
    stroke(root, word(100, 100), { pointerType: 'pen' });
    expect(store.items(key)).toHaveLength(1);
    const tap = (ids: number[]) => {
      for (const id of ids) pointer(root, 'pointerdown', 300, 300 + id, { pointerId: id, pointerType: 'touch', isPrimary: id === ids[0] });
      for (const id of ids) pointer(root, 'pointerup', 300, 300 + id, { pointerId: id, pointerType: 'touch', isPrimary: id === ids[0] });
    };
    tap([11, 12]);
    tap([13, 14]);
    expect(store.items(key)).toHaveLength(0);
    tap([21, 22, 23]);
    tap([24, 25, 26]);
    expect(store.items(key)).toHaveLength(1);
    // a pen down meanwhile: nothing happens
    pointer(root, 'pointerdown', 50, 50, { pointerId: 90, pointerType: 'pen' });
    tap([31, 32]);
    tap([33, 34]);
    pointer(root, 'pointerup', 50, 50, { pointerId: 90, pointerType: 'pen' });
    expect(store.items(key).length).toBeGreaterThanOrEqual(1);
    await store.flush();
  });
});

describe('G15 the eraser filter and text highlights', () => {
  it('limited to the highlighter, the eraser leaves pen strokes it crosses', async () => {
    const { root, store, key } = setupLayer('pen', { prefs: { eraserTypes: { pen: false, highlighter: true, shape: true, text_highlight: false } } });
    await waitFor(() => expect(root.getAttribute('data-tool')).toBe('pen'));
    stroke(root, [
      [60, 200],
      [540, 200],
    ]);
    act(() => {
      fireEvent.keyDown(document, { code: 'KeyH', key: 'h' });
    });
    await waitFor(() => expect(root.getAttribute('data-tool')).toBe('highlighter'));
    stroke(root, [
      [60, 220],
      [540, 220],
    ]);
    act(() => {
      fireEvent.keyDown(document, { code: 'KeyE', key: 'e' });
    });
    await waitFor(() => expect(root.getAttribute('data-tool')).toBe('eraser_stroke'));
    stroke(root, [
      [300, 150],
      [300, 190],
      [300, 230],
      [300, 260],
    ]);
    const left = store.items(key);
    expect(left.map((i) => (i.data as InkData).style.tool)).toEqual(['pen']);
    await store.flush();
  });

  it('the eraser removes a text highlight only when allowed; it is a tombstone and undo brings it back', async () => {
    const { root, store, key, anchor } = setupLayer('eraser_stroke', { prefs: { eraserTypes: { pen: true, highlighter: true, shape: true, text_highlight: true } } });
    await waitFor(() => expect(root.getAttribute('data-tool')).toBe('eraser_stroke'));
    const id = newId();
    const now = Date.now();
    await getDb().annotations.put({ id, targetKey: key, kind: 'text_highlight', tool: null, anchor, data: { v: 1, style: 'highlight', color: 'hl-yellow', rects: [{ x: 0.2, y: 0.3, w: 0.5, h: 0.02 }], quote: { exact: 'نص مطبوع' } }, layer: 'highlight', z: 0, locked: false, anchorStatus: 'ok', input: null, rev: 1, createdAt: now, updatedAt: now, deletedAt: null, syncState: 'synced' });
    pointer(root, 'pointerdown', 300, 220, { pointerId: 55 });
    await sleep(30); // the reader's highlights are read from this device's storage when the erase starts
    pointer(root, 'pointermove', 300, 250, { pointerId: 55 });
    pointer(root, 'pointerup', 300, 260, { pointerId: 55 });
    await store.flush();
    expect((await getDb().annotations.get(id))?.deletedAt).toBeTruthy();
    expect(store.items(key)).toHaveLength(0); // never held in the engine's memory
    act(() => {
      store.undo();
    });
    await store.stepSettled();
    await store.flush();
    await waitFor(async () => expect((await getDb().annotations.get(id))?.deletedAt).toBeFalsy());
  });
});

describe('G15 «امسح الصفحة» and «احذف كل … في الدفتر»', () => {
  // every test has its own notebook (this file's IndexedDB lives across its tests)
  let src = '';
  let docKey = '';
  beforeEach(() => {
    src = `SRC-${newId()}`;
    docKey = `${src}:VER`;
  });
  const anchorOf = (pageId: string): AnnotationAnchor => ({ type: 'page', source_id: src, version_id: 'VER', page_id: pageId, page_index: 0, space: 'page_norm' });
  function ink(anchor: AnnotationAnchor, tool: 'pen' | 'highlighter', y: number): InkItem {
    return makeInkItem({ id: newId(), anchor, now: Date.now(), z: 1, style: { tool, color: tool === 'pen' ? 'ink-black' : 'hl-yellow', width: tool === 'pen' ? 0.002 : 0.015 }, points: [[0.1, y, 0], [0.5, y, 10]], pressureAvailable: false, tiltAvailable: false, pointerType: 'pen' });
  }

  it('clear page: the count per type first; tombstones in one undo step; restorable from «المحذوف بالجملة»', async () => {
    const store = getDocumentStore(docKey);
    const a = anchorOf('P1');
    const key = annotationTargetKey(a);
    store.attachPage(key, a, 1.4);
    await store.whenLoaded(key);
    const items = [ink(a, 'pen', 0.1), ink(a, 'pen', 0.2), ink(a, 'highlighter', 0.3)];
    store.commit('كتابة', items.map((it) => ({ id: it.id, targetKey: key, before: null, after: it })));
    const plan = await planClearPage(store, key);
    expect(plan.byType).toEqual({ pen: 2, highlighter: 1 });
    expect(plan.total).toBe(3);
    const onlyPen = await planClearPage(store, key, new Set(['pen']));
    expect(onlyPen.total).toBe(2);
    await applyBulk(store, plan);
    expect(store.items(key)).toHaveLength(0);
    await store.flush();
    for (const it of items) expect((await getDb().annotations.get(it.id))?.deletedAt).toBeTruthy();
    expect(store.history.peekUndo()?.label_ar).toBe('مسح الصفحة');
    act(() => {
      store.undo();
    });
    expect(store.items(key)).toHaveLength(3);
    // clear again, then restore from the list instead of undo
    await applyBulk(store, await planClearPage(store, key));
    const trash = await listTrash(store);
    expect(trash[0]).toMatchObject({ label_ar: 'مسح الصفحة', total: 3 });
    await store.flush();
    expect(await restoreTrash(store, trash[0]!.id)).toBe(3);
    expect(store.items(key)).toHaveLength(3);
    expect(await listTrash(store)).toHaveLength(1);
    await store.flush();
  });

  it('delete by type reaches pages that are not open; undo works after a reload', async () => {
    const pages = ['PA', 'PB'].map(anchorOf);
    let store = getDocumentStore(docKey);
    for (const a of pages) {
      const key = annotationTargetKey(a);
      store.attachPage(key, a, 1.4);
      await store.whenLoaded(key);
      const its = [ink(a, 'pen', 0.1), ink(a, 'highlighter', 0.2), ink(a, 'highlighter', 0.4)];
      store.commit('كتابة', its.map((it) => ({ id: it.id, targetKey: key, before: null, after: it })));
    }
    await store.flush();
    // «reload»: only page A is open now
    __resetStores();
    store = getDocumentStore(docKey);
    const keyA = annotationTargetKey(pages[0]!);
    const keyB = annotationTargetKey(pages[1]!);
    store.attachPage(keyA, pages[0]!, 1.4);
    await store.whenLoaded(keyA);
    const plan = await planDeleteByType(store, 'highlighter');
    expect(plan.total).toBe(4);
    expect(plan.pages).toBe(2);
    await applyBulk(store, plan);
    await store.flush();
    const rowsB = await getDb().annotations.where('targetKey').equals(keyB).toArray();
    expect(rowsB.filter((r) => !r.deletedAt).map((r) => (r.data as InkData).style.tool)).toEqual(['pen']);
    await store.flushHistory();
    // another reload, then one undo brings all four back (the history survives a reload)
    __resetStores();
    store = getDocumentStore(docKey);
    await store.historyReady;
    store.attachPage(keyA, pages[0]!, 1.4);
    await store.whenLoaded(keyA);
    act(() => {
      store.undo();
    });
    await store.stepSettled();
    await store.flush();
    const keys = new Set([keyA, keyB]);
    const alive = (await getDb().annotations.toArray()).filter((r) => keys.has(r.targetKey) && !r.deletedAt && r.kind === 'ink');
    expect(alive).toHaveLength(6);
  });

  it('the «امسح الصفحة» dialog shows the count before anything happens', async () => {
    const { root, store, key } = setupLayer('pen', { toolbar: true });
    await waitFor(() => expect(root.getAttribute('data-tool')).toBe('pen'));
    stroke(root, word(100, 100));
    stroke(root, word(100, 200));
    fireEvent.click(screen.getByRole('button', { name: 'المزيد من أدوات الكتابة' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /امسح الصفحة/ }));
    const dialog = await screen.findByRole('dialog', { name: 'امسح الصفحة' });
    await waitFor(() => expect(within(dialog).getByRole('status').textContent).toMatch(/سيُمسح: .*خطوط بالقلم/));
    expect(store.items(key)).toHaveLength(2); // nothing yet
    fireEvent.click(within(dialog).getByRole('button', { name: /امسح ٢ عنصر/ }));
    await waitFor(() => expect(store.items(key)).toHaveLength(0));
    await store.flush();
  });
});

// ── review of N1 wave 1: regressions found by the adversarial review ──
describe('review: gestures, «امسح الصفحة» and failed writes', () => {
  it('shading inside a small circle drawn before stays ink and the circle stays (not a scratch-out)', async () => {
    const { root, store, key } = setupLayer('pen', NO_HOLD);
    await waitFor(() => expect(root.getAttribute('data-tool')).toBe('pen'));
    // a small circle (a nucleus) r = 24 px at (300, 300)
    const circle: Array<[number, number]> = [];
    for (let i = 0; i <= 48; i++) {
      const a = (i / 48) * Math.PI * 2.03;
      circle.push([300 + Math.cos(a) * 24, 300 + Math.sin(a) * 24]);
    }
    stroke(root, circle);
    // hatching inside it, back and forth, every swing reaching the outline
    const hatch: Array<[number, number]> = [];
    for (let i = 0; i <= 10; i++) {
      const y = 300 - 19 + (38 * i) / 10;
      const half = 25 * Math.sqrt(Math.max(0, 1 - ((y - 300) / 24) ** 2));
      hatch.push([i % 2 === 0 ? 300 - half : 300 + half, y]);
    }
    stroke(root, hatch);
    await sleep(30);
    expect(store.items(key)).toHaveLength(2);
    expect(store.history.peekUndo()?.label_ar).toBe('كتابة');
    await store.flush();
  });

  it('with finger writing on, a two-finger double tap with the eraser undoes the last step and erases nothing', async () => {
    const { root, store, key } = setupLayer('pen', { penOnly: false });
    await waitFor(() => expect(root.getAttribute('data-tool')).toBe('pen'));
    stroke(root, [
      [100, 300],
      [400, 300],
    ]);
    stroke(root, [
      [100, 500],
      [400, 500],
    ]);
    act(() => {
      fireEvent.keyDown(document, { code: 'KeyE', key: 'e' });
    });
    await waitFor(() => expect(root.getAttribute('data-tool')).toMatch(/eraser/));
    const tap = (ids: number[]) => {
      for (const id of ids) pointer(root, 'pointerdown', 200 + (id % 2) * 40, 300, { pointerId: id, pointerType: 'touch', isPrimary: id === ids[0] });
      for (const id of ids) pointer(root, 'pointerup', 200 + (id % 2) * 40, 300, { pointerId: id, pointerType: 'touch', isPrimary: id === ids[0] });
    };
    // two fingers tapped twice ON the first line: the owner means «undo», not «erase this line»
    tap([11, 12]);
    tap([13, 14]);
    await sleep(20);
    const left = store.items(key);
    expect(left).toHaveLength(1);
    expect((left[0]!.data as InkData).points[0]![1]).toBeCloseTo(300 / 800, 3);
    expect(store.history.peekRedo()?.label_ar).toBe('كتابة');
    await store.flush();
  });

  it('«امسح الصفحة» acts on the page in view (named in the dialog), not on the page written on last', async () => {
    const other: AnnotationAnchor = { type: 'page', source_id: 'S', version_id: 'V', page_id: newId(), page_index: 6, space: 'page_norm' };
    const otherKey = annotationTargetKey(other);
    const { root, store, key } = setupLayer('pen', {
      toolbar: true,
      around: (n) => (
        <InkHost links={null} currentPage={() => ({ targetKey: otherKey, anchor: other, ar: 800 / 600, pageWidthPt: 600 })}>
          {n}
        </InkHost>
      ),
    });
    await waitFor(() => expect(root.getAttribute('data-tool')).toBe('pen'));
    // the owner wrote on the layer's page (now «the page written on last») …
    stroke(root, word(100, 100));
    stroke(root, word(100, 200));
    // … then scrolled to page 7, which holds one stroke
    store.attachPage(otherKey, other, 800 / 600);
    await store.whenLoaded(otherKey);
    const far = makeInkItem({ id: newId(), anchor: other, now: Date.now(), z: 1, style: { tool: 'pen', color: 'ink-black', width: 0.002 }, points: [[0.1, 0.5, 0], [0.5, 0.5, 10]], pressureAvailable: false, tiltAvailable: false, pointerType: 'pen' });
    act(() => store.commit('كتابة', [{ id: far.id, targetKey: otherKey, before: null, after: far }]));
    fireEvent.click(screen.getByRole('button', { name: 'المزيد من أدوات الكتابة' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /امسح الصفحة/ }));
    const dialog = await screen.findByRole('dialog', { name: 'امسح الصفحة' });
    await waitFor(() => expect(within(dialog).getByRole('status').textContent).toMatch(/سيُمسح: ١ خط بالقلم/));
    expect(dialog.textContent).toMatch(/الصفحة ٧/);
    fireEvent.click(within(dialog).getByRole('button', { name: /امسح ١ عنصر/ }));
    await waitFor(() => expect(store.items(otherKey)).toHaveLength(0));
    expect(store.items(key)).toHaveLength(2); // the page written on last is untouched
    await store.flush();
  });

  it('a restore (undo) whose write failed is written again as the restore — never as a tombstone', async () => {
    const { root, store, key, anchor } = setupLayer('eraser_stroke', { prefs: { eraserTypes: { pen: true, highlighter: true, shape: true, text_highlight: true } } });
    await waitFor(() => expect(root.getAttribute('data-tool')).toBe('eraser_stroke'));
    const id = newId();
    const now = Date.now();
    await getDb().annotations.put({ id, targetKey: key, kind: 'text_highlight', tool: null, anchor, data: { v: 1, style: 'highlight', color: 'hl-yellow', rects: [{ x: 0.2, y: 0.3, w: 0.5, h: 0.02 }], quote: { exact: 'نص مطبوع' } }, layer: 'highlight', z: 0, locked: false, anchorStatus: 'ok', input: null, rev: 1, createdAt: now, updatedAt: now, deletedAt: null, syncState: 'synced' });
    pointer(root, 'pointerdown', 300, 220, { pointerId: 55 });
    await sleep(30);
    pointer(root, 'pointermove', 300, 250, { pointerId: 55 });
    pointer(root, 'pointerup', 300, 260, { pointerId: 55 });
    await store.flush();
    expect((await getDb().annotations.get(id))?.deletedAt).toBeTruthy();
    // the undo's write fails once (storage full) …
    const db = getDb();
    const original = db.transaction.bind(db) as (...a: unknown[]) => unknown;
    let fail = 1;
    const spy = vi.spyOn(db, 'transaction').mockImplementation(((...args: unknown[]) => {
      if (fail > 0) {
        fail--;
        return Promise.reject(new Error('QuotaExceededError'));
      }
      return original(...args);
    }) as typeof db.transaction);
    act(() => {
      store.undo();
    });
    await store.stepSettled();
    await store.flush();
    expect(store.getStatus().state).toBe('error');
    // … and is retried with the next write: the highlight comes back
    act(() => {
      fireEvent.keyDown(document, { code: 'KeyP', key: 'p' });
    });
    await waitFor(() => expect(root.getAttribute('data-tool')).toMatch(/^(pen|fountain|ball)$/));
    stroke(root, word(100, 600));
    await store.flush();
    spy.mockRestore();
    expect(store.getStatus().state).toBe('idle');
    expect((await getDb().annotations.get(id))?.deletedAt).toBeFalsy();
  });
});
