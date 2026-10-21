// Parity N1 — G17 (the lasso's type filter and rectangle mode) and G19 (free resize and rotation of text boxes and
// pictures, keyboard nudge), through the real <InkLayer> / <SelectionOverlay> and the real store:
//  * «حبري فقط» selects the strokes inside the loop and leaves the text box; the rectangle selects by its corners; the
//    choice is remembered for this document only;
//  * a reader highlight on printed text inside the loop is never selected nor moved;
//  * a corner drag stretches a text box (Shift keeps its proportions, Alt resizes about the centre); a picture always
//    keeps its proportions; the far side stops at the storable range;
//  * the rotate handle turns text boxes and pictures; the turn is kept in page space (the same on-screen turn gives the
//    same stored angle at another zoom and page rotation);
//  * the frame is a named group: the arrows move it in the direction pressed on screen (rotated view too), quick
//    presses are one undo step, Delete removes, Escape clears.
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newId, normToView, richTextFromPlain, type ImageAnnotationData, type InkData, type QuarterTurn, type TextBoxData } from '@medlevo/shared';
import { setInkSettingsBackend } from '../../src/features/workspace/ink/inkSettings';
import { COORD_MAX, limitStretchToRange, makeImageItem, makeInkItem, makeTextItem, type InkItem } from '../../src/features/workspace/ink/model';
import { DEFAULT_LASSO, loadLassoPrefs, parseLassoPrefs } from '../../src/features/workspace/ink/prefs';
import { __resetStores } from '../../src/features/workspace/ink/store';
import { getDb } from '../../src/lib/localdb';
import { installSettings, setupLayer, stroke, type LayerSetup } from './n1-helpers';

// a real layer and toolbar in jsdom: slow on a loaded machine, never hanging
vi.setConfig({ testTimeout: 20_000 });

beforeEach(() => {
  __resetStores();
  window.localStorage.clear();
  installSettings();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});
afterEach(() => {
  setInkSettingsBackend(null);
  __resetStores();
  vi.restoreAllMocks();
});

const now = () => Date.now();
function penStroke(s: LayerSetup, y: number, x0 = 0.2, x1 = 0.4): InkItem {
  return makeInkItem({ id: newId(), anchor: s.anchor, now: now(), z: s.store.nextZ(s.key), style: { tool: 'pen', color: 'ink-black', width: 0.002 }, points: [[x0, y, 0], [(x0 + x1) / 2, y, 5], [x1, y, 10]], pressureAvailable: false, tiltAvailable: false, pointerType: 'pen' });
}
function textBox(s: LayerSetup, box = { x: 0.2, y: 0.2, w: 0.2, h: 0.1 }): InkItem {
  return makeTextItem({ id: newId(), anchor: s.anchor, now: now(), z: s.store.nextZ(s.key), box, text: richTextFromPlain('ضغط الدم'), color: 'ink-black', fontScale: 0.03 });
}
function picture(s: LayerSetup, box = { x: 0.2, y: 0.2, w: 0.2, h: 0.1 }): InkItem {
  const data: ImageAnnotationData = { v: 1, image_key: `K-${newId()}`, box, mime: 'image/png', natural_w: 20, natural_h: 10, bytes: 9 };
  return makeImageItem({ id: newId(), anchor: s.anchor, now: now(), z: s.store.nextZ(s.key), data });
}
async function put(s: LayerSetup, items: InkItem[]) {
  await s.store.whenLoaded(s.key);
  act(() => {
    s.store.commit('كتابة', items.map((it) => ({ id: it.id, targetKey: s.key, before: null, after: it })));
  });
}
/** a client point from a layer-local view point (the layer's rect starts at 10, 20) */
const client = (v: [number, number]) => ({ clientX: v[0] + 10, clientY: v[1] + 20 });

function select(s: LayerSetup, ids: string[]): HTMLElement {
  act(() => s.store.setSelection({ targetKey: s.key, ids }));
  const frame = s.root.querySelector('.ml-ink-selection');
  expect(frame).not.toBeNull();
  return frame as HTMLElement;
}

/** a drag of one selection handle from → to (layer-local view px) */
function drag(el: Element, from: [number, number], to: [number, number], mods: { shiftKey?: boolean; altKey?: boolean } = {}) {
  const base = { pointerId: 31, button: 0, pointerType: 'mouse' };
  act(() => {
    fireEvent.pointerDown(el, { ...base, ...client(from) });
  });
  act(() => {
    fireEvent.pointerMove(el, { ...base, buttons: 1, ...client(to), ...mods });
  });
  act(() => {
    fireEvent.pointerUp(el, { ...base, ...client(to), ...mods });
  });
}

describe('G17 the lasso type filter and the rectangle', () => {
  it('«حبري فقط» selects the strokes inside the loop and leaves the text box; the choice is this document’s only', async () => {
    const s = setupLayer('lasso', { toolbar: true });
    await waitFor(() => expect(s.root.getAttribute('data-tool')).toBe('lasso'));
    const pen = penStroke(s, 0.25);
    const text = textBox(s, { x: 0.5, y: 0.2, w: 0.2, h: 0.05 });
    await put(s, [pen, text]);
    const loop: Array<[number, number]> = [
      [60, 120],
      [300, 110],
      [480, 120],
      [490, 200],
      [480, 280],
      [300, 290],
      [60, 280],
      [50, 200],
      [62, 124],
    ];
    // everything at first
    stroke(s.root, loop);
    expect(s.store.getSelection()?.ids.sort()).toEqual([pen.id, text.id].sort());
    act(() => s.store.setSelection(null));
    // the lasso's options: «حبري فقط»
    fireEvent.click(screen.getByRole('button', { name: 'خيارات التحديد (الشكل والأنواع)' }));
    fireEvent.click(await screen.findByRole('button', { name: 'حبري فقط' }));
    expect(screen.getByRole('button', { name: 'الحبر' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'النصوص' }).getAttribute('aria-pressed')).toBe('false');
    stroke(s.root, loop);
    expect(s.store.getSelection()?.ids).toEqual([pen.id]);
    // a tap on the text box does not pick it either (same filter)
    act(() => s.store.setSelection(null));
    stroke(s.root, [[360, 180]]);
    expect(s.store.getSelection()).toBeNull();
    // remembered for this document on this device, not for another one
    expect(loadLassoPrefs(s.docKey).types).toEqual({ ink: true, shape: false, text: false, image: false, link: false });
    expect(loadLassoPrefs(`other-${newId()}`)).toEqual(DEFAULT_LASSO);
    await s.store.flush();
  });

  it('the rectangle mode selects what lies inside the dragged rectangle', async () => {
    const docKey = `doc-n1-rect-${newId()}`;
    window.localStorage.setItem(`medlevo.ink.lasso.v1:${docKey}`, JSON.stringify({ mode: 'rect', types: DEFAULT_LASSO.types }));
    const s = setupLayer('lasso', { docKey });
    await waitFor(() => expect(s.root.getAttribute('data-tool')).toBe('lasso'));
    const inside = penStroke(s, 0.25);
    const below = penStroke(s, 0.6);
    await put(s, [inside, below]);
    // a straight drag corner to corner (a freehand loop of two points would select nothing)
    stroke(s.root, [
      [60, 120],
      [300, 200],
      [480, 280],
    ]);
    expect(s.store.getSelection()?.ids).toEqual([inside.id]);
    await s.store.flush();
  });

  it('a filter that lets nothing through falls back to everything; an unknown mode is the freehand loop', () => {
    expect(parseLassoPrefs({ mode: 'star', types: { ink: false, shape: false, text: false, image: false, link: false } })).toEqual(DEFAULT_LASSO);
    expect(parseLassoPrefs({ mode: 'rect', types: { text: false } })).toEqual({ mode: 'rect', types: { ...DEFAULT_LASSO.types, text: false } });
  });

  it('a reader highlight on printed text inside the loop is never selected nor moved', async () => {
    const s = setupLayer('lasso');
    await waitFor(() => expect(s.root.getAttribute('data-tool')).toBe('lasso'));
    const pen = penStroke(s, 0.25);
    await put(s, [pen]);
    const hid = newId();
    const t = now();
    const row = { id: hid, targetKey: s.key, kind: 'text_highlight', tool: null, anchor: s.anchor, data: { v: 1, style: 'highlight', color: 'hl-yellow', rects: [{ x: 0.2, y: 0.22, w: 0.3, h: 0.02 }], quote: { exact: 'نص مطبوع' } }, layer: 'highlight', z: 0, locked: false, anchorStatus: 'ok', input: null, rev: 3, createdAt: t, updatedAt: t, deletedAt: null, syncState: 'synced' } as const;
    await getDb().annotations.put(structuredClone(row) as never);
    stroke(s.root, [
      [60, 120],
      [480, 120],
      [480, 280],
      [60, 280],
      [62, 124],
    ]);
    expect(s.store.getSelection()?.ids).toEqual([pen.id]);
    const frame = s.root.querySelector('.ml-ink-selection') as HTMLElement;
    act(() => {
      fireEvent.keyDown(frame, { key: 'ArrowDown' });
    });
    await s.store.flush();
    expect((s.store.item(s.key, pen.id)!.data as InkData).points[0]![1]).toBeGreaterThan(0.25);
    const after = await getDb().annotations.get(hid);
    expect(after).toMatchObject({ rev: 3, deletedAt: null, data: row.data });
  });
});

describe('G19 free resize and rotation', () => {
  // the page is 600×800 pt; at scale 1 / no rotation the view is the page
  it('a corner drag stretches a text box; its letters keep their size; one undo step', async () => {
    const s = setupLayer('lasso');
    const t = textBox(s);
    await put(s, [t]);
    select(s, [t.id]);
    const handles = s.root.querySelectorAll('.ml-ink-handle');
    expect(handles).toHaveLength(4);
    // bottom-end corner (page bottom-right): from (240, 240) to (360, 260)
    drag(handles[2]!, [240, 240], [360, 260]);
    const d = s.store.item(s.key, t.id)!.data as TextBoxData;
    expect(d.box.x).toBeCloseTo(0.2, 5);
    expect(d.box.y).toBeCloseTo(0.2, 5);
    expect(d.box.w).toBeCloseTo(0.4, 5);
    expect(d.box.h).toBeCloseTo(0.125, 5);
    expect(d.font_scale).toBeCloseTo(0.03, 6);
    expect(s.store.history.peekUndo()?.label_ar).toBeTruthy();
    act(() => {
      s.store.undo();
    });
    expect((s.store.item(s.key, t.id)!.data as TextBoxData).box).toEqual(t.data && (t.data as TextBoxData).box);
    await s.store.flush();
  });

  it('Shift keeps the proportions; Alt resizes about the centre', async () => {
    const s = setupLayer('lasso');
    const t = textBox(s);
    await put(s, [t]);
    select(s, [t.id]);
    drag(s.root.querySelectorAll('.ml-ink-handle')[2]!, [240, 240], [360, 260], { shiftKey: true });
    let d = s.store.item(s.key, t.id)!.data as TextBoxData;
    expect(d.box.w / d.box.h).toBeCloseTo(2, 3); // boxes are stored rounded
    expect(d.font_scale).toBeGreaterThan(0.03); // a proportional resize scales the letters too
    act(() => {
      s.store.undo();
    });
    select(s, [t.id]);
    drag(s.root.querySelectorAll('.ml-ink-handle')[2]!, [240, 240], [300, 280], { altKey: true });
    d = s.store.item(s.key, t.id)!.data as TextBoxData;
    expect(d.box.x + d.box.w / 2).toBeCloseTo(0.3, 5);
    expect(d.box.y + d.box.h / 2).toBeCloseTo(0.25, 5);
    expect(d.box.w).toBeGreaterThan(0.2);
    await s.store.flush();
  });

  it('a picture always keeps its proportions', async () => {
    const s = setupLayer('lasso');
    const p = picture(s);
    await put(s, [p]);
    select(s, [p.id]);
    drag(s.root.querySelectorAll('.ml-ink-handle')[2]!, [240, 240], [360, 260]);
    const b = (s.store.item(s.key, p.id)!.data as ImageAnnotationData).box;
    expect(b.w / b.h).toBeCloseTo(2, 3);
    expect(b.w).toBeGreaterThan(0.2);
    await s.store.flush();
  });

  it('the far side of a stretch stops at the storable range', () => {
    const [sx, sy] = limitStretchToRange(20, 20, [0, 0], { x: 0, y: 0, w: 0.5, h: 0.25 }, 1);
    expect(0.5 * sx).toBeCloseTo(COORD_MAX, 9);
    expect(0.25 * sy).toBeCloseTo(COORD_MAX, 9);
    // shrinking is never limited
    expect(limitStretchToRange(0.5, 0.2, [0, 0], { x: 0, y: 0, w: 0.5, h: 0.25 }, 1)).toEqual([0.5, 0.2]);
  });

  const cases: Array<{ rotation: QuarterTurn; scale: number }> = [
    { rotation: 0, scale: 1 },
    { rotation: 90, scale: 2 },
    { rotation: 270, scale: 0.75 },
  ];
  for (const c of cases) {
    it(`the rotate handle turns a text box and a picture by the same angle in page space (view ${c.rotation}°, zoom ${c.scale})`, async () => {
      const s = setupLayer('lasso', { rotation: c.rotation, scale: c.scale });
      const t = textBox(s);
      const p = picture(s, { x: 0.25, y: 0.225, w: 0.1, h: 0.05 }); // the same centre (0.3, 0.25)
      await put(s, [t, p]);
      select(s, [t.id, p.id]);
      const centre = normToView(0.3, 0.25, s.view) as [number, number];
      const rotate = s.root.querySelector('.ml-ink-selection__rotate')!;
      // a quarter turn clockwise on screen: from above the centre to its right
      drag(rotate, [centre[0], centre[1] - 60], [centre[0] + 60, centre[1]]);
      const td = s.store.item(s.key, t.id)!.data as TextBoxData;
      const pd = s.store.item(s.key, p.id)!.data as ImageAnnotationData;
      expect(td.rotation).toBeCloseTo(Math.PI / 2, 5);
      expect(pd.rotation).toBeCloseTo(Math.PI / 2, 5);
      // turned about the selection's centre: the centres stay put, the sizes too
      expect(td.box.x + td.box.w / 2).toBeCloseTo(0.3, 5);
      expect(td.box.w).toBeCloseTo(0.2, 5);
      expect(pd.box.w / pd.box.h).toBeCloseTo(2, 3);
      // drawn with the page's quarter turn and then its own turn
      const el = await waitFor(() => {
        const e = s.root.querySelector('.ml-ink-text') as HTMLElement | null;
        expect(e?.style.transform).toContain('rad');
        return e!;
      });
      expect(el.style.transform).toBe(`${c.rotation ? `rotate(${c.rotation}deg) ` : ''}rotate(1.570796rad)`);
      await s.store.flush();
    });
  }
});

describe('G19 the frame and the keyboard', () => {
  it('a named, focusable group; the arrows move in the direction pressed on screen (rotated view); quick presses are one undo step', async () => {
    const s = setupLayer('lasso', { rotation: 90, scale: 2 });
    const pen = penStroke(s, 0.25);
    await put(s, [pen]);
    const frame = select(s, [pen.id]);
    expect(frame.getAttribute('role')).toBe('group');
    expect(frame.tabIndex).toBe(0);
    expect(frame.getAttribute('aria-label')).toMatch(/^المحدد: ١ عنصر/);
    expect(document.getElementById(frame.getAttribute('aria-describedby')!)?.textContent).toMatch(/الأسهم تحرّكه/);
    const undoBefore = s.store.history.size.undo;
    frame.focus();
    // the page is turned a quarter clockwise: right on screen is up the page (−y)
    act(() => {
      fireEvent.keyDown(frame, { key: 'ArrowRight' });
    });
    act(() => {
      fireEvent.keyDown(frame, { key: 'ArrowRight', shiftKey: true });
    });
    const pts = (s.store.item(s.key, pen.id)!.data as InkData).points;
    expect(pts[0]![0]).toBeCloseTo(0.2, 5);
    expect(pts[0]![1]).toBeCloseTo(0.25 - 11 / 800, 5);
    expect(s.store.history.size.undo).toBe(undoBefore + 1);
    act(() => {
      s.store.undo();
    });
    expect((s.store.item(s.key, pen.id)!.data as InkData).points[0]![1]).toBeCloseTo(0.25, 6);
    // Escape clears, Delete removes
    select(s, [pen.id]);
    act(() => {
      fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' });
    });
    await waitFor(() => expect(s.store.getSelection()).toBeNull());
    select(s, [pen.id]);
    act(() => {
      fireEvent.keyDown(document, { key: 'Delete', code: 'Delete' });
    });
    await waitFor(() => expect(s.store.items(s.key)).toHaveLength(0));
    await s.store.flush();
  });

  // (review) a slider, a radio or a check box elsewhere on the screen keeps its own arrows: the selection is moved only
  // when the keyboard is on the selection frame, the page's ink layer, or nowhere in particular
  it('the arrows are left alone while another control (a slider, a radio button) has the keyboard', async () => {
    const s = setupLayer('lasso');
    const pen = penStroke(s, 0.25);
    await put(s, [pen]);
    select(s, [pen.id]);
    for (const type of ['range', 'radio', 'checkbox']) {
      const input = document.createElement('input');
      input.type = type;
      document.body.appendChild(input);
      input.focus();
      act(() => {
        fireEvent.keyDown(input, { key: 'ArrowRight' });
        fireEvent.keyDown(input, { key: 'ArrowDown' });
      });
      const p = (s.store.item(s.key, pen.id)!.data as InkData).points[0]!;
      expect([p[0], p[1]], type).toEqual([0.2, 0.25]);
      input.remove();
    }
    // back on the frame, the arrows move it again
    const frame = s.root.querySelector('.ml-ink-selection') as HTMLElement;
    frame.focus();
    act(() => {
      fireEvent.keyDown(frame, { key: 'ArrowRight' });
    });
    expect((s.store.item(s.key, pen.id)!.data as InkData).points[0]![0]).toBeGreaterThan(0.2);
    await s.store.flush();
  });

  it('the arrows are left alone while typing', async () => {
    const s = setupLayer('lasso');
    const pen = penStroke(s, 0.25);
    await put(s, [pen]);
    select(s, [pen.id]);
    const input = document.createElement('input');
    document.body.appendChild(input);
    act(() => {
      fireEvent.keyDown(input, { key: 'ArrowRight' });
    });
    expect((s.store.item(s.key, pen.id)!.data as InkData).points[0]![0]).toBeCloseTo(0.2, 6);
    input.remove();
    await s.store.flush();
  });
});
