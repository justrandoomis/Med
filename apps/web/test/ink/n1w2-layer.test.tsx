// Parity N1 wave 2 — the new writing aids through the real <InkLayer>, toolbar and store (jsdom: input and persistence
// run, painting is skipped):
//  * G06 / G04: a pencil stroke is saved as points-only pen ink with the graphite texture; a dashed preset dashes;
//  * G21: a connector drawn between two shapes attaches to both; moving a shape re-routes it in the SAME undo step,
//    and an undo puts both back with the attachments; «add a connected shape» is one undo step;
//  * G10: «أفسح مكانًا» moves only what is below the line, in one undo step; the reflow is offered only with handwriting
//    recognition (its reason otherwise) and, with the fake reader, moves whole words in one step;
//  * G09: the zoom window — a tap places the box, a stroke in the strip is saved in PAGE space in the box, one undo step;
//    a stroke reaching the left third (Arabic) moves the box to the left;
//  * G67: a long press with a finger (and a right click, and the context-menu key) opens the page menu; «نص هنا» starts
//    a text box at that point; «صفحة ملاحظات بعد هذه الصفحة» calls the host; a disabled entry says why;
//  * G08: a stroke along the ruler is straight; the ruler and the measurement are never saved as ink; the measurement
//    is labelled «تقدير تعليمي — ليس قياسًا سريريًا»;
//  * G11: the neat copy hides the pen canvas, draws a derived one, and leaves the stored strokes byte for byte;
//  * G22: dragging a selection snaps to a processed region's edge.
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newId, type AnnotationAnchor, type InkData, type ShapeData } from '@medlevo/shared';
import { capabilitiesStore } from '../../src/lib/capabilities';
import { attachPoint } from '../../src/features/workspace/ink/connectors';
import { InkHost } from '../../src/features/workspace/ink/host';
import { setInkSettingsBackend } from '../../src/features/workspace/ink/inkSettings';
import { useInkInternal } from '../../src/features/workspace/ink/InkProvider';
import { itemBBox, makeInkItem, makeShapeItem, type InkItem, type InkItemOf } from '../../src/features/workspace/ink/model';
import { __setPageRegions } from '../../src/features/workspace/ink/pageOverlays';
import { setReflowReader } from '../../src/features/workspace/ink/reflow';
import { placeRuler, rulerEdge } from '../../src/features/workspace/ink/ruler';
import { __resetStores } from '../../src/features/workspace/ink/store';
import { installSettings, pointer, setupLayer, stroke, type LayerSetup } from './n1-helpers';

vi.setConfig({ testTimeout: 20_000 });

beforeEach(() => {
  __resetStores();
  window.localStorage.clear();
  installSettings();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});
afterEach(() => {
  setInkSettingsBackend(null);
  setReflowReader(null);
  capabilitiesStore.reset(null);
  __resetStores();
  vi.restoreAllMocks();
});

const AR = 800 / 600;
const sheet = (n: React.ReactNode) => <div className="wk-sheet">{n}</div>;
function inks(s: LayerSetup) {
  return s.store.items(s.key).filter((i): i is InkItemOf<InkData> => i.kind === 'ink');
}
function shapes(s: LayerSetup) {
  return s.store.items(s.key).filter((i): i is InkItemOf<ShapeData> => i.kind === 'shape');
}
async function put(s: LayerSetup, items: InkItem[]) {
  await s.store.whenLoaded(s.key);
  act(() => {
    s.store.commit('كتابة', items.map((it) => ({ id: it.id, targetKey: s.key, before: null, after: it })));
  });
}
function rect(s: LayerSetup, from: [number, number], to: [number, number], extra: Partial<ShapeData> = {}) {
  return makeShapeItem({ id: newId(), anchor: s.anchor, now: Date.now(), z: s.store.nextZ(s.key), shape: 'rect', from, to, style: { tool: 'pen', color: 'ink-black', width: 0.003 }, extra });
}
function penLine(s: LayerSetup, x0: number, x1: number, y: number, slope = 0) {
  const pts: Array<[number, number, number]> = [];
  for (let i = 0; i <= 12; i++) {
    const x = x0 + ((x1 - x0) * i) / 12;
    pts.push([x, y + slope * (x - x0) + (i % 2 ? 0.008 : 0), i * 10]);
  }
  return makeInkItem({ id: newId(), anchor: s.anchor, now: Date.now(), z: s.store.nextZ(s.key), style: { tool: 'pen', color: 'ink-black', width: 0.002 }, points: pts, pressureAvailable: false, tiltAvailable: false, pointerType: 'pen' });
}
/** page-normalized → layer-local css px (600 × 800 at scale 1) */
const px = (x: number, y: number): [number, number] => [x * 600, y * 800];

/** exposes the provider's session state to the test */
let internal: ReturnType<typeof useInkInternal> | null = null;
function Internal() {
  const i = useInkInternal();
  useEffect(() => {
    internal = i;
  });
  return null;
}

describe('G06 / G04 pencil and line patterns through the layer', () => {
  it('a pencil stroke is stored as points-only pen ink with the graphite texture; a dashed preset is dashed', async () => {
    const s = setupLayer('pencil', { prefs: { presets: { pencil: { color: 'ink-black', width: 0.003, dash: 'dot' } } } });
    await s.store.whenLoaded(s.key);
    stroke(s.root, [px(0.2, 0.3), px(0.3, 0.31), px(0.4, 0.3)], { pointerType: 'pen', pressure: 0.4 });
    const [it] = inks(s);
    expect(it).toBeTruthy();
    expect(it!.tool).toBe('pen');
    expect(it!.data.style).toMatchObject({ tool: 'pen', texture: 'graphite', dash: 'dot' });
    expect(it!.data.points.length).toBeGreaterThan(1);
    await s.store.flush();
  });
});

describe('G21 connectors', () => {
  it('a connector attaches to two shapes; moving a shape re-routes it in the same undo step; undo keeps the attachments', async () => {
    const s = setupLayer('connector');
    const a = rect(s, [0.1, 0.1], [0.3, 0.2]);
    const b = rect(s, [0.6, 0.1], [0.8, 0.2]);
    await put(s, [a, b]);
    stroke(s.root, [px(0.29, 0.15), px(0.45, 0.15), px(0.61, 0.15)]);
    const conn = shapes(s).find((x) => x.data.attach)!;
    expect(conn.data.attach).toEqual({ from: { id: a.id, side: 'e' }, to: { id: b.id, side: 'w' } });
    const movedB = { ...b, data: { ...b.data, from: [0.6, 0.5] as [number, number], to: [0.8, 0.6] as [number, number] } };
    act(() => s.store.commit('نقل', [{ id: b.id, targetKey: s.key, before: s.store.item(s.key, b.id)!, after: movedB }]));
    const rerouted = s.store.item(s.key, conn.id) as InkItemOf<ShapeData>;
    const west = attachPoint(movedB.data, 'w', AR)!;
    expect(rerouted.data.to[0]).toBeCloseTo(west[0], 5);
    expect(rerouted.data.to[1]).toBeCloseTo(west[1], 5);
    expect(rerouted.data.attach).toEqual(conn.data.attach);
    act(() => {
      s.store.undo();
    });
    const back = s.store.item(s.key, conn.id) as InkItemOf<ShapeData>;
    expect(back.data.to).toEqual(conn.data.to);
    expect(back.data.attach).toEqual(conn.data.attach);
    expect((s.store.item(s.key, b.id) as InkItemOf<ShapeData>).data.from).toEqual([0.6, 0.1]);
    await s.store.flush();
  });

  it('«أضف شكلًا متصلًا» adds a shape and an attached arrow in one undo step', async () => {
    const s = setupLayer('lasso');
    const a = rect(s, [0.1, 0.1], [0.3, 0.2]);
    await put(s, [a]);
    act(() => s.store.setSelection({ targetKey: s.key, ids: [a.id] }));
    fireEvent.click(await screen.findByRole('button', { name: 'أضف شكلًا متصلًا من الأسفل' }));
    await waitFor(() => expect(shapes(s).length).toBe(3));
    const conn = shapes(s).find((x) => x.data.attach)!;
    expect(conn.data.attach!.from!.id).toBe(a.id);
    act(() => {
      s.store.undo();
    });
    expect(shapes(s).map((x) => x.id)).toEqual([a.id]);
    await s.store.flush();
  });
});

describe('G10 insert space and word reflow', () => {
  it('a downward drag with «أفسح مكانًا» moves only what is below the line, in one undo step', async () => {
    const s = setupLayer('insert_space');
    const above = penLine(s, 0.1, 0.5, 0.1);
    const below = penLine(s, 0.1, 0.5, 0.5);
    await put(s, [above, below]);
    stroke(s.root, [px(0.5, 0.3), px(0.5, 0.33), px(0.5, 0.36)]);
    const nb = s.store.item(s.key, below.id) as InkItemOf<InkData>;
    expect(nb.data.points[0]![1]).toBeCloseTo(0.56, 2);
    expect((s.store.item(s.key, above.id) as InkItemOf<InkData>).data.points).toEqual(above.data.points);
    act(() => {
      s.store.undo();
    });
    expect((s.store.item(s.key, below.id) as InkItemOf<InkData>).data.points).toEqual(below.data.points);
    await s.store.flush();
  });

  it('reflow needs handwriting recognition (its reason is shown); with the fake reader it moves whole words in one step', async () => {
    const s = setupLayer('lasso');
    const words = [0.8, 0.6, 0.4, 0.2].map((x) =>
      makeInkItem({ id: newId(), anchor: s.anchor, now: Date.now(), z: s.store.nextZ(s.key), style: { tool: 'pen', color: 'ink-black', width: 0.002 }, points: [0, 1, 2, 3, 4, 5, 6].map((i) => [x + (0.08 * i) / 6, 0.3 + (i % 2 ? 0.02 : 0), i * 10] as [number, number, number]), pressureAvailable: false, tiltAvailable: false, pointerType: 'pen' }),
    );
    await put(s, words);
    capabilitiesStore.reset({ features: { 'workspace.handwriting_recognition': { state: 'requires_configuration', reason_ar: 'لا يوجد مفتاح للذكاء الاصطناعي.' } } } as never);
    act(() => s.store.setSelection({ targetKey: s.key, ids: words.map((w) => w.id) }));
    fireEvent.click(await screen.findByRole('button', { name: 'المزيد' }));
    const off = await screen.findByRole('menuitem', { name: /أعد ترتيب الكلمات/ });
    expect(off.getAttribute('aria-disabled')).toBe('true');
    expect(document.body.textContent).toContain('إعادة ترتيب الكلمات تحتاج قراءة الخط');
    fireEvent.keyDown(off, { key: 'Escape' });
    // the fake provider's reading: the same four words
    capabilitiesStore.reset({ features: { 'workspace.handwriting_recognition': { state: 'available' } } } as never);
    setReflowReader(async () => ({ lang: 'ar', lines: [{ words: [{ text: 'ارتفاع' }, { text: 'ضغط' }, { text: 'الدم' }, { text: 'الشرياني' }] }] as never }));
    fireEvent.click(screen.getByRole('button', { name: 'المزيد' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /أعد ترتيب الكلمات/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'اقرأ الكلمات' }));
    await screen.findByText(/٤ كلمة في/);
    const before = words.map((w) => (s.store.item(s.key, w.id) as InkItemOf<InkData>).data.points);
    fireEvent.click(screen.getByRole('button', { name: 'طبّق' }));
    await waitFor(() => expect(words.some((w, i) => (s.store.item(s.key, w.id) as InkItemOf<InkData>).data.points !== before[i])).toBe(true));
    act(() => {
      s.store.undo();
    });
    words.forEach((w, i) => expect((s.store.item(s.key, w.id) as InkItemOf<InkData>).data.points).toEqual(before[i]));
    await s.store.flush();
  });
});

describe('G09 the zoom writing window', () => {
  it('a tap places the box; a stroke in the strip is saved in the box (page space), one undo step; RTL advances left', async () => {
    const s = setupLayer('zoom_window', { toolbar: true, around: (n) => <>{n}<Internal /></> });
    await s.store.whenLoaded(s.key);
    pointer(s.root, 'pointerdown', ...px(0.8, 0.3));
    pointer(s.root, 'pointerup', ...px(0.8, 0.3));
    const strip = (await screen.findByRole('application', { name: /اكتب هنا/ })) as HTMLElement;
    const box = internal!.zoom!.box;
    expect(internal!.zoom!.dir).toBe('rtl');
    expect(box.x + box.w).toBeCloseTo(0.8, 3); // the tap is where writing starts: the box's right side
    vi.spyOn(strip, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 500, width: 600, height: 150, right: 600, bottom: 650, x: 0, y: 500, toJSON: () => ({}) } as DOMRect);
    const ev = (type: string, x: number, y: number) => fireEvent[type as 'pointerDown'](strip, { pointerId: 9, pointerType: 'pen', button: 0, buttons: type === 'pointerUp' ? 0 : 1, clientX: x, clientY: y, pressure: 0.5, isPrimary: true });
    // a word written from the right edge across to the left third of the strip
    ev('pointerDown', 560, 560);
    ev('pointerMove', 400, 570);
    ev('pointerMove', 250, 560);
    ev('pointerMove', 120, 575);
    ev('pointerUp', 120, 575);
    const [it] = inks(s);
    expect(it).toBeTruthy();
    const xs = it!.data.points.map((p) => p[0]);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(box.x - 1e-3);
    expect(Math.max(...xs)).toBeLessThanOrEqual(box.x + box.w + 1e-3);
    expect(it!.data.points[0]![1]).toBeGreaterThanOrEqual(box.y - 1e-3);
    await waitFor(() => expect(internal!.zoom!.box.x).toBeLessThan(box.x));
    act(() => {
      s.store.undo();
    });
    expect(inks(s).length).toBe(0);
    await s.store.flush();
  });
});

describe('G67 the page menu', () => {
  it('a finger held still opens the menu (pen-only mode); «نص هنا» starts a text box there; a disabled entry says why', async () => {
    const newNotePageAfter = vi.fn();
    const s = setupLayer('pen', { penOnly: true, wrap: sheet, around: (n) => <InkHost links={null as never} currentPage={() => null} notify={() => undefined} pageMenu={{ newNotePageAfter }}>{n}</InkHost> });
    await s.store.whenLoaded(s.key);
    pointer(s.root, 'pointerdown', ...px(0.5, 0.5), { pointerType: 'touch', pointerId: 77 });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 650));
    });
    const menu = await screen.findByRole('menu', { name: 'قائمة الصفحة' });
    const paste = screen.getByRole('menuitem', { name: /الصق هنا/ });
    expect(paste.getAttribute('aria-disabled')).toBe('true');
    expect(menu.textContent).toContain('لا يوجد ما يُلصق');
    // the finger lifts: the click it may fire is swallowed, the next tap on the menu works
    pointer(s.root, 'pointerup', ...px(0.5, 0.5), { pointerType: 'touch', pointerId: 77 });
    fireEvent.click(s.root);
    expect(screen.getByRole('menu', { name: 'قائمة الصفحة' })).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: /صفحة ملاحظات بعد هذه الصفحة/ }));
    expect(newNotePageAfter).toHaveBeenCalledWith(s.anchor);
    // a right click opens it too
    fireEvent.contextMenu(s.root, { clientX: 10 + 300, clientY: 20 + 200 });
    fireEvent.click(await screen.findByRole('menuitem', { name: /نص هنا/ }));
    await waitFor(() => expect(document.querySelector('.ml-ink-text-editor, [data-ink-editor], textarea')).not.toBeNull());
    await s.store.flush();
  });

  it('the context-menu key opens the menu of the page in view', async () => {
    const s = setupLayer('lasso', { wrap: sheet });
    await s.store.whenLoaded(s.key);
    act(() => s.store.markActive(s.key));
    fireEvent.keyDown(document, { key: 'ContextMenu' });
    expect(await screen.findByRole('menu', { name: 'قائمة الصفحة' })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu', { name: 'قائمة الصفحة' })).toBeNull());
  });
});

describe('G08 the ruler and the measurement', () => {
  it('a stroke along the ruler is straight on its edge; the ruler is never saved', async () => {
    const s = setupLayer('pen', { around: (n) => <>{n}<Internal /></> });
    await s.store.whenLoaded(s.key);
    const r = placeRuler(s.key, [0.5, 0.5], 0);
    act(() => internal!.setRuler(r));
    expect(await screen.findByRole('group', { name: /المسطرة/ })).toBeTruthy();
    const edgeY = rulerEdge(r, AR).a[1] / AR;
    stroke(s.root, [px(0.2, edgeY - 0.004), px(0.3, edgeY + 0.006), px(0.4, edgeY - 0.003), px(0.5, edgeY + 0.004)]);
    const [it] = inks(s);
    for (const p of it!.data.points) expect(p[1]).toBeCloseTo(edgeY, 4);
    // only the stroke was saved
    expect(s.store.items(s.key).length).toBe(1);
    await s.store.flush();
  });

  it('a measured line shows the educational label and is never saved as ink', async () => {
    const s = setupLayer('measure');
    await s.store.whenLoaded(s.key);
    stroke(s.root, [px(0.2, 0.2), px(0.3, 0.2), px(0.5, 0.2)]);
    const panel = await screen.findByRole('region', { name: 'قياس تعليمي' });
    expect(panel.textContent).toContain('تقدير تعليمي — ليس قياسًا سريريًا');
    expect(panel.textContent).toContain('لا يُحفظ كحبر');
    expect(s.store.items(s.key).length).toBe(0);
  });
});

describe('G11 the neat copy', () => {
  it('turned on from the page menu: a derived canvas over the hidden pen canvas; the stored strokes do not change', async () => {
    const s = setupLayer('lasso', { wrap: sheet });
    const tilted = penLine(s, 0.2, 0.6, 0.3, 0.1);
    await put(s, [tilted]);
    const before = JSON.stringify(s.store.items(s.key));
    fireEvent.contextMenu(s.root, { clientX: 10 + 300, clientY: 20 + 700 });
    fireEvent.click(await screen.findByRole('menuitem', { name: /النسخة المرتبة لهذه الصفحة/ }));
    await waitFor(() => expect(s.root.hasAttribute('data-neat')).toBe(true));
    expect(s.root.querySelector('.ml-ink-layer__canvas--neat')).not.toBeNull();
    expect(screen.getByRole('note').textContent).toContain('لم يتغير');
    expect(JSON.stringify(s.store.items(s.key))).toBe(before);
    fireEvent.click(screen.getByRole('button', { name: 'اعرض الحبر كما كتبته' }));
    await waitFor(() => expect(s.root.hasAttribute('data-neat')).toBe(false));
  });
});

describe('G22 snapping to a processed region', () => {
  it('a dragged selection lands on the region edge within the tolerance', async () => {
    const anchor: AnnotationAnchor = { type: 'page', source_id: 'S', version_id: 'V', page_id: newId(), page_index: 0, space: 'page_norm' };
    __setPageRegions((anchor as { page_id: string }).page_id, [{ x: 0.6, y: 0.5, w: 0.3, h: 0.2 }]);
    const s = setupLayer('lasso', { anchor });
    const box = rect(s, [0.2, 0.52], [0.3, 0.6]);
    await put(s, [box]);
    act(() => s.store.setSelection({ targetKey: s.key, ids: [box.id] }));
    const frame = s.root.querySelector('.ml-ink-selection') as HTMLElement;
    const base = { pointerId: 41, button: 0, pointerType: 'mouse' };
    const start = px(0.25, 0.56);
    // the box's left edge would land at 0.596 — 2.4 px from the region's left edge at 0.6
    const end = px(0.25 + 0.396, 0.56);
    act(() => {
      fireEvent.pointerDown(frame, { ...base, clientX: start[0] + 10, clientY: start[1] + 20 });
    });
    act(() => {
      fireEvent.pointerMove(frame, { ...base, buttons: 1, clientX: end[0] + 10, clientY: end[1] + 20 });
    });
    act(() => {
      fireEvent.pointerUp(frame, { ...base, clientX: end[0] + 10, clientY: end[1] + 20 });
    });
    const moved = s.store.item(s.key, box.id) as InkItemOf<ShapeData>;
    // the outer edge of the drawn outline (its stroke width included) sits on the region's edge
    expect(itemBBox(moved, AR).x).toBeCloseTo(0.6, 4);
    await s.store.flush();
  });
});

describe('G08 one measurement panel on screen (review of the e2e run)', () => {
  it('with several pages in view, only the page measured shows its panel', async () => {
    const mk = (i: number): AnnotationAnchor => ({ type: 'page', source_id: 'S', version_id: 'V', page_id: newId(), page_index: i, space: 'page_norm' });
    const anchors = [mk(0), mk(1), mk(2)];
    const view = { pageWidth: 600, pageHeight: 800, scale: 1, rotation: 0 as const };
    const docKey = `doc-n1-${newId()}`;
    window.localStorage.setItem('medlevo.ink.prefs.v1', JSON.stringify({ penOnly: false }));
    const { InkLayer, InkProvider } = await import('../../src/features/workspace/ink');
    const { annotationTargetKey } = await import('@medlevo/shared');
    const { render } = await import('@testing-library/react');
    const { ToolProbe } = await import('./n1-helpers');
    const r = render(
      <InkProvider documentKey={docKey}>
        <ToolProbe set="measure" />
        {anchors.map((a) => (
          <div key={a.type === 'page' ? a.page_id : ''} style={{ position: 'relative' }}>
            <InkLayer targetKey={annotationTargetKey(a)} anchor={a} view={view} interactive />
          </div>
        ))}
      </InkProvider>,
    );
    const roots = Array.from(r.container.querySelectorAll('.ml-ink-layer')) as HTMLElement[];
    roots.forEach((root) => vi.spyOn(root, 'getBoundingClientRect').mockReturnValue({ left: 10, top: 20, width: 600, height: 800, right: 610, bottom: 820, x: 10, y: 20, toJSON: () => ({}) } as DOMRect));
    // nothing measured yet: no panel (the tool's options say what to do)
    expect(screen.queryAllByRole('region', { name: 'قياس تعليمي' })).toHaveLength(0);
    stroke(roots[1]!, [px(0.2, 0.2), px(0.4, 0.2), px(0.6, 0.2)]);
    expect(await screen.findAllByRole('region', { name: 'قياس تعليمي' })).toHaveLength(1);
    stroke(roots[2]!, [px(0.2, 0.3), px(0.4, 0.3), px(0.6, 0.3)]);
    await waitFor(() => expect(screen.getAllByRole('region', { name: 'قياس تعليمي' })).toHaveLength(1));
  });
});
